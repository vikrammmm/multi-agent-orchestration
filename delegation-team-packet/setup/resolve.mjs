#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--packet', '--home', '--settings', '--out', '--repos'].includes(argv[i]) || !argv[i + 1]) {
      throw new Error('expected --packet <dir> --home <dir> --settings <file> --out <dir> [--repos <dir>]');
    }
    result[argv[i].slice(2)] = argv[i + 1];
  }
  for (const name of ['packet', 'home', 'settings', 'out']) {
    if (!result[name]) throw new Error('expected --packet, --home, --settings and --out');
  }
  return result;
}

// The first Claude Code build that knows Claude Haiku 5.5 (the haiku-helper's model): 2.1.289 refuses
// claude-haiku-5-5, 2.1.293 runs it.
const HAIKU_HELPER_MIN_CLAUDE = '2.1.293';
// The first Claude Code build that knows Claude Sonnet 5.5 (the Sonnet helpers' model).
const SONNET55_HELPERS_MIN_CLAUDE = '2.1.284';

function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function line(text) { return `${text}\n`; }
function display(candidate) { return candidate.effort ? `${candidate.model} at ${candidate.effort}` : candidate.model; }
function receiptDisplay(candidate) { return candidate.effort ? `${candidate.model} ${candidate.effort}` : candidate.model; }
function winQuote(value) { return `"${String(value).replace(/"/g, '\\"')}"`; }

function cursorModels(launcher) {
  const opts = { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
  const windowsScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(launcher);
  const result = windowsScript
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${winQuote(launcher)} models"`],
      { ...opts, windowsVerbatimArguments: true })
    : spawnSync(launcher, ['models'], opts);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.replace(/[\u200B\u200C\u200D\uFEFF]/g, '');
  const lines = output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const reason = (lines[0] || 'no output').slice(0, 120);
  if (result.status !== 0 || result.error) return { known: false, reason };
  const models = new Set();
  for (const entry of lines) {
    if (/^Tip:/i.test(entry)) continue;
    const match = entry.match(/^([^\s]+)\s+-\s+.+$/);
    if (match) models.add(match[1]);
  }
  return models.size ? { known: true, models } : { known: false, reason };
}

function codexModels(file) {
  try {
    const data = json(file);
    if (!Array.isArray(data.models)) throw new Error('invalid model list');
    const offered = new Set();
    for (const model of data.models) {
      if (model.visibility !== 'list' || !Array.isArray(model.supported_reasoning_levels)) continue;
      for (const level of model.supported_reasoning_levels) {
        if (level.effort) offered.add(`${model.slug}\u0000${level.effort}`);
      }
    }
    return { known: true, offered, date: data.fetched_at || 'unknown date' };
  } catch {
    return { known: false, reason: 'Codex has no model list yet' };
  }
}

function settingsUnavailable(file) {
  try {
    const list = json(file).unavailable;
    return new Set(Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []);
  } catch { return new Set(); }
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const firstVersion = (text) => (String(text || '').match(/\d+\.\d+(?:\.\d+)?/) || [''])[0];

// A command on PATH (with PATHEXT on Windows), or ''.
function findOnPath(name) {
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase());
      if (isFile(file) && (process.platform === 'win32' ? ext !== '' : true)) return file;
    }
  }
  return '';
}

// The first line of `<file> --version`, or '' (8-second limit, like the installers).
function versionOf(file) {
  const opts = { encoding: 'utf8', timeout: 8_000, windowsHide: true };
  const script = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  const r = script
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${winQuote(file)} --version"`], { ...opts, windowsVerbatimArguments: true })
    : spawnSync(file, ['--version'], opts);
  return `${r.stdout || ''}\n${r.stderr || ''}`.split(/\r?\n/).map((s) => s.trim()).find((s) => firstVersion(s)) || '';
}

// Other command-line tools worth knowing about; listed in the profile, no relay for them.
const OTHER_TOOLS = [['git', 'git'], ['gh', 'GitHub CLI'], ['gemini', 'Gemini CLI'], ['qwen', 'Qwen Code'], ['aider', 'Aider']];
function otherTools() {
  const found = [];
  for (const [command, label] of OTHER_TOOLS) {
    const file = findOnPath(command);
    if (file) found.push({ command, label, version: firstVersion(versionOf(file)) || 'version unknown' });
  }
  return found;
}

// Where the person keeps their repositories: an explicit folder, else the usual place that holds
// the most git repositories (one or two levels down).
function countRepos(dir) {
  let count = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).slice(0, 400); } catch { return 0; }
  for (const entry of entries) {
    const sub = path.join(dir, entry.name);
    if (fs.existsSync(path.join(sub, '.git'))) { count++; continue; }
    let inner = [];
    try { inner = fs.readdirSync(sub, { withFileTypes: true }).filter((e) => e.isDirectory()).slice(0, 100); } catch { continue; }
    for (const e of inner) if (fs.existsSync(path.join(sub, e.name, '.git'))) count++;
  }
  return count;
}
function detectRepos(home, explicit) {
  if (explicit) return isDir(explicit) ? { path: path.resolve(explicit), count: countRepos(explicit), source: 'set' } : null;
  const rel = ['Documents/GitHub', 'GitHub', 'source/repos', 'repos', 'src', 'code', 'Code', 'projects', 'Projects',
    'dev', 'Developer', 'workspace', 'git'];
  let homeEntries = [];
  try { homeEntries = fs.readdirSync(home).filter((n) => /^OneDrive/i.test(n)); } catch { homeEntries = []; }
  const candidates = [...rel, ...homeEntries.map((n) => `${n}/Documents/GitHub`)].map((r) => path.join(home, r));
  let best = null;
  for (const dir of candidates) {
    if (!isDir(dir)) continue;
    const count = countRepos(dir);
    if (count > 0 && (!best || count > best.count)) best = { path: dir, count, source: 'found' };
  }
  return best;
}

// A Claude Code engine that the desktop app carries (Windows: %APPDATA%\Claude\claude-code\<version>\;
// macOS, not verified: ~/Library/Application Support/Claude/claude-code/<version>/). The newest one.
function desktopClaude(home) {
  const root = process.env.TEAM_DESKTOP_CLAUDE_ROOT
    || (process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude-code')
      : path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code'));
  let best = null;
  let names = [];
  try { names = fs.readdirSync(root); } catch { return null; }
  for (const name of names) {
    if (!/^\d+\.\d+\.\d+$/.test(name)) continue;
    const file = ['claude.exe', 'claude.cmd', 'claude'].map((n) => path.join(root, name, n)).find(isFile);
    if (!file) continue;
    const version = firstVersion(versionOf(file));
    if (!version) continue;
    const key = version.split('.').map((n) => Number(n).toString().padStart(6, '0')).join('.');
    if (!best || key > best.key) best = { file, version, key };
  }
  return best;
}

async function main() {
  // Test hook: "1" fails plainly; any other value fails with that text in the message.
  const failHook = process.env.TEAM_SETUP_FAIL;
  if (failHook) throw new Error(failHook === '1' ? 'test hook' : `test hook: ${failHook}`);
  const args = options(process.argv.slice(2));
  const packet = path.resolve(args.packet);
  const table = json(path.join(packet, 'consensus/seats.json'));
  const laneFile = json(path.join(packet, 'claude/delegate-lanes.json'));
  const fallbackFile = json(path.join(packet, 'claude/lane-fallbacks.json'));
  const { seatEligibility, pickPair, gradeOf, versionAtLeast } = await import(
    pathToFileURL(path.join(packet, 'consensus/lib/select.mjs')).href);
  const unavailable = settingsUnavailable(args.settings);
  const found = {
    codex: Boolean(process.env.TEAM_CODEX), cursor: Boolean(process.env.TEAM_CURSOR),
    muse: Boolean(process.env.TEAM_MUSE), claude: Boolean(process.env.TEAM_CLAUDE),
  };
  const codex = found.codex ? codexModels(path.join(process.env.CODEX_HOME || path.join(args.home, '.codex'), 'models_cache.json')) : null;
  const cursor = found.cursor ? cursorModels(process.env.TEAM_CURSOR) : null;
  const tools = {
    'claude-code': { found: found.claude, version: process.env.TEAM_CLAUDE_VERSION || null },
    codex: { found: found.codex, version: process.env.TEAM_CODEX_VERSION || null },
    cursor: { found: found.cursor, version: process.env.TEAM_CURSOR_VERSION || null },
  };

  // A newer Claude Code inside the desktop app serves the reviewers when the command line is older.
  const pathClaude = process.env.TEAM_CLAUDE_VERSION || '';
  const desktop = found.claude ? desktopClaude(args.home) : null;
  let claudeVersion = pathClaude;
  let desktopNote = '';
  if (desktop && (!pathClaude || (versionAtLeast(desktop.version, pathClaude) === true && desktop.version !== pathClaude))) {
    claudeVersion = desktop.version;
    tools['claude-code'].version = desktop.version;
    desktopNote = `The reviewers use the desktop app's Claude Code ${desktop.version} (${desktop.file}) because the command line has ${pathClaude || 'an unreadable version'}; after you update it (claude update), run this installer again.`;
  }
  const repos = detectRepos(args.home, args.repos);
  const extras = otherTools();

  const local = { seats: {} };
  if (desktopNote) local.binaries = { claude: desktop.file };
  for (const [id, seat] of Object.entries(table.seats)) {
    const model = seat.model;
    if (seat.route === 'claude-code' && !found.claude) {
      local.seats[id] = { unavailable: 'Claude Code not found' };
    } else if (unavailable.has(model)) {
      local.seats[id] = { unavailable: `${model} is declared unavailable (installer --unavailable)` };
    } else if (seat.route === 'claude-code') {
      local.seats[id] = { unverified: `Claude plan access to ${model} is not verified` };
    } else if (seat.route === 'codex' && found.codex) {
      if (!codex.known) local.seats[id] = { unverified: `Codex model list unknown: ${codex.reason}` };
      else if (!codex.offered.has(`${model}\u0000${seat.effort}`)) {
        local.seats[id] = { unavailable: `${model} at ${seat.effort} is not offered by this Codex (model list of ${codex.date})` };
      }
    } else if (seat.route === 'cursor' && found.cursor) {
      if (!cursor.known) local.seats[id] = { unverified: `Cursor model list unknown: ${cursor.reason}` };
      else if (!cursor.models.has(model)) local.seats[id] = { unavailable: `${model} is not offered by this Cursor account` };
    }
  }

  const selectedLanes = {};
  const laneMessages = [];
  const exceptionalLanes = [];
  let fallbackCount = 0, unverifiedCount = 0, leftOutCount = 0;
  let grokFellBack = false;
  const laneNamesByTool = { codex: [], cursor: [], muse: [] };
  for (const [name, lane] of Object.entries(laneFile.lanes)) {
    const impl = lane.implementer;
    if (!found[impl]) continue;
    const candidates = [{ model: lane.model, ...(lane.effort ? { effort: lane.effort } : {}) }, ...(fallbackFile.lanes[name] || [])];
    const list = impl === 'codex' ? codex : impl === 'cursor' ? cursor : { known: true };
    const offered = (candidate) => {
      if (unavailable.has(candidate.model)) return false;
      if (!list.known) return true;
      if (impl === 'codex') return codex.offered.has(`${candidate.model}\u0000${candidate.effort || ''}`);
      if (impl === 'cursor') return cursor.models.has(candidate.model);
      return candidate.model === 'muse-spark-1.3';
    };
    const choiceIndex = candidates.findIndex(offered);
    let message;
    if (choiceIndex < 0) {
      leftOutCount++;
      message = `${name}: left out (none of ${candidates.map(display).join(', ')} is offered here)`;
    } else {
      const choice = candidates[choiceIndex];
      const updated = { ...lane, model: choice.model };
      if (choice.effort) updated.effort = choice.effort;
      else delete updated.effort;
      selectedLanes[name] = updated;
      laneNamesByTool[impl].push(name);
      message = `${name}: ${display(choice)}`;
      if (choiceIndex > 0) {
        fallbackCount++;
        const first = candidates[0];
        const why = unavailable.has(first.model) ? `${first.model} is declared unavailable` : `${display(first)} is not offered here`;
        message += ` (fallback: ${why})`;
        if (impl === 'cursor' && first.model === 'grok-4.7-xhigh-fast' && !unavailable.has(first.model)) grokFellBack = true;
      }
      // Independent of the fallback: a choice from an unknown list is not verified either way.
      if (!list.known) {
        unverifiedCount++;
        message += ` (not verified: ${list.reason})`;
      }
    }
    laneMessages.push(`- ${message}`);
    if (choiceIndex < 0 || choiceIndex > 0 || !list.known) exceptionalLanes.push(message);
  }

  const facts = { tools, local };
  const usable = new Set(Object.keys(table.seats).filter((id) => seatEligibility(table, id, facts).usable));
  const chosen = pickPair(table, (id) => usable.has(id));
  const pair = chosen.length === 2 ? chosen : [];
  const grade = pair.length ? gradeOf(pair.map((id) => ({ id, ...table.seats[id] }))) : { level: 'off', note: '' };
  const first = grade.level === 'standard' ? `on, standard grade (best pair: ${pair.join(' + ')})`
    : grade.level === 'single-vendor' ? `on, lower grade: single vendor (${pair.join(' + ')})`
      : grade.level === 'below-cto' ? `on, lower grade: below CTO level (${pair.join(' + ')})`
        : 'off: fewer than two different models are usable here';
  const notVerified = pair.filter((id) => local.seats[id]?.unverified)
    .map((id) => `Not verified here: ${id} (${local.seats[id].unverified})`);
  const advice = [];
  if (desktopNote) advice.push(desktopNote);
  if (args.repos && !repos) advice.push(`The folder given with --repos does not exist: ${args.repos}.`);
  if (found.claude && claudeVersion) {
    if (versionAtLeast(claudeVersion, table.routes['claude-code'].minVersion) === false) {
      advice.push(`Update Claude Code to 2.1.248 or newer to use the Claude reviewers (found ${claudeVersion}).`);
    } else if (versionAtLeast(claudeVersion, table.seats['claude-opus-5.5'].minVersion) === false) {
      advice.push(`Update Claude Code to 2.1.280 or newer to enable the Opus 5.5 reviewer (found ${claudeVersion}).`);
    }
    if (versionAtLeast(claudeVersion, SONNET55_HELPERS_MIN_CLAUDE) === false) {
      advice.push(`Update Claude Code to 2.1.284 or newer to get the Sonnet 5.5 helpers (found ${claudeVersion}); until then the Sonnet helpers run Claude Sonnet 4.6.`);
    }
    if (versionAtLeast(claudeVersion, HAIKU_HELPER_MIN_CLAUDE) === false) {
      advice.push(`Update Claude Code to ${HAIKU_HELPER_MIN_CLAUDE} or newer to use the Haiku helper (found ${claudeVersion}); until then use the Sonnet helpers.`);
    }
  }
  if (found.codex && !codex.known) advice.push('Open Codex once so it downloads its model list, then run this installer again.');
  if (found.codex && codex.known) {
    const desired = [...Object.values(laneFile.lanes).filter((lane) => lane.implementer === 'codex').map((lane) => lane.model),
      ...Object.values(table.seats).filter((seat) => seat.route === 'codex').map((seat) => seat.model)];
    const missing = [...new Set(desired.filter((model) => /^gpt-6(\.\d+)?-/.test(model)
      && ![...codex.offered].some((pairKey) => pairKey.startsWith(`${model}\u0000`))))];
    if (missing.length) advice.push(`Your Codex does not offer ${missing.join(', ')} yet: update Codex or check your ChatGPT plan, then run this installer again.`);
  }
  if (found.cursor && !cursor.known) advice.push(`Log in to Cursor Agent (cursor-agent login), then run this installer again (${cursor.reason}).`);
  if (grokFellBack) advice.push('Your Cursor plan does not offer Grok 4.7; the Cursor lanes use Grok 4.6.');
  if (grade.level === 'single-vendor') advice.push('For a standard-grade review, add a second vendor: Codex with GPT-6.2 Sol or Cursor with Grok 4.7.');
  else if (grade.level === 'below-cto') advice.push('For CTO-level reviews you need Claude Opus 5.5 (Claude Code 2.1.280 or newer and a plan that includes it) or Opus 5, GPT-6.2 Sol (Codex) or Grok 4.7 (Cursor).');
  else if (grade.level === 'off') advice.push('Consensus needs two different models: install and log in to Codex or Cursor, or update Claude Code.');
  if (found.claude && !claudeVersion) advice.push("Claude Code's version could not be read; the Claude reviewers are assumed available.");
  const unverifiedClaude = pair.filter((id) => table.seats[id].route === 'claude-code' && local.seats[id]?.unverified)
    .map((id) => table.seats[id].model);
  if (unverifiedClaude.length) advice.push(`If your Claude plan does not include ${unverifiedClaude.join(', ')}, run this installer with --unavailable ${unverifiedClaude.join(',')} so the reviewers skip them.`);

  const haikuOk = !found.claude || !claudeVersion || versionAtLeast(claudeVersion, HAIKU_HELPER_MIN_CLAUDE) !== false;
  const sonnet55Ok = !found.claude || !claudeVersion || versionAtLeast(claudeVersion, SONNET55_HELPERS_MIN_CLAUDE) !== false;
  const routes = found.claude ? [haikuOk
    ? '- Haiku helper (haiku-helper, Claude Haiku 5.5): the first Claude helper to try'
    : `- Haiku helper (haiku-helper, Claude Haiku 5.5): needs Claude Code ${HAIKU_HELPER_MIN_CLAUDE} or newer (found ${claudeVersion}); use the Sonnet helpers until then`,
  sonnet55Ok
    ? '- Sonnet helpers (explore, researcher, implementer, verifier, Claude Sonnet 5.5): always available'
    : `- Sonnet helpers (explore, researcher, implementer, verifier): Claude Sonnet 4.6 here, because Claude Code ${claudeVersion} is older than 2.1.284; update Claude Code and run this installer again for Sonnet 5.5`] : [];
  for (const [impl, label] of Object.entries({ codex: 'Codex CLI via codex-delegate', cursor: 'Cursor Agent via cursor-delegate', muse: 'Muse Code via muse-delegate' })) {
    if (laneNamesByTool[impl].length) routes.push(`- ${label}: ${laneNamesByTool[impl].join(', ')}`);
  }
  const consensus = [first];
  if (pair.length && grade.level !== 'standard') consensus.push(grade.note);
  consensus.push(...notVerified, ...advice.map((item) => `- ${item}`));
  const summary = [`Lanes: ${Object.keys(selectedLanes).length} ready (${fallbackCount} on a fallback, ${unverifiedCount} not verified, ${leftOutCount} left out)`,
    ...exceptionalLanes, `Consensus: ${first}`, ...notVerified,
    `Repositories: ${repos ? `${repos.path} (${repos.count} git repositories)` : 'not found (set with --repos <folder>)'}`,
    `Other tools: ${extras.length ? extras.map((t) => `${t.label} ${t.version}`).join(', ') : 'none found'}`, ...advice];
  const reposText = repos
    ? `- Repositories: ${repos.path} (${repos.count} git repositories${repos.source === 'set' ? ', set with --repos' : ''})`
    : '- Repositories: not found; run this installer with --repos <folder> to set it';
  const toolsText = extras.length ? extras.map((t) => `- ${t.label}: ${t.version} (no relay; use it directly)`).join('\n')
    : '- none of git, GitHub CLI, Gemini CLI, Qwen Code or Aider was found';
  const receiptLanes = Object.fromEntries(Object.entries(selectedLanes).map(([name, lane]) => [name, receiptDisplay(lane)]));
  const sonnetHelpers = !found.claude ? 'none' : sonnet55Ok ? '5.5' : '4.6';
  const output = {
    'local.json': line(JSON.stringify(local, null, 2)),
    'routes.md': line(routes.join('\n')),
    'lanes.md': line(laneMessages.length ? laneMessages.join('\n') : '- none: no Codex, Cursor or Muse CLI was found'),
    'consensus.md': line(consensus.join('\n')),
    'summary.txt': line(summary.join('\n')),
    'repos.md': line(reposText),
    'tools.md': line(toolsText),
    'sonnet-helpers.txt': line(sonnetHelpers),
    'receipt.json': line(JSON.stringify({ consensus: { grade: grade.level, pair, reason: first }, lanes: receiptLanes,
      repos: repos ? { path: repos.path, count: repos.count } : null, sonnetHelpers })),
  };
  if (found.codex || found.cursor || found.muse) output['lanes.json'] = line(JSON.stringify({ version: 'delegate-fleet.v1', lanes: selectedLanes }, null, 2));
  fs.mkdirSync(args.out, { recursive: true });
  for (const [name, content] of Object.entries(output)) {
    if (name !== process.env.TEAM_SETUP_SKIP) fs.writeFileSync(path.join(args.out, name), content, 'utf8');
  }
  console.log(`RESOLVE OK ${Object.keys(selectedLanes).length} lanes, consensus ${grade.level}`);
}

main().catch((error) => {
  console.error(`RESOLVE FAILED: ${error.message}`);
  process.exitCode = 1;
});
