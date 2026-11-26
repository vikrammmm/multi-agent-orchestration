import test from 'node:test';
import assert from 'node:assert/strict';
import { addClaude, removeClaude, hasClaude, addMuse, removeMuse, hasMuse, addCodex, removeCodex, hasCodex, hookCommand, MARKER, CodexBlockEditedError } from '../lib/splice.mjs';

const CMD = hookCommand('C:/N~1/node.exe', 'C:/H~1/hook.mjs', 'claude');

// ---- Claude Code settings.json ----
const claudeOriginal = JSON.stringify({ autoUpdatesChannel: 'latest', skipWorkflowUsageWarning: true, switchModelsOnFlag: true }, null, 2) + '\n';

test('claude: adds a hook block, keeps every other key and the indentation', () => {
  const out = addClaude(claudeOriginal, CMD);
  const j = JSON.parse(out);
  assert.equal(j.autoUpdatesChannel, 'latest');
  assert.equal(j.skipWorkflowUsageWarning, true);
  assert.equal(j.hooks.PreToolUse.length, 1);
  assert.equal(j.hooks.PreToolUse[0].matcher, 'Agent|Workflow');
  assert.ok(j.hooks.PreToolUse[0].hooks[0].command.includes(MARKER));
  assert.equal(j.hooks.PreToolUse[0].hooks[0].timeout, 5);
  assert.ok(out.includes('\n  "autoUpdatesChannel"'), 'two-space indentation kept');
  assert.ok(hasClaude(out));
});

test('claude: installing twice changes nothing; removing restores the original exactly', () => {
  const once = addClaude(claudeOriginal, CMD);
  assert.equal(addClaude(once, CMD), once);
  assert.equal(removeClaude(once), claudeOriginal);
});

test('claude: other hooks and other PreToolUse entries are preserved and stay first', () => {
  const withOthers = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other.js' }] }], PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] }, model: 'm' }, null, 2) + '\n';
  const out = JSON.parse(addClaude(withOthers, CMD));
  assert.equal(out.hooks.PreToolUse.length, 2);
  assert.equal(out.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(out.hooks.PostToolUse.length, 1);
  assert.equal(out.model, 'm');
  const back = JSON.parse(removeClaude(JSON.stringify(out, null, 2)));
  assert.equal(back.hooks.PreToolUse.length, 1);
  assert.equal(back.hooks.PreToolUse[0].matcher, 'Bash');
});

test('claude: removes only our hook from a mixed matcher group', () => {
  const mixed = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Agent|Workflow', hooks: [
    { type: 'command', command: CMD, timeout: 5 },
    { type: 'command', command: 'node keep.js' },
  ] }] } }, null, 2);
  const removed = JSON.parse(removeClaude(mixed));
  assert.equal(removed.hooks.PreToolUse.length, 1);
  assert.deepEqual(removed.hooks.PreToolUse[0].hooks.map((h) => h.command), ['node keep.js']);
  const added = JSON.parse(addClaude(mixed, CMD));
  assert.deepEqual(added.hooks.PreToolUse[0].hooks.map((h) => h.command), ['node keep.js']);
  assert.equal(added.hooks.PreToolUse.length, 2);
});

test('claude: an update replaces our old entry (new command) instead of adding a second', () => {
  const first = addClaude(claudeOriginal, hookCommand('C:/old/node.exe', 'C:/old/hook.mjs', 'claude'));
  const second = JSON.parse(addClaude(first, CMD));
  assert.equal(second.hooks.PreToolUse.length, 1);
  assert.ok(second.hooks.PreToolUse[0].hooks[0].command.includes('C:/N~1/node.exe'));
});

test('claude: invalid JSON throws, so the installer can leave the file alone', () => {
  assert.throws(() => addClaude('{ not json', CMD));
});

// ---- Muse settings.json ----
test('muse: the hook goes under the key "hooks" with the subagent_spawn matcher; other settings are kept', () => {
  const museOriginal = JSON.stringify({ schema_version: 1, provider: 'meta', model: 'muse-wonder-full-1.0', contributor_mode_enabled: false, permissions: { default_profile: ':unrestricted' } }, null, 2) + '\n';
  const out = addMuse(museOriginal, hookCommand('C:/N~1/node.exe', 'C:/H~1/hook.mjs', 'muse'));
  const j = JSON.parse(out);
  assert.equal(j.contributor_mode_enabled, false);
  assert.equal(j.permissions.default_profile, ':unrestricted');
  assert.equal(j.hooks.PreToolUse[0].matcher, 'subagent_spawn');
  assert.ok(hasMuse(out));
  assert.equal(removeMuse(out), museOriginal);
});

test('muse: removing our hook preserves another hook in the same matcher group', () => {
  const command = hookCommand('C:/N~1/node.exe', 'C:/H~1/hook.mjs', 'muse');
  const mixed = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'subagent_spawn', hooks: [
    { type: 'command', command, timeout: 5 },
    { type: 'command', command: 'node keep.js' },
  ] }] } });
  const removed = JSON.parse(removeMuse(mixed));
  assert.equal(removed.hooks.PreToolUse.length, 1);
  assert.deepEqual(removed.hooks.PreToolUse[0].hooks.map((h) => h.command), ['node keep.js']);
});

// ---- Codex config.toml ----
const codexOriginal = `model = "gpt-6.1-sol"
model_reasoning_effort = "ultra"

[features]
hooks = true

[[hooks.PreToolUse]]
matcher = "^Bash$|^apply_patch$|^Edit$|^Write$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = 'python3 ~/.codex/hooks/astra_execution_budget/astra_execution_budget.py'
timeout = 5

[hooks.state.'C:\\Users\\X\\.codex\\config.toml:pre_tool_use:0:0']
trusted_hash = "sha256:92b17b3d"
`;

test('codex: our block is appended last, so the budget hook keeps index 0 and its trust entry', () => {
  const out = addCodex(codexOriginal, CMD);
  assert.ok(out.startsWith(codexOriginal.trimEnd()), 'everything before our block is byte-identical');
  assert.equal((out.match(/\[\[hooks\.PreToolUse\]\]/g) || []).length, 2);
  assert.ok(out.indexOf('astra_execution_budget') < out.indexOf('frontdesk-guard'));
  assert.ok(out.includes('trusted_hash = "sha256:92b17b3d"'));
  assert.ok(out.includes('matcher = "[Aa]gent"'));
  assert.ok(out.includes('command_windows ='));
  assert.ok(hasCodex(out));
  assert.ok(out.includes(MARKER));
});

test('codex: installing twice changes nothing; removing restores the original exactly', () => {
  const once = addCodex(codexOriginal, CMD);
  assert.equal(addCodex(once, CMD), once);
  assert.equal(removeCodex(once), codexOriginal);
});

test('codex: a file without a trailing newline still round-trips to a clean file', () => {
  const noNl = codexOriginal.trimEnd();
  const back = removeCodex(addCodex(noNl, CMD));
  assert.equal(back.trimEnd(), noNl);
});

test('codex: removing from a file that never had our block returns it untouched', () => {
  assert.equal(removeCodex(codexOriginal), codexOriginal);
  assert.equal(hasCodex(codexOriginal), false);
});

test('codex: an edited marked block is preserved and reported', () => {
  const edited = addCodex(codexOriginal, CMD).replace(/timeout = 5(?![\s\S]*timeout = 5)/, 'timeout = 9');
  assert.ok(edited.endsWith('timeout = 9\n# <<< frontdesk-guard <<<\n'));
  assert.throws(() => removeCodex(edited), /edited by hand/);
  assert.throws(() => addCodex(edited, CMD), /edited by hand/);
});

test('codex: the managed block can be removed after line endings are normalized', () => {
  const once = addCodex(codexOriginal, CMD).replace(/\n/g, '\r\n');
  assert.equal(removeCodex(once, CMD).replace(/\r\n/g, '\n'), codexOriginal);
});

test('codex: a command containing a single quote is written as a double-quoted TOML string', () => {
  const out = addCodex(codexOriginal, hookCommand("C:/it's/node.exe", 'C:/h.mjs', 'codex'));
  assert.ok(/command = "C:\/it's\/node\.exe/.test(out));
});

// When the user trusts our hook, Codex moves [tui] and [hooks.state...] tables (its own trust entries, ours with
// "enabled = true") to the end, so they now sit between our two markers.
function codexRewritten(command = CMD) {
  const withBlock = addCodex(codexOriginal, command);
  const [before, rest] = [withBlock.slice(0, withBlock.indexOf('# >>> frontdesk-guard')), withBlock.slice(withBlock.indexOf('# >>> frontdesk-guard'))];
  const budgetState = before.slice(before.indexOf("[hooks.state.'"));
  const head = before.slice(0, before.indexOf("[hooks.state.'")).trimEnd();
  const group = rest.slice(rest.indexOf('[[hooks.PreToolUse]]'), rest.indexOf('# <<< frontdesk-guard <<<')).trimEnd();
  return `${head}\n\n[tui]\nscreen_reader_detection_done = true\n\n${rest.slice(0, rest.indexOf('[[hooks.PreToolUse]]'))}${group}\n\n[hooks.state]\n\n${budgetState.trimEnd()}\n\n[hooks.state.'C:\\\\Users\\\\X\\\\.codex\\\\config.toml:pre_tool_use:1:0']\ntrusted_hash = "sha256:ours"\nenabled = true\n# <<< frontdesk-guard <<<\n`;
}

test('codex: after Codex rewrites the file around our block, our hook is still found and removed on its own', () => {
  const rewritten = codexRewritten();
  assert.ok(hasCodex(rewritten));
  const out = removeCodex(rewritten);
  assert.equal(hasCodex(out), false);
  assert.ok(!out.includes('--fd-guard') && !out.includes('sha256:ours') && !out.includes('frontdesk-guard'), 'our group, our trust entry and the markers are gone');
  assert.ok(out.includes("pre_tool_use:0:0']") && out.includes('trusted_hash = "sha256:92b17b3d"'), 'the budget hook trust entry stays');
  assert.ok(out.includes('[tui]\nscreen_reader_detection_done = true'), "Codex's own tables stay");
  assert.ok(out.includes('astra_execution_budget'));
});

test('codex: reinstalling the same hook over the rewritten file changes nothing; a new command replaces ours and drops the stale trust entry', () => {
  const rewritten = codexRewritten();
  assert.equal(addCodex(rewritten, CMD), rewritten);
  const other = hookCommand('C:/N~2/node.exe', 'C:/H~2/hook.mjs', 'claude');
  const replaced = addCodex(rewritten, other, { existingCommand: CMD });
  assert.ok(replaced.includes('N~2') && !replaced.includes('N~1') && !replaced.includes('sha256:ours'));
  assert.equal((replaced.match(/\[\[hooks\.PreToolUse\]\]/g) || []).length, 2);
  assert.ok(replaced.includes('trusted_hash = "sha256:92b17b3d"'));
  assert.equal(removeCodex(replaced, other).includes('--fd-guard'), false);
});

test('codex: removal is refused when another hook comes after ours, because that would renumber its trust entry', () => {
  const later = `${codexRewritten().trimEnd()}\n\n[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = 'node other.js'\n`;
  assert.throws(() => removeCodex(later), (e) => e instanceof CodexBlockEditedError && e.layout === true && /renumber/.test(e.message));
});

test('codex: a table header inside a multi-line string is not mistaken for a table', () => {
  const text = `note = """\n[[hooks.PreToolUse]]\ncommand = 'x --fd-guard'\n"""\n`;
  assert.equal(hasCodex(text), false);
  assert.equal(removeCodex(text), text);
});