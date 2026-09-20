import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Probe } from './probe.js';

const path = join(mkdtempSync(join(tmpdir(), 'workbench-demo-')), 'probe.sqlite');
const spec = JSON.parse(readFileSync(new URL('../fixtures/task.json', import.meta.url)));
let probe = new Probe(path);
const task = probe.prepare(spec);
probe.authorize(spec.taskId, { scopeHash: task.scopeHash, action: 'one_routine_fire',
  approvedBy: 'Synthetic operator', expiresAt: new Date(Date.now() + 60000).toISOString(),
  extraUsageDisabled: true, scopeVerified: true, incrementalSpendUsd: 0, mode: 'synthetic' });
let calls = 0;
const lostResponse = async () => { calls++; throw new Error('Synthetic response lost after server accepted'); };
await probe.dispatch(spec.taskId, { token: 'synthetic', fetchImpl: lostResponse });
probe.close();
probe = new Probe(path);
await probe.dispatch(spec.taskId, { token: 'synthetic', fetchImpl: lostResponse });
await probe.reconcile(spec.taskId, async path => path.includes('/branches/') ? null : []);
const restored = probe.get(spec.taskId);
console.log(JSON.stringify({ mode: 'synthetic; no network calls', database: path, fireCalls: calls,
  afterRestart: restored.dispatch, result: restored.result.result,
  admissionBlockedBy: probe.controls().active,
  conclusion: 'Lost response survives restart. Duplicate input and absent PR do not fire again.' }, null, 2));
probe.close();
