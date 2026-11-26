import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTask, reportPath, setup, writeDiff, writeLf, writePlan } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// An isolated runtime copy, so local.json changes here never touch the real
// runtime or the other test files running alongside this one.
function privateRuntime(local) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-host-'));
  for (const name of ['lib', 'prompts', 'schemas']) {
    fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
  }
  for (const name of ['referee.mjs', 'seats.json', 'limits.json', 'VERSION']) {
    fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
  }
  if (local !== undefined) writeLf(path.join(dir, 'local.json'), JSON.stringify(local));
  return dir;
}

function runAt(rt, argv, ctx, env = {}) {
  const clean = { ...process.env };
  delete clean.CONSENSUS_SEAT;
  delete clean.DELEGATION_DISPATCHED;
  delete clean.CONSENSUS_TASK_ID;
  const r = spawnSync(process.execPath, [path.join(rt, 'referee.mjs'), ...argv], {
    encoding: 'utf8', env: { ...clean, CONSENSUS_LEDGER: ctx.ledger, ...env },
    timeout: 60000, windowsHide: true,
  });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim()); } catch { /* not json */ }
  return { status: r.status, json, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function startFullAt(rt, ctx, chair, cochair) {
  return runAt(rt, [
    'start', '--mode', 'full', '--chair', chair, '--cochair', cochair,
    '--project', ctx.project, '--goal', ctx.goal,
  ], ctx);
}

function sealAt(rt, ctx, id, phase, obj) {
  const file = path.join(ctx.project, `seal-${phase}.json`);
  writeLf(file, `${JSON.stringify(obj, null, 2)}\n`);
  return runAt(rt, ['seal', '--task', id, '--phase', phase, '--file', file], ctx);
}

function sealAgreeAt(rt, ctx, id) {
  return sealAt(rt, ctx, id, 'finish-line', {
    phase: 'finish-line', verdict: 'AGREE', summary: 'Chair agrees.',
  });
}

function sealDoneAt(rt, ctx, id) {
  return sealAt(rt, ctx, id, 'signoff', {
    phase: 'signoff', verdict: 'DONE', blocking: [], later: [], summary: 'Chair says done.',
  });
}

function briefAt(ctx) {
  const file = path.join(ctx.project, 'brief.md');
  writeLf(file, 'Advise on adding a checked gate to the feature.\n');
  return file;
}

test('missing host key reads as desktop', () => {
  const rt = privateRuntime();
  const ctx = setup();
  const started = startFullAt(rt, ctx, 'fake:agree', 'fake:done');
  assert.equal(started.status, 0, started.stdout);
  assert.equal(started.json.hostMode, 'desktop');
  assert.equal(loadTask(ctx, started.json.id).hostMode, 'desktop');
  const status = runAt(rt, ['status', '--task', started.json.id], ctx);
  assert.equal(status.json.hostMode, 'desktop');
});

test('invalid host mode refuses start and new consult, but assess ignores it', () => {
  const rt = privateRuntime({ hostMode: 'bogus' });
  const ctx = setup();
  const started = startFullAt(rt, ctx, 'fake:agree', 'fake:done');
  assert.equal(started.status, 2, started.stdout);
  assert.equal(started.json.code, 'BAD_HOST_MODE');
  const consulted = runAt(rt, [
    'consult', '--project', ctx.project, '--brief', briefAt(ctx), '--seats', 'fake:consult',
  ], ctx);
  assert.equal(consulted.status, 2, consulted.stdout);
  assert.equal(consulted.json.code, 'BAD_HOST_MODE');
  const assessed = runAt(rt, [
    'assess', '--project', ctx.project, '--brief', briefAt(ctx), '--assessor', 'fake:assess-simple',
  ], ctx);
  assert.equal(assessed.status, 0, assessed.stdout);
  assert.equal(assessed.json.state, 'assessed');
});

test('server finish line OBJECT at the last round freezes with a chair decision', () => {
  const rt = privateRuntime({ hostMode: 'server' });
  const ctx = setup();
  const started = startFullAt(rt, ctx, 'fake:agree', 'fake:object');
  assert.equal(started.status, 0, started.stdout);
  assert.equal(started.json.hostMode, 'server');
  const id = started.json.id;
  assert.equal(loadTask(ctx, id).limits.finishLineRounds, 3);
  writePlan(ctx, id);
  sealAgreeAt(rt, ctx, id);
  const first = runAt(rt, ['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(first.json.state, 'finish-line');
  sealAgreeAt(rt, ctx, id);
  const second = runAt(rt, ['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(second.json.state, 'finish-line');
  sealAgreeAt(rt, ctx, id);
  const third = runAt(rt, ['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(third.status, 0, third.stdout);
  assert.equal(third.json.state, 'frozen');
  assert.equal(third.json.chairDecided, true);
  assert.ok(String(third.json.report).endsWith('chair-decision.md'));
  const ledger = loadTask(ctx, id);
  assert.equal(ledger.hostMode, 'server');
  assert.deepEqual(ledger.chairDecided, [{
    phase: 'finish-line', round: 3, reason: 'finish-line OBJECT at last round', at: ledger.chairDecided[0].at,
  }]);
  assert.ok(fs.existsSync(reportPath(ctx, id, 'chair-decision.md')));
  assert.ok(!fs.existsSync(reportPath(ctx, id, 'split-decision.md')));
  const text = fs.readFileSync(reportPath(ctx, id, 'chair-decision.md'), 'utf8');
  assert.ok(text.includes('This is not an agreement: treat the points above as open.'));
  assert.ok(!text.includes('owner'));
  const status = runAt(rt, ['status', '--task', id], ctx);
  assert.equal(status.json.hostMode, 'server');
  assert.ok(status.json.next.includes('signoff'));
  const events = fs.readFileSync(path.join(ctx.ledger, 'tasks', id, 'events.jsonl'), 'utf8');
  assert.ok(events.includes('chair-decision'));
});

test('server sign-off rounds exhausted closes decided with the chair verdict', () => {
  const rt = privateRuntime({ hostMode: 'server' });
  const ctx = setup();
  const started = startFullAt(rt, ctx, 'fake:agree', 'fake:not-done-vary');
  const id = started.json.id;
  writePlan(ctx, id);
  sealAgreeAt(rt, ctx, id);
  const frozen = runAt(rt, ['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(frozen.json.state, 'frozen');
  writeDiff(ctx, id);
  let last;
  for (let i = 0; i < 3; i++) {
    sealDoneAt(rt, ctx, id);
    last = runAt(rt, ['ask', '--task', id, '--phase', 'signoff'], ctx);
  }
  assert.equal(last.status, 0, last.stdout);
  assert.equal(last.json.state, 'decided');
  assert.equal(last.json.chairDecided, true);
  const ledger = loadTask(ctx, id);
  assert.equal(ledger.outcome, 'decided');
  assert.equal(ledger.outcomeReason, 'sign-off rounds exhausted');
  assert.equal(ledger.chairVerdict, 'DONE');
  assert.equal(ledger.chairDecided.length, 1);
  assert.ok(fs.existsSync(reportPath(ctx, id, 'chair-decision.md')));
  const listed = runAt(rt, ['list', '--open'], ctx);
  assert.ok(!listed.json.tasks.some((t) => t.id === id));
  const closed = runAt(rt, ['close', '--task', id, '--outcome', 'abandoned', '--reason', 'x'], ctx);
  assert.equal(closed.status, 2);
  assert.equal(closed.json.code, 'WRONG_STATE');
});

test('identical blocking set closes decided on server', () => {
  const rt = privateRuntime({ hostMode: 'server' });
  const ctx = setup();
  const started = startFullAt(rt, ctx, 'fake:agree', 'fake:not-done-same');
  const id = started.json.id;
  writePlan(ctx, id);
  sealAgreeAt(rt, ctx, id);
  runAt(rt, ['ask', '--task', id, '--phase', 'finish-line'], ctx);
  writeDiff(ctx, id);
  sealDoneAt(rt, ctx, id);
  const first = runAt(rt, ['ask', '--task', id, '--phase', 'signoff'], ctx);
  assert.equal(first.json.state, 'signoff');
  sealDoneAt(rt, ctx, id);
  const second = runAt(rt, ['ask', '--task', id, '--phase', 'signoff'], ctx);
  assert.equal(second.json.state, 'decided');
  const ledger = loadTask(ctx, id);
  assert.equal(ledger.outcomeReason, 'identical blocking set');
  assert.equal(ledger.chairVerdict, 'DONE');
});

test('server call cap and time limit close decided', () => {
  const rt = privateRuntime({ hostMode: 'server' });
  const ctx = setup();
  const started = startFullAt(rt, ctx, 'fake:agree', 'fake:done');
  const id = started.json.id;
  for (let i = 0; i < 15; i++) {
    const job = runAt(rt, ['job', '--task', id, '--lane', 'w', '--note', `job ${i}`], ctx);
    assert.equal(job.status, 0, job.stdout);
  }
  const refused = runAt(rt, ['job', '--task', id, '--lane', 'w', '--note', 'one too many'], ctx);
  assert.equal(refused.status, 2);
  assert.equal(refused.json.code, 'LIMIT_CALLS');
  assert.equal(refused.json.state, 'decided');
  assert.ok(String(refused.json.report).endsWith('chair-decision.md'));
  assert.equal(loadTask(ctx, id).state, 'decided');
  assert.ok(fs.existsSync(reportPath(ctx, id, 'chair-decision.md')));

  const ctx2 = setup();
  const started2 = startFullAt(rt, ctx2, 'fake:agree', 'fake:done');
  const id2 = started2.json.id;
  writePlan(ctx2, id2);
  sealAgreeAt(rt, ctx2, id2);
  const file = path.join(ctx2.ledger, 'tasks', id2, 'ledger.json');
  const ledger2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  ledger2.deadlineAt = '2000-01-01T00:00:00.000Z';
  writeLf(file, `${JSON.stringify(ledger2, null, 2)}\n`);
  const asked = runAt(rt, ['ask', '--task', id2, '--phase', 'finish-line'], ctx2);
  assert.equal(asked.status, 2);
  assert.equal(asked.json.code, 'LIMIT_TIME');
  assert.equal(asked.json.state, 'decided');
  assert.ok(fs.existsSync(reportPath(ctx2, id2, 'chair-decision.md')));
});

test('a task keeps its recorded mode after local.json changes', () => {
  const rt = privateRuntime({ hostMode: 'server' });
  const ctx = setup();
  const started = startFullAt(rt, ctx, 'fake:agree', 'fake:object');
  const id = started.json.id;
  writePlan(ctx, id);
  sealAgreeAt(rt, ctx, id);
  const first = runAt(rt, ['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(first.json.state, 'finish-line');
  writeLf(path.join(rt, 'local.json'), JSON.stringify({ hostMode: 'desktop' }));
  sealAgreeAt(rt, ctx, id);
  const second = runAt(rt, ['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(second.json.state, 'finish-line');

  const rt2 = privateRuntime();
  const ctx2 = setup();
  const started2 = startFullAt(rt2, ctx2, 'fake:agree', 'fake:object');
  const id2 = started2.json.id;
  writePlan(ctx2, id2);
  sealAgreeAt(rt2, ctx2, id2);
  runAt(rt2, ['ask', '--task', id2, '--phase', 'finish-line'], ctx2);
  writeLf(path.join(rt2, 'local.json'), JSON.stringify({ hostMode: 'server' }));
  sealAgreeAt(rt2, ctx2, id2);
  const split = runAt(rt2, ['ask', '--task', id2, '--phase', 'finish-line'], ctx2);
  assert.equal(split.json.state, 'split');
});

test('server advise split wording leaves the worker to decide', () => {
  const rt = privateRuntime({ hostMode: 'server' });
  const ctx = setup();
  const got = runAt(rt, [
    'consult', '--project', ctx.project, '--brief', briefAt(ctx),
    '--seats', 'fake:merge-object,fake:merge-object', '--stage', 'plan',
  ], ctx);
  assert.equal(got.status, 0, got.stdout);
  assert.equal(got.json.state, 'split');
  assert.equal(got.json.hostMode, 'server');
  const text = fs.readFileSync(reportPath(ctx, got.json.id, 'split.md'), 'utf8');
  assert.ok(text.includes('No person will settle this'));
  assert.ok(text.includes('say plainly in your result that the reviewers disagreed'));
  assert.ok(text.includes('kept for the record'));
  assert.ok(text.includes('Open questions (decide them yourself)'));
  assert.ok(!text.includes('owner'));
  const raw = fs.readFileSync(reportPath(ctx, got.json.id, 'split-raw.md'), 'utf8');
  assert.ok(raw.includes('kept for the record'));
  assert.ok(!raw.includes('owner only'));

  const ctx2 = setup();
  const single = runAt(rt, [
    'consult', '--project', ctx2.project, '--brief', briefAt(ctx2),
    '--seats', 'fake:consult', '--stage', 'plan',
  ], ctx2);
  assert.equal(single.json.state, 'answered');
  const feedback = fs.readFileSync(reportPath(ctx2, single.json.id, 'feedback.md'), 'utf8');
  assert.ok(feedback.includes('Open questions (decide them yourself)'));
});

test('desktop finish line still splits after 2 OBJECTs', () => {
  const rt = privateRuntime();
  const ctx = setup();
  const started = startFullAt(rt, ctx, 'fake:agree', 'fake:object');
  const id = started.json.id;
  writePlan(ctx, id);
  sealAgreeAt(rt, ctx, id);
  const first = runAt(rt, ['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(first.json.state, 'finish-line');
  sealAgreeAt(rt, ctx, id);
  const second = runAt(rt, ['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(second.json.state, 'split');
  assert.ok(fs.existsSync(reportPath(ctx, id, 'split-decision.md')));
  assert.ok(!fs.existsSync(reportPath(ctx, id, 'chair-decision.md')));
  assert.deepEqual(loadTask(ctx, id).chairDecided, []);
});

test('doctor reports the host mode and flags an invalid value', () => {
  const ctx = setup();
  const desk = runAt(privateRuntime(), ['doctor'], ctx);
  assert.equal(desk.status, 0, desk.stdout);
  assert.equal(desk.json.hostMode, 'desktop');
  assert.equal(desk.json.hostModeDisplay, 'desktop');
  assert.equal(desk.json.hostModeProblem, null);
  const srv = runAt(privateRuntime({ hostMode: 'server' }), ['doctor'], ctx);
  assert.equal(srv.json.hostMode, 'server');
  assert.equal(srv.json.hostModeDisplay, 'server (review disagreements are settled by the chair after 3 rounds)');
  const bad = runAt(privateRuntime({ hostMode: 'bogus' }), ['doctor'], ctx);
  assert.ok(bad.json.hostModeProblem);
  const human = runAt(privateRuntime({ hostMode: 'server' }), ['doctor', '--human'], ctx);
  assert.ok(human.stdout.includes('server (review disagreements are settled by the chair after 3 rounds)'));
});
