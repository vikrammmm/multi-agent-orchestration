// Hook payloads reflect Claude Code and Muse Code formats. Codex's are a guess:
// its hook payloads are not proved yet. Prompt text is a recognisable secret so tests can prove it never reaches the log.
export const SECRET = 'TOP-SECRET-PROMPT-TEXT';

const claudeBase = { session_id: 'abcd1234-0000-4000-8000-000000000000', transcript_path: 'C:/x/t.jsonl', cwd: 'C:/w/project-x', scratchpad_dir: 'C:/x/s', prompt_id: 'p1', permission_mode: 'default', effort: 'low', hook_event_name: 'PreToolUse', tool_use_id: 'toolu_1' };
export const claudeAgent = (sub, extra = {}) => ({ ...claudeBase, tool_name: 'Agent', tool_input: { description: 'd', prompt: SECRET, subagent_type: sub, run_in_background: false, ...extra } });
export const claudeAgentNoType = () => ({ ...claudeBase, tool_name: 'Agent', tool_input: { description: 'd', prompt: SECRET } });
export const claudeSubagentCallsAgent = (sub) => ({ ...claudeAgent(sub), agent_id: 'a1b2c3', agent_type: 'general-purpose' });
export const claudeSubagentBash = () => ({ ...claudeBase, tool_name: 'Bash', agent_id: 'a1b2c3', agent_type: 'general-purpose', tool_input: { command: 'echo hi' } });
export const claudeBash = () => ({ ...claudeBase, tool_name: 'Bash', tool_input: { command: 'echo hi' } });
export const claudeWorkflow = (script) => ({ ...claudeBase, tool_name: 'Workflow', tool_input: { script } });

const museBase = { session_id: '01a13b8a-aaaa', cwd: 'C:/w/hookproof-muse/work', permission_mode: 'on-request', model: 'muse-spark-1.3', model_provider: 'meta', hook_event_name: 'PreToolUse', tool_use_id: 'tu', turn_id: 'tn', transcript_path: 'C:/m/t' };
export const museSpawn = (role = 'general-purpose') => ({ ...museBase, tool_name: 'subagent_spawn', tool_input: { command_id: 'c1', objective: SECRET, role } });
export const museShell = () => ({ ...museBase, tool_name: 'powershell', tool_input: { command: 'echo hi' } });

const codexBase = { session_id: 'cx-1', cwd: 'C:/w/project-x', hook_event_name: 'PreToolUse', tool_use_id: 'tu' };
export const codexSpawn = (extra = {}) => ({ ...codexBase, tool_name: 'spawn_agent', tool_input: { message: SECRET, task_name: 't', ...extra } });
export const codexBash = () => ({ ...codexBase, tool_name: 'Bash', tool_input: { command: 'echo hi' } });
