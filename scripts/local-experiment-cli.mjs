#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  createLocalToolRegistry,
  formatToolRegistry,
  planLocalTask,
} from './local-tool-registry.mjs';
import {
  buildWorkflowWithAdapter,
  createModelAdapterConfig,
  formatModelAdapterLabel,
} from './local-model-runtime.mjs';
import {
  applyAgentProfile,
  getLocalAgent,
  listLocalAgents,
} from './local-agents.mjs';

const args = process.argv.slice(2);
const PRESETS = {
  'safe-local': {
    allowWrite: false,
    allowRun: false,
    label: 'Read/search only',
  },
  'research-local': {
    allowWrite: true,
    allowRun: true,
    label: 'Read/search/edit/run with confirmations',
  },
};
const SKIPPED_DIR_NAMES = new Set(['.git', '.local-experiment', 'node_modules']);

function getFlagValue(flag, fallback) {
  const flagIndex = args.indexOf(flag);
  return flagIndex >= 0 && args[flagIndex + 1] ? args[flagIndex + 1] : fallback;
}

const requestedRoot = getFlagValue('--root', process.cwd());
const presetName = getFlagValue('--preset', 'safe-local');
const requestedAdapter = getFlagValue(
  '--adapter',
  process.env.MECTOV_MODEL_ADAPTER ?? 'heuristic',
);
const requestedAdapterCommand = getFlagValue(
  '--adapter-command',
  process.env.MECTOV_MODEL_COMMAND ?? '',
);
const AUTO_APPROVE = args.includes('--yes') || args.includes('--auto-approve');
if (!(presetName in PRESETS)) {
  throw new Error(`Unknown preset "${presetName}". Use one of: ${Object.keys(PRESETS).join(', ')}`);
}

const ROOT_DIR = path.resolve(requestedRoot);
const SESSION_DIR = path.join(ROOT_DIR, '.local-experiment', 'sessions');
const BACKUP_DIR = path.join(ROOT_DIR, '.local-experiment', 'backups');
const AGENT_MEMORY_DIR = path.join(ROOT_DIR, '.local-experiment', 'agents');
const MEMORY_LOG = path.join(ROOT_DIR, '.local-experiment', 'workflow-memory.jsonl');
const SESSION_LOG = path.join(SESSION_DIR, `${new Date().toISOString().replaceAll(':', '-')}.log`);
const ACTIVE_PRESET = PRESETS[presetName];
const TOOL_REGISTRY = createLocalToolRegistry({
  presetName,
  activePreset: ACTIVE_PRESET,
});
const MODEL_ADAPTER = createModelAdapterConfig({
  requestedAdapter,
  requestedAdapterCommand,
});
const SESSION_STATE = {
  startedAt: new Date(),
  commandCount: 0,
  workflowCount: 0,
  agentRunCount: 0,
  editCount: 0,
  runCount: 0,
  backupCount: 0,
  errorCount: 0,
  lastCommand: null,
  lastWorkflow: null,
  recentCommands: [],
  recentEvents: [],
};

let rl;

async function ensureWorkspaceStateDirs() {
  await fs.mkdir(SESSION_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  await fs.mkdir(AGENT_MEMORY_DIR, { recursive: true });
}

function pushRecent(list, value, limit = 8) {
  if (!value) {
    return;
  }
  list.push(value);
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
}

function trackCommand(commandLine) {
  SESSION_STATE.commandCount += 1;
  SESSION_STATE.lastCommand = commandLine;
  pushRecent(SESSION_STATE.recentCommands, commandLine, 10);
}

function trackWorkflow(kind, workflow) {
  SESSION_STATE.workflowCount += 1;
  SESSION_STATE.lastWorkflow = `${kind}:${workflow.intent}`;
  pushRecent(
    SESSION_STATE.recentEvents,
    `${kind} -> ${workflow.intent}${workflow.confidence ? ` (${workflow.confidence})` : ''} :: ${workflow.summary}`,
    10,
  );
}

function trackAgent(agentName, requestText) {
  SESSION_STATE.agentRunCount += 1;
  pushRecent(SESSION_STATE.recentEvents, `agent ${agentName} :: ${requestText}`, 10);
}

function trackEdit(action, target) {
  SESSION_STATE.editCount += 1;
  pushRecent(SESSION_STATE.recentEvents, `${action} ${target}`, 10);
}

function trackBackup(filePath) {
  SESSION_STATE.backupCount += 1;
  pushRecent(SESSION_STATE.recentEvents, `backup ${filePath}`, 10);
}

function trackRun(commandText) {
  SESSION_STATE.runCount += 1;
  pushRecent(SESSION_STATE.recentEvents, `run ${commandText}`, 10);
}

function trackError(message) {
  SESSION_STATE.errorCount += 1;
  pushRecent(SESSION_STATE.recentEvents, `error ${message}`, 10);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function getConfidenceTier(confidence) {
  if (confidence === undefined || confidence === null || confidence === '') {
    return 'unknown';
  }

  if (typeof confidence === 'number') {
    if (confidence >= 0.8) {
      return 'high';
    }
    if (confidence >= 0.5) {
      return 'medium';
    }
    return 'low';
  }

  const normalized = String(confidence).trim().toLowerCase();
  if (normalized === 'high') {
    return 'high';
  }
  if (normalized === 'medium' || normalized === 'med' || normalized === 'heuristic') {
    return 'medium';
  }
  if (normalized === 'low') {
    return 'low';
  }
  return 'unknown';
}

function describeConfidencePolicy(confidence) {
  const tier = getConfidenceTier(confidence);
  switch (tier) {
    case 'high':
      return 'High confidence: read-only workflows may auto-run normally.';
    case 'medium':
      return 'Medium confidence: review the workflow, especially before broader execution.';
    case 'low':
      return 'Low confidence: auto-run is restricted and execution needs extra confirmation.';
    default:
      return 'Confidence unknown: review the workflow before relying on it.';
  }
}

function enabledToolCount() {
  return TOOL_REGISTRY.tools.filter(tool => tool.enabled).length;
}

function buildStatusSummary() {
  return [
    `${presetName}`,
    `cmd:${SESSION_STATE.commandCount}`,
    `wf:${SESSION_STATE.workflowCount}`,
    `edit:${SESSION_STATE.editCount}`,
    `err:${SESSION_STATE.errorCount}`,
  ].join(' | ');
}

function buildPrompt() {
  return `mectov[${buildStatusSummary()}]> `;
}

function printHeader() {
  console.log('Mectov CLI');
  console.log(`${ACTIVE_PRESET.label} | tools ${enabledToolCount()}/${TOOL_REGISTRY.tools.length} enabled | adapter ${formatModelAdapterLabel(MODEL_ADAPTER)} | auto-approve ${AUTO_APPROVE ? 'on' : 'off'}`);
  console.log(`Workspace root: ${ROOT_DIR}`);
  console.log(`Session log: ${SESSION_LOG}`);
  console.log('Quick start: help, tools, adapter, status, recap, agents');
}

async function finalizeSession(reason = 'completed') {
  await logEvent(
    'session.end',
    `reason=${reason} commands=${SESSION_STATE.commandCount} workflows=${SESSION_STATE.workflowCount} edits=${SESSION_STATE.editCount} runs=${SESSION_STATE.runCount} errors=${SESSION_STATE.errorCount}`,
  );
}

async function buildWorkflow(requestText) {
  return buildWorkflowWithAdapter({
    request: requestText,
    registry: TOOL_REGISTRY,
    adapterConfig: MODEL_ADAPTER,
    context: {
      rootDir: ROOT_DIR,
      presetName,
      commandCwd: process.cwd(),
    },
  });
}

function tokenize(commandLine) {
  const tokens = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(commandLine)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function resolveInsideRoot(targetPath = '.') {
  const absoluteTarget = path.resolve(ROOT_DIR, targetPath);
  const relativeTarget = path.relative(ROOT_DIR, absoluteTarget);
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    throw new Error(`Path escapes the workspace root: ${targetPath}`);
  }
  return absoluteTarget;
}

function toWorkspacePath(absolutePath) {
  const relative = path.relative(ROOT_DIR, absolutePath);
  return relative === '' ? '.' : relative;
}

function shouldSkipEntry(fullPath, entry) {
  if (!entry.isDirectory()) {
    return false;
  }
  if (SKIPPED_DIR_NAMES.has(entry.name)) {
    return true;
  }
  const relative = path.relative(ROOT_DIR, fullPath);
  return relative.startsWith('.local-experiment');
}

async function logEvent(kind, payload) {
  const line = `[${new Date().toISOString()}] ${kind} ${payload}\n`;
  await fs.appendFile(SESSION_LOG, line, 'utf8');
}

async function rememberWorkflow(kind, workflow) {
  const entry = {
    timestamp: new Date().toISOString(),
    kind,
    request: workflow.request,
    intent: workflow.intent,
    summary: workflow.summary,
    planner: workflow.planner ?? null,
    confidence: workflow.confidence ?? null,
    rationale: Array.isArray(workflow.rationale) ? workflow.rationale : [],
    phases: Array.isArray(workflow.phases) ? workflow.phases : [],
    autoRunnable: workflow.autoRunnable,
    steps: workflow.steps.map(step => ({
      goal: step.goal,
      command: step.command,
      enabled: step.enabled,
      readOnly: step.readOnly,
    })),
  };
  await fs.appendFile(MEMORY_LOG, `${JSON.stringify(entry)}\n`, 'utf8');
  trackWorkflow(kind, workflow);
}

function getAgentMemoryLog(agentName) {
  return path.join(AGENT_MEMORY_DIR, `${agentName}.jsonl`);
}

async function rememberAgentWorkflow(agentName, workflow) {
  const entry = {
    timestamp: new Date().toISOString(),
    agent: agentName,
    request: workflow.request,
    intent: workflow.intent,
    summary: workflow.summary,
    planner: workflow.planner ?? null,
    confidence: workflow.confidence ?? null,
    rationale: Array.isArray(workflow.rationale) ? workflow.rationale : [],
    phases: Array.isArray(workflow.phases) ? workflow.phases : [],
    autoRunnable: workflow.autoRunnable,
    steps: workflow.steps.map(step => ({
      goal: step.goal,
      command: step.command,
      enabled: step.enabled,
      readOnly: step.readOnly,
    })),
  };
  await fs.appendFile(getAgentMemoryLog(agentName), `${JSON.stringify(entry)}\n`, 'utf8');
}

async function question(prompt) {
  if (!rl) {
    rl = createInterface({ input, output, terminal: true });
  }
  return (await rl.question(prompt)).trim();
}

async function confirm(prompt) {
  if (AUTO_APPROVE) {
    return true;
  }
  const answer = (await question(`${prompt} [y/N] `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

async function walkFiles(startDir, visitor, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) {
    return;
  }

  const entries = await fs.readdir(startDir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = path.join(startDir, entry.name);
    const decision = await visitor(fullPath, entry, depth);
    if (entry.isDirectory() && decision !== 'skip' && !shouldSkipEntry(fullPath, entry)) {
      await walkFiles(fullPath, visitor, depth + 1, maxDepth);
    }
  }
}

function ensurePresetAllows(capability) {
  if (capability === 'write' && !ACTIVE_PRESET.allowWrite) {
    throw new Error('This preset is read-only. Restart with --preset research-local to edit files.');
  }
  if (capability === 'run' && !ACTIVE_PRESET.allowRun) {
    throw new Error('This preset does not allow shell execution. Restart with --preset research-local.');
  }
}

function normalizeCommandName(command) {
  if (!command) {
    return command;
  }
  return command.replace(/^\/+/, '');
}

function looksLikePathArg(value) {
  return typeof value === 'string' && (value.includes('/') || /\.[A-Za-z0-9_-]+$/.test(value));
}

function isDirectPreviewCommand(tokens) {
  const [rawCommand, ...rest] = tokens;
  const command = normalizeCommandName(rawCommand);

  switch (command) {
    case 'diff':
    case 'restore':
      return rest.length >= 1 && looksLikePathArg(rest[0]);
    case 'write':
    case 'append':
      return rest.length >= 1 && looksLikePathArg(rest[0]);
    case 'replace':
    case 'patch':
    case 'patch-block':
      return rest.length >= 3 && looksLikePathArg(rest[0]);
    case 'patch-lines':
      return rest.length >= 4 && looksLikePathArg(rest[0]);
    case 'patch-anchor':
      return rest.length >= 4 && looksLikePathArg(rest[0]);
    case 'run':
      return rest.length >= 1;
    default:
      return false;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function decodeEscapedText(value) {
  if (value === undefined || value === null) {
    return value;
  }

  return value
    .replace(/\\\\/g, '\u0000')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\u0000/g, '\\');
}

function parseLineRange(startArg, endArg) {
  const start = Number.parseInt(startArg, 10);
  const end = Number.parseInt(endArg ?? startArg, 10);

  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error('Line range must be numeric.');
  }
  if (start < 1 || end < start) {
    throw new Error('Invalid line range.');
  }

  return { start, end };
}

function applyLinePatch(content, start, end, replacementText) {
  const lines = content.split('\n');
  const replacementLines = replacementText.split('\n');
  const before = lines.slice(0, start - 1);
  const after = lines.slice(end);
  return [...before, ...replacementLines, ...after].join('\n');
}

function applyAnchorPatch(content, anchorText, oldText, newText) {
  const anchorOccurrences = content.split(anchorText).length - 1;
  if (anchorOccurrences === 0) {
    throw new Error('Anchor text was not found in the target file.');
  }
  if (anchorOccurrences > 1) {
    throw new Error(
      `Anchor text appears ${anchorOccurrences} times in the target file. patch-anchor requires exactly one anchor match.`,
    );
  }

  const anchorStart = content.indexOf(anchorText);
  const anchorEnd = anchorStart + anchorText.length;
  const anchorBlock = content.slice(anchorStart, anchorEnd);
  const targetOccurrences = anchorBlock.split(oldText).length - 1;

  if (targetOccurrences === 0) {
    throw new Error('Target text was not found inside the anchor block.');
  }
  if (targetOccurrences > 1) {
    throw new Error(
      `Target text appears ${targetOccurrences} times inside the anchor block. patch-anchor requires exactly one target match inside the anchor.`,
    );
  }

  const patchedAnchor = anchorBlock.replace(oldText, newText);
  const afterContent = `${content.slice(0, anchorStart)}${patchedAnchor}${content.slice(anchorEnd)}`;
  return {
    afterContent,
    anchorOccurrences,
    targetOccurrences,
  };
}

async function createBackupIfFileExists(filePath) {
  const absolutePath = resolveInsideRoot(filePath);
  try {
    await fs.access(absolutePath);
  } catch {
    return null;
  }

  const backupPath = path.join(
    BACKUP_DIR,
    `${filePath}.${new Date().toISOString().replaceAll(':', '-')}.bak`,
  );
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.copyFile(absolutePath, backupPath);
  await logEvent('backup', `${filePath} -> ${toWorkspacePath(backupPath)}`);
  trackBackup(filePath);
  return backupPath;
}

async function getLatestBackup(filePath) {
  const backupDir = path.join(BACKUP_DIR, path.dirname(filePath));
  const backupBaseName = `${path.basename(filePath)}.`;
  let entries;
  try {
    entries = await fs.readdir(backupDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches = entries
    .filter(
      entry =>
        entry.isFile() &&
        entry.name.startsWith(backupBaseName) &&
        entry.name.endsWith('.bak'),
    )
    .map(entry => path.join(backupDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  return matches.at(-1) ?? null;
}

async function runProcess(command, commandArgs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function diffStrings(beforeContent, afterContent, label) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mectov-preview-'));
  const beforePath = path.join(tempDir, 'before.txt');
  const afterPath = path.join(tempDir, 'after.txt');

  await fs.writeFile(beforePath, beforeContent, 'utf8');
  await fs.writeFile(afterPath, afterContent, 'utf8');

  try {
    const result = await runProcess('diff', [
      '-u',
      '--label',
      `${label}:before`,
      '--label',
      `${label}:after`,
      beforePath,
      afterPath,
    ]);

    if (result.code === 0) {
      return 'No changes.';
    }
    if (result.code === 1) {
      return result.stdout || result.stderr || 'Changes detected.';
    }
    return result.stderr.trim() || 'Unable to compute preview diff.';
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function buildCommandPreview(commandLine) {
  const tokens = tokenize(commandLine);
  const [rawCommand, ...rest] = tokens;
  const command = normalizeCommandName(rawCommand);

  switch (command) {
    case 'write': {
      const filePath = rest[0];
      const inlineText = decodeEscapedText(rest.slice(1).join(' '));
      if (!filePath) {
        return { kind: 'message', body: 'Preview unavailable: missing target file.' };
      }
      if (!inlineText) {
        return {
          kind: 'message',
          body: 'Preview unavailable for interactive write. Use inline text to preview.',
        };
      }
      const absolutePath = resolveInsideRoot(filePath);
      const beforeContent = (await readFileIfExists(absolutePath)) ?? '';
      const afterContent = `${inlineText}\n`;
      return {
        kind: 'diff',
        body: await diffStrings(beforeContent, afterContent, filePath),
      };
    }
    case 'append': {
      const filePath = rest[0];
      const inlineText = decodeEscapedText(rest.slice(1).join(' '));
      if (!filePath) {
        return { kind: 'message', body: 'Preview unavailable: missing target file.' };
      }
      if (!inlineText) {
        return {
          kind: 'message',
          body: 'Preview unavailable for interactive append. Use inline text to preview.',
        };
      }
      const absolutePath = resolveInsideRoot(filePath);
      const beforeContent = (await readFileIfExists(absolutePath)) ?? '';
      const afterContent = `${beforeContent}${inlineText}\n`;
      return {
        kind: 'diff',
        body: await diffStrings(beforeContent, afterContent, filePath),
      };
    }
    case 'replace': {
      const [filePath, rawOldText, rawNewText] = rest;
      const oldText = decodeEscapedText(rawOldText);
      const newText = decodeEscapedText(rawNewText);
      if (!filePath || oldText === undefined || newText === undefined) {
        return {
          kind: 'message',
          body: 'Preview unavailable: replace needs file, old text, and new text.',
        };
      }
      const absolutePath = resolveInsideRoot(filePath);
      const beforeContent = (await readFileIfExists(absolutePath)) ?? '';
      if (!beforeContent.includes(oldText)) {
        return {
          kind: 'message',
          body: `Preview note: "${oldText}" was not found in ${filePath}.`,
        };
      }
      const afterContent = beforeContent.replaceAll(oldText, newText);
      return {
        kind: 'diff',
        body: await diffStrings(beforeContent, afterContent, filePath),
      };
    }
    case 'patch': {
      const [filePath, rawOldText, rawNewText] = rest;
      const oldText = decodeEscapedText(rawOldText);
      const newText = decodeEscapedText(rawNewText);
      if (!filePath || oldText === undefined || newText === undefined) {
        return {
          kind: 'message',
          body: 'Preview unavailable: patch needs file, old text, and new text.',
          canApply: false,
        };
      }
      const absolutePath = resolveInsideRoot(filePath);
      const beforeContent = (await readFileIfExists(absolutePath)) ?? '';
      const occurrences = beforeContent.split(oldText).length - 1;
      if (occurrences === 0) {
        return {
          kind: 'message',
          body: `Patch preview note: "${oldText}" was not found in ${filePath}.`,
          canApply: false,
        };
      }
      if (occurrences > 1) {
        return {
          kind: 'message',
          body: `Patch preview note: "${oldText}" appears ${occurrences} times in ${filePath}. Patch requires exactly one match.`,
          canApply: false,
        };
      }
      const afterContent = beforeContent.replace(oldText, newText);
      return {
        kind: 'diff',
        body: await diffStrings(beforeContent, afterContent, filePath),
        canApply: true,
      };
    }
    case 'patch-block': {
      const [filePath, rawOldText, rawNewText] = rest;
      const oldText = decodeEscapedText(rawOldText);
      const newText = decodeEscapedText(rawNewText);
      if (!filePath || oldText === undefined || newText === undefined) {
        return {
          kind: 'message',
          body: 'Preview unavailable: patch-block needs file, old text, and new text.',
          canApply: false,
        };
      }
      const absolutePath = resolveInsideRoot(filePath);
      const beforeContent = (await readFileIfExists(absolutePath)) ?? '';
      const occurrences = beforeContent.split(oldText).length - 1;
      if (occurrences === 0) {
        return {
          kind: 'message',
          body: `Patch-block preview note: target block was not found in ${filePath}.`,
          canApply: false,
        };
      }
      if (occurrences > 1) {
        return {
          kind: 'message',
          body: `Patch-block preview note: target block appears ${occurrences} times in ${filePath}. patch-block requires exactly one match.`,
          canApply: false,
        };
      }
      const afterContent = beforeContent.replace(oldText, newText);
      return {
        kind: 'diff',
        body: await diffStrings(beforeContent, afterContent, filePath),
        canApply: true,
      };
    }
    case 'patch-lines': {
      const [filePath, startArg, endArg, ...textParts] = rest;
      if (!filePath || !startArg || !endArg) {
        return {
          kind: 'message',
          body: 'Preview unavailable: patch-lines needs file, start, end, and replacement text.',
          canApply: false,
        };
      }
      const replacementText = decodeEscapedText(textParts.join(' '));
      const absolutePath = resolveInsideRoot(filePath);
      const beforeContent = (await readFileIfExists(absolutePath)) ?? '';
      try {
        const { start, end } = parseLineRange(startArg, endArg);
        const beforeLines = beforeContent.split('\n');
        if (end > beforeLines.length) {
          return {
            kind: 'message',
            body: `Patch-lines preview note: ${filePath} only has ${beforeLines.length} lines.`,
            canApply: false,
          };
        }
        const afterContent = applyLinePatch(beforeContent, start, end, replacementText);
        return {
          kind: 'diff',
          body: await diffStrings(beforeContent, afterContent, filePath),
          canApply: true,
        };
      } catch (error) {
        return {
          kind: 'message',
          body: error instanceof Error ? error.message : String(error),
          canApply: false,
        };
      }
    }
    case 'patch-anchor': {
      const [filePath, rawAnchorText, rawOldText, rawNewText] = rest;
      const anchorText = decodeEscapedText(rawAnchorText);
      const oldText = decodeEscapedText(rawOldText);
      const newText = decodeEscapedText(rawNewText);
      if (!filePath || anchorText === undefined || oldText === undefined || newText === undefined) {
        return {
          kind: 'message',
          body: 'Preview unavailable: patch-anchor needs file, anchor text, old text, and new text.',
          canApply: false,
        };
      }
      const absolutePath = resolveInsideRoot(filePath);
      const beforeContent = (await readFileIfExists(absolutePath)) ?? '';
      try {
        const { afterContent } = applyAnchorPatch(beforeContent, anchorText, oldText, newText);
        return {
          kind: 'diff',
          body: await diffStrings(beforeContent, afterContent, filePath),
          canApply: true,
        };
      } catch (error) {
        return {
          kind: 'message',
          body: `Patch-anchor preview note: ${error instanceof Error ? error.message : String(error)}`,
          canApply: false,
        };
      }
    }
    case 'restore': {
      const filePath = rest[0];
      if (!filePath) {
        return { kind: 'message', body: 'Preview unavailable: missing target file.' };
      }
      const absolutePath = resolveInsideRoot(filePath);
      const latestBackup = await getLatestBackup(filePath);
      if (!latestBackup) {
        return {
          kind: 'message',
          body: `Preview unavailable: no backup exists for ${filePath}.`,
        };
      }
      const beforeContent = (await readFileIfExists(absolutePath)) ?? '';
      const afterContent = await fs.readFile(latestBackup, 'utf8');
      return {
        kind: 'diff',
        body: await diffStrings(beforeContent, afterContent, filePath),
      };
    }
    case 'run':
      return {
        kind: 'message',
        body: `Shell preview: ${rest.join(' ') || '(empty command)'}`,
      };
    default:
      return null;
  }
}

async function cmdHelp() {
  console.log(`Commands:
  help
  tools
  adapter
  agents
  agent <name> <request>
  agent-memory <name> [lines]
  mode
  status
  plan <request>
  ask <request>
  think <request>
  solve <request>
  preview <request>
  memory [lines]
  recap [lines]
  pwd
  summary [path]
  ls [path]
  tree [path] [depth]
  read <file> [start] [end]
  find <text> [path]
  grep <text> [path]
  diff <file>
  restore <file>
  patch <file> <old> <new>
  patch-block <file> <old> <new>
  patch-lines <file> <start> <end> <new>
  patch-anchor <file> <anchor> <old> <new>
  write <file>
  append <file>
  replace <file>
  run <shell command>
  history [lines]
  quit`);
}

async function cmdLs(target = '.') {
  const dir = resolveInsideRoot(target);
  const stat = await fs.stat(dir);
  if (stat.isFile()) {
    console.log(path.basename(dir));
    return;
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  if (entries.length === 0) {
    console.log('(empty)');
    return;
  }
  entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(entry => {
      const suffix = entry.isDirectory() ? '/' : '';
      console.log(`${entry.name}${suffix}`);
    });
}

async function cmdMode() {
  console.log(`Preset: ${presetName}`);
  console.log(`Behavior: ${ACTIVE_PRESET.label}`);
  console.log(`Workspace root: ${ROOT_DIR}`);
  console.log(`Available tools: ${TOOL_REGISTRY.tools.filter(tool => tool.enabled).length}/${TOOL_REGISTRY.tools.length}`);
}

async function cmdAdapter() {
  console.log(`Adapter: ${formatModelAdapterLabel(MODEL_ADAPTER)}`);
  console.log(`Mode: ${MODEL_ADAPTER.mode}`);
  if (MODEL_ADAPTER.mode === 'module') {
    console.log(`Module: ${MODEL_ADAPTER.command}`);
    console.log('Behavior: load a local planning module with heuristic fallback on failure.');
  } else if (MODEL_ADAPTER.command) {
    console.log(`Command: ${MODEL_ADAPTER.command}`);
    console.log('Behavior: external planner with automatic heuristic fallback on failure.');
  } else {
    console.log('Behavior: built-in heuristic planner.');
  }
}

async function cmdStatus() {
  console.log(`Status: ${buildStatusSummary()}`);
  console.log(`Adapter: ${formatModelAdapterLabel(MODEL_ADAPTER)}`);
  console.log(`Agents: ${SESSION_STATE.agentRunCount}`);
  console.log(`Backups: ${SESSION_STATE.backupCount}`);
  console.log(`Runs: ${SESSION_STATE.runCount}`);
  console.log(`Last command: ${SESSION_STATE.lastCommand ?? '(none yet)'}`);
  console.log(`Last workflow: ${SESSION_STATE.lastWorkflow ?? '(none yet)'}`);
  console.log(`Elapsed: ${formatDuration(Date.now() - SESSION_STATE.startedAt.getTime())}`);
}

async function cmdTools() {
  console.log('Local tool registry:');
  formatToolRegistry(TOOL_REGISTRY).forEach(line => console.log(`  ${line}`));
}

async function cmdAgents() {
  console.log('Local agents:');
  listLocalAgents().forEach(agent => {
    console.log(`  ${agent.name.padEnd(16, ' ')} ${agent.description}`);
    console.log(`                   ${agent.style}`);
  });
}

function printPlan(plan) {
  console.log(`Request: ${plan.request}`);

  if (plan.selected) {
    console.log(`Selected tool: ${plan.selected.tool}`);
    console.log(`Suggested command: ${plan.selected.command}`);
    console.log(`Reason: ${plan.selected.reason}`);
  } else {
    console.log('Selected tool: none');
  }

  if (plan.candidates.length > 0) {
    console.log('Top candidates:');
    plan.candidates.forEach(candidate => {
      const enabled = candidate.enabled ? 'enabled' : 'blocked';
      console.log(
        `  ${candidate.tool} (${candidate.score}, ${enabled}) -> ${candidate.command}`,
      );
    });
  }

  plan.notes.forEach(note => console.log(`Note: ${note}`));
}

function printWorkflow(workflow) {
  console.log(`Request: ${workflow.request}`);
  console.log(`Intent: ${workflow.intent}`);
  console.log(`Summary: ${workflow.summary}`);
  if (workflow.planner) {
    console.log(`Planner: ${workflow.planner}`);
  }
  if (workflow.confidence !== undefined && workflow.confidence !== null) {
    console.log(`Confidence: ${workflow.confidence}`);
    console.log(`Confidence policy: ${describeConfidencePolicy(workflow.confidence)}`);
  }
  if (Array.isArray(workflow.rationale) && workflow.rationale.length > 0) {
    console.log('Rationale:');
    workflow.rationale.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item}`);
    });
  }
  if (Array.isArray(workflow.phases) && workflow.phases.length > 0) {
    console.log('Phases:');
    workflow.phases.forEach((phase, index) => {
      const stepRefs =
        Array.isArray(phase.steps) && phase.steps.length > 0
          ? ` [steps ${phase.steps.join(', ')}]`
          : '';
      console.log(`  ${index + 1}. ${phase.title}${stepRefs}`);
      if (phase.summary) {
        console.log(`     ${phase.summary}`);
      }
    });
  }

  if (workflow.steps.length === 0) {
    console.log('Steps: none');
  } else {
    console.log('Steps:');
    workflow.steps.forEach((step, index) => {
      const status = step.enabled ? 'enabled' : 'blocked';
      const mode = step.readOnly ? 'read-only' : 'mutating';
      console.log(`  ${index + 1}. ${step.goal}`);
      console.log(`     ${step.command} [${status}, ${mode}]`);
    });
  }

  console.log(`Auto-runnable: ${workflow.autoRunnable ? 'yes' : 'no'}`);
  if (workflow.requiresApproval) {
    console.log('Approval checkpoints: required for one or more steps');
  }
  workflow.notes.forEach(note => console.log(`Note: ${note}`));
}

async function executeWorkflow(workflow, prefixLabel = 'Running') {
  if (workflow.steps.length === 0) {
    console.log('No executable steps.');
    return;
  }

  const blockedStep = workflow.steps.find(step => !step.enabled);
  if (blockedStep) {
    console.log(`Execution blocked at step "${blockedStep.command}" because the active preset does not allow it.`);
    return;
  }

  const confidenceTier = getConfidenceTier(workflow.confidence);
  if (confidenceTier === 'medium') {
    console.log('Confidence note: medium-confidence workflow, so keep an eye on the planned steps.');
  }
  if (confidenceTier === 'low') {
    console.log('Confidence gate: low-confidence workflow detected.');
    if (!AUTO_APPROVE && !input.isTTY) {
      console.log(
        'Stopped before execution because this workflow is low confidence. Re-run interactively or pass --yes only if you have reviewed it.',
      );
      return;
    }
    const approved = await confirm(
      `Workflow confidence is low. Run ${workflow.steps.length} planned step(s) anyway?`,
    );
    if (!approved) {
      console.log('Stopped before executing the low-confidence workflow.');
      return;
    }
  }

  for (const [index, step] of workflow.steps.entries()) {
    if (!step.readOnly) {
      const preview = await buildCommandPreview(step.command);
      if (preview) {
        console.log(`Preview for step ${index + 1}:`);
        console.log(preview.body);
        if (preview.canApply === false) {
          console.log(`Stopped before mutating step ${index + 1} because the preview marked it unsafe to apply.`);
          return;
        }
      }
      if (!AUTO_APPROVE && !input.isTTY) {
        console.log(
          `Stopped before mutating step ${index + 1}. Re-run with --yes or use an interactive shell to approve it.`,
        );
        return;
      }
      const approved = await confirm(
        `Approve step ${index + 1}/${workflow.steps.length}: ${step.command}?`,
      );
      if (!approved) {
        console.log(`Stopped before mutating step ${index + 1}.`);
        return;
      }
    }

    console.log(`${prefixLabel} step ${index + 1}/${workflow.steps.length}: ${step.command}`);
    await handleCommand(step.command, true);
  }
}

async function cmdPlan(requestText) {
  if (!requestText) {
    throw new Error('Usage: plan <request>');
  }
  const plan = planLocalTask(requestText, TOOL_REGISTRY);
  printPlan(plan);
}

async function cmdAsk(requestText) {
  if (!requestText) {
    throw new Error('Usage: ask <request>');
  }

  const plan = planLocalTask(requestText, TOOL_REGISTRY);
  printPlan(plan);

  if (!plan.selected) {
    return;
  }

  if (!plan.selected.readOnly) {
    console.log('Auto-run skipped because the selected tool changes files or executes shell commands.');
    return;
  }

  const workflow = await buildWorkflow(requestText);
  const confidenceTier = getConfidenceTier(workflow.confidence);
  if (confidenceTier === 'low') {
    console.log(
      'Auto-run skipped because the workflow confidence is low. Review it with "think" or "preview" before running manually.',
    );
    return;
  }
  if (confidenceTier === 'medium') {
    console.log('Confidence note: auto-running a medium-confidence read-only command.');
  }

  console.log(`Auto-running: ${plan.selected.command}`);
  await handleCommand(plan.selected.command, true);
}

async function cmdThink(requestText) {
  if (!requestText) {
    throw new Error('Usage: think <request>');
  }

  const workflow = await buildWorkflow(requestText);
  printWorkflow(workflow);
  await rememberWorkflow('think', workflow);
}

async function cmdSolve(requestText) {
  if (!requestText) {
    throw new Error('Usage: solve <request>');
  }

  const workflow = await buildWorkflow(requestText);
  printWorkflow(workflow);
  await rememberWorkflow('solve', workflow);

  if (!workflow.executable) {
    console.log('Execution skipped because at least one step is blocked by the active preset.');
    return;
  }

  await executeWorkflow(workflow, 'Running');
}

async function cmdPreview(requestText) {
  if (!requestText) {
    throw new Error('Usage: preview <request>');
  }

  const directTokens = tokenize(requestText);
  const directCommand = normalizeCommandName(directTokens[0]);
  if (
    ['write', 'append', 'replace', 'patch', 'patch-block', 'patch-lines', 'patch-anchor', 'restore', 'run'].includes(
      directCommand,
    ) &&
    isDirectPreviewCommand(directTokens)
  ) {
    const preview = await buildCommandPreview(requestText);
    if (!preview) {
      console.log('No preview available for that command.');
      return;
    }
    console.log(`Direct preview: ${requestText}`);
    console.log(preview.body);
    return;
  }

  const workflow = await buildWorkflow(requestText);
  printWorkflow(workflow);
  await rememberWorkflow('preview', workflow);

  for (const [index, step] of workflow.steps.entries()) {
    if (step.readOnly) {
      continue;
    }
    console.log(`Preview step ${index + 1}/${workflow.steps.length}: ${step.command}`);
    const preview = await buildCommandPreview(step.command);
    if (!preview) {
      console.log('No preview available for this step.');
      continue;
    }
    console.log(preview.body);
  }
}

async function cmdMemory(linesArg = '10') {
  const lineCount = Math.max(1, Math.min(Number.parseInt(linesArg, 10) || 10, 100));
  let content;
  try {
    content = await fs.readFile(MEMORY_LOG, 'utf8');
  } catch {
    console.log('No workflow memory yet.');
    return;
  }

  const entries = content
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-lineCount)
    .map(line => JSON.parse(line));

  if (entries.length === 0) {
    console.log('No workflow memory yet.');
    return;
  }

  entries.forEach(entry => {
    console.log(`[${entry.timestamp}] ${entry.kind} ${entry.intent}`);
    console.log(`  Request: ${entry.request}`);
    console.log(`  Summary: ${entry.summary}`);
    if (entry.planner) {
      console.log(`  Planner: ${entry.planner}`);
    }
    if (entry.confidence !== undefined && entry.confidence !== null) {
      console.log(`  Confidence: ${entry.confidence}`);
    }
    if (Array.isArray(entry.rationale) && entry.rationale.length > 0) {
      console.log(`  Rationale: ${entry.rationale.join(' | ')}`);
    }
    if (Array.isArray(entry.phases) && entry.phases.length > 0) {
      console.log(
        `  Phases: ${entry.phases.map(phase => phase.title).join(' | ')}`,
      );
    }
    console.log(`  Steps: ${entry.steps.map(step => step.command).join(' | ')}`);
  });
}

async function cmdRecap(linesArg = '5') {
  const lineCount = Math.max(1, Math.min(Number.parseInt(linesArg, 10) || 5, 20));
  console.log('Session recap:');
  console.log(`  Elapsed: ${formatDuration(Date.now() - SESSION_STATE.startedAt.getTime())}`);
  console.log(`  Commands: ${SESSION_STATE.commandCount}`);
  console.log(`  Workflows: ${SESSION_STATE.workflowCount}`);
  console.log(`  Agent runs: ${SESSION_STATE.agentRunCount}`);
  console.log(`  Edits: ${SESSION_STATE.editCount}`);
  console.log(`  Backups: ${SESSION_STATE.backupCount}`);
  console.log(`  Shell runs: ${SESSION_STATE.runCount}`);
  console.log(`  Errors: ${SESSION_STATE.errorCount}`);
  console.log(`  Session log: ${SESSION_LOG}`);

  if (SESSION_STATE.recentCommands.length > 0) {
    console.log('Recent commands:');
    SESSION_STATE.recentCommands
      .slice(-lineCount)
      .forEach((entry, index) => console.log(`  ${index + 1}. ${entry}`));
  }

  if (SESSION_STATE.recentEvents.length > 0) {
    console.log('Recent actions:');
    SESSION_STATE.recentEvents
      .slice(-lineCount)
      .forEach((entry, index) => console.log(`  ${index + 1}. ${entry}`));
  }
}

async function cmdAgentMemory(agentName, linesArg = '10') {
  if (!agentName) {
    throw new Error('Usage: agent-memory <name> [lines]');
  }
  const agent = getLocalAgent(agentName);
  if (!agent) {
    throw new Error(`Unknown agent "${agentName}". Use "agents" to list available agents.`);
  }

  const lineCount = Math.max(1, Math.min(Number.parseInt(linesArg, 10) || 10, 100));
  let content;
  try {
    content = await fs.readFile(getAgentMemoryLog(agentName), 'utf8');
  } catch {
    console.log(`No memory yet for agent "${agentName}".`);
    return;
  }

  const entries = content
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-lineCount)
    .map(line => JSON.parse(line));

  if (entries.length === 0) {
    console.log(`No memory yet for agent "${agentName}".`);
    return;
  }

  entries.forEach(entry => {
    console.log(`[${entry.timestamp}] ${entry.agent} ${entry.intent}`);
    console.log(`  Request: ${entry.request}`);
    console.log(`  Summary: ${entry.summary}`);
    if (entry.planner) {
      console.log(`  Planner: ${entry.planner}`);
    }
    if (entry.confidence !== undefined && entry.confidence !== null) {
      console.log(`  Confidence: ${entry.confidence}`);
    }
    if (Array.isArray(entry.rationale) && entry.rationale.length > 0) {
      console.log(`  Rationale: ${entry.rationale.join(' | ')}`);
    }
    if (Array.isArray(entry.phases) && entry.phases.length > 0) {
      console.log(
        `  Phases: ${entry.phases.map(phase => phase.title).join(' | ')}`,
      );
    }
    console.log(`  Steps: ${entry.steps.map(step => step.command).join(' | ')}`);
  });
}

async function cmdAgent(agentName, requestText) {
  if (!agentName || !requestText) {
    throw new Error('Usage: agent <name> <request>');
  }
  const agent = getLocalAgent(agentName);
  if (!agent) {
    throw new Error(`Unknown agent "${agentName}". Use "agents" to list available agents.`);
  }
  trackAgent(agentName, requestText);

  const baseWorkflow = await buildWorkflow(requestText);
  const workflow = applyAgentProfile(agentName, baseWorkflow);
  workflow.agent = agentName;
  workflow.executable =
    workflow.steps.length > 0 &&
    workflow.steps.every(step => step.enabled);
  workflow.autoRunnable =
    workflow.steps.length > 0 &&
    workflow.steps.every(step => step.readOnly && step.enabled);
  workflow.requiresApproval = workflow.steps.some(step => !step.readOnly);

  console.log(`Agent: ${agent.name}`);
  console.log(`Style: ${agent.style}`);
  printWorkflow(workflow);
  await rememberWorkflow(`agent:${agentName}`, workflow);
  await rememberAgentWorkflow(agentName, workflow);

  if (!workflow.executable) {
    console.log('Execution skipped because at least one step is blocked by the active preset.');
    return;
  }

  await executeWorkflow(workflow, 'Agent');
}

async function cmdSummary(target = '.') {
  const resolvedPath = resolveInsideRoot(target);
  const stat = await fs.stat(resolvedPath);

  if (stat.isFile()) {
    const ext = path.extname(resolvedPath) || '(no extension)';
    console.log(`Path: ${toWorkspacePath(resolvedPath)}`);
    console.log('Type: file');
    console.log(`Size: ${formatBytes(stat.size)}`);
    console.log(`Extension: ${ext}`);
    return;
  }

  const dir = resolvedPath;
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;
  const extensionCounts = new Map();

  await walkFiles(
    dir,
    async (fullPath, entry) => {
      if (entry.isDirectory()) {
        dirCount += 1;
        return undefined;
      }

      fileCount += 1;
      const stat = await fs.stat(fullPath);
      totalBytes += stat.size;
      const ext = path.extname(entry.name) || '(no extension)';
      extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
      return undefined;
    },
    0,
    8,
  );

  console.log(`Path: ${toWorkspacePath(dir)}`);
  console.log(`Directories: ${dirCount}`);
  console.log(`Files: ${fileCount}`);
  console.log(`Size: ${formatBytes(totalBytes)}`);

  const topExtensions = [...extensionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  if (topExtensions.length > 0) {
    console.log('Top extensions:');
    topExtensions.forEach(([ext, count]) => {
      console.log(`  ${ext}: ${count}`);
    });
  }
}

async function cmdTree(target = '.', depthArg = '2') {
  const dir = resolveInsideRoot(target);
  const stat = await fs.stat(dir);
  const maxDepth = Number.parseInt(depthArg, 10);
  const safeDepth = Number.isNaN(maxDepth) ? 2 : Math.max(0, Math.min(maxDepth, 6));

  if (stat.isFile()) {
    console.log(toWorkspacePath(dir));
    return;
  }

  console.log(`${toWorkspacePath(dir)}/`);
  await walkFiles(
    dir,
    async (fullPath, entry, depth) => {
      if (shouldSkipEntry(fullPath, entry)) {
        return 'skip';
      }
      if (depth >= safeDepth) {
        return;
      }
      const indent = '  '.repeat(depth + 1);
      const suffix = entry.isDirectory() ? '/' : '';
      console.log(`${indent}${entry.name}${suffix}`);
    },
    0,
    safeDepth,
  );
}

async function cmdRead(filePath, startArg = '1', endArg = '40') {
  if (!filePath) {
    throw new Error('Usage: read <file> [start] [end]');
  }
  const absolutePath = resolveInsideRoot(filePath);
  const content = await fs.readFile(absolutePath, 'utf8');
  const lines = content.split('\n');
  const start = Math.max(1, Number.parseInt(startArg, 10) || 1);
  const end = Math.max(start, Number.parseInt(endArg, 10) || start + 39);
  for (let i = start; i <= Math.min(end, lines.length); i += 1) {
    console.log(`${String(i).padStart(4, ' ')} | ${lines[i - 1]}`);
  }
}

async function cmdFind(text, target = '.') {
  if (!text) {
    throw new Error('Usage: find <text> [path]');
  }
  const dir = resolveInsideRoot(target);
  const stat = await fs.stat(dir);
  const matches = [];

  if (stat.isFile()) {
    if (path.basename(dir).toLowerCase().includes(text.toLowerCase())) {
      console.log(toWorkspacePath(dir));
    } else {
      console.log('No matches.');
    }
    return;
  }

  await walkFiles(
    dir,
    async (fullPath, entry) => {
      if (entry.isDirectory()) {
        return shouldSkipEntry(fullPath, entry) ? 'skip' : undefined;
      }
      if (entry.name.toLowerCase().includes(text.toLowerCase())) {
        matches.push(toWorkspacePath(fullPath));
      }
    },
    0,
    8,
  );

  if (matches.length === 0) {
    console.log('No matches.');
    return;
  }

  matches.slice(0, 100).forEach(match => console.log(match));
  if (matches.length > 100) {
    console.log(`...and ${matches.length - 100} more`);
  }
}

async function cmdGrep(text, target = '.') {
  if (!text) {
    throw new Error('Usage: grep <text> [path]');
  }
  const dir = resolveInsideRoot(target);
  const stat = await fs.stat(dir);
  const hits = [];

  if (stat.isFile()) {
    let content;
    try {
      content = await fs.readFile(dir, 'utf8');
    } catch {
      console.log('No matches.');
      return;
    }
    content.split('\n').forEach((line, index) => {
      if (line.includes(text)) {
        hits.push(`${toWorkspacePath(dir)}:${index + 1}: ${line.trim()}`);
      }
    });
    if (hits.length === 0) {
      console.log('No matches.');
      return;
    }
    hits.slice(0, 120).forEach(hit => console.log(hit));
    if (hits.length > 120) {
      console.log(`...and ${hits.length - 120} more`);
    }
    return;
  }

  await walkFiles(
    dir,
    async (fullPath, entry) => {
      if (entry.isDirectory()) {
        return shouldSkipEntry(fullPath, entry) ? 'skip' : undefined;
      }

      const stat = await fs.stat(fullPath);
      if (stat.size > 512 * 1024) {
        return;
      }

      let content;
      try {
        content = await fs.readFile(fullPath, 'utf8');
      } catch {
        return;
      }

      const lines = content.split('\n');
      lines.forEach((line, index) => {
        if (line.includes(text)) {
          hits.push(`${toWorkspacePath(fullPath)}:${index + 1}: ${line.trim()}`);
        }
      });
    },
    0,
    6,
  );

  if (hits.length === 0) {
    console.log('No matches.');
    return;
  }

  hits.slice(0, 120).forEach(hit => console.log(hit));
  if (hits.length > 120) {
    console.log(`...and ${hits.length - 120} more`);
  }
}

async function cmdDiff(filePath) {
  if (!filePath) {
    throw new Error('Usage: diff <file>');
  }

  const absolutePath = resolveInsideRoot(filePath);
  const latestBackup = await getLatestBackup(filePath);
  if (!latestBackup) {
    console.log('No backup found for that file yet.');
    return;
  }

  const result = await runProcess('diff', ['-u', latestBackup, absolutePath]);
  if (result.code === 0) {
    console.log('No differences from latest backup.');
    return;
  }

  if (result.code === 1) {
    process.stdout.write(result.stdout || result.stderr);
    return;
  }

  throw new Error(result.stderr.trim() || 'diff command failed.');
}

async function cmdRestore(filePath) {
  ensurePresetAllows('write');
  if (!filePath) {
    throw new Error('Usage: restore <file>');
  }

  const absolutePath = resolveInsideRoot(filePath);
  const latestBackup = await getLatestBackup(filePath);
  if (!latestBackup) {
    console.log('No backup found for that file yet.');
    return;
  }

  const confirmed = await confirm(`Restore ${filePath} from latest backup?`);
  if (!confirmed) {
    console.log('Canceled.');
    return;
  }

  await createBackupIfFileExists(filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.copyFile(latestBackup, absolutePath);
  console.log(`Restored ${filePath}.`);
  trackEdit('restore', filePath);
}

async function captureMultilineInput(label) {
  console.log(`${label} Finish with a single line containing ".end".`);
  const chunks = [];
  while (true) {
    if (!rl) {
      rl = createInterface({ input, output, terminal: true });
    }
    const line = await rl.question('');
    if (line === '.end') {
      break;
    }
    chunks.push(line);
  }
  return `${chunks.join('\n')}\n`;
}

async function cmdWrite(filePath, mode, inlineText) {
  ensurePresetAllows('write');
  if (!filePath) {
    throw new Error(`Usage: ${mode} <file>`);
  }
  const absolutePath = resolveInsideRoot(filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await createBackupIfFileExists(filePath);
  const content =
    inlineText !== undefined
      ? `${decodeEscapedText(inlineText)}\n`
      : await captureMultilineInput(
          mode === 'write' ? `Writing ${filePath}.` : `Appending to ${filePath}.`,
        );

  const confirmed = await confirm(
    `${mode === 'write' ? 'Write' : 'Append'} ${content.length} bytes to ${filePath}?`,
  );
  if (!confirmed) {
    console.log('Canceled.');
    return;
  }

  if (mode === 'write') {
    await fs.writeFile(absolutePath, content, 'utf8');
  } else {
    await fs.appendFile(absolutePath, content, 'utf8');
  }
  console.log(`Saved ${filePath}.`);
  trackEdit(mode, filePath);
}

async function cmdReplace(filePath, oldTextArg, newTextArg) {
  ensurePresetAllows('write');
  if (!filePath) {
    throw new Error('Usage: replace <file>');
  }
  const absolutePath = resolveInsideRoot(filePath);
  const content = await fs.readFile(absolutePath, 'utf8');
  const oldText = decodeEscapedText(oldTextArg ?? (await question('Text to replace: ')));
  if (!oldText) {
    throw new Error('Replace text cannot be empty.');
  }
  const newText = decodeEscapedText(newTextArg ?? (await question('Replacement text: ')));
  const count = content.split(oldText).length - 1;
  if (count === 0) {
    console.log('No occurrences found.');
    return;
  }
  const confirmed = await confirm(`Replace ${count} occurrence(s) in ${filePath}?`);
  if (!confirmed) {
    console.log('Canceled.');
    return;
  }
  await createBackupIfFileExists(filePath);
  await fs.writeFile(absolutePath, content.replaceAll(oldText, newText), 'utf8');
  console.log(`Updated ${filePath}.`);
  trackEdit('replace', filePath);
}

async function cmdPatch(filePath, oldTextArg, newTextArg) {
  ensurePresetAllows('write');
  if (!filePath) {
    throw new Error('Usage: patch <file> <old> <new>');
  }
  if (oldTextArg === undefined || newTextArg === undefined) {
    throw new Error('Usage: patch <file> <old> <new>');
  }

  const absolutePath = resolveInsideRoot(filePath);
  const content = await fs.readFile(absolutePath, 'utf8');
  const oldText = decodeEscapedText(oldTextArg);
  const newText = decodeEscapedText(newTextArg);
  const occurrences = content.split(oldText).length - 1;

  if (occurrences === 0) {
    console.log(`No exact match found for "${oldText}" in ${filePath}.`);
    return;
  }
  if (occurrences > 1) {
    console.log(
      `Patch aborted: "${oldText}" appears ${occurrences} times in ${filePath}. Use a more specific target or fall back to replace.`,
    );
    return;
  }

  const confirmed = await confirm(`Apply exact patch to ${filePath}?`);
  if (!confirmed) {
    console.log('Canceled.');
    return;
  }

  await createBackupIfFileExists(filePath);
  await fs.writeFile(absolutePath, content.replace(oldText, newText), 'utf8');
  console.log(`Patched ${filePath}.`);
  trackEdit('patch', filePath);
}

async function cmdPatchBlock(filePath, oldTextArg, newTextArg) {
  await cmdPatch(filePath, oldTextArg, newTextArg);
}

async function cmdPatchLines(filePath, startArg, endArg, replacementArg) {
  ensurePresetAllows('write');
  if (!filePath || !startArg || !endArg || replacementArg === undefined) {
    throw new Error('Usage: patch-lines <file> <start> <end> <new>');
  }

  const { start, end } = parseLineRange(startArg, endArg);
  const replacementText = decodeEscapedText(replacementArg);
  const absolutePath = resolveInsideRoot(filePath);
  const content = await fs.readFile(absolutePath, 'utf8');
  const lines = content.split('\n');

  if (end > lines.length) {
    console.log(`${filePath} only has ${lines.length} lines.`);
    return;
  }

  const confirmed = await confirm(`Apply line patch to ${filePath}:${start}-${end}?`);
  if (!confirmed) {
    console.log('Canceled.');
    return;
  }

  await createBackupIfFileExists(filePath);
  const nextContent = applyLinePatch(content, start, end, replacementText);
  await fs.writeFile(absolutePath, nextContent, 'utf8');
  console.log(`Patched lines ${start}-${end} in ${filePath}.`);
  trackEdit(`patch-lines ${start}-${end}`, filePath);
}

async function cmdPatchAnchor(filePath, anchorArg, oldTextArg, newTextArg) {
  ensurePresetAllows('write');
  if (!filePath || anchorArg === undefined || oldTextArg === undefined || newTextArg === undefined) {
    throw new Error('Usage: patch-anchor <file> <anchor> <old> <new>');
  }

  const anchorText = decodeEscapedText(anchorArg);
  const oldText = decodeEscapedText(oldTextArg);
  const newText = decodeEscapedText(newTextArg);
  const absolutePath = resolveInsideRoot(filePath);
  const content = await fs.readFile(absolutePath, 'utf8');

  let result;
  try {
    result = applyAnchorPatch(content, anchorText, oldText, newText);
  } catch (error) {
    console.log(
      `Patch-anchor aborted: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const confirmed = await confirm(`Apply anchor patch to ${filePath}?`);
  if (!confirmed) {
    console.log('Canceled.');
    return;
  }

  await createBackupIfFileExists(filePath);
  await fs.writeFile(absolutePath, result.afterContent, 'utf8');
  console.log(`Patched anchored text in ${filePath}.`);
  trackEdit('patch-anchor', filePath);
}

async function cmdRun(commandText) {
  ensurePresetAllows('run');
  if (!commandText) {
    throw new Error('Usage: run <shell command>');
  }
  const confirmed = await confirm(`Run "${commandText}" inside ${ROOT_DIR}?`);
  if (!confirmed) {
    console.log('Canceled.');
    return;
  }

  await new Promise((resolve, reject) => {
    const child = spawn(commandText, {
      cwd: ROOT_DIR,
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        CLAUDE_CODE_EXPERIMENT_ROOT: ROOT_DIR,
      },
    });

    child.on('exit', code => {
      console.log(`Process exited with code ${code ?? 0}.`);
      resolve();
    });
    child.on('error', reject);
  });
  trackRun(commandText);
}

async function cmdHistory(linesArg = '20') {
  const lineCount = Math.max(1, Math.min(Number.parseInt(linesArg, 10) || 20, 200));
  const content = await fs.readFile(SESSION_LOG, 'utf8');
  content
    .trimEnd()
    .split('\n')
    .slice(-lineCount)
    .forEach(line => console.log(line));
}

async function handleCommand(commandLine, isNested = false) {
  const tokens = tokenize(commandLine);
  const [rawCommand, ...rest] = tokens;
  const command = normalizeCommandName(rawCommand);

  switch (command) {
    case '':
    case undefined:
      return false;
    case 'help':
      await cmdHelp();
      return false;
    case 'tools':
      await cmdTools();
      return false;
    case 'adapter':
      await cmdAdapter();
      return false;
    case 'agents':
      await cmdAgents();
      return false;
    case 'agent':
      await cmdAgent(rest[0], rest.slice(1).join(' '));
      return false;
    case 'agent-memory':
      await cmdAgentMemory(rest[0], rest[1]);
      return false;
    case 'mode':
      await cmdMode();
      return false;
    case 'status':
      await cmdStatus();
      return false;
    case 'plan':
      await cmdPlan(rest.join(' '));
      return false;
    case 'ask':
      await cmdAsk(rest.join(' '));
      return false;
    case 'think':
      await cmdThink(rest.join(' '));
      return false;
    case 'solve':
      await cmdSolve(rest.join(' '));
      return false;
    case 'preview':
      await cmdPreview(commandLine.trim().replace(/^\/?preview\b\s*/, ''));
      return false;
    case 'memory':
      await cmdMemory(rest[0]);
      return false;
    case 'recap':
      await cmdRecap(rest[0]);
      return false;
    case 'pwd':
      console.log(ROOT_DIR);
      return false;
    case 'summary':
      await cmdSummary(rest[0]);
      return false;
    case 'ls':
      await cmdLs(rest[0]);
      return false;
    case 'tree':
      await cmdTree(rest[0], rest[1]);
      return false;
    case 'read':
      await cmdRead(rest[0], rest[1], rest[2]);
      return false;
    case 'find':
      await cmdFind(rest[0], rest[1]);
      return false;
    case 'grep':
      await cmdGrep(rest[0], rest[1]);
      return false;
    case 'diff':
      await cmdDiff(rest[0]);
      return false;
    case 'restore':
      await cmdRestore(rest[0]);
      return false;
    case 'patch':
      await cmdPatch(rest[0], rest[1], rest[2]);
      return false;
    case 'patch-block':
      await cmdPatchBlock(rest[0], rest[1], rest[2]);
      return false;
    case 'patch-lines':
      await cmdPatchLines(rest[0], rest[1], rest[2], rest.slice(3).join(' '));
      return false;
    case 'patch-anchor':
      await cmdPatchAnchor(rest[0], rest[1], rest[2], rest.slice(3).join(' '));
      return false;
    case 'write':
      await cmdWrite(rest[0], 'write', rest.slice(1).join(' ') || undefined);
      return false;
    case 'append':
      await cmdWrite(rest[0], 'append', rest.slice(1).join(' ') || undefined);
      return false;
    case 'replace':
      await cmdReplace(rest[0], rest[1], rest[2]);
      return false;
    case 'run':
      await cmdRun(rest.join(' '));
      return false;
    case 'history':
      await cmdHistory(rest[0]);
      return false;
    case 'quit':
    case 'exit':
      return true;
    default:
      if (!isNested) {
        console.log(`Unknown command: ${command}`);
        await cmdHelp();
      } else {
        throw new Error(`Unknown routed command: ${command}`);
      }
      return false;
  }
}

async function main() {
  await ensureWorkspaceStateDirs();
  await logEvent('session.start', `root=${ROOT_DIR} preset=${presetName} user=${os.userInfo().username}`);

  printHeader();

  if (!input.isTTY) {
    let buffer = '';
    for await (const chunk of input) {
      buffer += chunk;
    }

    const lines = buffer.split(/\r?\n/).filter(line => line.length > 0);
    for (const line of lines) {
      trackCommand(line);
      await logEvent('command', line);
      const shouldExit = await handleCommand(line);
      if (shouldExit) {
        rl?.close();
        await finalizeSession('user-exit');
        return;
      }
    }

    rl?.close();
    await finalizeSession('stdin-complete');
    return;
  }

  while (true) {
    const commandLine = await question(buildPrompt());
    try {
      trackCommand(commandLine || '(empty)');
      await logEvent('command', commandLine || '(empty)');
      const shouldExit = await handleCommand(commandLine);
      if (shouldExit) {
        rl?.close();
        await finalizeSession('user-exit');
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logEvent('error', message);
      trackError(message);
      console.error(`Error: ${message}`);
    }
  }
}

main().catch(async error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  try {
    await ensureWorkspaceStateDirs();
    await logEvent('fatal', message);
  } finally {
    trackError(message);
    console.error(message);
    process.exit(1);
  }
});
