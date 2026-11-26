import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findFolders, renderFolders } from '../folders.mjs';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'folders-test-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const env = { TEAM_FOLDER_ROOTS: '' };
const dir = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const fixture = () => ({ home: fs.mkdtempSync(path.join(scratch, 'home-')) });
function repo(parent, name = 'SecondBrain', origin = false, age = 100) {
  const p = dir(parent, name), g = dir(p, '.git');
  fs.writeFileSync(path.join(g, 'config'), origin ? '[remote "origin"]\n url = https://example.test/SECONDbrain.git\n' : '');
  fs.writeFileSync(path.join(g, 'index'), ''); fs.utimesSync(path.join(g, 'index'), age, age); return p;
}
test('strong credentials chosen; weak offered only; at most nine candidates', () => {
  const f = fixture(), w = dir(f.home, 'personal creds');
  assert.equal(findFolders(f, env).credentials.path, null);
  assert.deepEqual(findFolders(f, env).credentials.candidates, [{ path: w, strong: false }]);
  const strong = dir(f.home, 'nested', 'CREDENTIALS');
  for (let i = 0; i < 12; i++) dir(f.home, `secrets-${i}`);
  const r = findFolders(f, env); assert.equal(r.credentials.path, strong); assert.equal(r.credentials.source, 'found');
  assert.equal(r.credentials.candidates.length, 9);
  assert.ok(r.credentials.candidates.some(c => c.path === strong));
});
test('ranking a and b: origin then not under Other computers', () => {
  const f = fixture(), a = repo(f.home, 'SecondBrain', false, 300);
  const b = repo(dir(f.home, 'Other computers', 'PC'), 'SecondBrain', true, 100);
  assert.equal(findFolders(f, env).knowledge.path, b);
  fs.writeFileSync(path.join(b, '.git', 'config'), ''); assert.equal(findFolders(f, env).knowledge.path, a);
});
test('ranking c and d: newest activity then shortest path', () => {
  const f = fixture(), a = repo(f.home), b = repo(dir(f.home, 'long-parent'), 'second-brain', false, 200);
  assert.equal(findFolders(f, env).knowledge.path, b);
  fs.utimesSync(path.join(b, '.git', 'index'), 100, 100); assert.equal(findFolders(f, env).knowledge.path, a);
  for (const file of ['FETCH_HEAD', 'logs/HEAD']) {
    dir(b, '.git', path.dirname(file)); fs.writeFileSync(path.join(b, '.git', file), '');
    fs.utimesSync(path.join(b, '.git', file), 500, 500); assert.equal(findFolders(f, env).knowledge.path, b);
  }
  const ca = dir(f.home, 'credentials'), cb = dir(f.home, 'parent', 'credentials');
  fs.utimesSync(ca, 100, 100); fs.utimesSync(cb, 200, 200); assert.equal(findFolders(f, env).credentials.path, cb);
  fs.utimesSync(cb, 100, 100); assert.equal(findFolders(f, env).credentials.path, ca);
});
test('set/kept bypass search; missing set remains null; missing kept searches with exact advice', () => {
  const f = fixture(), c = dir(f.home, 'credentials'), k = repo(f.home), missing = path.join(f.home, 'gone');
  for (const source of ['set', 'kept']) {
    const r = findFolders({ ...f, credentials: c, 'credentials-from': source, knowledge: k, 'knowledge-from': source }, env);
    assert.equal(r.credentials.source, source); assert.equal(r.knowledge.source, source); assert.deepEqual(r.credentials.candidates, []);
  }
  for (const kind of ['credentials', 'knowledge']) {
    const r = findFolders({ ...f, [kind]: missing, [`${kind}-from`]: 'set' }, env);
    assert.equal(r[kind].path, null); assert.deepEqual(r.advice, [`The folder given with --${kind} does not exist: ${missing}.`]);
    const kept = findFolders({ ...f, [kind]: missing, [`${kind}-from`]: 'kept' }, env);
    assert.equal(kept[kind].source, 'found'); assert.deepEqual(kept.advice, [`The remembered ${kind} folder ${missing} no longer exists; searched again.`]);
  }
});
test('prune repositories, credentials, hidden and excluded folders; home depth four', () => {
  const f = fixture();
  for (const n of ['.hidden', '$cache', 'AppData', 'Library', 'node_modules', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'venv', '__pycache__']) repo(dir(f.home, n));
  const ordinary = dir(f.home, 'ordinary'); dir(ordinary, '.git'); repo(ordinary);
  repo(dir(f.home, 'credentials')); repo(dir(f.home, 'a', 'b', 'c', 'd'));
  assert.equal(findFolders(f, env).knowledge.path, null);
});
test('gitdir file followed for origin and metadata', () => {
  const f = fixture(), k = dir(f.home, 'SECOND BRAIN'), g = dir(scratch, 'gitdir');
  fs.writeFileSync(path.join(k, '.git'), `gitdir: ${path.relative(k, g)}\n`);
  fs.writeFileSync(path.join(g, 'config'), '[remote "origin"]\nurl = ssh://example.test/secondbrain\n');
  assert.equal(findFolders(f, env).knowledge.path, k);
  fs.writeFileSync(path.join(k, '.git'), 'gitdir: missing-metadata\n');
  assert.equal(findFolders(f, env).knowledge.path, k);
});
test('symlink or Windows junction never followed', t => {
  const f = fixture(), outside = dir(scratch, 'outside'); repo(outside);
  try { fs.symlinkSync(outside, path.join(f.home, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { t.skip(`cannot create link: ${e.code}`); return; }
  assert.equal(findFolders(f, env).knowledge.path, null);
});
test('extra roots replaced, empty disables; repos depth two; budget exact advice', () => {
  const f = fixture(), extra = dir(scratch, 'extra'), k = repo(extra);
  assert.equal(findFolders(f, env).knowledge.path, null);
  assert.equal(findFolders(f, { TEAM_FOLDER_ROOTS: extra }).knowledge.path, k);
  const repos = dir(scratch, 'repos'), deep = repo(dir(repos, 'one'));
  assert.equal(findFolders({ ...f, repos }, env).knowledge.path, deep);
  dir(f.home, 'a'); dir(f.home, 'b'); const r = findFolders(f, { ...env, TEAM_FOLDER_BUDGET: '1' });
  assert.equal(r.searchIncomplete, true); assert.deepEqual(r.advice, ['The folder search stopped early (too many folders); set the folders with --credentials and --knowledge if one is missing.']);
});
test('privacy spy forbids reading or listing credential candidates or their contents', () => {
  const f = fixture(), c = dir(f.home, 'personal creds'); repo(c);
  const linked = dir(f.home, 'SecondBrain');
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${c}\n`);
  const originalRead = fs.readFileSync, originalList = fs.readdirSync;
  const touches = [];
  const guard = original => (p, ...args) => {
    if (String(p) === c || String(p).startsWith(c + path.sep)) {
      touches.push(String(p));
      throw new Error(`private read ${p}`);
    }
    return original(p, ...args);
  };
  fs.readFileSync = guard(originalRead); fs.readdirSync = guard(originalList);
  try { assert.equal(findFolders(f, env).knowledge.path, linked); }
  finally { fs.readFileSync = originalRead; fs.readdirSync = originalList; }
  assert.deepEqual(touches, []);
});
test('overlapping roots deduplicate; explicit roots inside credentials remain private', () => {
  const f = fixture(), repos = dir(f.home, 'Documents', 'GitHub'), k = repo(repos);
  assert.deepEqual(findFolders({ ...f, repos }, env).knowledge.candidates, [{ path: k, strong: true }]);
  const c = dir(scratch, 'credentials'), nested = dir(c, 'nested'); repo(nested);
  assert.deepEqual(findFolders(f, { TEAM_FOLDER_ROOTS: nested }).knowledge.candidates, [{ path: k, strong: true }]);
});
test('a supplied credentials link also protects its target reached through another root', t => {
  const f = fixture(), vault = dir(scratch, 'vault'), link = path.join(f.home, 'account link');
  repo(vault);
  try { fs.symlinkSync(vault, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { t.skip(`cannot create link: ${e.code}`); return; }
  const originalList = fs.readdirSync, touches = [];
  fs.readdirSync = (p, ...args) => {
    if (String(p) === vault || String(p).startsWith(vault + path.sep)) { touches.push(p); throw new Error('private'); }
    return originalList(p, ...args);
  };
  try {
    const r = findFolders({ ...f, credentials: link, 'credentials-from': 'set', repos: vault }, env);
    assert.equal(r.credentials.path, link); assert.equal(r.knowledge.path, null);
  } finally { fs.readdirSync = originalList; }
  assert.deepEqual(touches, []);
});
test('render all how values, unset, section slashes, summary candidates and advice', () => {
  const out = dir(scratch, 'render');
  for (const source of ['found', 'set', 'asked', 'kept', null]) {
    const p = source ? path.join(scratch, 'folder') : null;
    renderFolders({ credentials: { path: p, source, candidates: [{ path: '/another', strong: false }] }, knowledge: { path: p, source, candidates: [] }, advice: ['Advice.'] }, out);
    const profile = fs.readFileSync(path.join(out, 'folders.md'), 'utf8'); assert.equal(profile.trim().split('\n').length, 2);
    const how = { found: 'found', set: 'set with --credentials', asked: 'chosen by you', kept: 'kept from the last run' }[source];
    assert.ok(source ? profile.includes(`(${how})`) : profile.includes('not set; run this installer'));
    const section = fs.readFileSync(path.join(out, 'folders-section.md'), 'utf8');
    assert.ok(source ? section.includes(p.replace(/\\/g, '/')) : section.includes('Ask the person once where it is'));
    const summary = fs.readFileSync(path.join(out, 'folders-summary.txt'), 'utf8'); assert.ok(summary.includes('/another')); assert.ok(summary.endsWith('Advice.\n'));
  }
});
test('CLI bad arguments fail with FOLDERS FAILED', () => {
  for (const args of [[], ['find'], ['find', '--home', scratch, '--out', path.join(scratch, 'bad.json'), '--credentials-from', 'asked']]) {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../folders.mjs', import.meta.url)), ...args], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /^FOLDERS FAILED:/);
  }
});

test('quick pass finds common folders and Other computers copies before general walking', () => {
  const f = fixture(), other = dir(scratch, 'quick-cloud', 'Other computers');
  const c = dir(other, 'PC', 'Documents', 'GitHub', 'credentials');
  const k = repo(dir(f.home, 'Documents', 'GitHub'));
  const original = fs.readdirSync, listed = [];
  fs.readdirSync = (p, ...args) => { listed.push(String(p)); return original(p, ...args); };
  let r;
  try { r = findFolders(f, { TEAM_FOLDER_ROOTS: other, TEAM_FOLDER_BUDGET: '8' }); }
  finally { fs.readdirSync = original; }
  assert.equal(r.credentials.path, c); assert.equal(r.knowledge.path, k);
  assert.equal(new Set(listed).size, listed.length, 'each folder is listed only once');
});
test('general walk is breadth-first and interleaves roots at each level', () => {
  const f = fixture(), first = dir(scratch, 'breadth-first'), later = dir(scratch, 'breadth-later');
  for (let i = 0; i < 25; i++) dir(first, `branch-${i}`, 'deep', 'deeper');
  const k = repo(dir(later, 'unusual'));
  // Three root listings in quick pass, then one directory per root in each round.
  const r = findFolders(f, { TEAM_FOLDER_ROOTS: [first, later].join(path.delimiter), TEAM_FOLDER_BUDGET: '5' });
  assert.equal(r.knowledge.path, k); assert.equal(r.searchIncomplete, true);
});
test('time cap keeps quick-pass findings and uses the test-only seconds override', () => {
  const f = fixture(), k = repo(f.home); dir(f.home, 'slow');
  const original = fs.readdirSync, now = Date.now; let clock = 0;
  Date.now = () => clock;
  fs.readdirSync = (p, ...args) => {
    const entries = original(p, ...args);
    if (path.basename(String(p)) === 'slow') clock = 1100;
    return entries;
  };
  let r;
  try { r = findFolders(f, { ...env, TEAM_FOLDER_SECONDS: '1' }); }
  finally { fs.readdirSync = original; Date.now = now; }
  assert.equal(r.knowledge.path, k); assert.equal(r.searchIncomplete, true);
  assert.equal(r.advice.length, 1);
});
test('none and empty disable default extra roots without probing drives', () => {
  const f = fixture(), original = fs.lstatSync, touches = [];
  fs.lstatSync = (p, ...args) => { if (/^[D-Z]:[\\/](My Drive|Other computers)$/i.test(String(p))) touches.push(p); return original(p, ...args); };
  try { for (const value of ['', 'none']) findFolders(f, { TEAM_FOLDER_ROOTS: value }); }
  finally { fs.lstatSync = original; }
  assert.deepEqual(touches, []);
});

test('the seconds override cannot lengthen the thirty-second limit', () => {
  const f = fixture(), original = fs.readdirSync, now = Date.now; let clock = 0;
  Date.now = () => clock;
  fs.readdirSync = (p, ...args) => { const entries = original(p, ...args); clock = 31000; return entries; };
  let r;
  try { r = findFolders(f, { ...env, TEAM_FOLDER_SECONDS: '300' }); }
  finally { fs.readdirSync = original; Date.now = now; }
  assert.equal(r.searchIncomplete, true);
});
