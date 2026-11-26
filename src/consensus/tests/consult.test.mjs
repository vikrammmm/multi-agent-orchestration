import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadTask, reportPath, run, setup, writeLf } from './helpers.mjs';

function brief(ctx) {
  const file = path.join(ctx.project, 'brief.md');
  writeLf(file, 'Advise on adding a checked gate to the feature.\n');
  return file;
}

test('one-seat consult answers', () => {
  const ctx = setup();
  const got = run([
    'consult', '--project', ctx.project, '--brief', brief(ctx),
    '--seats', 'fake:consult', '--stage', 'plan',
  ], ctx);
  assert.equal(got.status, 0, got.stdout);
  assert.equal(got.json.state, 'answered');
  assert.ok(fs.existsSync(got.json.report));
  assert.ok(fs.existsSync(reportPath(ctx, got.json.id, 'feedback.md')));
});

test('two-seat confirm writes feedback', () => {
  const ctx = setup();
  const got = run([
    'consult', '--project', ctx.project, '--brief', brief(ctx),
    '--seats', 'fake:consult,fake:merge-confirm', '--stage', 'plan',
  ], ctx);
  assert.equal(got.status, 0, got.stdout);
  assert.equal(got.json.state, 'answered');
  assert.ok(fs.existsSync(reportPath(ctx, got.json.id, 'feedback.md')));
  const ledger = loadTask(ctx, got.json.id);
  assert.equal(ledger.counters.seatCalls, 4);
});

test('two-seat double object writes split.md and uses exactly 6 calls', () => {
  const ctx = setup();
  const got = run([
    'consult', '--project', ctx.project, '--brief', brief(ctx),
    '--seats', 'fake:merge-object,fake:merge-object', '--stage', 'plan',
  ], ctx);
  assert.equal(got.status, 0, got.stdout);
  assert.equal(got.json.state, 'split');
  assert.ok(fs.existsSync(reportPath(ctx, got.json.id, 'split.md')));
  assert.equal(loadTask(ctx, got.json.id).counters.seatCalls, 6);
  assert.ok(fs.existsSync(reportPath(ctx, got.json.id, 'split-raw.md')));
  assert.ok(!fs.readFileSync(reportPath(ctx, got.json.id, 'split.md'), 'utf8').includes('Seat A:'));
  assert.ok(fs.readFileSync(reportPath(ctx, got.json.id, 'split-raw.md'), 'utf8').includes('Seat A:'));
});

test('fourth consultation refuses', () => {
  const ctx = setup();
  const b = brief(ctx);
  let id = null;
  for (let i = 0; i < 3; i++) {
    const got = run([
      'consult', '--project', ctx.project, '--brief', b,
      '--seats', 'fake:consult',
      ...(id ? ['--task', id] : []),
    ], ctx);
    assert.equal(got.status, 0, got.stdout);
    id = got.json.id;
  }
  const fourth = run([
    'consult', '--project', ctx.project, '--brief', b,
    '--seats', 'fake:consult', '--task', id,
  ], ctx);
  assert.equal(fourth.status, 2);
  assert.equal(fourth.json.code, 'LIMIT_CONSULTATIONS');
});
