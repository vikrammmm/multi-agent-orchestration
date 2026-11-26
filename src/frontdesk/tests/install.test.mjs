// End to end: plant a fixed ladder release into a fake shared folder, install it into a fake home that has the three tools' settings
// files, and check what changed and what did not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmp, rm, installFake, fixtureRelease, testEnv } from './helpers.mjs';
import { addCodex, addMuse, hookCommand, removeCodex } from '../lib/splice.mjs';
import { logRecord } from '../lib/hooklog.mjs';
import { loadTools } from '../lib/tools.mjs';
import { applySettingsPlans, codexForLiveCheck, LIVE_CHECK_OFF, shouldRunCodexLiveCheck, smokeHook, runCodexLiveCheck, validateCodexConfig, verifySettingsSnapshot } from '../install-frontdesk.mjs';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const FD_SRC = path.resolve(here, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function copyTree(src, dst, skip = () => false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(e.name, src)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d, skip); else fs.copyFileSync(s, d);
  }
}
function hashTree(dir) {
  const out = {};
  const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(p, r); else out[r] = sha(fs.readFileSync(p)); } };
  walk(dir); return out;
}

const CLAUDE = JSON.stringify({ autoUpdatesChannel: 'latest', skipWorkflowUsageWarning: true, switchModelsOnFlag: true }, null, 2) + '\n';
const MUSE = JSON.stringify({ schema_version: 1, provider: 'meta', model: 'muse-wonder-full-1.0', reasoning_effort: 'max', contributor_mode_enabled: false, permissions: { default_profile: ':unrestricted' } }, null, 2) + '\n';
const CODEX = `model = "gpt-6.1-sol"
model_reasoning_effort = "ultra"

[features]
hooks = true

[[hooks.PreToolUse]]
matcher = "^Bash$|^apply_patch$|^Edit$|^Write$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = 'python3 ~/.codex/hooks/astra_execution_budget/astra_execution_budget.py'
timeout = 5

[hooks.state.'C:\\Users\\X\\.codex\\config.toml:pre_tool_use:0:0']
trusted_hash = "sha256:92b17b3d"
`;
const HELPER = `---
name: haiku-helper
description: test
tools: Read
model: claude-haiku-5-5
effort: max
---
body
`;

function world({ spaceHome = false, wonderHold = false } = {}) {
  const root = tmp('fd-world-');
  const shared = path.join(root, 'shared'), home = path.join(root, spaceHome ? 'home with spaces' : 'home');
  fixtureRelease(shared, { wonderHold });
  copyTree(FD_SRC, path.join(shared, 'frontdesk'), (n) => n === 'tests' || n === 'code-manifest.json');
  const seal = spawnSync(process.execPath, [path.join(shared, 'frontdesk', 'seal.mjs')], { encoding: 'utf8' });
  assert.equal(seal.status, 0, seal.stderr);
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'muse'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), CLAUDE);
  fs.writeFileSync(path.join(home, '.claude', 'agents', 'haiku-helper.md'), HELPER);
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), CODEX);
  fs.writeFileSync(path.join(home, '.config', 'muse', 'settings.json'), MUSE);
  return { root, shared, home, installer: path.join(shared, 'frontdesk', 'install-frontdesk.mjs') };
}
const install = (w, extra = [], env = {}) => spawnSync(process.execPath, [w.installer, ...extra, '--no-live-check', '--home', w.home, '--shared-root', w.shared], { encoding: 'utf8', env: testEnv(w.home, env), timeout: 120000 });
const role = (w, args, env = {}) => spawnSync(process.execPath, [path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'bin', 'role.mjs'), ...args], { encoding: 'utf8', env: testEnv(w.home, env), timeout: 60000 });
const read = (w, rel) => fs.readFileSync(path.join(w.home, rel), 'utf8');

test('dry run changes nothing', () => {
  const w = world();
  try {
    const before = hashTree(w.home);
    const r = install(w);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing changed/);
    assert.deepEqual(hashTree(w.home), before);
  } finally { rm(w.root); }
});

test('installer main check resolves a directory junction entry path', () => {
  const w = world();
  const junction = path.join(w.root, 'frontdesk-junction');
  try {
    fs.symlinkSync(path.dirname(w.installer), junction, 'junction');
    const result = spawnSync(process.execPath, [path.join(junction, 'install-frontdesk.mjs'), 'status', '--home', w.home], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not installed/);
  } finally { rm(w.root); }
});

test('dry run prints the final command and commands work from a home path with spaces', () => {
  const w = world({ spaceHome: true });
  try {
    const dry = install(w, ['--tools', 'claude']);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    const line = dry.stdout.split(/\r?\n/).find((x) => x.includes('claude command:'));
    assert.ok(line, dry.stdout);
    const dryCommand = line.slice(line.indexOf('claude command:') + 'claude command:'.length).trim();
    assert.match(dryCommand, /hook\.mjs claude --fd-guard$/);
    const applied = install(w, ['--yes', '--tools', 'claude']);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const receipt = JSON.parse(read(w, '.config/delegate-skills/frontdesk-install.json'));
    // A dry run on a fresh home cannot know the short name Windows will give the new folder; the applied command has no spaces and ends alike.
    assert.match(receipt.hooks.claude.command, /hook\.mjs claude --fd-guard$/);
    assert.equal(receipt.hooks.claude.command.split(' ').length, 4, receipt.hooks.claude.command);
    const receiptBytes = read(w, '.config/delegate-skills/frontdesk-install.json');
    const currentBefore = read(w, '.config/delegate-skills/frontdesk/current.json');
    const again = install(w, ['--yes', '--tools', 'claude']);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /already installed, nothing to do/);
    assert.equal(read(w, '.config/delegate-skills/frontdesk-install.json'), receiptBytes);
    assert.equal(read(w, '.config/delegate-skills/frontdesk/current.json'), currentBefore);
    assert.equal(receipt.hooks.claude.command, JSON.parse(receiptBytes).hooks.claude.command);
    assert.equal(fs.existsSync(path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'bin.prev')), false);
    const report = role(w, ['doctor', '--json']);
    const check = JSON.parse(report.stdout).hookCommands.claude;
    assert.equal(check.nodeExists, true);
    assert.equal(check.hookExists, true);
    assert.ok(check.hook.endsWith('/hook.mjs') || check.hook.endsWith('\\hook.mjs'));
  } finally { rm(w.root); }
});

test('install: program, generation, receipt and a selected log-only hook; other settings stay', () => {
  const w = world();
  try {
    const r = install(w, ['--yes', '--tools', 'claude']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const fd = '.config/delegate-skills/frontdesk';
    assert.ok(fs.existsSync(path.join(w.home, fd, 'bin', 'hook.mjs')));
    assert.ok(fs.existsSync(path.join(w.home, fd, 'current.json')));
    assert.ok(fs.existsSync(path.join(w.home, '.config', 'delegate-skills', 'frontdesk-install.json')));
    const claude = JSON.parse(read(w, '.claude/settings.json'));
    assert.equal(claude.autoUpdatesChannel, 'latest');
    assert.equal(claude.hooks.PreToolUse.length, 1);
    assert.match(claude.hooks.PreToolUse[0].hooks[0].command, /hook\.mjs claude --fd-guard$/);
    const command = claude.hooks.PreToolUse[0].hooks[0].command;
    assert.match(command, /hook\.mjs claude --fd-guard$/);
    assert.ok(r.stdout.includes(`claude command: ${command}`));
    const muse = JSON.parse(read(w, '.config/muse/settings.json'));
    assert.equal(muse.contributor_mode_enabled, false);
    assert.equal(muse.hooks, undefined);
    const codex = read(w, '.codex/config.toml');
    assert.equal(codex, CODEX, 'the unselected Codex config is untouched');
    const rec = JSON.parse(read(w, '.config/delegate-skills/frontdesk-install.json'));
    assert.ok(rec.hooks.claude.backup && fs.existsSync(rec.hooks.claude.backup));
    assert.equal(fs.readFileSync(rec.hooks.claude.backup, 'utf8'), CLAUDE, 'the backup is the original');
    assert.equal(rec.hooks.codex, undefined);
    assert.equal(rec.hooks.muse, undefined);
    const gen = fs.readdirSync(path.join(w.home, fd, 'generations'));
    assert.equal(gen.length, 1);
    const helpers = JSON.parse(fs.readFileSync(path.join(w.home, fd, 'generations', gen[0], 'helpers.json'), 'utf8')).helpers;
    assert.equal(helpers['haiku-helper'].engineer, 'claude-haiku-5-5|max');
  } finally { rm(w.root); }
});

test('the default install omits Muse and an explicit Muse request needs the opt-in flag', () => {
  const w = world();
  try {
    const r = install(w, ['--yes']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(read(w, '.config/muse/settings.json')).hooks, undefined);
    const receipt = JSON.parse(read(w, '.config/delegate-skills/frontdesk-install.json'));
    assert.equal(receipt.hooks.muse, undefined);
    const refused = install(w, ['--dry-run', '--tools', 'muse']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /user-level hook location is unproven/);
    const allowed = install(w, ['--dry-run', '--tools', 'muse', '--allow-unproven-muse']);
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    assert.doesNotMatch(allowed.stderr, /refused/);
  } finally { rm(w.root); }
});

test('install twice: the second run changes none of the settings files', () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--tools', 'claude']).status, 0);
    const snap = { c: read(w, '.claude/settings.json'), m: read(w, '.config/muse/settings.json'), x: read(w, '.codex/config.toml') };
    const r = install(w, ['--yes', '--tools', 'claude']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /already/);
    assert.equal(read(w, '.claude/settings.json'), snap.c);
    assert.equal(read(w, '.config/muse/settings.json'), snap.m);
    assert.equal(read(w, '.codex/config.toml'), snap.x);
  } finally { rm(w.root); }
});

test('an identical reinstall is a full no-op and keeps the original backup references', () => {
  const w = world({ spaceHome: true });
  try {
    assert.equal(install(w, ['--yes', '--tools', 'claude']).status, 0);
    const receiptPath = path.join(w.home, '.config', 'delegate-skills', 'frontdesk-install.json');
    const firstReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const currentPath = path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'current.json');
    const current = fs.readFileSync(currentPath, 'utf8');
    const before = hashTree(w.home);
    const again = install(w, ['--yes', '--tools', 'claude']);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /already installed, nothing to do/);
    assert.deepEqual(hashTree(w.home), before);
    assert.equal(fs.readFileSync(currentPath, 'utf8'), current);
    assert.equal(fs.existsSync(path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'bin.prev')), false);
    const secondReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(secondReceipt.hooks.claude.backup, firstReceipt.hooks.claude.backup);
    assert.equal(secondReceipt.hooks.claude.command, firstReceipt.hooks.claude.command);
  } finally { rm(w.root); }
});

test('a second settings failure restores the first settings file byte-for-byte', () => {
  const root = tmp('fd-settings-transaction-');
  try {
    const first = path.join(root, 'claude.json'), second = path.join(root, 'codex.toml');
    fs.writeFileSync(first, 'claude original'); fs.writeFileSync(second, 'codex original');
    const plans = [
      { tool: 'claude', file: first, before: 'claude original', after: 'claude changed' },
      { tool: 'codex', file: second, before: 'codex original', after: 'codex changed' },
    ];
    assert.throws(() => applySettingsPlans(plans, {
      backupFile: (file) => { const saved = `${file}.backup`; fs.copyFileSync(file, saved); return saved; },
      writeFile: (file, text) => fs.writeFileSync(file, text),
      afterWrite: (h) => { if (h.tool === 'codex') throw new Error('fake Codex check failure'); },
    }), /fake Codex check failure/);
    assert.equal(fs.readFileSync(first, 'utf8'), 'claude original');
    assert.equal(fs.readFileSync(second, 'utf8'), 'codex original');
  } finally { rm(root); }
});

test('Codex TOML validation tries python then py -3, and refuses parse errors', () => {
  const calls = [];
  const ok = validateCodexConfig('candidate config', (command, args, options) => {
    calls.push({ command, args, options });
    return command === 'python' ? { error: { code: 'ENOENT', name: 'Error' } } : { status: 0 };
  });
  assert.deepEqual(ok, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'python');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-I', '-c']);
  assert.match(calls[0].args[2], /tomllib\.load\(sys\.stdin\.buffer\)/);
  assert.equal(calls[1].command, 'py');
  assert.deepEqual(calls[1].args.slice(0, 3), ['-3', '-I', '-c']);
  assert.equal(calls[0].options.input.toString(), 'candidate config');
  const parseFailThenFallback = validateCodexConfig('candidate config', (command) => command === 'python' ? { status: 1, stderr: 'parse failed' } : { status: 0 });
  assert.equal(parseFailThenFallback.ok, true);
  const bad = validateCodexConfig('invalid', () => ({ status: 1 }));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /rejected/);
  const missing = validateCodexConfig('candidate', () => ({ error: { code: 'ENOENT', name: 'Error' } }));
  assert.equal(missing.ok, false);
  assert.match(missing.message, /no usable Python/);
  const storeStub = validateCodexConfig('candidate', () => ({ status: 9009, stderr: 'Python was not found' }));
  assert.match(storeStub.message, /no usable Python/);
  const withoutTomllib = validateCodexConfig('candidate', () => ({ status: 1, stderr: "ModuleNotFoundError: No module named 'tomllib'" }));
  assert.match(withoutTomllib.message, /no usable Python/);
});

function fakeChild({ output = 'ok\n' } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.prompt = '';
  child.stdin.on('data', (chunk) => { child.prompt += chunk; });
  child.complete = (code = 0) => { if (output) child.stdout.emit('data', Buffer.from(output)); child.emit('close', code); };
  return child;
}

test('Codex live check uses detected executable, safe arguments, and sends its prompt on stdin', async () => {
  const root = tmp('fd-codex-check-');
  let seen, child;
  try {
    const ok = await runCodexLiveCheck('C:/Users/test/codex.exe', 'C:/Users/test home', {
      tempRoot: root,
      spawnProcess: (command, args, options) => {
        seen = { command, args, options };
        assert.equal(fs.readdirSync(options.cwd).length, 0);
        child = fakeChild();
        setImmediate(() => child.complete(0));
        return child;
      },
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.firstLine, 'ok');
    assert.equal(seen.command, 'C:/Users/test/codex.exe');
    assert.deepEqual(seen.args, ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', seen.options.cwd, '-c', 'model_reasoning_effort=low', ...LIVE_CHECK_OFF.flatMap((n) => ['-c', `features.${n}=false`]), '-']);
    assert.equal(child.prompt, 'Reply with the single word ok. Do not call any tool.');
    assert.equal(seen.options.env.CODEX_HOME, path.join('C:/Users/test home', '.codex'));
    assert.equal(seen.options.shell, undefined);
  } finally { rm(root); }
});

test('Codex cmd wrappers receive one quoted command string with the prompt only on stdin', async () => {
  const root = tmp('fd-codex-cmd-');
  let seen, child;
  try {
    const result = await runCodexLiveCheck('C:/Users/test home/.codex/codex.cmd', 'C:/Users/test home', {
      tempRoot: root,
      spawnProcess: (command, args, options) => {
        seen = { command, args, options };
        child = fakeChild();
        setImmediate(() => child.complete(0));
        return child;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(seen.command, 'cmd.exe');
    assert.deepEqual(seen.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(seen.args[3], /^""C:\/Users\/test home\/\.codex\/codex\.cmd" exec /);
    assert.match(seen.args[3], / features\.image_generation=false -"$/);
    assert.equal(child.prompt, 'Reply with the single word ok. Do not call any tool.');
  } finally { rm(root); }
});

test('Codex live check kills a timed out process tree and waits for close', async () => {
  const root = tmp('fd-codex-timeout-');
  let killed = false;
  try {
    const result = await runCodexLiveCheck('C:/tools/codex.exe', 'C:/home', {
      timeoutMs: 20, tempRoot: root,
      spawnProcess: () => fakeChild(),
      killTree: (child) => { killed = true; child.complete(1); },
    });
    assert.equal(killed, true);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.message, /timed out/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { rm(root); }
});

test('Codex live check names the error code and the program when Codex cannot start', async () => {
  const root = tmp('fd-codex-enoent-');
  const gone = 'C:/Users/test/AppData/Local/OpenAI/Codex/bin/old/codex.exe';
  try {
    const late = await runCodexLiveCheck(gone, 'C:/home', {
      tempRoot: root,
      spawnProcess: () => { const child = fakeChild(); setImmediate(() => child.emit('error', Object.assign(new Error(`spawn ${gone} ENOENT`), { code: 'ENOENT' }))); return child; },
    });
    assert.equal(late.ok, false);
    assert.equal(late.message, `Codex live check failed: ENOENT starting ${gone}`);
    const early = await runCodexLiveCheck(gone, 'C:/home', { tempRoot: root, spawnProcess: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
    assert.equal(early.ok, false);
    assert.equal(early.message, `Codex live check failed: EACCES starting ${gone}`);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { rm(root); }
});

test('the live check detects Codex again instead of trusting a cached path the Codex app has replaced', () => {
  const f = installFake();
  try {
    fs.writeFileSync(path.join(f.L.state, 'tools.json'), JSON.stringify({ detectedAt: new Date().toISOString(), tools: { codex: { path: 'C:/apps/Codex/bin/old/codex.exe', version: '0.163.0' } } }));
    const fresh = { detectedAt: new Date().toISOString(), tools: { codex: { path: 'C:/apps/Codex/bin/new/codex.exe', version: '0.163.0' } } };
    assert.equal(codexForLiveCheck(f.L, (L, opts) => loadTools(L, { ...opts, detect: () => fresh })), 'C:/apps/Codex/bin/new/codex.exe');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.L.state, 'tools.json'), 'utf8')), fresh);
    assert.equal(codexForLiveCheck(f.L, () => ({ tools: { codex: null } })), undefined);
  } finally { rm(f.home); }
});

test('settings writes recheck snapshots and refuse symbolic links', () => {
  const root = tmp('fd-settings-race-');
  try {
    const file = path.join(root, 'settings.json');
    fs.writeFileSync(file, 'before');
    fs.writeFileSync(file, 'changed after planning');
    assert.throws(() => verifySettingsSnapshot(file, 'before'), /changed after it was read/);
    fs.writeFileSync(file, 'before');
    assert.throws(() => applySettingsPlans([{ file, before: 'before', after: 'installed' }], {
      backupFile: (target) => { const saved = `${target}.backup`; fs.copyFileSync(target, saved); fs.writeFileSync(target, 'raced'); return saved; },
    }), /changed after it was read/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'raced');
    const fakeLinkFs = { lstatSync: () => ({ isSymbolicLink: () => true }), readFileSync: () => 'before' };
    assert.throws(() => verifySettingsSnapshot(file, 'before', fakeLinkFs), /symbolic link/);
  } finally { rm(root); }
});

test('settings rollback reports a failed restore with both paths', () => {
  const root = tmp('fd-restore-failure-');
  const first = path.join(root, 'claude.json'), second = path.join(root, 'codex.toml');
  fs.writeFileSync(first, 'old claude'); fs.writeFileSync(second, 'old codex');
  let failure;
  try {
    try {
      applySettingsPlans([
        { tool: 'claude', file: first, before: 'old claude', after: 'new claude' },
        { tool: 'codex', file: second, before: 'old codex', after: 'new codex' },
      ], {
        backupFile: (file) => { const saved = `${file}.backup`; fs.copyFileSync(file, saved); return saved; },
        writeFile: (file, text) => fs.writeFileSync(file, text),
        restoreFile: (saved, file) => { if (file === first) throw new Error('forced restore failure'); fs.copyFileSync(saved, file); },
        afterWrite: (h) => { if (h.tool === 'codex') throw new Error('second tool failed'); },
      });
    } catch (error) { failure = error; }
    assert.match(failure.message, /second tool failed/);
    assert.deepEqual(failure.restoreFailures, [{ path: first, backupPath: `${first}.backup`, reason: 'forced restore failure' }]);
    assert.equal(fs.readFileSync(second, 'utf8'), 'old codex');
    assert.equal(fs.readFileSync(first, 'utf8'), 'new claude');
  } finally { rm(root); }
});

test('settings rollback preserves a file changed after this installer wrote it', () => {
  const root = tmp('fd-restore-race-');
  const first = path.join(root, 'claude.json'), second = path.join(root, 'codex.toml');
  fs.writeFileSync(first, 'old claude'); fs.writeFileSync(second, 'old codex');
  let failure;
  try {
    try {
      applySettingsPlans([
        { tool: 'claude', file: first, before: 'old claude', after: 'new claude' },
        { tool: 'codex', file: second, before: 'old codex', after: 'new codex' },
      ], {
        backupFile: (file) => { const saved = `${file}.backup`; fs.copyFileSync(file, saved); return saved; },
        writeFile: (file, text) => fs.writeFileSync(file, text),
        afterWrite: (h) => {
          if (h.tool === 'claude') fs.writeFileSync(first, 'external edit');
          else throw new Error('second tool failed');
        },
      });
    } catch (error) { failure = error; }
    assert.equal(fs.readFileSync(first, 'utf8'), 'external edit');
    assert.ok(failure.restoreFailures.some((x) => x.path === first && /changed after this install wrote it/.test(x.reason)));
  } finally { rm(root); }
});

test('doctor says healthy after install and BROKEN after a program file is changed', () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--tools', 'claude']).status, 0);
    const ok = role(w, ['doctor']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /HEALTHY/);
    assert.match(ok.stdout, /hooks: claude configured, muse not covered \(user-level hook location unproven\), codex not installed/);
    fs.appendFileSync(path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'bin', 'role.mjs'), '\n// tampered\n');
    const bad = role(w, ['doctor']);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /BROKEN/);
    const plan = role(w, ['plan']);
    assert.notEqual(plan.status, 0);
    assert.match(plan.stdout, /BROKEN|do not fall back/i);
  } finally { rm(w.root); }
});

test('installer refuses every hook write when mode is enforced, corrupt, or unreadable', () => {
  for (const setup of [
    (w) => ({ env: { FRONTDESK_GUARD_MODE: 'enforce' }, expected: /guard mode for claude is enforce/ }),
    (w) => ({ env: { FRONTDESK_GUARD_MODE: 'unknown' }, expected: /guard mode for claude is unknown \(mode_unreadable\)/ }),
    (w) => {
      const file = path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'state', 'mode.json');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{');
      return { env: {}, expected: /guard mode is unreadable/ };
    },
    (w) => {
      const file = path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'state', 'mode.json');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.mkdirSync(file);
      return { env: {}, expected: /guard mode is unreadable/ };
    },
  ]) {
    const w = world();
    try {
      const { env, expected } = setup(w);
      const result = install(w, ['--yes', '--tools', 'claude'], env);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, expected);
      assert.equal(fs.existsSync(path.join(w.home, '.config', 'delegate-skills', 'frontdesk-install.json')), false);
      assert.equal(read(w, '.claude/settings.json'), CLAUDE);
    } finally { rm(w.root); }
  }
});

test('doctor reports corrupt and unreadable mode files as UNKNOWN and treats forced enforce as effective', () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--no-hooks']).status, 0);
    const mode = path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'state', 'mode.json');
    fs.writeFileSync(mode, '{');
    const corrupt = role(w, ['doctor', '--json']);
    assert.equal(corrupt.status, 1);
    assert.match(corrupt.stdout, /UNKNOWN \(mode_unreadable\)/);
    fs.unlinkSync(mode); fs.mkdirSync(mode);
    const unreadable = role(w, ['doctor', '--json']);
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stdout, /UNKNOWN \(mode_unreadable\)/);
    fs.rmSync(mode, { recursive: true });
    const enforced = role(w, ['doctor', '--json'], { FRONTDESK_GUARD_MODE: 'enforce' });
    assert.equal(enforced.status, 0, enforced.stdout + enforced.stderr);
    assert.deepEqual(JSON.parse(enforced.stdout).modes, { claude: 'enforce', codex: 'enforce', muse: 'enforce' });
    assert.match(role(w, ['doctor'], { FRONTDESK_GUARD_MODE: 'enforce' }).stdout, /WARNING: one or more tools are not in shadow mode/);
    const invalidEnv = role(w, ['doctor', '--json'], { FRONTDESK_GUARD_MODE: 'unknown' });
    assert.equal(invalidEnv.status, 1);
    assert.match(invalidEnv.stdout, /UNKNOWN \(mode_unreadable\)/);
  } finally { rm(w.root); }
});

test('doctor distinguishes configured, pending approval and proven hooks and reports effective modes', async () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--tools', 'claude']).status, 0);
    const receiptPath = path.join(w.home, '.config', 'delegate-skills', 'frontdesk-install.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const codexCommand = receipt.hooks.claude.command.replace(/ claude --fd-guard$/, ' codex --fd-guard');
    const codexFile = path.join(w.home, '.codex', 'config.toml');
    const beforeManaged = `${CODEX}\n[[hooks.PreToolUse]]\nmatcher = "other-before"\n`;
    const afterManaged = `\n[[hooks.PreToolUse]]\nmatcher = "other-after"\n`;
    fs.writeFileSync(codexFile, addCodex(beforeManaged, codexCommand) + afterManaged);
    receipt.hooks.codex = { file: codexFile, command: codexCommand, backup: null, installedAt: receipt.installedAt };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));

    const pending = role(w, ['doctor', '--json']);
    assert.equal(pending.status, 0, pending.stdout + pending.stderr);
    const pendingJson = JSON.parse(pending.stdout);
    assert.equal(pendingJson.hooks.claude.status, 'configured');
    assert.equal(pendingJson.hooks.codex.status, 'pending approval');
    assert.equal(pendingJson.hooks.codex.pendingApproval, true);
    assert.equal(pendingJson.hooks.muse.status, 'not covered (user-level hook location unproven)');
    assert.match(role(w, ['doctor']).stdout, /muse not covered \(user-level hook location unproven\)/);
    assert.equal(pendingJson.hookCommands.claude.nodeExists, true);
    assert.equal(pendingJson.hookCommands.claude.hookExists, true);
    assert.equal(pendingJson.hookCommands.codex.nodeExists, true);
    assert.equal(pendingJson.hookCommands.codex.hookExists, true);

    fs.writeFileSync(codexFile, addCodex(beforeManaged, codexCommand) + `${afterManaged}\n[hooks.state]\ntrusted_hash = "sha256:unknown"\n`);
    const unverifiable = role(w, ['doctor', '--json']);
    assert.equal(JSON.parse(unverifiable.stdout).hooks.codex.status, 'configured (approval not verifiable)');
    fs.writeFileSync(codexFile, addCodex(beforeManaged, codexCommand) + afterManaged);

    fs.appendFileSync(codexFile, `\n[hooks.state.'C:\\Users\\X\\.codex\\config.toml:pre_tool_use:2:0']\ntrusted_hash = "sha256:fd-guard"\n`);
    const configured = role(w, ['doctor', '--json']);
    assert.equal(JSON.parse(configured.stdout).hooks.codex.status, 'configured');

    const guardLogs = { logs: path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'logs') };
    await logRecord(guardLogs, { tool: 'codex', gen: receipt.generation, fault: 'bad_payload' });
    await logRecord(guardLogs, { tool: 'codex', gen: receipt.generation, decision: 'allow', t: new Date(Date.parse(receipt.installedAt) - 1000).toISOString() });
    await logRecord(guardLogs, { tool: 'codex', gen: receipt.generation + 1, decision: 'allow' });
    const notProven = role(w, ['doctor', '--json']);
    assert.equal(JSON.parse(notProven.stdout).hooks.codex.proven, false);

    const modeFile = path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'state', 'mode.json');
    fs.writeFileSync(modeFile, JSON.stringify({ default: 'shadow', codex: 'enforce' }));
    const stored = role(w, ['doctor', '--json']);
    const storedJson = JSON.parse(stored.stdout);
    assert.equal(storedJson.modes.codex, 'enforce');
    assert.match(role(w, ['doctor']).stdout, /WARNING: one or more tools are not in shadow mode/);
    const forced = role(w, ['doctor', '--json'], { FRONTDESK_GUARD_MODE: 'shadow' });
    assert.deepEqual(JSON.parse(forced.stdout).modes, { claude: 'shadow', codex: 'shadow', muse: 'shadow' });

    await logRecord(guardLogs, { tool: 'codex', gen: receipt.generation, kind: 'other', name: 'wait_agent', decision: 'allow' });
    assert.equal(JSON.parse(role(w, ['doctor', '--json']).stdout).hooks.codex.proven, false, 'a wait_agent record (kind other) is not proof');

    await logRecord(guardLogs, { tool: 'codex', gen: receipt.generation, kind: 'spawn_agent', decision: 'allow' });
    const proven = role(w, ['doctor', '--json']);
    assert.equal(JSON.parse(proven.stdout).hooks.codex.status, 'proven');
    assert.equal(JSON.parse(proven.stdout).hooks.claude.status, 'configured');

    const configText = fs.readFileSync(codexFile, 'utf8');
    fs.writeFileSync(codexFile, configText.replace(/# >>> frontdesk-guard[\s\S]*?# <<< frontdesk-guard <<<\r?\n/, '')); // another hook sits after ours here, so the product code would rightly refuse to renumber it
    const removed = JSON.parse(role(w, ['doctor', '--json']).stdout).hooks.codex;
    assert.equal(removed.proven, false, 'records from a hook that is no longer configured are not proof');
    assert.equal(removed.status, 'not installed');
  } finally { rm(w.root); }
});

test('a machine that was never installed is told to use the legacy routes', () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--no-hooks']).status, 0);
    fs.unlinkSync(path.join(w.home, '.config', 'delegate-skills', 'frontdesk-install.json'));
    const r = role(w, ['plan']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /not installed|legacy/i);
  } finally { rm(w.root); }
});

test('an unreadable Claude settings file is left untouched while the program installs', () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.home, '.claude', 'settings.json'), '{ this is not json');
    const r = install(w, ['--yes', '--tools', 'claude']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /could not be read/);
    assert.equal(read(w, '.claude/settings.json'), '{ this is not json');
    assert.equal(read(w, '.codex/config.toml'), CODEX);
  } finally { rm(w.root); }
});

test('an invalid receipt is backed up and blocks install without being overwritten', () => {
  const w = world();
  const receiptPath = path.join(w.home, '.config', 'delegate-skills', 'frontdesk-install.json');
  const invalid = '{ receipt is broken';
  try {
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, invalid);
    const result = install(w, ['--yes', '--tools', 'claude']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /receipt is invalid/);
    assert.equal(fs.readFileSync(receiptPath, 'utf8'), invalid);
    const backupPath = result.stderr.match(/backup saved to (.+); refusing/)[1];
    assert.equal(fs.readFileSync(backupPath, 'utf8'), invalid);
  } finally { rm(w.root); }
});

test('--no-hooks installs the program and the generation but touches no settings file', () => {
  const w = world();
  try {
    const before = { c: read(w, '.claude/settings.json'), m: read(w, '.config/muse/settings.json'), x: read(w, '.codex/config.toml') };
    assert.equal(install(w, ['--yes', '--no-hooks']).status, 0);
    assert.equal(read(w, '.claude/settings.json'), before.c);
    assert.equal(read(w, '.config/muse/settings.json'), before.m);
    assert.equal(read(w, '.codex/config.toml'), before.x);
  } finally { rm(w.root); }
});

test('uninstall puts the three settings files back exactly and removes the receipt', () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--tools', 'claude']).status, 0);
    const u = install(w, ['uninstall', '--yes']);
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.equal(read(w, '.claude/settings.json'), CLAUDE);
    assert.equal(read(w, '.config/muse/settings.json'), MUSE);
    assert.equal(read(w, '.codex/config.toml'), CODEX);
    assert.ok(!fs.existsSync(path.join(w.home, '.config', 'delegate-skills', 'frontdesk-install.json')));
  } finally { rm(w.root); }
});

test('selective uninstall removes only the chosen tool record and keeps the receipt', () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--tools', 'claude']).status, 0);
    const receiptPath = path.join(w.home, '.config', 'delegate-skills', 'frontdesk-install.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const command = receipt.hooks.claude.command.replace(/ claude --fd-guard$/, ' codex --fd-guard');
    fs.writeFileSync(path.join(w.home, '.codex', 'config.toml'), addCodex(CODEX, command));
    receipt.hooks.codex = { file: path.join(w.home, '.codex', 'config.toml'), command, backup: null };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));

    const u = install(w, ['uninstall', '--yes', '--tools', 'codex']);
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.match(u.stdout, /receipt kept for hooks: claude/);
    const after = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.deepEqual(Object.keys(after.hooks), ['claude']);
    assert.equal(read(w, '.codex/config.toml'), CODEX);
    assert.ok(JSON.parse(read(w, '.claude/settings.json')).hooks.PreToolUse);
  } finally { rm(w.root); }
});

test('default uninstall also removes a Muse hook recorded by an older install', () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--tools', 'claude']).status, 0);
    const receiptPath = path.join(w.home, '.config', 'delegate-skills', 'frontdesk-install.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const command = receipt.hooks.claude.command.replace(/ claude --fd-guard$/, ' muse --fd-guard');
    const museFile = path.join(w.home, '.config', 'muse', 'settings.json');
    fs.writeFileSync(museFile, addMuse(MUSE, command));
    receipt.hooks.muse = { file: museFile, command, backup: null };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    const removed = install(w, ['uninstall', '--yes']);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(read(w, '.config/muse/settings.json'), MUSE);
    assert.equal(fs.existsSync(receiptPath), false);
  } finally { rm(w.root); }
});

test('an uninstall skipped because a settings file is missing keeps its hook receipt and reports incomplete', () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--tools', 'claude']).status, 0);
    const receiptPath = path.join(w.home, '.config', 'delegate-skills', 'frontdesk-install.json');
    fs.unlinkSync(path.join(w.home, '.claude', 'settings.json'));
    const u = install(w, ['uninstall', '--yes', '--tools', 'claude']);
    assert.equal(u.status, 1, u.stdout + u.stderr);
    assert.match(u.stdout, /settings\.json is missing; skipped/);
    assert.match(u.stdout, /uninstall incomplete; receipt kept/);
    assert.ok(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).hooks.claude);
  } finally { rm(w.root); }
});

test('a hand-edited Codex block makes uninstall incomplete and retains its receipt record', () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--tools', 'claude']).status, 0);
    const receiptPath = path.join(w.home, '.config', 'delegate-skills', 'frontdesk-install.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const command = receipt.hooks.claude.command.replace(/ claude --fd-guard$/, ' codex --fd-guard');
    const codexFile = path.join(w.home, '.codex', 'config.toml');
    const edited = addCodex(CODEX, command).replace(/timeout = 5(?![\s\S]*timeout = 5)/, 'timeout = 9');
    fs.writeFileSync(codexFile, edited);
    receipt.hooks.codex = { file: codexFile, command, backup: null };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));

    const u = install(w, ['uninstall', '--yes', '--tools', 'claude,codex']);
    assert.equal(u.status, 1, u.stdout + u.stderr);
    assert.match(u.stdout, /marked block was edited by hand/);
    assert.match(u.stdout, /timeout = 9/);
    assert.match(u.stdout, /uninstall incomplete; receipt kept/);
    assert.equal(read(w, '.claude/settings.json'), CLAUDE);
    assert.equal(read(w, '.codex/config.toml'), edited);
    const after = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.deepEqual(Object.keys(after.hooks), ['codex']);
  } finally { rm(w.root); }
});

test('a published release that does not match its manifest is refused and the home is untouched', () => {
  const w = world();
  try {
    const rel = fs.readdirSync(path.join(w.shared, 'ladder', 'releases'))[0];
    fs.appendFileSync(path.join(w.shared, 'ladder', 'releases', rel, 'ladder.json'), ' ');
    const before = hashTree(w.home);
    const r = install(w, ['--yes']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not match its manifest/);
    assert.deepEqual(hashTree(w.home), before);
  } finally { rm(w.root); }
});

test('front desk code that does not match its code manifest is refused', () => {
  const w = world();
  try {
    fs.appendFileSync(path.join(w.shared, 'frontdesk', 'role.mjs'), '\n// half synced\n');
    const r = install(w, ['--yes']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /code manifest/);
  } finally { rm(w.root); }
});

test('after a new release is published, installing again switches the generation and keeps the previous one for rollback', () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--no-hooks']).status, 0);
    fixtureRelease(w.shared, { generation: 2 });
    assert.equal(install(w, ['--yes', '--no-hooks']).status, 0);
    const cur = JSON.parse(read(w, '.config/delegate-skills/frontdesk/current.json'));
    assert.equal(cur.generation, 2);
    assert.equal(cur.previous.generation, 1);
    assert.equal(fs.readdirSync(path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'generations')).length, 2);
    assert.match(role(w, ['doctor']).stdout, /HEALTHY/);
  } finally { rm(w.root); }
});

test('role plan on an installed machine names the engineer that would be called (tools pre-seeded so no CLI is probed)', () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--no-hooks']).status, 0);
    const st = path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'state');
    fs.mkdirSync(st, { recursive: true });
    const t = { path: 'x', version: '99.0.0' };
    fs.writeFileSync(path.join(st, 'tools.json'), JSON.stringify({ detectedAt: new Date().toISOString(), tools: { claude: t, codex: t, cursor: t, muse: t, qwen: null } }));
    const r = role(w, ['plan', 'Tech lead', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.roles[0].role, 'Tech lead');
    assert.ok(j.roles[0].engineers.some((e) => e.wouldBeCalled));
    assert.equal(j.roles[0].engineers[0].key, 'grok-4.7|high', 'the owner placed Grok 4.7 high first among the Tech leads');
  } finally { rm(w.root); }
});

test('role plan CTO skips both Wonder families with billing_unverified', () => {
  const w = world({ wonderHold: true });
  try {
    assert.equal(install(w, ['--yes', '--no-hooks']).status, 0);
    const state = path.join(w.home, '.config', 'delegate-skills', 'frontdesk', 'state');
    fs.mkdirSync(state, { recursive: true });
    const tool = { path: 'cached-tool', version: '99.0.0' };
    fs.writeFileSync(path.join(state, 'tools.json'), JSON.stringify({ detectedAt: new Date().toISOString(), tools: { claude: tool, codex: tool, cursor: tool, muse: tool, qwen: null } }));
    const r = role(w, ['plan', 'CTO', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const rows = JSON.parse(r.stdout).roles[0].engineers.filter((e) => e.key.startsWith('muse-wonder'));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((e) => !e.eligible && e.reasons.some((x) => x.code === 'billing_unverified')));
  } finally { rm(w.root); }
});

test('role list identifies the two Wonder billing holds', () => {
  const w = world({ wonderHold: true });
  try {
    assert.equal(install(w, ['--yes', '--no-hooks']).status, 0);
    const listed = role(w, ['list']);
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    assert.equal([...listed.stdout.matchAll(/held \(billing unconfirmed\)/g)].length, 2);
  } finally { rm(w.root); }
});

test('uninstall removes our Codex hook from a file Codex rewrote around it and keeps every other table and the receipt record of Claude', () => {
  const w = world();
  try {
    assert.equal(install(w, ['--yes', '--tools', 'claude']).status, 0);
    const receiptPath = path.join(w.home, '.config', 'delegate-skills', 'frontdesk-install.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const command = receipt.hooks.claude.command.replace(/ claude --fd-guard$/, ' codex --fd-guard');
    const codexFile = path.join(w.home, '.codex', 'config.toml');
    const rewritten = addCodex(CODEX, command).replace('# <<< frontdesk-guard <<<\n', `\n[hooks.state.'${codexFile}:pre_tool_use:1:0']\ntrusted_hash = "sha256:ours"\nenabled = true\n# <<< frontdesk-guard <<<\n`);
    fs.writeFileSync(codexFile, rewritten);
    receipt.hooks.codex = { file: codexFile, command, backup: null };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));

    const dry = install(w, ['uninstall', '--tools', 'codex']);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /remove entry/);
    assert.equal(fs.readFileSync(codexFile, 'utf8'), rewritten, 'a dry run changes nothing');

    const u = install(w, ['uninstall', '--yes', '--tools', 'codex']);
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.equal(fs.readFileSync(codexFile, 'utf8'), CODEX);
    const after = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.deepEqual(Object.keys(after.hooks), ['claude']);
  } finally { rm(w.root); }
});

test('the Codex live check runs after a program upgrade even when the config text is unchanged, and not for a skipped or Claude-only install', () => {
  assert.equal(shouldRunCodexLiveCheck([{ tool: 'codex', same: true }]), true);
  assert.equal(shouldRunCodexLiveCheck([{ tool: 'codex', same: false }]), true);
  assert.equal(shouldRunCodexLiveCheck([{ tool: 'claude', same: false }]), false);
  assert.equal(shouldRunCodexLiveCheck([{ tool: 'claude', same: false }], false, { hooks: { codex: { file: 'x' } } }), true, 'a Claude-only upgrade under a live Codex hook is checked too');
  assert.equal(shouldRunCodexLiveCheck([{ tool: 'codex', same: false }], true), false);
});

test('the hook smoke run passes for a silent exit 0 and fails for output, a non-zero exit or a timeout', () => {
  const ok = smokeHook({ node: 'n', script: 's' }, 'claude', { spawnFn: () => ({ status: 0, stdout: '', stderr: '' }) });
  assert.equal(ok.ok, true);
  assert.equal(smokeHook({ node: 'n', script: 's' }, 'codex', { spawnFn: () => ({ status: 0, stdout: 'hello', stderr: '' }) }).ok, false);
  assert.equal(smokeHook({ node: 'n', script: 's' }, 'claude', { spawnFn: () => ({ status: 1, stdout: '', stderr: '' }) }).ok, false);
  const timeout = smokeHook({ node: 'n', script: 's' }, 'claude', { spawnFn: () => ({ status: null, error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }) });
  assert.equal(timeout.ok, false);
  assert.match(timeout.message, /ETIMEDOUT/);
  let seen;
  smokeHook({ node: 'n', script: 's' }, 'codex', { spawnFn: (cmd, args, opts) => { seen = { cmd, args, opts }; return { status: 0, stdout: '', stderr: '' }; } });
  assert.deepEqual(seen.args, ['s', 'codex', '--fd-guard']);
  assert.equal(JSON.parse(seen.opts.input).tool_name, 'spawn_agent');
  assert.equal(seen.opts.env.FRONTDESK_GUARD_MODE, 'shadow');
});
