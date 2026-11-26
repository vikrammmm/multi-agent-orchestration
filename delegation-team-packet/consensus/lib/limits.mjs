import { limitsJsonPath } from './paths.mjs';
import { readJson } from './fsx.mjs';

let cached = null;

export function loadLimits(name = 'standard') {
  if (!cached) cached = readJson(limitsJsonPath());
  const table = cached[name] || cached.standard;
  return { ...table };
}

export function ok() {
  return { ok: true, code: null, message: null };
}

export function fail(code, message) {
  return { ok: false, code, message };
}

export function nextRound(ledger, phase) {
  if (phase === 'finish-line') return ledger.counters.finishLineRounds + 1;
  if (phase === 'signoff') return ledger.counters.signoffRounds + 1;
  return 1;
}

export function checkRounds(ledger, phase) {
  const n = nextRound(ledger, phase);
  const max = phase === 'finish-line' ? ledger.limits.finishLineRounds : ledger.limits.signoffRounds;
  if (n > max) {
    return fail('LIMIT_ROUNDS', `Round ${n} exceeds the ${phase} limit of ${max}.`);
  }
  return ok();
}

export function checkCalls(ledger, extra = 1) {
  const used = ledger.counters.seatCalls + ledger.counters.workerJobs;
  if (used + extra > ledger.limits.totalCalls) {
    return fail('LIMIT_CALLS', `Call ${used + extra} exceeds the total-call limit of ${ledger.limits.totalCalls}.`);
  }
  return ok();
}

export function checkCallsAtCap(ledger) {
  const used = ledger.counters.seatCalls + ledger.counters.workerJobs;
  if (used >= ledger.limits.totalCalls) {
    return fail('LIMIT_CALLS', `Call budget exhausted (${used}/${ledger.limits.totalCalls}).`);
  }
  return ok();
}

export function checkTime(ledger, now = Date.now()) {
  const deadline = Date.parse(ledger.deadlineAt);
  if (Number.isFinite(deadline) && now >= deadline) {
    return fail('LIMIT_TIME', `Deadline ${ledger.deadlineAt} has passed.`);
  }
  return ok();
}

export function checkConsultations(ledger) {
  const n = ledger.counters.consultations + 1;
  const max = ledger.limits.consultationsPerTask;
  if (n > max) {
    return fail('LIMIT_CONSULTATIONS', `Consultation ${n} exceeds the limit of ${max}.`);
  }
  return ok();
}

export function checkMerge(ledger, mergeRounds) {
  const max = ledger.limits.mergeRounds;
  if (mergeRounds > max) {
    return fail('LIMIT_MERGE', `Merge round ${mergeRounds} exceeds the limit of ${max}.`);
  }
  return ok();
}

export function checkConsultCalls(ledger, used, extra = 1) {
  const max = ledger.limits.seatCallsPerConsultation;
  if (used + extra > max) {
    return fail('LIMIT_MERGE', `Consultation call ${used + extra} exceeds the per-consultation cap of ${max}.`);
  }
  return ok();
}

export function timeoutMs(ledger) {
  const table = (ledger.limits.seatCallMinutes || 45) * 60 * 1000;
  // CONSENSUS_SEAT_TIMEOUT_MS (used by the tests) may shorten the watchdog, never lengthen it.
  const env = process.env.CONSENSUS_SEAT_TIMEOUT_MS;
  if (env && String(env).trim()) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return Math.min(n, table);
  }
  return table;
}
