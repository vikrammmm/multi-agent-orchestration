// Finds the delegation CLIs on this machine and their versions. Results are cached in state/tools.json; `doctor` refreshes them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, writeAtomic, nowIso } from './fsx.mjs';

const WIN = process.platform === 'win32';
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
export const firstVersion = (text) => (String(text || '').match(/\d+\.\d+(?:\.\d+)?/) || [''])[0];

export function versionAtLeast(have, want) {
  const a = String(have || '').split('.').map((x) => parseInt(x, 10) || 0), b = String(want || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d > 0; }
  return true;
}

function onPath(name) {
  const r = spawnSync(WIN ? 'where.exe' : 'which', [name], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(isFile);
}

function newestChild(dir, pattern) {
  if (!isDir(dir)) return null;
  const kids = fs.readdirSync(dir).map((n) => path.join(dir, n)).filter(isDir).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const k of kids) { const f = pattern(k); if (f && isFile(f)) return f; }
  return null;
}

function candidates(name, home) {
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const list = [];
  if (name === 'claude') {
    list.push(path.join(home, '.local', 'bin', WIN ? 'claude.exe' : 'claude'));
    const app = newestChild(path.join(roaming, 'Claude', 'claude-code'), (d) => path.join(d, 'claude.exe')); if (app) list.push(app);
  } else if (name === 'codex') {
    const app = newestChild(path.join(local, 'OpenAI', 'Codex', 'bin'), (d) => path.join(d, 'codex.exe')); if (app) list.push(app);
    list.push(path.join(home, '.local', 'bin', WIN ? 'codex.cmd' : 'codex'));
  } else if (name === 'cursor') {
    list.push(path.join(local, 'cursor-agent', WIN ? 'cursor-agent.cmd' : 'cursor-agent'), path.join(home, '.local', 'bin', WIN ? 'cursor-agent.cmd' : 'cursor-agent'));
  } else if (name === 'muse') {
    list.push(path.join(local, 'Programs', 'muse', WIN ? 'muse.cmd' : 'muse'), path.join(home, '.local', 'bin', 'muse'));
  } else if (name === 'qwen') {
    list.push(path.join(home, '.local', 'bin', WIN ? 'qwen.cmd' : 'qwen'));
  }
  return list.filter(isFile);
}
const PATH_NAMES = { claude: 'claude', codex: 'codex', cursor: 'cursor-agent', muse: 'muse', qwen: 'qwen' };

export function probeEnvironment(file, base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^MUSE_(INTERNAL_|LAUNCHER_|UPDATE|NO_AUTO)/.test(key)) delete env[key];
  Object.assign(env, { MUSE_UPDATE_INTERVAL_SECONDS: '2147483647', MUSE_NO_AUTO_UPDATE: '1', MUSE_LOGIN: '0' });
  const name = path.basename(file).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (['claude', 'codex', 'cursor-agent'].includes(name)) env.DISABLE_AUTOUPDATER = '1';
  return env;
}

function metadataVersion(file) {
  const pathVersion = String(file).split(/[\\/]/).map(firstVersion).find((v) => v && /^\d+\.\d+(?:\.\d+)?$/.test(v));
  if (pathVersion) return pathVersion;
  let dir = path.dirname(file);
  for (let i = 0; i < 3; i++, dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.version && /claude|codex|cursor-agent|muse/i.test(String(pkg.name || ''))) return firstVersion(pkg.version);
    } catch { /* wrappers often have no adjacent package metadata */ }
  }
  return '';
}

export function versionOf(file, runner = spawnSync) {
  const metadata = metadataVersion(file);
  if (metadata) return metadata;
  const cmd = /\.(cmd|bat)$/i.test(file);
  const env = probeEnvironment(file);
  const r = cmd
    ? runner(`"${file}" --version`, { encoding: 'utf8', timeout: 15000, shell: true, windowsHide: true, env })
    : runner(file, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true, env });
  return r.status === 0 ? firstVersion(r.stdout + r.stderr) : '';
}

export function detectAll(home) {
  const out = { detectedAt: nowIso(), tools: {} };
  for (const name of Object.keys(PATH_NAMES)) {
    const found = [...candidates(name, home), ...onPath(PATH_NAMES[name])];
    let hit = null;
    for (const f of [...new Set(found)]) { const v = versionOf(f); if (v) { hit = { path: f, version: v }; break; } }
    out.tools[name] = hit;
  }
  return out;
}

// route name used in the ladder -> tool key
export const TOOL_OF_ROUTE = { 'claude-code': 'claude', codex: 'codex', cursor: 'cursor', muse: 'muse', qwen: 'qwen' };

export function loadTools(L, { refresh = false, ttlMs = 3600_000, detect = detectAll } = {}) {
  const file = path.join(L.state, 'tools.json');
  const cached = readJson(file, null);
  if (!refresh && cached && Date.now() - Date.parse(cached.detectedAt) < ttlMs) return cached;
  const fresh = detect(L.home);
  try { writeAtomic(file, JSON.stringify(fresh, null, 1)); } catch { /* a read-only state folder must not stop planning */ }
  return fresh;
}
