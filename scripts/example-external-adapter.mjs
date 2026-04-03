#!/usr/bin/env node

import { planWorkflow } from './example-module-adapter.mjs';

try {
  let payloadText = process.env.MECTOV_ADAPTER_PAYLOAD ?? '';
  if (!payloadText) {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      buffer += chunk;
    }
    payloadText = buffer;
  }

  const payload = JSON.parse(payloadText || '{}');
  const workflow = planWorkflow(payload);

  process.stdout.write(`${JSON.stringify(workflow)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
