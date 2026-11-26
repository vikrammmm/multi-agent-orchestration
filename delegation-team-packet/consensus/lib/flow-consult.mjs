import fs from 'node:fs';
import path from 'node:path';
import { realDir } from './fsx.mjs';
import { applyPause, runSeatCall } from './call.mjs';
import { refuse } from './fail.mjs';
import { checkConsultRecursion, checkPending } from './guard.mjs';
import {
  closeTask, copyBrief, createTask, isClosed, loadLedger, materialText, saveLedger, setState,
} from './ledger.mjs';
import { checkCallsAtCap, checkConsultCalls, checkConsultations } from './limits.mjs';
import { hostModeOf, requireHostMode, taskPaths } from './paths.mjs';
import { buildPrompt, materialsBundle } from './prompt.mjs';
import { formatConsultFeedback, writeFeedback, writeSplitConsult } from './report.mjs';
import {
  assertDispatchable, expandSeats, gradeForSeatIds, refuseSameModel, unverifiedFor, usedFake,
} from './seats.mjs';

function mats(id) {
  return materialsBundle(taskPaths(id).materials, {
    goal: materialText(id, 'goal.md'),
    plan: materialText(id, 'plan.md'),
    checklist: materialText(id, 'checklist.md'),
    diff: materialText(id, 'diff.patch'),
    tests: materialText(id, 'tests.txt'),
    brief: materialText(id, 'brief.md'),
  });
}

export function ensureTask(args) {
  if (args.task) {
    const ledger = loadLedger(args.task);
    if (ledger.mode === 'assess') refuse('WRONG_STATE', 'An assessment task cannot be consulted.');
    if (isClosed(ledger)) refuse('WRONG_STATE', `Task is ${ledger.state}.`);
    return ledger;
  }
  const hostMode = requireHostMode();
  if (args.limits && args.limits !== 'standard' && args.limits !== true) {
    refuse('NO_EXTEND', 'No command can raise a limit; only --limits standard is allowed.');
  }
  if (!args.project || !fs.existsSync(path.resolve(String(args.project)))) {
    refuse('BAD_ARGS', '--project must be an existing directory.');
  }
  const seats = expandSeats(args.seats);
  const grade = gradeForSeatIds(seats);
  const unverified = unverifiedFor(seats);
  const { ledger } = createTask({
    mode: 'advise',
    chair: seats[0],
    cochair: seats[1] || null,
    project: realDir(args.project),
    limitsName: 'standard',
    test: seats.some(usedFake),
    grade,
    unverified,
    hostMode,
  });
  return ledger;
}

// The grade and not-verified seats this consultation stored on its ledger.
function gradeFields(ledger) {
  const grade = ledger.grade || { level: 'standard', note: '' };
  const fields = { grade: grade.level, unverified: ledger.unverified || [] };
  if (grade.level !== 'standard') fields.gradeNote = grade.note;
  return fields;
}

// A JSON retry is a seat call too, so it counts against the per-consultation cap.
function callsUsed(call) {
  return call && call.retryCallIndex ? 2 : 1;
}

function budgetOrSplit(ledger, rec, extra = 1) {
  const taskCap = checkCallsAtCap(ledger);
  if (!taskCap.ok) {
    rec.outcome = 'split';
    writeSplitConsult(ledger, { draft: rec.draft, confirm: rec.confirm, answers: rec.answers });
    closeTask(ledger, 'split', taskCap.code);
    refuse(taskCap.code, taskCap.message);
  }
  const c = checkConsultCalls(ledger, rec.calls, extra);
  if (!c.ok) {
    rec.outcome = 'split';
    writeSplitConsult(ledger, { draft: rec.draft, confirm: rec.confirm, answers: rec.answers });
    closeTask(ledger, 'split', c.code);
    refuse(c.code, c.message);
  }
}

export async function cmdConsult(args) {
  checkConsultRecursion();
  const reused = Boolean(args.task);
  const ledger = ensureTask(args);
  checkPending(ledger.id);
  // A task keeps its reviewers: every consultation uses the seats the task started with.
  const seats = [ledger.chair, ledger.cochair].filter(Boolean);
  if (reused && args.seats) {
    if (args.seats === true || args.seats === 'both') {
      if (seats.length < 2) {
        refuse('SEAT_UNAVAILABLE', `Task ${ledger.id} has one reviewer (${seats[0]}); a pair needs a new consultation.`);
      }
    } else {
      const named = String(args.seats).split(',').map((s) => s.trim()).filter(Boolean);
      if (new Set(named).size !== named.length) refuse('SAME_MODEL', `Seats ${named.join(', ')} name the same model twice.`);
      refuseSameModel(named);
      if (named.length !== seats.length || named.some((id) => !seats.includes(id))) {
        refuse('BAD_ARGS', `Task ${ledger.id} keeps its seats (${seats.join(' + ')}); start a new consultation for other seats.`);
      }
    }
  }
  for (const id of seats) assertDispatchable(id);
  const consults = checkConsultations(ledger);
  if (!consults.ok) refuse(consults.code, consults.message);
  if (args.brief) copyBrief(ledger.id, String(args.brief));
  const stage = args.stage ? String(args.stage) : 'plan';
  ledger.counters.consultations += 1;
  if (seats.some(usedFake)) ledger.test = true;
  // This consultation's grade and not-verified seats, for its answer and its report.
  const grade = gradeForSeatIds(seats);
  ledger.grade = grade;
  ledger.unverified = unverifiedFor(seats);
  const rec = {
    n: ledger.counters.consultations, seats, calls: 0, mergeRounds: 0, outcome: null,
    grade: grade.level, unverified: ledger.unverified,
  };
  ledger.consultations.push(rec);
  ledger.state = 'open';
  saveLedger(ledger);
  budgetOrSplit(ledger, rec, seats.length);

  const prompt = buildPrompt({
    phase: 'consult',
    project: ledger.project,
    materials: mats(ledger.id),
    extra: { STAGE: stage },
  });

  const results = await Promise.all(seats.map((seatId) => runSeatCall({
    ledger, seatId, phase: 'consult', prompt, keepCopy: Boolean(args['keep-copy']),
  })));
  rec.calls += results.reduce((sum, r) => sum + callsUsed(r), 0);
  rec.answers = results.map((r) => r.verdict);
  saveLedger(ledger);
  const paused = results.find((r) => r.pauseReason);
  if (paused) {
    const out = applyPause(ledger, paused.pauseReason, 'consult seat failed');
    out.hostMode = hostModeOf(ledger);
    return out;
  }

  if (seats.length === 1) {
    const file = writeFeedback(ledger, formatConsultFeedback(results[0].verdict, hostModeOf(ledger)));
    rec.outcome = 'answered';
    setState(ledger, 'answered', { outcome: 'answered' });
    return { ok: true, id: ledger.id, state: 'answered', hostMode: hostModeOf(ledger), report: file, seats, ...gradeFields(ledger) };
  }

  return mergeConfirm(ledger, rec, seats, results, args);
}

async function mergeConfirm(ledger, rec, seats, consultResults, args) {
  let draft = null;
  let confirm = null;
  const objections = '';
  for (let round = 1; round <= (ledger.limits.mergeRounds || 2); round++) {
    budgetOrSplit(ledger, rec, 1);
    rec.mergeRounds = round;
    const mergePrompt = buildPrompt({
      phase: 'merge',
      project: ledger.project,
      materials: mats(ledger.id),
      extra: {
        ANSWER_A: JSON.stringify(consultResults[0].verdict, null, 2),
        ANSWER_B: JSON.stringify(consultResults[1].verdict, null, 2),
        DRAFT: draft ? draft.unified_feedback : '',
        OBJECTIONS_LIST: (confirm && confirm.objections || []).join('\n'),
      },
      objections: round > 1 ? (confirm && confirm.objections || []).join('\n') : objections,
    });
    const mergeCall = await runSeatCall({ ledger, seatId: seats[0], phase: 'merge', prompt: mergePrompt });
    rec.calls += callsUsed(mergeCall);
    if (mergeCall.pauseReason) {
      const out = applyPause(ledger, mergeCall.pauseReason, 'merge failed');
      out.hostMode = hostModeOf(ledger);
      return out;
    }
    draft = mergeCall.verdict;
    rec.draft = draft;

    budgetOrSplit(ledger, rec, 1);
    const confirmPrompt = buildPrompt({
      phase: 'confirm',
      project: ledger.project,
      materials: mats(ledger.id),
      extra: {
        ANSWER_B: JSON.stringify(consultResults[1].verdict, null, 2),
        DRAFT: draft.unified_feedback,
      },
    });
    const confirmCall = await runSeatCall({ ledger, seatId: seats[1], phase: 'confirm', prompt: confirmPrompt });
    rec.calls += callsUsed(confirmCall);
    if (confirmCall.pauseReason) {
      const out = applyPause(ledger, confirmCall.pauseReason, 'confirm failed');
      out.hostMode = hostModeOf(ledger);
      return out;
    }
    confirm = confirmCall.verdict;
    rec.confirm = confirm;

    if (confirm.verdict === 'CONFIRM') {
      const file = writeFeedback(ledger, formatConsultFeedback(draft, hostModeOf(ledger)));
      rec.outcome = 'answered';
      setState(ledger, 'answered', { outcome: 'answered' });
      return { ok: true, id: ledger.id, state: 'answered', hostMode: hostModeOf(ledger), report: file, seats, mergeRounds: round, ...gradeFields(ledger) };
    }
  }

  rec.outcome = 'split';
  const file = writeSplitConsult(ledger, { draft, confirm, answers: rec.answers });
  closeTask(ledger, 'split', 'consult confirm OBJECT');
  return { ok: true, id: ledger.id, state: 'split', hostMode: hostModeOf(ledger), report: file, seats, calls: rec.calls, ...gradeFields(ledger) };
}
