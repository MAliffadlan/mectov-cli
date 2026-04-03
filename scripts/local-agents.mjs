function appendUniqueStep(steps, step) {
  if (!steps.some(existing => existing.command === step.command)) {
    steps.push(step);
  }
}

function isLikelyFilePath(target) {
  return /\.[A-Za-z0-9_-]+$/.test(target);
}

function inferFocusPath(workflow) {
  const summaryStep = workflow.steps.find(step => step.command.startsWith('summary '));
  if (summaryStep) {
    return summaryStep.command.replace(/^summary\s+/, '').trim() || '.';
  }

  const readStep = workflow.steps.find(step => step.command.startsWith('read '));
  if (readStep) {
    const parts = readStep.command.split(/\s+/);
    return parts[1] || '.';
  }

  const treeStep = workflow.steps.find(step => step.command.startsWith('tree '));
  if (treeStep) {
    const parts = treeStep.command.split(/\s+/);
    return parts[1] || '.';
  }

  return '.';
}

export const LOCAL_AGENTS = {
  generalist: {
    name: 'generalist',
    description: 'Balanced default agent for broad repo exploration.',
    style: 'Flexible, neutral workflow.',
  },
  explorer: {
    name: 'explorer',
    description: 'Maps code structure and traces symbols before going deep.',
    style: 'Prefers summary, tree, and grep before detailed reads.',
  },
  reviewer: {
    name: 'reviewer',
    description: 'Looks for risks, changed behavior, and evidence in files.',
    style: 'Prefers diff, read, and issue-oriented search.',
  },
  editor: {
    name: 'editor',
    description: 'Focuses on file changes with verification after each mutation.',
    style: 'Prefers read, edit, and diff with explicit approval checkpoints.',
  },
  'statusline-helper': {
    name: 'statusline-helper',
    description: 'Focuses on status line, prompt, and shell-config related work.',
    style: 'Biases toward prompt/statusline/PS1 searches and relevant file reads.',
  },
};

export function listLocalAgents() {
  return Object.values(LOCAL_AGENTS);
}

export function getLocalAgent(agentName) {
  return LOCAL_AGENTS[agentName] ?? null;
}

export function applyAgentProfile(agentName, workflow) {
  const nextWorkflow = {
    ...workflow,
    notes: [...workflow.notes],
    steps: workflow.steps.map(step => ({ ...step })),
  };
  const focusPath = inferFocusPath(nextWorkflow);

  switch (agentName) {
    case 'explorer':
      nextWorkflow.notes.unshift(
        'Explorer agent favors broad orientation before line-by-line inspection.',
      );
      if (nextWorkflow.intent === 'search' && nextWorkflow.steps.length > 0) {
        appendUniqueStep(nextWorkflow.steps, {
          goal: 'Summarize the surrounding area for context.',
          command: 'summary .',
          readOnly: true,
          enabled: true,
        });
      }
      break;
    case 'reviewer':
      nextWorkflow.notes.unshift(
        'Reviewer agent prioritizes evidence of risk, regression, and behavior changes.',
      );
      if (nextWorkflow.intent !== 'diff') {
        const firstRead = nextWorkflow.steps.find(step => step.command.startsWith('read '));
        if (firstRead) {
          appendUniqueStep(nextWorkflow.steps, {
            goal: 'Look for issue markers in the same area.',
            command: `grep TODO ${focusPath}`,
            readOnly: true,
            enabled: true,
          });
        }
      }
      break;
    case 'editor':
      nextWorkflow.notes.unshift(
        'Editor agent is optimized for file changes and post-edit verification.',
      );
      if (
        isLikelyFilePath(focusPath) &&
        !nextWorkflow.steps.some(step => step.command.startsWith('diff '))
      ) {
        appendUniqueStep(nextWorkflow.steps, {
          goal: 'Review the final result after editing.',
          command: `diff ${focusPath}`,
          readOnly: true,
          enabled: true,
        });
      }
      break;
    case 'statusline-helper':
      nextWorkflow.notes.unshift(
        'Statusline helper agent looks for prompt and status line signals first.',
      );
      appendUniqueStep(nextWorkflow.steps, {
        goal: 'Search for status line related terms.',
        command: `grep statusLine ${focusPath}`,
        readOnly: true,
        enabled: true,
      });
      appendUniqueStep(nextWorkflow.steps, {
        goal: 'Search for shell prompt related terms.',
        command: `grep PS1 ${focusPath}`,
        readOnly: true,
        enabled: true,
      });
      break;
    default:
      nextWorkflow.notes.unshift('Generalist agent used.');
      break;
  }

  return nextWorkflow;
}
