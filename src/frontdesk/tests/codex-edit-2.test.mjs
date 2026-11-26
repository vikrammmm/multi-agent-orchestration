// Round 2 of the fail-closed Codex editing: escapes in quoted keys, our position in the BEFORE tree, one shared file comparison, empty containers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addCodex, removeCodex, hasCodex, scanCodexOurs, hookCommand, CodexBlockEditedError } from '../lib/splice.mjs';
import { verifyCodexEdit, parseTomlTree, stripOurs } from '../lib/tomlcheck.mjs';
import { sameConfigFile, normalizeConfigPath } from '../lib/samefile.mjs';

const CMD = hookCommand('C:/N~1/node.exe', 'C:/H~1/hook.mjs', 'codex');
const FILE = 'C:\\Users\\X\\.codex\\config.toml';
const budget = `[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = 'python3 budget.py'\ntimeout = 5\n`;
const withOurs = (extra = '') => addCodex(`model = "x"\n\n${budget}${extra}`, CMD, { file: FILE });
// the six literal characters  \u0065  (a TOML escape for the letter e) inside a quoted key: [[hooks."PreToolUs\u0065"]]
const ESCAPED_HEADER = String.raw`[[hooks."PreToolUs\u0065"]]`;
const later = `\n${ESCAPED_HEADER}\nmatcher = "^Bash$"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = 'node other.js'\n`;

test('a quoted key written with a \\u escape is read as the letter, so a later hook is counted', () => {
  assert.ok(ESCAPED_HEADER.includes('\\u0065'), 'the fixture holds the literal backslash-u sequence');
  const text = `${withOurs().trimEnd()}\n${later}`;
  assert.throws(() => removeCodex(text, null, { file: FILE }), (e) => e instanceof CodexBlockEditedError && e.layout && /renumber/.test(e.message));
  assert.equal(scanCodexOurs(withOurs()).index, 1);
});

test('\\U escapes decode and a plain quoted key is counted', () => {
  const ok = `${budget}\n[[hooks."PreToolUse"]]\nmatcher = "m"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = 'x'\n`;
  assert.equal(scanCodexOurs(ok).count, 0);
  const wide = String.raw`[[hooks."\U00000050reToolUse"]]`;
  const text = `${withOurs().trimEnd()}\n\n${wide}\nmatcher = "m"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = 'y'\n`;
  assert.throws(() => removeCodex(text, null, { file: FILE }), /renumber/);
});

const py = parseTomlTree('a = 1\n');
const maybe = py.ok ? test : test.skip;

maybe('the parser puts a later hook after ours even when the scanner could not read it: refused before anything is written', () => {
  const before = `${withOurs().trimEnd()}\n${later}`;
  const wrongAfter = withOurs();
  const r = verifyCodexEdit(before, wrongAfter, FILE, { count: 1, index: 1 });
  assert.equal(r.ok, false);
  assert.match(r.message, /comes after ours/);
});

maybe('the parser and the scanner must agree on our position', () => {
  const text = withOurs();
  const r = verifyCodexEdit(text, removeCodex(text, null, { file: FILE }), FILE, { count: 1, index: 0 });
  assert.equal(r.ok, false);
  assert.match(r.message, /position/);
});

maybe('a first install into an empty config and the removal of our only hook both verify', () => {
  const first = addCodex('', CMD, { file: FILE });
  assert.deepEqual(verifyCodexEdit('', first, FILE, scanCodexOurs('')), { ok: true });
  assert.deepEqual(verifyCodexEdit(first, removeCodex(first, null, { file: FILE }), FILE, scanCodexOurs(first)), { ok: true });
  assert.equal(removeCodex(first, null, { file: FILE }).trim(), '');
});

maybe('an unrelated empty table that disappears is a change that is not ours', () => {
  const before = withOurs('\n[unrelated]\n');
  const damaged = removeCodex(before, null, { file: FILE }).replace('[unrelated]\n', '');
  const r = verifyCodexEdit(before, damaged, FILE, scanCodexOurs(before));
  assert.equal(r.ok, false);
  assert.match(r.message, /not ours/);
});

maybe('scanner and parser agree on a file whose trust key was written with doubled backslashes', () => {
  const doubled = 'C:\\\\Users\\\\X\\\\.codex\\\\config.toml';
  const text = `${withOurs().trimEnd()}\n\n[hooks.state.'${doubled}:pre_tool_use:1:0']\ntrusted_hash = "sha256:ours"\nenabled = true\n`;
  const out = removeCodex(text, null, { file: FILE });
  assert.ok(!out.includes('sha256:ours'), 'the scanner removes our trust entry');
  assert.deepEqual(verifyCodexEdit(text, out, FILE, scanCodexOurs(text)), { ok: true });
  const replaced = addCodex(text, hookCommand('C:/N~2/node.exe', 'C:/H~2/hook.mjs', 'codex'), { existingCommand: CMD, file: FILE });
  assert.deepEqual(verifyCodexEdit(text, replaced, FILE, scanCodexOurs(text)), { ok: true });
});

test('one comparison for the config path: slashes, case and doubled backslashes fold, a UNC prefix does not collapse', () => {
  assert.ok(sameConfigFile('C:\\Users\\X\\.codex\\config.toml', 'c:/users/x/.codex/CONFIG.toml'));
  assert.ok(sameConfigFile('C:\\\\Users\\\\X\\\\c.toml', 'C:\\Users\\X\\c.toml'));
  assert.equal(normalizeConfigPath('\\\\server\\share\\c.toml'), '//server/share/c.toml');
  assert.ok(!sameConfigFile('\\\\server\\share\\c.toml', '\\server\\share\\c.toml'));
});

test('hasCodex is false when the scan cannot be trusted', () => {
  assert.equal(hasCodex('note = """\nopen'), false);
});
