import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLocalWorkflow } from './local-model-adapter.mjs';

const READ_ONLY_COMMANDS = new Set([
  'summary',
  'explain',
  'inspect',
  'ls',
  'tree',
  'read',
  'find',
  'grep',
  'changes',
  'diff',
  'review',
  'history',
  'memory',
  'status',
  'recap',
  'mode',
  'tools',
  'agents',
  'agent-memory',
  'pwd',
]);

function dedupeSteps(steps) {
  const seen = new Set();
  return steps.filter(step => {
    if (!step?.command || seen.has(step.command)) {
      return false;
    }
    seen.add(step.command);
    return true;
  });
}

function inferReadOnlyFromCommand(command) {
  const toolName = String(command ?? '')
    .trim()
    .split(/\s+/)[0]
    .replace(/^\/+/, '');
  return READ_ONLY_COMMANDS.has(toolName);
}

function tokenizeCommand(commandLine) {
  const tokens = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(commandLine)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function normalizeExternalSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) {
    throw new Error('External adapter response must include a steps array.');
  }

  return rawSteps.map((step, index) => {
    if (typeof step === 'string') {
      return {
        goal: `Run external step ${index + 1}.`,
        command: step,
        readOnly: inferReadOnlyFromCommand(step),
      };
    }

    if (!step || typeof step !== 'object' || typeof step.command !== 'string') {
      throw new Error('Each external adapter step must be a command string or an object with a command field.');
    }

    return {
      goal: step.goal || `Run external step ${index + 1}.`,
      command: step.command,
      readOnly:
        typeof step.readOnly === 'boolean'
          ? step.readOnly
          : inferReadOnlyFromCommand(step.command),
    };
  });
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return Math.max(0, Math.min(1, value));
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function normalizeRationale(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

function normalizePhases(value, stepCount) {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }

  return value
    .map((phase, index) => {
      if (typeof phase === 'string') {
        return {
          title: phase,
          summary: '',
          steps: [],
        };
      }

      if (!phase || typeof phase !== 'object') {
        return null;
      }

      const title = String(phase.title || phase.name || `Phase ${index + 1}`).trim();
      const summary = String(phase.summary || phase.goal || '').trim();
      const steps = Array.isArray(phase.steps)
        ? phase.steps
            .map(stepIndex => Number.parseInt(stepIndex, 10))
            .filter(stepIndex => !Number.isNaN(stepIndex) && stepIndex >= 1 && stepIndex <= stepCount)
        : [];

      return {
        title,
        summary,
        steps,
      };
    })
    .filter(Boolean);
}

function finalizeWorkflow(request, workflow, registry, adapterLabel, extraNotes = []) {
  const enabledTools = new Set(
    registry.tools.filter(tool => tool.enabled).map(tool => tool.name),
  );
  const steps = dedupeSteps(workflow.steps).map(step => ({
    ...step,
    enabled: enabledTools.has(
      String(step.command ?? '')
        .split(/\s+/)[0]
        .replace(/^\/+/, ''),
    ),
  }));

  const blockedSteps = steps.filter(step => !step.enabled);
  const notes = [
    ...(Array.isArray(workflow.notes) ? workflow.notes : []),
    ...extraNotes,
    `Planner: ${adapterLabel}.`,
  ];
  if (blockedSteps.length > 0) {
    notes.push('Some steps are blocked by the active preset.');
  }

  return {
    request,
    intent: workflow.intent || 'fallback',
    summary: workflow.summary || 'External adapter generated a workflow.',
    confidence: normalizeConfidence(workflow.confidence),
    rationale: normalizeRationale(workflow.rationale),
    phases: normalizePhases(workflow.phases, steps.length),
    steps,
    notes,
    executable: steps.length > 0 && steps.every(step => step.enabled),
    autoRunnable: steps.length > 0 && steps.every(step => step.readOnly && step.enabled),
    requiresApproval: steps.some(step => !step.readOnly),
    planner: adapterLabel,
  };
}

async function runExternalCommand(command, payload, cwd) {
  const [bin] = tokenizeCommand(command);
  if (!bin) {
    throw new Error('External adapter command is empty.');
  }

  const result = spawnSync('bash', ['-lc', command], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      MECTOV_ADAPTER_PAYLOAD: JSON.stringify(payload),
    },
  });

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 0) !== 0) {
    throw new Error(
      result.stderr?.trim() || `External adapter exited with code ${result.status ?? 0}.`,
    );
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseExternalWorkflow(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('External adapter returned no output.');
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('External adapter output was not valid JSON.');
  }

  return {
    intent: parsed.intent || 'fallback',
    summary: parsed.summary || 'External adapter returned a workflow.',
    confidence: parsed.confidence,
    rationale: parsed.rationale,
    phases: parsed.phases,
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    steps: normalizeExternalSteps(parsed.steps),
  };
}

function formatAdapterError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const compact = raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)[0] ?? 'Unknown adapter error.';
  return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
}

export function createModelAdapterConfig({
  requestedAdapter = 'heuristic',
  requestedAdapterCommand = '',
} = {}) {
  const mode = String(requestedAdapter || 'heuristic').trim().toLowerCase();

  if (mode === 'heuristic') {
    return {
      mode: 'heuristic',
      label: 'heuristic',
      command: null,
    };
  }

  if (mode === 'external-command') {
    if (!requestedAdapterCommand) {
      throw new Error('The external-command adapter needs --adapter-command or MECTOV_MODEL_COMMAND.');
    }
    return {
      mode: 'external-command',
      label: 'external-command',
      command: requestedAdapterCommand,
    };
  }

  if (mode === 'module') {
    if (!requestedAdapterCommand) {
      throw new Error('The module adapter needs --adapter-command or MECTOV_MODEL_COMMAND.');
    }
    return {
      mode: 'module',
      label: 'module',
      command: requestedAdapterCommand,
    };
  }

  throw new Error(`Unknown adapter "${requestedAdapter}". Use "heuristic", "module", or "external-command".`);
}

export function formatModelAdapterLabel(adapterConfig) {
  if (adapterConfig.mode === 'external-command' || adapterConfig.mode === 'module') {
    return `${adapterConfig.label} (${adapterConfig.command})`;
  }
  return adapterConfig.label;
}

async function runModuleAdapter(modulePath, payload, cwd) {
  const resolvedPath = path.isAbsolute(modulePath)
    ? modulePath
    : path.resolve(cwd, modulePath);
  const loadedModule = await import(pathToFileURL(resolvedPath).href);
  const planner =
    typeof loadedModule.planWorkflow === 'function'
      ? loadedModule.planWorkflow
      : typeof loadedModule.default === 'function'
        ? loadedModule.default
        : null;

  if (!planner) {
    throw new Error('Module adapter must export a default function or named planWorkflow function.');
  }

  const result = await planner(payload);
  return {
    intent: result?.intent || 'fallback',
    summary: result?.summary || 'Module adapter returned a workflow.',
    confidence: result?.confidence,
    rationale: result?.rationale,
    phases: result?.phases,
    notes: Array.isArray(result?.notes) ? result.notes : [],
    steps: normalizeExternalSteps(result?.steps),
  };
}

export async function buildWorkflowWithAdapter({
  request,
  registry,
  adapterConfig,
  context = {},
}) {
  const heuristicWorkflow = buildLocalWorkflow(request, registry);

  if (!adapterConfig || adapterConfig.mode === 'heuristic') {
    return {
      ...heuristicWorkflow,
      confidence: heuristicWorkflow.confidence ?? 'heuristic',
      rationale: heuristicWorkflow.rationale ?? [],
      phases: heuristicWorkflow.phases ?? [],
      notes: [...heuristicWorkflow.notes, 'Planner: heuristic.'],
      planner: 'heuristic',
    };
  }

  try {
    const payload = {
      request,
      rootDir: context.rootDir ?? process.cwd(),
      presetName: context.presetName ?? 'safe-local',
      tools: registry.tools.map(tool => ({
        name: tool.name,
        category: tool.category,
        safety: tool.safety,
        enabled: tool.enabled,
        description: tool.description,
      })),
    };

    let externalWorkflow;
    if (adapterConfig.mode === 'module') {
      externalWorkflow = await runModuleAdapter(
        adapterConfig.command,
        payload,
        context.commandCwd ?? process.cwd(),
      );
    } else {
      const result = await runExternalCommand(
        adapterConfig.command,
        payload,
        context.commandCwd ?? process.cwd(),
      );
      externalWorkflow = parseExternalWorkflow(result.stdout);
    }
    return finalizeWorkflow(
      request,
      externalWorkflow,
      registry,
      formatModelAdapterLabel(adapterConfig),
    );
  } catch (error) {
    return {
      ...heuristicWorkflow,
      notes: [
        ...heuristicWorkflow.notes,
        `External adapter failed, fell back to heuristic planner: ${formatAdapterError(error)}`,
        `Planner fallback from ${formatModelAdapterLabel(adapterConfig)} to heuristic.`,
      ],
      planner: `heuristic (fallback from ${adapterConfig.label})`,
    };
  }
}
