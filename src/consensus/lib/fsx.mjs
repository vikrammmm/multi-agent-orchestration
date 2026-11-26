import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const INTEGRITY_EXCLUDE = [
  '.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', '__pycache__',
];

export function isExcludedName(name) {
  return INTEGRITY_EXCLUDE.includes(name) || name.startsWith('.consensus');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function toLf(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function writeUtf8(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, toLf(text), { encoding: 'utf8' });
}

export function readUtf8(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

export function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const json = toLf(JSON.stringify(obj, null, 2)) + '\n';
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, json, { encoding: 'utf8' });
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(file); } catch { /* dest may not exist */ }
    fs.renameSync(tmp, file);
  }
}

export function readJson(file) {
  return JSON.parse(readUtf8(file));
}

export function tryReadJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return readJson(file);
  } catch {
    return null;
  }
}

export function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', { encoding: 'utf8' });
}

export function sha256String(text) {
  return crypto.createHash('sha256').update(toLf(text), 'utf8').digest('hex');
}

export function sha256File(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256(input) {
  if (typeof input === 'string' && fs.existsSync(input) && fs.statSync(input).isFile()) {
    return sha256File(input);
  }
  return sha256String(String(input));
}

export function rmrf(dir) {
  if (!dir || dir === path.parse(dir).root) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

export function copyDir(src, dest, exclude = []) {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  const skip = new Set(exclude);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    if (skip.has(ent.name) || isExcludedName(ent.name)) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(from, to, exclude);
    else if (ent.isFile()) {
      ensureDir(path.dirname(to));
      fs.copyFileSync(from, to);
    }
  }
}

function walkFiles(root, dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (isExcludedName(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(root, full, out);
    else if (ent.isFile()) {
      try {
        const st = fs.statSync(full);
        out.push({
          path: toLf(path.relative(root, full).split(path.sep).join('/')),
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch { /* raced */ }
    }
  }
}

export function integrityManifest(root) {
  const files = [];
  if (root && fs.existsSync(root)) walkFiles(root, root, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export function manifestEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.path !== y.path || x.size !== y.size || x.mtimeMs !== y.mtimeMs) return false;
  }
  return true;
}

export function exists(file) {
  return fs.existsSync(file);
}

// Long, symlink-free absolute form of a directory. A Windows 8.3 short name such as
// C:\Users\LONGNA~1 makes a restricted seat reject the path, so every directory handed to a seat
// or stored in a ledger goes through here.
export function realDir(dir) {
  const resolved = path.resolve(String(dir));
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}
