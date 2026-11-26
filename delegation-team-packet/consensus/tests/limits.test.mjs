import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  freezeFlow, loadTask, run, sealAgree, setup, startFull, writeLf, writePlan,
} from './helpers.mjs';

test('call cap refuses the 16th call', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:done');
  const id = started.json.id;
  let last;
  for (let i = 0; i < 15; i++) {
    last = run(['job', '--task', id, '--lane', 'w', '--note', `job ${i}`], ctx);
    assert.equal(last.status, 0, last.stdout);
  }
  const refused = run(['job', '--task', id, '--lane', 'w', '--note', 'one too many'], ctx);
  assert.equal(refused.status, 2);
  assert.equal(refused.json.code, 'LIMIT_CALLS');
  assert.equal(loadTask(ctx, id).state, 'split');
});

test('deadline in the past refuses', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:done');
  const id = started.json.id;
  writePlan(ctx, id);
  sealAgree(ctx, id);
  const file = path.join(ctx.ledger, 'tasks', id, 'ledger.json');
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  ledger.deadlineAt = '2000-01-01T00:00:00.000Z';
  writeLf(file, JSON.stringify(ledger, null, 2) + '\n');
  const asked = run(['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(asked.status, 2);
  assert.equal(asked.json.code, 'LIMIT_TIME');
});

test('ask without seal refuses', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:done');
  const asked = run(['ask', '--task', started.json.id, '--phase', 'finish-line'], ctx);
  assert.equal(asked.status, 2);
  assert.equal(asked.json.code, 'NO_SEAL');
});

test('second seal for a round refuses', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:done');
  const id = started.json.id;
  writePlan(ctx, id);
  const first = sealAgree(ctx, id);
  assert.equal(first.status, 0);
  const second = sealAgree(ctx, id);
  assert.equal(second.status, 2);
  assert.equal(second.json.code, 'SEAL_EXISTS');
});

test('changed checklist after freeze refuses', () => {
  const ctx = setup();
  const { id } = freezeFlow(ctx);
  const checklist = path.join(ctx.ledger, 'tasks', id, 'materials', 'checklist.md');
  writeLf(checklist, '1. Changed after freeze.\n');
  const asked = run(['ask', '--task', id, '--phase', 'signoff'], ctx);
  assert.equal(asked.status, 2);
  assert.equal(asked.json.code, 'CHECKLIST_CHANGED');
});
