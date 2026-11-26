#!/usr/bin/env node
// Front desk installer (phase 1a), also installed by the team packet with --no-hooks. Installs on THIS machine:
//   - the front desk program   -> ~/.config/delegate-skills/frontdesk/bin
//   - one verified ladder generation -> .../frontdesk/generations/<n>-<release> (current.json points at it; the previous one is kept)
//   - log-only guard hooks in Claude Code and Codex by default (Muse only with explicit opt-in), each with a backup first
//   - a receipt (~/.config/delegate-skills/frontdesk-install.json) that decides whether this machine routes by role
//
//   node install-frontdesk.mjs [install] [--dry-run] [--yes] [--tools claude,codex] [--allow-unproven-muse] [--no-hooks] [--no-live-check] [--shared-root <dir>] [--home <dir>]
//   node install-frontdesk.mjs uninstall [--dry-run] [--yes]      removes our hook entries and the receipt; keeps logs and the program
//   node install-frontdesk.mjs status
// Install only: --exclude-required <id,id> adds sticky ids; --exclude-declared <id,id|-> sets ids (empty or - clears);
// --installed-by team-packet is sticky and adds the team's mandatory exclusions. Ids: [A-Za-z0-9._-]+.
// Dry run is the default unless --yes is given. Exit 0: success; 1: refused or prior state restored; 4: rollback incomplete.
// Test hooks require FRONTDESK_TEST_HOOKS=1: FRONTDESK_TEST_FAIL=before-commit|restore; FRONTDESK_TEST_STAMP fixes the backup prefix.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { layout, READER_SCHEMA, VERSION } from './lib/paths.mjs';
import { sha256, readJson, readJsonState, writeAtomic } from './lib/fsx.mjs';
import { verifyFiles } from './lib/generation.mjs';
import { effectiveMode, MODE } from './lib/guard.mjs';
import { loadTools } from './lib/tools.mjs';
import { addClaude, removeClaude, hasClaude, addMuse, removeMuse, hasMuse, addCodex, removeCodex, hasCodex, countCodexGroups, scanCodexOurs, hookCommand, CodexBlockEditedError } from './lib/splice.mjs';
import { verifyCodexEdit } from './lib/tomlcheck.mjs';
import { TEAM_REQUIRED_EXCLUSIONS, EXCLUSION_ID, exclusionProblems } from './lib/receipts.mjs';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'install';
const flag = (n) => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const apply = flag('--yes') && !flag('--dry-run');
const L = layout(val('--home', undefined));
const sharedRoot = path.resolve(val('--shared-root', path.dirname(here)));
const ladderDir = path.join(sharedRoot, 'ladder');
const toolsExplicit = flag('--tools');
const wanted = (val('--tools', 'claude,codex')).split(',').map((s) => s.trim()).filter(Boolean);
const log = (s) => console.log((apply ? '' : '[dry run] ') + s);
const die = (s) => { console.error('install-frontdesk: ' + s); process.exit(1); };
const testHooks = process.env.FRONTDESK_TEST_HOOKS === '1';
const stamp = testHooks && process.env.FRONTDESK_TEST_STAMP !== undefined ? process.env.FRONTDESK_TEST_STAMP : new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const testFail = testHooks ? process.env.FRONTDESK_TEST_FAIL : null;
const beforeCommit = () => { if (testFail === 'before-commit' || testFail === 'restore') throw new Error('injected before-commit failure'); };
const TOML_CHECK = 'import sys,tomllib; tomllib.load(sys.stdin.buffer)';

export function validateCodexConfig(text, runner = spawnSync) {
  const opts = { input: Buffer.from(text, 'utf8'), encoding: 'utf8', timeout: 5000, windowsHide: true };
  let foundUsable = false;
  for (const [command, args] of [['python', ['-I', '-c', TOML_CHECK]], ['py', ['-3', '-I', '-c', TOML_CHECK]]]) {
    let result;
    try { result = runner(command, args, opts); } catch (error) { result = { error }; }
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status === 0 && !result.error) return { ok: true };
    if (!result.error && result.status !== 9009 && !/Python was not found|No module named ['"]?tomllib/i.test(output)) foundUsable = true;
  }
  return foundUsable
    ? { ok: false, message: 'Python tomllib rejected the candidate config' }
    : { ok: false, message: 'no usable Python with tomllib was found (tried python and py -3)' };
}

function quoteCmdArg(value) {
  const text = String(value);
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

// A Codex hook in the plan means the restricted live check runs on every install that is not a full no-op, even when the config text is unchanged (the program changed).
export const shouldRunCodexLiveCheck = (hookPlan, skip = false, prevReceipt = null) => !skip && (hookPlan.some((h) => h.tool === 'codex') || !!prevReceipt?.hooks?.codex);

// Runs the hook once with a synthetic PreToolUse payload against a scratch home, as the tool will (the 8.3 paths of its command, no shell): it must exit 0 and print nothing.
export function smokeHook({ node, script }, tool, { spawnFn = spawnSync, timeoutMs = 5000 } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-smoke-'));
  try {
    const input = tool === 'codex' ? { tool_name: 'spawn_agent', tool_input: {} } : { tool_name: 'Agent', tool_input: { description: 'smoke', prompt: 'smoke', subagent_type: 'smoke' } };
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'smoke', cwd: scratch, ...input });
    const started = Date.now();
    const r = spawnFn(node, [script, tool, '--fd-guard'], { input: payload, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: { ...process.env, FRONTDESK_HOME: scratch, FRONTDESK_GUARD_MODE: 'shadow' } });
    const ms = Date.now() - started;
    const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
    const ok = !r.error && r.status === 0 && !output;
    return { ok, ms, message: ok ? '' : `hook smoke run failed (exit ${r.status ?? 'none'}${r.error ? ', ' + (r.error.code || r.error.name) : ''}${output ? ', output: ' + output.slice(0, 120) : ''})` };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

export function killProcessTree(child, runner = spawnSync) {
  if (!child?.pid) return;
  if (process.platform === 'win32') runner('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], { timeout: 10000, windowsHide: true });
  else { try { child.kill('SIGKILL'); } catch { /* the process may already be gone */ } }
}

export const LIVE_CHECK_OFF = ['multi_agent', 'plugins', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation']; // the live check keeps hook loading but turns these integrations off

// The Codex app replaces its versioned bin folder when it updates itself, so a cached path can name a program that is gone: detect again right before the check.
export const codexForLiveCheck = (L, load = loadTools) => load(L, { refresh: true }).tools?.codex?.path;

export async function runCodexLiveCheck(codexPath, home, { spawnProcess = spawn, killTree = killProcessTree, timeoutMs = 90000, tempRoot = os.tmpdir() } = {}) {
  if (!codexPath) return { ok: false, exitCode: null, seconds: 0, firstLine: '', message: 'Codex executable was not found by role doctor detection' };
  const cwd = fs.mkdtempSync(path.join(tempRoot, 'frontdesk-codex-check-'));
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', cwd, '-c', 'model_reasoning_effort=low', ...LIVE_CHECK_OFF.flatMap((name) => ['-c', `features.${name}=false`]), '-'];
  const isCmd = /\.(cmd|bat)$/i.test(codexPath);
  const command = isCmd ? 'cmd.exe' : codexPath;
  const commandLine = `"${[quoteCmdArg(codexPath), ...args.map(quoteCmdArg)].join(' ')}"`;
  const spawnArgs = isCmd ? ['/d', '/s', '/c', commandLine] : args;
  const options = {
    cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: path.join(home, '.codex') },
    ...(isCmd ? { windowsVerbatimArguments: true } : {}),
  };
  const start = Date.now();
  return new Promise((resolve) => {
    let child, timer, output = '', timedOut = false, settled = false;
    const finish = (exitCode, error = null) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* temp cleanup */ }
      const seconds = (Date.now() - start) / 1000;
      const firstLine = output.split(/\r?\n/).find((line) => line.trim())?.slice(0, 200) || '';
      const message = timedOut ? 'Codex live check timed out after 90 seconds' : error ? `Codex live check failed: ${error.code || error.name || 'process error'} starting ${codexPath}` : exitCode === 0 ? '' : `Codex live check exited ${exitCode}`;
      resolve({ ok: !timedOut && !error && exitCode === 0, exitCode, seconds, firstLine, message });
    };
    try { child = spawnProcess(command, spawnArgs, options); }
    catch (error) { finish(null, error); return; }
    const capture = (chunk) => { if (output.length < 4096) output += String(chunk).slice(0, 4096 - output.length); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));
    timer = setTimeout(async () => {
      timedOut = true;
      try { await killTree(child); } catch { /* wait for close before reporting */ }
    }, timeoutMs);
    child.stdin?.end('Reply with the single word ok. Do not call any tool.');
  });
}

export function verifySettingsSnapshot(file, expected, fsApi = fs) {
  if (fsApi.lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symbolic link`);
  if (fsApi.readFileSync(file, 'utf8') !== expected) throw new Error(`${file} changed after it was read`);
}

export function applySettingsPlans(plans, { backupFile = backup, writeFile = writeAtomic, readFile = (file) => fs.readFileSync(file, 'utf8'), restoreFile = (saved, target) => fs.copyFileSync(saved, target), verify = verifySettingsSnapshot, afterWrite = () => {} } = {}) {
  const attempted = [];
  try {
    for (const h of plans) {
      verify(h.file, h.before);
      h.backup = backupFile(h.file);
    }
    for (const h of plans) {
      verify(h.file, h.before);
      attempted.push(h);
      writeFile(h.file, h.after);
      afterWrite(h, readFile(h.file));
    }
    return attempted;
  } catch (error) {
    error.restoreFailures = [];
    for (const h of attempted.reverse()) {
      try {
        const current = readFile(h.file);
        if (current === h.before) continue;
        if (current !== h.after) throw new Error('settings file changed after this install wrote it');
        restoreFile(h.backup, h.file);
      } catch (restoreError) { error.restoreFailures.push({ path: h.file, backupPath: h.backup, reason: restoreError.message }); }
    }
    throw error;
  }
}

function shortPath(p) {
  const fwd = (s) => s.split('\\').join('/');
  const absolute = path.resolve(p);
  if (process.platform !== 'win32') return /\s/.test(absolute) ? null : fwd(absolute);
  if (!/\s/.test(absolute)) return fwd(absolute);
  const suffix = [];
  let ancestor = absolute;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return null;
    suffix.unshift(path.basename(ancestor)); ancestor = parent;
  }
  try {
    const quoted = ancestor.replace(/"/g, '""');
    const short = execSync(`cmd.exe /d /c for %I in ("${quoted}") do @echo %~sI`, { encoding: 'utf8', windowsHide: true }).trim();
    const result = short && fwd(path.join(short, ...suffix));
    return result && !/\s/.test(result) ? result : null;
  } catch { return null; }
}

function legacyHelpers() {
  const dir = path.join(L.home, '.claude', 'agents');
  const helpers = {};
  if (!fs.existsSync(dir)) return helpers;
  for (const f of fs.readdirSync(dir).filter((n) => /\.md$/i.test(n))) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    const fm = Object.fromEntries(m[1].split(/\r?\n/).map((l) => l.match(/^([A-Za-z_]+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]));
    if (!fm.name || !fm.model) continue;
    helpers[fm.name.toLowerCase()] = { kind: 'legacy', source: `claude/agents/${f}`, name: fm.name, model: fm.model, effort: fm.effort || null, engineer: `${fm.model}|${fm.effort || 'default'}` };
  }
  return helpers;
}

function preflight() {
  if (Number(process.versions.node.split('.')[0]) < 18) die('Node 18 or newer is needed');
  const codeManifest = readJson(path.join(here, 'code-manifest.json'), null);
  if (!codeManifest) die('code-manifest.json is missing next to the installer (run seal.mjs after changing the code)');
  const codeProblems = verifyFiles(here, codeManifest.files);
  if (codeProblems.length) die('the front desk code does not match its code manifest (half-synced Drive copy?): ' + codeProblems.map((p) => `${p.file} ${p.problem}`).join(', '));
  const manifest = readJson(path.join(ladderDir, 'manifest.json'), null);
  if (!manifest) die(`no published ladder release in ${ladderDir} (run publish.mjs on the publisher machine)`);
  if (!(manifest.compat && manifest.compat.minReader <= READER_SCHEMA && READER_SCHEMA <= manifest.compat.maxReader)) die(`the published release has schema ${manifest.schema}; this front desk reads ${READER_SCHEMA}`);
  const relProblems = verifyFiles(ladderDir, Object.fromEntries(manifest.installable.map((n) => [`releases/${manifest.release}/${n}`, manifest.files[`releases/${manifest.release}/${n}`]])));
  if (relProblems.length) die('the published release does not match its manifest (Drive still syncing?); keeping the installed one: ' + relProblems.map((p) => `${p.file} ${p.problem}`).join(', '));
  return { codeManifest, manifest };
}

// Resolve existing ancestors too: a not-yet-created destination below a junction is still outside.
export function assertContained(L, file, fsApi = fs) {
  const resolve = (p) => {
    try { fsApi.lstatSync(p); }
    catch (e) { if (e.code !== 'ENOENT') throw e; const parent = path.dirname(p); if (parent === p) throw e; return path.join(resolve(parent), path.basename(p)); }
    return fsApi.realpathSync(p);
  };
  const root = resolve(path.resolve(L.base)), real = resolve(path.resolve(file));
  const rel = path.relative(root, real);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error(`${file} resolves outside ${L.base}`);
  return real;
}

export function checkContainment(L) {
  const targets = [L.frontdesk, L.bin, L.bin + '.prev', L.generations, L.state, L.logs, L.current, L.receipt, L.backups];
  for (const file of targets) assertContained(L, file);
  if (fs.existsSync(L.generations)) for (const name of fs.readdirSync(L.generations)) assertContained(L, path.join(L.generations, name));
}

export function backupFile(file, L, stamp, fsApi = fs) {
  if (/[\\/:]/.test(stamp) || stamp === '.' || stamp === '..') throw new Error('invalid backup stamp');
  assertContained(L, L.backups, fsApi);
  fsApi.mkdirSync(L.backups, { recursive: true });
  const dir = fsApi.mkdtempSync(path.join(L.backups, stamp + '-'));
  try { assertContained(L, dir, fsApi); }
  catch (error) { try { fsApi.rmdirSync(dir); } catch { /* only remove an empty folder */ } throw error; }
  const dst = path.join(dir, path.basename(file) + (file.includes(`${path.sep}.claude${path.sep}`) ? '.claude' : file.includes(`${path.sep}.codex${path.sep}`) ? '.codex' : file.includes(`${path.sep}muse${path.sep}`) ? '.muse' : ''));
  fsApi.copyFileSync(file, dst, fs.constants.COPYFILE_EXCL);
  return dst;
}

function backup(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} disappeared before it could be backed up`);
  return backupFile(file, L, stamp);
}

function exclusionOptions() {
  for (const name of ['--exclude-required', '--exclude-declared', '--installed-by']) if (args.filter((arg) => arg === name).length > 1) throw new Error(`${name} may only be given once`);
  const get = (name, clear = false) => {
    if (!flag(name)) return undefined;
    const value = val(name);
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    if (clear && (value === '-' || value === '')) return [];
    const ids = value.split(',').map((id) => id.trim());
    if (ids.some((id) => !EXCLUSION_ID.test(id))) throw new Error(`${name} contains an invalid id (use [A-Za-z0-9._-]+)`);
    return [...new Set(ids)].sort();
  };
  const installedBy = flag('--installed-by') ? val('--installed-by') : undefined;
  if (flag('--installed-by') && installedBy !== 'team-packet') throw new Error('--installed-by must be team-packet');
  return { required: get('--exclude-required'), declared: get('--exclude-declared', true), installedBy };
}

async function install() {
  let options;
  try { options = exclusionOptions(); checkContainment(L); } catch (error) { die(error.message); }
  const freshInstall = !fs.existsSync(L.receipt) && !fs.existsSync(L.frontdesk);
  if (wanted.includes('muse') && !flag('--allow-unproven-muse')) die('Muse hooks are refused in phase 1a because the user-level hook location is unproven; pass --allow-unproven-muse to opt in.');
  const { codeManifest, manifest } = preflight();
  const receiptState = readJsonState(L.receipt);
  if (receiptState.exists && (!receiptState.ok || !receiptState.value || typeof receiptState.value !== 'object' || Array.isArray(receiptState.value))) {
    if (!apply) die('the install receipt is invalid; refusing to overwrite it (dry run; no backup made)');
    let saved;
    try { saved = backup(L.receipt); } catch (error) { die(`the install receipt is invalid and could not be backed up: ${error.message}`); }
    die(`the install receipt is invalid; backup saved to ${saved}; refusing to overwrite it`);
  }
  const prevReceipt = receiptState.exists ? receiptState.value : null;
  const problems = prevReceipt ? exclusionProblems(prevReceipt) : [];
  if (problems.length) die('the install receipt is invalid: ' + problems.map((p) => `${p.file}: ${p.problem}`).join('; '));
  const installedBy = prevReceipt?.installedBy ?? options.installedBy;
  const hasExclusions = !!prevReceipt?.exclusions || installedBy !== undefined || options.required !== undefined || options.declared !== undefined;
  const exclusions = hasExclusions ? { required: [...new Set([...(prevReceipt?.exclusions?.required || []), ...(options.required || []), ...(installedBy === 'team-packet' ? TEAM_REQUIRED_EXCLUSIONS : [])])].sort(), declared: options.declared ?? prevReceipt?.exclusions?.declared ?? [] } : undefined;
  const metadata = { ...(installedBy !== undefined ? { installedBy } : {}), ...(exclusions ? { exclusions } : {}) };
  const sameMetadata = prevReceipt?.installedBy === installedBy && (!exclusions ? !prevReceipt?.exclusions : ['required', 'declared'].every((key) => JSON.stringify(prevReceipt?.exclusions?.[key]) === JSON.stringify(exclusions[key])));
  log(`planned exclusions: ${JSON.stringify(exclusions ?? { required: [], declared: [] })}; installedBy: ${installedBy ?? '(absent)'}`);
  if (!flag('--no-hooks')) {
    const modeFile = path.join(L.state, 'mode.json');
    const savedMode = readJsonState(modeFile);
    if (savedMode.exists && !savedMode.ok) die(`guard mode is unreadable (${savedMode.error?.name || 'invalid'}); refusing to install hooks`);
    if (savedMode.exists && Object.entries(savedMode.value || {}).some(([key, value]) => ['default', 'claude', 'codex', 'muse'].includes(key) && value !== MODE.SHADOW)) {
      die('guard mode is not shadow in mode.json; phase 1a refuses to install hooks');
    }
    for (const tool of ['claude', 'codex', 'muse']) {
      try {
        const mode = await effectiveMode(L, tool, process.env);
        if (mode !== MODE.SHADOW) die(`guard mode for ${tool} is ${mode}; phase 1a refuses to install hooks`);
      } catch (error) { die(`guard mode for ${tool} is unknown (${error.kind || error.name}); refusing to install hooks`); }
    }
  }
  log(`front desk ${codeManifest.version}; ladder generation ${manifest.generation}, release ${manifest.release}, published ${manifest.time} by ${manifest.publisher?.machine}`);
  log(`home: ${L.home}; shared root: ${sharedRoot}`);

  const genName = `${manifest.generation}-${manifest.release}`;
  const genDir = path.join(L.generations, genName);
  const helpers = { schema: 1, helpers: legacyHelpers() };
  const installed = {};
  const files = {};
  for (const n of manifest.installable) files[n] = fs.readFileSync(path.join(ladderDir, 'releases', manifest.release, n));
  files['helpers.json'] = Buffer.from(JSON.stringify(helpers, null, 1));
  for (const [n, b] of Object.entries(files)) installed[n] = sha256(b);
  const binFiles = codeManifest.files;
  log(`generation ${genName}: ${Object.keys(files).join(', ')}; legacy helpers seen: ${Object.keys(helpers.helpers).join(', ') || 'none'}`);
  log(`program: ${Object.keys(binFiles).length} files into ${L.bin}`);

  // Windows gives a folder its 8.3 short name when it is created, so create our own (empty) folder before the commands are spelled:
  // a first install and a repeat install then spell the same command. A dry run cannot do that and says so.
  if (apply) fs.mkdirSync(L.frontdesk, { recursive: true });
  const node = process.execPath;
  const nodeShort = shortPath(node);
  const scriptShort = shortPath(path.join(L.bin, 'hook.mjs'));
  const hookPlan = [];
  let codexRefused = false;
  if (!flag('--no-hooks')) for (const tool of wanted) {
    const file = { claude: L.claudeSettings, codex: L.codexConfig, muse: L.museSettings }[tool];
    if (!file) { log(`unknown tool ${tool}`); continue; }
    if (!fs.existsSync(file)) { log(`${tool}: ${file} does not exist; skipped`); continue; }
    try { if (fs.lstatSync(file).isSymbolicLink()) { log(`${tool}: ${file} is a symbolic link; refused to write through it, skipped`); continue; } }
    catch (e) { log(`${tool}: ${file} could not be checked (${e.name}); skipped`); continue; }
    let command = nodeShort && scriptShort ? hookCommand(nodeShort, scriptShort, tool) : null;
    let parts = { node: nodeShort, script: scriptShort };
    if (!command) {
      if (tool === 'muse') { log('muse: cannot form a hook command without spaces (no 8.3 short names here); skipped'); continue; }
      const nodePath = path.resolve(node).split('\\').join('/');
      const hookPath = path.resolve(L.bin, 'hook.mjs').split('\\').join('/');
      command = hookCommand(`"${nodePath}"`, `"${hookPath}"`, tool);
      parts = { node: nodePath, script: hookPath };
    }
    let before;
    try { before = fs.readFileSync(file, 'utf8'); }
    catch (e) { log(`${tool}: ${file} could not be read (${e.name}); skipped`); continue; }
    let after;
    try {
      after = tool === 'codex'
        ? addCodex(before, command, { existingCommand: prevReceipt?.hooks?.codex?.command || command, file })
        : { claude: addClaude, muse: addMuse }[tool](before, command);
    } catch (e) {
      if (e instanceof CodexBlockEditedError) log(e.layout ? `codex: ${e.message}; left untouched. Our hook:\n${e.block}` : `codex: marked block was edited by hand; left untouched. Our hook as found:\n${e.block}`);
      else log(`${tool}: ${file} could not be read as ${tool === 'codex' ? 'TOML' : 'JSON'} (${e.name}); left untouched, hook skipped`);
      if (tool === 'codex') codexRefused = true;
      continue;
    }
    if (tool === 'codex') {
      let parsed;
      try { parsed = verifyCodexEdit(before, after, file, scanCodexOurs(before)); }
      catch (e) { parsed = { ok: false, message: e instanceof CodexBlockEditedError ? e.message : `the config could not be checked (${e.name})` }; }
      if (!parsed.ok) { log(`codex: ${parsed.message}; config skipped`); codexRefused = true; continue; }
    }
    hookPlan.push({ tool, file, command, parts, before, after, same: before === after });
    log(`${tool}: ${before === after ? 'hook already installed' : 'add log-only hook'} in ${file}`);
    log(`${tool} command: ${command}`);
  }
  // a live Codex hook must never end up under a changed program without a check: if Codex was refused this time, change nothing at all
  if (codexRefused && prevReceipt?.hooks?.codex) die('the Codex config was refused above and a Codex hook is already installed; nothing was changed. Fix the Codex file or run the uninstall first.');
  if (!apply) { log(prevReceipt?.hooks?.codex || hookPlan.some((h) => h.tool === 'codex') ? 'nothing changed. The Codex live check and the hook smoke run happen on apply. Add --yes to apply.' : 'nothing changed. Add --yes to apply.'); return; }

  fs.mkdirSync(L.frontdesk, { recursive: true });
  const stageId = `${process.pid}-${Date.now()}`;
  const genStage = `${genDir}.staging-${stageId}`;
  const genOld = `${genDir}.rollback-${stageId}`;
  const binStage = `${L.bin}.staging-${stageId}`;
  const oldPrev = `${L.bin}.prev-old-${stageId}`;
  let currentBackup, receiptBackup;
  let genNeedsSwap = true, genOldMoved = false, genNewMoved = false, binOldMoved = false, binNewMoved = false, prevMoved = false;
  let currentExisted = false, currentWritten = false, modeExisted = false, modeWritten = false, committed = false;
  let currentBackupMade = false, rollbackIncomplete = false;
  const settingsWritten = [];
  const sameMap = (a, b) => !!a && !!b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
  const generationFilesMatch = () => {
    if (!fs.existsSync(genDir)) return false;
    const m = readJson(path.join(genDir, 'manifest.json'), null);
    return !!m?.installed && sameMap(m.installed, installed) && verifyFiles(genDir, installed).length === 0;
  };
  const currentBeforeNoop = readJson(L.current, null);
  const installationMatches = () => {
    if (!prevReceipt || !sameMap(prevReceipt.binFiles, binFiles) || !sameMap(prevReceipt.installed, installed)) return false;
    if (!currentBeforeNoop || currentBeforeNoop.dir !== genName || currentBeforeNoop.generation !== manifest.generation || currentBeforeNoop.release !== manifest.release) return false;
    if (verifyFiles(L.bin, binFiles).length || !generationFilesMatch()) return false;
    for (const h of hookPlan) if (!h.same || prevReceipt.hooks?.[h.tool]?.command !== h.command || prevReceipt.hooks?.[h.tool]?.file !== h.file) return false;
    for (const [tool, old] of Object.entries(prevReceipt.hooks || {})) {
      if (!['claude', 'codex', 'muse'].includes(tool) || !fs.existsSync(old.file)) return false;
      const text = fs.readFileSync(old.file, 'utf8');
      if (tool === 'codex') {
        try { if (removeCodex(text, old.command, { file: old.file }) === text) return false; } catch { return false; }
      } else {
        try {
          const entries = JSON.parse(text).hooks?.PreToolUse || [];
          const matcher = tool === 'muse' ? 'subagent_spawn' : 'Agent|Workflow';
          const expected = { type: 'command', command: old.command, timeout: 5 };
          const own = entries.filter((group) => group.matcher === matcher && Array.isArray(group.hooks) && group.hooks.length === 1 && Object.keys(group.hooks[0]).sort().join(',') === 'command,timeout,type' && group.hooks[0].type === expected.type && group.hooks[0].command === expected.command && group.hooks[0].timeout === expected.timeout);
          if (own.length !== 1) return false;
        } catch { return false; }
      }
    }
    return true;
  };
  const alreadyInstalled = () => installationMatches() && sameMetadata;

  try {
    if (alreadyInstalled()) { log('already installed, nothing to do'); return; }
    if (installationMatches()) {
      receiptBackup = backup(L.receipt);
      beforeCommit();
      writeAtomic(L.receipt, JSON.stringify({ ...prevReceipt, ...metadata }, null, 1));
      committed = true;
      log(`exclusions updated; backup ${receiptBackup}`);
      return;
    }
    currentExisted = fs.existsSync(L.current);
    if (currentExisted) { currentBackup = backup(L.current); currentBackupMade = true; }
    const modeFile = path.join(L.state, 'mode.json');
    modeExisted = fs.existsSync(modeFile);
    const oldManifest = readJson(path.join(genDir, 'manifest.json'), null);
    genNeedsSwap = !oldManifest?.installed || !sameMap(oldManifest.installed, installed) || verifyFiles(genDir, installed).length > 0;
    if (genNeedsSwap) {
      fs.mkdirSync(genStage, { recursive: true });
      for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(genStage, n), b);
      const local = { ...manifest, files: undefined, installed, installedAt: new Date().toISOString(), frontdesk: codeManifest.version };
      fs.writeFileSync(path.join(genStage, 'manifest.json'), JSON.stringify(local, null, 1));
      if (verifyFiles(genStage, installed).length) throw new Error('staged generation failed verification');
    }
    fs.mkdirSync(binStage, { recursive: true });
    for (const rel of Object.keys(binFiles)) { const dst = path.join(binStage, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(here, rel), dst); }
    if (verifyFiles(binStage, binFiles).length) throw new Error('staged program failed verification');
    settingsWritten.push(...applySettingsPlans(hookPlan.filter((h) => !h.same), {
      afterWrite: (h, text) => {
        const ok = { claude: hasClaude, muse: hasMuse, codex: hasCodex }[h.tool](text);
        if (!ok) throw new Error(`${h.tool} hook was not present after writing`);
      },
    }));

    if (genNeedsSwap) {
      if (fs.existsSync(genDir)) { fs.renameSync(genDir, genOld); genOldMoved = true; }
      fs.renameSync(genStage, genDir); genNewMoved = true;
    }
    if (fs.existsSync(L.bin + '.prev')) { fs.renameSync(L.bin + '.prev', oldPrev); prevMoved = true; }
    if (fs.existsSync(L.bin)) { fs.renameSync(L.bin, L.bin + '.prev'); binOldMoved = true; }
    fs.renameSync(binStage, L.bin); binNewMoved = true;

    // any install that gets here is not a full no-op: a changed program or config under Codex is re-checked with a real restricted run, even when the Codex config itself is untouched
    if (shouldRunCodexLiveCheck(hookPlan, flag('--no-live-check'), prevReceipt)) {
      const codexPath = codexForLiveCheck(L);
      const check = await runCodexLiveCheck(codexPath, L.home);
      log(`Codex live check: ${check.seconds.toFixed(1)}s; exit code ${check.exitCode ?? 'unknown'}; first output: ${check.firstLine || '(none)'}`);
      if (!check.ok) throw new Error(check.message);
    }

    // the installed hooks are run once with a synthetic payload: silent, exit 0, fast (the live check never calls our hook)
    for (const h of hookPlan) {
      if (!h.parts?.node || !h.parts?.script) continue;
      const smoke = smokeHook(h.parts, h.tool);
      log(`${h.tool} hook smoke run: ${smoke.ok ? 'ok' : 'FAILED'} in ${smoke.ms} ms`);
      if (!smoke.ok) throw new Error(smoke.message);
    }

    currentWritten = true;
    const prevCurrent = currentExisted ? readJson(L.current, null) : null;
    writeAtomic(L.current, JSON.stringify({ generation: manifest.generation, release: manifest.release, dir: genName, previous: prevCurrent ? { generation: prevCurrent.generation, release: prevCurrent.release, dir: prevCurrent.dir } : null, switchedAt: new Date().toISOString() }, null, 1));
    if (!modeExisted) { modeWritten = true; writeAtomic(modeFile, JSON.stringify({ default: 'shadow', note: 'shadow = log only; the owner switches a tool to enforce after the shadow period' }, null, 1)); }

    const hookReceipt = {};
    for (const h of hookPlan) {
      const prior = prevReceipt?.hooks?.[h.tool];
      hookReceipt[h.tool] = { file: h.file, command: h.command, backup: h.backup ?? prior?.backup ?? null, installedAt: h.same ? (prior?.installedAt ?? new Date().toISOString()) : new Date().toISOString() };
      log(`${h.tool}: hook ${h.same ? 'was already there' : 'installed; backup ' + h.backup}`);
    }
    const receipt = { schema: 1, frontdesk: codeManifest.version, installedAt: new Date().toISOString(), previousInstalledAt: prevReceipt?.installedAt ?? null, sharedRoot, node, release: manifest.release, generation: manifest.generation, inputsHash: manifest.source?.inputsHash, binFiles, generationDir: genName, installed, hooks: { ...(prevReceipt?.hooks || {}), ...hookReceipt }, ...metadata };
    beforeCommit();
    writeAtomic(L.receipt, JSON.stringify(receipt, null, 1));
    committed = true;
    if (prevMoved) { try { fs.rmSync(oldPrev, { recursive: true, force: true }); } catch { /* backup cleanup */ } }
    if (genOldMoved) { try { fs.rmSync(genOld, { recursive: true, force: true }); } catch { /* backup cleanup */ } }
    log(`receipt written: ${L.receipt}`);
    try {
      const d = spawnSync(process.execPath, [path.join(L.bin, 'role.mjs'), 'doctor'], { encoding: 'utf8', env: { ...process.env, FRONTDESK_HOME: L.home } });
      console.log(d.stdout || d.stderr);
    } catch { /* install is committed; doctor can be run separately */ }
  } catch (e) {
    const restoreFailures = [...(e.restoreFailures || [])];
    let restoreInjected = false;
    const attemptRestore = (file, backupPath, restore) => {
      try { if (testFail === 'restore' && !restoreInjected) { restoreInjected = true; throw new Error('injected restore failure'); } restore(); }
      catch (error) { restoreFailures.push({ path: file, backupPath: backupPath || '(no backup)', reason: error.message }); }
    };
    if (!committed) {
      if (receiptBackup) attemptRestore(L.receipt, receiptBackup, () => {
        if (!fs.readFileSync(L.receipt).equals(fs.readFileSync(receiptBackup))) throw new Error('receipt changed during the update; refusing to overwrite it');
      });
      for (const h of settingsWritten.reverse()) attemptRestore(h.file, h.backup, () => {
        if (fs.readFileSync(h.file, 'utf8') !== h.after) throw new Error('settings file changed after this install wrote it');
        fs.copyFileSync(h.backup, h.file);
      });
      if (binNewMoved) attemptRestore(L.bin, L.bin + '.prev', () => fs.rmSync(L.bin, { recursive: true, force: true }));
      if (binOldMoved) {
        if (fs.existsSync(L.bin + '.prev')) attemptRestore(L.bin, L.bin + '.prev', () => fs.renameSync(L.bin + '.prev', L.bin));
        else restoreFailures.push({ path: L.bin, backupPath: L.bin + '.prev', reason: 'backup is missing' });
      }
      if (prevMoved) {
        if (fs.existsSync(oldPrev)) attemptRestore(L.bin + '.prev', oldPrev, () => fs.renameSync(oldPrev, L.bin + '.prev'));
        else restoreFailures.push({ path: L.bin + '.prev', backupPath: oldPrev, reason: 'backup is missing' });
      }
      if (currentWritten && currentExisted && currentBackupMade) attemptRestore(L.current, currentBackup, () => fs.copyFileSync(currentBackup, L.current));
      else if (currentWritten && !currentExisted) attemptRestore(L.current, '(new file; no prior backup)', () => fs.rmSync(L.current, { force: true }));
      const modeFile = path.join(L.state, 'mode.json');
      if (modeWritten && !modeExisted) attemptRestore(modeFile, '(new file; no prior backup)', () => fs.rmSync(modeFile, { force: true }));
      if (genNewMoved) attemptRestore(genDir, genOld, () => fs.rmSync(genDir, { recursive: true, force: true }));
      if (genOldMoved) {
        if (fs.existsSync(genOld)) attemptRestore(genDir, genOld, () => fs.renameSync(genOld, genDir));
        else restoreFailures.push({ path: genDir, backupPath: genOld, reason: 'backup is missing' });
      }
    }
    if (freshInstall && !committed && !restoreFailures.length) attemptRestore(L.frontdesk, null, () => fs.rmSync(L.frontdesk, { recursive: true, force: true }));
    rollbackIncomplete = restoreFailures.length > 0;
    if (rollbackIncomplete) console.error(`install-frontdesk: install failed; rollback incomplete: ${e.message}; failed restores: ${restoreFailures.map((x) => `${x.path} (backup ${x.backupPath}): ${x.reason}`).join('; ')}`);
    else console.error(`install-frontdesk: install failed; prior state restored: ${e.message}`);
    process.exitCode = rollbackIncomplete ? 4 : 1;
  } finally {
    try { fs.rmSync(genStage, { recursive: true, force: true }); } catch { /* cleanup */ }
    try { fs.rmSync(binStage, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
}

function uninstall() {
  const saved = readJsonState(L.receipt);
  const receipt = saved.ok ? saved.value : null;
  const hooks = { ...(receipt?.hooks || {}) };
  let incomplete = !saved.ok && saved.exists;
  let receiptChanged = false;
  const selectedTools = toolsExplicit ? wanted : [...new Set(['claude', 'codex', ...Object.keys(hooks)])];
  log('uninstall: removing selected hook entries (the program, generations and logs stay)');
  if (incomplete) log(`receipt could not be read (${saved.error?.name || 'invalid'}); it will be kept`);
  for (const tool of selectedTools) {
    const file = { claude: L.claudeSettings, codex: L.codexConfig, muse: L.museSettings }[tool];
    const recorded = hooks[tool];
    if (!file) { log(`unknown tool ${tool}; skipped`); incomplete = true; continue; }
    if (!fs.existsSync(file)) {
      if (recorded) { log(`${tool}: ${file} is missing; skipped`); incomplete = true; }
      if (apply && !incomplete && recorded) { delete hooks[tool]; receiptChanged = true; }
      continue;
    }
    try { if (fs.lstatSync(file).isSymbolicLink()) { log(`${tool}: ${file} is a symbolic link; skipped`); incomplete = true; continue; } }
    catch (e) { log(`${tool}: ${file} could not be checked (${e.name}); skipped`); incomplete = true; continue; }
    let before;
    try { before = fs.readFileSync(file, 'utf8'); }
    catch (e) { log(`${tool}: ${file} could not be read (${e.name}); skipped`); incomplete = true; continue; }
    let after;
    try {
      after = tool === 'codex' ? removeCodex(before, recorded?.command, { file }) : { claude: removeClaude, muse: removeMuse }[tool](before);
      if (tool === 'codex') {
        const checked = verifyCodexEdit(before, after, file, scanCodexOurs(before));
        if (!checked.ok) { log(`codex: ${checked.message}; left untouched`); incomplete = true; continue; }
      }
    } catch (e) {
      if (e instanceof CodexBlockEditedError) log(e.layout ? `codex: ${e.message}; left untouched. Our hook:\n${e.block}` : `codex: marked block was edited by hand; left untouched. Our hook as found:\n${e.block}`);
      else log(`${tool}: ${file} could not be parsed (${e.name}); left untouched`);
      incomplete = true;
      continue;
    }
    log(`${tool}: ${before === after ? 'no front desk entry found' : 'remove entry from ' + file}`);
    if (apply && before !== after) {
      try {
        verifySettingsSnapshot(file, before);
        const bk = backup(file);
        verifySettingsSnapshot(file, before);
        writeAtomic(file, after);
        log(`${tool}: removed; backup ${bk}`);
      } catch (e) { log(`${tool}: could not be changed safely (${e.message}); skipped`); incomplete = true; continue; }
    }
    if (apply && recorded) { delete hooks[tool]; receiptChanged = true; }
  }
  if (apply && receipt) {
    const remaining = Object.keys(hooks);
    if (!remaining.length && !incomplete) {
      backup(L.receipt);
      fs.unlinkSync(L.receipt);
      log('receipt removed (this machine now falls back to the legacy routes in POLICY.md)');
    } else {
      if (receiptChanged) { backup(L.receipt); writeAtomic(L.receipt, JSON.stringify({ ...receipt, hooks }, null, 1)); }
      log(incomplete ? 'uninstall incomplete; receipt kept' : `receipt kept for hooks: ${remaining.join(', ')}`);
    }
  } else if (apply && incomplete) log('uninstall incomplete; receipt kept');
  else if (!apply) log('nothing changed. Add --yes to apply.');
  if (apply && incomplete) process.exitCode = 1;
}

let isMain = false;
try { isMain = !!process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(url.fileURLToPath(import.meta.url)); } catch { /* an unresolved entry point is not the main script */ }
if (isMain) {
  if (cmd !== 'install' && ['--exclude-required', '--exclude-declared', '--installed-by'].some(flag)) die('exclusion and installed-by options are install only');
  if (cmd === 'install') await install();
  else if (cmd === 'uninstall') { try { checkContainment(L); } catch (error) { die(error.message); } uninstall(); }
  else if (cmd === 'status' && !fs.existsSync(path.join(L.bin, 'role.mjs'))) console.log('not installed');
  else if (cmd === 'status') { const r = spawnSync(process.execPath, [path.join(L.bin, 'role.mjs'), 'doctor'], { encoding: 'utf8', env: { ...process.env, FRONTDESK_HOME: L.home } }); console.log(r.stdout || r.stderr || 'not installed'); }
  else die(`unknown command ${cmd}`);
}
