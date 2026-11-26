import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadTask, run, sealAgree, setup, startFull, writePlan } from './helpers.mjs';

test('garbage twice pauses with INVALID_VERDICT', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:garbage');
  const id = started.json.id;
  writePlan(ctx, id);
  sealAgree(ctx, id);
  const asked = run(['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(asked.json.state, 'paused');
  assert.equal(asked.json.reason, 'INVALID_VERDICT');
  assert.equal(loadTask(ctx, id).counters.seatCalls, 2);
});

test('timeout counts the call and pauses', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:timeout');
  const id = started.json.id;
  writePlan(ctx, id);
  sealAgree(ctx, id);
  const asked = run(['ask', '--task', id, '--phase', 'finish-line'], {
    ...ctx,
    env: { CONSENSUS_SEAT_TIMEOUT_MS: '1000' },
    timeout: 30000,
  });
  assert.equal(asked.json.state, 'paused');
  assert.equal(asked.json.reason, 'TIMEOUT');
  assert.equal(loadTask(ctx, id).counters.seatCalls, 1);
});

test('missing binary pauses SEAT_UNAVAILABLE', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:missing');
  const id = started.json.id;
  writePlan(ctx, id);
  sealAgree(ctx, id);
  const asked = run(['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(asked.json.state, 'paused');
  assert.equal(asked.json.reason, 'SEAT_UNAVAILABLE');
});

test('writer marks the call tainted', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:writer');
  const id = started.json.id;
  writePlan(ctx, id);
  sealAgree(ctx, id);
  const asked = run(['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(asked.status, 0);
  assert.equal(asked.json.tainted, true);
  assert.ok(fs.existsSync(path.join(ctx.project, 'CONSENSUS-WRITER-TEST.txt')));
});
