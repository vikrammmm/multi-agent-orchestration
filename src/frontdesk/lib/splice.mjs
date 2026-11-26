import { sameConfigFile as sameFile } from './samefile.mjs';
// Pure functions that add or remove the front desk's hook entries in each tool's own settings file. Nothing here touches the disk:
// text in, text out, so every behaviour is testable on fixtures. Our entries are recognised by the marker argument "--fd-guard" in the hook
// command; every other key and entry in the file is left exactly as it was.
export const MARKER = '--fd-guard';
const isOurs = (cmd) => typeof cmd === 'string' && cmd.includes(MARKER);

export function hookCommand(nodePath, scriptPath, tool) { return `${nodePath} ${scriptPath} ${tool} ${MARKER}`; }

// ---- Claude Code: ~/.claude/settings.json (JSON) ------------------------------------------------------------------------------
function indentOf(text) { const m = text.match(/^\{\r?\n(\s+)"/); return m ? m[1] : '  '; }
export function addClaude(text, command, { matcher = 'Agent|Workflow', timeout = 5 } = {}) {
  const j = text && text.trim() ? JSON.parse(text) : {};
  const indent = text && text.trim() ? indentOf(text) : '  ';
  const hooks = (j.hooks && typeof j.hooks === 'object') ? j.hooks : (j.hooks = {});
  const list = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : (hooks.PreToolUse = []);
  const kept = list.flatMap((g) => {
    const entries = Array.isArray(g.hooks) ? g.hooks : [];
    const ownFiltered = entries.filter((h) => !isOurs(h.command));
    if (ownFiltered.length === entries.length) return [g];
    return ownFiltered.length ? [{ ...g, hooks: ownFiltered }] : [];
  });
  kept.push({ matcher, hooks: [{ type: 'command', command, timeout }] });
  hooks.PreToolUse = kept;
  return JSON.stringify(j, null, indent) + '\n';
}
export function removeClaude(text) {
  if (!text || !text.trim()) return text;
  const j = JSON.parse(text); const indent = indentOf(text);
  const list = j.hooks?.PreToolUse;
  if (!Array.isArray(list)) return text;
  const changed = list.some((g) => (g.hooks || []).some((h) => isOurs(h.command)));
  if (!changed) return text;
  const kept = list.flatMap((g) => {
    const entries = Array.isArray(g.hooks) ? g.hooks : [];
    const ownFiltered = entries.filter((h) => !isOurs(h.command));
    if (ownFiltered.length === entries.length) return [g];
    return ownFiltered.length ? [{ ...g, hooks: ownFiltered }] : [];
  });
  if (kept.length) j.hooks.PreToolUse = kept; else { delete j.hooks.PreToolUse; if (!Object.keys(j.hooks).length) delete j.hooks; }
  return JSON.stringify(j, null, indent) + '\n';
}
export const hasClaude = (text) => { try { return (JSON.parse(text).hooks?.PreToolUse || []).some((g) => (g.hooks || []).some((h) => isOurs(h.command))); } catch { return false; } };

// ---- Muse Code: ~/.config/muse/settings.json (JSON), same hook shape under the key "hooks" -------------------------------------
export const addMuse = (text, command) => addClaude(text, command, { matcher: 'subagent_spawn', timeout: 5 });
export const removeMuse = removeClaude;
export const hasMuse = hasClaude;

// ---- Codex: ~/.codex/config.toml (TOML) ---------------------------------------------------------------------------------------
// Our hook is a group of tables appended AFTER everything else: [[hooks.PreToolUse]] plus its [[hooks.PreToolUse.hooks]], between two comment markers.
// Codex records a trust hash per hook by its position ("pre_tool_use:<index>:<n>"), so the existing budget hook must keep index 0: our group goes last.
// Codex REWRITES this file when a user trusts a hook: it moves its own tables ([tui], [hooks.state...]) to the end, which puts them
// between our markers. So the markers say only "we were here"; the hook itself is found by its command (--fd-guard), table by table, and only
// our group and our own trust entry are ever removed. Everything else in the file stays exactly as it is.
// This module is a text scanner, not a TOML parser. It fails closed: when it cannot tell which tables are ours it throws, and the installer additionally
// compares the parsed file before and after (lib/tomlcheck.mjs) and refuses any edit that changes something that is not ours.
const OPEN = '# >>> frontdesk-guard (managed by install-frontdesk; remove with: node install-frontdesk.mjs uninstall) >>>';
const CLOSE = '# <<< frontdesk-guard <<<';
const OPEN_RE = /^\s*# >>> frontdesk-guard\b/;
const CLOSE_RE = /^\s*# <<< frontdesk-guard <<<[ \t]*$/;
const quoteToml = (s) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);

function codexGroupLines(command, matcher, timeout) {
  return ['[[hooks.PreToolUse]]', `matcher = ${JSON.stringify(matcher)}`, '', '[[hooks.PreToolUse.hooks]]', 'type = "command"', `command = ${quoteToml(command)}`, `command_windows = ${quoteToml(command)}`, `timeout = ${timeout}`];
}

function commandFromGroup(groupText) {
  const m = /^command\s*=\s*(.+)$/m.exec(groupText);
  if (!m) return null;
  const value = m[1].trim();
  try { return value.startsWith('"') ? JSON.parse(value) : value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : null; }
  catch { return null; }
}

export class CodexBlockEditedError extends Error {
  constructor(block, message = 'the marked Codex block was edited by hand', layout = false) { super(message); this.name = 'CodexBlockEditedError'; this.block = block; this.layout = layout; }
}
const layoutError = (block, message) => new CodexBlockEditedError(block, message, true);

// Lexical pass: which lines start or end inside a multi-line string, and which are real comment lines.
function lexLines(lines) {
  const info = [];
  let state = null; // null, '"""' or "'''"
  for (const line of lines) {
    const startsInString = state !== null;
    const n = line.length;
    let i = 0;
    while (i < n) {
      if (state === '"""') {
        let j = i, closed = false;
        while (j < n) { if (line[j] === '\\') { j += 2; continue; } if (line.startsWith('"""', j)) { closed = true; j += 3; break; } j++; }
        if (closed) { state = null; i = j; } else i = n;
        continue;
      }
      if (state === "'''") {
        const k = line.indexOf("'''", i);
        if (k >= 0) { state = null; i = k + 3; } else i = n;
        continue;
      }
      const ch = line[i];
      if (ch === '#') break;
      if (line.startsWith('"""', i)) { state = '"""'; i += 3; continue; }
      if (line.startsWith("'''", i)) { state = "'''"; i += 3; continue; }
      if (ch === '"') { let j = i + 1; while (j < n && line[j] !== '"') { if (line[j] === '\\') j++; j++; } i = j + 1; continue; }
      if (ch === "'") { const k = line.indexOf("'", i + 1); i = k < 0 ? n : k + 1; continue; }
      i++;
    }
    info.push({ startsInString, endsInString: state !== null, commentLine: !startsInString && /^\s*#/.test(line) });
  }
  return { info, endState: state };
}

// "a.'b c'.\"d\"" -> ['a', 'b c', 'd']
function splitKey(raw) {
  const parts = [];
  const n = raw.length;
  let i = 0;
  while (i < n) {
    while (raw[i] === ' ' || raw[i] === '\t') i++;
    let part;
    if (raw[i] === '"') {
      let j = i + 1, s = '';
      const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      while (j < n && raw[j] !== '"') {
        if (raw[j] !== '\\') { s += raw[j++]; continue; }
        const c = raw[j + 1];
        if (c === 'u' || c === 'U') { // \uXXXX and \UXXXXXXXX are valid in a quoted key
          const len = c === 'u' ? 4 : 8;
          const hex = raw.slice(j + 2, j + 2 + len);
          if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) return null;
          try { s += String.fromCodePoint(parseInt(hex, 16)); } catch { return null; }
          j += 2 + len;
        } else { s += simple[c] ?? c; j += 2; }
      }
      if (raw[j] !== '"') return null;
      part = s; i = j + 1;
    } else if (raw[i] === "'") {
      const j = raw.indexOf("'", i + 1);
      if (j < 0) return null;
      part = raw.slice(i + 1, j); i = j + 1;
    } else {
      let j = i;
      while (j < n && raw[j] !== '.') j++;
      part = raw.slice(i, j).trim();
      if (!part) return null;
      i = j;
    }
    parts.push(part);
    while (raw[i] === ' ' || raw[i] === '\t') i++;
    if (i < n) { if (raw[i] !== '.') return null; i++; }
  }
  return parts.length ? parts : null;
}

// "[a.b]" / "[[a.b]]" with an optional trailing comment; brackets inside quoted keys do not end the header
function parseHeader(line) {
  const n = line.length;
  let i = 0;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  if (line[i] !== '[') return null;
  const array = line[i + 1] === '[';
  i += array ? 2 : 1;
  let raw = '', q = null;
  for (; i < n; i++) {
    const ch = line[i];
    if (q) { raw += ch; if (ch === '\\' && q === '"') { raw += line[++i] ?? ''; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; raw += ch; continue; }
    if (ch === ']') break;
    raw += ch;
  }
  if (q || line[i] !== ']') return null;
  i++;
  if (array) { if (line[i] !== ']') return null; i++; }
  const rest = line.slice(i).trim();
  if (rest && !rest.startsWith('#')) return null;
  const parts = splitKey(raw);
  return parts ? { array, parts } : null;
}

const same = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);

function scanCodex(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const { info, endState } = lexLines(lines);
  const heads = [];
  lines.forEach((line, i) => {
    if (info[i].startsInString || !/^\s*\[/.test(line)) return;
    const h = parseHeader(line);
    if (h) heads.push({ line: i, ...h });
  });
  const end = (k) => (k + 1 < heads.length ? heads[k + 1].line : lines.length);
  const groups = [];
  for (let k = 0; k < heads.length; k++) {
    if (!(heads[k].array && same(heads[k].parts, ['hooks', 'PreToolUse']))) continue;
    let last = k;
    while (last + 1 < heads.length && heads[last + 1].array && same(heads[last + 1].parts, ['hooks', 'PreToolUse', 'hooks'])) last++;
    groups.push({ index: groups.length, first: heads[k].line, end: end(last) });
    k = last;
  }
  return { eol, lines, info, endState, heads, groups, end };
}

const isMarkerLine = (scan, i) => scan.info[i].commentLine && (OPEN_RE.test(scan.lines[i]) || CLOSE_RE.test(scan.lines[i]));
const FD_COMMAND_RE = /^\s*command(_windows)?\s*=.*--fd-guard/;
const mentionsFd = (scan, i) => !scan.info[i].startsInString && !scan.info[i].commentLine && FD_COMMAND_RE.test(scan.lines[i]);

// last line of real content in [from, to): not blank and not one of our marker comments
function contentEnd(scan, from, to) {
  let e = to;
  while (e > from && (scan.lines[e - 1].trim() === '' || isMarkerLine(scan, e - 1))) e--;
  return e;
}

// All groups that hold a --fd-guard command; throws when ownership is unclear (fail closed).
function findOurs(scan) {
  if (scan.endState) throw layoutError('', 'the file ends inside a multi-line string, so the tables cannot be told apart');
  const found = [];
  for (const g of scan.groups) {
    const e = contentEnd(scan, g.first, g.end);
    if (scan.lines.slice(g.first, e).some((_, k) => mentionsFd(scan, g.first + k))) found.push({ ...g, contentEnd: e, text: scan.lines.slice(g.first, e).join('\n') });
  }
  if (found.length > 1) throw layoutError(found.map((g) => g.text).join('\n\n'), 'more than one front desk hook group was found');
  if (!found.length) {
    const stray = scan.lines.findIndex((_, i) => (scan.info[i].commentLine && OPEN_RE.test(scan.lines[i])) || mentionsFd(scan, i));
    if (stray >= 0) throw layoutError(scan.lines[stray], 'a front desk marker or command is present but no complete hook group was found');
    return null;
  }
  return found[0];
}

export function addCodex(text, command, { matcher = '[Aa]gent', timeout = 5, existingCommand = command, file = null } = {}) {
  const src = text || '';
  const ours = findOurs(scanCodex(src));
  const wanted = codexGroupLines(command, matcher, timeout).join('\n');
  if (ours && ours.text === wanted) return src;
  const base = removeCodex(src, existingCommand, { file });
  const sep = base.length === 0 ? '' : (base.endsWith('\n') ? '\n' : '\n\n');
  return base + sep + [OPEN, ...codexGroupLines(command, matcher, timeout), CLOSE].join('\n') + '\n';
}

const SIMPLE_VALUE = /^\s*[A-Za-z0-9_-]+\s*=\s*("[^"\\]*"|'[^']*'|true|false|-?\d[\d_.]*)\s*(#.*)?$/;

export function removeCodex(text, expectedCommand = null, { file = null } = {}) {
  const scan = scanCodex(text);
  const ours = findOurs(scan);
  if (!ours) return text;
  const command = expectedCommand ?? commandFromGroup(ours.text);
  const expected = command && codexGroupLines(command, '[Aa]gent', 5).join('\n');
  if (!expected || ours.text !== expected) throw new CodexBlockEditedError(ours.text);
  if (scan.groups.some((g) => g.index > ours.index)) {
    throw layoutError(ours.text, 'another PreToolUse hook comes after ours; removing ours would renumber it and break its trust entry');
  }
  const drop = new Array(scan.lines.length).fill(false);
  const dropRange = (from, to) => { for (let i = from; i < to; i++) drop[i] = true; };
  // our group, with one blank line before it and the opening marker just above it
  let from = ours.first;
  if (from > 0 && isMarkerLine(scan, from - 1) && OPEN_RE.test(scan.lines[from - 1])) from--;
  if (from > 0 && scan.lines[from - 1].trim() === '') from--;
  dropRange(from, ours.contentEnd);
  // our own trust entry: [hooks.state.'<this config file>:pre_tool_use:<our index>:<n>'], only simple key = value lines
  scan.heads.forEach((h, k) => {
    if (h.array || h.parts.length !== 3 || !same(h.parts.slice(0, 2), ['hooks', 'state'])) return;
    const m = /^(.*):pre_tool_use:(\d+):(\d+)$/.exec(h.parts[2]);
    if (!m || Number(m[2]) !== ours.index || (file && !sameFile(m[1], file))) return;
    let lastKv = h.line;
    for (let i = h.line + 1; i < scan.end(k); i++) {
      const line = scan.lines[i];
      if (line.trim() === '' || isMarkerLine(scan, i)) continue;
      if (scan.info[i].commentLine) break; // comments before the next table belong to it
      if (scan.info[i].startsInString || scan.info[i].endsInString || !SIMPLE_VALUE.test(line)) throw layoutError(scan.lines.slice(h.line, scan.end(k)).join('\n'), 'our trust entry holds something other than simple key = value lines');
      lastKv = i;
    }
    let s = h.line;
    if (s > 0 && scan.lines[s - 1].trim() === '' && !drop[s - 1]) s--;
    dropRange(s, lastKv + 1);
  });
  scan.lines.forEach((_, i) => { if (isMarkerLine(scan, i)) drop[i] = true; });
  return scan.lines.filter((_, i) => !drop[i]).join(scan.eol);
}

// How many of our groups the scanner sees (0 or 1, or it throws); the installer compares this with the parsed file.
export const countCodexGroups = (text) => (findOurs(scanCodex(text || '')) ? 1 : 0);
// What the scanner sees: how many of our groups (0 or 1, or it throws) and at which position among the [[hooks.PreToolUse]] groups. The installer compares this with the parsed file.
export const scanCodexOurs = (text) => { const found = findOurs(scanCodex(text || '')); return found ? { count: 1, index: found.index } : { count: 0, index: -1 }; };
export const hasCodex = (text) => { try { return countCodexGroups(text) === 1; } catch { return false; } };
