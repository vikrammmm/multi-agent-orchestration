import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, before, after } from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const staged = path.resolve(testDir, '../..');
const sourceRoot = path.resolve(testDir, '../../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'team-resolve-test-'));
let packet;
let table;
let select;

before(async () => {
  if (fs.existsSync(path.join(staged, 'claude/delegate-lanes.json'))
    && fs.existsSync(path.join(staged, 'consensus/seats.json'))) {
    packet = staged;
  } else {
    packet = path.join(scratch, 'packet');
    for (const [source, dest] of [
      ['claude/delegate-lanes.json', 'claude/delegate-lanes.json'],
      ['packet/claude/lane-fallbacks.json', 'claude/lane-fallbacks.json'],
      ['consensus/seats.json', 'consensus/seats.json'],
      ['consensus/lib/select.mjs', 'consensus/lib/select.mjs'],
      ['packet/setup/resolve.mjs', 'setup/resolve.mjs'],
    ]) {
      const target = path.join(packet, dest);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(sourceRoot, source), target);
    }
  }
  table = JSON.parse(fs.readFileSync(path.join(packet, 'consensus/seats.json'), 'utf8'));
  select = await import(pathToFileURL(path.join(packet, 'consensus/lib/select.mjs')).href);
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const codexAll = {
  'gpt-6.2-sol': ['high', 'xhigh'], 'gpt-6.1-sol': ['high', 'xhigh'], 'gpt-6-sol': ['high', 'xhigh'], 'gpt-6-luna': ['max'],
  'gpt-5.6-sol': ['high', 'xhigh'], 'gpt-5.6-terra': ['max'], 'gpt-5.6-luna': ['max'],
};
const cursorAll = ['gpt-5.6-terra-max', 'gpt-5.6-sol-high', 'grok-4.7-high', 'grok-4.7-xhigh-fast',
  'grok-4.7-xhigh', 'cursor-grok-4.6-xhigh-fast', 'cursor-grok-4.6-xhigh'];
const codexOld = { 'gpt-5.6-sol': ['high', 'xhigh'], 'gpt-5.6-terra': ['max'], 'gpt-5.6-luna': ['max'] };

function fixture({ claude = '', codex = false, cursor = false, muse = false, codexList,
  cursorList = cursorAll, cursorFail = '', settings, hook = {}, codexHome = false, homeSetup, reposArg } = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, 'case-'));
  const home = path.join(dir, 'home');
  const out = path.join(dir, 'out');
  fs.mkdirSync(home);
  if (homeSetup) homeSetup(home);
  const fake = path.join(dir, 'fake-tool');
  fs.writeFileSync(fake, 'fake\n');
  const env = { ...process.env, TEAM_CLAUDE: claude ? fake : '', TEAM_CLAUDE_VERSION: claude,
    TEAM_CODEX: codex ? fake : '', TEAM_CODEX_VERSION: '', TEAM_CURSOR: '', TEAM_CURSOR_VERSION: '',
    TEAM_MUSE: muse ? fake : '', TEAM_MUSE_VERSION: '', TEAM_SETUP_FAIL: '', TEAM_SETUP_SKIP: '', CODEX_HOME: '',
    TEAM_DESKTOP_CLAUDE_ROOT: path.join(dir, 'no-desktop-claude') };
  if (codex && codexList !== undefined) {
    const cache = codexHome ? path.join(dir, 'custom-codex-home') : path.join(home, '.codex');
    fs.mkdirSync(cache, { recursive: true });
    if (codexHome) env.CODEX_HOME = cache;
    fs.writeFileSync(path.join(cache, 'models_cache.json'), JSON.stringify({ fetched_at: '2026-09-24',
      models: Object.entries(codexList).map(([slug, levels]) => ({ slug, visibility: 'list',
        supported_reasoning_levels: levels.map((effort) => ({ effort })) })) }));
  }
  if (cursor) {
    const script = path.join(dir, 'fake-cursor.mjs');
    const output = cursorFail || ['\uFEFFTip: sign in', ...cursorList.map((id) => `\u200B${id} - available`)].join('\n');
    fs.writeFileSync(script, `process.${cursorFail ? 'stderr' : 'stdout'}.write(${JSON.stringify(output + '\n')});\n${cursorFail ? 'process.exitCode = 1;' : ''}\n`);
    const launcher = path.join(dir, process.platform === 'win32' ? 'cursor-agent.cmd' : 'cursor-agent');
    if (process.platform === 'win32') fs.writeFileSync(launcher, '@node "%~dp0fake-cursor.mjs" %*\r\n');
    else {
      fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      fs.chmodSync(launcher, 0o755);
    }
    env.TEAM_CURSOR = launcher;
  }
  Object.assign(env, hook);
  const settingFile = path.join(dir, 'settings.json');
  if (settings !== undefined) fs.writeFileSync(settingFile, JSON.stringify({ unavailable: settings }));
  const result = spawnSync(process.execPath, [path.join(packet, 'setup/resolve.mjs'), '--packet', packet,
    '--home', home, '--settings', settingFile, '--out', out, ...(reposArg ? ['--repos', reposArg(home)] : [])],
    { encoding: 'utf8', env, timeout: 25_000 });
  const read = (name) => fs.readFileSync(path.join(out, name), 'utf8');
  const data = (name) => JSON.parse(read(name));
  return { dir, home, out, env, result, read, data, exists: (name) => fs.existsSync(path.join(out, name)) };
}
function ok(run) { assert.equal(run.result.status, 0, run.result.stderr); assert.match(run.result.stdout, /^RESOLVE OK /); }
function pairMatchesReferee(run) {
  const tools = {
    'claude-code': { found: Boolean(run.env.TEAM_CLAUDE), version: run.env.TEAM_CLAUDE_VERSION || null },
    codex: { found: Boolean(run.env.TEAM_CODEX), version: run.env.TEAM_CODEX_VERSION || null },
    cursor: { found: Boolean(run.env.TEAM_CURSOR), version: run.env.TEAM_CURSOR_VERSION || null },
  };
  const facts = { tools, local: run.data('local.json') };
  const expected = select.pickPair(table, (id) => select.seatEligibility(table, id, facts).usable);
  const actual = run.data('receipt.json').consensus.pair;
  assert.deepEqual(actual, expected.length === 2 ? expected : []);
  if (actual.length) assert.ok(run.read('consensus.md').split('\n')[0].includes(actual.join(' + ')));
}

test('1: every tool offered, first choices and standard pair', () => {
  const r = fixture({ claude: '2.1.280', codex: true, codexList: codexAll, cursor: true, muse: true, codexHome: true }); ok(r);
  const lanes = r.data('lanes.json').lanes;
  assert.equal(Object.keys(lanes).length, 10);
  assert.equal(lanes['cursor-review'].model, 'grok-4.7-high');
  assert.equal(lanes['cursor-implement'], undefined);
  assert.equal(lanes['cursor-grok-review'].model, 'grok-4.7-xhigh-fast');
  assert.deepEqual(r.data('local.json').seats, Object.fromEntries(Object.entries(table.seats)
    .filter(([, seat]) => seat.route === 'claude-code').map(([id, seat]) => [id,
      { unverified: `Claude plan access to ${seat.model} is not verified` }])));
  assert.match(r.read('consensus.md'), /^on, standard grade \(best pair: gpt-6\.2-sol \+ claude-opus-5\.5\)/);
  pairMatchesReferee(r);
});

test('2: GPT-5.6 fallbacks and GPT-6 seat marks', () => {
  const r = fixture({ claude: '2.1.280', codex: true, codexList: codexOld }); ok(r);
  assert.equal(r.data('lanes.json').lanes['codex-review'].model, 'gpt-5.6-sol');
  assert.equal(r.data('lanes.json').lanes['codex-implement'].model, 'gpt-5.6-terra');
  assert.match(r.read('lanes.md'), /codex-review: gpt-5\.6-sol at high \(fallback: gpt-6\.2-sol at high is not offered here\)/);
  assert.match(r.data('local.json').seats['gpt-6.2-sol'].unavailable, /gpt-6\.2-sol at xhigh/);
  assert.match(r.data('local.json').seats['gpt-6-sol'].unavailable, /model list of 2026-09-24/);
  assert.match(r.read('summary.txt'), /Your Codex does not offer gpt-6\.2-sol, gpt-6-luna, gpt-6\.1-sol, gpt-6-sol yet/);
  pairMatchesReferee(r);
});

test('2b: GPT-6 Sol is the lane fallback when GPT-6.2 Sol is not offered', () => {
  const r = fixture({ claude: '2.1.280', codex: true, codexList: { 'gpt-6-sol': ['high'] } }); ok(r);
  for (const name of ['codex-review', 'codex-implement']) {
    const lane = r.data('lanes.json').lanes[name];
    assert.equal(lane.model, 'gpt-6-sol');
    assert.equal(lane.effort, 'high');
    assert.match(r.read('lanes.md'), new RegExp(`${name}: gpt-6-sol at high \\(fallback: gpt-6\\.2-sol at high is not offered here\\)`));
  }
});

test('3: unknown Codex list leaves lanes and seats unverified', () => {
  const r = fixture({ claude: '2.1.280', codex: true }); ok(r);
  assert.equal(r.data('lanes.json').lanes['codex-review'].model, 'gpt-6.2-sol');
  assert.match(r.read('lanes.md'), /codex-review: gpt-6\.2-sol at high \(not verified: Codex has no model list yet\)/);
  assert.match(r.data('local.json').seats['gpt-6.2-sol'].unverified, /Codex model list unknown/);
  assert.match(r.data('local.json').seats['gpt-6.1-sol'].unverified, /Codex model list unknown/);
  assert.match(r.read('summary.txt'), /Open Codex once/);
});

test('4: Grok 4.6 lane fallback and missing Grok 4.7 seat', () => {
  const r = fixture({ claude: '2.1.280', cursor: true, cursorList: cursorAll.filter((id) => !id.startsWith('grok-4.7')) }); ok(r);
  assert.equal(r.data('lanes.json').lanes['cursor-grok-review'].model, 'cursor-grok-4.6-xhigh-fast');
  assert.match(r.data('local.json').seats['grok-4.7'].unavailable, /not offered by this Cursor account/);
  assert.match(r.read('summary.txt'), /Your Cursor plan does not offer Grok 4.7/);
  assert.equal(r.data('lanes.json').lanes['cursor-review'], undefined, 'cursor-review is left out, not replaced, when Grok 4.7 high is not offered');
  assert.match(r.read('lanes.md'), /cursor-review/);
});

test('5: failing Cursor list is unknown with its output as reason', () => {
  const r = fixture({ claude: '2.1.280', cursor: true, cursorFail: 'not logged in' }); ok(r);
  assert.match(r.read('lanes.md'), /cursor-review: grok-4\.7-high \(not verified: not logged in\)/);
  assert.match(r.read('summary.txt'), /cursor-agent login\), then run this installer again \(not logged in\)/);
});

test('6: known Codex list can leave lanes out', () => {
  const r = fixture({ codex: true, codexList: { 'gpt-6-luna': ['max'] } }); ok(r);
  assert.equal(r.data('lanes.json').lanes['codex-review'], undefined);
  assert.equal(r.data('lanes.json').lanes['codex-implement'], undefined);
  assert.equal(r.data('lanes.json').lanes['codex-luna-review'].model, 'gpt-6-luna');
  assert.match(r.read('lanes.md'), /codex-review: left out/);
  assert.match(r.read('summary.txt'), /2 left out/);
});

test('7 and 16: Claude only pairs Opus 5.5 and Opus 5, unverified with plan advice', () => {
  const r = fixture({ claude: '2.1.280' }); ok(r);
  assert.equal(r.exists('lanes.json'), false);
  assert.equal(r.read('lanes.md'), '- none: no Codex, Cursor or Muse CLI was found\n');
  assert.match(r.read('consensus.md'), /^on, lower grade: single vendor \(claude-opus-5\.5 \+ claude-opus\)/);
  assert.match(r.read('consensus.md'), /LOWER GRADE \(single vendor\)/);
  assert.match(r.read('consensus.md'), /Not verified here: claude-opus-5\.5/);
  assert.match(r.read('consensus.md'), /Not verified here: claude-opus/);
  assert.match(r.read('consensus.md'), /For a standard-grade review/);
  assert.match(r.read('consensus.md'), /--unavailable claude-opus-5-5,claude-opus-5/);
  pairMatchesReferee(r);
});

test('8: older Claude uses Opus 5 and advises an Opus 5.5 update', () => {
  const r = fixture({ claude: '2.1.259', codex: true, codexList: codexAll, cursor: true }); ok(r);
  assert.match(r.read('consensus.md'), /^on, standard grade \(best pair: gpt-6\.2-sol \+ claude-opus\)/);
  assert.match(r.read('summary.txt'), /Update Claude Code to 2.1.280 or newer/);
  pairMatchesReferee(r);
});

test('9: below CTO pair across vendors', () => {
  const r = fixture({ claude: '2.1.200', codex: true, codexList: { 'gpt-6-sol': ['xhigh'] },
    cursor: true, cursorList: ['cursor-grok-4.6-xhigh', 'cursor-grok-4.6-xhigh-fast'] }); ok(r);
  assert.match(r.read('consensus.md'), /^on, lower grade: below CTO level \(gpt-6-sol \+ grok-4\.6\)/);
  assert.match(r.read('summary.txt'), /Update Claude Code to 2.1.248 or newer/);
  assert.match(r.read('summary.txt'), /For CTO-level reviews/);
  pairMatchesReferee(r);
});

test('10: old Claude alone has consensus off', () => {
  const r = fixture({ claude: '2.1.200' }); ok(r);
  assert.match(r.read('consensus.md'), /^off: fewer than two different models are usable here/);
  assert.match(r.read('summary.txt'), /Consensus needs two different models/);
});

test('11: unknown Claude version is assumed available with advice', () => {
  const r = fixture({ claude: '2.1.280' });
  r.env.TEAM_CLAUDE_VERSION = '';
  const env = { ...r.env, TEAM_CLAUDE_VERSION: '' };
  const out = path.join(r.dir, 'unknown-version-out');
  const rerun = spawnSync(process.execPath, [path.join(packet, 'setup/resolve.mjs'), '--packet', packet,
    '--home', r.home, '--settings', path.join(r.dir, 'missing.json'), '--out', out], { encoding: 'utf8', env });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(fs.readFileSync(path.join(out, 'summary.txt'), 'utf8'), /Claude Code's version could not be read/);
  assert.match(fs.readFileSync(path.join(out, 'routes.md'), 'utf8'), /^- Haiku helper \(haiku-helper, Claude Haiku 5\.5\): the first Claude helper to try\n- Sonnet helpers \(explore, researcher, implementer, verifier, Claude Sonnet 5\.5\): always available\n$/);
});

test('Haiku helper is the first Claude helper at version 2.1.293', () => {
  const r = fixture({ claude: '2.1.293' }); ok(r);
  assert.match(r.read('routes.md'), /^- Haiku helper \(haiku-helper, Claude Haiku 5\.5\): the first Claude helper to try\n- Sonnet helpers \(explore, researcher, implementer, verifier, Claude Sonnet 5\.5\): always available\n$/);
});

test('Haiku helper needs Claude Code 2.1.293 at version 2.1.292', () => {
  const r = fixture({ claude: '2.1.292' }); ok(r);
  assert.match(r.read('routes.md'), /^- Haiku helper \(haiku-helper, Claude Haiku 5\.5\): needs Claude Code 2\.1\.293 or newer \(found 2\.1\.292\); use the Sonnet helpers until then\n- Sonnet helpers \(explore, researcher, implementer, verifier, Claude Sonnet 5\.5\): always available\n$/);
  assert.match(r.read('summary.txt'), /Update Claude Code to 2\.1\.293 or newer to use the Haiku helper \(found 2\.1\.292\); until then use the Sonnet helpers\./);
});

test('Sonnet 4.6 helpers at Claude Code 2.1.283', () => {
  const r = fixture({ claude: '2.1.283' }); ok(r);
  assert.match(r.read('routes.md'), /^- Sonnet helpers \(explore, researcher, implementer, verifier\): Claude Sonnet 4\.6 here, because Claude Code 2\.1\.283 is older than 2\.1\.284; update Claude Code and run this installer again for Sonnet 5\.5$/m);
  assert.match(r.read('summary.txt'), /Update Claude Code to 2\.1\.284 or newer to get the Sonnet 5\.5 helpers \(found 2\.1\.283\); until then the Sonnet helpers run Claude Sonnet 4\.6\./);
  assert.equal(r.read('sonnet-helpers.txt'), '4.6\n');
  assert.equal(r.data('receipt.json').sonnetHelpers, '4.6');
});

test('Sonnet 5.5 helpers at Claude Code 2.1.284', () => {
  const r = fixture({ claude: '2.1.284' }); ok(r);
  assert.match(r.read('routes.md'), /^- Sonnet helpers \(explore, researcher, implementer, verifier, Claude Sonnet 5\.5\): always available$/m);
  assert.doesNotMatch(r.read('summary.txt'), /Sonnet 5\.5 helpers/);
  assert.equal(r.read('sonnet-helpers.txt'), '5.5\n');
  assert.equal(r.data('receipt.json').sonnetHelpers, '5.5');
});

test('Sonnet 5.5 helpers when the Claude version is unreadable', () => {
  const r = fixture({ claude: '2.1.283' });
  const env = { ...r.env, TEAM_CLAUDE_VERSION: '' };
  const out = path.join(r.dir, 'unreadable-sonnet-out');
  const rerun = spawnSync(process.execPath, [path.join(packet, 'setup/resolve.mjs'), '--packet', packet,
    '--home', r.home, '--settings', path.join(r.dir, 'missing.json'), '--out', out], { encoding: 'utf8', env });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(fs.readFileSync(path.join(out, 'routes.md'), 'utf8'), /Sonnet helpers \(explore, researcher, implementer, verifier, Claude Sonnet 5\.5\): always available/);
  assert.equal(fs.readFileSync(path.join(out, 'sonnet-helpers.txt'), 'utf8'), '5.5\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'receipt.json'), 'utf8')).sonnetHelpers, '5.5');
});

test('without Claude Code there are no Claude helpers, lanes or usable seats', () => {
  const r = fixture({ codex:true, codexList:codexAll }); ok(r);
  assert.doesNotMatch(r.read('routes.md'), /Haiku helper|Sonnet helpers|Claude Code/);
  assert.equal(r.read('sonnet-helpers.txt'), 'none\n');
  const receipt = r.data('receipt.json');
  assert.equal(receipt.sonnetHelpers, 'none');
  assert.ok(receipt.consensus.pair.every(id => !id.startsWith('claude-')));
  assert.ok(Object.values(r.data('lanes.json').lanes).every(l => l.implementer !== 'claude'));
  const local = r.data('local.json');
  for (const [id,seat] of Object.entries(JSON.parse(fs.readFileSync(path.join(packet,'consensus/seats.json'))).seats)) {
    if (seat.route === 'claude-code') assert.equal(local.seats[id].unavailable, 'Claude Code not found');
  }
});

test('Sonnet 5.5 helpers when the desktop app carries a newer Claude Code', () => {
  const root = path.join(scratch, 'desktop-sonnet55');
  fakeScript(path.join(root, '2.1.293'), 'claude', '2.1.293 (Claude Code)');
  const r = fixture({ claude: '2.1.283', hook: { TEAM_DESKTOP_CLAUDE_ROOT: root } }); ok(r);
  assert.match(r.read('routes.md'), /^- Haiku helper \(haiku-helper, Claude Haiku 5\.5\): the first Claude helper to try\n- Sonnet helpers \(explore, researcher, implementer, verifier, Claude Sonnet 5\.5\): always available\n$/);
  assert.doesNotMatch(r.read('summary.txt'), /Sonnet 5\.5 helpers/);
  assert.equal(r.read('sonnet-helpers.txt'), '5.5\n');
  assert.equal(r.data('receipt.json').sonnetHelpers, '5.5');
});

test('12: receipt mirrors consensus and lanes', () => {
  const r = fixture({ claude: '2.1.280', codex: true, codexList: codexAll }); ok(r);
  const receipt = r.data('receipt.json');
  assert.equal(receipt.consensus.reason, r.read('consensus.md').split('\n')[0]);
  assert.deepEqual(receipt.consensus.pair, ['gpt-6.2-sol', 'claude-opus-5.5']);
  for (const [name, lane] of Object.entries(r.data('lanes.json').lanes)) {
    assert.equal(receipt.lanes[name], `${lane.model}${lane.effort ? ` ${lane.effort}` : ''}`);
  }
  assert.equal(r.read('receipt.json').trim().split('\n').length, 1);
});

test('13: Muse lanes use its static model', () => {
  const r = fixture({ muse: true }); ok(r);
  assert.equal(r.data('lanes.json').lanes['muse-implement'].model, 'muse-spark-1.3');
  assert.equal(r.data('lanes.json').lanes['muse-review'].model, 'muse-spark-1.3');
  assert.match(r.read('routes.md'), /Muse Code via muse-delegate: muse-implement, muse-review/);
});

test('14: same family Sol pair is below CTO', () => {
  const r = fixture({ claude: '2.1.200', codex: true, codexList: { 'gpt-6-sol': ['xhigh'], 'gpt-5.6-sol': ['xhigh'] } }); ok(r);
  assert.match(r.read('consensus.md'), /^on, lower grade: below CTO level \(gpt-6-sol \+ gpt-5\.6-sol\)/);
  assert.match(r.read('consensus.md'), /same family/);
  pairMatchesReferee(r);
});

test('15: declared unavailable overrides listed seats and lane candidates', () => {
  const r = fixture({ claude: '2.1.280', codex: true, codexList: { 'gpt-6.2-sol': ['high', 'xhigh'], 'gpt-6.1-sol': ['high', 'xhigh'], 'gpt-6-sol': ['high', 'xhigh'], 'gpt-5.6-sol': ['high'] },
    settings: ['claude-opus-5-5', 'claude-opus-5', 'gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol'] }); ok(r);
  for (const id of ['claude-opus-5.5', 'claude-opus', 'gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol']) {
    assert.match(r.data('local.json').seats[id].unavailable, /declared unavailable \(installer --unavailable\)/);
  }
  assert.match(r.read('lanes.md'), /codex-review: gpt-5\.6-sol at high \(fallback: gpt-6\.2-sol is declared unavailable\)/);
  assert.equal(r.data('receipt.json').consensus.grade, 'off');
  pairMatchesReferee(r);
  const requested = fixture({ claude: '2.1.280', codex: true, codexList: { 'gpt-6-sol': ['xhigh'] },
    settings: ['claude-opus-5-5', 'claude-opus-5'] }); ok(requested);
  assert.match(requested.read('consensus.md'), /^on, lower grade: below CTO level \(gpt-6-sol \+ claude-sonnet-5\)/);
  pairMatchesReferee(requested);
});

test('15b: a fallback chosen from an unknown list is also not verified', () => {
  const r = fixture({ claude: '2.1.280', codex: true, settings: ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol'] }); ok(r);
  assert.equal(r.data('lanes.json').lanes['codex-review'].model, 'gpt-5.6-sol');
  assert.ok(r.read('lanes.md').includes('- codex-review: gpt-5.6-sol at high (fallback: gpt-6.2-sol is declared unavailable) (not verified: Codex has no model list yet)'), r.read('lanes.md'));
  assert.match(r.read('summary.txt'), /^Lanes: \d+ ready \(\d+ on a fallback, [1-9]\d* not verified, 0 left out\)/);
});

function fakeScript(dir, name, output) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const file = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(file, `@echo off\r\necho ${output}\r\n`);
    return file;
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho '${output}'\n`);
  fs.chmodSync(file, 0o755);
  return file;
}
const gitRepo = (dir) => fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

test('18: the repositories folder is the usual place with the most repositories, or --repos', () => {
  const r = fixture({ claude: '2.1.280', homeSetup: (home) => {
    gitRepo(path.join(home, 'Documents', 'GitHub', 'a'));
    for (const n of ['b', 'c']) gitRepo(path.join(home, 'code', n));
    gitRepo(path.join(home, 'code', 'org', 'd'));
  } }); ok(r);
  assert.match(r.read('repos.md'), /Repositories: .*code \(3 git repositories\)/);
  assert.equal(r.data('receipt.json').repos.count, 3);
  const set = fixture({ claude: '2.1.280', homeSetup: (home) => gitRepo(path.join(home, 'Documents', 'GitHub', 'a')),
    reposArg: (home) => path.join(home, 'Documents', 'GitHub') }); ok(set);
  assert.match(set.read('repos.md'), /\(1 git repositories, set with --repos\)/);
  const none = fixture({ claude: '2.1.280' }); ok(none);
  assert.match(none.read('repos.md'), /not found; run this installer with --repos/);
  assert.equal(none.data('receipt.json').repos, null);
});

test('19: other tools on PATH are listed', () => {
  const bin = path.join(scratch, 'extra-bin');
  fakeScript(bin, 'gemini', 'gemini 0.9.1');
  const r = fixture({ claude: '2.1.280', hook: { [pathKey]: `${bin}${path.delimiter}${process.env[pathKey]}` } }); ok(r);
  assert.match(r.read('tools.md'), /Gemini CLI: 0\.9\.1/);
  assert.match(r.read('summary.txt'), /Other tools: .*Gemini CLI 0\.9\.1/);
});

test('20: a newer Claude Code in the desktop app serves the reviewers', () => {
  const root = path.join(scratch, 'desktop-new');
  fakeScript(path.join(root, '2.1.290'), 'claude', '2.1.290 (Claude Code)');
  const r = fixture({ claude: '2.1.259', hook: { TEAM_DESKTOP_CLAUDE_ROOT: root } }); ok(r);
  assert.match(r.data('local.json').binaries.claude, /2\.1\.290/);
  assert.match(r.read('summary.txt'), /desktop app's Claude Code 2\.1\.290/);
  assert.ok(r.data('receipt.json').consensus.pair.includes('claude-opus-5.5'));
  assert.doesNotMatch(r.read('summary.txt'), /Update Claude Code to 2\.1\.280/);
});

test('21: an older desktop copy of Claude Code is ignored', () => {
  const root = path.join(scratch, 'desktop-old');
  fakeScript(path.join(root, '2.1.250'), 'claude', '2.1.250 (Claude Code)');
  const r = fixture({ claude: '2.1.280', hook: { TEAM_DESKTOP_CLAUDE_ROOT: root } }); ok(r);
  assert.equal(r.data('local.json').binaries, undefined);
  assert.doesNotMatch(r.read('summary.txt'), /desktop app/);
});

test('17: failure and skip hooks', () => {
  const failed = fixture({ claude: '2.1.280', hook: { TEAM_SETUP_FAIL: '1' } });
  assert.equal(failed.result.status, 1);
  assert.match(failed.result.stderr, /RESOLVE FAILED: test hook/);
  assert.equal(fs.existsSync(failed.out), false);
  const skipped = fixture({ claude: '2.1.280', hook: { TEAM_SETUP_SKIP: 'consensus.md' } }); ok(skipped);
  assert.equal(skipped.exists('consensus.md'), false);
  for (const name of ['local.json', 'routes.md', 'lanes.md', 'summary.txt', 'receipt.json']) assert.equal(skipped.exists(name), true);
});

test('all output text uses LF and ends in a newline', () => {
  const r = fixture({ claude: '2.1.280', codex: true, codexList: codexAll, cursor: true, muse: true }); ok(r);
  for (const name of fs.readdirSync(r.out)) {
    const content = r.read(name);
    assert.ok(content.endsWith('\n'), name);
    assert.equal(content.includes('\r'), false, name);
  }
});

test('GPT-6.1 is the first lane fallback and a standard-grade reserve when 6.2 is absent', () => {
  const r = fixture({ claude: '2.1.280', codex: true, codexList: { 'gpt-6.1-sol': ['high', 'xhigh'] } }); ok(r);
  for (const name of ['codex-review', 'codex-implement']) {
    assert.equal(r.data('lanes.json').lanes[name].model, 'gpt-6.1-sol');
    assert.equal(r.data('lanes.json').lanes[name].effort, 'high');
    assert.ok(r.read('lanes.md').includes(name + ': gpt-6.1-sol at high (fallback:'));
  }
  assert.ok(r.data('local.json').seats['gpt-6.2-sol'].unavailable);
  assert.equal(r.data('local.json').seats['gpt-6.1-sol'], undefined);
  assert.deepEqual(r.data('receipt.json').consensus.pair, ['claude-opus-5.5', 'gpt-6.1-sol']);
  assert.equal(r.data('receipt.json').consensus.grade, 'standard');
  pairMatchesReferee(r);
});
