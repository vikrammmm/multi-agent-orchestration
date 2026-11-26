import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmp, writeLf } from './helpers.mjs';

// Eligibility, grading and banners against a private referee. Fake CLIs answer --version only.
// No seat is launched. Each scenario has its own runtime and ledger.

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_IDS = [
  'gpt-6.2-sol', 'gpt-6.1-sol', 'claude-opus-5.5', 'grok-4.7', 'claude-opus',
  'gpt-6-sol', 'claude-sonnet-5', 'grok-4.6', 'gpt-5.6-sol',
];

function fakeCli(dir, name, versionLine) {
  if (process.platform === 'win32') {
    const file = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(file, `@echo off\r\necho ${versionLine}\r\n`, 'utf8');
    return file;
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho '${versionLine}'\n`, 'utf8');
  fs.chmodSync(file, 0o755);
  return file;
}

function marks(unavailable = [], unverified = {}) {
  const seats = {};
  for (const id of unavailable) seats[id] = { unavailable: 'marked for test' };
  for (const [id, reason] of Object.entries(unverified)) {
    seats[id] = { ...(seats[id] || {}), unverified: reason };
  }
  return seats;
}

function runtimeWith({ claudeVersion, seatMarks = {}, disabled = null }) {
  const rt = tmp('crt-');
  const ledger = tmp('cled-');
  const project = tmp('cproj-');
  const goal = path.join(project, 'goal.md');
  const brief = path.join(project, 'brief.md');
  writeLf(goal, 'Ship a tiny, testable feature.\n');
  writeLf(brief, 'Advise on the feature.\n');
  for (const name of ['referee.mjs', 'limits.json', 'VERSION', 'seats.json']) {
    fs.copyFileSync(path.join(SOURCE, name), path.join(rt, name));
  }
  fs.cpSync(path.join(SOURCE, 'lib'), path.join(rt, 'lib'), { recursive: true });
  fs.cpSync(path.join(SOURCE, 'prompts'), path.join(rt, 'prompts'), { recursive: true });
  fs.cpSync(path.join(SOURCE, 'schemas'), path.join(rt, 'schemas'), { recursive: true });
  const bin = path.join(rt, 'bin');
  fs.mkdirSync(bin);
  const local = {
    binaries: {
      claude: fakeCli(bin, 'claude', `${claudeVersion} (Claude Code)`),
      codex: fakeCli(bin, 'codex', 'codex-cli 0.155.0'),
      'cursor-agent': fakeCli(bin, 'cursor-agent', 'cursor-agent 1.0.0'),
    },
  };
  if (Object.keys(seatMarks).length) local.seats = seatMarks;
  if (disabled != null) local.disabled = disabled;
  writeLf(path.join(rt, 'local.json'), `${JSON.stringify(local, null, 2)}\n`);
  return { rt, ledger, project, goal, brief, referee: path.join(rt, 'referee.mjs') };
}

function runRef(ctx, argv) {
  const clean = { ...process.env };
  delete clean.CONSENSUS_SEAT;
  delete clean.DELEGATION_DISPATCHED;
  delete clean.CONSENSUS_TASK_ID;
  const r = spawnSync(process.execPath, [ctx.referee, ...argv], {
    encoding: 'utf8',
    env: { ...clean, CONSENSUS_LEDGER: ctx.ledger },
    timeout: 60000,
    windowsHide: true,
  });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim()); } catch { json = null; }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

function start(ctx, extra) {
  return runRef(ctx, [
    'start', '--mode', 'full', '--project', ctx.project, '--goal', ctx.goal, ...extra,
  ]);
}

function noCalls(ledger) {
  const tasks = path.join(ledger, 'tasks');
  if (!fs.existsSync(tasks)) return true;
  for (const id of fs.readdirSync(tasks)) {
    if (fs.existsSync(path.join(tasks, id, 'calls'))) return false;
  }
  return true;
}

test('a Claude chair uses the standard-grade GPT-6.1 reserve when 6.2 is unavailable', () => {
  const ctx = runtimeWith({ claudeVersion: '2.1.280', seatMarks: marks(['gpt-6.2-sol', 'grok-4.7']) });
  const started = start(ctx, ['--chair', 'claude-opus-5.5']);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.equal(started.json.cochair, 'gpt-6.1-sol');
  assert.equal(started.json.grade, 'standard');
});

test('all usable: Opus 5.5 pairs with GPT-6.2 Sol at standard grade', () => {
  const ctx = runtimeWith({ claudeVersion: '2.1.280' });
  const started = start(ctx, ['--chair', 'claude-opus-5.5']);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.equal(started.json.cochair, 'gpt-6.2-sol');
  assert.equal(started.json.grade, 'standard');
  assert.equal(started.json.gradeNote, undefined);
  const doc = runRef(ctx, ['doctor']);
  assert.equal(doc.status, 0, doc.stdout + doc.stderr);
  assert.deepEqual(doc.json.bestPair.seats, ['gpt-6.2-sol', 'claude-opus-5.5']);
  assert.equal(doc.json.bestPair.grade, 'standard');
});

test('Claude only: single-vendor pair, unverified co-chair stored on the ledger', () => {
  const ctx = runtimeWith({
    claudeVersion: '2.1.280',
    seatMarks: marks(
      ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'grok-4.7', 'grok-4.6'],
      { 'claude-opus': 'Claude plan access is assumed' },
    ),
  });
  const started = start(ctx, ['--chair', 'claude-opus-5.5']);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.equal(started.json.cochair, 'claude-opus');
  assert.equal(started.json.grade, 'single-vendor');
  assert.match(started.json.gradeNote, /single vendor/);
  assert.match(started.json.gradeNote, /same model family/);
  assert.ok(started.json.unverified.some((u) => u.seat === 'claude-opus'));
  const ledger = JSON.parse(fs.readFileSync(path.join(ctx.ledger, 'tasks', started.json.id, 'ledger.json'), 'utf8'));
  assert.equal(ledger.grade.level, 'single-vendor');
  assert.match(ledger.grade.note, /single vendor/);
  assert.ok(ledger.unverified.some((u) => u.seat === 'claude-opus'));
});

test('Claude Code 2.1.200: Claude seats too old, Sol pairs with Grok 4.6 below CTO', () => {
  const ctx = runtimeWith({
    claudeVersion: '2.1.200',
    seatMarks: marks(['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-5.6-sol', 'grok-4.7']),
  });
  const doc = runRef(ctx, ['doctor']);
  assert.equal(doc.status, 0, doc.stdout + doc.stderr);
  for (const id of ['claude-opus-5.5', 'claude-opus', 'claude-sonnet-5']) {
    const row = doc.json.seats.find((s) => s.id === id);
    assert.equal(row.available, false, id);
    assert.match(row.reason, /2\.1\.248 or later is required/);
  }
  const started = start(ctx, ['--chair', 'gpt-6-sol']);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.equal(started.json.cochair, 'grok-4.6');
  assert.equal(started.json.grade, 'below-cto');
  assert.deepEqual(doc.json.bestPair.seats, ['gpt-6-sol', 'grok-4.6']);
  assert.equal(doc.json.bestPair.grade, 'below-cto');
});

test('Claude Code 2.1.279: Opus 5.5 is too old, Opus 5 fills in, and Grok 4.7 follows', () => {
  const ctx = runtimeWith({ claudeVersion: '2.1.279' });
  const doc = runRef(ctx, ['doctor']);
  const opus = doc.json.seats.find((s) => s.id === 'claude-opus-5.5');
  assert.equal(opus.available, false);
  assert.match(opus.reason, /2\.1\.280 or later is required/);
  for (const id of ALL_IDS) {
    if (id === 'claude-opus-5.5') continue;
    assert.equal(doc.json.seats.find((s) => s.id === id).available, true, id);
  }
  const named = start(ctx, ['--chair', 'gpt-6.2-sol', '--cochair', 'claude-opus-5.5']);
  assert.equal(named.status, 2, named.stdout + named.stderr);
  assert.equal(named.json.code, 'SEAT_TOO_OLD');
  const auto = start(ctx, ['--chair', 'gpt-6.2-sol']);
  assert.equal(auto.status, 0, auto.stdout + auto.stderr);
  assert.equal(auto.json.cochair, 'claude-opus');
  assert.equal(auto.json.grade, 'standard');
  writeLocal(ctx, { seats: { 'claude-opus': { unavailable: 'marked for test' }, 'gpt-6.1-sol': { unavailable: 'marked for test' } } });
  const fallback = start(ctx, ['--chair', 'gpt-6.2-sol']);
  assert.equal(fallback.status, 0, fallback.stdout + fallback.stderr);
  assert.equal(fallback.json.cochair, 'grok-4.7');
  assert.equal(fallback.json.grade, 'standard');
});

test('explicit co-chair: not here, same vendor allowed, same model refused', () => {
  const ctx = runtimeWith({
    claudeVersion: '2.1.280',
    seatMarks: marks(['gpt-6.2-sol']),
  });
  const missing = start(ctx, ['--chair', 'claude-opus-5.5', '--cochair', 'gpt-6.2-sol']);
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.equal(missing.json.code, 'SEAT_NOT_HERE');
  const sameVendor = start(ctx, ['--chair', 'claude-opus-5.5', '--cochair', 'claude-opus']);
  assert.equal(sameVendor.status, 0, sameVendor.stdout + sameVendor.stderr);
  assert.equal(sameVendor.json.cochair, 'claude-opus');
  assert.equal(sameVendor.json.grade, 'single-vendor');
  const same = start(ctx, ['--chair', 'claude-opus-5.5', '--cochair', 'claude-opus-5.5']);
  assert.equal(same.status, 2, same.stdout + same.stderr);
  assert.equal(same.json.code, 'SAME_MODEL');
});

test('consult both with one model refuses before any seat call; duplicate ids are the same model', () => {
  const ctx = runtimeWith({
    claudeVersion: '2.1.280',
    seatMarks: marks(ALL_IDS.filter((id) => id !== 'gpt-6.2-sol')),
  });
  const both = runRef(ctx, ['consult', '--project', ctx.project, '--brief', ctx.brief, '--seats', 'both']);
  assert.equal(both.status, 2, both.stdout + both.stderr);
  assert.equal(both.json.code, 'SEAT_UNAVAILABLE');
  assert.equal(noCalls(ctx.ledger), true);
  const dup = runRef(ctx, ['consult', '--project', ctx.project, '--brief', ctx.brief, '--seats', 'gpt-6.2-sol,gpt-6.2-sol']);
  assert.equal(dup.status, 2, dup.stdout + dup.stderr);
  assert.equal(dup.json.code, 'SAME_MODEL');
  assert.equal(noCalls(ctx.ledger), true);
});

test('a disabled machine is off and start refuses before a seat', () => {
  const ctx = runtimeWith({ claudeVersion: '2.1.280', disabled: 'machine check failed: test' });
  const doc = runRef(ctx, ['doctor']);
  assert.equal(doc.status, 0, doc.stdout + doc.stderr);
  assert.equal(doc.json.disabled, 'machine check failed: test');
  assert.equal(doc.json.bestPair.grade, 'off');
  assert.equal(doc.json.bestPair.note, 'machine check failed: test');
  assert.deepEqual(doc.json.bestPair.seats, []);
  const started = start(ctx, ['--chair', 'claude-opus-5.5']);
  assert.equal(started.status, 2, started.stdout + started.stderr);
  assert.equal(started.json.code, 'CONSENSUS_DISABLED');
  assert.match(started.json.message, /machine check failed: test/);
  assert.equal(noCalls(ctx.ledger), true);
});

test('grade banner leads the split decision and is empty for a standard or ungraded ledger', async () => {
  const ctx = runtimeWith({
    claudeVersion: '2.1.280',
    seatMarks: marks(
      ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'grok-4.7', 'grok-4.6'],
      { 'claude-opus': 'Claude plan access is assumed' },
    ),
  });
  const started = start(ctx, ['--chair', 'claude-opus-5.5']);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  process.env.CONSENSUS_LEDGER = ctx.ledger;
  const report = await import(pathToFileURL(path.join(ctx.rt, 'lib', 'report.mjs')).href);
  const ledger = JSON.parse(fs.readFileSync(path.join(ctx.ledger, 'tasks', started.json.id, 'ledger.json'), 'utf8'));
  const file = report.writeSplitDecision(ledger);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith(ledger.grade.note), text.slice(0, 200));
  assert.match(text, /Not verified on this machine: claude-opus \(Claude plan access is assumed\)/);
  assert.equal(report.gradeBanner({ grade: { level: 'standard', note: '' } }), '');
  assert.equal(report.gradeBanner({}), '');
});

test('two Sol models only: best pair is below CTO', () => {
  const ctx = runtimeWith({
    claudeVersion: '2.1.280',
    seatMarks: marks(ALL_IDS.filter((id) => id !== 'gpt-6-sol' && id !== 'gpt-5.6-sol')),
  });
  const doc = runRef(ctx, ['doctor']);
  assert.equal(doc.status, 0, doc.stdout + doc.stderr);
  assert.deepEqual(doc.json.bestPair.seats, ['gpt-6-sol', 'gpt-5.6-sol']);
  assert.equal(doc.json.bestPair.grade, 'below-cto');
});

function writeLocal(ctx, patch) {
  const file = path.join(ctx.rt, 'local.json');
  const local = JSON.parse(fs.readFileSync(file, 'utf8'));
  writeLf(file, `${JSON.stringify({ ...local, ...patch }, null, 2)}\n`);
}

function ledgerOf(ctx, id) {
  return JSON.parse(fs.readFileSync(path.join(ctx.ledger, 'tasks', id, 'ledger.json'), 'utf8'));
}

function consult(ctx, extra) {
  return runRef(ctx, ['consult', '--brief', ctx.brief, '--stage', 'plan', ...extra]);
}

test('a one-seat consultation is a single reviewer in its answer, ledger and report', () => {
  const ctx = runtimeWith({ claudeVersion: '2.1.280' });
  const got = consult(ctx, ['--project', ctx.project, '--seats', 'fake:consult']);
  assert.equal(got.status, 0, got.stdout + got.stderr);
  assert.equal(got.json.grade, 'single-reviewer');
  assert.match(got.json.gradeNote, /SINGLE REVIEWER/);
  const ledger = ledgerOf(ctx, got.json.id);
  assert.equal(ledger.grade.level, 'single-reviewer');
  const report = fs.readFileSync(got.json.report, 'utf8');
  assert.ok(report.indexOf(ledger.grade.note) >= 0 && report.indexOf(ledger.grade.note) < report.indexOf('# Consultation feedback'), report.slice(0, 400));
});

test('a not-verified seat is returned by consult and written into its ledger and report', () => {
  const ctx = runtimeWith({ claudeVersion: '2.1.280', seatMarks: { 'fake:consult': { unverified: 'plan access unknown' } } });
  const got = consult(ctx, ['--project', ctx.project, '--seats', 'fake:consult']);
  assert.equal(got.status, 0, got.stdout + got.stderr);
  assert.deepEqual(got.json.unverified, [{ seat: 'fake:consult', reason: 'plan access unknown' }]);
  assert.deepEqual(ledgerOf(ctx, got.json.id).unverified, [{ seat: 'fake:consult', reason: 'plan access unknown' }]);
  assert.match(fs.readFileSync(got.json.report, 'utf8'), /Not verified on this machine: fake:consult \(plan access unknown\)/);
});

test('a disabled machine refuses consult before any seat call', () => {
  const ctx = runtimeWith({ claudeVersion: '2.1.280', disabled: 'machine check failed: test' });
  const got = consult(ctx, ['--project', ctx.project, '--seats', 'fake:consult']);
  assert.equal(got.status, 2, got.stdout + got.stderr);
  assert.equal(got.json.code, 'CONSENSUS_DISABLED');
  assert.equal(noCalls(ctx.ledger), true);
});

test('an unreadable local.json switches consensus off instead of clearing its marks', () => {
  const ctx = runtimeWith({ claudeVersion: '2.1.280' });
  writeLf(path.join(ctx.rt, 'local.json'), '{"seats":{"gpt-6.2-sol":{"unavailable":"declared"}}');
  const doc = runRef(ctx, ['doctor']);
  assert.equal(doc.status, 0, doc.stdout + doc.stderr);
  assert.equal(doc.json.bestPair.grade, 'off');
  assert.match(doc.json.disabled, /local\.json could not be read/);
  const started = start(ctx, ['--chair', 'claude-opus-5.5']);
  assert.equal(started.status, 2, started.stdout + started.stderr);
  assert.equal(started.json.code, 'CONSENSUS_DISABLED');
});

test('a reused consultation keeps its seats and records the current grade and not-verified seats', () => {
  const ctx = runtimeWith({ claudeVersion: '2.1.280' });
  const first = consult(ctx, ['--project', ctx.project, '--seats', 'fake:consult']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(first.json.unverified, []);
  writeLocal(ctx, { seats: { 'fake:consult': { unverified: 'marked after the first consultation' } } });
  const other = consult(ctx, ['--task', first.json.id, '--seats', 'fake:other']);
  assert.equal(other.status, 2, other.stdout + other.stderr);
  assert.equal(other.json.code, 'BAD_ARGS');
  const second = consult(ctx, ['--task', first.json.id]);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual(second.json.seats, ['fake:consult']);
  assert.equal(second.json.grade, 'single-reviewer');
  assert.deepEqual(second.json.unverified, [{ seat: 'fake:consult', reason: 'marked after the first consultation' }]);
  const ledger = ledgerOf(ctx, first.json.id);
  assert.equal(ledger.consultations.length, 2);
  assert.deepEqual(ledger.unverified, second.json.unverified);
  assert.match(fs.readFileSync(second.json.report, 'utf8'), /Not verified on this machine: fake:consult \(marked after the first consultation\)/);
});

test('ask refuses before any seat call when the assigned co-chair became unusable', () => {
  const ctx = runtimeWith({ claudeVersion: '2.1.280' });
  const started = start(ctx, ['--chair', 'claude-opus-5.5']);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.equal(started.json.cochair, 'gpt-6.2-sol');
  const id = started.json.id;
  const mat = path.join(ctx.ledger, 'tasks', id, 'materials');
  writeLf(path.join(mat, 'plan.md'), 'Plan.\n');
  writeLf(path.join(mat, 'checklist.md'), '1. The feature exists.\n');
  const seal = path.join(ctx.project, 'seal.json');
  writeLf(seal, '{"phase":"finish-line","verdict":"AGREE","summary":"ok"}\n');
  const sealed = runRef(ctx, ['seal', '--task', id, '--phase', 'finish-line', '--file', seal]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  writeLocal(ctx, { seats: { 'gpt-6.2-sol': { unavailable: 'declared unavailable after start' } } });
  const asked = runRef(ctx, ['ask', '--task', id, '--phase', 'finish-line']);
  assert.equal(asked.status, 2, asked.stdout + asked.stderr);
  assert.equal(asked.json.code, 'SEAT_NOT_HERE');
  assert.match(asked.json.message, /declared unavailable after start/);
  const ledger = ledgerOf(ctx, id);
  assert.equal(ledger.cochair, 'gpt-6.2-sol');
  assert.equal(ledger.counters.seatCalls, 0);
  const calls = path.join(ctx.ledger, 'tasks', id, 'calls');
  assert.equal(fs.existsSync(calls) ? fs.readdirSync(calls).length : 0, 0);
});

test('a reused consultation refuses a pair on a one-seat task and the same seat twice, before any call', () => {
  const ctx = runtimeWith({ claudeVersion: '2.1.280' });
  const one = consult(ctx, ['--project', ctx.project, '--seats', 'fake:consult']);
  assert.equal(one.status, 0, one.stdout + one.stderr);
  const pair = consult(ctx, ['--task', one.json.id, '--seats', 'both']);
  assert.equal(pair.status, 2, pair.stdout + pair.stderr);
  assert.equal(pair.json.code, 'SEAT_UNAVAILABLE');
  assert.equal(ledgerOf(ctx, one.json.id).counters.seatCalls, 1);
  const two = consult(ctx, ['--project', ctx.project, '--seats', 'fake:consult,fake:merge-confirm']);
  assert.equal(two.status, 0, two.stdout + two.stderr);
  const calls = ledgerOf(ctx, two.json.id).counters.seatCalls;
  const dup = consult(ctx, ['--task', two.json.id, '--seats', 'fake:consult,fake:consult']);
  assert.equal(dup.status, 2, dup.stdout + dup.stderr);
  assert.equal(dup.json.code, 'SAME_MODEL');
  assert.equal(ledgerOf(ctx, two.json.id).counters.seatCalls, calls);
});
