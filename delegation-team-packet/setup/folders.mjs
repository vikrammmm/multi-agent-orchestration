#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const weak = /(^|[\s._-])(creds?|credentials|secrets?)([\s._-]|$)/i;
const excluded = /^(AppData|Library|node_modules|Windows|Program Files|Program Files \(x86\)|ProgramData|venv|__pycache__)$/i;
const stopped = 'The folder search stopped early (too many folders); set the folders with --credentials and --knowledge if one is missing.';
const stat = (file) => { try { return fs.lstatSync(file); } catch { return null; } };
const directory = (file) => { const s = file && stat(file); return !!s?.isDirectory() && !s.isSymbolicLink(); };
const existingDirectory = (file) => { try { return fs.statSync(file).isDirectory(); } catch { return false; } };
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

function extraRoots(home, env) {
  if (env.TEAM_FOLDER_ROOTS !== undefined) return env.TEAM_FOLDER_ROOTS === 'none' ? [] : env.TEAM_FOLDER_ROOTS.split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    return Array.from({ length: 23 }, (_, i) => String.fromCharCode(68 + i))
      .flatMap(d => [`${d}:\\My Drive`, `${d}:\\Other computers`]).filter(directory);
  }
  if (process.platform === 'darwin') {
    const cloud = path.join(home, 'Library', 'CloudStorage');
    try { return fs.readdirSync(cloud).map(n => path.join(cloud, n)).filter(directory); } catch {}
  }
  return [];
}

// Only metadata is inspected here. In particular a credential candidate is never listed.
export function findFolders(opts, env = process.env) {
  const result = { credentials: { path: null, source: null, candidates: [] },
    knowledge: { path: null, source: null, candidates: [] }, searchIncomplete: false, advice: [] };
  const blocked = new Set();
  for (const kind of ['credentials', 'knowledge']) {
    if (!opts[kind]) continue;
    const value = path.resolve(opts[kind]), source = opts[`${kind}-from`] || 'set';
    if (existingDirectory(value)) { result[kind].path = value; result[kind].source = source; }
    else if (source === 'set') {
      blocked.add(kind);
      result.advice.push(`The folder given with --${kind} does not exist: ${opts[kind]}.`);
    } else result.advice.push(`The remembered ${kind} folder ${opts[kind]} no longer exists; searched again.`);
  }
  if (result.credentials.path && result.knowledge.path) return result;
  const matches = { credentials: [], knowledge: [] }, inspected = new Map(), listings = new Map();
  const start = Date.now(), budget = Number(env.TEAM_FOLDER_BUDGET) > 0 ? Math.min(40000, Number(env.TEAM_FOLDER_BUDGET)) : 40000;
  const seconds = Number(env.TEAM_FOLDER_SECONDS) > 0 ? Math.min(30, Number(env.TEAM_FOLDER_SECONDS)) : 30;
  let listed = 0;
  function expired() {
    if (Date.now() - start >= seconds * 1000) result.searchIncomplete = true;
    return result.searchIncomplete;
  }
  const pathKey = p => process.platform === 'win32' ? p.toLowerCase() : p;
  const privatePaths = new Set();
  if (result.credentials.path) {
    privatePaths.add(pathKey(path.resolve(result.credentials.path)));
    // A supplied directory may be a link. Its target stays private if another root reaches it.
    try { privatePaths.add(pathKey(fs.realpathSync(result.credentials.path))); } catch {}
  }
  function safeAncestors(file) {
    let parent = path.dirname(file);
    while (true) {
      if (weak.test(path.basename(parent)) || privatePaths.has(pathKey(parent)) || stat(parent)?.isSymbolicLink()) return false;
      const next = path.dirname(parent);
      if (next === parent) return true;
      parent = next;
    }
  }
  function inspect(folder) {
    folder = path.resolve(folder);
    const key = pathKey(folder);
    if (inspected.has(key)) return inspected.get(key);
    inspected.set(key, false);
    if (expired() || !safeAncestors(folder) || !directory(folder) || privatePaths.has(key)) return false;
    const name = path.basename(folder);
    if (/^[.$]/.test(name) || excluded.test(name)) return;
    const other = folder.split(path.sep).some(n => /^Other computers$/i.test(n));
    if (weak.test(name)) {
      if (!result.credentials.path) matches.credentials.push({ path: folder, strong: /^credentials$/i.test(name),
        origin: false, other, activity: stat(folder)?.mtimeMs || 0 });
      return;
    }
    const git = path.join(folder, '.git'), gitStat = stat(git);
    if (gitStat) {
      if (!result.knowledge.path && /^second[-_ ]?brain$/i.test(name)) {
        if (gitStat.isSymbolicLink()) return;
        let gitDir = git, origin = false, activity = 0;
        if (gitStat.isFile()) {
          const m = read(git).match(/^gitdir:\s*(.+?)\s*$/im);
          gitDir = m ? path.resolve(folder, m[1]) : null;
        }
        // A .git file counts even when its metadata is unavailable. Unsafe metadata
        // is never read, and contributes neither origin preference nor activity.
        if (gitDir && safeAncestors(gitDir) && directory(gitDir) && safeAncestors(path.join(gitDir, 'config'))) {
          const configPath = path.join(gitDir, 'config');
          const config = stat(configPath)?.isSymbolicLink() ? '' : read(configPath);
          let inOrigin = false;
          for (const line of config.split(/\r?\n/)) {
            if (/^\s*\[/.test(line)) inOrigin = /^\s*\[remote\s+"origin"\]\s*$/i.test(line);
            else if (inOrigin && /^\s*url\s*=\s*.*\/secondbrain(?:\.git)?\s*$/i.test(line)) origin = true;
          }
          activity = Math.max(0, ...['index', 'logs/HEAD', 'FETCH_HEAD'].map(f => {
            const file = path.join(gitDir, f);
            return safeAncestors(file) ? stat(file)?.mtimeMs || 0 : 0;
          }));
        }
        matches.knowledge.push({ path: folder, strong: true, origin, other, activity });
      }
      return;
    }
    inspected.set(key, true);
    return true;
  }
  function children(folder) {
    const key = pathKey(path.resolve(folder));
    if (expired() || !inspect(folder)) return [];
    if (listings.has(key)) return listings.get(key);
    if (listed >= budget) { result.searchIncomplete = true; return []; }
    listed++;
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { entries = []; }
    const dirs = entries.filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => path.join(folder, e.name));
    listings.set(key, dirs);
    // Inspect names and git metadata, never enter a credential candidate or repository.
    for (const child of dirs) { if (expired()) break; inspect(child); }
    return dirs;
  }
  const roots = [[path.resolve(opts.home), 4], ...(opts.repos ? [[path.resolve(opts.repos), 2]] : []),
    ...extraRoots(opts.home, env).map(p => [path.resolve(p), 5])];
  const common = ['', 'Documents', 'Documents/GitHub', 'GitHub', 'source/repos', 'repos',
    'src', 'code', 'Code', 'projects', 'Projects', 'dev', 'work', 'workspace', 'git', 'Desktop'];
  function quickParent(root, relative) {
    let parent = root;
    for (const part of relative.split('/').filter(Boolean)) {
      if (expired() || !inspect(parent)) return;
      parent = path.join(parent, part);
    }
    children(parent);
  }
  // Try the usual places across roots before spending the remainder on a full walk.
  for (const relative of common) for (const [root] of roots) {
    if (expired()) break;
    quickParent(root, relative);
  }
  for (const [root] of roots) if (/^Other computers$/i.test(path.basename(root))) {
    for (const pc of children(root)) for (const relative of ['', 'Documents', 'Documents/GitHub', 'GitHub', 'Desktop']) {
      if (expired()) break;
      quickParent(pc, relative);
    }
  }
  // Each root gets a turn within each level. Cached quick-pass listings are reused,
  // so they are not listed or charged again and their deeper descendants remain reachable.
  let frontiers = roots.map(([root]) => [root]);
  for (let level = 0; !expired() && frontiers.some(f => f.length); level++) {
    const next = roots.map(() => []), positions = roots.map(() => 0);
    while (!expired() && frontiers.some((f, i) => positions[i] < f.length)) {
      for (let i = 0; i < roots.length && !expired(); i++) {
        if (positions[i] >= frontiers[i].length || level > roots[i][1]) continue;
        const folder = frontiers[i][positions[i]++];
        if (level < roots[i][1]) { for (const child of children(folder)) next[i].push(child); }
        else inspect(folder);
      }
    }
    frontiers = next;
  }
  for (const kind of ['credentials', 'knowledge']) {
    const ranked = [...new Map(matches[kind].map(c => [c.path, c])).values()].sort((a, b) => Number(b.origin) - Number(a.origin) || Number(a.other) - Number(b.other)
      || b.activity - a.activity || a.path.length - b.path.length || a.path.localeCompare(b.path));
    result[kind].candidates = ranked.slice(0, 9).map(({ path, strong }) => ({ path, strong }));
    const chosen = ranked.find(c => c.strong);
    if (chosen && !blocked.has(kind)) { result[kind].path = chosen.path; result[kind].source = 'found'; }
    if (result[kind].path && chosen && !result[kind].candidates.some(c => c.path === chosen.path)) {
      result[kind].candidates[8] = { path: chosen.path, strong: true };
    }
  }
  if (result.searchIncomplete) result.advice.push(stopped);
  return result;
}

export const foldersIntro = 'Your folders (remembered by the packet installer and kept on every later run; to change one, run the\ninstaller again with `--credentials <folder>` or `--knowledge <folder>`):';
export function renderFolders(data, out) {
  const profile = [], section = [foldersIntro, ''], summary = [];
  for (const kind of ['credentials', 'knowledge']) {
    const item = data[kind], label = kind === 'credentials' ? 'Credentials folder' : 'Knowledge base (SecondBrain repository)';
    const sectionLabel = kind === 'credentials' ? label : 'Knowledge base (the SecondBrain repository)';
    const how = { found: 'found', set: `set with --${kind}`, asked: 'chosen by you', kept: 'kept from the last run' }[item.source];
    const alternatives = (item.candidates || []).filter(c => c.path !== item.path).map(c => c.path);
    if (item.path) {
      if (!path.isAbsolute(item.path) || !how) throw new Error(`invalid ${kind} decision`);
      profile.push(`- ${label}: \`${item.path}\` (${how})`);
      const p = item.path.replace(/\\/g, '/');
      section.push(kind === 'credentials'
        ? `- ${sectionLabel}: \`${p}\`. The person's logins, keys and account details;\n  use it when a task needs them.`
        : `- ${sectionLabel}: \`${p}\`. Look there for project and background\n  knowledge before asking the person.`);
    } else {
      profile.push(`- ${label}: not set; run this installer with --${kind} <folder> to set it`);
      section.push(`- ${sectionLabel}: not set. Ask the person once where it is, then run\n  the packet installer again with \`--${kind} <folder>\` so every later chat has it.`);
    }
    summary.push(`${kind === 'credentials' ? label : 'Knowledge base'}: ${item.path || 'not set'}${item.path
      ? ` (${how}${alternatives.length ? `; also found: ${alternatives.join(', ')}` : ''})`
      : alternatives.length ? ` (candidates: ${alternatives.join(', ')})` : ''}`);
  }
  fs.mkdirSync(out, { recursive: true });
  for (const [name, lines] of [['folders.md', profile], ['folders-section.md', section],
    ['folders-summary.txt', [...summary, ...(data.advice || [])]]]) fs.writeFileSync(path.join(out, name), lines.join('\n') + '\n');
}

function main(argv) {
  const command = argv.shift(), opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const allowed = command === 'find' ? ['home', 'repos', 'credentials', 'credentials-from', 'knowledge', 'knowledge-from', 'out'] : ['decided', 'out'];
    if (!argv[i]?.startsWith('--') || !allowed.includes(argv[i].slice(2)) || !argv[i + 1]) throw new Error('invalid arguments');
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  if (!opts.out) throw new Error('expected --out');
  if (command === 'find') {
    if (!opts.home) throw new Error('expected --home');
    for (const kind of ['credentials', 'knowledge']) {
      if (opts[`${kind}-from`] && (!opts[kind] || !['set', 'kept'].includes(opts[`${kind}-from`]))) throw new Error(`invalid --${kind}-from`);
    }
    fs.writeFileSync(opts.out, JSON.stringify(findFolders(opts), null, 2) + '\n');
  } else if (command === 'render' && opts.decided) renderFolders(JSON.parse(fs.readFileSync(opts.decided, 'utf8')), opts.out);
  else throw new Error('expected find or render');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`FOLDERS FAILED: ${e.message}`); process.exitCode = 1; }
}
