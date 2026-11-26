#!/usr/bin/env node
/**
 * packet/tests/fixtures.mjs – PACKET-SPEC v2 fixture harness (section 5)
 * Usage: node packet/tests/fixtures.mjs --packet <staged-packet> [--previous <zip>]
 *        [--only ps|sh] [--scenario <n>[,<n>...]] [--keep]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const NODE_BIN = process.execPath;
const NODE_DIR = path.dirname(NODE_BIN);

// ─── model constants ───────────────────────────────────────────────────────────

const CODEX_ALL_SLUGS = ['gpt-6.2-sol','gpt-6.1-sol','gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna'];
const CODEX_ALL_EFFORTS = ['low','medium','high','xhigh','max'];
const CODEX_GPT56_SLUGS = ['gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna'];
// Deliberately omit both GPT CTOs: these lists exercise the lower-tier Sol seats, not first-choice lanes.
const CODEX_SOL_ONLY = ['gpt-6-sol'];
const CODEX_SOL_56 = ['gpt-6-sol','gpt-5.6-sol'];
const CURSOR_ALL_IDS = ['grok-4.7-high','grok-4.7-xhigh','grok-4.7-xhigh-fast','cursor-grok-4.6-xhigh','cursor-grok-4.6-xhigh-fast','gpt-5.6-terra-max','gpt-5.6-sol-high'];
const CURSOR_GROK46_IDS = ['cursor-grok-4.6-xhigh','cursor-grok-4.6-xhigh-fast','gpt-5.6-terra-max','gpt-5.6-sol-high'];
const VERSIONS = { claude: '2.1.280 (Claude Code)', codex: 'codex-cli 0.155.0', cursor: '2026.09.18-9a7762b', muse: 'Muse Code 1.3.0' };
const ROUTES_CLAUDE_280 = '- Haiku helper (haiku-helper, Claude Haiku 5.5): needs Claude Code 2.1.293 or newer (found 2.1.280); use the Sonnet helpers until then\n- Sonnet helpers (explore, researcher, implementer, verifier): Claude Sonnet 4.6 here, because Claude Code 2.1.280 is older than 2.1.284; update Claude Code and run this installer again for Sonnet 5.5';
const ROUTES_NO_MACHINE_CHECK = '- Haiku helper (haiku-helper, Claude Haiku 5.5): the first Claude helper to try; needs Claude Code 2.1.293 or newer\n- Sonnet helpers (explore, researcher, implementer, verifier): Claude Sonnet 4.6 here, because Claude Code 2.1.280 is older than 2.1.284; update Claude Code and run this installer again for Sonnet 5.5';

function makeCodexCache(slugs = CODEX_ALL_SLUGS, efforts = CODEX_ALL_EFFORTS) {
  return {
    fetched_at: '2026-09-24T00:00:00Z',
    models: slugs.map(slug => ({ slug, visibility: 'list', supported_reasoning_levels: efforts.map(effort => ({ effort })) }))
  };
}

// ─── argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { packet: null, previous: null, only: null, scenarios: null, keep: false, strict: false, jobs: 1, shard: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--packet': a.packet = argv[++i]; break;
      case '--previous': a.previous = argv[++i]; break;
      case '--only': a.only = argv[++i]; break;
      case '--scenario': a.scenarios = argv[++i].split(',').map(Number); break;
      case '--keep': a.keep = true; break;
      case '--strict': a.strict = true; break;
      // --jobs N: run the (scenario, installer) pairs in N child processes (bash on Windows is slow).
      case '--jobs': a.jobs = Math.max(1, Number(argv[++i]) || 1); break;
      case '--shard': { const [k, n] = argv[++i].split('/').map(Number); a.shard = { k, n }; break; }
    }
  }
  return a;
}

// ─── temp dirs ─────────────────────────────────────────────────────────────────

const _keep = [];
function makeTmp(prefix = 'fixt-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  _keep.push(d);
  return d;
}
function cleanTmp(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

// ─── checksums ─────────────────────────────────────────────────────────────────

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256f(f) { return sha256(fs.readFileSync(f)); }

function buildChecksums(dir) {
  const lines = [];
  const walk = d => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      const rel = full.slice(dir.length + 1).replace(/\\/g, '/');
      if (rel !== 'CHECKSUMS.txt') lines.push(`${sha256f(full)}  ${rel}`);
    }
  };
  walk(dir);
  lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
  return lines.join('\n') + '\n';
}

function writeChecksums(dir) {
  fs.writeFileSync(path.join(dir, 'CHECKSUMS.txt'), buildChecksums(dir), 'utf8');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ─── fake tool helper ──────────────────────────────────────────────────────────

const HELPER = path.join(__dirname, 'fake-tool.mjs');

function ensureHelper() {
  if (fs.existsSync(HELPER)) return;
  fs.writeFileSync(HELPER, `#!/usr/bin/env node
import fs from 'node:fs';
const [,, name, ...argv] = process.argv;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(process.env.FIXTURE_TOOL_CFG,'utf8')); } catch {}
const ver = (cfg.versions||{})[name]||'';
if (argv[0]==='--version'){process.stdout.write(ver+'\\n');process.exit(0);}
if (name==='cursor-agent'&&argv[0]==='models'){
  if(cfg.cursorFail){process.stdout.write('not logged in\\n');process.exit(1);}
  process.stdout.write('Available models\\n'+(cfg.cursorModels||[]).join('\\n')+'\\n');
  process.exit(0);
}
process.exit(0);
`, 'utf8');
}

// tools: { claude:'2.1.280 (Claude Code)', codex:..., 'cursor-agent':..., muse:... }
// Omit a key to make that tool absent from PATH.
function createFakeTools(dir, tools, cursorCfg, wantNode) {
  fs.mkdirSync(dir, { recursive: true });
  const cfg = { versions: {}, cursorModels: cursorCfg.models || [], cursorFail: cursorCfg.fail || false };
  for (const [k, v] of Object.entries(tools)) cfg.versions[k] = v;
  const cfgFile = path.join(dir, '_cfg.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg), 'utf8');

  for (const [name, ver] of Object.entries(tools)) {
    if (ver == null) continue; // not installed
    const safeV = String(ver).replace(/[()&<>^|]/g, '?');
    if (wantNode) {
      const np = NODE_BIN.replace(/\\/g, '/');
      const hp = HELPER.replace(/\\/g, '/');
      const cfgFwd = cfgFile.replace(/\\/g, '/');
      // .cmd for Windows powershell/cmd
      fs.writeFileSync(path.join(dir, `${name}.cmd`),
        `@echo off\nset "FIXTURE_TOOL_CFG=${cfgFile}"\n"${NODE_BIN}" "${HELPER}" ${name} %*\n`);
      // sh for bash
      fs.writeFileSync(path.join(dir, name),
        `#!/bin/sh\nFIXTURE_TOOL_CFG='${cfgFwd}' exec '${np}' '${hp}' ${name} "$@"\n`);
    } else {
      // Self-contained: no node on PATH
      if (name === 'cursor-agent') {
        let cmd = `@echo off\nif "%~1"=="--version" (echo ${safeV}& exit /b 0)\nif "%~1"=="models" (\n`;
        if (cursorCfg.fail) cmd += `  echo not logged in\n  exit /b 1\n)\nexit /b 0\n`;
        else {
          cmd += `  echo Available models\n`;
          for (const l of cursorCfg.models || []) cmd += `  echo ${l}\n`;
          cmd += `  exit /b 0\n)\nexit /b 0\n`;
        }
        fs.writeFileSync(path.join(dir, `${name}.cmd`), cmd);
        const vsh = String(ver).replace(/'/g, "'\\''");
        let sh = `#!/bin/sh\ncase "$1" in\n--version) echo '${vsh}'; exit 0;;\nmodels)\n`;
        if (cursorCfg.fail) sh += `  echo 'not logged in'; exit 1;;\nesac\nexit 0\n`;
        else {
          sh += `  echo 'Available models'\n`;
          for (const l of cursorCfg.models || []) sh += `  echo '${String(l).replace(/'/g,"'\\''")}'  \n`;
          sh += `  exit 0;;\nesac\nexit 0\n`;
        }
        fs.writeFileSync(path.join(dir, name), sh);
      } else {
        const vsh = String(ver).replace(/'/g, "'\\''");
        fs.writeFileSync(path.join(dir, `${name}.cmd`),
          `@echo off\nif "%~1"=="--version" echo ${safeV}\nexit /b 0\n`);
        fs.writeFileSync(path.join(dir, name),
          `#!/bin/sh\ncase "$1" in\n--version) echo '${vsh}';;\nesac\nexit 0\n`);
      }
    }
    if (!IS_WIN) try { fs.chmodSync(path.join(dir, name), 0o755); } catch {}
  }
}

// ─── environment ───────────────────────────────────────────────────────────────

const SYS_WIN = `${process.env.SystemRoot||'C:\\Windows'}\\System32;${process.env.SystemRoot||'C:\\Windows'};${process.env.SystemRoot||'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0`;
// Only the commands the installers, referee and front desk need; never expose system Node or CLIs.
const SYSTEM_COMMANDS = 'awk basename bash cat chmod cmp cp cut date dd dirname env find grep head id ln ls mkdir mktemp mv od readlink rm rmdir sed sh sha256sum shasum sleep sort tail tee test timeout tr uname uniq wc which'.split(' ');
function systemBin(fakeDir) {
  const dir = path.join(fakeDir, 'system-bin');
  fs.mkdirSync(dir, { recursive:true });
  for (const name of SYSTEM_COMMANDS) {
    const src = ['/usr/bin', '/bin'].map(d => path.join(d, name)).find(isFile);
    const dest = path.join(dir, name);
    if (src && !fs.existsSync(dest)) fs.symlinkSync(src, dest);
  }
  return dir;
}
const API_KEYS = ['ANTHROPIC_API_KEY','OPENAI_API_KEY','CURSOR_API_KEY','XAI_API_KEY','MUSE_API_KEY'];

function buildEnv(fakeDir, wantNode, extra = {}) {
  const parts = [fakeDir];
  if (IS_WIN && wantNode) parts.push(NODE_DIR);
  if (!IS_WIN && wantNode && !fs.existsSync(path.join(fakeDir, 'node'))) fs.symlinkSync(NODE_BIN, path.join(fakeDir, 'node'));
  parts.push(IS_WIN ? SYS_WIN : systemBin(fakeDir));
  const env = { PATH: parts.join(IS_WIN ? ';' : ':') };
  const ks = IS_WIN
    // The standard variables every real Windows session has. PATHEXT matters most: without it
    // PowerShell does not treat node.exe or the fake .cmd tools as programs.
    ? ['PATHEXT','SystemRoot','TEMP','TMP','COMSPEC','ComSpec','USERPROFILE','APPDATA','LOCALAPPDATA',
       'ProgramFiles','ProgramFiles(x86)','ProgramW6432','ProgramData','CommonProgramFiles','WinDir',
       'SystemDrive','PSModulePath','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','USERNAME',
       'HOMEDRIVE','HOMEPATH','COMPUTERNAME']
    : ['HOME','USER','LOGNAME','TMPDIR','TERM','SHELL'];
  for (const k of ks) if (process.env[k]) env[k] = process.env[k];
  for (const name of ['APPDATA', 'LOCALAPPDATA']) {
    env[name] = path.join(fakeDir, name.toLowerCase());
    fs.mkdirSync(env[name], { recursive:true });
  }
  env.HOME = path.join(fakeDir, 'home');
  env.USERPROFILE = env.HOME;
  fs.mkdirSync(env.HOME, { recursive:true });
  for (const k of API_KEYS) { delete env[k]; delete env[k.toLowerCase()]; }
  env.TEAM_FOLDER_ROOTS = 'none';
  env.TEAM_DESKTOP_CLAUDE_ROOT = path.join(fakeDir, 'no-desktop-claude');
  for (const [k, v] of Object.entries(extra)) { if (v === null) delete env[k]; else env[k] = String(v); }
  return env;
}

// ─── find bash ─────────────────────────────────────────────────────────────────

function findBash() {
  if (!IS_WIN) {
    const r = spawnSync('which', ['bash'], { encoding: 'utf8' });
    return (r.stdout || '').split('\n')[0].trim() || '/bin/bash';
  }
  for (const c of ['C:\\Program Files\\Git\\bin\\bash.exe','C:\\Program Files (x86)\\Git\\bin\\bash.exe'])
    if (fs.existsSync(c)) return c;
  const r = spawnSync('where', ['bash.exe'], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0) {
    const f = (r.stdout||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    if (f.length) return f[0];
  }
  return null;
}

// ─── run installer ─────────────────────────────────────────────────────────────

// Bash under Git for Windows starts processes slowly, more so with parallel shards, so a full
// install.sh run can take minutes here (seconds on macOS and Linux); a killed run counts as exit 1.
const TIMEOUT = 900_000;

function unixPath(p) {
  if (!IS_WIN) return p;
  // Git Bash mounts this folder as /tmp. Using that mount also avoids mkdir -p traversing
  // denied ancestors of the Windows user folder in a restricted execution sandbox.
  const rel = path.relative(os.tmpdir(), p);
  if (rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))) return `/tmp/${rel.replace(/\\/g, '/')}`;
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}

function mustInstall(type, pkt, home, args, env, bash) {
  const r = runInstaller(type, pkt, home, args, env, bash);
  if (r.status !== 0) throw new Error(`the preparing install exited ${r.status}: ${r.stdout.trim().split(/\r?\n/).slice(-3).join(' | ')}`);
  return r;
}

function runInstaller(type, pkt, home, args, env, bash) {
  env = { ...env, CONSENSUS_LEDGER:path.join(home,'.config/delegate-skills/consensus-ledger') };
  if (type === 'ps') {
    const r = spawnSync('powershell.exe',
      ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(pkt,'install.ps1'),'--home',home,'--yes',...args],
      { encoding:'utf8', timeout:TIMEOUT, env, windowsHide:true, maxBuffer:8*1024*1024 });
    return { stdout:(r.stdout||'')+(r.stderr||''), status:r.status??1 };
  }
  const r = spawnSync(bash,
    [unixPath(path.join(pkt,'install.sh')),'--home',unixPath(home),'--yes',...args],
    { encoding:'utf8', timeout:TIMEOUT, env, windowsHide:true, maxBuffer:8*1024*1024 });
  return { stdout:(r.stdout||'')+(r.stderr||''), status:r.status??1 };
}

// ─── filesystem helpers ────────────────────────────────────────────────────────

const tryJson = f => { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return null; } };
const tryRead = f => { try { return fs.readFileSync(f,'utf8'); } catch { return null; } };
const isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const isDir  = d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

const receiptp  = h => path.join(h,'.config/delegate-skills/team-install.json');
const lanep     = h => path.join(h,'.config/delegate-skills/config.json');
const localp    = h => path.join(h,'.config/delegate-skills/consensus/local.json');
const settingsp = h => path.join(h,'.config/delegate-skills/team-settings.json');
const backupsp  = h => path.join(h,'.config/delegate-skills/.backups/team');
const claudep   = h => path.join(h,'.claude/CLAUDE.md');
const teamp     = h => path.join(h,'.config/delegate-skills/team-policy/profiles/team.md');
const consensusd= h => path.join(h,'.config/delegate-skills/consensus');
const routesIn  = h => (tryRead(teamp(h))||'').replace(/\r\n/g,'\n');
const modeLine = {
  desktop: '- Mode: desktop (a person works in the chat)',
  server: '- Mode: server (no person in the chat; follow "Desktop mode and server mode" in POLICY.md)',
};

// Per-home values a scenario's prepare step hands to its checks (homes are plain strings).
const STASH = new Map();
const INVENTORY = [];
let STRICT = false;
class ScenarioSkip extends Error {}
function report(status, n, type, title, reason = '') {
  if (status === 'SKIP' && STRICT) status = 'FAIL';
  INVENTORY.push({ status, n, type, title, reason });
  process.stdout.write(`${status} ${n} ${type} ${title}${reason ? ': ' + reason : ''}\n`);
  return status;
}
function printInventory() {
  for (const r of INVENTORY) process.stdout.write(`INVENTORY ${r.n} ${r.type} ${r.status} ${r.title}${r.reason ? ': ' + r.reason : ''}\n`);
}
function extractPrevious(zip, dest) {
  const choices = IS_WIN
    ? [['powershell.exe', ['-NoProfile','-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g,"''")}' -DestinationPath '${dest.replace(/'/g,"''")}' -Force`]]]
    : [['unzip', ['-q',zip,'-d',dest]], ['python3',['-m','zipfile','-e',zip,dest]], ['bsdtar',['-xf',zip,'-C',dest]]];
  const errors = [];
  for (const [bin, argv] of choices) {
    const r = spawnSync(bin, argv, { encoding:'utf8', timeout:60000, windowsHide:true });
    if (r.status === 0) return;
    errors.push(`${bin}: ${r.error?.code || r.status}`);
  }
  throw new ScenarioSkip(`previous zip extraction unavailable or failed (${errors.join(', ')})`);
}
function assertNoNode(env, bash) {
  const r = spawnSync(bash || 'where.exe', bash ? ['-c','command -v node'] : ['node'], { env, encoding:'utf8', windowsHide:true });
  if (r.status !== 1 || r.stdout.trim()) throw new Error(`no-Node PATH leaked node: ${r.stdout || r.stderr || r.error}`);
}

// The VERSION of the --previous packet, read when scenario 17 unpacks it (the build passes the
// newest other zip in dist, so the version is not fixed).
let PREV_VERSION = null;

// True when a file with this base name exists anywhere under dir (backups are named after the
// path relative to the home, with separators replaced by "-", so match on the ending).
function findNamed(dir, baseName) {
  if (!isDir(dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() ? findNamed(full, baseName) : entry.name.endsWith(baseName)) return true;
  }
  return false;
}

// The receipt's files, each mapped back to this home. Keys use the installer's own path style
// (C:\... for ps, /c/... for sh), so match on the part after the home folder's unique name.
function receiptFiles(home) {
  const files = tryJson(receiptp(home))?.files || {};
  const base = `/${path.basename(home)}/`;
  const out = [];
  for (const [key, hash] of Object.entries(files)) {
    const norm = key.replace(/\\/g, '/');
    const i = norm.indexOf(base);
    if (i < 0) continue;
    const rel = norm.slice(i + base.length);
    out.push({ key, rel, file: path.join(home, rel), hash });
  }
  return out;
}

const countEntries = d => isDir(d) ? fs.readdirSync(d).length : 0;
// Plan lines start with the action in both installers ("  UPDATE: x" and "UPDATE    x").
const planHas = (out, actions) => new RegExp(`^\\s*(${actions.join('|')})\\b`, 'm').test(out);

// Every file under a folder of this home, with its hash (for "byte-identical afterwards").
function hashTree(home, rels) {
  const snap = {};
  const walk = d => {
    if (!isDir(d)) return;
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      if (isDir(full)) walk(full); else snap[full] = sha256f(full);
    }
  };
  for (const r of rels) { const p = path.join(home, r); if (isFile(p)) snap[p] = sha256f(p); else walk(p); }
  return snap;
}

// ─── check helpers ─────────────────────────────────────────────────────────────

// Standard check signature: (home, stdout, exitCode, ctx) -> null | string error
// ctx: { pkt, fakeDir, type, bash, env, run: (args) => {stdout,status} }

const ok  = () => null;
const chk = (cond, msg) => cond ? null : msg;
const seq = (...fns) => (h, out, s, ctx) => { for (const f of fns) { const r = f(h,out,s,ctx); if (r) return r; } return null; };

const exit0 = (_,__,s) => s===0 ? null : `exit ${s} expected 0`;
const exit1 = (_,__,s) => s===1 ? null : `exit ${s} expected 1`;
const exit2 = (_,__,s) => s===2 ? null : `exit ${s} expected 2`;
const hasStr = want => (_,out) => out.includes(want) ? null : `stdout missing: ${JSON.stringify(want)}`;
const noStr  = want => (_,out) => !out.includes(want) ? null : `stdout should not contain: ${JSON.stringify(want)}`;
const noReceipt = h => !isFile(receiptp(h)) ? null : 'receipt should not exist';
const hasReceipt = h => { const r=tryJson(receiptp(h)); return r&&r.schema===2 ? null : `receipt missing or not schema 2 (got ${r?.schema})`; };
const checkMode = mode => (home, out) => {
  if (tryJson(receiptp(home))?.hostMode !== mode) return `receipt did not record ${mode} mode`;
  if (tryJson(localp(home))?.hostMode !== mode) return `local.json did not record ${mode} mode`;
  const machine = routesIn(home).split('## This machine\n')[1]?.split('\n## ')[0];
  if (!machine?.split('\n').includes(modeLine[mode])) return `profile is missing the ${mode} mode line`;
  if (out.split(/\r?\n/).filter(line => line === `Mode: ${mode}`).length !== 2) return `plan and summary did not both show ${mode} mode`;
  return null;
};
const noPlaceholders = h => { const t=tryRead(teamp(h)); if(!t) return 'team.md missing'; return /\{\{/.test(t)?'team.md has {{ placeholder':null; };
const hasDelegation = h => {
  const md = tryRead(claudep(h));
  if (!md) return 'CLAUDE.md missing';
  if (!md.includes('## Delegation (shared rulebook)')) return 'CLAUDE.md missing delegation section';
  if (!md.includes('## Style')) return 'CLAUDE.md missing ## Style';
  if (!md.includes('## Notes')) return 'CLAUDE.md missing ## Notes';
  return null;
};
const consensusHas = want => (_, out) => {
  const m = out.match(/Consensus: ([^\n]+)/);
  const line = m ? m[1].trim() : '';
  return line.includes(want) ? null : `consensus line "${line}" missing "${want}"`;
};

// ─── consensus line parsing ────────────────────────────────────────────────────

function parseConsensus(out) {
  const m = out.match(/Consensus: ([^\n]+)/);
  return m ? m[1].trim() : null;
}
function parseGP(line) {
  if (!line) return null;
  if (/^off:/.test(line)) return { grade:'off', pair:[] };
  const sv   = line.match(/single vendor \(([^+)]+) \+ ([^)]+)\)/);
  const bcto = line.match(/below CTO level \(([^+)]+) \+ ([^)]+)\)/);
  const std  = line.match(/standard grade \(best pair: ([^+)]+) \+ ([^)]+)\)/);
  if (sv)   return { grade:'single-vendor', pair:[sv[1].trim(),sv[2].trim()] };
  if (bcto) return { grade:'below-cto',     pair:[bcto[1].trim(),bcto[2].trim()] };
  if (std)  return { grade:'standard',      pair:[std[1].trim(),std[2].trim()] };
  return null;
}

// ─── snapshot helpers ──────────────────────────────────────────────────────────

function snapFiles(home) {
  const snap = {};
  const ds = path.join(home,'.config/delegate-skills');
  if (!isDir(ds)) return snap;
  const walk = d => {
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      if (isDir(full)) walk(full); else snap[full] = sha256f(full);
    }
  };
  walk(ds);
  const cm = claudep(home);
  if (isFile(cm)) snap[cm] = sha256f(cm);
  // Every installed file, wherever it lives (helpers, skills, relays), not only the config folder.
  for (const f of receiptFiles(home)) if (isFile(f.file)) snap[f.file] = sha256f(f.file);
  return snap;
}

function snapCheck(snap) {
  for (const [f, h] of Object.entries(snap)) {
    if (!isFile(f)) return `file removed: ${path.basename(f)}`;
    if (sha256f(f) !== h) return `file changed: ${path.basename(f)}`;
  }
  return null;
}

// ─── doctor equivalence ────────────────────────────────────────────────────────

function doctorCheck(home, grade, pair, env) {
  env = { ...env, CONSENSUS_LEDGER:path.join(home,'.config/delegate-skills/consensus-ledger') };
  const ref = path.join(consensusd(home), 'referee.mjs');
  if (!isFile(ref)) return `referee.mjs not found`;
  const r = spawnSync(NODE_BIN, [ref, 'doctor'],
    { encoding:'utf8', timeout:30000, env, windowsHide:true, maxBuffer:4*1024*1024 });
  let doc;
  try { doc = JSON.parse((r.stdout||'').trim()); } catch {
    return `doctor JSON error: ${((r.stdout||r.stderr||'').slice(0,120))}`;
  }
  if (!doc.bestPair) return `doctor missing bestPair (v1 referee; expect v2)`;
  if (doc.bestPair.grade !== grade) return `doctor grade=${doc.bestPair.grade} want=${grade}`;
  if (grade === 'off') return null;
  const got = new Set(doc.bestPair.seats||[]), want = new Set(pair);
  if ([...want].some(x=>!got.has(x))||[...got].some(x=>!want.has(x)))
    return `doctor pair=[${[...got].join('+')}] want=[${pair.join('+')}]`;
  return null;
}

// ─── home setup ────────────────────────────────────────────────────────────────

const ORIG_MD = '## Style\n\nKeep responses under 100 words when possible.\n\n## Notes\n\nPrefer structured output.\n';

function setupHome(home) {
  fs.mkdirSync(path.join(home,'.claude'), { recursive:true });
  fs.writeFileSync(claudep(home), ORIG_MD, 'utf8');
}

function writeCodexCache(home, cache) {
  const d = path.join(home,'.codex');
  fs.mkdirSync(d, { recursive:true });
  fs.writeFileSync(path.join(d,'models_cache.json'), JSON.stringify(cache), 'utf8');
}

// ─── scenario table ────────────────────────────────────────────────────────────
// Each scenario: { n, title, wantNode, tools(claudeVer), cursorCfg, codexCache,
//                  prepare(home,pkt,type,bash,env) => optPkt,
//                  args, extraEnv, check(h,out,s,ctx), doctor }
// doctor: { grade, pair } or fn(out) => { grade, pair }

function scenarios() {
  const allTools = v => ({ claude: `${v} (Claude Code)`, codex: VERSIONS.codex, 'cursor-agent': VERSIONS.cursor, muse: VERSIONS.muse });
  const noRelays = v => ({ claude: `${v} (Claude Code)` });
  const noCodexCursor = v => ({ claude: `${v} (Claude Code)`, muse: VERSIONS.muse });
  const noMuse = v => ({ claude: `${v} (Claude Code)`, codex: VERSIONS.codex, 'cursor-agent': VERSIONS.cursor });
  const codexOnly = v => ({ claude: `${v} (Claude Code)`, codex: VERSIONS.codex });
  const cursAll = { models: CURSOR_ALL_IDS.map(id=>`${id} - ${id}`), fail:false };
  const curs46  = { models: CURSOR_GROK46_IDS.map(id=>`${id} - ${id}`), fail:false };
  const cursNone = { models:[], fail:false };
  const cursFail = { models:[], fail:true };
  const noNode = false, yesNode = true;

  return [

    // 1 – dry-run
    { n:1, title:'--dry-run',
      wantNode:yesNode, tools:allTools('2.1.280'), cursorCfg:cursAll,
      prepare: h => { setupHome(h); },
      args:['--dry-run'],
      check: seq(exit0, noReceipt, hasStr('CREATE'),
        (_,out) => planHas(out, ['UPDATE','UNCHANGED','REMOVE','KEEP']) ? 'a target is not CREATE on a fresh home' : null,
        h => tryRead(claudep(h)) === ORIG_MD ? null : 'dry-run changed CLAUDE.md',
        h => isDir(path.join(h,'.config/delegate-skills')) ? 'dry-run wrote into .config/delegate-skills' : null)
    },

    // 2 – fresh install
    { n:2, title:'fresh install',
      wantNode:yesNode, tools:noRelays('2.1.280'), cursorCfg:cursNone,
      prepare: h => { setupHome(h); },
      check: seq(exit0, hasReceipt, noPlaceholders, hasDelegation, checkMode('desktop'),
        h => {
          const files = receiptFiles(h);
          for (const want of ['.config/delegate-skills/team-policy/POLICY.md', '.config/delegate-skills/team-policy/profiles/team.md',
            '.claude/agents/explore.md', '.claude/agents/implementer.md', '.claude/agents/researcher.md',
            '.claude/agents/verifier.md', '.claude/agents/haiku-helper.md', '.config/delegate-skills/consensus/referee.mjs',
            '.config/delegate-skills/consensus/local.json', '.claude/skills/consensus/SKILL.md',
            '.agents/skills/consensus/SKILL.md', '.claude/CLAUDE.md'])
            if (!files.some(f => f.rel === want)) return `receipt does not list ${want}`;
          for (const f of files) if (!isFile(f.file) || sha256f(f.file) !== f.hash) return `receipt hash differs for ${f.rel}`;
          return null;
        },
        // An ordinary install gets the packet's team helpers byte for byte (not the owner's).
        // Claude Code 2.1.280 is older than 2.1.284, so the Sonnet helpers are the 4.6 copies.
        (h,out,s,ctx) => {
          for (const f of ['explore.md', 'implementer.md', 'researcher.md', 'verifier.md']) {
            const got = path.join(h, '.claude/agents', f);
            if (!isFile(got) || sha256f(got) !== sha256f(path.join(ctx.pkt, 'claude', 'agents', 'sonnet-4-6', f))) return `${f} is not the packet's Sonnet 4.6 helper`;
          }
          const haiku = path.join(h, '.claude/agents', 'haiku-helper.md');
          if (!isFile(haiku) || sha256f(haiku) !== sha256f(path.join(ctx.pkt, 'claude', 'agents', 'haiku-helper.md'))) return 'haiku-helper.md is not the packet\'s team helper';
          return null;
        },
        h => routesIn(h).includes(ROUTES_CLAUDE_280) ? null : 'rendered routes omit the Haiku helper version requirement'),
      doctor: { grade:'single-vendor', pair:['claude-opus-5.5','claude-opus'] }  // Claude only: single-vendor pair, as scenario 7
    },

    // 3 – re-install UNCHANGED
    { n:3, title:'re-install UNCHANGED',
      wantNode:yesNode, tools:noRelays('2.1.280'), cursorCfg:cursNone,
      prepare:(h,pkt,type,bash,env) => {
        setupHome(h); mustInstall(type,pkt,h,[],env,bash);
        STASH.set(h, { backups: countEntries(backupsp(h)) });
      },
      check: seq(exit0, hasStr('UNCHANGED'),
        (_,out) => planHas(out, ['CREATE','UPDATE','REMOVE']) ? 'a target is not UNCHANGED on re-install' : null,
        h => countEntries(backupsp(h)) === STASH.get(h).backups ? null : 'a new backup folder was created on re-install')
    },

    // 4 – hand edit in ## Notes, re-install
    { n:4, title:'hand edit + re-install',
      wantNode:yesNode, tools:noRelays('2.1.280'), cursorCfg:cursNone,
      prepare:(h,pkt,type,bash,env) => {
        setupHome(h);
        mustInstall(type,pkt,h,[],env,bash);
        const md = fs.readFileSync(claudep(h),'utf8');
        fs.writeFileSync(claudep(h), md.replace('Prefer structured output.','Prefer structured output.\n\n<!-- hand-edit -->'), 'utf8');
      },
      check: seq(exit0, hasDelegation,
        h => (tryRead(claudep(h))||'').includes('<!-- hand-edit -->')?null:'hand edit not kept')
    },

    // 5 – uninstall
    { n:5, title:'uninstall',
      wantNode:yesNode, tools:noMuse('2.1.280'), cursorCfg:cursAll, codexCache:makeCodexCache(),
      prepare:(h,pkt,type,bash,env) => {
        setupHome(h);
        // An install with relays, a lane file and a settings file, then a hand edit in ## Notes.
        mustInstall(type,pkt,h,['--unavailable','claude-opus-5'],env,bash);
        const md = fs.readFileSync(claudep(h),'utf8');
        fs.writeFileSync(claudep(h), md.replace('Prefer structured output.','Prefer structured output.\n\n<!-- hand-edit -->'), 'utf8');
        STASH.set(h, { owned: receiptFiles(h).filter(f => f.rel !== '.claude/CLAUDE.md').map(f => f.rel) });
      },
      args:['--uninstall'],
      check: seq(exit0, noReceipt,
        h => {
          const md = tryRead(claudep(h))||'';
          if (md.includes('## Delegation (shared rulebook)')) return 'delegation section not removed';
          if (!md.includes('## Style')) return '## Style missing after uninstall';
          if (!md.includes('## Notes')) return '## Notes missing after uninstall';
          if (!md.includes('<!-- hand-edit -->')) return 'hand edit lost on uninstall';
          return null;
        },
        h => {
          const owned = STASH.get(h).owned;
          for (const want of ['.config/delegate-skills/consensus/local.json', '.config/delegate-skills/team-settings.json',
            '.config/delegate-skills/config.json', '.claude/skills/codex-delegate/SKILL.md', '.claude/skills/cursor-delegate/SKILL.md',
            '.claude/agents/explore.md', '.claude/agents/implementer.md', '.claude/agents/researcher.md',
            '.claude/agents/verifier.md', '.claude/agents/haiku-helper.md'])
            if (!owned.includes(want)) return `the install did not list ${want}`;
          const left = owned.filter(r => isFile(path.join(h, r)));
          return left.length ? `owned files left after uninstall: ${left.slice(0, 3).join(', ')}` : null;
        },
        h => isDir(backupsp(h))?null:'backups dir missing after uninstall')
    },

    // 6 – no Node, no relays
    { n:6, title:'no Node no relays SKIP',
      wantNode:noNode, tools:noRelays('2.1.280'), cursorCfg:cursNone,
      prepare: h => { setupHome(h); },
      check: seq(exit0, hasStr('SKIP (needs Node 18+)'),
        h => routesIn(h).includes(ROUTES_NO_MACHINE_CHECK) ? null : 'no-machine-check routes omit the Haiku helper line',
        h => (tryRead(teamp(h))||'').includes('off: no Node 18+') ? null : 'profile lacks "off: no Node 18+"',
        h => isFile(path.join(consensusd(h),'referee.mjs')) ? 'the runtime was installed without Node' : null)
    },

    // 7 – Node, no codex/cursor, Claude 2.1.280 → single vendor
    { n:7, title:'Claude-only single vendor',
      wantNode:yesNode, tools:noRelays('2.1.280'), cursorCfg:cursNone,
      prepare: h => { setupHome(h); },
      check: seq(exit0, consensusHas('single vendor'), consensusHas('claude-opus-5.5'), consensusHas('claude-opus'),
        hasStr('Not verified here: claude-opus-5.5')),
      doctor: { grade:'single-vendor', pair:['claude-opus-5.5','claude-opus'] }
    },

    // 8 – every tool, all models, ANTHROPIC_API_KEY warning
    { n:8, title:'all tools all models API key warn',
      wantNode:yesNode, tools:allTools('2.1.280'), cursorCfg:cursAll, codexCache:makeCodexCache(),
      prepare: h => { setupHome(h); },
      extraEnv:{ ANTHROPIC_API_KEY:'sk-test-xxx' },
      check: seq(exit0, consensusHas('standard grade'),
        (_,out)=>out.includes('ANTHROPIC_API_KEY')?null:'ANTHROPIC_API_KEY warning missing',
        (_,out)=>out.includes('Lanes: 10 ready (0 on a fallback, 0 not verified, 0 left out)')?null:'not every lane is on its first choice'),
      doctor: out => parseGP(parseConsensus(out))
    },

    // 9 – damaged packet (one byte of consensus/VERSION changed)
    { n:9, title:'damaged packet exit 2',
      wantNode:yesNode, tools:allTools('2.1.280'), cursorCfg:cursNone, useCopy:true,
      mutatePkt: pkt => {
        const v = path.join(pkt,'consensus','VERSION');
        if (!isFile(v)) return;
        const buf = Buffer.from(fs.readFileSync(v)); buf[0] ^= 0x01;
        fs.writeFileSync(v, buf);
      },
      prepare: h => { setupHome(h); },
      check: seq(exit2, noReceipt, hasStr('damaged'),
        h => tryRead(claudep(h)) === ORIG_MD ? null : 'CLAUDE.md changed by a damaged packet',
        h => isDir(path.join(h,'.config/delegate-skills')) ? 'a damaged packet wrote into .config/delegate-skills' : null)
    },

    // 10 – Claude 2.1.259 → Opus5.5 advice, standard with Opus 5
    { n:10, title:'Claude 2.1.259 Opus5.5 advice',
      wantNode:yesNode, tools:allTools('2.1.259'), cursorCfg:cursAll, codexCache:makeCodexCache(),
      prepare: h => { setupHome(h); },
      check: seq(exit0,
        (_,out) => out.includes('2.1.280')&&out.includes('Opus 5.5')?null:'Opus5.5 advice missing',
        consensusHas('standard grade'), consensusHas('claude-opus'),
        (_,out) => (parseConsensus(out)||'').includes('claude-opus-5.5') ? 'Opus 5.5 used below Claude Code 2.1.280' : null)
    },

    // 11 – Codex without GPT-6, fallbacks, local.json marks gpt-6.2-sol + gpt-6-sol unavailable
    { n:11, title:'Codex without GPT-6 fallbacks',
      wantNode:yesNode, tools:noMuse('2.1.280'), cursorCfg:cursAll, codexCache:makeCodexCache(CODEX_GPT56_SLUGS),
      prepare: h => { setupHome(h); },
      check: seq(exit0, hasStr('fallback'),
        h => {
          const lj = tryJson(localp(h));
          if (!lj) return 'local.json missing';
          if (!lj.seats?.['gpt-6.1-sol']?.unavailable) return 'reserve gpt-6.1-sol not unavailable in local.json';
          if (!lj.seats?.['gpt-6.2-sol']?.unavailable) return 'gpt-6.2-sol not unavailable in local.json';
          if (!lj.seats?.['gpt-6-sol']?.unavailable) return 'gpt-6-sol not unavailable in local.json';
          return null;
        })
    },

    // 12 – Codex found, no model list → not verified, advice
    { n:12, title:'Codex no model list unverified',
      wantNode:yesNode, tools:codexOnly('2.1.280'), cursorCfg:cursNone,
      // No codexCache → missing file → unknown
      prepare: h => { setupHome(h); },
      check: seq(exit0, hasStr('not verified'), hasStr('Open Codex once'))
    },

    // 13 – Cursor without Grok 4.7 → grok lanes on 4.6, local.json marks grok-4.7 unavailable
    { n:13, title:'Cursor without Grok 4.7',
      wantNode:yesNode, tools:noMuse('2.1.280'), cursorCfg:curs46, codexCache:makeCodexCache(),
      prepare: h => { setupHome(h); },
      check: seq(exit0, hasStr('cursor-grok-4.6-xhigh-fast'),
        h => {
          const lj = tryJson(localp(h));
          if (!lj) return 'local.json missing';
          if (!lj.seats?.['grok-4.7']?.unavailable) return 'grok-4.7 not unavailable in local.json';
          return null;
        })
    },

    // 14 – cursor-agent models fails → not verified, login advice
    { n:14, title:'cursor-agent not logged in',
      wantNode:yesNode, tools:noMuse('2.1.280'), cursorCfg:cursFail, codexCache:makeCodexCache(),
      prepare: h => { setupHome(h); },
      check: seq(exit0, hasStr('not verified'), hasStr('cursor-agent login'))
    },

    // 15 – no CTO usable: Claude 2.1.200, Codex gpt-6-sol only, Cursor grok-4.6 only
    { n:15, title:'no CTO below-cto gpt-6-sol+grok-4.6',
      wantNode:yesNode, tools:noMuse('2.1.200'), cursorCfg:curs46, codexCache:makeCodexCache(CODEX_SOL_ONLY),
      prepare: h => { setupHome(h); },
      check: seq(exit0, consensusHas('below CTO level'), consensusHas('gpt-6-sol'), consensusHas('grok-4.6')),
      doctor: { grade:'below-cto', pair:['gpt-6-sol','grok-4.6'] }
    },

    // 16 – codex found, no Node → relays SKIP (needs Node 18+)
    { n:16, title:'codex no Node relays SKIP',
      wantNode:noNode, tools:codexOnly('2.1.280'), cursorCfg:cursNone,
      prepare: h => { setupHome(h); },
      check: seq(exit0, hasStr('SKIP (needs Node 18+)'),
        h => isDir(path.join(h,'.claude/skills/codex-delegate')) ? 'a relay was installed without Node' : null,
        h => isFile(lanep(h)) ? 'a lane file was written without Node' : null)
    },

    // 17 – upgrade from previous packet
    { n:17, title:'upgrade from previous packet',
      wantNode:yesNode, tools:noRelays('2.1.280'), cursorCfg:cursNone,
      isUpgrade:true,
      prepare: h => { STASH.set(h, { oldFiles: receiptFiles(h) }); },
      check: seq(exit0,
        () => PREV_VERSION ? null : 'the previous packet has no VERSION file',
        (_,out) => hasStr(`Upgrading from ${PREV_VERSION} to `)(_,out),
        (_,out) => planHas(out, ['UPDATE']) ? null : 'no UPDATE in the upgrade plan',
        h => {
          const r = tryJson(receiptp(h));
          if (!r) return 'receipt missing';
          if (r.schema !== 2) return `receipt schema ${r.schema} want 2`;
          if (r.previousPacketVersion !== PREV_VERSION) return `previousPacketVersion=${r.previousPacketVersion} want ${PREV_VERSION}`;
          const now = new Set(receiptFiles(h).map(f => f.rel));
          const old = STASH.get(h).oldFiles;
          if (!old.length) return 'the old install listed no files';
          for (const f of old) if (!now.has(f.rel) && isFile(f.file)) return `old file neither listed nor removed: ${f.rel}`;
          return null;
        })
    },

    // 18 – downgrade guard → exit 2; with --allow-downgrade proceeds
    { n:18, title:'downgrade guard',
      wantNode:yesNode, tools:noRelays('2.1.280'), cursorCfg:cursNone,
      prepare:(h,pkt,type) => {
        setupHome(h);
        const dsd = path.join(h,'.config/delegate-skills');
        fs.mkdirSync(dsd,{recursive:true});
        // Receipts use the installer's own path style (C:\... for ps, /c/... for sh).
        STASH.set(h, { home: type === 'sh' ? unixPath(h) : h });
        fs.writeFileSync(receiptp(h), JSON.stringify({
          schema:2, packetVersion:'99.0.0', home:STASH.get(h).home, files:{}, tools:{},
          unavailable:[], refresh:{status:'ok',at:'2099-01-01T00:00:00Z'},
          consensus:{grade:'off',pair:[],reason:'off'},lanes:{},relays:[],
          installedAt:'2099-01-01T00:00:00Z', platform:'win32',
          previousPacketVersion:null, backupDir:null
        }), 'utf8');
      },
      check: seq(exit2, hasStr('newer')),
      subCheck:(h,out,s,ctx) => {
        // Re-plant receipt then run with --allow-downgrade
        fs.writeFileSync(receiptp(h), JSON.stringify({
          schema:2, packetVersion:'99.0.0', home:STASH.get(h).home, files:{}, tools:{},
          unavailable:[], refresh:{status:'ok',at:'2099-01-01T00:00:00Z'},
          consensus:{grade:'off',pair:[],reason:'off'},lanes:{},relays:[],
          installedAt:'2099-01-01T00:00:00Z', platform:'win32',
          previousPacketVersion:null, backupDir:null
        }), 'utf8');
        const r = ctx.run(['--allow-downgrade']);
        if (r.status!==0) return `allow-downgrade: exit ${r.status}`;
        if (!r.stdout.includes('Downgrad')) return `allow-downgrade: no Downgrad in stdout`;
        // A dated number (the shape earlier packets carried) counts as older than any packet, however large it looks.
        const dated = fs.readFileSync(receiptp(h),'utf8').replace(/("packetVersion"\s*:\s*")[^"]*(")/, (m,a,b) => a+'2099.01.01-1'+b);
        if (!dated.includes('2099.01.01-1')) return 'dated receipt: could not plant the dated number';
        fs.writeFileSync(receiptp(h), dated, 'utf8');
        const d = ctx.run([]);
        if (d.status!==0) return `dated receipt: exit ${d.status}`;
        if (!d.stdout.includes('Upgrading from 2099.01.01-1 to')) return 'dated receipt: no "Upgrading from 2099.01.01-1 to" in stdout';
        return null;
      }
    },

    // 19 – two Sol models: Claude 2.1.200, Codex gpt-6-sol+gpt-5.6-sol, no Cursor
    { n:19, title:'two Sol below-cto same family',
      wantNode:yesNode, tools:codexOnly('2.1.200'), cursorCfg:cursNone, codexCache:makeCodexCache(CODEX_SOL_56),
      prepare: h => { setupHome(h); },
      check: seq(exit0, consensusHas('below CTO level'), consensusHas('gpt-6-sol'), consensusHas('gpt-5.6-sol'),
        h => (tryRead(teamp(h))||'').includes('same family')?null:'same family note missing from the profile')
    },

    // 20 – declared unavailable; second install keeps list; --clear-unavailable resets
    { n:20, title:'declared unavailable',
      wantNode:yesNode, tools:codexOnly('2.1.280'), cursorCfg:cursNone, codexCache:makeCodexCache(CODEX_SOL_ONLY),
      prepare: h => { setupHome(h); },
      args:['--unavailable','claude-opus-5-5,claude-opus-5'],
      check: seq(exit0, consensusHas('below CTO level'), consensusHas('gpt-6-sol'), consensusHas('claude-sonnet-5'),
        (_,__,___,ctx) => {
          // Second install without option: list kept
          const r2 = ctx.run([]);
          if (r2.status!==0) return `2nd install exit ${r2.status}`;
          const sf = tryJson(settingsp(ctx.home));
          if (!sf?.unavailable?.includes('claude-opus-5-5')) return 'claude-opus-5-5 not in settings after 2nd install';
          // --clear-unavailable: settings gone, pair resets to single-vendor
          const r3 = ctx.run(['--clear-unavailable']);
          if (r3.status!==0) return `clear-unavailable exit ${r3.status}`;
          if (isFile(settingsp(ctx.home))) return 'settings should be gone after --clear-unavailable';
          const line3 = parseConsensus(r3.stdout);
          if (!line3||!line3.includes('single vendor')||!line3.includes('claude-opus-5.5')) return `after clear: expected single vendor with claude-opus-5.5, got: ${line3}`;
          return null;
        }),
      doctor: out => parseGP(parseConsensus(out))   // called with the last run's output
    },

    // 21 – machine check fail, fresh install: core ok, local.json disabled, relays SKIP
    { n:21, title:'machine check fail fresh',
      wantNode:yesNode, tools:noMuse('2.1.280'), cursorCfg:cursAll, codexCache:makeCodexCache(),
      prepare: h => { setupHome(h); },
      // A failure text with a backslash and quotes: local.json must still be valid JSON.
      extraEnv:{ TEAM_SETUP_FAIL:'C:\\packet\\out "x"' },
      check: seq(exit0, hasStr('SKIP (machine check failed'),
        h => {
          const lj = tryJson(localp(h));
          if (!lj) return 'local.json missing or not valid JSON';
          if (!lj.disabled) return 'local.json.disabled not set';
          if (!lj.disabled.includes('C:\\packet\\out "x"')) return `local.json.disabled lost the failure text: ${lj.disabled}`;
          return null;
        },
        hasDelegation,
        h => routesIn(h).includes(ROUTES_NO_MACHINE_CHECK) ? null : 'failed machine-check routes omit the Haiku helper line',
        h => isDir(path.join(h,'.claude/skills/codex-delegate')) ? 'a relay was installed after a failed check' : null,
        h => isFile(lanep(h)) ? 'a lane file was written after a failed check' : null,
        h => (tryRead(teamp(h))||'').includes('the machine check failed') ? null : 'profile does not say the check failed'),
      doctor: { grade:'off', pair:[] }
    },

    // 22 – machine check fail after successful install: files kept, receipt updated
    { n:22, title:'machine check fail keeps previous setup',
      wantNode:yesNode, tools:noMuse('2.1.280'), cursorCfg:cursAll, codexCache:makeCodexCache(CODEX_GPT56_SLUGS),
      prepare:(h,pkt,type,bash,env) => {
        setupHome(h);
        // First install: scenario 11 state (Codex without GPT-6); the machine check succeeds.
        const { TEAM_SETUP_FAIL, ...okEnv } = env;
        const r = runInstaller(type,pkt,h,[],okEnv,bash);
        if (r.status !== 0) throw new Error(`first install exit ${r.status}`);
        const rec = tryJson(receiptp(h));
        const lj = tryJson(localp(h));
        if (!rec?.consensus?.pair?.length || !Object.keys(rec?.lanes||{}).length) throw new Error('first install has no reviewer pair or lanes');
        if (!lj?.seats || !Object.keys(lj.seats).length) throw new Error('first install has no local.json marks');
        STASH.set(h, { rec, snap: hashTree(h, ['.config/delegate-skills/consensus', '.config/delegate-skills/config.json',
          '.claude/skills/codex-delegate', '.claude/skills/cursor-delegate', '.claude/skills/delegate-setup',
          '.claude/skills/consensus', '.agents/skills/consensus']) });
      },
      extraEnv:{ TEAM_SETUP_FAIL:'1' },
      check:(h,out,s,ctx) => {
        const st = STASH.get(h);
        const verify = (label, o, status, reasonHas) => {
          if (status !== 0) return `${label}: exit ${status}`;
          if (!/KEEP \(machine check failed\)/.test(o)) return `${label}: no KEEP (machine check failed) lines`;
          if (!o.includes('your previous reviewer and lane setup is kept unchanged')) return `${label}: the summary does not say the previous setup is kept`;
          for (const [file, hash] of Object.entries(st.snap)) {
            if (!isFile(file) || sha256f(file) !== hash) return `${label}: changed or removed: ${path.relative(h, file)}`;
          }
          const r = tryJson(receiptp(h));
          if (!r) return `${label}: receipt missing`;
          if (r.refresh?.status !== 'failed' || !String(r.refresh?.reason||'').includes(reasonHas))
            return `${label}: refresh=${JSON.stringify(r.refresh)} want failed mentioning ${reasonHas}`;
          if (JSON.stringify(r.consensus) !== JSON.stringify(st.rec.consensus)) return `${label}: receipt consensus changed`;
          if (JSON.stringify(r.lanes) !== JSON.stringify(st.rec.lanes)) return `${label}: receipt lanes changed`;
          const listed = new Set(receiptFiles(h).map(f => f.file.toLowerCase()));
          for (const file of Object.keys(st.snap)) if (!listed.has(file.toLowerCase())) return `${label}: receipt no longer lists ${path.relative(h, file)}`;
          return null;
        };
        const bad = verify('TEAM_SETUP_FAIL', out, s, 'RESOLVE FAILED'); if (bad) return bad;
        const { TEAM_SETUP_FAIL, ...skipEnv } = ctx.env;
        const r2 = runInstaller(ctx.type, ctx.pkt, h, [], { ...skipEnv, TEAM_SETUP_SKIP:'consensus.md' }, ctx.bash);
        ctx.lastOut = r2.stdout;
        const bad2 = verify('TEAM_SETUP_SKIP=consensus.md', r2.stdout, r2.status, 'consensus.md'); if (bad2) return bad2;
        // A check that "succeeds" without its lane file (relay tools present) is a failed check too.
        const r3 = runInstaller(ctx.type, ctx.pkt, h, [], { ...skipEnv, TEAM_SETUP_SKIP:'lanes.json' }, ctx.bash);
        ctx.lastOut = r3.stdout;
        return verify('TEAM_SETUP_SKIP=lanes.json', r3.stdout, r3.status, 'lanes.json');
      }
    },

    // 23 – obsolete files: install, hand-change one relay file, reinstall with two relay files removed
    { n:23, title:'obsolete file KEEP+REMOVE',
      wantNode:yesNode, tools:noMuse('2.1.280'), cursorCfg:cursAll, codexCache:makeCodexCache(),
      useCopy:true, // create modified packet copy
      prepare:(h,pkt,type,bash,env,origPkt) => {
        setupHome(h);
        // First install with the full packet (relays installed: codex found, Node present).
        mustInstall(type,origPkt,h,[],env,bash);
        // Two relay files the new packet copy no longer ships: one changed by hand, one not.
        const rel = ['skills/codex-delegate/references/writing-the-brief.md',
                     'skills/codex-delegate/references/multi-task-queues.md'];
        const installed = rel.map(r => path.join(h, '.claude', r));
        for (const f of installed) if (!isFile(f)) throw new Error(`first install did not create ${f}`);
        fs.appendFileSync(installed[0], '\n<!-- changed by hand -->\n');
        STASH.set(h, { changed: installed[0], changedHash: sha256f(installed[0]), removed: installed[1] });
        for (const r of rel) fs.unlinkSync(path.join(pkt, r));
        writeChecksums(pkt);
      },
      check: seq(exit0,
        h => {
          const s = STASH.get(h);
          if (!s) return 'prepare did not run';
          if (!isFile(s.changed)) return 'the hand-changed obsolete file was deleted';
          if (sha256f(s.changed) !== s.changedHash) return 'the hand-changed obsolete file was modified';
          if (isFile(s.removed)) return 'the unchanged obsolete file was not removed';
          if (!findNamed(backupsp(h), path.basename(s.removed))) return 'the removed file is not in the backups';
          // A kept file stays in the receipt with its previous hash, so it stays ours.
          const keys = Object.keys(tryJson(receiptp(h))?.files || {}).map(k => k.replace(/\\/g, '/'));
          return keys.some(k => k.endsWith('/.claude/skills/codex-delegate/references/writing-the-brief.md'))
            ? null : 'the kept file is no longer listed in the receipt';
        },
        (_,out)=>/KEEP \(changed since install\)/.test(out)?null:'plan lacks KEEP (changed since install)',
        (_,out)=>/REMOVE/.test(out)?null:'plan lacks REMOVE')
    },

    // 24 – backup failure: .backups/team is a file → exit 1, files byte-identical
    { n:24, title:'backup failure stops install',
      wantNode:yesNode, tools:noRelays('2.1.280'), cursorCfg:cursNone, useCopy:true,
      prepare:(h,pkt,type,bash,env) => {
        setupHome(h);
        mustInstall(type,pkt,h,[],env,bash);
        // Block backups directory
        const bd = backupsp(h);
        try { fs.rmSync(bd,{recursive:true,force:true}); } catch {}
        fs.mkdirSync(path.dirname(bd),{recursive:true});
        fs.writeFileSync(bd,'BLOCKED','utf8');
        // Change a file the packet installs, so the installer must back up the installed copy first.
        fs.appendFileSync(path.join(pkt,'policy','POLICY.md'), '\n<!-- changed for the backup-failure scenario -->\n');
        writeChecksums(pkt);
      },
      _snapBefore: true, // signal runner to snap before main run
      check:(h,out,s,ctx) => {
        if (s!==1) return `exit ${s} expected 1`;
        const bad = snapCheck(ctx.snapBefore);
        if (bad) return `file changed despite backup failure: ${bad}`;
        return null;
      }
    },

    // 25 – foreign receipt: install ignores it; uninstall exits 2; sentinels byte-identical
    { n:25, title:'foreign receipt ignored; uninstall exit 2',
      wantNode:yesNode, tools:noRelays('2.1.280'), cursorCfg:cursNone,
      prepare:(h,pkt,type) => {
        setupHome(h);
        const style = p => (type === 'sh' ? unixPath(p) : p);   // receipts use the installer's own path style
        const otherHome = makeTmp('fixt-oth-');
        const sentDir   = makeTmp('fixt-snt-');
        const sentinel  = path.join(sentDir,'sentinel.txt');
        const sentinel2 = path.join(sentDir,'sentinel2.txt');
        fs.writeFileSync(sentinel,'SENTINEL','utf8');
        fs.writeFileSync(sentinel2,'SENTINEL 2','utf8');
        const dsd = path.join(h,'.config/delegate-skills');
        fs.mkdirSync(dsd,{recursive:true});
        // A junction (Windows) or symlink inside an owned folder that points outside the home.
        const link = path.join(dsd,'ext-link');
        if (IS_WIN) fs.symlinkSync(sentDir, link, 'junction'); else fs.symlinkSync(sentDir, link);
        const foreign = JSON.stringify({
          schema:2, packetVersion:'0.1.0', home:style(otherHome), files:{ [style(sentinel)]:sha256f(sentinel) },
          tools:{}, unavailable:[], refresh:{status:'ok',at:'2026-09-24T00:00:00Z'},
          consensus:{grade:'off',pair:[],reason:'off'},lanes:{},relays:[],
          installedAt:'2026-09-24T00:00:00Z', platform:IS_WIN?'windows':'posix',
          previousPacketVersion:null, backupDir:''
        }, null, 2);
        fs.writeFileSync(receiptp(h), foreign, 'utf8');
        STASH.set(h, { foreign, style, sentinels: [[sentinel, sha256f(sentinel)], [sentinel2, sha256f(sentinel2)]],
          viaLink: path.join(link,'sentinel2.txt') });
      },
      check:(h,out,s) => {
        if (s!==0) return `install exit ${s}`;
        const st = STASH.get(h);
        for (const [f, hash] of st.sentinels) if (!isFile(f) || sha256f(f)!==hash) return `sentinel changed during install: ${f}`;
        return /belongs to/.test(out) ? null : 'install did not report the foreign receipt';
      },
      subCheck:(h,out,s,ctx) => {
        const st = STASH.get(h);
        const intact = when => { for (const [f, hash] of st.sentinels) if (!isFile(f) || sha256f(f)!==hash) return `sentinel changed during ${when}: ${f}`; return null; };
        // (a) the foreign receipt put back: uninstall refuses with exit 2 and removes nothing.
        const own = tryRead(receiptp(h));
        fs.writeFileSync(receiptp(h), st.foreign, 'utf8');
        const r1 = ctx.run(['--uninstall']);
        if (r1.status!==2) return `uninstall with a foreign receipt: exit ${r1.status} want 2`;
        let bad = intact('uninstall with a foreign receipt'); if (bad) return bad;
        // (b) our own receipt listing a path that escapes through the junction or symlink:
        //     uninstall succeeds but never deletes the file behind the link.
        const rec = JSON.parse(own);
        rec.files[st.style(st.viaLink)] = sha256f(st.sentinels[1][0]);
        fs.writeFileSync(receiptp(h), JSON.stringify(rec, null, 2), 'utf8');
        const r2 = ctx.run(['--uninstall']);
        if (r2.status!==0) return `uninstall with an escaping path: exit ${r2.status} want 0`;
        bad = intact('uninstall with an escaping path'); if (bad) return bad;
        // (c) a receipt that names no home proves no ownership: uninstall refuses, removes nothing.
        const helper = path.join(h,'.claude/agents/explore.md');
        fs.mkdirSync(path.dirname(helper),{recursive:true});
        fs.writeFileSync(helper,'owned-looking file\n','utf8');
        const homeless = { ...JSON.parse(st.foreign), files:{ [st.style(helper)]: sha256f(helper) } };
        delete homeless.home;
        fs.writeFileSync(receiptp(h), JSON.stringify(homeless, null, 2), 'utf8');
        const r3 = ctx.run(['--uninstall']);
        if (r3.status!==2) return `uninstall with a receipt that names no home: exit ${r3.status} want 2`;
        if (!isFile(helper)) return 'uninstall with a receipt that names no home deleted a listed file';
        // (d) the backup folder behind a link that leads outside: install stops before any change.
        fs.rmSync(receiptp(h), { force:true });
        const sentDir = path.dirname(st.sentinels[0][0]);
        const before = fs.readdirSync(sentDir).sort().join(',');
        const backups = path.join(h,'.config/delegate-skills/.backups');
        if (fs.existsSync(backups)) fs.renameSync(backups, `${backups}-moved`);
        if (IS_WIN) fs.symlinkSync(sentDir, backups, 'junction'); else fs.symlinkSync(sentDir, backups);
        const r4 = ctx.run([]);
        if (r4.status!==2) return `install with the backup folder behind an outside link: exit ${r4.status} want 2`;
        if (fs.readdirSync(sentDir).sort().join(',') !== before) return 'install wrote through the backup folder link';
        bad = intact('install with the backup folder behind an outside link'); if (bad) return bad;
        // (e) the same for the ledger folder (the post-install doctor writes a probe there).
        fs.rmSync(backups);
        const ledgerDir = path.join(h,'.config/delegate-skills/consensus-ledger');
        if (fs.existsSync(ledgerDir)) fs.renameSync(ledgerDir, `${ledgerDir}-moved`);
        if (IS_WIN) fs.symlinkSync(sentDir, ledgerDir, 'junction'); else fs.symlinkSync(sentDir, ledgerDir);
        const r5 = ctx.run([]);
        if (r5.status!==2) return `install with the ledger behind an outside link: exit ${r5.status} want 2`;
        if (fs.readdirSync(sentDir).sort().join(',') !== before) return 'install wrote through the ledger link';
        bad = intact('install with the ledger behind an outside link'); if (bad) return bad;
        return null;
      }
    },

    // 26 – self-test honesty: extra failing test → --self-test exit 1 naming suite
    { n:26, title:'self-test honesty failing test',
      wantNode:yesNode, tools:noRelays('2.1.280'), cursorCfg:cursNone, useCopy:true,
      mutatePkt: pkt => {
        const dir = path.join(pkt,'consensus','tests');
        fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,'fail-extra.test.mjs'),
          "import {test} from 'node:test';\ntest('always fails',()=>{throw new Error('intentional');});\n",'utf8');
        // Do NOT update CHECKSUMS (extra files not listed per spec)
      },
      prepare: h => { setupHome(h); },
      args:['--self-test'],
      check: seq(exit1, (_,out) => /FAILED[^\n]*consensus/.test(out) ? null : 'the failing suite (consensus) is not named',
        (_,out) => /^\s*tests \d+\s*$/m.test(out) && /^\s*fail [1-9]\d*\s*$/m.test(out) ? null : 'the self-test printed no test counts'),
      subCheck:(h,out,s,ctx) => {
        // Another copy with the failing test in setup/tests instead.
        const pkt2 = makeTmp('fixt-p2-');
        copyDir(ctx.pkt, pkt2);
        fs.rmSync(path.join(pkt2,'consensus','tests','fail-extra.test.mjs'), { force:true });
        fs.writeFileSync(path.join(pkt2,'setup','tests','fail-extra.test.mjs'),
          "import {test} from 'node:test';\ntest('always fails',()=>{throw new Error('intentional');});\n",'utf8');
        const r = runInstaller(ctx.type, pkt2, h, ['--self-test'], ctx.env, ctx.bash);
        if (r.status !== 1) return `setup variant: exit ${r.status} want 1`;
        if (!/FAILED[^\n]*setup/.test(r.stdout)) return 'setup variant: the failing suite (setup) is not named';
        if (/FAILED[^\n]*consensus/.test(r.stdout)) return 'setup variant: consensus named as failing';
        return null;
      }
    },

    // 27 – exclusions never silently lost (three sub-checks a/b/c)
    { n:27, title:'exclusions never lost',
      wantNode:yesNode, tools:codexOnly('2.1.280'), cursorCfg:cursNone, codexCache:makeCodexCache(CODEX_SOL_ONLY),
      prepare:(h,pkt,type,bash,env) => {
        setupHome(h);
        // First install: scenario 20's state (both Opus models declared unavailable)
        mustInstall(type,pkt,h,['--unavailable','claude-opus-5-5,claude-opus-5'],env,bash);
      },
      check:(h,out,s,ctx) => {
        if (s!==0) return `initial install exit ${s}`;
        // (a) Make settings unparsable: re-install exits 2, files byte-identical
        const sf = settingsp(h);
        fs.writeFileSync(sf,'{not json','utf8');
        const snap = snapFiles(h);
        const ra = ctx.run([]);
        if (ra.status!==2) return `(a) exit ${ra.status} want 2`;
        const ba = snapCheck(snap);
        if (ba) return `(a) ${ba}`;
        // (a2) valid JSON of the wrong shape and a truncated file are unreadable too.
        for (const text of ['{}', '{"unavailable":null}', '{"unavailable":[]']) {
          fs.writeFileSync(sf, text, 'utf8');
          const snapV = snapFiles(h);
          const rv = ctx.run([]);
          if (rv.status!==2) return `(a2) ${text}: exit ${rv.status} want 2`;
          const bv = snapCheck(snapV);
          if (bv) return `(a2) ${text}: ${bv}`;
        }
        // (b) Delete settings file: re-install recovers ids, pair unchanged
        fs.unlinkSync(sf);
        const rb = ctx.run([]);
        if (rb.status!==0) return `(b) exit ${rb.status} want 0`;
        if (!rb.stdout.toLowerCase().includes('recover')) return '(b) no recovery message in stdout';
        if (!isFile(sf)) return '(b) settings file not re-created';
        const sfb = tryJson(sf);
        if (!sfb?.unavailable?.includes('claude-opus-5-5')) return '(b) claude-opus-5-5 not in recovered settings';
        const lineB = parseConsensus(rb.stdout);
        if (!lineB||!lineB.includes('gpt-6-sol')||!lineB.includes('claude-sonnet-5'))
          return `(b) pair wrong: ${lineB}`;
        const db = doctorCheck(h, 'below-cto', ['gpt-6-sol','claude-sonnet-5'], ctx.env);
        if (db) return `(b) doctor: ${db}`;
        // (c) Unparsable again + --clear-unavailable: proceeds, settings gone
        fs.writeFileSync(sf,'{not json','utf8');
        const rc = ctx.run(['--clear-unavailable']);
        if (rc.status!==0) return `(c) exit ${rc.status} want 0`;
        if (isFile(sf)) return '(c) settings still present after --clear-unavailable';
        const rec = tryJson(receiptp(h));
        if (!rec || (rec.unavailable||[]).length) return `(c) receipt unavailable=${JSON.stringify(rec?.unavailable)} want []`;
        // (d) a hand-formatted valid file (spaces, new lines) is read normally.
        fs.writeFileSync(sf, '{\n  "unavailable": [\n    "claude-opus-5"\n  ]\n}\n', 'utf8');
        const rd = ctx.run([]);
        if (rd.status!==0) return `(d) exit ${rd.status} want 0`;
        const recD = tryJson(receiptp(h));
        if (JSON.stringify(recD?.unavailable) !== '["claude-opus-5"]') return `(d) receipt unavailable=${JSON.stringify(recD?.unavailable)} want ["claude-opus-5"]`;
        return null;
      }
    },

    // 28 – repositories folder, other tools and a newer desktop Claude Code: detected, rendered,
    //      the --repos choice kept on the next run, and the reviewers using the desktop copy.
    { n:28, title:'repos folder, other tools, desktop Claude',
      wantNode:yesNode, tools:{ claude:'2.1.259 (Claude Code)', gemini:'0.9.1' }, cursorCfg:cursNone,
      prepare:(h,pkt,type,bash,env) => {
        setupHome(h);
        for (const r of ['code/r1','code/r2','elsewhere/r3']) fs.mkdirSync(path.join(h, r, '.git'), { recursive:true });
        const root = makeTmp('fixt-desk-');
        const ver = path.join(root, '2.1.290');
        fs.mkdirSync(ver, { recursive:true });
        if (IS_WIN) fs.writeFileSync(path.join(ver, 'claude.cmd'), '@echo off\r\necho 2.1.290 (Claude Code)\r\n');
        else { fs.writeFileSync(path.join(ver, 'claude'), "#!/bin/sh\necho '2.1.290 (Claude Code)'\n"); fs.chmodSync(path.join(ver, 'claude'), 0o755); }
        env.TEAM_DESKTOP_CLAUDE_ROOT = root;
      },
      check: seq(exit0,
        h => { const t = tryRead(teamp(h))||''; return /Repositories: .*code \(2 git repositories\)/.test(t) ? null : 'profile does not show the detected repositories folder'; },
        h => /Gemini CLI: 0\.9\.1/.test(tryRead(teamp(h))||'') ? null : 'profile does not list Gemini CLI',
        h => /2\.1\.290/.test(tryJson(localp(h))?.binaries?.claude || '') ? null : 'local.json does not point the reviewers at the desktop copy',
        consensusHas('claude-opus-5.5'),
        h => tryJson(receiptp(h))?.repos?.count === 2 ? null : 'receipt does not record the repositories folder'),
      subCheck:(h,out,s,ctx) => {
        const other = path.join(h, 'elsewhere');
        const r1 = ctx.run(['--repos', ctx.type === 'sh' ? unixPath(other) : other]);
        if (r1.status !== 0) return `--repos run: exit ${r1.status}`;
        if (!/Repositories: .*elsewhere \(1 git repositories, set with --repos\)/.test(tryRead(teamp(h))||'')) return 'profile does not show the folder given with --repos';
        const r2 = ctx.run([]);
        if (r2.status !== 0) return `follow-up run: exit ${r2.status}`;
        if (!/Repositories: .*elsewhere/.test(tryRead(teamp(h))||'')) return 'the --repos choice was not kept on the next run';
        return null;
      }
    },

    // 30 – old Claude Code 2.1.283: the Sonnet 4.6 copies are installed
    { n:30, title:'old Claude installs Sonnet 4.6 helpers',
      wantNode:yesNode, tools:noRelays('2.1.283'), cursorCfg:cursNone,
      prepare: h => { setupHome(h); },
      check: seq(exit0,
        h => {
          for (const f of ['explore.md', 'implementer.md', 'researcher.md', 'verifier.md']) {
            const got = tryRead(path.join(h, '.claude/agents', f)) || '';
            if (!got.includes('model: claude-sonnet-4-6')) return `${f} is not the Sonnet 4.6 copy`;
          }
          return null;
        },
        h => routesIn(h).includes('Claude Sonnet 4.6 here, because Claude Code 2.1.283 is older than 2.1.284') ? null : 'rendered routes omit the Sonnet 4.6 line',
        hasStr('Update Claude Code to 2.1.284 or newer to get the Sonnet 5.5 helpers'),
        hasStr('(Claude Sonnet 4.6: Claude Code older than 2.1.284)'))
    },

    // 31 – new Claude Code 2.1.293: the Sonnet 5.5 copies are installed
    { n:31, title:'new Claude installs Sonnet 5.5 helpers',
      wantNode:yesNode, tools:noRelays('2.1.293'), cursorCfg:cursNone,
      prepare: h => { setupHome(h); },
      check: seq(exit0,
        h => {
          for (const f of ['explore.md', 'implementer.md', 'researcher.md', 'verifier.md']) {
            const got = tryRead(path.join(h, '.claude/agents', f)) || '';
            if (!got.includes('model: claude-sonnet-5-5')) return `${f} is not the Sonnet 5.5 copy`;
          }
          return null;
        },
        h => routesIn(h).includes('- Sonnet helpers (explore, researcher, implementer, verifier, Claude Sonnet 5.5): always available') ? null : 'rendered routes omit the Sonnet 5.5 line',
        hasStr('(Claude Sonnet 5.5)'))
    },

    // 32 – no Node (no machine check) with a new Claude Code 2.1.293: the installer's own version
    // picks the Sonnet 5.5 copies and the degraded routes text says so
    { n:32, title:'no Node, new Claude installs Sonnet 5.5 helpers',
      wantNode:noNode, tools:noRelays('2.1.293'), cursorCfg:cursNone,
      prepare: h => { setupHome(h); },
      check: seq(exit0, hasStr('SKIP (needs Node 18+)'),
        h => {
          for (const f of ['explore.md', 'implementer.md', 'researcher.md', 'verifier.md']) {
            const got = tryRead(path.join(h, '.claude/agents', f)) || '';
            if (!got.includes('model: claude-sonnet-5-5')) return `${f} is not the Sonnet 5.5 copy`;
          }
          return null;
        },
        h => routesIn(h).includes('- Sonnet helpers (explore, researcher, implementer, verifier, Claude Sonnet 5.5): always available') ? null : 'no-machine-check routes omit the Sonnet 5.5 line',
        hasStr('(Claude Sonnet 5.5)'))
    },
  ];
}

// Ladder fixtures use complete trees (including empty folders and links), not just receipt files.
const frontdeskp = h => path.join(h,'.config/delegate-skills/frontdesk');
const frontreceiptp = h => path.join(h,'.config/delegate-skills/frontdesk-install.json');
const demand = (condition, message) => { if (!condition) throw new Error(message); };
const readRequired = f => { const r = tryJson(f); demand(r, `invalid or missing JSON: ${f}`); return r; };
function snapshotTree(root) {
  const result = {};
  const walk = (file, rel) => {
    let st; try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (st.isSymbolicLink()) result[rel] = `link:${fs.readlinkSync(file)}`;
    else if (st.isDirectory()) { result[rel] = 'directory'; for (const n of fs.readdirSync(file).sort()) walk(path.join(file,n),`${rel}/${n}`); }
    else result[rel] = sha256f(file);
  };
  walk(root,''); return result;
}
function equalTree(before, root, label) {
  const after = snapshotTree(root);
  const changed = [...new Set([...Object.keys(before),...Object.keys(after)])].find(k => before[k] !== after[k]);
  demand(changed === undefined, `${label}: tree changed at ${changed}`);
}
function frontState(h) { return { tree:snapshotTree(frontdeskp(h)), receipt:tryRead(frontreceiptp(h)) }; }
function equalFront(before,h,label) {
  equalTree(before.tree,frontdeskp(h),label);
  demand(before.receipt === tryRead(frontreceiptp(h)), `${label}: front desk receipt changed`);
}
function installCase(ctx, args = [], { env=ctx.env, home=ctx.home, pkt=ctx.pkt, status=0 } = {}) {
  const r = runInstaller(ctx.type,pkt,home,args,env,ctx.bash);
  ctx.lastOut = r.stdout;
  demand(r.status === status, `packet exit ${r.status}, wanted ${status}: ${r.stdout.slice(-2200)}`);
  return r;
}
function directFrontdesk(ctx, args = [], { home=ctx.home, pkt=ctx.pkt, env=ctx.env, dry=false, status=0 } = {}) {
  const r = spawnSync(NODE_BIN,[path.join(pkt,'frontdesk/install-frontdesk.mjs'),'install','--no-hooks','--no-live-check',
    '--shared-root',pkt,'--home',home,...args,...(dry ? [] : ['--yes'])],
    { env, encoding:'utf8', windowsHide:true, timeout:TIMEOUT, maxBuffer:8*1024*1024 });
  const out = (r.stdout||'')+(r.stderr||'');
  demand(r.status === status, `front desk exit ${r.status}, wanted ${status}: ${out.slice(-1500)}`);
  return out;
}
function roleJson(ctx, args, home=ctx.home, wanted=0) {
  const r = spawnSync(NODE_BIN,[path.join(frontdeskp(home),'bin/role.mjs'),...args,'--json'],
    { env:{...ctx.env,FRONTDESK_HOME:home,HOME:home,USERPROFILE:home}, encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024*1024 });
  demand(r.status === wanted, `role ${args.join(' ')} exit ${r.status}, wanted ${wanted}: ${r.stdout || r.stderr}`);
  let value; try { value = JSON.parse(r.stdout); } catch { throw new Error(`role did not return JSON: ${r.stdout || r.stderr}`); }
  return value;
}
let nativeVersionStub = null;
function plantWindowsCandidates(ctx,home) {
  if (!IS_WIN) return;
  // Windows where.exe cannot enumerate these sandbox directories (Access denied), although
  // direct execution works. Exercise the front desk's real, documented candidate locations.
  // The tiny native stub is needed for the two candidates whose names must end in .exe.
  if (!nativeVersionStub) {
    const dir=makeTmp('fixt-native-version-'); nativeVersionStub=path.join(dir,'version.exe');
    const source='public static class VersionStub { public static int Main(string[] a) { if (a.Length > 0 && a[0] == "--version") System.Console.WriteLine("99.0.0"); return 0; } }';
    const command=`Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString('base64')}'))) -OutputAssembly '${nativeVersionStub.replace(/'/g,"''")}' -OutputType ConsoleApplication`;
    const r=spawnSync('powershell.exe',['-NoProfile','-Command',command],{env:ctx.env,encoding:'utf8',windowsHide:true,timeout:60000});
    demand(r.status===0 && isFile(nativeVersionStub),`native fixture compilation failed: ${r.stderr || r.stdout || r.error}`);
  }
  const copy=(tool,dest,native=false)=>{
    const src=path.join(ctx.fakeDir,tool+'.cmd'); if(!isFile(src)) return;
    fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(native?nativeVersionStub:src,dest);
  };
  copy('claude',path.join(ctx.env.APPDATA,'Claude/claude-code/fixture/claude.exe'),true);
  copy('codex',path.join(ctx.env.LOCALAPPDATA,'OpenAI/Codex/bin/fixture/codex.exe'),true);
  copy('cursor-agent',path.join(ctx.env.LOCALAPPDATA,'cursor-agent/cursor-agent.cmd'));
  copy('muse',path.join(ctx.env.LOCALAPPDATA,'Programs/muse/muse.cmd'));
  copy('qwen',path.join(home,'.local/bin/qwen.cmd'));
}
function isolatedTools(ctx,home=ctx.home) {
  plantWindowsCandidates(ctx,home);
  const doc = roleJson(ctx,['doctor','--refresh'],home);
  demand(doc.state === 'healthy','front desk doctor is not healthy');
  if (isFile(path.join(ctx.fakeDir,IS_WIN?'qwen.cmd':'qwen')))
    demand(doc.tools?.qwen && doc.tools.qwen.version === '99.0.0','fixture Qwen was not detected at its declared version');
  for (const [name,tool] of Object.entries(doc.tools||{})) if (tool) {
    const real = fs.realpathSync(tool.path);
    const allowed = [ctx.fakeDir,home].some(base => { const rel=path.relative(fs.realpathSync(base),real); return rel === '' || (!rel.startsWith('..'+path.sep) && rel !== '..' && !path.isAbsolute(rel)); });
    demand(allowed, `tool escaped scenario: ${name} ${tool.path}`);
  }
  return doc;
}
function excluded(ctx,role,id,home=ctx.home) {
  const plan = roleJson(ctx,['plan',role],home);
  const rows = plan.roles?.[0];
  demand(rows,`role ${role} absent`);
  const matches = rows.engineers.filter(e => e.key.startsWith(id+'|') || e.reasons.some(r => r.code === 'excluded_here' && r.detail === id));
  demand(matches.length > 0, `${role}: no excluded row for ${id}`);
  demand(matches.every(e => !e.eligible && !e.wouldBeCalled && e.reasons.some(r=>r.code === 'excluded_here')), `${role}: ${id} not excluded_here`);
  demand(!rows.resolution.key?.startsWith(id+'|'),`${role}: excluded engineer selected`);
}
function noHooks(h) {
  const r = readRequired(frontreceiptp(h));
  demand(r.hooks && !Array.isArray(r.hooks) && Object.keys(r.hooks).length === 0,'front desk hooks are not empty');
  for (const f of ['.claude/settings.json','.codex/config.toml','.config/muse/settings.json']) demand(!(tryRead(path.join(h,f))||'').includes('--fd-guard'),`hook found in ${f}`);
  for (const f of receiptFiles(h)) demand(!f.rel.startsWith('.config/delegate-skills/frontdesk'),'front desk file added to packet files');
}
function ownedLadder(ctx,h=ctx.home) {
  const r = readRequired(frontreceiptp(h)), packet = readRequired(receiptp(h));
  demand(packet.ladder?.owned === true,'ladder is not owned');
  demand(r.installedBy === 'team-packet','installedBy is not team-packet');
  demand(JSON.stringify(r.exclusions.required) === '["qwen-local"]','required exclusions differ');
  demand(packet.ladder.lastInstalled?.release === r.release && packet.ladder.lastInstalled?.frontdesk === r.frontdesk && packet.ladder.lastInstalled?.generation === r.generation,'lastInstalled does not match front desk');
  demand(!routesIn(h).includes('{{'),'profile has unrendered placeholders');
  demand(routesIn(h).includes(`- Role ladder: installed (release ${r.release}, front desk ${r.frontdesk}); ask it with node "`),'profile ladder line missing');
  noHooks(h); isolatedTools(ctx,h);
  excluded(ctx,'Junior','qwen-local',h); excluded(ctx,'Developer','qwen-local',h);
  return packet;
}
function operationallyStable(r) {
  const copy = structuredClone(r);
  delete copy.installedAt; delete copy.previousPacketVersion; delete copy.refresh.at; delete copy.ladder.lastAttempt;
  return copy;
}
function childHome(ctx) { const h=makeTmp(`fixt-${ctx.n}-${ctx.type}-sub-h-`); setupHome(h); return h; }
function copyPacket(ctx,change) { const p=makeTmp('fixt-ladder-p-'); copyDir(ctx.pkt,p); change(p); writeChecksums(p); return p; }
function fileLink(ctx,target,link,label) {
  try { fs.symlinkSync(target,link,'file'); return true; }
  catch (e) {
    if (!IS_WIN || !['EPERM','EACCES'].includes(e.code)) throw e;
    report('SKIP',ctx.n,ctx.type,`sub-case ${label}`,`Windows file symlink unavailable (${e.code}; developer mode or privilege required)`);
    if (STRICT) throw new Error(`strict mode: ${label} was skipped`);
    return false;
  }
}
function folderLink(target,link) { fs.symlinkSync(target,link,IS_WIN?'junction':'dir'); }

function ladderScenarios() {
  const common={wantNode:true,tools:{claude:'99.0.0',qwen:'99.0.0'},cursorCfg:{models:[],fail:false}};
  const test=(n,title,exercise,overrides={})=>({...common,n,title,exercise,...overrides});
  return [
    test(33,'fresh ladder, exclusions and unchanged repeat',ctx=>{
      installCase(ctx); const before=ownedLadder(ctx), front=frontState(ctx.home);
      const stable=operationallyStable(before), tree=snapshotTree(ctx.home);
      const repeat=installCase(ctx);
      demand(repeat.stdout.includes('already installed, nothing to do'),'front desk repeat is not unchanged');
      demand(!planHas(repeat.stdout,['CREATE','UPDATE','REMOVE']),'repeat has changed packet targets');
      const after=readRequired(receiptp(ctx.home));
      demand(after.ladder.lastAttempt.status === 'unchanged','repeat attempt status is not unchanged');
      demand(JSON.stringify(stable) === JSON.stringify(operationallyStable(after)),'packet receipt changed outside operational fields');
      equalFront(front,ctx.home,'unchanged repeat');
      const afterTree=snapshotTree(ctx.home); delete tree['/.config/delegate-skills/team-install.json']; delete afterTree['/.config/delegate-skills/team-install.json'];
      demand(JSON.stringify(tree) === JSON.stringify(afterTree),'repeat changed installed files or created backups');
    }),
    test(34,'no Node and Node 16 skip ladder',ctx=>{
      const noNode=buildEnv(ctx.fakeDir,false); assertNoNode(noNode,ctx.bash);
      let out=installCase(ctx,[],{env:noNode});
      demand(out.stdout.includes('Ladder: SKIP (needs Node 18+)'),'missing Node not skipped');
      demand(!fs.existsSync(frontdeskp(ctx.home)),'ladder installed without Node');
      createFakeTools(ctx.fakeDir,{node:'16.0.0'},{},false);
      out=installCase(ctx,[],{env:buildEnv(ctx.fakeDir,false)});
      demand(out.stdout.includes('Ladder: SKIP (needs Node 18+)'),'Node 16 not skipped');
      demand(!fs.existsSync(frontdeskp(ctx.home)),'ladder installed with Node 16');
      demand(readRequired(receiptp(ctx.home)).ladder.lastAttempt.status === 'skipped','skipped attempt missing');
    },{wantNode:false}),
    test(35,'declared family and route exclusions persist and clear',ctx=>{
      const ids=['claude-haiku-5-5','grok-4.7-xhigh-fast'];
      installCase(ctx,['--unavailable',ids.join(',')]); ownedLadder(ctx);
      excluded(ctx,'Junior',ids[0]); excluded(ctx,'Tech lead',ids[1]);
      installCase(ctx);
      demand(JSON.stringify(readRequired(frontreceiptp(ctx.home)).exclusions.declared) === JSON.stringify(ids),'declared exclusions lost on repeat');
      excluded(ctx,'Junior',ids[0]); excluded(ctx,'Tech lead',ids[1]);
      installCase(ctx,['--clear-unavailable']);
      demand(readRequired(frontreceiptp(ctx.home)).exclusions.declared.length === 0,'declared list not cleared');
      ownedLadder(ctx);
    },{tools:{...common.tools,'cursor-agent':'99.0.0'},cursorCfg:{models:CURSOR_ALL_IDS,fail:false}}),
    test(36,'uninstall removes owned ladder and core',ctx=>{
      installCase(ctx); ownedLadder(ctx);
      const files=receiptFiles(ctx.home).filter(f=>f.file!==claudep(ctx.home));
      fs.writeFileSync(claudep(ctx.home),tryRead(claudep(ctx.home)).replace('Prefer structured output.','Prefer structured output.\n\n<!-- user note -->'));
      installCase(ctx,['--uninstall']);
      demand(!fs.existsSync(frontdeskp(ctx.home)) && !fs.existsSync(frontreceiptp(ctx.home)),'front desk remains after uninstall');
      demand(!fs.existsSync(receiptp(ctx.home)),'packet receipt remains');
      demand(files.every(f=>!fs.existsSync(f.file)),'packet-owned core files remain');
      const md=tryRead(claudep(ctx.home)); demand(md.includes('## Style') && md.includes('## Notes') && md.includes('<!-- user note -->') && !md.includes('## Delegation (shared rulebook)'),'uninstall damaged CLAUDE.md');
    },{tools:{...common.tools,codex:'99.0.0','cursor-agent':'99.0.0',muse:'99.0.0'},cursorCfg:{models:CURSOR_ALL_IDS,fail:false},codexCache:makeCodexCache()}),
    test(38,'previous packet upgrade acquires or keeps ladder ownership',ctx=>{
      if (!ctx.previous || !fs.existsSync(ctx.previous)) throw new ScenarioSkip('no previous packet');
      const dir=makeTmp('fixt-ladder-prev-'); extractPrevious(ctx.previous,dir);
      const entries=fs.readdirSync(dir); const previous=entries.length===1?path.join(dir,entries[0]):dir;
      // A previous packet that had no ladder (dated numbers before 2026.10.27-1) must not own it and must hand ownership
      // over; every later one (a later dated number, or any MAJOR.MINOR.PATCH number) must own it already and keep it
      // through the upgrade. Dated numbers are YYYY.MM.DD-N, so they compare as strings.
      const prevVersion=(tryRead(path.join(previous,'VERSION'))||'').trim();
      const numbered=/^\d+\.\d+\.\d+$/.test(prevVersion);
      demand(numbered || /^\d{4}\.\d{2}\.\d{2}-\d+$/.test(prevVersion),`previous packet VERSION unreadable: "${prevVersion}"`);
      installCase(ctx,[],{pkt:previous}); const before=readRequired(receiptp(ctx.home)).ladder;
      if (numbered || prevVersion>='2026.10.27-1') demand(before?.owned===true,`previous packet ${prevVersion} should own the ladder`);
      else demand(!before,`previous packet ${prevVersion} unexpectedly owns the ladder`);
      const out=installCase(ctx); demand(out.stdout.includes('Upgrading from'),'upgrade message missing'); ownedLadder(ctx);
    }),
    test(39,'dry runs preserve fresh, valid, malformed and unreadable homes',ctx=>{
      let before=snapshotTree(ctx.home); const fresh=installCase(ctx,['--dry-run']);
      demand(fresh.stdout.includes('[dry run]'),'front desk dry-run plan missing'); equalTree(before,ctx.home,'fresh dry run');
      installCase(ctx); ownedLadder(ctx);
      before=snapshotTree(ctx.home); installCase(ctx,['--dry-run']); equalTree(before,ctx.home,'valid receipt dry run');
      const valid=fs.readFileSync(frontreceiptp(ctx.home));
      fs.writeFileSync(frontreceiptp(ctx.home),'{bad'); before=snapshotTree(ctx.home);
      installCase(ctx,['--dry-run']); equalTree(before,ctx.home,'malformed receipt dry run');
      directFrontdesk(ctx,[],{dry:true,status:1}); equalTree(before,ctx.home,'direct malformed receipt dry run');
      fs.rmSync(frontreceiptp(ctx.home)); fs.mkdirSync(frontreceiptp(ctx.home));
      fs.writeFileSync(path.join(frontreceiptp(ctx.home),'unreadable-sentinel'),'directory cannot be read as receipt JSON');
      before=snapshotTree(ctx.home); installCase(ctx,['--dry-run']); equalTree(before,ctx.home,'unreadable receipt dry run');
      fs.rmSync(frontreceiptp(ctx.home),{recursive:true}); fs.writeFileSync(frontreceiptp(ctx.home),valid);
    }),
    test(40,'tampering fails closed and owner-style receipts keep behavior',ctx=>{
      installCase(ctx); ownedLadder(ctx);
      for (const name of fs.readdirSync(path.join(frontdeskp(ctx.home),'state'))) fs.rmSync(path.join(frontdeskp(ctx.home),'state',name),{recursive:true,force:true});
      excluded(ctx,'Junior','qwen-local'); excluded(ctx,'Developer','qwen-local');
      const receipt=readRequired(frontreceiptp(ctx.home));
      const variants=[r=>{delete r.exclusions;return r;},r=>{r.exclusions={required:[],declared:[]};return r;},r=>{r.exclusions.required=r.exclusions.required.filter(x=>x!=='qwen-local');return r;}];
      for (const [i,change] of [...variants,()=>'{bad'].entries()) {
        const r=change(structuredClone(receipt)); fs.writeFileSync(frontreceiptp(ctx.home),typeof r==='string'?r:JSON.stringify(r));
        for (const args of [['plan','Junior'],['plan','Developer'],['list']]) {
          const result=roleJson(ctx,args,ctx.home,3);
          demand(result.ok===false && !result.roles && !JSON.stringify(result).includes('"resolution"'),`tamper ${i}: an engineer was named`);
        }
      }
      const owner=structuredClone(receipt); delete owner.installedBy; delete owner.exclusions; fs.writeFileSync(frontreceiptp(ctx.home),JSON.stringify(owner));
      isolatedTools(ctx);
      for (const role of ['Junior','Developer']) {
        const p=roleJson(ctx,['plan',role]);
        const qwen=p.roles[0].engineers.find(e=>e.key==='qwen-local|high');
        demand(qwen && !qwen.reasons.some(r=>r.code==='excluded_here'),`${role}: owner-style receipt gained an exclusion`);
        const ownerHome=childHome(ctx); directFrontdesk(ctx,[],{home:ownerHome});
        isolatedTools(ctx,ownerHome);
        const baseline=roleJson(ctx,['plan',role],ownerHome);
        demand(JSON.stringify(p.roles)===JSON.stringify(baseline.roles),`${role}: owner-style behavior differs from a direct owner-style install`);
      }
    }),
    test(41,'ownership survives missing Node, old Node and clean failure',ctx=>{
      installCase(ctx); const installed=ownedLadder(ctx).ladder.lastInstalled;
      const noTools=makeTmp('fixt-ladder-no-node-'); createFakeTools(noTools,common.tools,common.cursorCfg,false);
      const noNode=buildEnv(noTools,false); assertNoNode(noNode,ctx.bash);
      for (const old of [false,true]) {
        if(old) createFakeTools(noTools,{node:'16.0.0'},{},false);
        installCase(ctx,[],{env:noNode});
        const l=readRequired(receiptp(ctx.home)).ladder;
        demand(l.owned && l.lastAttempt.status==='skipped' && JSON.stringify(l.lastInstalled)===JSON.stringify(installed),'skip lost durable ownership');
      }
      const fail=installCase(ctx,['--unavailable','claude-haiku-5-5'],{env:{...ctx.env,TEAM_LADDER_TEST_FAIL:'before-commit'}});
      const l=readRequired(receiptp(ctx.home)).ladder;
      demand(l.owned && l.lastAttempt.status==='failed' && JSON.stringify(l.lastInstalled)===JSON.stringify(installed),'failure lost durable ownership');
      demand(fail.stdout.includes('previous state is kept'),'clean failure summary missing');
      installCase(ctx,['--uninstall']); demand(!fs.existsSync(frontdeskp(ctx.home)) && !fs.existsSync(frontreceiptp(ctx.home)),'uninstall lost ownership after degraded runs');
    }),
    test(42,'separate front desks are never adopted or removed',ctx=>{
      directFrontdesk(ctx); isolatedTools(ctx);
      fs.writeFileSync(path.join(frontdeskp(ctx.home),'state/sentinel'),'private state');
      fs.mkdirSync(path.join(frontdeskp(ctx.home),'generations/extra')); fs.writeFileSync(path.join(frontdeskp(ctx.home),'generations/extra/sentinel'),'private generation');
      const before=frontState(ctx.home);
      for (const args of [[],[],['--uninstall']]) {
        const out=installCase(ctx,args);
        demand(out.stdout.includes('Ladder: KEEP'),'foreign front desk KEEP missing'); equalFront(before,ctx.home,'foreign front desk');
      }
      // A readable receipt with hooks and an unreadable receipt are also foreign, even with an owned packet record.
      for (const variant of ['hooks','unreadable']) {
        const home=childHome(ctx); installCase(ctx,[],{home}); isolatedTools(ctx,home);
        const durable=readRequired(receiptp(home)).ladder.lastInstalled;
        if(variant==='hooks'){ const r=readRequired(frontreceiptp(home));r.hooks={claude:{command:'external hook'}};fs.writeFileSync(frontreceiptp(home),JSON.stringify(r)); }
        else fs.writeFileSync(frontreceiptp(home),'{bad');
        const state=frontState(home); const out=installCase(ctx,[],{home}); demand(out.stdout.includes('Ladder: KEEP'),'owned packet adopted foreign receipt');
        const kept=readRequired(receiptp(home)).ladder;
        demand(kept.owned && kept.lastAttempt.status==='kept' && JSON.stringify(kept.lastInstalled)===JSON.stringify(durable),'KEEP lost durable ladder ownership');
        installCase(ctx,['--uninstall'],{home}); equalFront(state,home,variant);
      }
    }),
    test(43,'destination and backup links never touch outside sentinels',ctx=>{
      for (const rel of ['', 'state','generations','receipt']) {
        const home=childHome(ctx); installCase(ctx,[],{home}); isolatedTools(ctx,home);
        const outside=makeTmp('fixt-ladder-outside-'); fs.writeFileSync(path.join(outside,'sentinel'),'outside');
        const link=rel==='receipt'?frontreceiptp(home):path.join(frontdeskp(home),rel);
        fs.renameSync(link,link+'.saved');
        const linked=rel==='receipt'?fileLink(ctx,path.join(outside,'sentinel'),link,'frontdesk-install.json link'):(folderLink(outside,link),true);
        if(!linked){ fs.renameSync(link+'.saved',link);continue; }
        const before=snapshotTree(outside), dryBefore=snapshotTree(home);
        const dry=installCase(ctx,['--dry-run'],{home}); demand(dry.stdout.includes('a link leads outside the owned folders'),'linked destination dry run not skipped'); equalTree(dryBefore,home,'linked dry run'); equalTree(before,outside,`dry-run link ${rel}`);
        const out=installCase(ctx,[],{home}); demand(out.stdout.includes('Ladder: SKIP (a link leads outside the owned folders)'),'linked destination install not skipped');
        equalTree(before,outside,`install link ${rel}`);
        installCase(ctx,['--uninstall'],{home}); equalTree(before,outside,`link ${rel}`);
      }
      for (const kind of ['folder','file']) {
        const home=childHome(ctx); installCase(ctx,[],{home}); isolatedTools(ctx,home);
        const outside=makeTmp('fixt-ladder-backup-outside-'); const sentinel=path.join(outside,'sentinel'); fs.writeFileSync(sentinel,'outside backup');
        const base=path.join(home,'.config/delegate-skills/.backups/frontdesk'), prefix='fixture-fixed-stamp';
        fs.mkdirSync(base,{recursive:true}); const trap=path.join(base,prefix);
        if(kind==='folder') folderLink(outside,trap);
        else { fs.mkdirSync(trap); if(!fileLink(ctx,sentinel,path.join(trap,'frontdesk-install.json'),'backup destination file link')) continue; }
        const env={...ctx.env,FRONTDESK_TEST_HOOKS:'1',FRONTDESK_TEST_STAMP:prefix};
        const outsideBefore=snapshotTree(outside), before=snapshotTree(home);
        installCase(ctx,['--dry-run','--unavailable','claude-haiku-5-5'],{home,env}); equalTree(before,home,'backup-link dry run');
        const update=installCase(ctx,['--unavailable','claude-haiku-5-5'],{home,env});
        demand(/exclusions updated|prior state|not installed/.test(update.stdout),'backup-link update result missing'); equalTree(outsideBefore,outside,'exclusion-only backup');
        const receipt=frontreceiptp(home); fs.writeFileSync(receipt,'{bad');
        const badBefore=snapshotTree(home); directFrontdesk(ctx,[],{home,env,dry:true,status:1}); equalTree(badBefore,home,'invalid receipt backup dry run');
        directFrontdesk(ctx,[],{home,env,status:1}); equalTree(outsideBefore,outside,'invalid receipt backup');
        demand(tryRead(receipt)==='{bad','invalid receipt was overwritten');
        demand(fs.readdirSync(base).some(n=>n.startsWith(prefix+'-') && !fs.lstatSync(path.join(base,n)).isSymbolicLink()),'no fresh exclusive backup folder');
      }
    }),
    test(44,'fresh, upgrade and exclusion failures preserve state; rollback status is distinct',ctx=>{
      const fresh=installCase(ctx,[],{env:{...ctx.env,TEAM_LADDER_TEST_FAIL:'before-commit'}});
      demand(fresh.stdout.includes('previous state is kept') && readRequired(receiptp(ctx.home)).ladder.lastAttempt.status==='failed','fresh clean failure not reported');
      demand(!fs.existsSync(frontdeskp(ctx.home)) && !fs.existsSync(frontreceiptp(ctx.home)),'fresh rollback left ladder files');
      installCase(ctx); ownedLadder(ctx);
      const upgrade=copyPacket(ctx,p=>{const f=path.join(p,'ladder/manifest.json'),m=readRequired(f);m.generation++;fs.writeFileSync(f,JSON.stringify(m));});
      for (const mode of ['upgrade','exclusions']) {
        const before=frontState(ctx.home), previous=readRequired(receiptp(ctx.home)).ladder.lastInstalled;
        const args=mode==='upgrade'?[]:['--unavailable','claude-haiku-5-5'];
        const failed=installCase(ctx,args,{pkt:mode==='upgrade'?upgrade:ctx.pkt,env:{...ctx.env,TEAM_LADDER_TEST_FAIL:'before-commit'}});
        demand(failed.stdout.includes('prior state restored') && readRequired(receiptp(ctx.home)).ladder.lastAttempt.status==='failed',`${mode} failure not recorded`);
        equalFront(before,ctx.home,mode+' rollback');
        demand(JSON.stringify(readRequired(receiptp(ctx.home)).ladder.lastInstalled)===JSON.stringify(previous),`${mode} changed lastInstalled`);
      }
      const failed=installCase(ctx,['--unavailable','claude-haiku-5-5'],{env:{...ctx.env,TEAM_LADDER_TEST_FAIL:'restore'}});
      demand(failed.stdout.includes('rollback is incomplete') && failed.stdout.includes('see the front desk backups'),'incomplete rollback summary missing');
      demand(readRequired(receiptp(ctx.home)).ladder.lastAttempt.status==='failed-rollback-incomplete','exit 4 attempt status missing');
    }),
    test(45,'failed first install can retry and later uninstall',ctx=>{
      installCase(ctx,[],{env:{...ctx.env,TEAM_LADDER_TEST_FAIL:'before-commit'}});
      demand(!fs.existsSync(frontdeskp(ctx.home)) && !fs.existsSync(frontreceiptp(ctx.home)),'failed first install did not restore empty location');
      const failed=readRequired(receiptp(ctx.home)).ladder; demand(!failed.owned && failed.lastInstalled===null && failed.lastAttempt.status==='failed','fresh failure claimed ownership');
      installCase(ctx); ownedLadder(ctx);
      installCase(ctx,['--uninstall']); demand(!fs.existsSync(frontdeskp(ctx.home)) && !fs.existsSync(frontreceiptp(ctx.home)),'retry was not uninstallable');
    }),
    test(46,'packet-to-packet upgrade preserves owned ladder',ctx=>{
      const older=copyPacket(ctx,p=>fs.writeFileSync(path.join(p,'VERSION'),'0.9.0\n'));
      installCase(ctx,[],{pkt:older}); ownedLadder(ctx);
      const out=installCase(ctx); demand(out.stdout.includes('Upgrading from 0.9.0 to'),'packet upgrade message missing');
      const r=ownedLadder(ctx), manifest=readRequired(path.join(ctx.pkt,'ladder/manifest.json')), version=readRequired(path.join(ctx.pkt,'frontdesk/code-manifest.json')).version;
      demand(r.ladder.lastInstalled.release===manifest.release && r.ladder.lastInstalled.frontdesk===version,'upgrade lastInstalled does not name current release/version');
    }),
  ];
}

const codexAgentsp = h => path.join(h,'.codex/AGENTS.md');
const HELPER_FILES = ['explore','implementer','researcher','verifier','haiku-helper'].map(n=>`.claude/agents/${n}.md`);
function freshAgentHome(h) { fs.rmSync(claudep(h),{force:true}); }
function writeInstructions(h,bytes) { fs.mkdirSync(path.dirname(codexAgentsp(h)),{recursive:true}); fs.writeFileSync(codexAgentsp(h),bytes); }
function sameBytes(file,expected,label) { demand(isFile(file) && fs.readFileSync(file).equals(Buffer.from(expected)),`${label}: bytes changed: ${file}`); }
// What a Muse relay must contain to protect its jobs, and the installers' warning when the installed one does not.
const GUARD='"--contributor-mode", "off"';
const UNGUARDED="does not switch off Meta's contributor tier";
const UNCONFIRMED="the installer cannot confirm that it switches off Meta's contributor tier";
function switchAgents(ctx,tools,wantNode=true) {
  ctx.fakeDir=makeTmp(`fixt-${ctx.n}-${ctx.type}-tools-`);
  createFakeTools(ctx.fakeDir,tools,{models:CURSOR_ALL_IDS,fail:false},wantNode);
  ctx.env=buildEnv(ctx.fakeDir,wantNode);
}
function assertNoClaude(h) {
  for(const f of [...HELPER_FILES,'.claude/CLAUDE.md']) demand(!fs.existsSync(path.join(h,f)),`Claude-only file created: ${f}`);
}
function assertAllRemoved(h,receipt,except=[]) {
  for(const f of receiptFilesFrom(receipt,h)) if(!except.includes(f.rel)) demand(!fs.existsSync(f.abs),`owned file survived uninstall: ${f.rel}`);
  demand(!fs.existsSync(receiptp(h)) && !fs.existsSync(frontdeskp(h)) && !fs.existsSync(frontreceiptp(h)),'packet/ladder survived uninstall');
}
function receiptFilesFrom(receipt,h) {
  const marker=`/${path.basename(h)}/`;
  return Object.keys(receipt.files).map(key=>{const norm=key.replace(/\\/g,'/'), i=norm.indexOf(marker); return {rel:norm.slice(i+marker.length),abs:path.join(h,norm.slice(i+marker.length))};});
}
function codexOwned(h) {
  const r=readRequired(receiptp(h)), file=codexAgentsp(h), record=r.codexSection;
  demand(record?.owned===true && typeof record.created==='boolean' && typeof record.separator==='string','Codex section ownership absent');
  const native=IS_WIN && record.path.startsWith('/tmp/') ? path.join(os.tmpdir(),record.path.slice(5)) : IS_WIN && record.path.startsWith('/') ? record.path.replace(/^\/([a-z])\//i,(_,d)=>`${d}:/`) : record.path;
  demand(path.resolve(native).toLowerCase()===fs.realpathSync(file).toLowerCase(),'Codex receipt canonical path mismatch');
  demand(/^\s*"codexSection":\s*\{[^\r\n]+\},?$/m.test(tryRead(receiptp(h))),'Codex ownership is not on one line');
  const text=tryRead(file);
  demand(text.includes('## Delegation (shared rulebook)') && !text.includes('{{'),'Codex section missing/unrendered');
  demand(receiptFiles(h).some(f=>f.rel==='.codex/AGENTS.md'),'Codex file hash not recorded');
  return r;
}
function noClaudeLadder(ctx,h=ctx.home) {
  ownedLadder(ctx,h);
  const doc=isolatedTools(ctx,h); demand(!doc.tools?.claude,'Claude escaped into the agent-only fixture');
  for(const role of ['Junior','Developer','Tech lead','CTO']) {
    const rows=roleJson(ctx,['plan',role],h).roles?.[0];
    demand(rows,`${role}: role absent`);
    demand(rows.resolution.route!=='claude-code',`${role}: Claude Code route selected without Claude Code`);
    // 47 requires no Claude model. Cursor-only may legitimately call a Claude model through Cursor.
    if(ctx.n===47) demand(!rows.resolution.key?.startsWith('claude'),`${role}: Claude engineer selected on Codex-only machine`);
  }
}
function neutralEntry(ctx,tool) {
  const text='No instructions file written: tell your agent to read ';
  demand(ctx.lastOut.includes(text) && ctx.lastOut.includes('before nontrivial work (Muse also finds the consensus skill).'),'summary has no C6 instruction');
  const profile=routesIn(ctx.home);
  demand(profile.includes(text) && profile.includes('Claude Code: not found') && !profile.includes('{{'),'profile missing C6/not-found line');
  assertNoClaude(ctx.home); demand(!fs.existsSync(codexAgentsp(ctx.home)),'instructions file written without Claude/Codex');
  for(const f of ['.claude/skills/consensus/SKILL.md','.agents/skills/consensus/SKILL.md',`.claude/skills/${tool}-delegate/SKILL.md`]) demand(isFile(path.join(ctx.home,f)),`missing ${f}`);
}
function agentScenarios() {
  const common={wantNode:true,tools:{codex:'99.0.0'},cursorCfg:{models:[],fail:false},codexCache:makeCodexCache()};
  const test=(n,title,exercise,overrides={})=>({...common,n,title,exercise,...overrides});
  return [
    test(47,'Codex only: entry, ladder, unchanged repeat and uninstall',ctx=>{
      freshAgentHome(ctx.home); const before=snapshotTree(ctx.home);
      installCase(ctx,['--dry-run']); equalTree(before,ctx.home,'Codex-only dry run');
      installCase(ctx); assertNoClaude(ctx.home); codexOwned(ctx.home); noClaudeLadder(ctx);
      demand(routesIn(ctx.home).includes('Claude Code: not found') && routesIn(ctx.home).includes('- Rulebook entry: Codex (AGENTS.md section)'),'Codex-only profile entry missing');
      const bytes=fs.readFileSync(codexAgentsp(ctx.home));
      const repeat=installCase(ctx); demand(!planHas(repeat.stdout,['CREATE','UPDATE','REMOVE']),'Codex-only repeat changed a target');
      sameBytes(codexAgentsp(ctx.home),bytes,'Codex-only repeat');
      const r=codexOwned(ctx.home); installCase(ctx,['--uninstall']); assertAllRemoved(ctx.home,r);
    }),
    test(48,'Codex byte splice variants, following heading and duplicates',ctx=>{
      const variants=[['LF',Buffer.from('# My rules\n\n## Style\nUse café.\n')],['CRLF',Buffer.from('# My rules\r\n\r\n## Style\r\nUse café.\r\n')],
        ['BOM',Buffer.concat([Buffer.from([239,187,191]),Buffer.from('# My rules\nUse café.\n')])],['blank-lines',Buffer.from('# My rules\n\n\n\n')],['no-final-newline',Buffer.from('# My rules\nUse café.')]];
      for(const [name,original] of variants) {
        const h=childHome(ctx); freshAgentHome(h); writeCodexCache(h,makeCodexCache()); writeInstructions(h,original);
        installCase(ctx,[],{home:h}); const r=codexOwned(h), installed=fs.readFileSync(codexAgentsp(h));
        const eol=name==='CRLF'?'\r\n':'\n', sep=original.at(-1)===10?eol:eol+eol;
        demand(r.codexSection.separator===sep && !r.codexSection.created,`${name}: wrong append separator/created flag`);
        demand(installed.subarray(0,original.length).equals(original),`${name}: original prefix changed`);
        const added=installed.subarray(original.length+Buffer.byteLength(sep)).toString('utf8');
        demand(added.endsWith(eol) && !added.endsWith(eol+eol) && (name!=='CRLF' || !/(^|[^\r])\n/.test(added)),`${name}: section line endings differ`);
        const again=installCase(ctx,[],{home:h}); demand(again.stdout.includes('UNCHANGED') && !planHas(again.stdout,['CREATE','UPDATE','REMOVE']),`${name}: repeat not UNCHANGED`);
        sameBytes(codexAgentsp(h),installed,name+' repeat');
        installCase(ctx,['--uninstall'],{home:h}); sameBytes(codexAgentsp(h),original,name+' restore');
      }
      const h=childHome(ctx), original=Buffer.concat([Buffer.from([239,187,191]),Buffer.from('# Private\r\nKeep these bytes.\r\n')]);
      freshAgentHome(h); writeCodexCache(h,makeCodexCache()); writeInstructions(h,original);
      installCase(ctx,[],{home:h}); const record=codexOwned(h).codexSection;
      const following=Buffer.from('## My added notes\r\nPreserve café and trailing blanks.\r\n\r\n');
      fs.appendFileSync(codexAgentsp(h),following);
      installCase(ctx,[],{home:h}); const withNotes=fs.readFileSync(codexAgentsp(h));
      const again=installCase(ctx,[],{home:h}); demand(!planHas(again.stdout,['CREATE','UPDATE','REMOVE']),'following heading repeat not unchanged'); sameBytes(codexAgentsp(h),withNotes,'following heading repeat');
      installCase(ctx,['--uninstall'],{home:h}); sameBytes(codexAgentsp(h),Buffer.concat([original,Buffer.from(record.separator),following]),'following heading retained');
      const duplicate=childHome(ctx); freshAgentHome(duplicate); writeInstructions(duplicate,'\ufeff## Delegation (shared rulebook) \t\r\nOne\r\n## Other\r\n## Delegation (shared rulebook)\r\nTwo\r\n');
      const before=snapshotTree(duplicate); const refusal=installCase(ctx,[],{home:duplicate,status:2}); demand(refusal.stdout.includes('more than one'),'duplicate section refusal missing'); equalTree(before,duplicate,'duplicate refusal');
    },{wantNode:false}), // Exercise the byte splice and receipt recovery without a JSON runtime; 47 covers Node + ladder.
    test(49,'no agent refuses before any change',ctx=>{
      freshAgentHome(ctx.home); const before=snapshotTree(ctx.home);
      const r=installCase(ctx,[],{status:2});
      demand(r.stdout.includes('No supported agent tool found (Claude Code, Codex, Cursor Agent or Muse). Install one, log in, then run the installer again.'),'four-agent refusal message missing');
      equalTree(before,ctx.home,'no-agent refusal');
    },{tools:{}}),
    test(50,'missing tools keep owned parts; zero-agent uninstall',ctx=>{
      const original=Buffer.from('# Existing Codex rules\r\nPrivate café.'); writeInstructions(ctx.home,original);
      installCase(ctx); const before=codexOwned(ctx.home), paths=[...HELPER_FILES,'.claude/CLAUDE.md','.codex/AGENTS.md'];
      const bytes=new Map(paths.map(f=>[f,fs.readFileSync(path.join(ctx.home,f))]));
      switchAgents(ctx,{codex:'99.0.0',muse:'99.0.0'});
      const noClaude=installCase(ctx); demand(noClaude.stdout.includes('KEEP (Claude Code not found; left as installed)'),'Claude missing KEEP absent');
      for(const f of paths) sameBytes(path.join(ctx.home,f),bytes.get(f),'Claude missing '+f);
      for(const f of HELPER_FILES.concat('.claude/CLAUDE.md')) demand(receiptFiles(ctx.home).some(x=>x.rel===f),'Claude ownership lost: '+f);
      // Muse remains for the second install, satisfying C1 while both original tools are absent.
      switchAgents(ctx,{muse:'99.0.0'});
      const noCodex=installCase(ctx); demand(noCodex.stdout.includes('KEEP (Codex not found; left as installed)'),'Codex missing KEEP absent');
      for(const f of paths) sameBytes(path.join(ctx.home,f),bytes.get(f),'both missing '+f);
      const after=readRequired(receiptp(ctx.home)); demand(JSON.stringify(after.codexSection)===JSON.stringify(before.codexSection),'Codex ownership changed when missing');
      for(const f of paths) demand(receiptFiles(ctx.home).some(x=>x.rel===f),'missing-tool receipt lost '+f);
      switchAgents(ctx,{}); installCase(ctx,['--uninstall']); assertAllRemoved(ctx.home,after,['.claude/CLAUDE.md','.codex/AGENTS.md']);
      sameBytes(codexAgentsp(ctx.home),original,'zero-agent uninstall restored Codex');
      demand(!tryRead(claudep(ctx.home)).includes('## Delegation (shared rulebook)'),'zero-agent uninstall retained Claude section');
    },{tools:{claude:'99.0.0',codex:'99.0.0',muse:'99.0.0'}}),
    test(51,'Codex environment, folder and file containment',ctx=>{
      for(const kind of ['CODEX_HOME','folder','file-fresh','file-owned']) {
        const h=childHome(ctx), outside=makeTmp('fixt-codex-outside-'); freshAgentHome(h);
        const sentinel=path.join(outside,'AGENTS.md'); fs.writeFileSync(sentinel,'## Outside rules\r\nLeave café alone.\r\n');
        let env=ctx.env, owned=null;
        if(kind==='CODEX_HOME') { fs.mkdirSync(path.join(h,'.codex'),{recursive:true}); env={...ctx.env,CODEX_HOME:outside}; }
        else if(kind==='folder') folderLink(outside,path.join(h,'.codex'));
        else {
          fs.mkdirSync(path.join(h,'.codex'),{recursive:true});
          if(kind==='file-owned') { writeCodexCache(h,makeCodexCache()); installCase(ctx,[],{home:h}); owned=codexOwned(h).codexSection; fs.unlinkSync(codexAgentsp(h)); }
          if(!fileLink(ctx,sentinel,codexAgentsp(h),kind)) continue;
        }
        const untouched=snapshotTree(outside), homeBefore=snapshotTree(h);
        const reason=kind==='CODEX_HOME'?'CODEX_HOME points to':'a link leads outside this home';
        for(const args of [['--dry-run'],[],['--uninstall']]) {
          const r=installCase(ctx,args,{home:h,env}); demand(r.stdout.includes(reason) && r.stdout.includes('SKIP'),`${kind}: skip reason missing`);
          equalTree(untouched,outside,kind+' outside');
          if(args.includes('--dry-run')) equalTree(homeBefore,h,kind+' dry run');
          if(args.length===0) {
            const rec=readRequired(receiptp(h)); demand(JSON.stringify(rec.codexSection)===JSON.stringify(owned),kind+': skipped ownership changed');
          }
          if(fs.existsSync(frontreceiptp(h))) isolatedTools(ctx,h);
        }
      }
    }),
    test(52,'Muse only installs skills and neutral entry',ctx=>{
      freshAgentHome(ctx.home); installCase(ctx); neutralEntry(ctx,'muse'); noClaudeLadder(ctx);
    },{tools:{muse:'99.0.0'}}),
    test(53,'skipped Codex sections never adopt pre-existing text',ctx=>{
      const original=Buffer.from('\ufeff# Private\r\n## Delegation (shared rulebook)\r\nPerson-owned rules.\r\n## Other\r\nKeep.\r\n');
      for(const kind of ['missing','CODEX_HOME']) {
        const h=childHome(ctx); freshAgentHome(h); writeInstructions(h,original);
        switchAgents(ctx,kind==='missing'?{muse:'99.0.0'}:{codex:'99.0.0'});
        let env=ctx.env, outside=null;
        if(kind==='CODEX_HOME') { outside=makeTmp('fixt-codex-env-'); fs.writeFileSync(path.join(outside,'sentinel'),'keep'); env={...env,CODEX_HOME:outside}; }
        const tree=outside?snapshotTree(outside):null;
        for(const action of ['install','repeat','uninstall']) {
          const r=installCase(ctx,action==='uninstall'?['--uninstall']:[],{home:h,env});
          demand(r.stdout.includes(kind==='missing'?(action==='uninstall'?'not owned':'needs Codex'):'CODEX_HOME points to'),`${kind}: skip/ownership reason missing`);
          sameBytes(codexAgentsp(h),original,kind+' '+action);
          if(action!=='uninstall') { const rec=readRequired(receiptp(h)); demand(!rec.codexSection?.owned && !receiptFiles(h).some(f=>f.rel==='.codex/AGENTS.md'),'unowned skipped section was adopted'); }
          if(outside) equalTree(tree,outside,'CODEX_HOME skip');
          if(fs.existsSync(frontreceiptp(h))) isolatedTools(ctx,h);
        }
      }
    }),
    test(54,'Codex only without Node installs core and entry',ctx=>{
      freshAgentHome(ctx.home); installCase(ctx); assertNoClaude(ctx.home); codexOwned(ctx.home);
      demand(isFile(path.join(ctx.home,'.config/delegate-skills/team-policy/POLICY.md')) && routesIn(ctx.home).includes('Codex (AGENTS.md section)'),'no-Node core/entry missing');
      demand(ctx.lastOut.includes('SKIP (needs Node 18+)'),'no-Node skip missing');
      for(const rel of ['.config/delegate-skills/consensus/referee.mjs','.claude/skills/codex-delegate/SKILL.md','.config/delegate-skills/config.json','.config/delegate-skills/frontdesk-install.json']) demand(!fs.existsSync(path.join(ctx.home,rel)),`no-Node wrote ${rel}`);
      demand(readRequired(receiptp(ctx.home)).ladder.lastAttempt.status==='skipped','no-Node ladder not skipped');
    },{wantNode:false}),
    test(55,'unowned Codex section is KEEP and never adopted',ctx=>{
      freshAgentHome(ctx.home); const original=Buffer.from('# Mine\n\n## Delegation (shared rulebook) \t\nPrivate café.\n## Later\nKeep.\n'); writeInstructions(ctx.home,original);
      for(const action of ['install','repeat','uninstall']) {
        const r=installCase(ctx,action==='uninstall'?['--uninstall']:[]);
        if(action!=='uninstall') {
          demand(r.stdout.includes('KEEP (a "Delegation (shared rulebook)" section the packet did not write is here; left as it is)'),'unowned KEEP missing');
          demand(readRequired(receiptp(ctx.home)).codexSection===null && !receiptFiles(ctx.home).some(f=>f.rel==='.codex/AGENTS.md'),'unowned section was adopted');
          noClaudeLadder(ctx);
        }
        sameBytes(codexAgentsp(ctx.home),original,'unowned '+action);
      }
    }),
    test(56,'Cursor only: neutral entry, unchanged repeat and uninstall',ctx=>{
      freshAgentHome(ctx.home); installCase(ctx); neutralEntry(ctx,'cursor'); noClaudeLadder(ctx);
      const repeat=installCase(ctx); demand(!planHas(repeat.stdout,['CREATE','UPDATE','REMOVE']),'Cursor-only repeat changed targets'); neutralEntry(ctx,'cursor');
      const r=readRequired(receiptp(ctx.home)); installCase(ctx,['--uninstall']); assertAllRemoved(ctx.home,r);
    },{tools:{'cursor-agent':'99.0.0'},cursorCfg:{models:CURSOR_ALL_IDS,fail:false}}),
    // 58/59: Muse's own contributor setting is reported, never changed.
    test(58,'Muse contributor mode ON: warning, settings untouched',ctx=>{
      freshAgentHome(ctx.home);
      const f=path.join(ctx.home,'.config/muse/settings.json'); fs.mkdirSync(path.dirname(f),{recursive:true});
      const original=Buffer.from('{\n  "schema_version": 1,\n  "contributor_mode_enabled": true,\n  "contributor_mode_disclosure_acknowledged": true\n}\n');
      fs.writeFileSync(f,original);
      const r=installCase(ctx);
      demand(r.stdout.includes('WARNING: Muse contributor mode is ON'),'contributor warning missing');
      demand(r.stdout.includes('switches it off for every job it runs'),'summary does not say the installed relay switches it off');
      demand(!r.stdout.includes(UNGUARDED),'the packet relay was reported unguarded');
      sameBytes(f,original,'Muse settings after install');
      const repeat=installCase(ctx); demand(repeat.stdout.includes('WARNING: Muse contributor mode is ON'),'contributor warning missing on repeat');
      // The value on the line after its key (install.sh used to match one line at a time).
      const split=Buffer.from('{\n  "schema_version": 1,\n  "contributor_mode_enabled":\n    true\n}\n'); fs.writeFileSync(f,split);
      const again=installCase(ctx); demand(again.stdout.includes('WARNING: Muse contributor mode is ON'),'warning missing when the value is on the next line');
      sameBytes(f,split,'Muse settings after the split-line run');
      installCase(ctx,['--uninstall']); sameBytes(f,split,'Muse settings after uninstall');
    },{tools:{muse:'99.0.0'}}),
    test(59,'Muse contributor mode off or absent: no warning',ctx=>{
      freshAgentHome(ctx.home);
      let r=installCase(ctx); demand(!r.stdout.includes('Muse contributor mode is ON'),'warning without a Muse settings file');
      demand(!r.stdout.includes(UNGUARDED),'the packet relay was reported unguarded');
      const f=path.join(ctx.home,'.config/muse/settings.json'); fs.mkdirSync(path.dirname(f),{recursive:true});
      const original=Buffer.from('{"schema_version":1,"contributor_mode_enabled":false}\n'); fs.writeFileSync(f,original);
      r=installCase(ctx); demand(!r.stdout.includes('Muse contributor mode is ON'),'warning with contributor mode off');
      sameBytes(f,original,'Muse settings after repeat');
    },{tools:{muse:'99.0.0'}}),
    test(60,'upgrade with Muse present installs the guarded Muse relay',ctx=>{
      if (!ctx.previous || !fs.existsSync(ctx.previous)) throw new ScenarioSkip('no previous packet');
      const dir=makeTmp('fixt-muse-prev-'); extractPrevious(ctx.previous,dir);
      const entries=fs.readdirSync(dir); const previous=entries.length===1?path.join(dir,entries[0]):dir;
      freshAgentHome(ctx.home); installCase(ctx,[],{pkt:previous});
      const relay=path.join(ctx.home,'.claude/skills/muse-delegate/scripts/relay.mjs');
      demand(isFile(relay),'the previous packet installed no Muse relay');
      const wasGuarded=fs.readFileSync(relay,'utf8').includes(GUARD);
      const out=installCase(ctx); demand(out.stdout.includes('Upgrading from'),'upgrade message missing');
      if (!wasGuarded) demand(/^\s*UPDATE\b.*muse-delegate[\\/]scripts[\\/]relay\.mjs/m.test(out.stdout),'the upgrade plan does not update the Muse relay');
      demand(fs.readFileSync(relay,'utf8').includes(GUARD),'the installed Muse relay does not pass --contributor-mode off');
      demand(!out.stdout.includes(UNGUARDED),'the upgraded relay was reported unguarded');
    },{tools:{muse:'99.0.0'}}),
    test(61,'a Muse relay installed by the person without the guard: kept as it is, with a warning',ctx=>{
      freshAgentHome(ctx.home);
      const own=path.join(ctx.home,'.claude/skills/muse-delegate'); fs.mkdirSync(path.join(own,'scripts'),{recursive:true});
      const skill=Buffer.from('---\nname: muse-delegate\n---\nmine\n'), relay=Buffer.from('// my own relay: runs muse exec without any contributor flag\n');
      fs.writeFileSync(path.join(own,'SKILL.md'),skill); fs.writeFileSync(path.join(own,'scripts/relay.mjs'),relay);
      const r=installCase(ctx);
      demand(/KEEP \(installed by you; not replaced\)/.test(r.stdout),'the person\'s relay folder was not kept');
      demand(r.stdout.includes(UNGUARDED),'no warning for a Muse relay that does not switch the contributor tier off');
      sameBytes(path.join(own,'SKILL.md'),skill,'person\'s SKILL.md'); sameBytes(path.join(own,'scripts/relay.mjs'),relay,'person\'s relay.mjs');
    },{tools:{muse:'99.0.0'}}),
    test(62,'a Muse relay installed by the person that only mentions the flag: kept, not called protected',ctx=>{
      freshAgentHome(ctx.home);
      const f=path.join(ctx.home,'.config/muse/settings.json'); fs.mkdirSync(path.dirname(f),{recursive:true});
      fs.writeFileSync(f,'{"schema_version":1,"contributor_mode_enabled":true}\n');
      const own=path.join(ctx.home,'.claude/skills/muse-delegate'); fs.mkdirSync(path.join(own,'scripts'),{recursive:true});
      const relay=Buffer.from('// my own relay; one day it should pass "--contributor-mode", "off" like the packet\'s\n');
      fs.writeFileSync(path.join(own,'SKILL.md'),'---\nname: muse-delegate\n---\nmine\n'); fs.writeFileSync(path.join(own,'scripts/relay.mjs'),relay);
      const r=installCase(ctx);
      demand(/KEEP \(installed by you; not replaced\)/.test(r.stdout),'the person\'s relay folder was not kept');
      demand(r.stdout.includes(UNCONFIRMED),'no "cannot confirm" warning for a relay that only mentions the flag');
      demand(!r.stdout.includes('switches it off for every job it runs'),'a relay that only mentions the flag was called protected');
      demand(!r.stdout.includes(UNGUARDED),'a relay that mentions the flag was reported as having none');
      sameBytes(path.join(own,'scripts/relay.mjs'),relay,'person\'s relay.mjs');
    },{tools:{muse:'99.0.0'}}),
    test(63,'Muse older than 1.4.15 is warned about; this user\'s Muse setting is read under XDG_CONFIG_HOME',ctx=>{
      freshAgentHome(ctx.home);
      const xdg=path.join(ctx.home,'xdg-config'), f=path.join(xdg,'muse/settings.json'); fs.mkdirSync(path.dirname(f),{recursive:true});
      const original=Buffer.from('{"schema_version":1,"contributor_mode_enabled":true}\n'); fs.writeFileSync(f,original);
      const env={...ctx.env,HOME:ctx.home,USERPROFILE:ctx.home,XDG_CONFIG_HOME:ctx.type==='sh'?unixPath(xdg):xdg};
      const r=installCase(ctx,[],{env});
      demand(r.stdout.includes('WARNING: Muse contributor mode is ON'),'the Muse setting under XDG_CONFIG_HOME was not read');
      demand(/Muse 1\.4\.14 is older than 1\.4\.15/.test(r.stdout),'no warning for a Muse older than 1.4.15');
      sameBytes(f,original,'Muse settings under XDG_CONFIG_HOME');
      const plain=installCase(ctx); demand(!plain.stdout.includes('Muse contributor mode is ON'),'a setting under XDG_CONFIG_HOME was read without XDG_CONFIG_HOME set');
    },{tools:{muse:'1.4.14'}}),
  ];
}

// ─── main runner ───────────────────────────────────────────────────────────────


function hostModeScenarios() {
  const common = { wantNode: true, tools: { claude: '2.1.280' } };
  const expectMode = (home, out, mode) => {
    const error = checkMode(mode)(home, out);
    demand(!error, error);
  };
  return [
    { ...common, n:71, title:'fresh server mode', args:['--mode', 'server'],
      check:seq(exit0, checkMode('server')) },
    { ...common, n:72, title:'remember server mode and switch to desktop', exercise:ctx => {
      installCase(ctx, ['--mode', 'server']);
      expectMode(ctx.home, installCase(ctx).stdout, 'server');

      const before = snapshotTree(ctx.home);
      const dryRun = installCase(ctx, ['--dry-run', '--mode=desktop']);
      demand(dryRun.stdout.split(/\r?\n/).includes('Mode: desktop'), 'dry-run plan is missing desktop mode');
      equalTree(before, ctx.home, 'dry-run mode switch');

      const noNode = buildEnv(ctx.fakeDir, false);
      assertNoNode(noNode, ctx.bash);
      const marks = readRequired(localp(ctx.home));
      expectMode(ctx.home, installCase(ctx, ['--mode', 'desktop'], { env:noNode }).stdout, 'desktop');
      const updated = readRequired(localp(ctx.home));
      demand(updated.hostMode === 'desktop' && JSON.stringify(updated.seats) === JSON.stringify(marks.seats),
        'switch without Node did not keep seat marks');
    } },
    { ...common, n:73, title:'invalid host mode makes no changes', exercise:ctx => {
      const before = snapshotTree(ctx.home);
      for (const args of [['--mode', 'bogus'], ['--mode=SERVER'], ['--mode='], ['--mode']]) {
        const refused = installCase(ctx, args, { status:1 });
        demand(refused.stdout.includes('Invalid --mode value:') && refused.stdout.includes('(expected desktop or server)'),
          'bad mode diagnostic missing');
        equalTree(before, ctx.home, 'invalid host mode');
      }
    } },
    { ...common, n:74, title:'fresh server mode without Node', wantNode:false, args:['--mode=server'],
      check:seq(exit0, checkMode('server'), h => chk(tryJson(localp(h))?.disabled === 'needs Node 18+', 'local.json must disable consensus without Node')) },
    { ...common, n:75, title:'fresh server mode when the machine check fails', args:['--mode=server'],
      extraEnv:{ TEAM_SETUP_FAIL:'1' }, check:seq(exit0, checkMode('server'),
        h => chk(tryJson(localp(h))?.disabled?.startsWith('machine check failed:'), 'local.json must disable consensus after a failed check')) },
  ];
}

function folderScenarios() {
  const common={wantNode:true,tools:{claude:'99.0.0',codex:'99.0.0'},cursorCfg:{models:[],fail:false},codexCache:makeCodexCache()};
  const test=(n,title,exercise)=>({...common,n,title,exercise,...(n===70?{codexCache:makeCodexCache(['gpt-6.1-sol'])}:{})});
  const mkdir=(...parts)=>{const d=path.join(...parts);fs.mkdirSync(d,{recursive:true});return d;};
  const repo=(parent)=>{const d=mkdir(parent,'SecondBrain');mkdir(d,'.git');fs.writeFileSync(path.join(d,'.git/config'),'[remote "origin"]\nurl = https://example.test/SecondBrain.git\n');return d;};
  const locations=ctx=>{const base=mkdir(ctx.home,'Documents','GitHub');return {credentials:mkdir(base,'credentials'),knowledge:repo(base)};};
  const check=(h,folders,source)=>{
    const receipt=readRequired(receiptp(h));
    for(const kind of ['credentials','knowledge']) {
      demand(receipt.folders[kind].path===folders[kind],`${kind}: receipt path differs`);
      demand(receipt.folders[kind].source===source,`${kind}: receipt source differs`);
      for(const f of [claudep(h),codexAgentsp(h)]) demand((tryRead(f)||'').includes(folders[kind].replace(/\\/g,'/')),`${kind}: missing in ${f}`);
      demand((tryRead(teamp(h))||'').includes(folders[kind]),`${kind}: missing in profile`);
    }
  };
  return [
    test(64,'folders found in home, both entry sections, profile, receipt and unchanged repeat',ctx=>{
      const folders=locations(ctx); installCase(ctx);check(ctx.home,folders,'found');
      const before=[claudep(ctx.home),codexAgentsp(ctx.home),teamp(ctx.home)].map(f=>fs.readFileSync(f));
      const again=installCase(ctx);check(ctx.home,folders,'kept');
      demand(!planHas(again.stdout,['CREATE','UPDATE','REMOVE']),'repeat changed a target');
      [claudep(ctx.home),codexAgentsp(ctx.home),teamp(ctx.home)].forEach((f,i)=>sameBytes(f,before[i],'unchanged folders repeat'));
    }),
    test(65,'missing folders with --yes do not prompt and explain how to remember them',ctx=>{
      const r=installCase(ctx);const receipt=readRequired(receiptp(ctx.home));
      demand(receipt.folders.credentials===null && receipt.folders.knowledge===null,'missing folders recorded as set');
      for(const f of [claudep(ctx.home),codexAgentsp(ctx.home)]) {
        const t=tryRead(f)||'';demand(t.includes('Credentials folder: not set. Ask the person once where it is'),'unset credentials instruction missing');
        demand(t.includes('Knowledge base (the SecondBrain repository): not set.'),'unset knowledge instruction missing');
      }
      demand(!r.stdout.includes('Type a number'),'--yes prompted');
      demand(ctx.env.TEAM_FOLDER_ROOTS==='none','fixture extra-root isolation is not explicit');
      demand(!r.stdout.includes('The folder search stopped early'),'fixture searched outside its bounded fake home');
      const summaries=r.stdout.split(/\r?\n/).map(l=>l.trim()).filter(l=>/^(Credentials folder|Knowledge base):/.test(l));
      demand(summaries.length>=2 && summaries.every(l=>/^(Credentials folder|Knowledge base): not set$/.test(l)),
        'fixture found a candidate outside the fake home: '+summaries.join(' | '));
    }),
    test(66,'folder flags set, then kept; missing flag advises and stays unset',ctx=>{
      const folders={credentials:mkdir(ctx.home,"my accounts O'Brien & Partners"),knowledge:mkdir(ctx.home,'my knowledge')};
      const flagArgs=['--credentials',folders.credentials+(ctx.type==='ps'?path.sep:''),'--knowledge',folders.knowledge+(ctx.type==='ps'?path.sep:'')];
      installCase(ctx,flagArgs);check(ctx.home,folders,'set');
      installCase(ctx);check(ctx.home,folders,'kept');
      const missing=path.join(ctx.home,'gone'),r=installCase(ctx,['--credentials',missing]);
      demand(r.stdout.includes(`The folder given with --credentials does not exist: ${missing}.`),'missing flag advice absent');
      demand(readRequired(receiptp(ctx.home)).folders.credentials===null,'missing flag used');
      // Node-free fallback must render the same section and preserve values on another run.
      installCase(ctx,['--credentials',folders.credentials]);
      const section=(tryRead(claudep(ctx.home))||'').split('Your folders (')[1];
      fs.writeFileSync(folders.knowledge+'.exe','This executable sibling is not the folder.\n');
      switchAgents(ctx,{claude:'99.0.0',codex:'99.0.0'},false);
      installCase(ctx,flagArgs);check(ctx.home,folders,'set');
      demand((tryRead(claudep(ctx.home))||'').split('Your folders (')[1]===section,'Node-free section differs');
      installCase(ctx);check(ctx.home,folders,'kept');
    }),
    test(67,'home wins over Other computers; weak credentials are only offered',ctx=>{
      const home=repo(mkdir(ctx.home,'Documents','GitHub')),extra=makeTmp('fixt-folders-cloud-');
      const other=repo(mkdir(extra,'Other computers','PC')),weak=mkdir(ctx.home,'personal creds');
      const env={...ctx.env,TEAM_FOLDER_ROOTS:extra};
      const r=installCase(ctx,[],{env}),receipt=readRequired(receiptp(ctx.home));
      demand(receipt.folders.knowledge.path===home,'Other computers won ranking');
      demand(receipt.folders.credentials===null,'weak credentials chosen automatically');
      demand(r.stdout.includes(other) && r.stdout.includes(weak),'summary lacks alternatives');
    }),
    test(68,'deleted remembered folder is searched again and advises',ctx=>{
      const folders=locations(ctx);installCase(ctx);fs.rmSync(folders.credentials,{recursive:true});
      const replacement=mkdir(ctx.home,'credentials'),r=installCase(ctx);
      demand(readRequired(receiptp(ctx.home)).folders.credentials.path===replacement,'remembered folder was not rediscovered');
      demand(r.stdout.includes(`The remembered credentials folder ${folders.credentials} no longer exists; searched again.`),'remembered missing advice absent');
    }),
    test(70,'GPT-6.1 reserve supplies both lane fallbacks and a standard-grade reviewer',ctx=>{
      const r=installCase(ctx), receipt=readRequired(receiptp(ctx.home));
      const lanes=readRequired(lanep(ctx.home)).lanes;
      for(const name of ['codex-review','codex-implement']) {
        demand(lanes[name].model==='gpt-6.1-sol' && lanes[name].effort==='high',`${name}: wrong fallback`);
        demand((tryRead(teamp(ctx.home))||'').includes(`${name}: gpt-6.1-sol at high (fallback:`),`${name}: no fallback marker`);
      }
      demand(receipt.consensus.grade==='standard','reserve changed consensus grade');
      demand(receipt.consensus.pair.includes('gpt-6.1-sol') && !receipt.consensus.pair.includes('gpt-6.2-sol'),'reserve not selected');
      demand(r.stdout.includes('claude-opus-5.5 + gpt-6.1-sol'),'summary does not name reserve');
    }),
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  STRICT = args.strict;
  if (!args.packet) {
    process.stderr.write('Usage: node fixtures.mjs --packet <staged-packet> [--previous <zip>] [--only ps|sh] [--scenario <n>[,<n>...]] [--keep]\n');
    process.exit(1);
  }
  const packetDir = path.resolve(args.packet);
  if (!isDir(packetDir)) { process.stderr.write(`packet dir not found: ${packetDir}\n`); process.exit(1); }

  const bash = findBash();
  if (IS_WIN && !bash && !args.shard) process.stdout.write('Note: bash.exe not found; sh scenarios skipped\n');

  ensureHelper();

  const scens = [...scenarios(), ...ladderScenarios(), ...agentScenarios(), ...folderScenarios(), ...hostModeScenarios()];
  const filter = args.scenarios;
  if (filter?.some(n => !scens.some(s => s.n === n))) throw new Error('unknown scenario number in --scenario');
  const onlyType = args.only;
  const typesFor = () => {
    const types = [];
    if (IS_WIN) {
      if (!onlyType || onlyType === 'ps') types.push('ps');
      if (!onlyType || onlyType === 'sh') types.push('sh');
    } else {
      if (!onlyType || onlyType === 'sh') types.push('sh');
      if (onlyType === 'ps') types.push('ps');
    }
    return types;
  };

  // Every (scenario, installer) pair, bash ones first so each shard gets a share of the slow ones.
  const items = [];
  for (const scen of scens) if (!filter || filter.includes(scen.n)) for (const t of typesFor()) items.push(`${scen.n}:${t}`);
  const ordered = [...items.filter(x => x.endsWith(':sh')), ...items.filter(x => !x.endsWith(':sh'))];

  if (args.jobs > 1 && !args.shard) {
    const { spawn } = await import('node:child_process');
    const argv = process.argv.slice(2);
    const base = argv.filter((x, i) => x !== '--jobs' && argv[i - 1] !== '--jobs');
    const results = await Promise.all(Array.from({ length: args.jobs }, (_, k) => new Promise(resolve => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...base, '--shard', `${k}/${args.jobs}`],
        { windowsHide: true });
      let out = '', pending = '';
      const collect = d => {
        out += d; pending += d;
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0,end).replace(/\r$/,''); pending = pending.slice(end+1);
          if (/^(PASS|FAIL|SKIP) /.test(line)) process.stdout.write(`${line}\n`);
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('close', code => resolve({ code, out }));
    })));
    const order = l => { const m = l.match(/^(?:PASS|FAIL|SKIP) (\d+) ?(ps|sh)?/); return m ? Number(m[1]) * 10 + (m[2] === 'sh' ? 1 : 0) : 0; };
    const lines = results.flatMap(r => r.out.split(/\r?\n/)).filter(l => /^(PASS|FAIL|SKIP) /.test(l)).sort((a, b) => order(a) - order(b));
    let passed = 0, failed = 0, skipped = 0;
    for (const l of lines) { if (l.startsWith('PASS ')) passed++; else if (l.startsWith('FAIL ')) failed++; else skipped++; }
    const inventory = results.flatMap(r => r.out.split(/\r?\n/)).filter(l => l.startsWith('INVENTORY '));
    for (const l of inventory.sort((a,b) => Number(a.split(' ')[1])-Number(b.split(' ')[1]) || a.localeCompare(b))) process.stdout.write(`${l}\n`);
    for (const r of results) {
      if (r.code !== 0 && !/^FAIL /m.test(r.out)) { failed++; process.stdout.write(`FAIL shard exited ${r.code}:\n${r.out.slice(-1500)}\n`); }
    }
    process.stdout.write(`\nTotal: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
    process.exit(failed > 0 ? 1 : 0);
  }
  const mine = args.shard ? new Set(ordered.filter((_, i) => i % args.shard.n === args.shard.k)) : null;

  let passed = 0, failed = 0, skipped = 0;

  for (const scen of scens) {
    if (filter && !filter.includes(scen.n)) continue;

    for (const type of typesFor()) {
      if (mine && !mine.has(`${scen.n}:${type}`)) continue;
      if ((type === 'sh' && !bash) || (type === 'ps' && !IS_WIN)) {
        const status = report('SKIP',scen.n,type,scen.title,type === 'sh' ? 'Git Bash missing' : 'PowerShell unavailable on this host');
        if (status === 'FAIL') failed++; else skipped++;
        continue;
      }
      const home = makeTmp(`fixt-${scen.n}-${type}-h-`);
      const fakeDir = makeTmp(`fixt-${scen.n}-${type}-f-`);
      let pkt = packetDir;

      try {
        // Optionally copy packet for mutation scenarios
        if (scen.useCopy || scen.mutatePkt) {
          pkt = makeTmp('fixt-p-');
          copyDir(packetDir, pkt);
          if (scen.mutatePkt) scen.mutatePkt(pkt, home);
        }

        // Handle upgrade scenario
        if (scen.isUpgrade) {
          if (!args.previous || !fs.existsSync(args.previous)) {
            throw new ScenarioSkip('no previous packet');
          }
          const prevDir = makeTmp('fixt-prev-');
          extractPrevious(args.previous, prevDir);
          const sub = fs.readdirSync(prevDir);
          const prevPkt = sub.length === 1 ? path.join(prevDir,sub[0]) : prevDir;
          try { PREV_VERSION = fs.readFileSync(path.join(prevPkt,'VERSION'),'utf8').trim() || null; } catch { PREV_VERSION = null; }
          setupHome(home);
          // Build env early for the pre-install
          createFakeTools(fakeDir, scen.tools, scen.cursorCfg||{models:[],fail:false}, scen.wantNode!==false);
          const preEnv = buildEnv(fakeDir, scen.wantNode!==false, scen.extraEnv||{});
          mustInstall(type, prevPkt, home, [], preEnv, bash);
          // receiptFiles maps the receipt's keys to this machine's paths: the sh receipt on Windows
          // holds Git Bash paths (/tmp/..., /c/...) that Node cannot open as they are.
          const ownedFiles = receiptFiles(home).map(f => f.file).filter(isFile);
          if (!ownedFiles.length) throw new Error('the previous install lists no file the harness can edit before the upgrade');
          fs.appendFileSync(ownedFiles[0], '\n<!-- hand change -->');
        }

        createFakeTools(fakeDir, scen.tools, scen.cursorCfg||{models:[],fail:false}, scen.wantNode!==false);
        if (scen.codexCache) writeCodexCache(home, scen.codexCache);

        const env = buildEnv(fakeDir, scen.wantNode!==false, scen.extraEnv||{});
        if (scen.wantNode === false) assertNoNode(env, bash);

        // Build ctx (shared across prepare + check)
        const ctx = {
          home, pkt, fakeDir, type, bash, env, n:scen.n, previous:args.previous,
          run: (extraArgs) => { const r = runInstaller(type, pkt, home, extraArgs, env, bash); ctx.lastOut = r.stdout; return r; },
          snapBefore: null,
          lastOut: '',
        };
        if (scen.exercise) {
          setupHome(home);
          scen.exercise(ctx);
          report('PASS',scen.n,type,scen.title); passed++;
          continue;
        }

        // Prepare: setup home and any pre-state
        if (scen.prepare) scen.prepare(home, pkt, type, bash, env, packetDir, null);

        // Snapshot before main run (for scenario 24)
        if (scen._snapBefore) ctx.snapBefore = snapFiles(home);

        // Main install run
        const instArgs = [...(scen.args||[])];
        const out = runInstaller(type, pkt, home, instArgs, env, bash);
        ctx.lastOut = out.stdout;

        // Primary check
        let failReason = null;
        if (scen.check) failReason = scen.check(home, out.stdout, out.status, ctx);

        // Sub-check (scenario 18, 25)
        if (!failReason && scen.subCheck)
          failReason = scen.subCheck(home, out.stdout, out.status, ctx);

        // Doctor equivalence (spec section 5): whenever the runtime is left installed, the installed
        // referee's best pair and grade must equal the last install run's consensus line, or, when a
        // degraded run printed none, the receipt's record of the setup that is installed.
        if (!failReason && out.status === 0 && isFile(path.join(consensusd(home),'referee.mjs'))) {
          let exp = null;
          if (scen.doctor) exp = typeof scen.doctor === 'function' ? scen.doctor(ctx.lastOut) : scen.doctor;
          if (!exp) exp = parseGP(parseConsensus(ctx.lastOut));
          if (!exp) { const rc = tryJson(receiptp(home))?.consensus; if (rc && rc.grade) exp = { grade: rc.grade, pair: rc.pair || [] }; }
          if (!exp) failReason = 'doctor: no consensus line or receipt record to compare with';
          else { const dr = doctorCheck(home, exp.grade, exp.pair||[], env); if (dr) failReason = `doctor: ${dr}`; }
        }

        if (failReason) {
          report('FAIL',scen.n,type,scen.title,failReason);
          failed++;
        } else {
          report('PASS',scen.n,type,scen.title);
          passed++;
        }
      } catch (err) {
        const status = report(err instanceof ScenarioSkip ? 'SKIP' : 'FAIL',scen.n,type,scen.title,err.message);
        if (status === 'SKIP') skipped++; else failed++;
      } finally {
        if (!args.keep) { cleanTmp(home); cleanTmp(fakeDir); if (pkt !== packetDir) cleanTmp(pkt); }
        else process.stdout.write(`  kept home: ${home}\n`);
      }
    }
  }

  if (!args.keep) for (const d of _keep) cleanTmp(d);
  printInventory();
  const totals = status => INVENTORY.filter(r=>r.status===status).length;
  process.stdout.write(`\nTotal: ${totals('PASS')} passed, ${totals('FAIL')} failed, ${totals('SKIP')} skipped\n`);
  process.exit(totals('FAIL') > 0 ? 1 : 0);
}

main().catch(err => { process.stderr.write(`${err.stack||err}\n`); process.exit(1); });
