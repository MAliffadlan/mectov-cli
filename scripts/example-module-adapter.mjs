export function planWorkflow(payload = {}) {
  const request = String(payload.request || '');
  const quoted = [...request.matchAll(/"([^"]+)"|'([^']+)'/g)].map(
    match => match[1] ?? match[2],
  );
  const pathMatch = request.match(
    /(?:\.{0,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*(?:\.[A-Za-z0-9_-]+)?/g,
  );
  const targetPath =
    pathMatch?.find(value => value.includes('/') || /\.[A-Za-z0-9_-]+$/.test(value)) ?? '.';
  const searchText = quoted[0] ?? 'TODO';

  if (/(search|find|grep|references|usage)/i.test(request)) {
    return {
      intent: 'search',
      summary: 'Module adapter generated a focused search workflow.',
      confidence: 'high',
      rationale: [
        'The request clearly signals a content search.',
        'A file target was detected, so the workflow can stay narrow.',
      ],
      phases: [
        {
          title: 'Search',
          summary: 'Find matching lines first.',
          steps: [1],
        },
        {
          title: 'Context',
          summary: 'Open the file after the search so the result stays grounded.',
          steps: [2],
        },
      ],
      steps: [
        {
          goal: 'Search for the requested text.',
          command: `grep "${searchText}" ${targetPath}`,
          readOnly: true,
        },
        {
          goal: 'Read the target for nearby context.',
          command: `read ${targetPath} 1 80`,
          readOnly: true,
        },
      ],
      notes: ['This workflow came from the example module adapter.'],
    };
  }

  return {
    intent: 'overview',
    summary: 'Module adapter generated a broad overview workflow.',
    confidence: 'low',
    rationale: [
      'The request looks exploratory rather than action-oriented.',
      'The target is broad enough that the planner cannot be very certain about the best next step.',
    ],
    phases: [
      {
        title: 'Survey',
        summary: 'Get a quick shape of the target first.',
        steps: [1, 2],
      },
    ],
    steps: [
      {
        goal: 'Summarize the target area.',
        command: `summary ${targetPath}`,
        readOnly: true,
      },
      {
        goal: 'Show a shallow tree.',
        command: `tree ${targetPath} 2`,
        readOnly: true,
      },
    ],
    notes: ['This workflow came from the example module adapter.'],
  };
}
