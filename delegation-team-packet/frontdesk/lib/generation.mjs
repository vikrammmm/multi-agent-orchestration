// A "generation" is one verified copy of a published ladder release on this machine. The front desk only ever reads the installed
// generation (never the live Drive copy). The installer stages a complete generation, verifies every hash, switches `current.json`
// to it and keeps the previous one for rollback.
import fs from 'node:fs';
import path from 'node:path';
import { READER_SCHEMA } from './paths.mjs';
import { readJson, readJsonState, sha256File } from './fsx.mjs';

export function verifyFiles(dir, files) {
  const problems = [];
  for (const [rel, want] of Object.entries(files || {})) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) { problems.push({ file: rel, problem: 'missing' }); continue; }
    const got = sha256File(p);
    if (got !== want) problems.push({ file: rel, problem: 'hash mismatch' });
  }
  return problems;
}

export function compatible(manifest) {
  const m = manifest?.compat;
  return !!m && m.minReader <= READER_SCHEMA && READER_SCHEMA <= m.maxReader;
}

// Read the installed generation. Returns { ok, problems, generation, dir, manifest, ladder, ctx } (ladder and ctx only when ok).
export function loadCurrent(L, { withLadder = true } = {}) {
  const current = readJsonState(L.current);
  if (!current.exists) return { ok: false, problems: [{ file: 'current.json', problem: 'missing' }] };
  if (!current.ok) return { ok: false, problems: [{ file: 'current.json', problem: current.error instanceof SyntaxError ? 'invalid JSON' : 'unreadable' }] };
  const cur = current.value;
  if (!cur || typeof cur !== 'object' || Array.isArray(cur) || typeof cur.dir !== 'string' || !cur.dir) return { ok: false, problems: [{ file: 'current.json', problem: 'invalid structure' }] };
  const dir = path.join(L.generations, cur.dir);
  const manifestRead = readJsonState(path.join(dir, 'manifest.json'));
  if (!manifestRead.exists) return { ok: false, problems: [{ file: 'manifest.json', problem: 'missing' }], generation: cur.generation, dir };
  if (!manifestRead.ok) return { ok: false, problems: [{ file: 'manifest.json', problem: manifestRead.error instanceof SyntaxError ? 'invalid JSON' : 'unreadable' }], generation: cur.generation, dir };
  const manifest = manifestRead.value;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, problems: [{ file: 'manifest.json', problem: 'invalid structure' }], generation: cur.generation, dir };
  if (!manifest.installed || typeof manifest.installed !== 'object' || Array.isArray(manifest.installed) || !Object.keys(manifest.installed).length) {
    return { ok: false, problems: [{ file: 'manifest.json', problem: 'missing installed hash map' }], generation: manifest.generation ?? cur.generation, dir, manifest };
  }
  const problems = verifyFiles(dir, manifest.installed);
  if (!compatible(manifest)) problems.push({ file: 'manifest.json', problem: `schema not readable by this front desk (reader ${READER_SCHEMA})` });
  if (problems.length) return { ok: false, problems, generation: manifest.generation, dir, manifest };
  const out = { ok: true, problems: [], generation: manifest.generation, release: manifest.release, dir, manifest };
  if (withLadder) { out.ladder = readJson(path.join(dir, 'ladder.json')); out.ctx = readJson(path.join(dir, 'guard-ctx.json')); out.requirements = readJson(path.join(dir, 'requirements.json'), {}); }
  return out;
}

export function allEngineers(ladder) {
  return ladder.roles.flatMap((r) => r.engineers.map((e) => ({ ...e, role: r.role })));
}
