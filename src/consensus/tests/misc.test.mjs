import assert from 'node:assert/strict';
import test from 'node:test';
import { run, sealAgree, setup, startFull, writePlan } from './helpers.mjs';

test('detach + wait round trip', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:done');
  const id = started.json.id;
  writePlan(ctx, id);
  sealAgree(ctx, id);
  const detached = run(['ask', '--task', id, '--phase', 'finish-line', '--detach'], ctx);
  assert.equal(detached.status, 0, detached.stdout);
  assert.equal(detached.json.detached, true);
  const waited = run(['wait', '--task', id, '--minutes', '2'], { ...ctx, timeout: 30000 });
  assert.equal(waited.status, 0, waited.stdout);
  assert.notEqual(waited.json.status, 'pending');
  const state = waited.json.state || run(['status', '--task', id], ctx).json.state;
  assert.equal(state, 'frozen');
});
