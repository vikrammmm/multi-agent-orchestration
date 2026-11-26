import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUtf8, writeUtf8 } from '../fsx.mjs';
import { emptyAdapterResult, resolveBinary, spawnSeat } from '../spawn.mjs';
import { finalReady } from './codex.mjs';

const vary = new Map();
const SEAT_PROC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-seat-proc.mjs');
// Behaviours whose process does not exit normally; fake-seat-proc.mjs describes each mode.
const STUCK = {
  'hang-after-output': 'hang-after-output',
  'orphan-hang': 'orphan-then-hang',
  'orphan-exit': 'orphan-then-exit',
};

function json(obj) {
  return JSON.stringify(obj);
}

function finishLine(verdict, extra = {}) {
  return {
    phase: 'finish-line',
    verdict,
    objections: extra.objections || [],
    checklist_additions: extra.checklist_additions || [],
    worker_jobs_requested: extra.worker_jobs_requested || [],
    later: extra.later || [],
    summary: extra.summary || (verdict === 'AGREE' ? 'Finish line is sufficient.' : 'Finish line is incomplete.'),
  };
}

function signoff(verdict, extra = {}) {
  return {
    phase: 'signoff',
    verdict,
    blocking: extra.blocking || [],
    later: extra.later || [],
    summary: extra.summary || (verdict === 'DONE' ? 'All checklist lines are met.' : 'Blocking items remain.'),
  };
}

function consultAnswer() {
  return {
    phase: 'consult',
    assessment: 'The brief is workable with a few concrete risks.',
    risks: [
      { risk: 'Missing tests around the change', severity: 'high', where: 'tests/' },
      { risk: 'Unclear rollback', severity: 'medium', where: 'deploy' },
    ],
    recommendations: [
      { priority: 'must', what: 'Add a failing-then-passing regression test', why: 'No evidence the defect stays gone.' },
      { priority: 'should', what: 'Document the gate command', why: 'The next reviewer needs a checkable step.' },
    ],
    questions_for_owner: ['Is the current scope the intended finish line?'],
    summary: 'Proceed, but add tests first.',
  };
}

function assessAnswer(behaviour) {
  const complex = behaviour === 'assess-complex' || behaviour === 'assess-inconsistent';
  return {
    phase: 'assess', rating: complex ? 'complex' : 'simple',
    suggest_consensus: behaviour === 'assess-complex',
    suggested_tier: complex ? 'cto' : 'developer', confidence: 'high',
    danger_hits: behaviour === 'assess-complex' ? [{ category: 'money', where: 'payments.js' }] : [],
    expected_files: [{ path: 'feature.js', why: 'The brief asks for a change here.' }],
    unknowns: [], architectural: false, reasons: ['The brief gives a bounded change.'],
    files_read: ['brief.md'], summary: 'This task is sized from the brief.',
  };
}

function mergeDraft() {
  return {
    phase: 'merge',
    unified_feedback: '## Must\n- Add a regression test.\n\n## Should\n- Document the gate command.\n',
    dropped: [],
    disputed: [],
  };
}

function confirm(verdict) {
  return {
    phase: 'confirm',
    verdict,
    objections: verdict === 'OBJECT' ? ['The draft omits a must-have test recommendation.'] : [],
    summary: verdict === 'CONFIRM' ? 'Draft is a fair merge.' : 'Draft is missing a must.',
  };
}

function oneObjection() {
  return [{
    target: 'checklist',
    item: '1',
    problem: 'The first line is not a checkable gate.',
    proposed_fix: 'Name the exact command that proves the line.',
  }];
}

function sameBlock() {
  return [{ checklist_line: 2, defect: 'Checklist line 2 is not met.', evidence: 'tests.txt does not show the gate passing.' }];
}

function payload(phase, behaviour, callIndex) {
  if (behaviour === 'garbage') return 'this is not json';
  if (phase === 'assess') return json(assessAnswer(behaviour));
  if (phase === 'finish-line') {
    if (behaviour === 'agree-ratetext') {
      return json(finishLine('AGREE', { summary: 'AGREE. The plan handles a 429 rate limit and a "login required" error correctly.' }));
    }
    if (behaviour === 'object') {
      return json(finishLine('OBJECT', { objections: oneObjection(), checklist_additions: ['Run the documented gate command.'] }));
    }
    return json(finishLine('AGREE'));
  }
  if (phase === 'signoff') {
    if (behaviour === 'not-done-same' || behaviour === 'object') return json(signoff('NOT_DONE', { blocking: sameBlock() }));
    if (behaviour === 'not-done-vary') {
      const n = Number(callIndex) || ((vary.get('vary') || 0) + 1);
      vary.set('vary', n);
      return json(signoff('NOT_DONE', {
        blocking: [{ checklist_line: n, defect: `Line ${n} is not met.`, evidence: `evidence ${n}` }],
        summary: `Checklist line ${n} is not met.`,
      }));
    }
    return json(signoff('DONE'));
  }
  if (phase === 'consult') {
    return json(consultAnswer());
  }
  if (phase === 'merge') {
    return json(mergeDraft());
  }
  if (phase === 'confirm') {
    if (behaviour === 'merge-object' || behaviour === 'object' || behaviour === 'not-done-same' || behaviour === 'not-done-vary') {
      return json(confirm('OBJECT'));
    }
    return json(confirm('CONFIRM'));
  }
  return json(finishLine('AGREE'));
}

function done(callDir, rawText, extra = {}) {
  writeUtf8(path.join(callDir, 'stdout.txt'), rawText.endsWith('\n') ? rawText : rawText + '\n');
  writeUtf8(path.join(callDir, 'stderr.txt'), '');
  return {
    ...emptyAdapterResult(callDir),
    status: 'completed',
    exitCode: 0,
    rawText,
    durationMs: extra.durationMs || 1,
    ...extra,
  };
}

export async function run(opts) {
  const behaviour = opts.seat.behaviour || String(opts.seat.id || '').slice(5);
  const phase = opts.phase;
  const callDir = opts.callDir;
  if (behaviour === 'timeout') {
    const bin = process.execPath;
    return wrapSpawn(await spawnSeat({
      bin,
      args: ['-e', 'setTimeout(()=>{}, 120000)'],
      cwd: opts.projectDir || callDir,
      prompt: '',
      env: opts.env || process.env,
      timeoutMs: opts.timeoutMs,
      stdoutPath: path.join(callDir, 'stdout.txt'),
      stderrPath: path.join(callDir, 'stderr.txt'),
      detachedGroup: true,
    }), callDir);
  }
  if (behaviour === 'missing') {
    const bin = resolveBinary('consensus-no-such-binary-xyz', null) || 'consensus-no-such-binary-xyz';
    return wrapSpawn(await spawnSeat({
      bin,
      args: ['--version'],
      cwd: opts.projectDir || callDir,
      prompt: '',
      env: opts.env || process.env,
      timeoutMs: opts.timeoutMs || 5000,
      stdoutPath: path.join(callDir, 'stdout.txt'),
      stderrPath: path.join(callDir, 'stderr.txt'),
    }), callDir, 'unavailable');
  }
  if (STUCK[behaviour]) {
    // A real child, codex-shaped: the agree verdict on stdin comes back in final.txt (the
    // declared output) or on stdout. Every process it starts is listed in pids.txt.
    const finalPath = path.join(callDir, 'final.txt');
    const spawned = await spawnSeat({
      bin: process.execPath,
      args: [SEAT_PROC, STUCK[behaviour], path.join(callDir, 'pids.txt'), finalPath],
      cwd: opts.projectDir || callDir,
      prompt: payload(phase, 'agree', opts.callIndex),
      env: opts.env || process.env,
      timeoutMs: opts.timeoutMs,
      stdoutPath: path.join(callDir, 'stdout.txt'),
      stderrPath: path.join(callDir, 'stderr.txt'),
      detachedGroup: true,
      ready: finalReady(finalPath, opts.isComplete),
    });
    let rawText = '';
    try { rawText = readUtf8(finalPath).trim(); } catch { /* not written */ }
    return wrapSpawn({ ...spawned, rawText: rawText || spawned.rawText }, callDir);
  }
  if (behaviour === 'writer') {
    const target = path.join(opts.projectDir, 'CONSENSUS-WRITER-TEST.txt');
    writeUtf8(target, 'written-by-fake-writer\n');
  }
  return done(callDir, payload(phase, behaviour, opts.callIndex));
}

function wrapSpawn(spawned, callDir, forceStatus) {
  return {
    ...emptyAdapterResult(callDir),
    status: forceStatus || spawned.status,
    exitCode: spawned.exitCode,
    signal: spawned.signal,
    rawText: spawned.rawText || '',
    durationMs: spawned.durationMs,
    errorText: spawned.errorText || '',
    endedBy: spawned.endedBy || null,
  };
}
