import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCodexArgs } from '../lib/adapters/codex.mjs';
import { cmdAssess, cmdAssessOutcome, cmdAssessReport } from '../lib/flow-assess.mjs';
import { cmdList, cmdStatus } from '../lib/flow-full.mjs';
import { assessorEligibility, pickAssessor, pickPair, rankPartners } from '../lib/select.mjs';
import { loadTask, run, setup, startFull, tmp, writeLf } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEATS = JSON.parse(fs.readFileSync(path.join(ROOT, 'seats.json'), 'utf8'));
const NOTE = 'TRIAL: this assessment changes nothing; the fixed consensus triggers still decide. Record what happened with assess-outcome when the task is finished.';

function brief(ctx) {
  const file = path.join(ctx.project, 'brief.md');
  writeLf(file, 'Implement the bounded feature and run its tests.\n');
  return file;
}

function assess(ctx, id = 'fake:assess-simple', extra = {}, argv = []) {
  return run(['assess', '--project', ctx.project, '--brief', brief(ctx), '--assessor', id, ...argv], { ...ctx, ...extra });
}

function indexBytes(ctx) {
  const file = path.join(ctx.ledger, 'index.json');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function taskBytes(ctx, id) {
  return fs.readFileSync(path.join(ctx.ledger, 'tasks', id, 'ledger.json'), 'utf8');
}

function assertRefusal(ctx, argv, code) {
  const before = indexBytes(ctx);
  const got = run(argv, ctx);
  assert.equal(got.status, 2, got.stdout + got.stderr);
  assert.equal(got.json?.code, code);
  assert.equal(indexBytes(ctx), before);
}

test('assessment records one call, copied brief, verdict, limits and report', () => {
  const ctx = setup();
  const got = assess(ctx);
  assert.equal(got.status, 0, got.stdout + got.stderr);
  assert.deepEqual({
    state: got.json.state, rating: got.json.rating, suggestConsensus: got.json.suggestConsensus,
    suggestedTier: got.json.suggestedTier, confidence: got.json.confidence,
    dangerHits: got.json.dangerHits, architectural: got.json.architectural,
    tainted: got.json.tainted, trial: got.json.trial, note: got.json.note,
  }, {
    state: 'assessed', rating: 'simple', suggestConsensus: false, suggestedTier: 'developer',
    confidence: 'high', dangerHits: [], architectural: false, tainted: false, trial: true, note: NOTE,
  });
  const ledger = loadTask(ctx, got.json.id);
  assert.equal(ledger.mode, 'assess');
  assert.equal(ledger.counters.seatCalls, 1);
  assert.equal(ledger.assessment.assessor, 'fake:assess-simple');
  assert.equal(ledger.assessment.expectedFiles, 1);
  assert.deepEqual([ledger.limits.totalCalls, ledger.limits.seatCallMinutes, ledger.limits.totalHours], [2, 15, 1]);
  assert.equal(fs.readFileSync(path.join(ctx.ledger, 'tasks', ledger.id, 'materials', 'brief.md'), 'utf8'), 'Implement the bounded feature and run its tests.\n');
  assert.ok(fs.existsSync(got.json.report));
  assert.match(fs.readFileSync(got.json.report, 'utf8'), /Trial|trial/);
});

test('complex and inconsistent verdicts force the suggestion', () => {
  for (const [behaviour, inconsistent] of [['fake:assess-complex', false], ['fake:assess-inconsistent', true]]) {
    const ctx = setup();
    const got = assess(ctx, behaviour);
    assert.equal(got.status, 0, got.stdout);
    assert.equal(got.json.suggestConsensus, true);
    assert.equal(got.json.inconsistent, inconsistent);
    assert.equal(loadTask(ctx, got.json.id).assessment.inconsistent, inconsistent);
  }
});

test('pre-task refusals never create a task or call', () => {
  const ctx = setup();
  const base = ['assess', '--project', ctx.project, '--brief', brief(ctx), '--assessor', 'fake:assess-simple'];
  for (const [env, code] of [[{ CONSENSUS_SEAT: '1' }, 'CONSENSUS_SEAT'], [{ DELEGATION_DISPATCHED: '1' }, 'DELEGATION_DISPATCHED']]) {
    const before = indexBytes(ctx);
    const got = run(base, { ...ctx, env });
    assert.equal(got.json.code, code);
    assert.equal(indexBytes(ctx), before);
  }
  assertRefusal(ctx, ['assess', '--project', path.join(ctx.project, 'absent'), '--brief', brief(ctx), '--assessor', 'fake:assess-simple'], 'BAD_ARGS');
  assertRefusal(ctx, ['assess', '--project', ctx.project, '--brief', path.join(ctx.project, 'absent'), '--assessor', 'fake:assess-simple'], 'BAD_ARGS');
  assertRefusal(ctx, [...base, '--rules-said', 'maybe'], 'BAD_ARGS');
  assertRefusal(ctx, ['assess', '--project', ctx.project, '--brief', brief(ctx), '--assessor', 'gpt-6.1-sol'], 'BAD_ARGS');
  const rt = privateRuntime();
  writeLf(path.join(rt, 'local.json'), JSON.stringify({ disabled: 'maintenance' }));
  const disabled = runtimeRun(rt, base, ctx);
  assert.equal(disabled.json.code, 'CONSENSUS_DISABLED');
  writeLf(path.join(rt, 'local.json'), JSON.stringify({ assessors: { 'fake:assess-simple': { unavailable: 'blocked here' } } }));
  const unavailable = runtimeRun(rt, base, ctx);
  assert.equal(unavailable.json.code, 'ASSESSOR_UNAVAILABLE');
  assert.equal(indexBytes(ctx), null);
});

test('invalid, timeout and missing assessor close failed without fallback', () => {
  for (const [id, code, count, env] of [
    ['fake:garbage', 'INVALID_VERDICT', 2, {}],
    ['fake:timeout', 'TIMEOUT', 1, { CONSENSUS_SEAT_TIMEOUT_MS: '100' }],
    ['fake:missing', 'SEAT_UNAVAILABLE', 1, {}],
  ]) {
    const ctx = setup();
    const got = assess(ctx, id, { env });
    assert.equal(got.status, 2, got.stdout + got.stderr);
    assert.equal(got.json.ok, false);
    assert.equal(got.json.code, code);
    assert.equal(got.json.state, 'failed');
    assert.equal(got.json.assessor, id);
    assert.equal(loadTask(ctx, got.json.id).counters.seatCalls, count);
  }
});

test('writer taints result, ledger and report', () => {
  const ctx = setup();
  const got = assess(ctx, 'fake:writer');
  assert.equal(got.json.tainted, true);
  assert.equal(loadTask(ctx, got.json.id).assessment.tainted, true);
  assert.match(fs.readFileSync(got.json.report, 'utf8'), /Tainted: true/);
});

test('detached assessment returns the foreground fields through wait', () => {
  const ctx = setup();
  const foreground = assess(setup()).json;
  const started = assess(ctx, 'fake:assess-simple', {}, ['--detach']);
  assert.equal(started.status, 0, started.stdout);
  const got = run(['wait', '--task', started.json.id, '--minutes', '1'], { ...ctx, timeout: 75000 });
  assert.equal(got.status, 0, got.stdout + got.stderr);
  for (const key of ['state', 'assessor', 'rating', 'suggestConsensus', 'suggestedTier', 'confidence', 'tainted', 'trial', 'note']) {
    assert.equal(got.json[key], foreground[key]);
  }
});

test('outcome validation, recording, second refusal and report aggregation', () => {
  const ctx = setup();
  const one = assess(ctx);
  const two = assess(ctx, 'fake:assess-complex', {}, ['--rules-said', 'no']);
  const waiting = assess(ctx, 'fake:assess-simple', {}, ['--rules-said', 'suggest']);
  assert.equal(one.status, 0);
  assert.equal(two.status, 0);
  assert.equal(waiting.status, 0);
  // Each flag appears once: a repeated flag parses as an array, which would refuse for that reason instead.
  const outcome = (id, over = {}) => ['assess-outcome', '--task', id, ...Object.entries({
    'files-changed': '2', 'gate-failures': '0', consensus: 'declined', ...over,
  }).flatMap(([key, value]) => [`--${key}`, value])];
  for (const argv of [
    outcome(one.json.id, { 'files-changed': '-1' }),
    outcome(one.json.id, { 'files-changed': '1.5' }),
    outcome(one.json.id, { consensus: 'maybe' }),
    outcome(one.json.id, { 'owner-view': 'wrong' }),
  ]) {
    const before = taskBytes(ctx, one.json.id);
    const got = run(argv, ctx);
    assert.equal(got.json.code, 'BAD_ARGS', argv.join(' '));
    assert.equal(taskBytes(ctx, one.json.id), before);
  }
  const recordedOne = run(outcome(one.json.id, { 'gate-failures': '2', 'owner-view': 'too-low' }), ctx);
  const recordedTwo = run(outcome(two.json.id, { 'owner-view': 'too-high' }), ctx);
  assert.equal(recordedOne.json.state, 'recorded');
  assert.equal(recordedTwo.json.state, 'recorded');
  assert.equal(loadTask(ctx, one.json.id).outcomeRecord.gateFailures, 2);
  assert.equal(run(outcome(one.json.id), ctx).json.code, 'WRONG_STATE');
  const normal = run(['assess-report'], ctx);
  const all = run(['assess-report', '--all'], ctx);
  assert.equal(normal.json.totals.assessed, 0);
  assert.deepEqual(all.json.totals, { assessed: 3, recorded: 2, waiting: 1, failed: 0 });
  assert.deepEqual(all.json.ratings, { simple: 2, moderate: 0, complex: 1 });
  assert.equal(all.json.agreement.assessorOnly, 1);
  assert.equal(all.json.agreement.fixedRulesOnly, 1);
  assert.equal(all.json.misses, 1);
  assert.equal(all.json.overCalls, 1);
  assert.equal(all.json.trial.recorded, 2);
  assert.equal(all.json.perAssessor['fake:assess-simple'].calls, 2);
  assert.ok(fs.existsSync(path.join(ctx.ledger, 'assessment-trial.md')));
});

test('assessors never chair, sit, or enter pair ranking', () => {
  for (const mode of ['full', 'advise']) for (const id of SEATS.assessorOrder) for (const option of ['chair', 'cochair']) {
    const ctx = setup();
    const argv = ['start', '--mode', mode, '--chair', 'fake:agree', '--cochair', 'fake:done', '--project', ctx.project, '--goal', ctx.goal];
    argv[argv.indexOf(`--${option}`) + 1] = id;
    assertRefusal(ctx, argv, 'BAD_ARGS');
  }
  for (const id of SEATS.assessorOrder) {
    const ctx = setup();
    assertRefusal(ctx, ['consult', '--project', ctx.project, '--brief', brief(ctx), '--seats', id], 'NO_SEAT');
  }
  const pair = pickPair(SEATS, () => true);
  const ranked = rankPartners(SEATS, () => true, { id: 'gpt-6.1-sol', ...SEATS.seats['gpt-6.1-sol'] });
  assert.ok([...pair, ...ranked].every((id) => !SEATS.assessorOrder.includes(id)));
});

test('other flows refuse assess tasks before changing ledger bytes; list and status understand states', () => {
  const ctx = setup();
  const assessed = assess(ctx);
  const recorded = assess(ctx);
  const failed = assess(ctx, 'fake:missing');
  run(['assess-outcome', '--task', recorded.json.id, '--files-changed', '1', '--gate-failures', '0', '--consensus', 'not-suggested'], ctx);
  const seal = path.join(ctx.project, 'seal.json');
  writeLf(seal, JSON.stringify({ phase: 'finish-line', verdict: 'AGREE' }));
  const commands = [
    ['seal', '--task', assessed.json.id, '--phase', 'finish-line', '--file', seal],
    ['ask', '--task', assessed.json.id, '--phase', 'finish-line'],
    ['job', '--task', assessed.json.id, '--lane', 'test'],
    ['consult', '--task', assessed.json.id],
    ['assess', '--task', recorded.json.id], ['assess-outcome', '--task', recorded.json.id],
    ['assess', '--task', failed.json.id], ['assess-outcome', '--task', failed.json.id],
    ['close', '--task', recorded.json.id, '--outcome', 'abandoned'],
    ['close', '--task', failed.json.id, '--outcome', 'abandoned'],
  ];
  for (const argv of commands) {
    const id = argv[argv.indexOf('--task') + 1];
    const before = taskBytes(ctx, id);
    const got = run(argv, ctx);
    assert.equal(got.json.code, 'WRONG_STATE', `${argv.join(' ')}: ${got.stdout}`);
    assert.equal(taskBytes(ctx, id), before);
  }
  const listed = run(['list', '--open'], ctx);
  assert.deepEqual(listed.json.tasks.map((row) => row.id), [assessed.json.id]);
  const status = run(['status', '--task', assessed.json.id], ctx);
  assert.match(status.json.next, /assess-outcome/);
  const full = startFull(ctx, 'fake:agree', 'fake:done');
  assert.equal(run(['assess-outcome', '--task', full.json.id, '--files-changed', '1', '--gate-failures', '0', '--consensus', 'used'], ctx).json.code, 'WRONG_STATE');
});

test('selection, codex flags and data remain separate', () => {
  const facts = { tools: { codex: { found: true, version: 'codex 0.158.0' }, 'claude-code': { found: true, version: '2.1.283' } }, local: {} };
  assert.match(assessorEligibility(SEATS, 'missing', facts).reason, /unknown assessor/);
  assert.match(assessorEligibility(SEATS, 'gpt-6-luna', { tools: {}, local: {} }).reason, /not found/);
  const old = { ...SEATS, assessors: { ...SEATS.assessors, 'gpt-6-luna': { ...SEATS.assessors['gpt-6-luna'], minVersion: '9.0.0' } } };
  assert.match(assessorEligibility(old, 'gpt-6-luna', facts).reason, /or later/);
  assert.match(assessorEligibility(SEATS, 'gpt-6-luna', { ...facts, local: { assessors: { 'gpt-6-luna': { unavailable: 'blocked' } } } }).reason, /not usable/);
  assert.equal(assessorEligibility(SEATS, 'gpt-6-luna', facts).usable, true);
  // Sonnet 5.5 needs Claude Code 2.1.284; older builds fall through to Sonnet 4.6.
  assert.match(assessorEligibility(SEATS, 'claude-sonnet-5.5', facts).reason, /2\.1\.284 or later/);
  assert.equal(assessorEligibility(SEATS, 'claude-sonnet-4.6', facts).usable, true);
  const newer = { ...facts, tools: { ...facts.tools, 'claude-code': { found: true, version: '2.1.284' } } };
  assert.equal(assessorEligibility(SEATS, 'claude-sonnet-5.5', newer).usable, true);
  assert.deepEqual(SEATS.assessorOrder, ['gpt-6-luna', 'claude-sonnet-5.5', 'claude-sonnet-4.6']);
  assert.equal(pickAssessor(SEATS, (id) => id !== 'gpt-6-luna'), 'claude-sonnet-5.5');
  assert.equal(pickAssessor(SEATS, (id) => id === 'claude-sonnet-4.6'), 'claude-sonnet-4.6');
  assert.equal(pickAssessor(SEATS, () => false), null);
  assert.deepEqual(SEATS.assessorOrder, Object.keys(SEATS.assessors));
  for (const id of SEATS.assessorOrder) {
    assert.ok(!SEATS.seats[id]);
    assert.ok(!SEATS.preferenceOrder.includes(id));
    assert.ok(!('seatEligible' in SEATS.assessors[id]));
    assert.ok(!('chairEligible' in SEATS.assessors[id]));
    assert.equal(SEATS.assessors[id].strictFlags, true, id);
  }
  for (const entry of [...Object.values(SEATS.seats), ...Object.values(SEATS.assessors)]) {
    if (entry.route === 'codex') assert.equal(entry.serviceTier, 'default');
  }
  const seat = { model: 'gpt-6-luna', effort: 'high', serviceTier: 'default' };
  const opts = { seat, projectDir: 'project', schemaPath: 'schema' };
  for (const resume of [undefined, 'thread']) {
    const args = buildCodexArgs({ ...opts, resume }, 'final');
    assert.ok(args.includes('service_tier=default'));
    assert.equal(args[args.indexOf('service_tier=default') - 1], '-c');
    assert.ok(!buildCodexArgs({ ...opts, seat: { ...seat, serviceTier: undefined }, resume }, 'final').some((v) => v.startsWith('service_tier=')));
  }
});

function privateRuntime() {
  const dir = tmp('crt-assess-');
  for (const name of ['lib', 'prompts', 'schemas']) fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
  for (const name of ['referee.mjs', 'seats.json', 'limits.json', 'VERSION']) fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
  return dir;
}

function runtimeRun(rt, argv, ctx, env = {}) {
  const clean = { ...process.env };
  delete clean.CONSENSUS_SEAT;
  delete clean.DELEGATION_DISPATCHED;
  if (Object.prototype.hasOwnProperty.call(env, 'PATH')) {
    for (const key of Object.keys(clean)) if (key.toUpperCase() === 'PATH') delete clean[key];
  }
  const r = spawnSync(process.execPath, [path.join(rt, 'referee.mjs'), ...argv], {
    encoding: 'utf8', env: { ...clean, CONSENSUS_LEDGER: ctx.ledger, ...env }, timeout: 60000, windowsHide: true,
  });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim()); } catch { /* */ }
  return { status: r.status, json, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function stubCli(dir, name, claudeVersion = '2.1.283') {
  const script = path.join(dir, `${name}.mjs`);
  writeLf(script, `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('${name === 'codex' ? 'codex-cli 0.158.0' : `${claudeVersion} (Claude Code)`}'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
const log = process.env.STUB_${name.toUpperCase()}_LOG;
const prior = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
const scenario = process.env.STUB_SCENARIO || '';
if (scenario === 'codex-fail' && '${name}' === 'codex') process.exit(1);
if ('${name}' === 'claude') {
  const flag = scenario.startsWith('reject-') ? '--' + scenario.slice(7) : null;
  if (flag && args.includes(flag)) { console.error("error: unknown option '" + flag + "'"); process.exit(1); }
}
if (scenario === 'malformed-first' && prior === 0) { console.log('not json'); process.exit(0); }
const assess = { phase:'assess', rating:'simple', suggest_consensus:false, suggested_tier:'developer', confidence:'high', danger_hits:[], expected_files:[], unknowns:[], architectural:false, reasons:['bounded'], files_read:['brief.md'], summary:'Bounded task.' };
const consult = { phase:'consult', assessment:'workable', risks:[], recommendations:[], questions_for_owner:[], summary:'Proceed.' };
// Answer the schema the caller sent, so a seat gets a consult answer and an assessor an assessment.
const at = args.indexOf('--json-schema');
const outAt = args.indexOf('--output-schema');
const schema = at !== -1 ? args[at + 1] : (outAt !== -1 && fs.existsSync(args[outAt + 1]) ? fs.readFileSync(args[outAt + 1], 'utf8') : '');
const value = /"consult"/.test(schema || '') ? consult : assess;
if ('${name}' === 'codex') {
  const oAt = args.indexOf('-o');
  if (oAt !== -1) fs.writeFileSync(args[oAt + 1], JSON.stringify(value));
} else console.log(JSON.stringify({ type:'result', is_error:false, structured_output:value }));
`);
  if (process.platform === 'win32') {
    const wrapper = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
    return wrapper;
  }
  const wrapper = path.join(dir, name);
  writeLf(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

function stubRuntime({ codex = true, claude = true, claudeVersion } = {}) {
  const rt = privateRuntime();
  const bin = path.join(rt, 'bin');
  fs.mkdirSync(bin);
  const local = { binaries: {} };
  if (codex) local.binaries.codex = stubCli(bin, 'codex');
  if (claude) local.binaries.claude = stubCli(bin, 'claude', claudeVersion);
  writeLf(path.join(rt, 'local.json'), JSON.stringify(local));
  const logs = { codex: path.join(rt, 'codex.log'), claude: path.join(rt, 'claude.log') };
  const env = {
    STUB_CODEX_LOG: logs.codex, STUB_CLAUDE_LOG: logs.claude,
    PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '',
  };
  return { rt, logs, env };
}

function logArgs(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('stub CLIs select Luna, then Sonnet fallback, and neither available refuses', () => {
  const sonnetModel = { 'claude-sonnet-5.5': 'claude-sonnet-5-5', 'claude-sonnet-4.6': 'claude-sonnet-4-6' };
  for (const [available, expected] of [
    [{ codex: true, claude: true }, 'gpt-6-luna'],
    [{ codex: false, claude: true, claudeVersion: '2.1.284' }, 'claude-sonnet-5.5'],
    [{ codex: false, claude: true }, 'claude-sonnet-4.6'],
    [{ codex: false, claude: false }, null],
  ]) {
    const ctx = setup();
    const stub = stubRuntime(available);
    const got = runtimeRun(stub.rt, ['assess', '--project', ctx.project, '--brief', brief(ctx)], ctx, stub.env);
    if (!expected) {
      assert.equal(got.json.code, 'ASSESSOR_UNAVAILABLE');
      assert.equal(indexBytes(ctx), null);
      continue;
    }
    assert.equal(got.status, 0, got.stdout + got.stderr);
    assert.equal(got.json.assessor, expected);
    assert.equal(loadTask(ctx, got.json.id).state, 'assessed');
    const codexCalls = logArgs(stub.logs.codex);
    const claudeCalls = logArgs(stub.logs.claude);
    if (expected === 'gpt-6-luna') {
      assert.equal(codexCalls.length, 1);
      assert.equal(claudeCalls.length, 0);
      for (const token of ['exec', '--json', '--output-schema', '-s', 'read-only', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=high', 'service_tier=default']) {
        assert.ok(codexCalls[0].includes(token), token);
      }
    } else {
      assert.equal(codexCalls.length, 0);
      assert.equal(claudeCalls.length, 1);
      for (const token of ['--model', sonnetModel[expected], '--effort', 'high', '--tools', 'Read,Glob,Grep', '--restricted', '--strict-mcp-config', '--mcp-config', '--json-schema', '--max-budget-usd', '5']) {
        assert.ok(claudeCalls[0].includes(token), token);
      }
    }
  }
  // Naming the Sonnet 5.5 assessor on a Claude Code older than 2.1.284 is refused before any call.
  const ctx = setup();
  const old = stubRuntime({ codex: false, claude: true });
  const named = runtimeRun(old.rt, ['assess', '--project', ctx.project, '--brief', brief(ctx), '--assessor', 'claude-sonnet-5.5'], ctx, old.env);
  assert.equal(named.json && named.json.code, 'ASSESSOR_UNAVAILABLE', named.stdout + named.stderr);
  assert.match(named.stdout + named.stderr, /2\.1\.284 or later/);
  assert.equal(logArgs(old.logs.claude).length, 0);
});

test('an existing open assessment is refused when consensus is off, in the foreground and detached, before any call', () => {
  const ctx = setup();
  const rt = privateRuntime();
  const first = runtimeRun(rt, ['assess', '--project', ctx.project, '--brief', brief(ctx), '--assessor', 'fake:assess-simple'], ctx);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const id = first.json.id;
  const taskDir = path.join(ctx.ledger, 'tasks', id);
  const file = path.join(taskDir, 'ledger.json');
  // Turn it back into an open, never-called assessment, as a crashed detached child leaves one.
  const open = JSON.parse(fs.readFileSync(file, 'utf8'));
  open.state = 'open';
  delete open.assessment;
  open.counters.seatCalls = 0;
  fs.writeFileSync(file, `${JSON.stringify(open, null, 2)}\n`);
  fs.rmSync(path.join(taskDir, 'calls'), { recursive: true, force: true });
  writeLf(path.join(rt, 'local.json'), JSON.stringify({ disabled: 'switched off for this test' }));
  const before = fs.readFileSync(file, 'utf8');
  for (const extra of [[], ['--detach']]) {
    const got = runtimeRun(rt, ['assess', '--task', id, ...extra], ctx);
    assert.equal(got.json && got.json.code, 'CONSENSUS_DISABLED', got.stdout + got.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(taskDir, 'calls', '1')));
    assert.ok(!fs.existsSync(path.join(taskDir, 'pending.json')));
    assert.ok(!fs.existsSync(path.join(taskDir, 'detach')));
  }
  // An assessor that became unusable here is refused the same way.
  writeLf(path.join(rt, 'local.json'), JSON.stringify({ assessors: { 'fake:assess-simple': { unavailable: 'declared' } } }));
  const unusable = runtimeRun(rt, ['assess', '--task', id], ctx);
  assert.equal(unusable.json && unusable.json.code, 'ASSESSOR_UNAVAILABLE', unusable.stdout + unusable.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  // With consensus on and the assessor usable, the same open task runs exactly once.
  fs.rmSync(path.join(rt, 'local.json'));
  const again = runtimeRun(rt, ['assess', '--task', id], ctx);
  assert.equal(again.json && again.json.state, 'assessed', again.stdout + again.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).counters.seatCalls, 1);
});

test('doctor --human lists each assessor, the one in use and the trial before the final best-pair line', () => {
  const ctx = setup();
  for (const [available, inUse, lunaState, sonnet55State] of [
    [{ codex: true, claude: true }, 'assessor: gpt-6-luna (fallback claude-sonnet-4.6)', 'assessor gpt-6-luna: available', 'assessor claude-sonnet-5.5: unavailable'],
    [{ codex: false, claude: true }, 'assessor: claude-sonnet-4.6 (fallback none)', 'assessor gpt-6-luna: unavailable', 'assessor claude-sonnet-5.5: unavailable'],
    [{ codex: true, claude: true, claudeVersion: '2.1.295' }, 'assessor: gpt-6-luna (fallback claude-sonnet-5.5)', 'assessor gpt-6-luna: available', 'assessor claude-sonnet-5.5: available'],
  ]) {
    const stub = stubRuntime(available);
    const got = runtimeRun(stub.rt, ['doctor', '--human'], ctx, stub.env);
    const lines = got.stdout.trim().split(/\r?\n/);
    assert.ok(lines.some((line) => line.startsWith(lunaState)), got.stdout);
    assert.ok(lines.some((line) => line.startsWith(sonnet55State)), got.stdout);
    assert.ok(lines.some((line) => line.startsWith('assessor claude-sonnet-4.6: available')), got.stdout);
    assert.ok(lines.includes(inUse), got.stdout);
    assert.ok(lines.includes('task sizing trial: 0 of 20 outcomes recorded'), got.stdout);
    assert.ok(lines[lines.length - 1].startsWith('best pair:'), got.stdout);
    assert.equal(logArgs(stub.logs.codex).length, 0);
    assert.equal(logArgs(stub.logs.claude).length, 0);
  }
});

test('strict assessor flags never drop or relaunch; seats retain the legacy retry', () => {
  for (const flag of ['effort', 'strict-mcp-config', 'json-schema']) {
    const ctx = setup();
    const stub = stubRuntime({ codex: false, claude: true });
    const got = runtimeRun(stub.rt, ['assess', '--project', ctx.project, '--brief', brief(ctx)], ctx,
      { ...stub.env, STUB_SCENARIO: `reject-${flag}` });
    assert.equal(got.json.code, 'SEAT_UNAVAILABLE', got.stdout + got.stderr);
    assert.equal(got.json.state, 'failed');
    assert.equal(logArgs(stub.logs.claude).length, 1);
    assert.equal(logArgs(stub.logs.codex).length, 0);
  }
  const ctx = setup();
  const stub = stubRuntime({ codex: false, claude: true });
  const got = runtimeRun(stub.rt, ['consult', '--project', ctx.project, '--brief', brief(ctx), '--seats', 'claude-opus-5.5'], ctx,
    { ...stub.env, STUB_SCENARIO: 'reject-effort' });
  assert.equal(got.status, 0, got.stdout + got.stderr);
  const calls = logArgs(stub.logs.claude);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('--effort'));
  assert.ok(!calls[1].includes('--effort'));
});

test('malformed Claude output retries once with full flags; Luna failure never falls back', () => {
  const ctx = setup();
  const stub = stubRuntime({ codex: false, claude: true });
  const good = runtimeRun(stub.rt, ['assess', '--project', ctx.project, '--brief', brief(ctx)], ctx,
    { ...stub.env, STUB_SCENARIO: 'malformed-first' });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.equal(logArgs(stub.logs.claude).length, 2);
  assert.equal(loadTask(ctx, good.json.id).counters.seatCalls, 2);
  for (const call of logArgs(stub.logs.claude)) {
    for (const flag of ['--effort', '--strict-mcp-config', '--json-schema']) assert.ok(call.includes(flag));
  }
  const failCtx = setup();
  const both = stubRuntime();
  const failed = runtimeRun(both.rt, ['assess', '--project', failCtx.project, '--brief', brief(failCtx)], failCtx,
    { ...both.env, STUB_SCENARIO: 'codex-fail' });
  assert.equal(failed.json.code, 'SEAT_UNAVAILABLE');
  assert.equal(logArgs(both.logs.codex).length, 1);
  assert.equal(logArgs(both.logs.claude).length, 0);
});

test('trial threshold reports 19, 20 and 21 without changing settings or behavior', () => {
  const ctx = setup();
  const rt = privateRuntime();
  const seatsBefore = fs.readFileSync(path.join(rt, 'seats.json'));
  const bestBefore = runtimeRun(rt, ['doctor'], ctx).json.bestPair;
  const index = { tasks: [] };
  for (let n = 1; n <= 21; n++) {
    const id = `trial-${n}`;
    const ledger = {
      id, mode: 'assess', state: 'recorded', test: false, chair: 'gpt-6-luna', cochair: null,
      project: ctx.project, startedAt: '2026-09-28T00:00:00.000Z', counters: { seatCalls: 1 },
      fixedRules: { said: 'no', triggers: null },
      assessment: { assessor: 'gpt-6-luna', model: 'gpt-6-luna', rating: 'simple', suggestConsensus: false, durationMs: 1 },
      outcomeRecord: { consensus: 'not-suggested', filesChanged: 1, gateFailures: 0, ownerView: 'right' },
    };
    writeLf(path.join(ctx.ledger, 'tasks', id, 'ledger.json'), JSON.stringify(ledger));
    index.tasks.push({ id, mode: 'assess', state: 'recorded' });
    writeLf(path.join(ctx.ledger, 'index.json'), JSON.stringify(index));
    if (n >= 19) {
      const result = runtimeRun(rt, ['assess-report'], ctx);
      assert.equal(result.json.trial.recorded, n);
      assert.equal(result.json.trial.trialTasks, 20);
      assert.equal(result.json.trial.trialComplete, n >= 20);
      assert.match(result.json.note, /The owner decides whether/);
    }
  }
  assert.deepEqual(fs.readFileSync(path.join(rt, 'seats.json')), seatsBefore);
  const after = runtimeRun(rt, ['assess', '--project', ctx.project, '--brief', brief(ctx), '--assessor', 'fake:assess-simple'], ctx);
  assert.equal(after.json.trial, true);
  assert.equal(after.json.note, NOTE);
  assert.deepEqual(runtimeRun(rt, ['doctor'], ctx).json.bestPair, bestBefore);
});

test('direct fake flow exercises assessment, outcome, report and state without child processes', async () => {
  const prior = process.env.CONSENSUS_LEDGER;
  const priorSeat = process.env.CONSENSUS_SEAT;
  const priorDispatched = process.env.DELEGATION_DISPATCHED;
  const ctx = setup();
  process.env.CONSENSUS_LEDGER = ctx.ledger;
  delete process.env.CONSENSUS_SEAT;
  delete process.env.DELEGATION_DISPATCHED;
  try {
    const simple = await cmdAssess({ project: ctx.project, brief: brief(ctx), assessor: 'fake:assess-simple', 'rules-said': 'no' });
    assert.equal(simple.state, 'assessed');
    assert.equal(simple.suggestConsensus, false);
    assert.equal(loadTask(ctx, simple.id).counters.seatCalls, 1);
    assert.match(cmdStatus({ task: simple.id }).next, /assess-outcome/);
    const complex = await cmdAssess({ project: ctx.project, brief: brief(ctx), assessor: 'fake:assess-inconsistent' });
    assert.equal(complex.inconsistent, true);
    const failed = await cmdAssess({ project: ctx.project, brief: brief(ctx), assessor: 'fake:garbage' });
    assert.equal(failed.code, 'INVALID_VERDICT');
    assert.equal(loadTask(ctx, failed.id).counters.seatCalls, 2);
    const outcome = cmdAssessOutcome({ task: simple.id, 'files-changed': '2', 'gate-failures': '2', consensus: 'declined', 'owner-view': 'too-low' });
    assert.equal(outcome.state, 'recorded');
    assert.deepEqual(cmdList({ open: true }).tasks.map((row) => row.id), [complex.id]);
    const report = cmdAssessReport({ all: true });
    assert.deepEqual(report.totals, { assessed: 2, recorded: 1, waiting: 1, failed: 1 });
    assert.equal(report.misses, 1);
  } finally {
    if (prior === undefined) delete process.env.CONSENSUS_LEDGER;
    else process.env.CONSENSUS_LEDGER = prior;
    if (priorSeat === undefined) delete process.env.CONSENSUS_SEAT;
    else process.env.CONSENSUS_SEAT = priorSeat;
    if (priorDispatched === undefined) delete process.env.DELEGATION_DISPATCHED;
    else process.env.DELEGATION_DISPATCHED = priorDispatched;
  }
});
