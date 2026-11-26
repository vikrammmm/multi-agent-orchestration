import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCurrent, verifyFiles, compatible } from '../lib/generation.mjs';
import { installState } from '../lib/receipts.mjs';
import { loadTools, probeEnvironment, versionOf } from '../lib/tools.mjs';
import { installFake, rm } from './helpers.mjs';

test('a healthy install loads its ladder and guard context', () => {
  const f = installFake();
  try {
    const cur = loadCurrent(f.L);
    assert.equal(cur.ok, true);
    assert.equal(cur.generation, 1);
    assert.equal(cur.ladder.roles.length, 4);
    assert.deepEqual(cur.ctx.commissioned, ['b|high']);
    assert.equal(installState(f.L).state, 'healthy');
  } finally { rm(f.home); }
});

test('no receipt means never installed (the legacy table applies)', () => {
  const f = installFake({ withReceipt: false });
  try { assert.equal(installState(f.L).state, 'never-installed'); } finally { rm(f.home); }
});

test('an existing malformed receipt is broken, not never installed', () => {
  const f = installFake();
  try {
    fs.writeFileSync(f.L.receipt, '{');
    const st = installState(f.L);
    assert.equal(st.state, 'broken');
    assert.match(st.problems[0].problem, /invalid JSON/);
  } finally { rm(f.home); }
});

test('an unreadable receipt is broken, not never installed', () => {
  const f = installFake();
  try {
    fs.unlinkSync(f.L.receipt);
    fs.mkdirSync(f.L.receipt);
    const st = installState(f.L);
    assert.equal(st.state, 'broken');
    assert.match(st.problems[0].problem, /unreadable/);
  } finally { rm(f.home); }
});

test('current and generation manifests distinguish invalid JSON from missing files', () => {
  const f = installFake();
  try {
    fs.writeFileSync(f.L.current, '{');
    assert.equal(loadCurrent(f.L).problems[0].problem, 'invalid JSON');
    fs.writeFileSync(f.L.current, JSON.stringify({ dir: '1-testrelease', generation: 1, release: 'testrelease' }));
    fs.writeFileSync(path.join(f.genDir, 'manifest.json'), '{');
    assert.equal(loadCurrent(f.L).problems[0].problem, 'invalid JSON');
    fs.unlinkSync(f.L.current);
    fs.mkdirSync(f.L.current);
    assert.equal(loadCurrent(f.L).problems[0].problem, 'unreadable');
    fs.rmSync(f.L.current, { recursive: true });
    fs.writeFileSync(f.L.current, JSON.stringify({ dir: '1-testrelease', generation: 1, release: 'testrelease' }));
    fs.rmSync(path.join(f.genDir, 'manifest.json'));
    fs.mkdirSync(path.join(f.genDir, 'manifest.json'));
    assert.equal(loadCurrent(f.L).problems[0].problem, 'unreadable');
  } finally { rm(f.home); }
});

test('a generation manifest without installed hashes fails verification', () => {
  const f = installFake();
  try {
    const mf = path.join(f.genDir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    delete m.installed;
    fs.writeFileSync(mf, JSON.stringify(m));
    const cur = loadCurrent(f.L);
    assert.equal(cur.ok, false);
    assert.match(cur.problems[0].problem, /installed hash map/);
  } finally { rm(f.home); }
});

test('receipt installed hashes must match the generation manifest', () => {
  const f = installFake();
  try {
    const receipt = JSON.parse(fs.readFileSync(f.L.receipt, 'utf8'));
    receipt.installed['ladder.json'] = 'not-the-installed-hash';
    fs.writeFileSync(f.L.receipt, JSON.stringify(receipt));
    const st = installState(f.L);
    assert.equal(st.state, 'broken');
    assert.ok(st.problems.some((p) => p.file === 'receipt.installed'));
  } finally { rm(f.home); }
});

test('tool version probes disable login and auto-updates without an interval-zero override', () => {
  let env;
  const version = versionOf('C:/tools/claude.exe', (command, args, options) => {
    env = options.env;
    return { status: 0, stdout: 'Claude Code 2.1.295', stderr: '' };
  });
  assert.equal(version, '2.1.295');
  assert.equal(env.MUSE_UPDATE_INTERVAL_SECONDS, '2147483647');
  assert.equal(env.MUSE_NO_AUTO_UPDATE, '1');
  assert.equal(env.MUSE_LOGIN, '0');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.notEqual(env.MUSE_UPDATE_INTERVAL_SECONDS, '0');
  for (const file of ['C:/tools/codex.exe', 'C:/tools/cursor-agent.cmd']) {
    const disabled = probeEnvironment(file);
    assert.equal(disabled.DISABLE_AUTOUPDATER, '1');
    assert.equal(disabled.MUSE_NO_AUTO_UPDATE, '1');
    assert.equal(disabled.MUSE_UPDATE_INTERVAL_SECONDS, '2147483647');
    assert.equal(disabled.MUSE_LOGIN, '0');
  }
  const muse = probeEnvironment('C:/tools/muse.cmd');
  assert.equal(muse.MUSE_LOGIN, '0');
  assert.equal(muse.MUSE_UPDATE_INTERVAL_SECONDS, '2147483647');
  const polluted = probeEnvironment('C:/tools/muse.cmd', {
    MUSE_INTERNAL_UPDATE: '1', MUSE_LAUNCHER_INSTALL: '1', MUSE_UPDATE_CHANNEL: 'edge', MUSE_NO_AUTO_UPDATE: '0',
  });
  for (const key of ['MUSE_INTERNAL_UPDATE', 'MUSE_LAUNCHER_INSTALL', 'MUSE_UPDATE_CHANNEL']) assert.equal(polluted[key], undefined);
  assert.equal(polluted.MUSE_NO_AUTO_UPDATE, '1');
  assert.equal(polluted.MUSE_UPDATE_INTERVAL_SECONDS, '2147483647');
  assert.equal(polluted.MUSE_LOGIN, '0');
});

test('a fresh tool cache avoids probes unless refresh is requested', () => {
  const f = installFake();
  try {
    const cached = { detectedAt: new Date().toISOString(), tools: { claude: { version: '1' } } };
    fs.writeFileSync(path.join(f.L.state, 'tools.json'), JSON.stringify(cached));
    let calls = 0;
    assert.deepEqual(loadTools(f.L, { detect: () => { calls++; throw new Error('unexpected probe'); } }), cached);
    assert.equal(calls, 0);
    loadTools(f.L, { refresh: true, detect: () => { calls++; return { detectedAt: new Date().toISOString(), tools: {} }; } });
    assert.equal(calls, 1);
  } finally { rm(f.home); }
});

test('a changed generation file makes the install broken, with the file named', () => {
  const f = installFake();
  try {
    fs.appendFileSync(path.join(f.genDir, 'ladder.json'), ' ');
    const st = installState(f.L);
    assert.equal(st.state, 'broken');
    assert.ok(st.problems.some((p) => /ladder\.json/.test(p.file) && /mismatch/.test(p.problem)));
  } finally { rm(f.home); }
});

test('a missing or changed program file makes the install broken', () => {
  const f = installFake();
  try {
    fs.writeFileSync(path.join(f.L.bin, 'role.mjs'), 'tampered');
    assert.equal(installState(f.L).state, 'broken');
    fs.unlinkSync(path.join(f.L.bin, 'role.mjs'));
    assert.ok(installState(f.L).problems.some((p) => p.problem === 'missing'));
  } finally { rm(f.home); }
});

test('a missing generation folder makes the install broken, not never-installed', () => {
  const f = installFake();
  try {
    fs.rmSync(f.genDir, { recursive: true });
    assert.equal(installState(f.L).state, 'broken');
  } finally { rm(f.home); }
});

test('current.json pointing at a different release than the receipt is broken', () => {
  const f = installFake();
  try {
    const rec = JSON.parse(fs.readFileSync(f.L.receipt, 'utf8')); rec.release = 'other'; fs.writeFileSync(f.L.receipt, JSON.stringify(rec));
    assert.equal(installState(f.L).state, 'broken');
  } finally { rm(f.home); }
});

test('a release whose schema this reader cannot read is not loaded', () => {
  const f = installFake();
  try {
    const mf = path.join(f.genDir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8')); m.compat = { minReader: 2, maxReader: 3 }; fs.writeFileSync(mf, JSON.stringify(m));
    assert.equal(compatible(m), false);
    const cur = loadCurrent(f.L);
    assert.equal(cur.ok, false);
    assert.ok(cur.problems.some((p) => /schema/.test(p.problem)));
  } finally { rm(f.home); }
});

test('verifyFiles reports missing and changed files', () => {
  const f = installFake();
  try {
    const m = JSON.parse(fs.readFileSync(path.join(f.genDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(verifyFiles(f.genDir, m.installed), []);
    fs.unlinkSync(path.join(f.genDir, 'summary.md'));
    assert.deepEqual(verifyFiles(f.genDir, m.installed).map((p) => p.problem), ['missing']);
  } finally { rm(f.home); }
});
