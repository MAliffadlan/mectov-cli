function quoteIfNeeded(value) {
  if (!value) {
    return value;
  }
  return /\s/.test(value) ? `"${value}"` : value;
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
    'show',
    'inspect',
    'review',
    'audit',
    'analyze',
    'analyse',
    'read',
    'open',
    'find',
    'search',
    'grep',
    'list',
    'tree',
    'summary',
    'summarize',
    'overview',
    'stats',
    'breakdown',
    'count',
    'diff',
    'restore',
    'replace',
    'write',
    'append',
    'run',
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
    'path',
    'file',
    'files',
    'folder',
    'directory',
    'repo',
    'workspace',
  ]);

  return pathMatches.filter(candidate => {
    const normalized = candidate.toLowerCase();
    return !stopWords.has(normalized);
  });
}

function extractShellSnippet(request) {
  const quotedValues = extractQuotedValues(request);
  if (quotedValues.length > 0) {
    return quotedValues[0];
  }

  const runMatch = request.match(
    /(?:run|execute|launch|start|test|build)\s+(.+)/i,
  );
  return runMatch?.[1]?.trim() ?? null;
}

function isPathLike(candidate) {
  return candidate.includes('/') || /\.[A-Za-z0-9_-]+$/.test(candidate);
}

function inferReplacementValues(request, quotedValues) {
  if (quotedValues.length >= 2) {
    return {
      oldText: quotedValues[0],
      newText: quotedValues[1],
    };
  }

  const replaceMatch = request.match(/replace\s+([^\s]+)\s+with\s+([^\s]+)/i);
  if (!replaceMatch) {
    return {
      oldText: null,
      newText: null,
    };
  }

  return {
    oldText: replaceMatch[1],
    newText: replaceMatch[2],
  };
}

function inferLineReplacementValue(request, quotedValues) {
  if (quotedValues.length >= 1) {
    return quotedValues.at(-1) ?? null;
  }

  const match = request.match(/(?:with|to)\s+(.+?)$/i);
  return match?.[1]?.trim() ?? null;
}

function inferAnchorValue(request, quotedValues) {
  if (!/(within|inside|around|near|in context|anchored by|under)/i.test(request)) {
    return null;
  }
  if (quotedValues.length >= 3) {
    return quotedValues[2];
  }

  const match = request.match(
    /(?:within|inside|around|near|in context|anchored by|under)\s+(.+?)$/i,
  );
  return match?.[1]?.trim() ?? null;
}

function buildCommand(toolName, args = []) {
  const filteredArgs = args.filter(
    value => value !== undefined && value !== null && String(value).length > 0,
  );
  return [toolName, ...filteredArgs.map(value => quoteIfNeeded(String(value)))].join(
    ' ',
  );
}

function createCandidate(tool, score, reason, command, notes = []) {
  return {
    tool: tool.name,
    score,
    reason,
    command,
    notes,
    readOnly: tool.safety === 'read-only',
    enabled: tool.enabled,
  };
}

export function createLocalToolRegistry({ presetName, activePreset }) {
  const tools = [
    {
      name: 'summary',
      category: 'inspect',
      safety: 'read-only',
      enabled: true,
      description: 'Summarize directory size, file counts, and top extensions.',
      examples: ['summary src'],
    },
    {
      name: 'ls',
      category: 'inspect',
      safety: 'read-only',
      enabled: true,
      description: 'List files and folders in a workspace path.',
      examples: ['ls src'],
    },
    {
      name: 'tree',
      category: 'inspect',
      safety: 'read-only',
      enabled: true,
      description: 'Show a shallow workspace tree.',
      examples: ['tree src 2'],
    },
    {
      name: 'read',
      category: 'inspect',
      safety: 'read-only',
      enabled: true,
      description: 'Read a file with line numbers.',
      examples: ['read README.md 1 40'],
    },
    {
      name: 'explain',
      category: 'inspect',
      safety: 'read-only',
      enabled: true,
      description: 'Explain a file or folder in a concise, human-readable summary.',
      examples: ['explain src/tools/AgentTool'],
    },
    {
      name: 'inspect',
      category: 'inspect',
      safety: 'read-only',
      enabled: true,
      description: 'Inspect a file or folder with richer metadata and risk signals.',
      examples: ['inspect src/tools.ts'],
    },
    {
      name: 'find',
      category: 'search',
      safety: 'read-only',
      enabled: true,
      description: 'Find files by name fragment.',
      examples: ['find AgentTool src'],
    },
    {
      name: 'grep',
      category: 'search',
      safety: 'read-only',
      enabled: true,
      description: 'Search file contents for matching text.',
      examples: ['grep "AgentTool" src'],
    },
    {
      name: 'changes',
      category: 'change-review',
      safety: 'read-only',
      enabled: true,
      description: 'Show git working tree changes for a path or workspace.',
      examples: ['changes .'],
    },
    {
      name: 'diff',
      category: 'change-review',
      safety: 'read-only',
      enabled: true,
      description: 'Compare a file with its latest automatic backup.',
      examples: ['diff demo.txt'],
    },
    {
      name: 'review',
      category: 'change-review',
      safety: 'read-only',
      enabled: true,
      description: 'Run a lightweight risk review on a file or area.',
      examples: ['review src/tools/AgentTool'],
    },
    {
      name: 'restore',
      category: 'change-review',
      safety: 'write',
      enabled: activePreset.allowWrite,
      description: 'Restore a file from its latest backup.',
      examples: ['restore demo.txt'],
    },
    {
      name: 'patch',
      category: 'edit',
      safety: 'write',
      enabled: activePreset.allowWrite,
      description: 'Apply an exact single-match text patch inside a file.',
      examples: ['patch notes.txt old new'],
    },
    {
      name: 'patch-block',
      category: 'edit',
      safety: 'write',
      enabled: activePreset.allowWrite,
      description: 'Apply an exact single-match multi-line patch using escaped text like \\n.',
      examples: ['patch-block notes.txt "a\\nb" "a\\nc"'],
    },
    {
      name: 'patch-lines',
      category: 'edit',
      safety: 'write',
      enabled: activePreset.allowWrite,
      description: 'Apply an exact patch to a specific line range.',
      examples: ['patch-lines notes.txt 2 3 "new line\\nother line"'],
    },
    {
      name: 'patch-anchor',
      category: 'edit',
      safety: 'write',
      enabled: activePreset.allowWrite,
      description: 'Apply an exact patch inside a unique anchor block.',
      examples: ['patch-anchor notes.txt "section\\nold\\nend" old new'],
    },
    {
      name: 'write',
      category: 'edit',
      safety: 'write',
      enabled: activePreset.allowWrite,
      description: 'Create or overwrite a file. Backs up existing content first.',
      examples: ['write notes.txt "hello world"'],
    },
    {
      name: 'append',
      category: 'edit',
      safety: 'write',
      enabled: activePreset.allowWrite,
      description: 'Append new text to a file. Backs up existing content first.',
      examples: ['append notes.txt "next line"'],
    },
    {
      name: 'replace',
      category: 'edit',
      safety: 'write',
      enabled: activePreset.allowWrite,
      description: 'Replace one string with another inside a file.',
      examples: ['replace notes.txt old new'],
    },
    {
      name: 'run',
      category: 'execute',
      safety: 'run',
      enabled: activePreset.allowRun,
      description: 'Run a shell command inside the workspace root.',
      examples: ['run bun test'],
    },
  ];

  return {
    presetName,
    activePreset,
    tools,
  };
}

export function formatToolRegistry(registry) {
  return registry.tools.map(tool => {
    const status = tool.enabled ? 'enabled' : 'disabled';
    return `${tool.name.padEnd(8, ' ')} ${status.padEnd(8, ' ')} ${tool.category.padEnd(13, ' ')} ${tool.description}`;
  });
}

export function planLocalTask(request, registry) {
  const normalized = request.trim().toLowerCase();
  const quotedValues = extractQuotedValues(request);
  const pathCandidates = extractPathCandidates(request);
  const explicitPaths = pathCandidates.filter(candidate => isPathLike(candidate));
  const nonPathCandidates = pathCandidates.filter(candidate => !isPathLike(candidate));
  const primaryPath = explicitPaths[0] ?? null;
  const secondaryPath = explicitPaths[1] ?? null;
  const primaryQuoted = quotedValues[0] ?? null;
  const secondaryQuoted = quotedValues[1] ?? null;
  const { oldText, newText } = inferReplacementValues(request, quotedValues);
  const lineReplacementText = inferLineReplacementValue(request, quotedValues);
  const anchorText = inferAnchorValue(request, quotedValues);
  const toolsByName = new Map(registry.tools.map(tool => [tool.name, tool]));
  const candidates = [];

  const summaryTool = toolsByName.get('summary');
  const explainTool = toolsByName.get('explain');
  if (/(explain|jelaskan|jelasin|describe|what is this|what does this do)/i.test(normalized)) {
    candidates.push(
      createCandidate(
        explainTool,
        10,
        'Request asks for a human-readable explanation of a file or folder.',
        buildCommand('explain', [primaryPath ?? '.']),
      ),
    );
  }

  const inspectTool = toolsByName.get('inspect');
  if (/(inspect|analyze|analyse|profile|detail|details|bedah)/i.test(normalized)) {
    candidates.push(
      createCandidate(
        inspectTool,
        9,
        'Request asks for a deeper inspection of a file or folder.',
        buildCommand('inspect', [primaryPath ?? '.']),
      ),
    );
  }

  if (/(summary|summarize|overview|stats|breakdown|count)/i.test(normalized)) {
    candidates.push(
      createCandidate(
        summaryTool,
        8,
        'Request asks for a high-level overview or counts.',
        buildCommand('summary', [primaryPath ?? '.']),
      ),
    );
  }

  const treeTool = toolsByName.get('tree');
  if (/(tree|structure|layout|hierarchy)/i.test(normalized)) {
    candidates.push(
      createCandidate(
        treeTool,
        7,
        'Request asks about directory structure.',
        buildCommand('tree', [primaryPath ?? '.', '2']),
      ),
    );
  }

  const lsTool = toolsByName.get('ls');
  if (/(list|show files|show folders|what is in)/i.test(normalized)) {
    candidates.push(
      createCandidate(
        lsTool,
        6,
        'Request asks to list files or folders.',
        buildCommand('ls', [primaryPath ?? '.']),
      ),
    );
  }

  const readTool = toolsByName.get('read');
  if (
    /(read|show|open|print|display)/i.test(normalized) &&
    primaryPath &&
    (primaryPath.includes('.') || primaryPath.includes('/'))
  ) {
    candidates.push(
      createCandidate(
        readTool,
        9,
        'Request looks like reading a specific file.',
        buildCommand('read', [primaryPath, '1', '40']),
      ),
    );
  }

  const findTool = toolsByName.get('find');
  if (/(find file|find files|filename|named)/i.test(normalized)) {
    candidates.push(
      createCandidate(
        findTool,
        8,
        'Request asks to locate files by name.',
        buildCommand('find', [primaryQuoted ?? nonPathCandidates[0] ?? request.trim(), primaryPath ?? '.']),
      ),
    );
  }

  const grepTool = toolsByName.get('grep');
  if (/(grep|search|contains|where is|where are|references|occurrences|usage)/i.test(normalized)) {
    if (primaryQuoted) {
      candidates.push(
        createCandidate(
          grepTool,
          9,
          'Quoted text is a strong signal for content search.',
          buildCommand('grep', [primaryQuoted, primaryPath ?? secondaryPath ?? '.']),
        ),
      );
    } else if (primaryPath && secondaryPath) {
      candidates.push(
        createCandidate(
          grepTool,
          6,
          'Request looks like content search but text was not quoted.',
          buildCommand('grep', [nonPathCandidates[0] ?? primaryPath, secondaryPath]),
          ['Tip: quote the search text for more reliable routing.'],
        ),
      );
    }
  }

  const diffTool = toolsByName.get('diff');
  const changesTool = toolsByName.get('changes');
  if (/(changes|changed files|what changed|git status|working tree|staged|unstaged|untracked|perubahan)/i.test(normalized)) {
    candidates.push(
      createCandidate(
        changesTool,
        9,
        'Request asks about git working tree changes.',
        buildCommand('changes', [primaryPath ?? '.']),
      ),
    );
  }

  if (/(diff|compare|changes|changed since backup)/i.test(normalized) && primaryPath) {
    candidates.push(
      createCandidate(
        diffTool,
        8,
        'Request asks to compare a file with its backup.',
        buildCommand('diff', [primaryPath]),
      ),
    );
  }

  const reviewTool = toolsByName.get('review');
  if (/(review|audit|risk|risks|bug hunt|scan issues|check issues|cek risiko)/i.test(normalized)) {
    candidates.push(
      createCandidate(
        reviewTool,
        9,
        'Request asks for a lightweight risk review.',
        buildCommand('review', [primaryPath ?? '.']),
      ),
    );
  }

  const restoreTool = toolsByName.get('restore');
  if (/(restore|revert|undo from backup)/i.test(normalized) && primaryPath) {
    candidates.push(
      createCandidate(
        restoreTool,
        8,
        'Request asks to restore a file from backup.',
        buildCommand('restore', [primaryPath]),
        restoreTool.enabled ? [] : ['Current preset blocks write operations.'],
      ),
    );
  }

  const writeTool = toolsByName.get('write');
  if (/(write|create file|new file|save to)/i.test(normalized) && primaryPath) {
    candidates.push(
      createCandidate(
        writeTool,
        7,
        'Request asks to create or overwrite a file.',
        buildCommand('write', [primaryPath, primaryQuoted ?? '...']),
        writeTool.enabled ? [] : ['Current preset blocks write operations.'],
      ),
    );
  }

  const appendTool = toolsByName.get('append');
  if (/(append|add to file|add line)/i.test(normalized) && primaryPath) {
    candidates.push(
      createCandidate(
        appendTool,
        7,
        'Request asks to add content to an existing file.',
        buildCommand('append', [primaryPath, primaryQuoted ?? '...']),
        appendTool.enabled ? [] : ['Current preset blocks write operations.'],
      ),
    );
  }

  const patchTool = toolsByName.get('patch');
  const patchBlockTool = toolsByName.get('patch-block');
  const patchLinesTool = toolsByName.get('patch-lines');
  const patchAnchorTool = toolsByName.get('patch-anchor');
  const lineRangeMatch = request.match(/lines?\s+(\d+)(?:-(\d+)|\s+to\s+(\d+))?/i);
  if (/(block patch|multiline patch|patch block|patch multiline)/i.test(normalized) && primaryPath) {
    candidates.push(
      createCandidate(
        patchBlockTool,
        quotedValues.length >= 2 ? 10 : 7,
        quotedValues.length >= 2
          ? 'Request asks for a block patch with clear old/new text.'
          : 'Request asks for a block patch but needs clearer old/new values.',
        buildCommand('patch-block', [
          primaryPath,
          primaryQuoted ?? 'old_block',
          secondaryQuoted ?? 'new_block',
        ]),
        patchBlockTool.enabled ? [] : ['Current preset blocks write operations.'],
      ),
    );
  }

  if (lineRangeMatch && primaryPath) {
    const start = lineRangeMatch[1];
    const end = lineRangeMatch[2] ?? lineRangeMatch[3] ?? lineRangeMatch[1];
    candidates.push(
      createCandidate(
        patchLinesTool,
        lineReplacementText ? 10 : 8,
        lineReplacementText
          ? 'Request targets a specific line range with replacement text.'
          : 'Request targets a specific line range but replacement text may need review.',
        buildCommand('patch-lines', [
          primaryPath,
          start,
          end,
          lineReplacementText ?? 'replacement_text',
        ]),
        patchLinesTool.enabled ? [] : ['Current preset blocks write operations.'],
      ),
    );
  }

  if (anchorText && primaryPath && /(replace|change|update|rewrite|edit|patch)/i.test(normalized)) {
    candidates.push(
      createCandidate(
        patchAnchorTool,
        oldText && newText ? 11 : 8,
        oldText && newText
          ? 'Request targets a specific anchor block with clear old/new text.'
          : 'Request targets a specific anchor block but old/new text may need review.',
        buildCommand('patch-anchor', [
          primaryPath,
          anchorText,
          oldText ?? primaryQuoted ?? 'old_text',
          newText ?? secondaryQuoted ?? 'new_text',
        ]),
        patchAnchorTool.enabled ? [] : ['Current preset blocks write operations.'],
      ),
    );
  }

  if (/(patch|change exactly|update exactly)/i.test(normalized) && primaryPath) {
    candidates.push(
      createCandidate(
        patchTool,
        oldText && newText ? 10 : 7,
        oldText && newText
          ? 'Request asks for an exact patch with clear old/new text.'
          : 'Request asks for an exact patch but needs clearer old/new values.',
        buildCommand('patch', [
          primaryPath,
          oldText ?? primaryQuoted ?? 'old_text',
          newText ?? secondaryQuoted ?? 'new_text',
        ]),
        patchTool.enabled ? [] : ['Current preset blocks write operations.'],
      ),
    );
  }

  const replaceTool = toolsByName.get('replace');
  if (/(replace|substitute|swap text)/i.test(normalized) && primaryPath) {
    candidates.push(
      createCandidate(
        patchTool,
        oldText && newText ? 10 : 7,
        oldText && newText
          ? 'Request looks like a precise edit, so exact patching is preferred.'
          : 'Request asks for a text edit but needs clearer old/new values.',
        buildCommand('patch', [
          primaryPath,
          oldText ?? primaryQuoted ?? 'old_text',
          newText ?? secondaryQuoted ?? 'new_text',
        ]),
        patchTool.enabled ? [] : ['Current preset blocks write operations.'],
      ),
    );
    candidates.push(
      createCandidate(
        replaceTool,
        oldText && newText ? 9 : 6,
        oldText && newText
          ? 'Broader replace is available if you intentionally want all matches changed.'
          : 'Request asks for text replacement but needs clearer old/new values.',
        buildCommand('replace', [
          primaryPath,
          oldText ?? primaryQuoted ?? 'old_text',
          newText ?? secondaryQuoted ?? 'new_text',
        ]),
        replaceTool.enabled ? [] : ['Current preset blocks write operations.'],
      ),
    );
  }

  const runTool = toolsByName.get('run');
  const shellSnippet = extractShellSnippet(request);
  if (/(run|execute|launch|start|test|build)/i.test(normalized) && shellSnippet) {
    candidates.push(
      createCandidate(
        runTool,
        8,
        'Request asks to execute a shell command.',
        buildCommand('run', [shellSnippet]),
        runTool.enabled ? [] : ['Current preset blocks shell execution.'],
      ),
    );
  }

  candidates.sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool));

  let selected = candidates[0] ?? null;
  if (selected && !selected.enabled) {
    selected = null;
  }

  const notes = [];
  if (selected?.readOnly) {
    notes.push('Selected action is read-only and safe to auto-run.');
  }
  if (!selected && candidates.length > 0) {
    notes.push('A matching tool exists, but the current preset blocks it.');
  }
  if (candidates.length === 0) {
    notes.push('No confident match. Try a direct command or quote the text/path you want to target.');
  }

  return {
    request,
    selected,
    candidates: candidates.slice(0, 5),
    notes,
  };
}
