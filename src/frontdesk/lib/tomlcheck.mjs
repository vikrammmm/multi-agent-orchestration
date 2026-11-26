// Safety net for edits to ~/.codex/config.toml. The text scanner in splice.mjs is not a TOML parser, so before any Codex write the installer asks Python's
// tomllib (a real parser) for the parsed file before and after, and refuses the edit unless the ONLY difference is our own hook group and our own trust entry.
import { spawnSync } from 'node:child_process';
import { sameConfigFile } from './samefile.mjs';

const DUMP = 'import sys,json,tomllib; sys.stdout.write(json.dumps(tomllib.load(sys.stdin.buffer), default=str))';

export function parseTomlTree(text, runner = spawnSync) {
  const opts = { input: Buffer.from(text, 'utf8'), encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  let usable = false;
  for (const [command, args] of [['python', ['-I', '-c', DUMP]], ['py', ['-3', '-I', '-c', DUMP]]]) {
    let result;
    try { result = runner(command, args, opts); } catch (error) { result = { error }; }
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status === 0 && !result.error) {
      try { return { ok: true, tree: JSON.parse(result.stdout) }; } catch { return { ok: false, message: 'Python returned something that is not JSON' }; }
    }
    if (!result.error && result.status !== 9009 && !/Python was not found|No module named ['"]?tomllib/i.test(output)) usable = true;
  }
  return { ok: false, message: usable ? 'Python tomllib rejected the config' : 'no usable Python with tomllib was found (tried python and py -3)' };
}

const isOursHook = (h) => [h?.command, h?.command_windows].some((c) => typeof c === 'string' && c.includes('--fd-guard'));
const groupIsOurs = (g) => Array.isArray(g?.hooks) && g.hooks.some(isOursHook);

export function oursIndexes(tree) {
  const list = tree?.hooks?.PreToolUse;
  return Array.isArray(list) ? list.flatMap((g, i) => (groupIsOurs(g) ? [i] : [])) : [];
}

// Sorted keys so two trees compare as text. Empty tables and arrays are KEPT (an unrelated empty table that disappears is a change).
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)]));
  return v;
}

// The tree without our group and without our trust entries (`<file>:pre_tool_use:<our index>:<n>` for this config file). Removing our hook can leave
// three containers empty that were not there before (hooks.PreToolUse, hooks.state, hooks); only those are dropped, on both sides alike.
export function stripOurs(tree, file) {
  const copy = JSON.parse(JSON.stringify(tree));
  const idx = oursIndexes(copy);
  if (!idx.length) return { tree: canonical(normalizeEmptied(copy)), indexes: idx };
  const hooks = copy.hooks;
  hooks.PreToolUse = hooks.PreToolUse.filter((_, i) => !idx.includes(i));
  const state = hooks.state;
  if (state && typeof state === 'object') {
    for (const key of Object.keys(state)) {
      const m = /^(.*):pre_tool_use:(\d+):\d+$/.exec(key);
      if (m && idx.includes(Number(m[2])) && (!file || sameConfigFile(m[1], file))) delete state[key];
    }
  }
  return { tree: canonical(normalizeEmptied(copy)), indexes: idx };
}

// Applied to BOTH trees whatever they hold, so a first install into an empty config and the removal of our only hook compare equal.
function normalizeEmptied(copy) {
  const h = copy.hooks;
  if (h && typeof h === 'object') {
    if (Array.isArray(h.PreToolUse) && !h.PreToolUse.length) delete h.PreToolUse;
    if (h.state && typeof h.state === 'object' && !Object.keys(h.state).length) delete h.state;
    if (!Object.keys(h).length) delete copy.hooks;
  }
  return copy;
}

// Is the parsed `after` equal to the parsed `before` apart from our own hook?
// `scan` is what the text scanner saw in `before`: { count, index } (a bare number is accepted as the count).
export function verifyCodexEdit(beforeText, afterText, file, scan, runner = spawnSync) {
  const seen = typeof scan === 'number' ? { count: scan, index: null } : scan;
  const pb = parseTomlTree(beforeText, runner);
  if (!pb.ok) return { ok: false, message: `the current file could not be parsed: ${pb.message}` };
  const before = pb.tree;
  const idxB = oursIndexes(before);
  if (idxB.length !== seen.count) return { ok: false, message: `cannot tell which tables are ours (the parser sees ${idxB.length} front desk hook group(s), the text scanner ${seen.count})` };
  if (idxB.length > 1) return { ok: false, message: 'more than one front desk hook group was found' };
  if (idxB.length === 1 && seen.index !== null && seen.index !== undefined && idxB[0] !== seen.index) {
    return { ok: false, message: `the parser puts our hook at position ${idxB[0]} but the text scanner at ${seen.index}; a hook the scanner could not read sits in between` };
  }
  if (afterText === beforeText) return { ok: true };
  if (idxB.length === 1 && idxB[0] !== before.hooks.PreToolUse.length - 1) {
    return { ok: false, message: 'another PreToolUse hook comes after ours (the parser sees it); changing ours would renumber it and break its trust entry' };
  }
  const pa = parseTomlTree(afterText, runner);
  if (!pa.ok) return { ok: false, message: `the edited file would not parse: ${pa.message}` };
  const sb = stripOurs(before, file);
  const sa = stripOurs(pa.tree, file);
  if (sa.indexes.length > 1) return { ok: false, message: 'the edit would leave more than one front desk hook group' };
  if (JSON.stringify(sa.tree) !== JSON.stringify(sb.tree)) return { ok: false, message: 'the edit would change something that is not ours' };
  if (sa.indexes.length === 1 && sa.indexes[0] !== pa.tree.hooks.PreToolUse.length - 1) return { ok: false, message: 'our hook would not be the last PreToolUse hook' };
  return { ok: true };
}
