// Fail-closed behaviour of the Codex config editing: the text scanner (lib/splice.mjs) and the parsed-file check (lib/tomlcheck.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { addCodex, removeCodex, hasCodex, countCodexGroups, hookCommand, CodexBlockEditedError } from '../lib/splice.mjs';
import { verifyCodexEdit, parseTomlTree } from '../lib/tomlcheck.mjs';

const CMD = hookCommand('C:/N~1/node.exe', 'C:/H~1/hook.mjs', 'codex');
const FILE = 'C:\\Users\\X\\.codex\\config.toml';
const KEY0 = `[hooks.state.'${FILE}:pre_tool_use:0:0']`;
const KEY1 = `[hooks.state.'${FILE}:pre_tool_use:1:0']`;

const budget = (header = '[[hooks.PreToolUse]]') => `${header}\nmatcher = "^Bash$"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = 'python3 budget.py'\ntimeout = 5\n`;
const ours = () => ['[[hooks.PreToolUse]]', 'matcher = "[Aa]gent"', '', '[[hooks.PreToolUse.hooks]]', 'type = "command"', `command = '${CMD}'`, `command_windows = '${CMD}'`, 'timeout = 5'].join('\n');
const OPEN = '# >>> frontdesk-guard (managed by install-frontdesk; remove with: node install-frontdesk.mjs uninstall) >>>';
const CLOSE = '# <<< frontdesk-guard <<<';

// Codex's layout: our group, then its own state tables inside our markers
const rewritten = ({ after = '', budgetHeader } = {}) => `model = "x"\n\n${budget(budgetHeader)}\n[tui]\nflag = true\n\n${OPEN}\n${ours()}\n\n[hooks.state]\n\n${KEY0}\ntrusted_hash = "sha256:aaa"\n\n${KEY1}\ntrusted_hash = "sha256:ours"\nenabled = true\n${after}${CLOSE}\n`;

test('trust entry removal stops at a following table whose quoted key contains a bracket', () => {
  const text = rewritten({ after: `\n[projects.'C:\\w\\old [2025]\\repo']\ntrust_level = "trusted"\n` });
  const out = removeCodex(text, null, { file: FILE });
  assert.ok(out.includes("[projects.'C:\\w\\old [2025]\\repo']") && out.includes('trust_level = "trusted"'));
  assert.ok(!out.includes('sha256:ours') && !out.includes('--fd-guard'));
  assert.ok(out.includes('sha256:aaa'));
});

test('a quoted key [[hooks."PreToolUse"]] is counted, so our index and trust entry are the right ones', () => {
  const out = removeCodex(rewritten({ budgetHeader: '[[hooks."PreToolUse"]]' }), null, { file: FILE });
  assert.ok(out.includes('sha256:aaa'), "the budget hook's trust entry stays");
  assert.ok(!out.includes('sha256:ours'));
});

test('comment lines after our trust entry belong to the next table and stay', () => {
  const out = removeCodex(rewritten({ after: `\n# keep this note\n[other]\nx = 1\n` }), null, { file: FILE });
  assert.ok(out.includes('# keep this note') && out.includes('[other]'));
  assert.ok(!out.includes('sha256:ours'));
});

test('a trust entry for another config file is not ours when the file is given', () => {
  const text = rewritten().replace(KEY1, "[hooks.state.'D:\\other\\config.toml:pre_tool_use:1:0']");
  const out = removeCodex(text, null, { file: FILE });
  assert.ok(out.includes("D:\\other\\config.toml:pre_tool_use:1:0") && out.includes('sha256:ours'));
  assert.ok(!out.includes('--fd-guard'));
});

test('a marker line inside an unrelated multi-line string is kept byte for byte', () => {
  const text = `note = """\n${CLOSE}\n"""\n\n${budget()}\n${OPEN}\n${ours()}\n${CLOSE}\n`;
  const out = removeCodex(text, null, { file: FILE });
  assert.ok(out.startsWith(`note = """\n${CLOSE}\n"""\n`));
  assert.ok(!out.includes('--fd-guard'));
});

test('string and comment tricks do not hide our group or open a false string', () => {
  for (const trick of ['# """\n', "x = 'a \"\"\"'\n", 'y = "esc \\"\\"\\" "\n', 'z = """\\"""x"""\n']) {
    const text = `${trick}${budget()}\n${OPEN}\n${ours()}\n${CLOSE}\n`;
    assert.equal(countCodexGroups(text), 1, trick);
    assert.equal(addCodex(text, CMD), text, 'no second block is appended: ' + trick);
    assert.ok(!removeCodex(text, null, { file: FILE }).includes('--fd-guard'), trick);
  }
});

test('unclear ownership is refused: a marker with no group, two groups, an unterminated string', () => {
  assert.throws(() => removeCodex(`a = 1\n${OPEN}\n${CLOSE}\n`), (e) => e instanceof CodexBlockEditedError && e.layout);
  assert.throws(() => addCodex(`a = 1\n${OPEN}\n${CLOSE}\n`, CMD), (e) => e instanceof CodexBlockEditedError && e.layout);
  assert.throws(() => removeCodex(`${budget()}\n${ours()}\n\n${ours()}\n`), /more than one/);
  assert.throws(() => removeCodex(`${budget()}\n${ours()}\nnote = """\nopen`), /multi-line string/);
  assert.throws(() => addCodex(`${budget()}\n[[hooks.PreToolUse]]\nmatcher = "x"\n\n[between]\nk = 1\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = '${CMD}'\n`, CMD), (e) => e instanceof CodexBlockEditedError && e.layout);
  assert.equal(hasCodex(`a = 1\n`), false);
});

// ---- the parsed-file check (needs Python with tomllib, like the installer) ----
const py = parseTomlTree('a = 1\n');
const maybe = py.ok ? test : test.skip;

maybe('verifyCodexEdit accepts removal of our hook from the rewritten file and an identical text', () => {
  const text = rewritten({ after: `\n[projects.'C:\\w\\old [2025]\\repo']\ntrust_level = "trusted"\n` });
  const out = removeCodex(text, null, { file: FILE });
  assert.deepEqual(verifyCodexEdit(text, out, FILE, countCodexGroups(text)), { ok: true });
  assert.deepEqual(verifyCodexEdit(text, text, FILE, countCodexGroups(text)), { ok: true });
});

maybe('verifyCodexEdit refuses an edit that drops something that is not ours', () => {
  const text = rewritten({ after: `\n[projects.'C:\\w\\keep']\ntrust_level = "trusted"\n` });
  const good = removeCodex(text, null, { file: FILE });
  const damaged = good.replace(`[projects.'C:\\w\\keep']\ntrust_level = "trusted"\n`, '');
  const bad = verifyCodexEdit(text, damaged, FILE, 1);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not ours/);
  const noBudgetTrust = good.replace(`${KEY0}\ntrusted_hash = "sha256:aaa"\n`, '');
  assert.equal(verifyCodexEdit(text, noBudgetTrust, FILE, 1).ok, false);
});

maybe('verifyCodexEdit refuses when the scanner and the parser disagree about what is ours', () => {
  const text = `${budget()}\n${ours()}\n`;
  const r = verifyCodexEdit(text, text, FILE, 0);
  assert.equal(r.ok, false);
  assert.match(r.message, /cannot tell which tables are ours/);
});

maybe('verifyCodexEdit accepts adding our hook last and refuses an addition that renumbers another hook', () => {
  const before = `${budget()}\n[tui]\nflag = true\n`;
  const after = addCodex(before, CMD, { file: FILE });
  assert.deepEqual(verifyCodexEdit(before, after, FILE, 0), { ok: true });
  const reordered = `${ours()}\n\n${budget()}`;
  assert.equal(verifyCodexEdit(before, reordered, FILE, 0).ok, false);
});
