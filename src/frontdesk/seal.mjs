#!/usr/bin/env node
// Writes code-manifest.json: the sha256 of every runtime file of the front desk. The installer refuses to install files that do not match it
// (a half-synced Drive copy would otherwise be installed silently). Run after any change to the front desk code:  node seal.mjs
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const RUNTIME = ['role.mjs', 'hook.mjs', 'VERSION', 'lib/paths.mjs', 'lib/fsx.mjs', 'lib/generation.mjs', 'lib/receipts.mjs', 'lib/tools.mjs', 'lib/eligible.mjs', 'lib/guard.mjs', 'lib/hooklog.mjs', 'lib/names.mjs', 'lib/splice.mjs', 'lib/audit-logs.mjs', 'lib/samefile.mjs', 'lib/tomlcheck.mjs', 'install-frontdesk.mjs'];

export function seal(dir = here) {
  const files = {};
  for (const rel of RUNTIME) files[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex');
  const version = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim();
  const manifest = { schema: 1, version, files };
  fs.writeFileSync(path.join(dir, 'code-manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  const m = seal();
  console.log(`sealed ${Object.keys(m.files).length} files, version ${m.version}`);
}
