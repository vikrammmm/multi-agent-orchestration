import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  freezeFlow, loadTask, reportPath, run, sealAgree, sealDone, setup, sha256File,
  startFull, writeDiff, writePlan,
} from './helpers.mjs';

test('finish-line agree freezes and hashes', () => {
  const ctx = setup();
  const { id, asked } = freezeFlow(ctx, 'fake:agree', 'fake:done');
  assert.equal(asked.status, 0);
  assert.equal(asked.json.state, 'frozen');
  const ledger = loadTask(ctx, id);
  assert.ok(ledger.checklistHash);
  const frozen = path.join(ctx.ledger, 'tasks', id, 'frozen', 'checklist.md');
  assert.equal(ledger.checklistHash, sha256File(frozen));
});

test('two objections end in split with the report', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:object');
  const id = started.json.id;
  writePlan(ctx, id);
  sealAgree(ctx, id);
  const first = run(['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(first.json.state, 'finish-line');
  assert.equal(first.json.verdict.verdict, 'OBJECT');
  sealAgree(ctx, id);
  const second = run(['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(second.status, 0);
  assert.equal(second.json.state, 'split');
  assert.ok(fs.existsSync(reportPath(ctx, id, 'split-decision.md')));
});

test('three NOT_DONE end in split', () => {
  const ctx = setup();
  const { id } = freezeFlow(ctx, 'fake:agree', 'fake:not-done-vary');
  writeDiff(ctx, id);
  let last;
  for (let i = 0; i < 3; i++) {
    sealDone(ctx, id);
    last = run(['ask', '--task', id, '--phase', 'signoff'], ctx);
  }
  assert.equal(last.json.state, 'split');
  assert.equal(loadTask(ctx, id).counters.signoffRounds, 3);
});

test('same blocking set twice ends in split at round 2', () => {
  const ctx = setup();
  const { id } = freezeFlow(ctx, 'fake:agree', 'fake:not-done-same');
  writeDiff(ctx, id);
  sealDone(ctx, id);
  const r1 = run(['ask', '--task', id, '--phase', 'signoff'], ctx);
  assert.equal(r1.json.state, 'signoff');
  sealDone(ctx, id);
  const r2 = run(['ask', '--task', id, '--phase', 'signoff'], ctx);
  assert.equal(r2.json.state, 'split');
  assert.equal(loadTask(ctx, id).counters.signoffRounds, 2);
});

test('both DONE ends in done with final.md', () => {
  const ctx = setup();
  const { id } = freezeFlow(ctx, 'fake:agree', 'fake:done');
  run(['job', '--task', id, '--lane', 'impl', '--note', 'build it'], ctx);
  writeDiff(ctx, id);
  sealDone(ctx, id);
  const asked = run(['ask', '--task', id, '--phase', 'signoff'], ctx);
  assert.equal(asked.status, 0);
  assert.equal(asked.json.state, 'done');
  assert.ok(fs.existsSync(reportPath(ctx, id, 'final.md')));
});
