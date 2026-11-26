// Tests for the muse-delegate relay's contributor-tier guard, with a fake `muse` on PATH (no network, no account).
// The packet build runs them against the staged relay (gate "muse relay tests"):
//   MUSE_RELAY=<path to muse-delegate/scripts/relay.mjs> node --test packet/tests/muse-relay.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const RELAY = process.env.MUSE_RELAY;
if (!RELAY || !fs.existsSync(RELAY)) {
  throw new Error('set MUSE_RELAY to the muse-delegate relay.mjs under test (the packet build sets it to the staged relay)');
}
const IS_WIN = process.platform === 'win32';

// A fake muse. `--version` prints FAKE_MUSE_VERSION (default 9.9.9); `exec` records its arguments (and whether
// MUSE_CONTRIBUTOR_MODE reached it, and its working directory) and prints the JSONL events named by
// FAKE_MUSE_EVENTS. Modes (FAKE_MUSE_MODE):
//   normal      - print the events and exit 0
//   linger      - start a grandchild that writes FAKE_MUSE_MARKER after FAKE_MUSE_LINGER_MS, print the events, never exit
//   orphan      - start such a grandchild detached (it outlives the fake), print the events and exit 0 at once
//   holder      - like orphan, but the grandchild keeps the fake's stdout and stderr open
//   oldflag     - behave like a Muse older than the --contributor-mode flag: refuse it as an unknown argument
//   flagnoise   - print the events, then a stderr line naming the flag and "invalid", exit 1 (no refusal)
//   breakstatus - make the Windows guard's status file unwritable (FAKE_GUARD_TMP becomes a folder), then exit 0
// The grandchild's command line holds the test folder's name, so leftovers can be found and counted.
const FAKE = `import fs from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(process.env.FAKE_MUSE_VERSION || 'Muse Code 9.9.9 (fake)'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_MUSE_ARGS, JSON.stringify(args));
fs.writeFileSync(process.env.FAKE_MUSE_ENV, JSON.stringify({ MUSE_CONTRIBUTOR_MODE: process.env.MUSE_CONTRIBUTOR_MODE ?? null, cwd: process.cwd() }));
const mode = process.env.FAKE_MUSE_MODE || 'normal';
if (mode === 'oldflag' && args.includes('--contributor-mode')) {
  process.stderr.write("error: unexpected argument '--contributor-mode' found\\n");
  process.exit(2);
}
if (mode === 'breakstatus') fs.mkdirSync(process.env.FAKE_GUARD_TMP, { recursive: true });
if (mode === 'linger' || mode === 'orphan' || mode === 'holder') {
  const wait = Number(process.env.FAKE_MUSE_LINGER_MS || 3000);
  const code = 'setTimeout(() => require("fs").writeFileSync(' + JSON.stringify(process.env.FAKE_MUSE_MARKER) + ', "still running"), ' + wait + ')';
  // Windows: a plain child of node ends with it (node keeps its children in a job of its own), so the orphan is
  // detached. POSIX: a plain child outlives node and stays in its process group; detached would start a new session.
  const stdio = mode === 'holder' ? ['ignore', 'inherit', 'inherit'] : 'ignore';
  const g = spawn(process.execPath, ['-e', code], { stdio, detached: mode !== 'linger' && process.platform === 'win32' });
  if (mode === 'linger') setInterval(() => {}, 1000); else g.unref();
}
for (const line of fs.readFileSync(process.env.FAKE_MUSE_EVENTS, 'utf8').split('\\n')) if (line.trim()) process.stdout.write(line + '\\n');
if (mode === 'flagnoise') { process.stderr.write('warning: --contributor-mode is invalid for this provider\\n'); process.exit(1); }
if (mode !== 'linger') process.exit(0);
`;

// Events shaped like Muse 1.4.15's --json stream. In the 2026-11-09 incident runs the first provider facet came at
// event 20 (task.lifecycle.status, phase stream_succeeded, payload.event.details.facets[1].detail), after a
// run.model.configured event that still named the standard model.
const STREAM = '01a00000-0000-7000-8000-000000000001';
const ev = (seq, payload_type, payload) => JSON.stringify({ schema_version: 1, stream: { kind: 'session', id: STREAM }, sequence: seq, payload_type, payload });
const providerFacet = (model, seq = 2) => ev(seq, 'task.lifecycle.status', { kind: 'task_lifecycle', event: { kind: 'status', details: { phase: 'stream_succeeded', facets: [
  { kind: 'external_attempt', system: 'meta', operation: 'model.response', attempt: 1 },
  { kind: 'producer', detail: { kind: 'provider', provider: 'meta', request_id: 'r1', response_id: 'p1', stream: true, model } }] } } });
const accepted = ev(1, 'runtime.command.accepted', { command_id: 'c1', client_id: 'cli' });
const configured = (model) => ev(3, 'run.model.configured', { provider_id: 'meta', model_id: model, display_label: model });
const lifecycle = (seq) => ev(seq, 'task.lifecycle.status', { kind: 'task_lifecycle', event: { kind: 'status', details: { phase: 'stream_started', facets: [
  { kind: 'external_attempt', system: 'meta', operation: 'model.response', attempt: 1 }] } } });
const delta = ev(30, 'run.output.delta', { command_id: 'c1', text: 'OK' });
const done = ev(31, 'run.terminal.completed', { command_id: 'c1', terminal: 'completed', text: 'OK' });

function world(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-relay-test-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'fake-muse.mjs'), FAKE);
  if (IS_WIN) fs.writeFileSync(path.join(bin, 'muse.cmd'), `@"${process.execPath}" "%~dp0fake-muse.mjs" %*\r\n`);
  else { fs.writeFileSync(path.join(bin, 'muse'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-muse.mjs" "$@"\n`); fs.chmodSync(path.join(bin, 'muse'), 0o755); }
  fs.writeFileSync(path.join(dir, 'events.txt'), events.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'brief.md'), 'Reply with exactly one word: OK\n');
  fs.mkdirSync(path.join(dir, 'work'));
  return dir;
}

function relayCall(dir, extra = [], fakeEnv = {}) {
  const env = {
    ...process.env, PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH,
    FAKE_MUSE_ARGS: path.join(dir, 'args.json'), FAKE_MUSE_ENV: path.join(dir, 'env.json'),
    FAKE_MUSE_EVENTS: path.join(dir, 'events.txt'), FAKE_MUSE_MARKER: path.join(dir, 'marker.txt'), ...fakeEnv,
  };
  delete env.Path; // Windows: one PATH variable only
  const timeout = extra.includes('--timeout') ? [] : ['--timeout', '2m'];
  return { args: [RELAY, '--brief', path.join(dir, 'brief.md'), '--cd', path.join(dir, 'work'), '--out-dir', path.join(dir, 'out'), ...timeout, ...extra], env };
}
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const outcome = (dir, status, stdout, stderr) => ({
  status, stdout, stderr, result: readJson(path.join(dir, 'out', 'result.json')),
  args: readJson(path.join(dir, 'args.json')), museEnv: readJson(path.join(dir, 'env.json')),
});

function run(dir, extra = [], fakeEnv = {}) {
  const c = relayCall(dir, extra, fakeEnv);
  const r = spawnSync(process.execPath, c.args, { encoding: 'utf8', env: c.env, timeout: 90_000 });
  return outcome(dir, r.status, r.stdout, r.stderr);
}

// Starts the relay without waiting; `act(child)` runs once the fake muse has started (its args file exists).
async function runWhile(dir, extra, fakeEnv, act) {
  const c = relayCall(dir, extra, fakeEnv);
  const child = spawn(process.execPath, c.args, { env: c.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const closed = new Promise((r) => child.on('close', (code, sig) => r(code ?? sig)));
  for (let i = 0; i < 300 && !fs.existsSync(path.join(dir, 'args.json')); i += 1) await sleep(100);
  await sleep(500);
  await act(child);
  const status = await closed;
  return outcome(dir, status, stdout, stderr);
}

// Processes still running whose command line names this test's folder (the fake muse and its grandchild).
function leftovers(dir) {
  const tag = path.basename(dir);
  if (IS_WIN) {
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${tag}*' } | ForEach-Object { $_.ProcessId }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    return (r.stdout || '').split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean);
  }
  const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter((l) => l.includes(tag)).map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((p) => p && p !== process.pid);
}

const clean = (dir) => {
  for (const pid of leftovers(dir)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(dir, { recursive: true, force: true });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('every run passes --contributor-mode off and records where requests went', () => {
  const dir = world([accepted, providerFacet('muse-spark-1.3'), delta, done]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3', '--effort', 'low']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const i = r.args.indexOf('--contributor-mode');
    assert.ok(i >= 0 && r.args[i + 1] === 'off', `muse was called without --contributor-mode off: ${JSON.stringify(r.args)}`);
    assert.equal(r.result.status, 'completed');
    assert.deepEqual(r.result.sentToModels, ['muse-spark-1.3']);
    assert.equal(r.result.contributorCheck, 'verified');
    assert.ok(['on', 'off', 'absent', 'unreadable'].includes(r.result.museContributorSetting));
    assert.equal(r.result.modelWarning, undefined);
    // Muse runs in --cd (on Windows the guard passes it explicitly).
    const norm = (p) => (IS_WIN ? fs.realpathSync(p).toLowerCase() : fs.realpathSync(p));
    assert.equal(norm(r.museEnv.cwd), norm(path.join(dir, 'work')));
  } finally { clean(dir); }
});

test('read-only runs carry the flag too', () => {
  const dir = world([accepted, providerFacet('muse-wonder-1.0'), delta, done]);
  try {
    const r = run(dir, ['--model', 'muse-wonder-1.0', '--read-only']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.args.includes('--disable-write'));
    assert.equal(r.args[r.args.indexOf('--contributor-mode') + 1], 'off');
  } finally { clean(dir); }
});

test('MUSE_CONTRIBUTOR_MODE never reaches muse', () => {
  const dir = world([accepted, providerFacet('muse-spark-1.3'), delta, done]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3'], { MUSE_CONTRIBUTOR_MODE: '1' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.museEnv.MUSE_CONTRIBUTOR_MODE, null);
  } finally { clean(dir); }
});

test('a contributor model id or provider is refused before muse starts', () => {
  for (const extra of [['--model', 'muse-spark-1.3-contributor'], ['--model', 'muse-ember-1.0-Contributor'], ['--provider', 'meta-contributor']]) {
    const dir = world([accepted, done]);
    try {
      const r = run(dir, extra);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr + r.stdout, /contributor tier/);
      assert.equal(r.args, null, 'muse must not have been run');
      assert.equal(r.result, null, 'a usage error writes no result');
    } finally { clean(dir); }
  }
});

test('a request that went to the contributor tier anyway stops the run with exit 3', () => {
  const dir = world([accepted, providerFacet('muse-spark-1.3-contributor'), delta, done]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(r.result.status, 'contributor_tier_used');
    assert.equal(r.result.ok, false);
    assert.equal(r.result.contributorCheck, 'contributor_tier_used');
    assert.deepEqual(r.result.sentToModels, ['muse-spark-1.3-contributor']);
    assert.match(r.result.error, /contributor tier/);
  } finally { clean(dir); }
});

test('an incident-shaped stream (configured as standard, sent to the contributor tier at event 20) stops with exit 3', () => {
  const events = [accepted, ev(2, 'session.run.linked', {}), configured('muse-spark-1.3')];
  for (let s = 4; s < 20; s += 1) events.push(lifecycle(s));
  events.push(providerFacet('muse-spark-1.3-contributor', 20), delta, done);
  const dir = world(events);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(r.result.status, 'contributor_tier_used');
    assert.deepEqual(r.result.sentToModels, ['muse-spark-1.3-contributor']);
  } finally { clean(dir); }
});

test('a contributor facet in the last line without a newline is still caught', () => {
  const dir = world([accepted, delta, done]);
  try {
    // The fake normally ends every line with a newline; make it print the last event without one.
    const raw = [accepted, delta, done].join('\n') + '\n' + providerFacet('muse-wonder-1.0-contributor');
    fs.writeFileSync(path.join(dir, 'bin', 'fake-muse.mjs'), FAKE.replace(/for \(const line[^\n]*\n/, `process.stdout.write(${JSON.stringify(raw)});\n`));
    const r = run(dir, ['--model', 'muse-wonder-1.0']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(r.result.status, 'contributor_tier_used');
  } finally { clean(dir); }
});

test('stopping for the contributor tier stops every process muse started', async () => {
  const dir = world([accepted, providerFacet('muse-spark-1.3-contributor')]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3'], { FAKE_MUSE_MODE: 'linger', FAKE_MUSE_LINGER_MS: '3000' });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(r.result.status, 'contributor_tier_used');
    assert.equal(r.result.museStopped, true);
    assert.match(r.result.error, /the relay stopped it and every process it started/);
    await sleep(5000);
    assert.equal(fs.existsSync(path.join(dir, 'marker.txt')), false, 'a process muse started was still running after the stop');
    assert.deepEqual(leftovers(dir), [], 'muse stand-in processes still running');
  } finally { clean(dir); }
});

test('the watchdog stops every process muse started', async () => {
  const dir = world([accepted]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3', '--timeout', '2s'], { FAKE_MUSE_MODE: 'linger', FAKE_MUSE_LINGER_MS: '6000' });
    assert.equal(r.status, 124, r.stdout + r.stderr);
    assert.equal(r.result.status, 'timeout');
    assert.equal(r.result.museStopped, true);
    await sleep(7000);
    assert.equal(fs.existsSync(path.join(dir, 'marker.txt')), false, 'a process muse started was still running after the timeout');
    assert.deepEqual(leftovers(dir), [], 'muse stand-in processes still running');
  } finally { clean(dir); }
});

test('muse that exits at once, leaving a process behind and a contributor facet in its unterminated last line: exit 3, nothing left running', async () => {
  const dir = world([accepted]);
  try {
    const raw = [accepted, delta].join('\n') + '\n' + providerFacet('muse-spark-1.3-contributor');
    fs.writeFileSync(path.join(dir, 'bin', 'fake-muse.mjs'), FAKE.replace(/for \(const line[^\n]*\n/, `process.stdout.write(${JSON.stringify(raw)});\n`));
    const r = run(dir, ['--model', 'muse-spark-1.3'], { FAKE_MUSE_MODE: 'orphan', FAKE_MUSE_LINGER_MS: '4000' });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(r.result.status, 'contributor_tier_used');
    // Windows: the guard's job ended it. POSIX: it is still in muse's process group, which the stop signals.
    assert.equal(r.result.museStopped, true);
    await sleep(5500);
    assert.equal(fs.existsSync(path.join(dir, 'marker.txt')), false, 'the process muse left behind was still running after the stop');
    assert.deepEqual(leftovers(dir), [], 'muse stand-in processes still running');
  } finally { clean(dir); }
});

// museLeftRunning: the job's count on Windows; true elsewhere (the group stop does not count its members).
const LEFT_ONE = IS_WIN ? 1 : true;

test('a process muse leaves running at a normal end is stopped and reported', async () => {
  const dir = world([accepted, providerFacet('muse-spark-1.3'), delta, done]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3'], { FAKE_MUSE_MODE: 'orphan', FAKE_MUSE_LINGER_MS: '4000' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.result.status, 'completed');
    assert.equal(r.result.museLeftRunning, LEFT_ONE);
    assert.equal(r.result.museStopped, undefined);
    assert.match(r.stdout, /check the worktree/i);
    await sleep(5500);
    assert.equal(fs.existsSync(path.join(dir, 'marker.txt')), false, 'the process muse left behind was still running');
    assert.deepEqual(leftovers(dir), [], 'muse stand-in processes still running');
  } finally { clean(dir); }
});

test('a process muse leaves running that keeps its output open does not turn a finished run into a timeout', async () => {
  const dir = world([accepted, providerFacet('muse-spark-1.3'), delta, done]);
  try {
    const started = Date.now();
    const r = run(dir, ['--model', 'muse-spark-1.3', '--timeout', '60s'], { FAKE_MUSE_MODE: 'holder', FAKE_MUSE_LINGER_MS: '20000' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.result.status, 'completed');
    assert.equal(r.result.museLeftRunning, LEFT_ONE);
    assert.equal(r.result.museStopped, undefined);
    assert.ok(Date.now() - started < 20_000, `the relay waited ${Date.now() - started} ms for the leftover process`);
    assert.deepEqual(leftovers(dir), [], 'muse stand-in processes still running');
    assert.equal(fs.existsSync(path.join(dir, 'marker.txt')), false);
  } finally { clean(dir); }
});

test('a working folder that does not exist: muse is never run and nothing was sent', () => {
  const dir = world([accepted, providerFacet('muse-spark-1.3'), delta, done]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3', '--cd', path.join(dir, 'missing')]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.result.status, 'failed');
    assert.equal(r.result.contributorCheck, 'not_sent');
    assert.match(r.result.error, /Muse was not run/);
    // Windows: the guard could not create muse's process there (exit 97, status "unavailable").
    if (IS_WIN) assert.match(r.result.error, /process guard \(.*CreateProcess failed \(Windows error 267\)/);
    assert.equal(r.args, null, 'muse exec must not have been run');
    assert.doesNotMatch(r.stdout, /Stop and tell the person/);
  } finally { clean(dir); }
});

test('Windows: a guard that loses its status file after muse started is reported unconfirmed, not "not sent"', { skip: !IS_WIN }, () => {
  const dir = world([]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3'], { FAKE_MUSE_MODE: 'breakstatus', FAKE_GUARD_TMP: path.join(dir, 'out', 'muse-guard.json.tmp') });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.result.status, 'failed');
    assert.equal(r.result.contributorCheck, 'unverified');
    assert.equal(r.result.museStopped, false);
    assert.match(r.stdout, /Stop and tell the person/);
    assert.deepEqual(leftovers(dir), [], 'muse stand-in processes still running');
  } finally { clean(dir); }
});

// The guard on its own (the script embedded in the relay), without the relay around it.
function guardRun(dir, env, wrapper = null) {
  const src = fs.readFileSync(RELAY, 'utf8');
  const script = /const GUARD_PS = String\.raw`([\s\S]*?)`;/.exec(src)[1];
  const marker = path.join(dir, 'started.txt');
  const full = {
    ...process.env,
    MUSE_RELAY_GUARD_STATUS: path.join(dir, 'guard.json'), MUSE_RELAY_GUARD_STOP: path.join(dir, 'guard.stop'),
    MUSE_RELAY_GUARD_CMD: `"${process.env.ComSpec || 'cmd.exe'}" /d /s /c "cd > "${marker}""`,
    MUSE_RELAY_GUARD_CWD: path.join(dir, 'work'), MUSE_RELAY_GUARD_PARENT: String(process.pid), ...env,
  };
  const code = wrapper ? wrapper : script;
  if (wrapper) full.T_GUARD = script;
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    { encoding: 'utf8', env: full, windowsHide: true, cwd: dir, timeout: 60_000 });
  const started = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, status: readJson(path.join(dir, 'guard.json')), started };
}

test('Windows guard: starts muse in the given folder; refuses to start it when it cannot be guarded', { skip: !IS_WIN }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-guard-test-'));
  const fresh = () => { for (const f of ['guard.json', 'guard.stop', 'started.txt']) fs.rmSync(path.join(dir, f), { force: true }); };
  try {
    fs.mkdirSync(path.join(dir, 'work'));
    // Normal: muse runs in MUSE_RELAY_GUARD_CWD, the guard writes nothing to stdout and confirms the job is empty.
    let g = guardRun(dir, {});
    assert.equal(g.code, 0, g.stderr);
    assert.equal(g.stdout, '');
    assert.equal(g.started.toLowerCase(), fs.realpathSync(path.join(dir, 'work')).toLowerCase());
    assert.equal(g.status.state, 'ended');
    assert.equal(g.status.started, true);
    assert.equal(g.status.active, 0);
    // Constrained Language Mode (what WDAC or AppLocker enforce): exit 97, "unavailable", muse never started.
    fresh();
    g = guardRun(dir, {}, "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\nInvoke-Expression $env:T_GUARD\nexit 5");
    assert.equal(g.code, 97, g.stderr);
    assert.equal(g.status.guard, 'unavailable');
    assert.match(g.status.error, /ConstrainedLanguage/);
    assert.equal(g.started, null, 'muse was started in Constrained Language Mode');
    // The relay process cannot be watched: exit 97 before muse starts.
    fresh();
    g = guardRun(dir, { MUSE_RELAY_GUARD_PARENT: '2147483644' });
    assert.equal(g.code, 97, g.stderr);
    assert.equal(g.status.guard, 'unavailable');
    assert.match(g.status.error, /cannot watch the relay process/);
    assert.equal(g.started, null);
    // A stop asked for before muse ran: muse is never let run, and the status says so.
    fresh();
    fs.writeFileSync(path.join(dir, 'guard.stop'), 'stop\n');
    g = guardRun(dir, {});
    assert.equal(g.code, 1, g.stderr);
    assert.equal(g.status.state, 'ended');
    assert.equal(g.status.started, false);
    assert.equal(g.status.active, 0);
    assert.equal(g.started, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stderr that names the flag does not hide where requests went', () => {
  const dir = world([accepted, providerFacet('muse-spark-1.3'), delta]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3'], { FAKE_MUSE_MODE: 'flagnoise' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.result.status, 'failed');
    assert.equal(r.result.contributorCheck, 'verified');
    assert.doesNotMatch(r.result.error, /update Muse/);
  } finally { clean(dir); }
});

test('Windows: when the relay itself is killed, everything muse started ends too', { skip: !IS_WIN }, async () => {
  const dir = world([accepted]);
  try {
    await runWhile(dir, ['--model', 'muse-spark-1.3'], { FAKE_MUSE_MODE: 'linger', FAKE_MUSE_LINGER_MS: '5000' }, (child) => {
      spawnSync('taskkill', ['/pid', String(child.pid), '/f'], { stdio: 'ignore', windowsHide: true });
    });
    await sleep(6500);
    assert.equal(fs.existsSync(path.join(dir, 'marker.txt')), false, 'a process muse started outlived the relay');
    assert.deepEqual(leftovers(dir), [], 'muse stand-in processes still running');
  } finally { clean(dir); }
});

test('POSIX: SIGINT or SIGTERM to the relay stops muse and everything it started first', { skip: IS_WIN }, async () => {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const dir = world([accepted]);
    try {
      const r = await runWhile(dir, ['--model', 'muse-spark-1.3'], { FAKE_MUSE_MODE: 'linger', FAKE_MUSE_LINGER_MS: '5000' }, (child) => { child.kill(sig); });
      assert.equal(r.status, code, r.stdout + r.stderr);
      assert.equal(r.result.status, 'cancelled');
      assert.equal(r.result.museStopped, true);
      await sleep(6000);
      assert.equal(fs.existsSync(path.join(dir, 'marker.txt')), false, `a process muse started outlived the relay after ${sig}`);
      assert.deepEqual(leftovers(dir), [], 'muse stand-in processes still running');
    } finally { clean(dir); }
  }
});

test('a Muse older than 1.4.15 is refused before it runs; an unreadable version runs and is recorded', () => {
  let dir = world([accepted, providerFacet('muse-spark-1.3'), delta, done]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3'], { FAKE_MUSE_VERSION: 'Muse Code 1.4.14 (1.4.14-R8100.1)' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.result.status, 'muse_too_old');
    assert.equal(r.result.museVersionCheck, 'old');
    assert.match(r.result.error, /older than 1\.4\.15/);
    assert.equal(r.args, null, 'muse exec must not have been run');
  } finally { clean(dir); }
  dir = world([accepted, providerFacet('muse-spark-1.3'), delta, done]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3'], { FAKE_MUSE_VERSION: 'Muse Code dev build' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.result.museVersionCheck, 'unparsed');
    assert.equal(r.args[r.args.indexOf('--contributor-mode') + 1], 'off');
  } finally { clean(dir); }
  dir = world([accepted, providerFacet('muse-spark-1.3'), delta, done]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3'], { FAKE_MUSE_VERSION: 'Muse Code 1.4.15 (1.4.15-R8339.1)' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.result.museVersionCheck, 'ok');
  } finally { clean(dir); }
});

test('a completed run that names no model is reported unverified', () => {
  const dir = world([accepted, delta, done]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.result.contributorCheck, 'unverified');
    assert.deepEqual(r.result.sentToModels, []);
    assert.match(r.stdout, /Stop and tell the person/);
  } finally { clean(dir); }
});

test('a model other than the requested one is reported', () => {
  const dir = world([accepted, providerFacet('muse-wonder-1.0'), delta, done]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.result.contributorCheck, 'verified');
    assert.match(r.result.modelWarning, /muse-wonder-1\.0/);
  } finally { clean(dir); }
});

test('a Muse that refuses --contributor-mode fails with an update message and is never rerun without it', () => {
  const dir = world([accepted, providerFacet('muse-spark-1.3'), delta, done]);
  try {
    const r = run(dir, ['--model', 'muse-spark-1.3'], { FAKE_MUSE_MODE: 'oldflag' });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.result.status, 'failed');
    assert.match(r.result.error, /update Muse to 1\.4\.15 or newer/);
    assert.ok(r.args.includes('--contributor-mode'), 'the one muse call carried the flag');
    // Nothing was sent, so this is not the "cannot tell where requests went" alarm.
    assert.equal(r.result.contributorCheck, 'not_sent');
    assert.doesNotMatch(r.stdout, /Stop and tell the person/);
  } finally { clean(dir); }
});
