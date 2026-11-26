// The local install receipt decides how this machine delegates, not the wording of the shared rulebook:
//   never-installed  no receipt: the legacy table in POLICY.md applies (a machine before its install)
//   healthy          every installed file matches its hash and the current generation verifies: route by role
//   broken           a receipt exists but something is missing or changed: no legacy fallback; stop delegating and report
import fs from 'node:fs';
import path from 'node:path';
import { readJsonState, sha256File } from './fsx.mjs';
import { loadCurrent } from './generation.mjs';

export const TEAM_REQUIRED_EXCLUSIONS = ['qwen-local'];
export const EXCLUSION_ID = /^[A-Za-z0-9._-]+$/;
export const excludedIds = (receipt) => new Set([...(receipt?.exclusions?.required || []), ...(receipt?.exclusions?.declared || [])]);

export function exclusionProblems(receipt) {
  const problems = [];
  if ('installedBy' in receipt && receipt.installedBy !== 'team-packet') problems.push({ file: 'receipt.installedBy', problem: 'must be team-packet or absent' });
  if ('exclusions' in receipt) {
    const x = receipt.exclusions;
    const ids = (a) => Array.isArray(a) && a.every((id) => typeof id === 'string' && id === id.trim() && EXCLUSION_ID.test(id)) && a.every((id, i) => i === 0 || a[i - 1] < id);
    if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).sort().join(',') !== 'declared,required' || !ids(x.required) || !ids(x.declared)) problems.push({ file: 'receipt.exclusions', problem: 'must contain required and declared arrays of sorted, unique valid ids' });
  }
  if (receipt.installedBy === 'team-packet' && (!receipt.exclusions || !Array.isArray(receipt.exclusions.required) || TEAM_REQUIRED_EXCLUSIONS.some((id) => !receipt.exclusions.required.includes(id)))) problems.push({ file: 'receipt.exclusions.required', problem: `team-packet requires ${TEAM_REQUIRED_EXCLUSIONS.join(', ')}` });
  return problems;
}

export function installState(L) {
  const saved = readJsonState(L.receipt);
  if (!saved.exists) return { state: 'never-installed', problems: [], receipt: null };
  if (!saved.ok) return { state: 'broken', problems: [{ file: 'receipt', problem: saved.error instanceof SyntaxError ? 'invalid JSON' : 'unreadable' }], receipt: null };
  const receipt = saved.value;
  const problems = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { state: 'broken', problems: [{ file: 'receipt', problem: 'invalid structure' }], receipt: null };
  problems.push(...exclusionProblems(receipt));
  const isHashMap = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length > 0;
  if (!isHashMap(receipt.binFiles)) problems.push({ file: 'receipt.binFiles', problem: 'missing hash map' });
  if (!isHashMap(receipt.installed)) problems.push({ file: 'receipt.installed', problem: 'missing hash map' });
  for (const [rel, want] of Object.entries(isHashMap(receipt.binFiles) ? receipt.binFiles : {})) {
    const p = path.join(L.bin, rel);
    if (!fs.existsSync(p)) problems.push({ file: `bin/${rel}`, problem: 'missing' });
    else if (sha256File(p) !== want) problems.push({ file: `bin/${rel}`, problem: 'changed since install' });
  }
  const cur = loadCurrent(L, { withLadder: false });
  if (!cur.ok) for (const p of cur.problems) problems.push({ file: `generation ${p.file}`, problem: p.problem });
  else if (receipt.release && cur.release !== receipt.release) problems.push({ file: 'current.json', problem: `points at release ${cur.release}, the receipt says ${receipt.release}` });
  else if (isHashMap(receipt.installed) && !sameHashes(receipt.installed, cur.manifest.installed)) problems.push({ file: 'receipt.installed', problem: 'does not match generation manifest hashes' });
  return { state: problems.length ? 'broken' : 'healthy', problems, receipt, generation: cur.generation, release: cur.release };
}

function sameHashes(a, b) {
  const ak = Object.keys(a), bk = Object.keys(b || {});
  return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
}
