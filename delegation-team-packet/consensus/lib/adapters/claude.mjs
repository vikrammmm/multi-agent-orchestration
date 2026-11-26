import path from 'node:path';
import { writeUtf8 } from '../fsx.mjs';
import { buildChildEnv, emptyAdapterResult, resolveSeatBinary, spawnSeat } from '../spawn.mjs';

const STRIP = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CURSOR_API_KEY', 'XAI_API_KEY', 'MUSE_API_KEY'];

function parseClaude(stdout) {
  const text = String(stdout || '').trim();
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') {
      if (obj.is_error === true) {
        // The CLI answered with an error result (plan limit, login, refusal): not a verdict.
        return {
          rawText: '',
          sessionId: obj.session_id || null,
          usage: obj.total_cost_usd != null ? { total_cost_usd: obj.total_cost_usd } : null,
          isError: true,
          errorText: obj.result != null ? String(obj.result) : 'the CLI reported an error',
        };
      }
      const raw = obj.structured_output != null
        ? (typeof obj.structured_output === 'string' ? obj.structured_output : JSON.stringify(obj.structured_output))
        : (obj.result != null ? String(obj.result) : text);
      return {
        rawText: raw,
        sessionId: obj.session_id || null,
        usage: obj.usage ? { ...obj.usage, total_cost_usd: obj.total_cost_usd } : (obj.total_cost_usd != null ? { total_cost_usd: obj.total_cost_usd } : null),
      };
    }
  } catch { /* not a single json object */ }
  return { rawText: stdout || '', sessionId: null, usage: null };
}

function unknownFlag(stderr) {
  const t = String(stderr || '');
  if (!/unknown option|unrecognized option|unknown flag/i.test(t)) return null;
  if (/strict-mcp-config/i.test(t)) return '--strict-mcp-config';
  if (/json-schema/i.test(t)) return '--json-schema';
  if (/effort/i.test(t)) return '--effort';
  return null;
}

export function buildArgs(opts, dropped = new Set()) {
  const mcp = path.join(opts.callDir, 'mcp-empty.json');
  writeUtf8(mcp, '{"mcpServers":{}}\n');
  const args = ['-p', '--output-format', 'json', '--model', opts.seat.model];
  if (!dropped.has('--effort')) {
    args.push('--effort', opts.seat.effort);
  }
  args.push('--tools', 'Read,Glob,Grep', '--restricted');
  if (!dropped.has('--strict-mcp-config')) {
    args.push('--strict-mcp-config');
  }
  args.push('--mcp-config', mcp);
  if (!dropped.has('--json-schema')) {
    args.push('--json-schema', opts.schemaJson);
  }
  args.push('--add-dir', path.join(opts.callDir, 'materials'));
  if (opts.seat.maxBudgetUsd != null) {
    args.push('--max-budget-usd', String(opts.seat.maxBudgetUsd));
  }
  if (opts.resume) args.push('--resume', opts.resume);
  return args;
}

export async function run(opts) {
  const bin = resolveSeatBinary('claude');
  const base = emptyAdapterResult(opts.callDir);
  if (!bin) {
    return { ...base, status: 'unavailable', errorText: 'claude binary not found' };
  }
  const dropped = new Set();
  const env = opts.env || buildChildEnv({
    taskId: opts.taskId,
    callIndex: opts.callIndex,
    stripKeys: STRIP,
  });
  let result = await invoke(bin, opts, env, dropped);
  const reject = unknownFlag(result.stderrText);
  if (reject && result.exitCode) {
    if (opts.seat.strictFlags) return {
      ...base, status: 'failed', exitCode: result.exitCode, signal: result.signal,
      rawText: '', durationMs: result.durationMs,
      errorText: `Claude Code rejected ${reject}; update the CLI`, flagsDropped: [],
    };
    dropped.add(reject);
    result = await invoke(bin, opts, env, dropped);
  }
  const parsed = parseClaude(result.rawText);
  return {
    ...base,
    status: parsed.isError ? 'failed' : (result.status === 'completed' && result.exitCode && !parsed.rawText ? 'failed' : result.status),
    exitCode: result.exitCode,
    signal: result.signal,
    rawText: parsed.rawText,
    sessionId: parsed.sessionId,
    usage: parsed.usage,
    durationMs: result.durationMs,
    errorText: parsed.errorText || result.errorText,
    flagsDropped: [...dropped],
    endedBy: result.endedBy,
  };
}

// The declared output is the one result object on stdout. Once it is complete (it parses as a
// whole) and carries a valid verdict, the call is over even if the CLI does not exit.
export function resultReady(isComplete) {
  if (typeof isComplete !== 'function') return null;
  let seen = -1;
  return ({ stdout }) => {
    const text = String(stdout() || '').trim();
    if (text.length === seen || !text.endsWith('}')) return false;
    seen = text.length;
    let obj;
    try { obj = JSON.parse(text); } catch { return false; }
    if (!obj || obj.type !== 'result' || obj.is_error === true) return false;
    const parsed = parseClaude(text);
    return Boolean(parsed.rawText) && isComplete(parsed.rawText);
  };
}

async function invoke(bin, opts, env, dropped) {
  const spawned = await spawnSeat({
    bin,
    args: buildArgs(opts, dropped),
    cwd: opts.projectDir,
    prompt: opts.prompt,
    env,
    timeoutMs: opts.timeoutMs,
    stdoutPath: path.join(opts.callDir, 'stdout.txt'),
    stderrPath: path.join(opts.callDir, 'stderr.txt'),
    detachedGroup: true,
    ready: resultReady(opts.isComplete),
  });
  let stderrText = '';
  try {
    const { readUtf8 } = await import('../fsx.mjs');
    stderrText = readUtf8(path.join(opts.callDir, 'stderr.txt'));
  } catch { /* empty */ }
  return { ...spawned, stderrText };
}
