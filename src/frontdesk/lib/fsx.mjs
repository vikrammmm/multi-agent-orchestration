// Small file helpers shared by the front desk: hashes, atomic writes, safe JSON reads, and a short lock.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const sha256File = (file) => sha256(fs.readFileSync(file));

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (fallback !== undefined && (e.code === 'ENOENT' || e instanceof SyntaxError)) return fallback; throw e; }
}

export function readJsonState(file) {
  try { return { exists: true, ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (error) { return { exists: error.code !== 'ENOENT', ok: false, error }; }
}

export async function readJsonBounded(file, { fallback, maxBytes = 1024 * 1024, readFile = fs.promises.readFile, stat = fs.promises.stat } = {}) {
  try {
    const info = await stat(file);
    if (info.size > maxBytes) throw Object.assign(new Error('JSON file exceeds its size limit'), { code: 'EFBIG' });
    const data = await readFile(file);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (bytes.length > maxBytes) throw Object.assign(new Error('JSON file exceeds its size limit'), { code: 'EFBIG' });
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

// Write to a temporary name next to the target, then rename over it, so a reader never sees half a file.
export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}

export function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// A cooperative lock: create a file exclusively; a lock older than staleMs is taken over. Returns a release function.
export function lock(file, { staleMs = 30000, waitMs = 5000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try { const fd = fs.openSync(file, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.unlinkSync(file); continue; } } catch { continue; }
      if (Date.now() > until) throw new Error(`lock busy: ${file}`);
      const t = Date.now() + 50; while (Date.now() < t) { /* brief spin; locks are held for milliseconds */ }
    }
  }
}

export function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base)); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

export const nowIso = () => new Date().toISOString();
