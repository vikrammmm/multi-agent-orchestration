import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { installFake, rm, testEnv } from './helpers.mjs';
import * as P from './fixtures.mjs';
import { logFile, logRecord, readRecords, LOG_ARRAY_ENTRIES_MAX, LOG_OBJECT_KEYS_MAX, LOG_RECORD_BYTES_MAX, LOG_STRING_MAX } from '../lib/hooklog.mjs';
import { runHook } from '../hook.mjs';

const hook = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'hook.mjs');
const helpers = { developer: { kind: 'role', engineer: 'b|high' }, 'haiku-helper': { kind: 'legacy', engineer: 'a|max' } };

function run(f, tool, input, env = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [hook, tool, '--fd-guard'], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: testEnv(f.home, env), timeout: 10000 });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
}
const records = (f) => { try { return fs.readFileSync(logFile(f.L), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test('shadow: a refusable request is logged but never blocked, and nothing is printed', () => {
  const f = installFake({ helpers });
  try {
    const r = run(f, 'claude', P.claudeAgent('general-purpose'));
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.equal(r.err, '');
    const log = records(f);
    assert.equal(log.length, 1);
    assert.equal(log[0].decision, 'deny');
    assert.deepEqual(log[0].reasons, ['inherits_boss_model']);
    assert.equal(log[0].mode, 'shadow');
    assert.equal(log[0].tool, 'claude');
    assert.equal(log[0].kind, 'agent_spawn');
  } finally { rm(f.home); }
});

test('the log holds structure only: no prompt text, no script text, no full path', () => {
  const f = installFake({ helpers });
  try {
    run(f, 'claude', P.claudeAgent('general-purpose'));
    run(f, 'claude', P.claudeWorkflow("agent('" + P.SECRET + "')"));
    run(f, 'muse', P.museSpawn());
    run(f, 'codex', P.codexSpawn({ model: 'gpt-6-luna' }));
    const text = fs.readFileSync(logFile(f.L), 'utf8');
    assert.ok(!text.includes(P.SECRET));
    assert.ok(!text.includes('C:/w/project-x'));
    assert.equal(records(f).length, 4);
  } finally { rm(f.home); }
});

test('shadow: an allowed request is logged as allow', () => {
  const f = installFake({ helpers });
  try {
    run(f, 'claude', P.claudeAgent('developer'));
    assert.equal(records(f)[0].decision, 'allow');
  } finally { rm(f.home); }
});

test('shadow: ordinary tools get structure-only records without a delegation decision', () => {
  const f = installFake({ helpers });
  try {
    for (const p of [P.claudeBash(), P.claudeSubagentBash()]) run(f, 'claude', p);
    run(f, 'muse', P.museShell());
    run(f, 'codex', P.codexBash());
    const log = records(f);
    assert.equal(log.length, 4);
    assert.ok(log.every((x) => x.kind === undefined && x.counts && typeof x.counts.payloadKeys === 'number'));
    assert.ok(log.every((x) => ['Bash', 'powershell'].includes(x.toolName)));
  } finally { rm(f.home); }
});

test('shadow: garbage input, an empty input and a missing generation never block and are logged as faults', () => {
  const f = installFake({ helpers });
  try {
    for (const bad of ['not json at all', '', '{']) { const r = run(f, 'claude', bad); assert.equal(r.code, 0); assert.equal(r.out, ''); }
    assert.ok(records(f).every((x) => x.fault === 'bad_payload'));
    assert.ok(records(f).every((x) => x.errorName === 'SyntaxError' && x.error === undefined));
    assert.equal(records(f).length, 3);
  } finally { rm(f.home); }
  const empty = installFake({ helpers });
  try {
    fs.unlinkSync(empty.L.current);
    const r = run(empty, 'claude', P.claudeAgent('developer'));
    assert.equal(r.code, 0);
    assert.equal(records(empty)[0].fault, 'no_generation');
  } finally { rm(empty.home); }
});

test('shadow: oversized input is structure-only, silent, and exits zero', () => {
  const f = installFake({ helpers });
  try {
    const r = run(f, 'claude', 'x'.repeat(256 * 1024 + 1));
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.equal(r.err, '');
    assert.equal(records(f)[0].fault, 'payload_too_large');
    assert.equal(records(f)[0].errorName, 'PayloadTooLargeError');
    assert.equal(records(f)[0].error, undefined);
  } finally { rm(f.home); }
});

test('shadow: a slow log write reaches the deadline and still exits silently', async () => {
  const f = installFake({ helpers });
  const input = new PassThrough();
  input.end(JSON.stringify(P.claudeAgent('developer')));
  const start = Date.now();
  try {
    const code = await runHook({ tool: 'claude', input, env: { FRONTDESK_HOME: f.home, FRONTDESK_HOOK_DEADLINE_MS: '80' }, L: f.L, startedAt: start, logger: () => new Promise(() => {}) });
    assert.equal(code, 0);
    assert.ok(Date.now() - start < 500);
  } finally { rm(f.home); }
});

test('a slow asynchronous context read cannot hold the hook past its deadline', async () => {
  const f = installFake({ helpers });
  const input = new PassThrough();
  input.end(JSON.stringify(P.claudeAgent('developer')));
  const realReadFile = fs.promises.readFile.bind(fs.promises);
  const start = Date.now();
  let records = 0;
  try {
    const code = await runHook({
      tool: 'claude', input, L: f.L, startedAt: start,
      env: { FRONTDESK_GUARD_MODE: 'shadow', FRONTDESK_HOOK_DEADLINE_MS: '50' },
      readFile: async (file) => {
        if (file.endsWith('guard-ctx.json')) await new Promise((resolve) => setTimeout(resolve, 120));
        return realReadFile(file);
      },
      logger: async () => { records++; },
    });
    assert.equal(code, 0);
    assert.ok(Date.now() - start < 200, `hook answered in ${Date.now() - start}ms`);
    assert.equal(records, 0);
  } finally { rm(f.home); }
});

test('shadow: an unwritable log path is silent and exits zero', () => {
  const f = installFake({ helpers });
  try {
    fs.rmSync(f.L.logs, { recursive: true, force: true });
    fs.writeFileSync(f.L.logs, 'not a directory');
    const r = run(f, 'claude', P.claudeAgent('developer'));
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.equal(r.err, '');
  } finally { rm(f.home); }
});

test('shadow: stdin that never closes exits silently at the deadline', async () => {
  const f = installFake({ helpers });
  try {
    const start = Date.now();
    const code = await new Promise((resolve) => {
      const c = spawn(process.execPath, [hook, 'claude', '--fd-guard'], { env: { ...process.env, FRONTDESK_HOME: f.home, FRONTDESK_HOOK_DEADLINE_MS: '100' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
      c.stdout.on('data', (x) => { out += x; }); c.stderr.on('data', (x) => { err += x; });
      c.on('error', () => resolve({ code: null, out, err }));
      c.on('exit', (exitCode) => resolve({ code: exitCode, out, err }));
    });
    assert.equal(code.code, 0);
    assert.equal(code.out, '');
    assert.equal(code.err, '');
    assert.ok(Date.now() - start < 1000);
  } finally { rm(f.home); }
});

test('shadow: eight parallel hooks stay silent, exit zero, and finish within budget plus margin', async () => {
  const f = installFake({ helpers });
  try {
    const runs = Array.from({ length: 8 }, () => new Promise((resolve) => {
      const start = Date.now();
      const c = spawn(process.execPath, [hook, 'claude', '--fd-guard'], { env: { ...process.env, FRONTDESK_HOME: f.home }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
      c.stdout.on('data', (x) => { out += x; }); c.stderr.on('data', (x) => { err += x; });
      c.on('error', (error) => resolve({ code: null, out, err, error }));
      c.on('exit', (code) => resolve({ code, out, err, ms: Date.now() - start }));
      c.stdin.end(JSON.stringify(P.claudeAgent('developer')));
    }));
    const results = await Promise.all(runs);
    for (const r of results) {
      assert.equal(r.code, 0, r.error?.message);
      assert.equal(r.out, '');
      assert.equal(r.err, '');
      assert.ok(r.ms < 2500, `hook took ${r.ms}ms`);
    }
  } finally { rm(f.home); }
});

test('hook records cap strings, object keys, arrays, and total bytes', async () => {
  const f = installFake({ helpers });
  try {
    await logRecord(f.L, { tool: 'claude', long: 'x'.repeat(500), object: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, 'v'])), list: Array.from({ length: 80 }, () => 'v') });
    const row = JSON.parse(fs.readFileSync(logFile(f.L), 'utf8').trim());
    assert.equal(row.long.length, LOG_STRING_MAX);
    assert.equal(Object.keys(row.object).length, LOG_OBJECT_KEYS_MAX);
    assert.equal(row.list.length, LOG_ARRAY_ENTRIES_MAX);
    assert.ok(Buffer.byteLength(JSON.stringify(row)) <= LOG_RECORD_BYTES_MAX);
  } finally { rm(f.home); }
});

test('readRecords does not open log months outside the requested window', () => {
  const f = installFake({ helpers });
  try {
    fs.mkdirSync(f.L.logs, { recursive: true });
    fs.mkdirSync(path.join(f.L.logs, 'guard-2000-01.jsonl'));
    assert.deepEqual(readRecords(f.L, { days: 7, now: new Date() }), []);
  } finally { rm(f.home); }
});

test('enforce: a refusable request exits 2 with a message that says how to comply', () => {
  const f = installFake({ helpers, mode: 'enforce' });
  try {
    const r = run(f, 'claude', P.claudeAgent('general-purpose'));
    assert.equal(r.code, 2);
    assert.match(r.err, /front desk|role/i);
    assert.equal(records(f)[0].mode, 'enforce');
    const muse = run(f, 'muse', P.museSpawn());
    assert.equal(muse.code, 2);
  } finally { rm(f.home); }
});

test('enforce: an allowed request passes; ordinary tools pass', () => {
  const f = installFake({ helpers, commissioned: ['b|high'], mode: 'enforce' });
  try {
    assert.equal(run(f, 'claude', P.claudeAgent('developer')).code, 0);
    assert.equal(run(f, 'claude', P.claudeBash()).code, 0);
    assert.equal(run(f, 'muse', P.museShell()).code, 0);
  } finally { rm(f.home); }
});

test('enforce: every fault becomes a refusal (a crashing guard must not let a delegation call through)', () => {
  const f = installFake({ helpers, mode: 'enforce' });
  try {
    assert.equal(run(f, 'claude', 'garbage').code, 2);
    assert.equal(run(f, 'claude', '').code, 2);
    const oversized = run(f, 'claude', 'x'.repeat(256 * 1024 + 1));
    assert.equal(oversized.code, 2);
    assert.match(oversized.err, /refusing this delegation call/);
    fs.unlinkSync(f.L.current);
    const r = run(f, 'claude', P.claudeAgent('developer'));
    assert.equal(r.code, 2);
    assert.match(r.err, /doctor/);
  } finally { rm(f.home); }
});

test('enforce: a log write fault is a refusal with exit 2', () => {
  const f = installFake({ helpers, mode: 'enforce' });
  try {
    fs.rmSync(f.L.logs, { recursive: true, force: true });
    fs.writeFileSync(f.L.logs, 'not a directory');
    const r = run(f, 'claude', P.claudeAgent('developer'));
    assert.equal(r.code, 2);
    assert.match(r.err, /refusing this delegation call/);
  } finally { rm(f.home); }
});

test('enforce: a log that exceeds the deadline is a refusal with exit 2', async () => {
  const f = installFake({ helpers, mode: 'enforce' });
  const input = new PassThrough();
  input.end(JSON.stringify(P.claudeAgent('developer')));
  const start = Date.now();
  let stderr = '';
  try {
    const code = await runHook({
      tool: 'claude', input, env: { FRONTDESK_HOOK_DEADLINE_MS: '60' }, L: f.L, startedAt: start,
      logger: () => new Promise(() => {}),
      stderr: { write(text, done) { stderr += text; done?.(); return true; } },
    });
    assert.equal(code, 2);
    assert.match(stderr, /refusing this delegation call/);
    assert.ok(Date.now() - start < 500);
  } finally { rm(f.home); }
});

test('enforce: an input that never ends is refused inside the deadline instead of hanging', async () => {
  const f = installFake({ helpers, mode: 'enforce' });
  try {
    const t0 = Date.now();
    const code = await new Promise((resolve) => {
      const c = spawn(process.execPath, [hook, 'claude', '--fd-guard'], { env: { ...process.env, FRONTDESK_HOME: f.home, FRONTDESK_HOOK_DEADLINE_MS: '600' }, stdio: ['pipe', 'ignore', 'ignore'] });
      c.on('exit', (x) => resolve(x));
      setTimeout(() => { try { c.kill(); } catch { /* done */ } }, 8000);
    });
    assert.equal(code, 2);
    assert.ok(Date.now() - t0 < 4000, 'answered well inside the tool timeout');
  } finally { rm(f.home); }
});

test('the environment can force a mode for one run', () => {
  const f = installFake({ helpers, mode: 'shadow' });
  try {
    assert.equal(run(f, 'claude', P.claudeAgent('general-purpose'), { FRONTDESK_GUARD_MODE: 'enforce' }).code, 2);
  } finally { rm(f.home); }
});

test('a corrupt or unreadable mode file logs mode_unreadable and stays silent in phase 1a', () => {
  for (const unreadable of [false, true]) {
    const f = installFake({ helpers });
    try {
      const modeFile = path.join(f.L.state, 'mode.json');
      fs.unlinkSync(modeFile);
      if (unreadable) fs.mkdirSync(modeFile); else fs.writeFileSync(modeFile, '{');
      const r = run(f, 'claude', P.claudeAgent('developer'));
      assert.equal(r.code, 0);
      assert.equal(r.out, '');
      assert.equal(r.err, '');
      assert.equal(records(f)[0].fault, 'mode_unreadable');
    } finally { rm(f.home); }
  }
});

test('mode and generation context JSON files are capped at one megabyte', () => {
  const f = installFake({ helpers });
  try {
    const modeFile = path.join(f.L.state, 'mode.json');
    const contextFiles = [modeFile, f.L.current, path.join(f.genDir, 'guard-ctx.json'), path.join(f.genDir, 'helpers.json')];
    for (const file of contextFiles) {
      fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
      const r = run(f, 'claude', P.claudeAgent('developer'));
      assert.equal(r.code, 0);
      assert.equal(r.out, '');
      assert.equal(r.err, '');
      assert.equal(records(f).at(-1).fault, file === modeFile ? 'mode_unreadable' : 'exception');
      fs.writeFileSync(file, file === modeFile ? JSON.stringify({ default: 'shadow' }) : file === f.L.current ? JSON.stringify({ generation: 1, release: 'testrelease', dir: '1-testrelease' }) : file.endsWith('guard-ctx.json') ? JSON.stringify({ commissioned: ['b|high'] }) : JSON.stringify({ helpers }));
    }
  } finally { rm(f.home); }
});

test('an invalid forced mode logs mode_unreadable but remains silent in the hook', () => {
  const f = installFake({ helpers });
  try {
    const r = run(f, 'claude', P.claudeAgent('developer'), { FRONTDESK_GUARD_MODE: 'other' });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.equal(r.err, '');
    assert.equal(records(f)[0].fault, 'mode_unreadable');
  } finally { rm(f.home); }
});

test('a dispatched worker environment is caught', () => {
  const f = installFake({ helpers });
  try {
    run(f, 'claude', P.claudeAgent('developer'), { DELEGATION_DISPATCHED: '1' });
    const r = records(f)[0];
    assert.equal(r.decision, 'deny');
    assert.ok(r.reasons.includes('worker_delegation_env'));
    assert.equal(r.caller, 'env-worker');
  } finally { rm(f.home); }
});

test('the hook runs when its entry path is reached through a directory junction', () => {
  const f = installFake({ helpers });
  const junction = path.join(f.home, 'frontdesk-junction');
  try {
    fs.symlinkSync(path.resolve(hook, '..'), junction, 'junction');
    const r = spawnSync(process.execPath, [path.join(junction, 'hook.mjs'), 'claude'], {
      input: JSON.stringify(P.claudeAgent('developer')), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, FRONTDESK_HOME: f.home },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.equal(records(f).length, 1);
  } finally { rm(f.home); }
});

test('a hook run is fast: well under the tool timeout', () => {
  const f = installFake({ helpers });
  try {
    run(f, 'claude', P.claudeAgent('developer')); // warm the disk cache
    const times = [];
    for (let i = 0; i < 5; i++) times.push(run(f, 'claude', P.claudeAgent('developer')).ms);
    times.sort((a, b) => a - b);
    assert.ok(times[2] < 1500, `median ${times[2]} ms`);
  } finally { rm(f.home); }
});
