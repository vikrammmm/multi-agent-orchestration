import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPause } from './call.mjs';
import { ensureDir, readUtf8, tryReadJson } from './fsx.mjs';
import { checkPending, clearPending, pidAlive, readPending, writePending } from './guard.mjs';
import { closeTask, loadLedger, logEvent, nowIso } from './ledger.mjs';
import { taskPaths } from './paths.mjs';
import { refuse } from './fail.mjs';

const REFEREE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'referee.mjs');

export function stripDetach(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--detach') continue;
    if (argv[i] === '--detach=true' || argv[i] === '--detach=1') continue;
    out.push(argv[i]);
  }
  return out;
}

export function cmdDetach(args, argv) {
  const id = args.task ? String(args.task) : null;
  if (!id) refuse('BAD_ARGS', '--detach requires --task (create the task first, or pass --task).');
  loadLedger(id);
  checkPending(id);
  const p = taskPaths(id);
  ensureDir(p.detach);
  const stdoutPath = path.join(p.detach, 'stdout.txt');
  const stderrPath = path.join(p.detach, 'stderr.txt');
  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');
  const childArgv = [REFEREE, ...stripDetach(argv)];
  const child = spawn(process.execPath, childArgv, {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: process.env,
    cwd: process.cwd(),
    windowsHide: true,
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  writePending(id, {
    pid: child.pid,
    command: [process.execPath, ...childArgv],
    startedAt: nowIso(),
    stdoutPath,
    stderrPath,
  });
  child.unref();
  return { ok: true, detached: true, id, pid: child.pid, stdoutPath, stderrPath };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function cmdWait(args) {
  const id = String(args.task || '');
  loadLedger(id);
  const minutes = args.minutes === true || args.minutes == null ? 9 : Number(args.minutes);
  const limitMs = (Number.isFinite(minutes) ? minutes : 9) * 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < limitMs) {
    const pending = readPending(id);
    if (!pending) return readDetachResult(id);
    // Another wait or status may collect it first; then its printed result is read as usual.
    if (!pidAlive(pending.pid)) return collectFinishedDetach(id) || readDetachResult(id);
    await sleep(5000);
  }
  return { ok: true, status: 'pending', id };
}

// The detached referee is no longer running: clear its lock and return what it printed, or record
// that it stopped without a result. null while it still runs or when nothing is pending.
export function collectFinishedDetach(id) {
  const pending = readPending(id);
  if (!pending || pidAlive(pending.pid)) return null;
  const file = pending.stdoutPath || path.join(taskPaths(id).detach, 'stdout.txt');
  clearPending(id, 'process-exited');
  const text = fs.existsSync(file) ? readUtf8(file).trim() : '';
  try {
    if (text) return JSON.parse(text);
  } catch { /* half a result is no result */ }
  return recordStopped(id);
}

// Ledger states in which a detached ask, consult or assess may have been cut off.
const IN_FLIGHT = { full: ['finish-line', 'frozen', 'signoff'], advise: ['open'], assess: ['open'] };

// SPEC section 7: a detached referee that ended without printing its result (it crashed, or was
// stopped by hand) must not leave the task looking as if it were still running. Its call is
// recorded as failed, the same way as a seat failure in that mode: a pause for ask and consult,
// a failed assessment for assess.
function recordStopped(id) {
  const ledger = loadLedger(id);
  logEvent(id, 'referee_stopped', { state: ledger.state });
  if (!(IN_FLIGHT[ledger.mode] || []).includes(ledger.state)) {
    const message = `The detached referee stopped before it printed a result; the task was already ${ledger.state}, so nothing changed.`;
    return { ok: false, code: 'REFEREE_STOPPED', id, state: ledger.state, message };
  }
  const message = 'The detached referee stopped before it printed a result (it crashed or was '
    + 'stopped); see detach/stderr.txt. The seat calls it made stay counted.';
  if (ledger.mode === 'assess') {
    closeTask(ledger, 'failed', 'REFEREE_STOPPED');
    return { ok: false, code: 'REFEREE_STOPPED', id, state: 'failed', message };
  }
  return applyPause(ledger, 'REFEREE_STOPPED', message);
}

function readDetachResult(id) {
  const p = taskPaths(id);
  const stdoutPath = path.join(p.detach, 'stdout.txt');
  const pendingMeta = tryReadJson(p.pending);
  const file = pendingMeta?.stdoutPath || stdoutPath;
  if (!fs.existsSync(file)) {
    const ledger = loadLedger(id);
    return { ok: true, id, state: ledger.state, status: ledger.state };
  }
  const text = readUtf8(file).trim();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, id, raw: text };
  }
}
