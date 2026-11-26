import fs from 'node:fs';
import path from 'node:path';
import { copyDir, ensureDir, integrityManifest, manifestEqual, readUtf8, realDir, rmrf, tryReadJson, writeJsonAtomic, writeUtf8 } from './fsx.mjs';
import { logEvent, saveLedger } from './ledger.mjs';
import { callDir as callDirOf, schemaPath, taskPaths } from './paths.mjs';
import { buildPrompt } from './prompt.mjs';
import { extractJson, validatePhase } from './schema.mjs';
import { apiKeysToStrip, getAdapter, getSeat, usedFake } from './seats.mjs';
import { buildChildEnv, emptyAdapterResult } from './spawn.mjs';
import { checkCallsAtCap, timeoutMs } from './limits.mjs';

const RATE_RE = /rate.?limit|usage limit|weekly limit|hit your .{0,24}limit|quota|not logged in|login required|unauthorized|401|429/i;

export function lastSessionForSeat(taskId, seatId) {
  const root = taskPaths(taskId).calls;
  if (!fs.existsSync(root)) return null;
  const nums = fs.readdirSync(root).map((n) => Number(n)).filter((n) => n > 0).sort((a, b) => b - a);
  for (const n of nums) {
    const meta = tryReadJson(path.join(root, String(n), 'meta.json'));
    if (meta && meta.seat === seatId && meta.sessionId) return meta.sessionId;
  }
  return null;
}

// ADAPTERS.md: only the codex route resumes a thread across rounds; claude-code and cursor get
// --resume solely on the JSON retry of the same call.
export function resumeForInitialCall(seat, taskId) {
  if (!seat || seat.route !== 'codex') return null;
  return lastSessionForSeat(taskId, seat.id);
}

function nextCall(ledger, seatId) {
  ledger.counters.seatCalls += 1;
  if (usedFake(seatId) || usedFake(ledger.chair) || usedFake(ledger.cochair)) ledger.test = true;
  const n = ledger.counters.seatCalls;
  const dir = callDirOf(ledger.id, n);
  ensureDir(dir);
  saveLedger(ledger);
  logEvent(ledger.id, 'call_budget', { n, seat: seatId });
  return { n, dir };
}

function validate(phase, rawText) {
  const parsed = extractJson(rawText);
  if (!parsed) return { ok: false, verdict: null, errors: ['not json'] };
  const v = validatePhase(phase, parsed);
  return { ok: v.ok, verdict: v.ok ? v.value : parsed, errors: v.errors };
}

// Last-resort bound on one adapter run. spawnSeat always ends a call within its watchdog plus the
// kill and pipe grace, and the claude adapter may launch twice, so this fires only if an adapter
// itself never returns. A thrown adapter error is a failed call too: either way the flow records a
// clear pause instead of leaving the task open.
function adapterDeadlineMs(timeout) {
  return 2 * timeout + 2 * 60 * 1000;
}

async function runAdapter(adapter, opts) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      ...emptyAdapterResult(opts.callDir),
      status: 'timeout',
      errorText: 'the seat adapter did not return within twice the per-call watchdog',
      endedBy: 'adapter-deadline',
    }), adapterDeadlineMs(opts.timeoutMs));
  });
  try {
    return await Promise.race([adapter.run(opts), late]);
  } catch (e) {
    return { ...emptyAdapterResult(opts.callDir), status: 'failed', errorText: `seat adapter error: ${e && e.message ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

function loginOrRate(result) {
  const text = `${result.rawText || ''}\n${result.errorText || ''}`;
  let stderr = '';
  try { if (result.stderrPath) stderr = readUtf8(result.stderrPath); } catch { /* */ }
  return RATE_RE.test(text) || RATE_RE.test(stderr);
}

export async function runSeatCall({ ledger, seatId, phase, prompt, keepCopy = false, resume = undefined, seat = getSeat(seatId) }) {
  const { n, dir } = nextCall(ledger, seatId);
  const projectDir = realDir(ledger.project);
  writeUtf8(path.join(dir, 'prompt.md'), prompt);
  const mats = taskPaths(ledger.id).materials;
  if (fs.existsSync(mats)) copyDir(mats, path.join(dir, 'materials'));
  const before = integrityManifest(projectDir);
  writeJsonAtomic(path.join(dir, 'manifest-before.json'), before);

  let copyDirPath = null;
  if (seat.route === 'cursor') {
    copyDirPath = path.join(dir, 'copy');
    copyDir(projectDir, copyDirPath);
    if (fs.existsSync(mats)) copyDir(mats, path.join(copyDirPath, '.consensus'));
  }

  const schemaFile = schemaPath(phase);
  let schemaJson = '{}';
  try { schemaJson = JSON.stringify(JSON.parse(readUtf8(schemaFile))); } catch { /* */ }
  const env = buildChildEnv({
    taskId: ledger.id,
    callIndex: n,
    stripKeys: apiKeysToStrip(),
    stripWindowsApps: seat.route === 'codex' && process.platform === 'win32',
  });
  const adapter = getAdapter(seat);
  const timeout = timeoutMs(ledger);
  const resumeId = resume !== undefined ? resume : resumeForInitialCall(seat, ledger.id);
  // Lets the adapter tell, while the seat still runs, that its declared output is a valid verdict.
  const isComplete = (raw) => validate(phase, raw).ok;

  let result = await runAdapter(adapter, {
    seat, prompt, projectDir, callDir: dir, schemaPath: schemaFile,
    schemaJson, timeoutMs: timeout, resume: resumeId, phase, copyDir: copyDirPath,
    taskId: ledger.id, callIndex: n, env, keepCopy, isComplete,
  });

  let parsed = validate(phase, result.rawText);
  writeCallFiles(dir, parsed, result, seatId, phase, false);
  noteForcedEnd(ledger, n, seatId, result);
  let retryN = null;
  let retryDir = null;
  let retryBlocked = null;
  if (shouldRetry(result, parsed) && !checkCallsAtCap(ledger).ok) {
    // Guard 4: the retry is a seat call too; at the cap it is not attempted.
    retryBlocked = 'call budget exhausted; no JSON retry was attempted';
    logEvent(ledger.id, 'retry_blocked', { call: n, seat: seatId, reason: 'LIMIT_CALLS' });
  }
  if (shouldRetry(result, parsed) && !retryBlocked) {
    const retryPrompt = buildPrompt({
      phase: 'retry',
      project: projectDir,
      materials: { dir: mats, goal: '', plan: '', checklist: '', diff: '', tests: '', brief: '' },
      extra: { retryPhase: phase },
      previous: result.rawText || '',
    });
    const second = nextCall(ledger, seatId);
    retryN = second.n;
    retryDir = second.dir;
    writeUtf8(path.join(second.dir, 'prompt.md'), retryPrompt);
    if (fs.existsSync(mats)) copyDir(mats, path.join(second.dir, 'materials'));
    result = await runAdapter(adapter, {
      seat, prompt: retryPrompt, projectDir, callDir: second.dir,
      schemaPath: schemaFile, schemaJson, timeoutMs: timeout,
      resume: result.sessionId || resumeId, phase, copyDir: copyDirPath,
      taskId: ledger.id, callIndex: second.n, env, keepCopy, isComplete,
    });
    parsed = validate(phase, result.rawText);
    writeCallFiles(second.dir, parsed, result, seatId, phase, false);
    noteForcedEnd(ledger, second.n, seatId, result);
  }

  const after = integrityManifest(projectDir);
  const tainted = !manifestEqual(before, after);
  if (tainted) logEvent(ledger.id, 'tainted', { call: n, seat: seatId, retryCall: retryN });
  for (const d of [dir, retryDir].filter(Boolean)) {
    writeJsonAtomic(path.join(d, 'manifest-after.json'), after);
    const meta = tryReadJson(path.join(d, 'meta.json')) || {};
    meta.tainted = tainted;
    writeJsonAtomic(path.join(d, 'meta.json'), meta);
  }

  if (copyDirPath && !keepCopy) rmrf(copyDirPath);
  const pause = pauseReason(result, parsed);
  return {
    ok: !pause && parsed.ok,
    verdict: parsed.ok ? parsed.verdict : null,
    tainted,
    callIndex: n,
    retryCallIndex: retryN,
    status: result.status,
    pauseReason: pause,
    rawText: result.rawText,
    result,
    errors: retryBlocked ? [...(parsed.errors || []), retryBlocked] : parsed.errors,
  };
}

// A call the referee had to end itself is logged, so the owner can see a seat that hangs.
function noteForcedEnd(ledger, n, seatId, result) {
  if (!result.endedBy || result.endedBy === 'exit') return;
  logEvent(ledger.id, 'call_forced_end', { call: n, seat: seatId, endedBy: result.endedBy, status: result.status });
}

function shouldRetry(result, parsed) {
  if (parsed.ok) return false;
  if (result.status === 'timeout' || result.status === 'unavailable') return false;
  // A CLI that answered with an error result (is_error) has nothing to retry.
  if (result.status === 'failed' && !result.rawText) return false;
  if (loginOrRate(result)) return false;
  return true;
}

function pauseReason(result, parsed) {
  if (result.status === 'timeout') return 'TIMEOUT';
  if (result.status === 'unavailable') return 'SEAT_UNAVAILABLE';
  // A verdict that validates stands, even when its own text mentions rate limits or logins.
  if (parsed.ok) return null;
  if (loginOrRate(result)) return 'SEAT_UNAVAILABLE';
  if (result.status === 'failed' && !result.rawText) return 'SEAT_UNAVAILABLE';
  return 'INVALID_VERDICT';
}

function writeCallFiles(dir, parsed, result, seatId, phase, tainted) {
  writeJsonAtomic(path.join(dir, 'verdict.json'), parsed.verdict || { error: parsed.errors, raw: result.rawText });
  writeJsonAtomic(path.join(dir, 'meta.json'), {
    seat: seatId,
    phase,
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    tainted,
    sessionId: result.sessionId || null,
    usage: result.usage || null,
    errorText: result.errorText || '',
    flagsDropped: result.flagsDropped || [],
    endedBy: result.endedBy || null,
  });
}

export function applyPause(ledger, reason, message) {
  ledger.state = 'paused';
  ledger.outcomeReason = reason;
  saveLedger(ledger);
  logEvent(ledger.id, 'paused', { reason, message: message || reason });
  return { ok: false, paused: true, code: reason, reason, message: message || reason, id: ledger.id, state: 'paused' };
}
