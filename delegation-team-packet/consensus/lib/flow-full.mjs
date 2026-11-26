import fs from 'node:fs';
import path from 'node:path';
import { realDir } from './fsx.mjs';
import { applyPause, runSeatCall } from './call.mjs';
import { collectFinishedDetach } from './detach.mjs';
import { refuse } from './fail.mjs';
import { assertState, checkAskRecursion, checkFrozenChecklist, checkPending, checkStartNested } from './guard.mjs';
import {
  addRound, closeTask, copyGoal, createTask, freezeChecklist, isClosed, loadIndex, loadLedger,
  logEvent, materialText, readSeal, recordChairDecision, saveLedger, sealHash, setState, writeSeal,
} from './ledger.mjs';
import { checkCallsAtCap, checkRounds, checkTime, nextRound } from './limits.mjs';
import { hostModeOf, requireHostMode, taskPaths } from './paths.mjs';
import { buildPrompt, materialsBundle } from './prompt.mjs';
import { writeChairDecision, writeFinal, writeSplitDecision } from './report.mjs';
import { blockingKey } from './schema.mjs';
import {
  assertDispatchable, gradeForSeatIds, loadSeatsJson, pickCochair, unverifiedFor, usedFake,
} from './seats.mjs';

function mats(id) {
  const p = taskPaths(id);
  return materialsBundle(p.materials, {
    goal: materialText(id, 'goal.md'),
    plan: materialText(id, 'plan.md'),
    checklist: materialText(id, 'checklist.md'),
    diff: materialText(id, 'diff.patch'),
    tests: materialText(id, 'tests.txt'),
    brief: materialText(id, 'brief.md'),
  });
}

function serverLimit(ledger, check, phase, round) {
  const last = (ledger.rounds || [])[(ledger.rounds || []).length - 1] || null;
  const usePhase = phase || (last ? last.phase : String(ledger.state || ''));
  const useRound = round != null ? round : (last ? last.round : 0);
  recordChairDecision(ledger, { phase: usePhase, round: useRound, reason: check.code });
  const seal = last && last.phase === 'signoff' ? readSeal(ledger.id, 'signoff', last.round) : null;
  if (seal && seal.verdict) ledger.chairVerdict = seal.verdict;
  const file = writeChairDecision(ledger, { phase: usePhase, round: useRound, reason: check.code });
  closeTask(ledger, 'decided', check.code);
  logEvent(ledger.id, 'chair-decision', { phase: usePhase, round: useRound, reason: check.code });
  refuse(check.code, check.message, { state: 'decided', report: file });
}

function splitLimit(ledger, check, info = {}) {
  if (isClosed(ledger)) refuse(check.code, check.message);
  if (hostModeOf(ledger) === 'server') serverLimit(ledger, check, info.phase, info.round);
  writeSplitDecision(ledger);
  closeTask(ledger, 'split', check.code);
  refuse(check.code, check.message, { state: 'split', report: path.join(taskPaths(ledger.id).reports, 'split-decision.md') });
}

export function cmdStart(args) {
  checkStartNested();
  const hostMode = requireHostMode();
  const mode = args.mode || 'full';
  if (mode !== 'full' && mode !== 'advise') refuse('BAD_ARGS', 'mode must be full or advise.');
  if (args.limits && args.limits !== 'standard' && args.limits !== true) {
    refuse('NO_EXTEND', 'No command can raise a limit; only --limits standard is allowed.');
  }
  if (!args.chair) refuse('BAD_ARGS', '--chair is required.');
  if (!args.project || !fs.existsSync(path.resolve(String(args.project)))) {
    refuse('BAD_ARGS', '--project must be an existing directory.');
  }
  const chair = String(args.chair);
  for (const id of [chair, args.cochair && String(args.cochair)].filter(Boolean)) {
    if (loadSeatsJson().assessors?.[id]) refuse('BAD_ARGS', `${id} is a task-sizing assessor; it is never a chair or a seat`);
  }
  const cochair = mode === 'full' ? pickCochair(chair, args.cochair ? String(args.cochair) : null) : (args.cochair ? String(args.cochair) : null);
  const test = usedFake(chair) || usedFake(cochair);
  const grade = mode === 'full' ? gradeForSeatIds([chair, cochair]) : { level: 'standard', note: '' };
  const unverified = mode === 'full' ? unverifiedFor([cochair]) : [];
  const { ledger, paths } = createTask({
    mode,
    chair,
    cochair,
    project: realDir(args.project),
    limitsName: 'standard',
    continuedFrom: args['continue-from'] ? String(args['continue-from']) : null,
    test,
    grade,
    unverified,
    hostMode,
  });
  if (args.goal) copyGoal(ledger.id, String(args.goal));
  const result = {
    ok: true,
    id: ledger.id,
    state: ledger.state,
    mode: ledger.mode,
    hostMode: hostModeOf(ledger),
    chair: ledger.chair,
    cochair: ledger.cochair,
    project: ledger.project,
    materials: paths.materials,
    deadlineAt: ledger.deadlineAt,
    continuedFrom: ledger.continuedFrom,
  };
  if (mode === 'full') {
    result.grade = grade.level;
    if (grade.level !== 'standard') result.gradeNote = grade.note;
    result.unverified = unverified;
  }
  return result;
}

export function cmdSeal(args) {
  const ledger = loadLedger(args.task);
  if (ledger.mode === 'assess') refuse('WRONG_STATE', 'An assessment task cannot be sealed.');
  const phase = String(args.phase || '');
  if (phase !== 'finish-line' && phase !== 'signoff') refuse('BAD_ARGS', '--phase must be finish-line or signoff.');
  if (phase === 'finish-line') assertState(ledger, ['finish-line'], 'seal finish-line');
  else assertState(ledger, ['frozen', 'signoff'], 'seal signoff');
  if (isClosed(ledger)) refuse('WRONG_STATE', `Task is ${ledger.state}.`);
  const n = nextRound(ledger, phase);
  if (!args.file || !fs.existsSync(path.resolve(String(args.file)))) refuse('BAD_ARGS', '--file verdict json is required.');
  let verdict;
  try { verdict = JSON.parse(fs.readFileSync(path.resolve(String(args.file)), 'utf8')); }
  catch { refuse('BAD_ARGS', 'Seal file is not JSON.'); }
  if (!verdict || verdict.phase !== phase || !verdict.verdict) {
    refuse('BAD_ARGS', 'Seal must include matching phase and verdict.');
  }
  const { hash } = writeSeal(ledger.id, phase, n, verdict);
  logEvent(ledger.id, 'seal', { phase, round: n, hash });
  return { ok: true, id: ledger.id, phase, round: n, sealHash: hash };
}

export async function cmdAsk(args) {
  checkAskRecursion();
  const ledger = loadLedger(args.task);
  if (ledger.mode === 'assess') refuse('WRONG_STATE', 'An assessment task cannot ask a seat.');
  checkPending(ledger.id);
  const phase = String(args.phase || '');
  if (phase !== 'finish-line' && phase !== 'signoff') refuse('BAD_ARGS', '--phase must be finish-line or signoff.');
  if (phase === 'finish-line') assertState(ledger, ['finish-line'], 'ask finish-line');
  else assertState(ledger, ['frozen', 'signoff'], 'ask signoff');
  if (phase === 'signoff' || ledger.state === 'frozen' || ledger.state === 'signoff') {
    checkFrozenChecklist(ledger);
  }
  const n = nextRound(ledger, phase);
  const time = checkTime(ledger);
  if (!time.ok) splitLimit(ledger, time, { phase, round: n });
  const rounds = checkRounds(ledger, phase);
  if (!rounds.ok) splitLimit(ledger, rounds, { phase, round: n });
  const calls = checkCallsAtCap(ledger);
  if (!calls.ok) splitLimit(ledger, calls, { phase, round: n });
  const seal = readSeal(ledger.id, phase, n);
  if (!seal) refuse('NO_SEAL', `No chair seal for ${phase} round ${n}.`);
  assertDispatchable(ledger.cochair);
  const prompt = buildPrompt({
    phase,
    project: ledger.project,
    materials: mats(ledger.id),
  });
  const call = await runSeatCall({
    ledger,
    seatId: ledger.cochair,
    phase,
    prompt,
    keepCopy: Boolean(args['keep-copy']),
  });
  if (call.pauseReason) {
    return applyPause(ledger, call.pauseReason, call.errors ? call.errors.join('; ') : call.pauseReason);
  }
  if (phase === 'finish-line') ledger.counters.finishLineRounds = n;
  else ledger.counters.signoffRounds = n;
  const rec = {
    phase, round: n, sealHash: sealHash(ledger.id, phase, n), callIndex: call.callIndex,
    verdict: call.verdict, tainted: call.tainted, blockingKey: phase === 'signoff' ? blockingKey(call.verdict) : null,
  };
  addRound(ledger, rec);
  return transitionAsk(ledger, phase, n, seal, call);
}

function decideSignoff(ledger, seal, n, reason) {
  recordChairDecision(ledger, { phase: 'signoff', round: n, reason });
  if (seal && seal.verdict) ledger.chairVerdict = seal.verdict;
  const file = writeChairDecision(ledger, { phase: 'signoff', round: n, reason });
  closeTask(ledger, 'decided', reason);
  logEvent(ledger.id, 'chair-decision', { phase: 'signoff', round: n, reason });
  return file;
}

function transitionAsk(ledger, phase, n, seal, call) {
  const verdict = call.verdict;
  const server = hostModeOf(ledger) === 'server';
  let chairFile = null;
  if (phase === 'finish-line') {
    if (verdict.verdict === 'AGREE') {
      freezeChecklist(ledger);
      setState(ledger, 'frozen');
    } else if (n >= (ledger.limits.finishLineRounds || 2)) {
      if (server) {
        freezeChecklist(ledger);
        recordChairDecision(ledger, { phase: 'finish-line', round: n, reason: 'finish-line OBJECT at last round' });
        setState(ledger, 'frozen');
        chairFile = writeChairDecision(ledger, { phase: 'finish-line', round: n, reason: 'finish-line OBJECT at last round' });
        logEvent(ledger.id, 'chair-decision', { phase: 'finish-line', round: n, reason: 'finish-line OBJECT at last round' });
      } else {
        writeSplitDecision(ledger);
        closeTask(ledger, 'split', 'finish-line OBJECT at last round');
      }
    } else {
      saveLedger(ledger);
    }
  } else {
    const chairDone = seal.verdict === 'DONE';
    const seatDone = verdict.verdict === 'DONE';
    const prev = [...ledger.rounds].reverse().find((r) => r.phase === 'signoff' && r.round !== n);
    if (chairDone && seatDone) {
      closeTask(ledger, 'done', 'both DONE');
      writeFinal(ledger);
    } else if (prev && prev.blockingKey && prev.blockingKey === blockingKey(verdict)) {
      if (server) chairFile = decideSignoff(ledger, seal, n, 'identical blocking set');
      else {
        writeSplitDecision(ledger);
        closeTask(ledger, 'split', 'identical blocking set');
      }
    } else if (n >= (ledger.limits.signoffRounds || 3)) {
      if (server) chairFile = decideSignoff(ledger, seal, n, 'sign-off rounds exhausted');
      else {
        writeSplitDecision(ledger);
        closeTask(ledger, 'split', 'sign-off rounds exhausted');
      }
    } else {
      setState(ledger, 'signoff');
    }
  }
  saveLedger(ledger);
  const out = {
    ok: true,
    id: ledger.id,
    state: ledger.state,
    phase,
    round: n,
    verdict,
    tainted: call.tainted,
    callIndex: call.callIndex,
    outcome: ledger.outcome,
  };
  if (chairFile) {
    out.chairDecided = true;
    out.report = chairFile;
  }
  return out;
}

export function cmdJob(args) {
  const ledger = loadLedger(args.task);
  if (ledger.mode === 'assess') refuse('WRONG_STATE', 'An assessment task cannot log a job.');
  if (isClosed(ledger)) refuse('WRONG_STATE', `Task is ${ledger.state}.`);
  const cap = checkCallsAtCap(ledger);
  if (!cap.ok) {
    if (hostModeOf(ledger) === 'server') serverLimit(ledger, cap);
    writeSplitDecision(ledger);
    closeTask(ledger, 'split', cap.code);
    refuse(cap.code, cap.message);
  }
  ledger.counters.workerJobs += 1;
  saveLedger(ledger);
  logEvent(ledger.id, 'job', { lane: args.lane || null, note: args.note || '', n: ledger.counters.workerJobs });
  return {
    ok: true,
    id: ledger.id,
    workerJobs: ledger.counters.workerJobs,
    callsUsed: ledger.counters.seatCalls + ledger.counters.workerJobs,
  };
}

export function cmdClose(args) {
  const ledger = loadLedger(args.task);
  if (args.outcome !== 'abandoned') refuse('BAD_ARGS', 'close only accepts --outcome abandoned.');
  if (isClosed(ledger)) refuse('WRONG_STATE', `Task is already ${ledger.state}.`);
  closeTask(ledger, 'abandoned', args.reason ? String(args.reason) : '');
  return { ok: true, id: ledger.id, state: 'abandoned', outcome: 'abandoned' };
}

export function cmdStatus(args) {
  // A detached referee that ended since the last look is collected first, so a task whose
  // referee stopped without a result reads as paused (or failed), not as still running.
  loadLedger(args.task);
  collectFinishedDetach(String(args.task));
  const ledger = loadLedger(args.task);
  const last = ledger.rounds[ledger.rounds.length - 1] || null;
  return {
    ok: true,
    id: ledger.id,
    mode: ledger.mode,
    hostMode: hostModeOf(ledger),
    state: ledger.state,
    chair: ledger.chair,
    cochair: ledger.cochair,
    counters: ledger.counters,
    deadlineAt: ledger.deadlineAt,
    lastVerdict: last ? last.verdict : null,
    next: nextStep(ledger),
    outcome: ledger.outcome,
    outcomeReason: ledger.outcomeReason,
    test: ledger.test,
  };
}

export function cmdList(args) {
  const index = loadIndex();
  let tasks = index.tasks || [];
  if (args.open) {
    tasks = tasks.filter((t) => !['done', 'split', 'decided', 'abandoned', 'recorded', 'failed'].includes(t.state));
  }
  return { ok: true, tasks };
}

export function nextStep(ledger) {
  if (ledger.mode === 'assess') {
    if (ledger.state === 'open') return 'wait for the assessment';
    if (ledger.state === 'assessed') return 'record what happened with assess-outcome when the task is finished';
    return null;
  }
  if (ledger.state === 'finish-line') {
    const n = nextRound(ledger, 'finish-line');
    return readSeal(ledger.id, 'finish-line', n) ? `ask --phase finish-line (round ${n})` : `seal --phase finish-line (round ${n})`;
  }
  if (ledger.state === 'frozen') return 'log jobs, then seal --phase signoff';
  if (ledger.state === 'signoff') return 'fix blocking items, seal the next sign-off round, ask again';
  if (ledger.state === 'paused') return 'fix the cause and rerun the same command';
  if (ledger.state === 'open') return 'consult is in progress or ready';
  if (ledger.state === 'answered') return 'read reports/feedback.md or consult again';
  if (ledger.state === 'decided') return null;
  return null;
}
