import fs from 'node:fs';
import path from 'node:path';
import { runSeatCall } from './call.mjs';
import { refuse } from './fail.mjs';
import { realDir, tryReadJson, writeUtf8 } from './fsx.mjs';
import { checkConsultRecursion, checkPending } from './guard.mjs';
import {
  closeTask, copyBrief, createTask, loadIndex, loadLedger, materialText, nowIso, setState,
} from './ledger.mjs';
import { ledgerRoot, taskPaths } from './paths.mjs';
import { checkCallsAtCap, checkTime } from './limits.mjs';
import { buildPrompt, materialsBundle } from './prompt.mjs';
import { chooseAssessor, getAssessor, loadSeatsJson, usedFake } from './seats.mjs';

export const TRIAL_NOTE = 'TRIAL: this assessment changes nothing; the fixed consensus triggers still decide. Record what happened with assess-outcome when the task is finished.';
export const OWNER_SENTENCE = 'The owner decides whether the assessment replaces the size trigger and the unclear, contradictory or architectural trigger; nothing changes automatically; the danger triggers stay fixed.';

function assessMaterials(id) {
  const dir = taskPaths(id).materials;
  return materialsBundle(dir, {
    goal: materialText(id, 'goal.md'), plan: materialText(id, 'plan.md'),
    checklist: materialText(id, 'checklist.md'), diff: materialText(id, 'diff.patch'),
    tests: materialText(id, 'tests.txt'), brief: materialText(id, 'brief.md'),
  });
}

export function ensureAssessTask(args) {
  checkConsultRecursion();
  const said = args['rules-said'] == null ? null : args['rules-said'];
  if (said !== null && said !== 'suggest' && said !== 'no') refuse('BAD_ARGS', '--rules-said must be suggest or no.');
  if (!args.project || !fs.existsSync(path.resolve(String(args.project))) || !fs.statSync(path.resolve(String(args.project))).isDirectory()) {
    refuse('BAD_ARGS', '--project must be an existing directory.');
  }
  if (!args.brief || !fs.existsSync(path.resolve(String(args.brief))) || !fs.statSync(path.resolve(String(args.brief))).isFile()) {
    refuse('BAD_ARGS', '--brief must be an existing file.');
  }
  const assessor = chooseAssessor(args.assessor);
  const { ledger } = createTask({
    mode: 'assess', chair: assessor, cochair: null, project: realDir(args.project),
    limitsName: 'assess', test: usedFake(assessor),
    grade: { level: 'assessment', note: 'Task-sizing assessment (trial), not a consensus review.' },
  });
  copyBrief(ledger.id, String(args.brief));
  ledger.fixedRules = { said, triggers: args.triggers == null ? null : String(args.triggers) };
  setState(ledger, 'open');
  return ledger;
}

function assessmentReport(ledger, verdict, assessment) {
  const file = path.join(taskPaths(ledger.id).reports, 'assessment.md');
  const lines = [
    '# Task sizing assessment (trial)', '',
    `Task: ${ledger.id}`, `Assessor: ${assessment.assessor} (${assessment.model})`,
    `Phase: ${verdict.phase}`,
    `Rating: ${verdict.rating}`, `Suggest consensus: ${assessment.suggestConsensus}`,
    `Assessor suggested consensus: ${verdict.suggest_consensus}`,
    `Inconsistent suggestion: ${assessment.inconsistent}`,
    `Suggested tier: ${verdict.suggested_tier}`, `Confidence: ${verdict.confidence}`,
    `Architectural: ${verdict.architectural}`, `Tainted: ${assessment.tainted}`, '',
    `Fixed rules said: ${ledger.fixedRules?.said || 'not given'}`,
    `Fixed rule triggers: ${ledger.fixedRules?.triggers || 'not given'}`, '',
    '## Summary', verdict.summary, '',
    '## Reasons', ...verdict.reasons.map((v) => `- ${v}`), '',
    '## Danger hits', ...verdict.danger_hits.map((v) => `- ${v.category}: ${v.where}`), '',
    '## Expected files', ...verdict.expected_files.map((v) => `- ${v.path}: ${v.why}`), '',
    '## Unknowns', ...verdict.unknowns.map((v) => `- ${v}`), '',
    '## Files read', ...verdict.files_read.map((v) => `- ${v}`), '',
    TRIAL_NOTE, '',
  ];
  writeUtf8(file, lines.join('\n'));
  return file;
}

// An existing task (the detached child, or a rerun of an open one) passes the same machine checks
// as a new one before anything is dispatched: consensus on, and its assessor still usable here.
export function loadOpenAssessTask(id) {
  checkConsultRecursion();
  const ledger = loadLedger(id);
  if (ledger.mode !== 'assess' || ledger.state !== 'open') refuse('WRONG_STATE', `Task is ${ledger.state} (${ledger.mode}).`);
  chooseAssessor(ledger.chair);
  return ledger;
}

export async function cmdAssess(args) {
  checkConsultRecursion();
  const ledger = args.task ? loadOpenAssessTask(args.task) : ensureAssessTask(args);
  checkPending(ledger.id);
  for (const check of [checkTime(ledger), checkCallsAtCap(ledger)]) {
    if (!check.ok) refuse(check.code, check.message);
  }
  const seatId = ledger.chair;
  const seat = getAssessor(seatId);
  const prompt = buildPrompt({ phase: 'assess', project: ledger.project, materials: assessMaterials(ledger.id) });
  const call = await runSeatCall({ ledger, seatId, phase: 'assess', prompt, seat });
  if (call.pauseReason) {
    closeTask(ledger, 'failed', call.pauseReason);
    return {
      ok: false, code: call.pauseReason, id: ledger.id, state: 'failed', assessor: seatId,
      tainted: call.tainted,
      message: 'The assessment failed; the fixed consensus triggers decide as usual. Fix the cause and run assess again, or name another assessor with --assessor.',
    };
  }
  const v = call.verdict;
  const suggestConsensus = v.suggest_consensus || v.rating === 'complex' || v.danger_hits.length > 0;
  const inconsistent = suggestConsensus && !v.suggest_consensus;
  ledger.assessment = {
    assessor: seatId, model: seat.model, rating: v.rating, suggestConsensus, inconsistent,
    suggestedTier: v.suggested_tier, confidence: v.confidence, dangerHits: v.danger_hits,
    architectural: v.architectural, expectedFiles: v.expected_files.length,
    unknowns: v.unknowns.length, callIndex: call.callIndex,
    durationMs: call.result.durationMs, usage: call.result.usage || null, tainted: call.tainted,
  };
  const report = assessmentReport(ledger, v, ledger.assessment);
  setState(ledger, 'assessed');
  return {
    ok: true, id: ledger.id, state: 'assessed', assessor: seatId, rating: v.rating,
    suggestConsensus, inconsistent, suggestedTier: v.suggested_tier,
    confidence: v.confidence, dangerHits: v.danger_hits, architectural: v.architectural,
    unknowns: v.unknowns, tainted: call.tainted, report, trial: true, note: TRIAL_NOTE,
  };
}

export function cmdAssessOutcome(args) {
  if (!args.task) refuse('BAD_ARGS', '--task is required.');
  const ledger = loadLedger(args.task);
  if (ledger.mode !== 'assess' || ledger.state !== 'assessed') refuse('WRONG_STATE', `Task is ${ledger.state} (${ledger.mode}).`);
  for (const name of ['files-changed', 'gate-failures']) {
    if (typeof args[name] !== 'string' || !/^\d+$/.test(args[name])) refuse('BAD_ARGS', `--${name} must be a nonnegative integer.`);
  }
  if (!['used', 'declined', 'not-suggested'].includes(args.consensus)) refuse('BAD_ARGS', '--consensus must be used, declined, or not-suggested.');
  if (args['owner-view'] != null && !['right', 'too-low', 'too-high'].includes(args['owner-view'])) {
    refuse('BAD_ARGS', '--owner-view must be right, too-low, or too-high.');
  }
  if (args.note != null && typeof args.note !== 'string') refuse('BAD_ARGS', '--note must be a string.');
  const outcome = {
    recordedAt: nowIso(), filesChanged: Number(args['files-changed']),
    gateFailures: Number(args['gate-failures']), consensus: args.consensus,
    ownerView: args['owner-view'] || null, note: args.note || null,
  };
  ledger.outcomeRecord = outcome;
  closeTask(ledger, 'recorded', 'outcome recorded');
  return { ok: true, id: ledger.id, state: 'recorded', outcome };
}

export function cmdAssessReport(args) {
  // A damaged task folder is listed, not fatal: the rest of the trial still reports.
  const unreadable = [];
  const records = [];
  for (const row of (loadIndex().tasks || []).filter((r) => r.mode === 'assess')) {
    let ledger;
    try { ledger = loadLedger(row.id); } catch { unreadable.push(row.id); continue; }
    if (args.all || !ledger.test) records.push(ledger);
  }
  const totals = { assessed: 0, recorded: 0, waiting: 0, failed: 0 };
  const ratings = { simple: 0, moderate: 0, complex: 0 };
  const agreement = { bothSuggest: 0, neither: 0, assessorOnly: 0, fixedRulesOnly: 0, fixedRulesNotGiven: 0 };
  const perAssessor = {};
  let misses = 0;
  let overCalls = 0;
  const tasks = [];
  for (const ledger of records) {
    const a = ledger.assessment;
    const outcome = ledger.outcomeRecord;
    if (ledger.state === 'failed') totals.failed++;
    if (a) {
      totals.assessed++;
      ratings[a.rating]++;
      if (ledger.state === 'assessed') totals.waiting++;
      if (ledger.state === 'recorded') totals.recorded++;
      const said = ledger.fixedRules?.said;
      if (!said) agreement.fixedRulesNotGiven++;
      else if (said === 'suggest' && a.suggestConsensus) agreement.bothSuggest++;
      else if (said === 'no' && !a.suggestConsensus) agreement.neither++;
      else if (a.suggestConsensus) agreement.assessorOnly++;
      else agreement.fixedRulesOnly++;
      if (outcome && !a.suggestConsensus && (outcome.gateFailures >= 2 || outcome.ownerView === 'too-low')) misses++;
      if (outcome && a.suggestConsensus && outcome.ownerView === 'too-high') overCalls++;
    }
    const id = a?.assessor || ledger.chair;
    const tally = perAssessor[id] || { calls: 0, totalDurationMs: 0 };
    const calls = ledger.counters?.seatCalls || 0;
    for (let n = 1; n <= calls; n++) {
      tally.totalDurationMs += tryReadJson(path.join(taskPaths(ledger.id).calls, String(n), 'meta.json'))?.durationMs || 0;
    }
    tally.calls += calls;
    perAssessor[id] = tally;
    tasks.push({
      id: ledger.id, date: ledger.startedAt, assessor: id, rating: a?.rating || null,
      suggestConsensus: a?.suggestConsensus ?? null, fixedRulesSaid: ledger.fixedRules?.said || null,
      outcome: outcome ? `${outcome.consensus}; ${outcome.filesChanged} files; ${outcome.gateFailures} gate failures; ${outcome.ownerView || 'no owner view'}` : ledger.state,
    });
  }
  for (const [id, tally] of Object.entries(perAssessor)) {
    perAssessor[id] = { calls: tally.calls, meanDurationMs: tally.calls ? Math.round(tally.totalDurationMs / tally.calls) : 0 };
  }
  const trialTasks = loadSeatsJson().assessment.trialTasks;
  const trial = { recorded: totals.recorded, trialTasks, trialComplete: totals.recorded >= trialTasks };
  const report = path.join(ledgerRoot(), 'assessment-trial.md');
  const body = [
    '# Task sizing assessment trial', '',
    `Assessed: ${totals.assessed}; recorded: ${totals.recorded}; waiting: ${totals.waiting}; failed: ${totals.failed}`,
    `Ratings: ${JSON.stringify(ratings)}`, `Agreement: ${JSON.stringify(agreement)}`,
    `Misses: ${misses}; over-calls: ${overCalls}`,
    `Trial progress: ${trial.recorded} of ${trial.trialTasks}; complete: ${trial.trialComplete}`,
    '', OWNER_SENTENCE, '', '## Per assessor',
    ...Object.entries(perAssessor).map(([id, value]) => `- ${id}: ${value.calls} calls; mean ${value.meanDurationMs} ms`),
    '', '## Tasks',
    ...tasks.map((task) => `- ${task.id} (${task.date}): ${task.assessor}; ${task.rating || task.outcome}; suggest ${task.suggestConsensus}; fixed ${task.fixedRulesSaid || 'not given'}; ${task.outcome}`), '',
    ...(unreadable.length ? ['## Unreadable task folders', ...unreadable.map((id) => `- ${id}`), ''] : []),
  ];
  writeUtf8(report, body.join('\n'));
  return { ok: true, totals, ratings, agreement, misses, overCalls, perAssessor, trial, note: OWNER_SENTENCE, report, tasks, unreadable };
}
