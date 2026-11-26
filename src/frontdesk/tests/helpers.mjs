// Shared test helpers: a throwaway home with an installed generation, written by hand so the tests do not depend on the installer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { layout } from '../lib/paths.mjs';
import { RUNTIME, seal } from '../seal.mjs';
import { fileURLToPath } from 'node:url';

// Child processes see fixture tools only; inherited worker flags belong to the runner, not the simulated caller.
export function testEnv(home, extra = {}) {
  const env = { ...process.env, FRONTDESK_HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
  for (const key of Object.keys(env)) if (/^(DELEGATION_DISPATCHED|CONSENSUS_SEAT|FRONTDESK_TEST_)/.test(key)) delete env[key];
  const python = (process.env.PATH || '').split(path.delimiter).filter((p) => /python/i.test(p));
  env.PATH = [...python, ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
  return { ...env, ...extra };
}

// A fixed published-release fixture: no publisher, builder, commission register or network is involved.
export function fixtureRelease(shared, { generation = 1, wonderHold = false } = {}) {
  const ladder = miniLadder();
  const engineer = (family, route, order, extra = {}) => ({ ...ladder.roles[0].engineers[0], key: `${family}|high`, family, effort: 'high', callOrder: order,
    routes: [{ route, wallet: 'fixture plan', readOnlyLock: 'firm', exec: { model: family === 'grok-4.7' ? 'grok-4.7-xhigh-fast' : family, effort: 'high' } }], ...extra });
  ladder.roles[0].engineers.unshift(engineer('qwen-local', 'qwen', 0));
  ladder.roles[1].engineers.unshift(engineer('qwen-local', 'qwen', 0), engineer('claude-haiku-5-5', 'claude-code', 1));
  ladder.roles[2].engineers.unshift(engineer('grok-4.7', 'cursor', 0));
  for (const [i, family] of ['muse-wonder-1.0', 'muse-wonder-full-1.0'].entries()) ladder.roles[3].engineers.push(engineer(family, 'muse', i + 2, wonderHold ? { commission: { state: 'billing_hold' } } : {}));
  const release = `fixture${generation}`;
  const files = { 'ladder.json': JSON.stringify(ladder), 'guard-ctx.json': JSON.stringify({ schema: 1, generation, release, commissioned: ladder.roles.flatMap((r) => r.engineers.map((e) => e.key)) }), 'requirements.json': JSON.stringify({ requirements: {}, rules: {} }), 'summary.md': '# fixture\n' };
  const dir = path.join(shared, 'ladder', 'releases', release);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const manifest = { schema: 1, compat: { minReader: 1, maxReader: 1 }, generation, release, time: '2026-10-14T00:00:00Z', publisher: { machine: 'TEST' }, source: { inputsHash: 'fixture' }, installable: Object.keys(files), files: Object.fromEntries(Object.entries(files).map(([name, text]) => [`releases/${release}/${name}`, sha(text)])) };
  fs.writeFileSync(path.join(shared, 'ladder', 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

export const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const tmp = (p = 'fd-test-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
export const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

export function fixtureWorld() {
  const root = tmp('fd-contract-'), home = path.join(root, 'home'), shared = path.join(root, 'shared');
  fs.mkdirSync(home);
  const src = fileURLToPath(new URL('..', import.meta.url));
  for (const rel of RUNTIME) { const dst = path.join(shared, 'frontdesk', rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(src, rel), dst); }
  seal(path.join(shared, 'frontdesk'));
  fixtureRelease(shared);
  return { root, home, shared, L: layout(home), installer: path.join(shared, 'frontdesk', 'install-frontdesk.mjs') };
}

export function snapshot(dir) {
  const out = {};
  const walk = (base, rel = '') => {
    for (const name of fs.readdirSync(base).sort()) {
      const file = path.join(base, name), key = rel ? `${rel}/${name}` : name, stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) out[key] = ['link', fs.readlinkSync(file)];
      else if (stat.isDirectory()) { out[key] = ['dir']; walk(file, key); }
      else out[key] = ['file', sha(fs.readFileSync(file))];
    }
  };
  walk(dir); return out;
}

export function miniLadder() {
  const e = (key, family, effort, role, callOrder, extra = {}) => ({ key, family, effort, role, callOrder, commissioned: true, isNew: false, ownerCleared: null, ii: 40, effectiveCost: 0.1, cost: 0.1,
    routes: [{ route: 'codex', wallet: 'ChatGPT plan', readOnlyLock: 'firm (sandbox)', exec: { tool: 'codex', model: family, effort, use: 'standard', problem: null, guessedId: false } }], ...extra });
  return { generatedAt: '2026-10-14T00:00:00Z', source: {}, counts: {}, roles: [
    { role: 'Junior', min: 25, engineers: [e('a|low', 'a', 'low', 'Junior', 1)] },
    { role: 'Developer', min: 36, engineers: [e('b|high', 'b', 'high', 'Developer', 1), e('c|max', 'c', 'max', 'Developer', 2)] },
    { role: 'Tech lead', min: 44, engineers: [e('d|high', 'd', 'high', 'Tech lead', 1)] },
    { role: 'CTO', min: 51, engineers: [e('e|xhigh', 'e', 'xhigh', 'CTO', 1)] },
  ] };
}

// Writes bin files, one generation, current.json and the receipt under a fake home. Returns { home, L, genDir, receipt }.
export function installFake({ commissioned = ['b|high'], helpers = {}, mode = 'shadow', withReceipt = true } = {}) {
  const home = tmp();
  const L = layout(home);
  const genName = '1-testrelease';
  const genDir = path.join(L.generations, genName);
  fs.mkdirSync(genDir, { recursive: true });
  const files = {
    'ladder.json': JSON.stringify(miniLadder()),
    'guard-ctx.json': JSON.stringify({ schema: 1, generation: 1, release: 'testrelease', commissioned }),
    'requirements.json': JSON.stringify({ requirements: { families: [], tools: {} }, rules: { modeExclusions: [] } }),
    'summary.md': '# test\n',
    'helpers.json': JSON.stringify({ schema: 1, helpers }),
  };
  const installed = {};
  for (const [n, t] of Object.entries(files)) { fs.writeFileSync(path.join(genDir, n), t); installed[n] = sha(t); }
  fs.writeFileSync(path.join(genDir, 'manifest.json'), JSON.stringify({ schema: 1, compat: { minReader: 1, maxReader: 1 }, generation: 1, release: 'testrelease', time: '2026-10-14T00:00:00Z', publisher: { machine: 'TEST' }, source: { inputsHash: 'abc' }, installed }));
  fs.writeFileSync(L.current, JSON.stringify({ generation: 1, release: 'testrelease', dir: genName, previous: null }));
  fs.mkdirSync(L.state, { recursive: true });
  fs.writeFileSync(path.join(L.state, 'mode.json'), JSON.stringify({ default: mode }));
  fs.mkdirSync(L.bin, { recursive: true });
  const binFiles = { 'role.mjs': 'x' };
  fs.writeFileSync(path.join(L.bin, 'role.mjs'), 'x');
  const receipt = { schema: 1, release: 'testrelease', generation: 1, binFiles: { 'role.mjs': sha('x') }, installed };
  if (withReceipt) fs.writeFileSync(L.receipt, JSON.stringify(receipt));
  return { home, L, genDir, receipt, binFiles };
}
