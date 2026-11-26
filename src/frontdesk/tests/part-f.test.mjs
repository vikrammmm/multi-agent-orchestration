// Part F contract: only throwaway homes and fixed releases; never a live register, tool account or publisher.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { eligibleEngineer, eligibleRoute } from '../lib/eligible.mjs';
import { installState, TEAM_REQUIRED_EXCLUSIONS } from '../lib/receipts.mjs';
import { backupFile } from '../install-frontdesk.mjs';
import { runHook } from '../hook.mjs';
import { seal } from '../seal.mjs';
import { claudeAgent, claudeWorkflow, codexSpawn } from './fixtures.mjs';
import { fixtureWorld, fixtureRelease, installFake, miniLadder, rm, snapshot, testEnv } from './helpers.mjs';

const invoke = (w, args = [], env = {}, nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, w.installer, 'install', '--no-hooks', '--no-live-check', '--home', w.home, '--shared-root', w.shared, ...args], { encoding: 'utf8', env: testEnv(w.home, env), timeout: 15000 });
const role = (w, args) => spawnSync(process.execPath, [path.join(w.L.bin, 'role.mjs'), ...args], { encoding: 'utf8', env: testEnv(w.home), timeout: 15000 });
const receipt = (w) => JSON.parse(fs.readFileSync(w.L.receipt, 'utf8'));
const save = (w, value) => fs.writeFileSync(w.L.receipt, JSON.stringify(value));
const ok = (r) => assert.equal(r.status, 0, r.stdout + r.stderr);
const hooks = { FRONTDESK_TEST_HOOKS: '1', FRONTDESK_TEST_FAIL: 'before-commit' };
const team = ['--installed-by', 'team-packet'];
const seedTools = (w) => {
  const t = { path: path.join(w.home, 'fixture-tool'), version: '99.0.0' };
  fs.writeFileSync(path.join(w.L.state, 'tools.json'), JSON.stringify({ detectedAt: new Date().toISOString(), tools: Object.fromEntries(['qwen', 'cursor', 'codex', 'claude', 'muse'].map((k) => [k, t])) }));
};
const active = (w) => ({ frontdesk: snapshot(w.L.frontdesk), receipt: fs.readFileSync(w.L.receipt, 'utf8') });

test('family exclusion refuses the engineer with the matching id as detail', () => {
  const e = miniLadder().roles[1].engineers[0];
  e.routes[0].exec.model = 'route-model';
  const ctx = { excluded: new Set(['b']), tools: { codex: { version: '99' } } };
  assert.deepEqual(eligibleEngineer(e, ctx).reasons, [{ code: 'excluded_here', detail: 'b' }]);
  assert.equal(eligibleEngineer(e, { ...ctx, excluded: new Set() }).ok, true);
});

test('route model exclusion refuses only that route, including ids unlike the family', () => {
  const e = miniLadder().roles[1].engineers[0];
  const rt = { ...e.routes[0], exec: { model: 'grok-4.7-xhigh-fast' } };
  const ctx = { excluded: new Set(['grok-4.7-xhigh-fast']), tools: { codex: { version: '99' } } };
  assert.deepEqual(eligibleRoute(e, rt, ctx).reasons, [{ code: 'excluded_here', detail: 'grok-4.7-xhigh-fast' }]);
  assert.equal(eligibleEngineer({ ...e, routes: [rt, e.routes[0]] }, ctx).ok, true);
});

const invalid = [
  ['team exclusions missing', { installedBy: 'team-packet' }],
  ['team exclusions empty', { installedBy: 'team-packet', exclusions: { required: [], declared: [] } }],
  ['team mandatory id only declared', { installedBy: 'team-packet', exclusions: { required: ['other'], declared: ['qwen-local'] } }],
  ['installedBy null', { installedBy: null }],
  ['installedBy object', { installedBy: {} }],
  ['installedBy unknown', { installedBy: 'owner' }],
  ['exclusions null', { exclusions: null }],
  ['exclusions array', { exclusions: [] }],
  ['required missing', { exclusions: { declared: [] } }],
  ['declared missing', { exclusions: { required: [] } }],
  ['required string', { exclusions: { required: 'qwen-local', declared: [] } }],
  ['declared string', { exclusions: { required: [], declared: 'other' } }],
  ['invalid id', { exclusions: { required: ['bad/id'], declared: [] } }],
  ['newline id', { exclusions: { required: ['bad\n'], declared: [] } }],
  ['nonstring id', { exclusions: { required: [], declared: [1] } }],
  ['duplicate ids', { exclusions: { required: ['a', 'a'], declared: [] } }],
  ['unsorted ids', { exclusions: { required: [], declared: ['z', 'a'] } }],
];
for (const [name, fields] of invalid) test(`installState and role plan/list fail closed: ${name}`, () => {
  const w = fixtureWorld();
  try {
    ok(invoke(w, ['--yes']));
    save(w, { ...receipt(w), ...fields });
    const st = installState(w.L);
    assert.equal(st.state, 'broken');
    assert.ok(st.problems.some((p) => /receipt\.(exclusions|installedBy)/.test(p.file)));
    for (const args of [['plan', 'Junior'], ['plan', 'Developer'], ['list']]) {
      const r = role(w, [...args, '--json']);
      assert.equal(r.status, 3, r.stdout + r.stderr);
      assert.equal(JSON.parse(r.stdout).state, 'broken');
      assert.doesNotMatch(r.stdout, /engineers|wouldBeCalled/);
    }
  } finally { rm(w.root); }
});

test('owner-style receipt preserves role plan/list outputs for all four roles with no exclusions', () => {
  const w = fixtureWorld();
  try {
    ok(invoke(w, ['--yes'])); seedTools(w);
    const owner = receipt(w);
    assert.equal('installedBy' in owner, false); assert.equal('exclusions' in owner, false);
    assert.equal(installState(w.L).state, 'healthy');
    const before = ['Junior', 'Developer', 'Tech lead', 'CTO'].map((r) => role(w, ['plan', r, '--json']).stdout);
    const listed = role(w, ['list', '--json']).stdout;
    save(w, { ...owner, exclusions: { required: [], declared: [] } });
    assert.deepEqual(['Junior', 'Developer', 'Tech lead', 'CTO'].map((r) => role(w, ['plan', r, '--json']).stdout), before);
    assert.equal(role(w, ['list', '--json']).stdout, listed);
    assert.ok(before.every((text) => !text.includes('excluded_here')));
  } finally { rm(w.root); }
});

test('team plan/list use required family and declared route model exclusions; doctor prints both fields', () => {
  const w = fixtureWorld();
  try {
    ok(invoke(w, ['--yes', ...team, '--exclude-declared', 'grok-4.7-xhigh-fast'])); seedTools(w);
    for (const r of ['Junior', 'Developer']) {
      const result = JSON.parse(role(w, ['plan', r, '--json']).stdout);
      const qwen = result.roles[0].engineers.find((e) => e.key === 'qwen-local|high');
      assert.equal(qwen.eligible, false); assert.equal(qwen.wouldBeCalled, false);
      assert.ok(qwen.reasons.some((x) => x.code === 'excluded_here' && x.detail === 'qwen-local'));
    }
    const tech = JSON.parse(role(w, ['plan', 'Tech lead', '--json']).stdout).roles[0].engineers[0];
    assert.equal(tech.eligible, false); assert.ok(tech.reasons.some((x) => x.detail === 'grok-4.7-xhigh-fast'));
    const listed = role(w, ['list', '--json']); ok(listed);
    assert.ok(JSON.parse(listed.stdout).roles.flatMap((r) => r.engineers).some((e) => e.reasons?.some((x) => x.code === 'excluded_here')));
    assert.match(role(w, ['list']).stdout, /excluded_here/);
    const doctor = role(w, ['doctor', '--json']); ok(doctor);
    assert.equal(JSON.parse(doctor.stdout).installedBy, 'team-packet');
    assert.deepEqual(JSON.parse(doctor.stdout).excluded, ['grok-4.7-xhigh-fast', ...TEAM_REQUIRED_EXCLUSIONS]);
    assert.match(role(w, ['doctor']).stdout, /installedBy: team-packet[\s\S]*exclusions:.*qwen-local/);
    // State is disposable; receipt exclusions survive removal of every state file.
    fs.rmSync(w.L.state, { recursive: true });
    const retry = role(w, ['plan', 'Junior', '--json']); ok(retry);
    assert.ok(JSON.parse(retry.stdout).roles[0].engineers[0].reasons.some((x) => x.code === 'excluded_here'));
  } finally { rm(w.root); }
});

for (const [name, args] of [
  ['bad required', ['--exclude-required', '../outside']], ['bad declared', ['--exclude-declared', 'ok,bad/id']],
  ['empty item', ['--exclude-required', 'a,,b']], ['empty required', ['--exclude-required', '']],
  ['unknown owner', ['--installed-by', 'other']], ['missing owner', ['--installed-by']],
  ['missing required', ['--exclude-required']], ['missing declared', ['--exclude-declared']],
  ['option as value', ['--exclude-declared', '--yes']],
  ['duplicate option', ['--installed-by', 'team-packet', '--installed-by', 'other']],
]) test(`installer validates options before any write: ${name}`, () => {
  const w = fixtureWorld();
  try { const before = snapshot(w.home); const r = invoke(w, ['--yes', ...args]); assert.equal(r.status, 1, r.stdout + r.stderr); assert.deepEqual(snapshot(w.home), before); }
  finally { rm(w.root); }
});

test('required and installedBy stick; declared sets exactly, stays absent an option, and clears with - or empty', () => {
  const w = fixtureWorld();
  try {
    ok(invoke(w, ['--yes', ...team, '--exclude-required', 'z,z,A_1.2-x', '--exclude-declared', 'z,a,z']));
    assert.deepEqual(receipt(w).exclusions, { required: ['A_1.2-x', 'qwen-local', 'z'], declared: ['a', 'z'] });
    ok(invoke(w, ['--yes', '--exclude-required', 'b']));
    assert.deepEqual(receipt(w).exclusions, { required: ['A_1.2-x', 'b', 'qwen-local', 'z'], declared: ['a', 'z'] });
    assert.equal(receipt(w).installedBy, 'team-packet');
    ok(invoke(w, ['--yes', '--exclude-declared', 'new'])); assert.deepEqual(receipt(w).exclusions.declared, ['new']);
    ok(invoke(w, ['--yes'])); assert.deepEqual(receipt(w).exclusions.declared, ['new']);
    ok(invoke(w, ['--yes', '--exclude-declared', '-'])); assert.deepEqual(receipt(w).exclusions.declared, []);
    ok(invoke(w, ['--yes', '--exclude-declared', 'x']));
    ok(invoke(w, ['--yes', '--exclude-declared', ''])); assert.deepEqual(receipt(w).exclusions.declared, []);
    assert.deepEqual(receipt(w).exclusions.required, ['A_1.2-x', 'b', 'qwen-local', 'z']);
  } finally { rm(w.root); }
});

test('exclusion-only update makes one atomic receipt replacement and a fresh exclusive backup; repeat is byte-identical', () => {
  const w = fixtureWorld();
  try {
    ok(invoke(w, ['--yes']));
    const old = active(w), probe = path.join(w.root, 'probe.mjs'), journal = path.join(w.root, 'renames.json');
    fs.writeFileSync(probe, `import fs from 'node:fs'; const original = fs.renameSync; fs.renameSync = (src, dst) => { if (dst === ${JSON.stringify(w.L.receipt)}) fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify([src, dst]) + '\\n'); return original(src, dst); };`);
    const env = { FRONTDESK_TEST_HOOKS: '1', FRONTDESK_TEST_STAMP: 'fixed' };
    const update = invoke(w, ['--yes', ...team], env, ['--import', pathToFileURL(probe).href]); ok(update);
    assert.match(update.stdout, /exclusions updated/);
    const renames = fs.readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(renames.length, 1);
    const [src, dst] = renames[0];
    assert.equal(dst, w.L.receipt); assert.ok(src.startsWith(w.L.receipt + '.')); assert.ok(src.endsWith('.tmp'));
    assert.deepEqual(snapshot(w.L.frontdesk), old.frontdesk);
    const dirs = fs.readdirSync(w.L.backups); assert.equal(dirs.length, 1); assert.match(dirs[0], /^fixed-.+/);
    assert.equal(fs.readFileSync(path.join(w.L.backups, dirs[0], 'frontdesk-install.json'), 'utf8'), old.receipt);
    const saved = snapshot(w.home), bytes = fs.readFileSync(w.L.receipt);
    const repeat = invoke(w, ['--yes', ...team], env); ok(repeat); assert.match(repeat.stdout, /already installed, nothing to do/);
    assert.deepEqual(fs.readFileSync(w.L.receipt), bytes); assert.deepEqual(snapshot(w.home), saved);
    ok(invoke(w, ['--yes', '--exclude-declared', 'a'], env));
    assert.equal(fs.readdirSync(w.L.backups).length, 2);
  } finally { rm(w.root); }
});

test('fresh before-commit failure removes the whole frontdesk folder and receipt; normal retry succeeds', () => {
  const w = fixtureWorld();
  try {
    const fail = invoke(w, ['--yes', ...team], hooks);
    assert.equal(fail.status, 1, fail.stdout + fail.stderr); assert.match(fail.stderr, /prior state restored/);
    assert.equal(fs.existsSync(w.L.frontdesk), false); assert.equal(fs.existsSync(w.L.receipt), false);
    ok(invoke(w, ['--yes', ...team])); assert.equal(installState(w.L).state, 'healthy');
    assert.deepEqual(receipt(w).exclusions.required, ['qwen-local']);
  } finally { rm(w.root); }
});

test('before-commit failure restores fresh hooked install settings and removes every new frontdesk folder', () => {
  const w = fixtureWorld();
  try {
    const settings = path.join(w.home, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(settings)); fs.writeFileSync(settings, '{}');
    const r = spawnSync(process.execPath, [w.installer, 'install', '--yes', '--tools', 'claude', '--no-live-check', '--home', w.home, '--shared-root', w.shared], { encoding: 'utf8', env: testEnv(w.home, hooks), timeout: 15000 });
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.equal(fs.readFileSync(settings, 'utf8'), '{}');
    assert.equal(fs.existsSync(w.L.frontdesk), false); assert.equal(fs.existsSync(w.L.receipt), false);
    assert.equal(fs.readdirSync(w.L.backups).length, 1);
  } finally { rm(w.root); }
});

for (const kind of ['upgrade', 'exclusion-only']) test(`before-commit failure preserves the previous installation and exclusions: ${kind}`, () => {
  const w = fixtureWorld();
  try {
    ok(invoke(w, ['--yes', ...team, '--exclude-declared', 'old']));
    const before = active(w);
    if (kind === 'upgrade') fixtureRelease(w.shared, { generation: 2 });
    const r = invoke(w, ['--yes', '--exclude-declared', 'new'], hooks);
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /prior state restored/);
    assert.deepEqual(active(w), before); assert.equal(installState(w.L).state, 'healthy');
    ok(invoke(w, ['--yes', '--exclude-declared', 'new'])); assert.deepEqual(receipt(w).exclusions.declared, ['new']);
  } finally { rm(w.root); }
});

test('exclusion options are install-only and cannot mutate an uninstall or status request', () => {
  const w = fixtureWorld();
  try {
    ok(invoke(w, ['--yes', ...team])); const before = snapshot(w.home);
    for (const cmd of ['uninstall', 'status']) for (const args of [team, ['--exclude-required', 'x'], ['--exclude-declared', '-']]) {
      const r = spawnSync(process.execPath, [w.installer, cmd, '--yes', '--home', w.home, ...args], { encoding: 'utf8', env: testEnv(w.home) });
      assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /install only/);
      assert.deepEqual(snapshot(w.home), before);
    }
  } finally { rm(w.root); }
});

test('a failed program upgrade from an owner-style 0.1.6 install restores it; retry installs 0.1.7 with team exclusions', () => {
  const w = fixtureWorld();
  try {
    const dir = path.join(w.shared, 'frontdesk'), versionFile = path.join(dir, 'VERSION'), pathsFile = path.join(dir, 'lib', 'paths.mjs');
    const source = fs.readFileSync(pathsFile, 'utf8');
    fs.writeFileSync(versionFile, '0.1.6\n'); fs.writeFileSync(pathsFile, source.replace("VERSION = '0.1.7'", "VERSION = '0.1.6'")); seal(dir);
    ok(invoke(w, ['--yes'])); assert.equal(receipt(w).frontdesk, '0.1.6'); assert.equal('exclusions' in receipt(w), false);
    const before = active(w);
    fs.writeFileSync(versionFile, '0.1.7\n'); fs.writeFileSync(pathsFile, source); seal(dir);
    const failed = invoke(w, ['--yes', ...team], hooks); assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.deepEqual(active(w), before); assert.equal(installState(w.L).state, 'healthy');
    ok(invoke(w, ['--yes', ...team])); assert.equal(receipt(w).frontdesk, '0.1.7');
    assert.deepEqual(receipt(w).exclusions.required, TEAM_REQUIRED_EXCLUSIONS);
  } finally { rm(w.root); }
});

test('injected restore failure returns 4 and identifies the failed restore', () => {
  const w = fixtureWorld();
  try {
    const r = invoke(w, ['--yes', ...team], { FRONTDESK_TEST_HOOKS: '1', FRONTDESK_TEST_FAIL: 'restore' });
    assert.equal(r.status, 4, r.stdout + r.stderr); assert.match(r.stderr, /rollback incomplete:.*injected before-commit failure/); assert.match(r.stderr, /injected restore failure/);
  } finally { rm(w.root); }
});

test('receipt-only rollback verification also honors the injected restore failure', () => {
  const w = fixtureWorld();
  try {
    ok(invoke(w, ['--yes', ...team])); const before = active(w);
    const r = invoke(w, ['--yes', '--exclude-declared', 'new'], { FRONTDESK_TEST_HOOKS: '1', FRONTDESK_TEST_FAIL: 'restore' });
    assert.equal(r.status, 4, r.stdout + r.stderr); assert.match(r.stderr, /rollback incomplete.*injected restore failure/);
    assert.deepEqual(active(w), before);
  } finally { rm(w.root); }
});

test('failure to remove a fresh frontdesk folder is an incomplete rollback', () => {
  const w = fixtureWorld();
  try {
    const probe = path.join(w.root, 'remove-failure.mjs');
    fs.writeFileSync(probe, `import fs from 'node:fs'; const original = fs.rmSync; fs.rmSync = (file, options) => { if (file === ${JSON.stringify(w.L.frontdesk)}) throw new Error('fixture cleanup refused'); return original(file, options); };`);
    const r = invoke(w, ['--yes'], hooks, ['--import', pathToFileURL(probe).href]);
    assert.equal(r.status, 4, r.stdout + r.stderr); assert.match(r.stderr, /rollback incomplete.*fixture cleanup refused/);
  } finally { rm(w.root); }
});

test('test failure and stamp variables have no effect without FRONTDESK_TEST_HOOKS=1', () => {
  const w = fixtureWorld();
  try {
    ok(invoke(w, ['--yes'], { FRONTDESK_TEST_FAIL: 'before-commit', FRONTDESK_TEST_STAMP: '../unsafe' }));
    const r = invoke(w, ['--yes', ...team], { FRONTDESK_TEST_FAIL: 'restore', FRONTDESK_TEST_STAMP: '../unsafe' }); ok(r);
    assert.match(r.stdout, /exclusions updated/); assert.ok(fs.readdirSync(w.L.backups).every((n) => !n.includes('unsafe')));
  } finally { rm(w.root); }
});

for (const where of ['frontdesk', 'state', 'generations', 'generation', 'bin', 'bin.prev', 'logs', 'current.json', 'receipt', 'backups']) test(`containment refusal before any write: ${where}`, (t) => {
  const w = fixtureWorld();
  try {
    const outside = path.join(w.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel'), 'outside');
    const fileLink = ['receipt', 'current.json'].includes(where);
    const target = fileLink ? path.join(outside, 'sentinel') : outside;
    const link = where === 'frontdesk' ? w.L.frontdesk : where === 'receipt' ? w.L.receipt : where === 'backups' ? w.L.backups : where === 'generation' ? path.join(w.L.generations, 'old-release') : path.join(w.L.frontdesk, where);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try { fs.symlinkSync(target, link, fileLink ? 'file' : 'junction'); }
    catch (e) { if (fileLink && ['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) { t.skip(`OS refused file symlink: ${e.code}`); return; } throw e; }
    const before = snapshot(w.home), sentinel = snapshot(outside);
    for (const args of [['--yes'], ['--dry-run'], ['uninstall', '--yes']]) {
      const r = args[0] === 'uninstall'
        ? spawnSync(process.execPath, [w.installer, ...args, '--home', w.home], { encoding: 'utf8', env: testEnv(w.home) })
        : invoke(w, args);
      assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /resolves outside/);
      assert.deepEqual(snapshot(w.home), before); assert.deepEqual(snapshot(outside), sentinel);
    }
  } finally { rm(w.root); }
});

test('a dangling frontdesk link is refused without creating its outside target', () => {
  const w = fixtureWorld();
  try {
    const outside = path.join(w.root, 'missing'); fs.mkdirSync(w.L.base, { recursive: true }); fs.symlinkSync(outside, w.L.frontdesk, 'junction');
    const before = snapshot(w.home); assert.equal(invoke(w, ['--yes']).status, 1);
    assert.deepEqual(snapshot(w.home), before); assert.equal(fs.existsSync(outside), false);
  } finally { rm(w.root); }
});

for (const kind of ['valid', 'malformed', 'unreadable']) test(`dry runs leave the entire home byte-identical: ${kind} receipt`, () => {
  const w = fixtureWorld();
  try {
    ok(invoke(w, ['--yes', ...team]));
    if (kind !== 'valid') { fs.unlinkSync(w.L.receipt); if (kind === 'malformed') fs.writeFileSync(w.L.receipt, '{'); else fs.mkdirSync(w.L.receipt); }
    const before = snapshot(w.home);
    for (const args of [[], ['--dry-run', '--yes']]) {
      const r = invoke(w, [...args, '--exclude-declared', 'new']); assert.equal(r.status, kind === 'valid' ? 0 : 1, r.stdout + r.stderr);
      if (kind === 'valid') assert.match(r.stdout, /planned exclusions:.*new/); else assert.match(r.stderr, /dry run; no backup made/);
      assert.deepEqual(snapshot(w.home), before);
    }
  } finally { rm(w.root); }
});

for (const kind of ['update', 'invalid']) test(`backup stamp folder links cannot redirect a copy: ${kind}`, () => {
  const w = fixtureWorld();
  try {
    ok(invoke(w, ['--yes']));
    if (kind === 'invalid') fs.writeFileSync(w.L.receipt, '{');
    const bytes = fs.readFileSync(w.L.receipt, 'utf8');
    const outside = path.join(w.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
    fs.mkdirSync(w.L.backups, { recursive: true });
    for (const name of ['fixed', 'fixed-occupied']) fs.symlinkSync(outside, path.join(w.L.backups, name), 'junction');
    const sentinel = snapshot(outside), before = snapshot(w.home), env = { FRONTDESK_TEST_HOOKS: '1', FRONTDESK_TEST_STAMP: 'fixed' };
    invoke(w, ['--dry-run', ...team], env); assert.deepEqual(snapshot(w.home), before);
    const r = invoke(w, ['--yes', ...team], env); assert.equal(r.status, kind === 'invalid' ? 1 : 0, r.stdout + r.stderr);
    const fresh = fs.readdirSync(w.L.backups).filter((n) => !['fixed', 'fixed-occupied'].includes(n)); assert.equal(fresh.length, 1); assert.match(fresh[0], /^fixed-.+/);
    assert.equal(fs.lstatSync(path.join(w.L.backups, fresh[0])).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(w.L.backups, fresh[0], 'frontdesk-install.json'), 'utf8'), bytes);
    assert.deepEqual(snapshot(outside), sentinel);
  } finally { rm(w.root); }
});

for (const kind of ['update', 'invalid']) test(`a pre-existing backup file link is never followed: ${kind}`, (t) => {
  const w = fixtureWorld();
  try {
    ok(invoke(w, ['--yes'])); if (kind === 'invalid') fs.writeFileSync(w.L.receipt, '{');
    const outside = path.join(w.root, 'sentinel'); fs.writeFileSync(outside, 'keep');
    const old = path.join(w.L.backups, 'fixed-old'); fs.mkdirSync(old, { recursive: true });
    try { fs.symlinkSync(outside, path.join(old, 'frontdesk-install.json'), 'file'); }
    catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) { t.skip(`OS refused file symlink: ${e.code}`); return; } throw e; }
    const before = snapshot(w.home), env = { FRONTDESK_TEST_HOOKS: '1', FRONTDESK_TEST_STAMP: 'fixed' };
    invoke(w, ['--dry-run', ...team], env); assert.deepEqual(snapshot(w.home), before);
    const r = invoke(w, ['--yes', ...team], env); assert.equal(r.status, kind === 'invalid' ? 1 : 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep'); assert.equal(fs.readdirSync(w.L.backups).length, 2);
  } finally { rm(w.root); }
});

test('new backup folder realpath is checked before copy and an empty escaped folder is removed', () => {
  const w = fixtureWorld();
  try {
    fs.mkdirSync(w.L.base, { recursive: true }); const source = path.join(w.root, 'settings.json'); fs.writeFileSync(source, '{}');
    const outside = path.join(w.root, 'empty-outside'); let copied = false;
    const fsApi = { ...fs, mkdtempSync: () => { fs.mkdirSync(outside); return outside; }, copyFileSync: () => { copied = true; } };
    assert.throws(() => backupFile(source, w.L, 'fixed', fsApi), /resolves outside/);
    assert.equal(copied, false); assert.equal(fs.existsSync(outside), false);
  } finally { rm(w.root); }
});

test('backup copy is exclusive even if a destination file appears after mkdtemp', () => {
  const w = fixtureWorld();
  try {
    fs.mkdirSync(w.L.base, { recursive: true }); const source = path.join(w.root, 'settings.json'); fs.writeFileSync(source, 'source');
    let destination;
    const fsApi = { ...fs, mkdtempSync: (prefix) => { const dir = fs.mkdtempSync(prefix); destination = path.join(dir, 'settings.json'); fs.writeFileSync(destination, 'raced'); return dir; } };
    assert.throws(() => backupFile(source, w.L, 'fixed', fsApi), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(destination, 'utf8'), 'raced');
  } finally { rm(w.root); }
});

for (const field of ['family', 'model']) test(`hook guard uses receipt exclusions and the shared eligibility rule: ${field}`, async () => {
  const f = installFake({ helpers: { developer: { kind: 'role', engineer: 'b|high', model: 'route-model' } } });
  try {
    fs.writeFileSync(f.L.receipt, JSON.stringify({ ...f.receipt, exclusions: { required: [], declared: [field === 'family' ? 'b' : 'route-model'] } }));
    for (const mode of ['shadow', 'enforce']) for (const [tool, payload] of [['claude', claudeAgent('developer')], ['claude', claudeWorkflow("agent('work', { agentType: 'developer' })")], ['codex', codexSpawn({ agent_type: 'developer' })]]) {
      const input = new PassThrough(), records = [], stderr = { write: (text, cb) => cb?.() };
      const result = runHook({ tool, input, env: { FRONTDESK_GUARD_MODE: mode }, L: f.L, startedAt: Date.now(), logger: (_L, record) => records.push(record), stderr });
      input.end(JSON.stringify(payload)); assert.equal(await result, mode === 'shadow' ? 0 : 2);
      assert.ok(records[0].reasons.includes('excluded_here'), JSON.stringify(records));
    }
  } finally { rm(f.home); }
});

test('hook reports tampered team receipt as a fault and remains silent in shadow mode', async () => {
  const f = installFake();
  try {
    fs.writeFileSync(f.L.receipt, JSON.stringify({ ...f.receipt, installedBy: 'team-packet' }));
    const input = new PassThrough(), records = [];
    const result = runHook({ tool: 'claude', input, env: {}, L: f.L, startedAt: Date.now(), logger: (_L, record) => records.push(record), stderr: { write: () => assert.fail('shadow output') } });
    input.end(JSON.stringify(claudeAgent('developer'))); assert.equal(await result, 0); assert.equal(records[0].fault, 'receipt_invalid');
  } finally { rm(f.home); }
});
