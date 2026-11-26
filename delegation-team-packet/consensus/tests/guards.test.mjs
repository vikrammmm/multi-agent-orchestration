import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { freezeFlow, loadTask, run, setup, sha256File, startFull, writeLf } from './helpers.mjs';

test('CONSENSUS_SEAT=1 makes ask refuse', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:done');
  const asked = run(['ask', '--task', started.json.id, '--phase', 'finish-line'], {
    ...ctx,
    env: { CONSENSUS_SEAT: '1' },
  });
  assert.equal(asked.status, 2);
  assert.equal(asked.json.code, 'CONSENSUS_SEAT');
});

test('DELEGATION_DISPATCHED=1 makes consult refuse', () => {
  const ctx = setup();
  const brief = path.join(ctx.project, 'brief.md');
  writeLf(brief, 'Need a second opinion on the plan.\n');
  const got = run([
    'consult', '--project', ctx.project, '--brief', brief, '--seats', 'fake:consult',
  ], { ...ctx, env: { DELEGATION_DISPATCHED: '1' } });
  assert.equal(got.status, 2);
  assert.equal(got.json.code, 'DELEGATION_DISPATCHED');
});

test('nested start refuses when CONSENSUS_TASK_ID is set', () => {
  const ctx = setup();
  const got = run([
    'start', '--mode', 'full', '--chair', 'fake:agree', '--cochair', 'fake:done',
    '--project', ctx.project, '--goal', ctx.goal,
  ], { ...ctx, env: { CONSENSUS_TASK_ID: 'already' } });
  assert.equal(got.status, 2);
  assert.equal(got.json.code, 'NESTED_TASK');
});

test('stale lock is cleared', () => {
  const ctx = setup();
  const { id } = freezeFlow(ctx, 'fake:agree', 'fake:done');
  const pending = path.join(ctx.ledger, 'tasks', id, 'pending.json');
  writeLf(pending, JSON.stringify({
    pid: 999999991, command: ['stale'], startedAt: '2000-01-01T00:00:00.000Z',
  }) + '\n');
  const asked = run(['ask', '--task', id, '--phase', 'signoff'], ctx);
  assert.notEqual(asked.json.code, 'PENDING');
  assert.equal(asked.json.code, 'NO_SEAL');
  assert.equal(fs.existsSync(pending), false);
});

test('continue-from copies the frozen checklist', () => {
  const ctx = setup();
  const { id } = freezeFlow(ctx, 'fake:agree', 'fake:done');
  const next = run([
    'start', '--mode', 'full', '--chair', 'fake:agree', '--cochair', 'fake:done',
    '--project', ctx.project, '--goal', ctx.goal, '--continue-from', id,
  ], ctx);
  assert.equal(next.status, 0);
  const copied = path.join(ctx.ledger, 'tasks', next.json.id, 'frozen', 'checklist.md');
  const orig = path.join(ctx.ledger, 'tasks', id, 'frozen', 'checklist.md');
  assert.ok(fs.existsSync(copied));
  assert.equal(fs.readFileSync(copied, 'utf8'), fs.readFileSync(orig, 'utf8'));
  assert.equal(next.json.continuedFrom, id);
  assert.equal(loadTask(ctx, next.json.id).checklistHash, sha256File(copied));
});
