// A seat process that does not exit must never hang a task.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { finalReady } from '../lib/adapters/codex.mjs';
import { resultReady as claudeReady } from '../lib/adapters/claude.mjs';
import { resultReady as cursorReady } from '../lib/adapters/cursor.mjs';
import { settleMs, spawnSeat } from '../lib/spawn.mjs';
import { loadTask, reportPath, run, sealAgree, setup, startFull, tmp, writeLf, writePlan } from './helpers.mjs';

const SEAT_PROC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'adapters', 'fake-seat-proc.mjs');
const CONFIRM = JSON.stringify({ phase: 'confirm', verdict: 'CONFIRM', objections: [], summary: 'Fair merge.' });
const isConfirm = (raw) => {
  try { return JSON.parse(raw).verdict === 'CONFIRM'; } catch { return false; }
};

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function pidsIn(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
}

function kill(pid) {
  if (process.platform === 'win32') {
    if (alive(pid)) spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  // A seat root leads its own group; the group kill also takes a child it starts late.
  try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader, or gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}

// Leftover holders sit outside the seat's tree on purpose; the test removes them itself.
function cleanUp(files) {
  for (const f of files) for (const pid of pidsIn(f)) kill(pid);
}

function callPidFiles(ctx, id) {
  const calls = path.join(ctx.ledger, 'tasks', id, 'calls');
  if (!fs.existsSync(calls)) return [];
  return fs.readdirSync(calls).map((n) => path.join(calls, n, 'pids.txt')).filter((f) => fs.existsSync(f));
}

// A pid seen gone once stays gone: on a busy Windows machine a freed pid can be reused by another
// program within seconds, which must not make the tree look alive again.
async function allDead(pids, ms = 5000) {
  const want = new Set(pids);
  const gone = new Set();
  const until = Date.now() + ms;
  for (;;) {
    for (const p of want) if (!gone.has(p) && !alive(p)) gone.add(p);
    if (gone.size === want.size) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function seat(mode, extra = {}) {
  const dir = tmp('cseat-');
  const pidFile = path.join(dir, 'pids.txt');
  const finalPath = path.join(dir, 'final.txt');
  const done = spawnSeat({
    bin: process.execPath,
    args: [SEAT_PROC, mode, pidFile, finalPath],
    cwd: dir,
    prompt: CONFIRM,
    env: process.env,
    stdoutPath: path.join(dir, 'stdout.txt'),
    stderrPath: path.join(dir, 'stderr.txt'),
    detachedGroup: true,
    timeoutMs: 60000,
    graceMs: 1000,
    ...extra,
    ready: extra.ready === undefined ? finalReady(finalPath, isConfirm) : extra.ready,
  });
  return { done, pidFile, finalPath };
}

test('a seat that wrote a valid output and then hangs is finished and its tree killed', async () => {
  const s = seat('hang-after-output', { settleAfterMs: 300 });
  try {
    const r = await s.done;
    assert.equal(r.status, 'completed');
    assert.equal(r.endedBy, 'output-ready');
    assert.ok(r.durationMs < 15000, `took ${r.durationMs} ms`);
    assert.ok(isConfirm(fs.readFileSync(s.finalPath, 'utf8').trim()));
    const pids = pidsIn(s.pidFile);
    assert.equal(pids.length, 2, 'the seat and the child holding its stdout');
    assert.ok(await allDead(pids), 'the whole process tree is gone');
  } finally {
    cleanUp([s.pidFile]);
  }
});

test('the watchdog keeps an output that is complete when it expires', async () => {
  // 15 s rather than 4 gives the fake seat time to write its output when parallel suites load the
  // machine.
  const s = seat('hang-after-output', { settleAfterMs: 60000, timeoutMs: 15000 });
  try {
    const r = await s.done;
    assert.equal(r.status, 'completed');
    assert.equal(r.endedBy, 'output-ready');
  } finally {
    cleanUp([s.pidFile]);
  }
});

test('without a declared output the same hang ends as a timeout and the tree is killed', async () => {
  const s = seat('hang-after-output', { ready: null, timeoutMs: 1500 });
  try {
    const r = await s.done;
    assert.equal(r.status, 'timeout');
    assert.equal(r.endedBy, 'timeout');
    assert.ok(await allDead(pidsIn(s.pidFile)));
  } finally {
    cleanUp([s.pidFile]);
  }
});

test('the watchdog ends a call whose pipe is held open outside the killed tree', async () => {
  const s = seat('orphan-then-hang', { timeoutMs: 1500 });
  try {
    const r = await s.done;
    assert.equal(r.status, 'timeout');
    assert.equal(r.endedBy, 'timeout');
    assert.match(r.errorText, /^watchdog expired/);
    assert.ok(r.durationMs < 15000, `took ${r.durationMs} ms`);
  } finally {
    cleanUp([s.pidFile]);
  }
});

test('a seat that exits while a leftover process holds its pipe keeps its output', async () => {
  const s = seat('orphan-then-exit', { ready: null });
  try {
    const r = await s.done;
    assert.equal(r.status, 'completed');
    assert.equal(r.endedBy, 'exit-pipes-held');
    assert.equal(r.exitCode, 0);
    assert.ok(isConfirm(r.rawText.trim()), r.rawText);
    assert.ok(r.durationMs < 15000, `took ${r.durationMs} ms`);
  } finally {
    cleanUp([s.pidFile]);
  }
});

test('the settle override can only shorten the settle time', () => {
  const before = process.env.CONSENSUS_SEAT_SETTLE_MS;
  try {
    delete process.env.CONSENSUS_SEAT_SETTLE_MS;
    assert.equal(settleMs(), 20000);
    process.env.CONSENSUS_SEAT_SETTLE_MS = '500';
    assert.equal(settleMs(), 500);
    process.env.CONSENSUS_SEAT_SETTLE_MS = String(10 * 60 * 1000);
    assert.equal(settleMs(), 20000);
    process.env.CONSENSUS_SEAT_SETTLE_MS = 'soon';
    assert.equal(settleMs(), 20000);
  } finally {
    if (before === undefined) delete process.env.CONSENSUS_SEAT_SETTLE_MS;
    else process.env.CONSENSUS_SEAT_SETTLE_MS = before;
  }
});

test('each adapter calls its output ready only when it is complete and valid', () => {
  const dir = tmp('cready-');
  const finalPath = path.join(dir, 'final.txt');
  const codex = finalReady(finalPath, isConfirm);
  assert.equal(codex(), false, 'no file yet');
  fs.writeFileSync(finalPath, CONFIRM.slice(0, 20));
  assert.equal(codex(), false, 'half written');
  fs.writeFileSync(finalPath, `${CONFIRM}\n`);
  assert.equal(codex(), true);
  assert.equal(finalReady(finalPath, undefined), null, 'no check without a validator');

  const result = JSON.stringify({ type: 'result', is_error: false, result: CONFIRM, session_id: 's' });
  const claude = claudeReady(isConfirm);
  assert.equal(claude({ stdout: () => result.slice(0, 40) }), false);
  assert.equal(claude({ stdout: () => JSON.stringify({ type: 'result', is_error: true, result: CONFIRM }) }), false);
  assert.equal(claude({ stdout: () => `${result}\n` }), true);

  const cursor = cursorReady(isConfirm);
  assert.equal(cursor({ stdout: () => '{"type":"thinking"}\n' }), false);
  assert.equal(cursor({ stdout: () => `{"type":"thinking"}\n${result}\n` }), true);
});

function brief(ctx) {
  const file = path.join(ctx.project, 'brief.md');
  writeLf(file, 'Advise on adding a checked gate to the feature.\n');
  return file;
}

function events(ctx, id) {
  return fs.readFileSync(path.join(ctx.ledger, 'tasks', id, 'events.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
}

test('a detached consultation whose seat hangs after answering still writes its feedback', async () => {
  const ctx = setup();
  let id = null;
  try {
    const env = { CONSENSUS_SEAT_SETTLE_MS: '300' };
    const started = run([
      'consult', '--project', ctx.project, '--brief', brief(ctx),
      '--seats', 'fake:consult,fake:hang-after-output', '--stage', 'review', '--detach',
    ], { ...ctx, env });
    assert.equal(started.status, 0, started.stdout + started.stderr);
    id = started.json.id;
    const waited = run(['wait', '--task', id, '--minutes', '2'], { ...ctx, env, timeout: 150000 });
    assert.equal(waited.status, 0, waited.stdout + waited.stderr);
    assert.equal(waited.json.state, 'answered');
    assert.ok(fs.existsSync(reportPath(ctx, id, 'feedback.md')));
    const ledger = loadTask(ctx, id);
    assert.equal(ledger.counters.seatCalls, 4);
    const forced = events(ctx, id).filter((e) => e.event === 'call_forced_end');
    assert.deepEqual(forced.map((e) => e.data.endedBy), ['output-ready', 'output-ready']);
    for (const e of forced) {
      const meta = JSON.parse(fs.readFileSync(path.join(ctx.ledger, 'tasks', id, 'calls', String(e.data.call), 'meta.json'), 'utf8'));
      assert.equal(meta.endedBy, 'output-ready');
      assert.equal(meta.status, 'completed');
    }
    // Windows ends a killed process asynchronously after taskkill returns. Wait for the tree to exit
    // instead of checking once.
    const pids = callPidFiles(ctx, id).flatMap(pidsIn);
    assert.ok(pids.length > 0, 'the seat calls recorded their pids');
    assert.ok(await allDead(pids, 10000), `still running: ${pids.filter(alive).join(' ')}`);
  } finally {
    if (id) cleanUp(callPidFiles(ctx, id));
  }
});

test('an ask whose seat leaves its pipe open after the kill pauses with TIMEOUT instead of hanging', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:orphan-hang');
  const id = started.json.id;
  try {
    writePlan(ctx, id);
    sealAgree(ctx, id);
    const t0 = Date.now();
    const asked = run(['ask', '--task', id, '--phase', 'finish-line'], {
      ...ctx, env: { CONSENSUS_SEAT_TIMEOUT_MS: '1000' }, timeout: 60000,
    });
    assert.equal(asked.json && asked.json.state, 'paused', asked.stdout + asked.stderr);
    assert.equal(asked.json.reason, 'TIMEOUT');
    assert.ok(Date.now() - t0 < 30000);
    assert.equal(loadTask(ctx, id).counters.seatCalls, 1);
    const meta = JSON.parse(fs.readFileSync(path.join(ctx.ledger, 'tasks', id, 'calls', '1', 'meta.json'), 'utf8'));
    assert.equal(meta.endedBy, 'timeout');
  } finally {
    cleanUp(callPidFiles(ctx, id));
  }
});

test('a detached referee stopped in the middle of a call leaves a paused task, not a pending one', async () => {
  const ctx = setup();
  let id = null;
  try {
    // The default 20-second settle keeps the referee inside the seat call while it is stopped.
    const started = run([
      'consult', '--project', ctx.project, '--brief', brief(ctx),
      '--seats', 'fake:consult,fake:hang-after-output', '--detach',
    ], ctx);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    id = started.json.id;
    const taskDir = path.join(ctx.ledger, 'tasks', id);
    const until = Date.now() + 20000;
    while (Date.now() < until && callPidFiles(ctx, id).length === 0) await new Promise((r) => setTimeout(r, 200));
    assert.ok(callPidFiles(ctx, id).length > 0, 'the seat call started');
    kill(started.json.pid);
    assert.ok(await allDead([started.json.pid]));
    const waited = run(['wait', '--task', id, '--minutes', '1'], { ...ctx, timeout: 75000 });
    assert.equal(waited.status, 2, waited.stdout);
    assert.equal(waited.json.code, 'REFEREE_STOPPED');
    assert.equal(waited.json.state, 'paused');
    const ledger = loadTask(ctx, id);
    assert.equal(ledger.state, 'paused');
    assert.equal(ledger.outcomeReason, 'REFEREE_STOPPED');
    assert.equal(fs.existsSync(path.join(taskDir, 'pending.json')), false);
    assert.ok(events(ctx, id).some((e) => e.event === 'referee_stopped'));
  } finally {
    if (id) cleanUp(callPidFiles(ctx, id));
  }
});

function fakeDeadDetach(ctx, id) {
  const taskDir = path.join(ctx.ledger, 'tasks', id);
  writeLf(path.join(taskDir, 'detach', 'stdout.txt'), '');
  writeLf(path.join(taskDir, 'pending.json'), JSON.stringify({
    pid: 999999991, command: ['consult'], startedAt: '2026-10-08T21:48:00.000Z',
    stdoutPath: path.join(taskDir, 'detach', 'stdout.txt'),
  }) + '\n');
}

test('status reports a task whose detached referee died as paused', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:done');
  const id = started.json.id;
  fakeDeadDetach(ctx, id);
  const status = run(['status', '--task', id], ctx);
  assert.equal(status.status, 0, status.stdout);
  assert.equal(status.json.state, 'paused');
  assert.equal(status.json.outcomeReason, 'REFEREE_STOPPED');
  assert.equal(fs.existsSync(path.join(ctx.ledger, 'tasks', id, 'pending.json')), false);
});

test('a dead detached referee does not change a task that already has its answer', () => {
  const ctx = setup();
  const got = run(['consult', '--project', ctx.project, '--brief', brief(ctx), '--seats', 'fake:consult'], ctx);
  assert.equal(got.json.state, 'answered');
  fakeDeadDetach(ctx, got.json.id);
  const waited = run(['wait', '--task', got.json.id, '--minutes', '1'], ctx);
  assert.equal(waited.json.code, 'REFEREE_STOPPED');
  assert.equal(waited.json.state, 'answered');
  assert.equal(loadTask(ctx, got.json.id).state, 'answered');
});
