function quoteIfNeeded(value) {
  if (!value) {
    return value;
  }
  return /\s/.test(value) ? `"${value}"` : value;
}

function buildCommand(name, args = []) {
  const filtered = args.filter(
    value => value !== undefined && value !== null && String(value).length > 0,
  );
  return [name, ...filtered.map(value => quoteIfNeeded(String(value)))].join(' ');
}

function trimPunctuation(value) {
  return value.replace(/^[,.:;]+|[,.:;]+$/g, '');
}

function extractQuotedValues(request) {
  return [...request.matchAll(/"([^"]+)"|'([^']+)'/g)].map(
    match => match[1] ?? match[2],
  );
}

function extractPathCandidates(request) {
  const pathMatches = request.match(
    /(?:\.{0,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*(?:\.[A-Za-z0-9_-]+)?/g,
  );
  if (!pathMatches) {
    return [];
  }

  const stopWords = new Set([
    'explain',
    'understand',
    'inspect',
    'investigate',
    'analyze',
    'analyse',
    'show',
    'read',
    'open',
    'search',
    'find',
    'grep',
    'where',
    'usage',
    'usages',
    'reference',
    'references',
    'summary',
    'summarize',
    'tree',
    'list',
    'walkthrough',
    'walk',
    'through',
    'compare',
    'diff',
    'changes',
    'what',
    'how',
    'why',
    'is',
    'in',
    'the',
    'a',
    'an',
    'for',
    'of',
    'to',
    'with',
    'from',
    'and',
    'or',
    'this',
    'that',
    'these',
    'those',
    'module',
    'folder',
    'directory',
    'repo',
    'project',
    'codebase',
  ]);

  return pathMatches.filter(candidate => !stopWords.has(candidate.toLowerCase()));
}

function normalizeRequest(request) {
  return request.trim().toLowerCase();
}

function dedupeSteps(steps) {
  const seen = new Set();
  return steps.filter(step => {
    if (seen.has(step.command)) {
      return false;
    }
    seen.add(step.command);
    return true;
  });
}

function isPathLike(candidate) {
  return candidate.includes('/') || /\.[A-Za-z0-9_-]+$/.test(candidate);
}

function createStep(goal, command, readOnly = true) {
  return { goal, command, readOnly };
}

function inferTargetPath(pathCandidates) {
  const pathLike = pathCandidates.find(candidate => isPathLike(candidate));
  if (pathLike) {
    return pathLike;
  }
  if (pathCandidates.length === 0) {
    return '.';
  }
  return '.';
}

function inferSymbol(request, quotedValues, pathCandidates) {
  if (quotedValues.length > 0) {
    return quotedValues[0];
  }

  const symbolCandidate = pathCandidates.find(candidate => !isPathLike(candidate));
  if (symbolCandidate) {
    return symbolCandidate;
  }

  if (pathCandidates.length === 1 && !isPathLike(pathCandidates[0])) {
    return pathCandidates[0];
  }

  const symbolMatch = request.match(
    /(?:search|find|grep|usage|references?|where is|look for)\s+([A-Za-z0-9_.:-]+)/i,
  );
  return symbolMatch?.[1] ?? null;
}

function inferFileTarget(pathCandidates) {
  return pathCandidates.find(candidate => isPathLike(candidate)) ?? null;
}

function inferReplacementValues(request, quotedValues) {
  if (quotedValues.length >= 2) {
    return {
      oldText: quotedValues[0],
      newText: quotedValues[1],
    };
  }

  const replaceMatch = request.match(
    /replace\s+([^\s]+)\s+with\s+([^\s]+)\s+/i,
  );
  if (!replaceMatch) {
    return {
      oldText: null,
      newText: null,
    };
  }
  return {
    oldText: trimPunctuation(replaceMatch[1]),
    newText: trimPunctuation(replaceMatch[2]),
  };
}

function inferSingleTextValue(request, quotedValues, verb) {
  if (quotedValues.length >= 1) {
    return quotedValues[0];
  }

  const regex = new RegExp(`${verb}\\s+(.+?)\\s+(?:to|into|in)\\s+`, 'i');
  const match = request.match(regex);
  return match?.[1] ? trimPunctuation(match[1]) : null;
}

function inferLineRange(request) {
  const rangeMatch = request.match(/lines?\s+(\d+)(?:-(\d+)|\s+to\s+(\d+))?/i);
  if (!rangeMatch) {
    return null;
  }

  const start = Number.parseInt(rangeMatch[1], 10);
  const end = Number.parseInt(rangeMatch[2] ?? rangeMatch[3] ?? rangeMatch[1], 10);
  if (Number.isNaN(start) || Number.isNaN(end) || start < 1 || end < start) {
    return null;
  }

  return { start, end };
}

function inferLineReplacementText(request, quotedValues) {
  if (quotedValues.length >= 1) {
    return quotedValues.at(-1) ?? null;
  }

  const match = request.match(/(?:with|to)\s+(.+?)$/i);
  return match?.[1] ? trimPunctuation(match[1]) : null;
}

function inferAnchorText(request, quotedValues) {
  if (!/(within|inside|around|near|in context|anchored by|under)/i.test(request)) {
    return null;
  }
  if (quotedValues.length >= 3) {
    return quotedValues[2];
  }

  const match = request.match(
    /(?:within|inside|around|near|in context|anchored by|under)\s+(.+?)$/i,
  );
  return match?.[1] ? trimPunctuation(match[1]) : null;
}

function buildOverviewWorkflow(request, targetPath, symbol) {
  const steps = [
    createStep('Summarize the target area.', buildCommand('summary', [targetPath])),
    createStep('Show the high-level structure.', buildCommand('tree', [targetPath, '2'])),
  ];

  if (targetPath && targetPath !== '.' && (targetPath.includes('.') || targetPath.includes('/'))) {
    if (/\.[A-Za-z0-9_-]+$/.test(targetPath)) {
      steps.push(
        createStep('Read the main target file.', buildCommand('read', [targetPath, '1', '80'])),
      );
    } else {
      steps.push(
        createStep('List the target directory.', buildCommand('ls', [targetPath])),
      );
    }
  }

  if (symbol) {
    steps.push(
      createStep(
        'Search for the key symbol or phrase.',
        buildCommand('grep', [symbol, targetPath]),
      ),
    );
  }

  return {
    intent: 'overview',
    summary: 'High-level walkthrough of the requested area.',
    steps,
    notes: ['This workflow stays read-only and focuses on fast codebase orientation.'],
  };
}

function buildSearchWorkflow(targetPath, symbol) {
  const steps = [];
  if (symbol) {
    steps.push(
      createStep(
        'Search for matching content.',
        buildCommand('grep', [symbol, targetPath]),
      ),
    );
  }
  if (targetPath && /\.[A-Za-z0-9_-]+$/.test(targetPath)) {
    steps.push(
      createStep('Read the target file for context.', buildCommand('read', [targetPath, '1', '80'])),
    );
  } else {
    steps.push(
      createStep('Show the local structure around the search area.', buildCommand('tree', [targetPath, '2'])),
    );
  }
  return {
    intent: 'search',
    summary: 'Content search with nearby context.',
    steps,
    notes: symbol
      ? ['If results are too broad, rerun with a quoted search term for tighter matching.']
      : ['No explicit search term was found, so the workflow may be broad.'],
  };
}

function buildReadWorkflow(targetPath) {
  return {
    intent: 'read',
    summary: 'Direct file inspection.',
    steps: [createStep('Read the requested file.', buildCommand('read', [targetPath, '1', '80']))],
    notes: [],
  };
}

function buildDiffWorkflow(targetPath) {
  return {
    intent: 'diff',
    summary: 'Compare the target file against its latest backup.',
    steps: [createStep('Show the diff from the latest backup.', buildCommand('diff', [targetPath]))],
    notes: ['Diff is read-only, but it depends on a prior backup existing.'],
  };
}

function buildInspectWorkflow(targetPath, symbol) {
  const steps = [
    createStep('Inspect the requested target in more detail.', buildCommand('inspect', [targetPath])),
  ];

  if (symbol) {
    steps.push(
      createStep(
        'Search for the key symbol or phrase nearby.',
        buildCommand('grep', [symbol, targetPath]),
      ),
    );
  }

  if (targetPath !== '.' && !/\.[A-Za-z0-9_-]+$/.test(targetPath)) {
    steps.push(
      createStep('Show a shallow tree for orientation.', buildCommand('tree', [targetPath, '2'])),
    );
  }

  return {
    intent: 'inspect',
    summary: 'Deeper inspection of the requested file or folder.',
    steps,
    notes: ['Inspection stays read-only and is designed to surface useful structure quickly.'],
  };
}

function buildExplainWorkflow(targetPath) {
  const steps = [createStep('Explain the requested target in plain language.', buildCommand('explain', [targetPath]))];

  if (targetPath !== '.' && !/\.[A-Za-z0-9_-]+$/.test(targetPath)) {
    steps.push(
      createStep('Show a shallow tree for the same area.', buildCommand('tree', [targetPath, '2'])),
    );
  }

  return {
    intent: 'explain',
    summary: 'Generate a concise explanation of the requested file or folder.',
    steps,
    notes: ['Explanation is read-only and combines structure, git context, and quick review hotspots.'],
  };
}

function buildChangesWorkflow(targetPath) {
  const steps = [createStep('Show the git working tree changes.', buildCommand('changes', [targetPath]))];
  if (targetPath !== '.') {
    steps.push(
      createStep('Run a quick review on the same target.', buildCommand('review', [targetPath])),
    );
  }

  return {
    intent: 'changes',
    summary: 'Summarize git changes around the requested area.',
    steps,
    notes: ['Changes view is read-only and depends on the workspace being inside a git repository.'],
  };
}

function buildReviewWorkflow(targetPath) {
  const steps = [];
  if (targetPath === '.') {
    steps.push(createStep('Check the current git change set first.', buildCommand('changes', ['.'])));
  } else {
    steps.push(
      createStep('Inspect the target before reviewing it.', buildCommand('inspect', [targetPath])),
    );
  }
  steps.push(
    createStep('Run a lightweight risk review.', buildCommand('review', [targetPath])),
  );

  return {
    intent: 'review',
    summary: 'Quick review flow focused on risks, markers, and local changes.',
    steps,
    notes: ['Review is heuristic and meant to highlight likely hotspots quickly.'],
  };
}

function buildFallbackWorkflow(targetPath) {
  return {
    intent: 'fallback',
    summary: 'Broad workspace orientation.',
    steps: [
      createStep('Summarize the workspace area.', buildCommand('summary', [targetPath])),
      createStep('Show a shallow tree.', buildCommand('tree', [targetPath, '2'])),
    ],
    notes: ['This is a generic fallback because the request was open-ended.'],
  };
}

function buildReplaceWorkflow(targetPath, oldText, newText) {
  const steps = [];
  const patchCommand =
    (oldText && (oldText.includes('\n') || oldText.includes('\\n'))) ||
    (newText && (newText.includes('\n') || newText.includes('\\n')))
      ? 'patch-block'
      : 'patch';

  if (targetPath) {
    steps.push(
      createStep(
        'Read the file before editing.',
        buildCommand('read', [targetPath, '1', '80']),
      ),
    );
  }

  steps.push(
    createStep(
      'Apply an exact patch to the target text.',
      buildCommand(patchCommand, [targetPath ?? 'target_file', oldText ?? 'old_text', newText ?? 'new_text']),
      false,
    ),
  );

  if (targetPath) {
    steps.push(
      createStep(
        'Review the updated file against its backup.',
        buildCommand('diff', [targetPath]),
      ),
    );
  }

  return {
    intent: 'edit',
    summary: 'Apply a precise single-match patch inside the target file with a guarded review step.',
    steps,
    notes: [
      oldText && newText
        ? 'Patch values were inferred from the request.'
        : 'Patch values were not fully clear, so review the generated command carefully.',
      patchCommand === 'patch-block'
        ? 'A block patch is being used because the target text spans multiple lines.'
        : 'A single-match patch is being used for a precise edit.',
      'Patch requires exactly one match. Use replace directly when you intentionally want a broader substitution.',
    ],
  };
}

function buildLinePatchWorkflow(targetPath, lineRange, replacementText) {
  const steps = [];

  if (targetPath) {
    steps.push(
      createStep(
        'Read the file before editing.',
        buildCommand('read', [targetPath, String(Math.max(1, lineRange.start - 3)), String(lineRange.end + 3)]),
      ),
    );
  }

  steps.push(
    createStep(
      'Apply an exact line-range patch.',
      buildCommand('patch-lines', [
        targetPath ?? 'target_file',
        String(lineRange.start),
        String(lineRange.end),
        replacementText ?? 'replacement_text',
      ]),
      false,
    ),
  );

  if (targetPath) {
    steps.push(
      createStep(
        'Review the updated file against its backup.',
        buildCommand('diff', [targetPath]),
      ),
    );
  }

  return {
    intent: 'edit',
    summary: 'Apply a precise line-range patch with a guarded review step.',
    steps,
    notes: [
      replacementText
        ? 'Line patch replacement text was inferred from the request.'
        : 'Line patch replacement text was not fully clear, so review the generated command carefully.',
      `Targeting lines ${lineRange.start}-${lineRange.end}.`,
    ],
  };
}

function buildAnchorPatchWorkflow(targetPath, anchorText, oldText, newText) {
  const steps = [];

  if (targetPath) {
    steps.push(
      createStep(
        'Read the file before editing.',
        buildCommand('read', [targetPath, '1', '120']),
      ),
    );
  }

  steps.push(
    createStep(
      'Apply an exact patch inside the anchored context block.',
      buildCommand('patch-anchor', [
        targetPath ?? 'target_file',
        anchorText ?? 'anchor_text',
        oldText ?? 'old_text',
        newText ?? 'new_text',
      ]),
      false,
    ),
  );

  if (targetPath) {
    steps.push(
      createStep(
        'Review the updated file against its backup.',
        buildCommand('diff', [targetPath]),
      ),
    );
  }

  return {
    intent: 'edit',
    summary: 'Apply a precise anchored patch inside a unique context block with a guarded review step.',
    steps,
    notes: [
      anchorText
        ? 'Anchor context was inferred from the request.'
        : 'Anchor context was not fully clear, so review the generated command carefully.',
      oldText && newText
        ? 'Patch values were inferred from the request.'
        : 'Patch values were not fully clear, so review the generated command carefully.',
      'Use this when the target text is repeated globally but unique within a nearby block.',
    ],
  };
}

function buildAppendWorkflow(targetPath, textValue) {
  const steps = [];

  if (targetPath) {
    steps.push(
      createStep(
        'Read the file before appending.',
        buildCommand('read', [targetPath, '1', '80']),
      ),
    );
  }

  steps.push(
    createStep(
      'Append the requested text.',
      buildCommand('append', [targetPath ?? 'target_file', textValue ?? '...']),
      false,
    ),
  );

  if (targetPath) {
    steps.push(
      createStep(
        'Review the appended result against its backup.',
        buildCommand('diff', [targetPath]),
      ),
    );
  }

  return {
    intent: 'edit',
    summary: 'Append new content with a diff review after the change.',
    steps,
    notes: [
      textValue
        ? 'Append text was inferred from the request.'
        : 'Append text was not fully clear, so review the generated command carefully.',
    ],
  };
}

function buildWriteWorkflow(targetPath, textValue) {
  const steps = [
    createStep(
      'Write the requested content to the target file.',
      buildCommand('write', [targetPath ?? 'target_file', textValue ?? '...']),
      false,
    ),
  ];

  if (targetPath) {
    steps.push(
      createStep(
        'Read the resulting file for verification.',
        buildCommand('read', [targetPath, '1', '80']),
      ),
    );
  }

  return {
    intent: 'edit',
    summary: 'Write content to a file and verify the result.',
    steps,
    notes: [
      textValue
        ? 'Write content was inferred from the request.'
        : 'Write content was not fully clear, so review the generated command carefully.',
    ],
  };
}

function buildRunWorkflow(commandText) {
  return {
    intent: 'execute',
    summary: 'Run a shell command with an approval checkpoint.',
    steps: [createStep('Execute the requested shell command.', buildCommand('run', [commandText ?? 'echo TODO']), false)],
    notes: commandText
      ? ['Shell command was inferred from the request.']
      : ['Shell command was not fully clear, so review the generated command carefully.'],
  };
}

export function buildLocalWorkflow(request, registry) {
  const normalized = normalizeRequest(request);
  const quotedValues = extractQuotedValues(request);
  const pathCandidates = extractPathCandidates(request);
  const targetPath = inferTargetPath(pathCandidates);
  const fileTarget = inferFileTarget(pathCandidates);
  const symbol = inferSymbol(request, quotedValues, pathCandidates);
  const { oldText, newText } = inferReplacementValues(request, quotedValues);
  const appendText = inferSingleTextValue(request, quotedValues, 'append');
  const writeText = inferSingleTextValue(request, quotedValues, 'write');
  const lineRange = inferLineRange(request);
  const lineReplacementText = inferLineReplacementText(request, quotedValues);
  const anchorText = inferAnchorText(request, quotedValues);
  const runMatch = request.match(/(?:run|execute|launch|start|test|build)\s+(.+)/i);
  const runText = runMatch?.[1]?.trim() ?? quotedValues[0] ?? null;

  let workflow;
  if (anchorText && /(replace|update|change|rewrite|edit|patch)/i.test(normalized)) {
    workflow = buildAnchorPatchWorkflow(fileTarget, anchorText, oldText, newText);
  } else if (lineRange && /(replace|update|change|rewrite|edit)/i.test(normalized)) {
    workflow = buildLinePatchWorkflow(fileTarget, lineRange, lineReplacementText);
  } else if (/(replace|substitute|swap text)/i.test(normalized)) {
    workflow = buildReplaceWorkflow(fileTarget, oldText, newText);
  } else if (/(append|add to file|add line)/i.test(normalized)) {
    workflow = buildAppendWorkflow(fileTarget, appendText);
  } else if (/(write|create file|new file|save to)/i.test(normalized)) {
    workflow = buildWriteWorkflow(fileTarget, writeText);
  } else if (/(run|execute|launch|start|test|build)/i.test(normalized)) {
    workflow = buildRunWorkflow(runText);
  } else if (/(explain|describe|what is this|what does this do)/i.test(normalized)) {
    workflow = buildExplainWorkflow(targetPath);
  } else if (/(review|audit|risk|risks|bug hunt|scan issues|check issues)/i.test(normalized)) {
    workflow = buildReviewWorkflow(targetPath);
  } else if (/(git status|working tree|staged|unstaged|untracked|what changed|changes in repo|changes in project|changes in workspace)/i.test(normalized)) {
    workflow = buildChangesWorkflow(targetPath);
  } else if (/(inspect|analyze|analyse|profile|detail|details)/i.test(normalized)) {
    workflow = buildInspectWorkflow(targetPath, symbol);
  } else if (/(diff|compare|changes?)/i.test(normalized) && targetPath !== '.') {
    workflow = buildDiffWorkflow(targetPath);
  } else if (
    /(read|show|open|print|display)/i.test(normalized) &&
    targetPath !== '.' &&
    /\.[A-Za-z0-9_-]+$/.test(targetPath)
  ) {
    workflow = buildReadWorkflow(targetPath);
  } else if (
    /(search|find|grep|where is|where are|usage|usages|references?)/i.test(normalized) &&
    (symbol || targetPath !== '.')
  ) {
    workflow = buildSearchWorkflow(targetPath, symbol);
  } else if (
    /(explain|understand|inspect|investigate|analyze|analyse|overview|walkthrough|how)/i.test(
      normalized,
    )
  ) {
    workflow = buildOverviewWorkflow(request, targetPath, symbol);
  } else {
    workflow = buildFallbackWorkflow(targetPath);
  }

  const enabledTools = new Set(
    registry.tools.filter(tool => tool.enabled).map(tool => tool.name),
  );
  const steps = dedupeSteps(workflow.steps).map(step => ({
    ...step,
    enabled: enabledTools.has(step.command.split(/\s+/)[0]),
  }));

  const blockedSteps = steps.filter(step => !step.enabled);
  const notes = [...workflow.notes];
  if (blockedSteps.length > 0) {
    notes.push('Some steps are blocked by the active preset.');
  }

  return {
    request,
    intent: workflow.intent,
    summary: workflow.summary,
    steps,
    notes,
    executable: steps.length > 0 && steps.every(step => step.enabled),
    autoRunnable:
      steps.length > 0 && steps.every(step => step.readOnly && step.enabled),
    requiresApproval: steps.some(step => !step.readOnly),
  };
}
