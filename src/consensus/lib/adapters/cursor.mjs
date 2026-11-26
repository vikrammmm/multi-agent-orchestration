import path from 'node:path';
import { extractJson } from '../schema.mjs';
import { buildChildEnv, emptyAdapterResult, resolveSeatBinary, spawnSeat } from '../spawn.mjs';

const STRIP = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CURSOR_API_KEY', 'XAI_API_KEY', 'MUSE_API_KEY'];

function parseCursor(stdout) {
  const text = String(stdout || '');
  const objs = [];
  const trimmed = text.trim();
  try {
    const one = JSON.parse(trimmed);
    if (one && typeof one === 'object') objs.push(one);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try { objs.push(JSON.parse(t)); } catch { /* skip */ }
    }
    const extracted = extractJson(text);
    if (extracted) objs.push(extracted);
  }
  const result = objs.find((o) => o && o.type === 'result') || objs[objs.length - 1] || null;
  if (result && result.is_error === true) {
    // The CLI answered with an error result (plan limit, login, refusal): not a verdict.
    return {
      rawText: '',
      sessionId: result.session_id || null,
      usage: null,
      isError: true,
      errorText: result.result != null ? String(result.result) : 'the CLI reported an error',
    };
  }
  if (result && result.type === 'result') {
    return {
      rawText: result.result != null ? String(result.result) : JSON.stringify(result),
      sessionId: result.session_id || null,
      usage: result.duration_ms != null ? { duration_ms: result.duration_ms } : null,
    };
  }
  if (result && result.result != null) {
    return { rawText: String(result.result), sessionId: result.session_id || null, usage: null };
  }
  return { rawText: text, sessionId: result?.session_id || null, usage: null };
}

export async function run(opts) {
  const bin = resolveSeatBinary('cursor-agent');
  const base = emptyAdapterResult(opts.callDir);
  if (!bin) return { ...base, status: 'unavailable', errorText: 'cursor-agent binary not found' };
  const copyDir = opts.copyDir || path.join(opts.callDir, 'copy');
  const args = [
    '--print', '--output-format', 'json', '--trust', '--mode', 'plan',
    '--model', opts.seat.model, '--workspace', copyDir,
  ];
  if (opts.resume) args.push('--resume', opts.resume);
  const spawned = await spawnSeat({
    bin,
    args,
    cwd: copyDir,
    prompt: opts.prompt,
    env: opts.env || buildChildEnv({
      taskId: opts.taskId,
      callIndex: opts.callIndex,
      stripKeys: STRIP,
    }),
    timeoutMs: opts.timeoutMs,
    stdoutPath: path.join(opts.callDir, 'stdout.txt'),
    stderrPath: path.join(opts.callDir, 'stderr.txt'),
    detachedGroup: true,
    ready: resultReady(opts.isComplete),
  });
  const parsed = parseCursor(spawned.rawText);
  const status = parsed.isError ? 'failed' : (spawned.status === 'completed' && spawned.exitCode && !parsed.rawText ? 'failed' : spawned.status);
  return {
    ...base,
    status,
    exitCode: spawned.exitCode,
    signal: spawned.signal,
    rawText: parsed.rawText,
    sessionId: parsed.sessionId,
    usage: parsed.usage,
    durationMs: spawned.durationMs,
    errorText: parsed.errorText || spawned.errorText,
    endedBy: spawned.endedBy,
  };
}

// The declared output is the `"type":"result"` object on stdout (the whole output, or one line of
// it). Once a complete one carries a valid verdict, the call is over even if the CLI does not exit.
export function resultReady(isComplete) {
  if (typeof isComplete !== 'function') return null;
  let seen = -1;
  return ({ stdout }) => {
    const text = String(stdout() || '');
    if (text.length === seen) return false;
    seen = text.length;
    for (const t of [text.trim(), ...text.split(/\r?\n/).map((l) => l.trim())]) {
      if (!t.startsWith('{') || !t.endsWith('}')) continue;
      let obj;
      try { obj = JSON.parse(t); } catch { continue; }
      if (obj && obj.type === 'result' && obj.is_error !== true && obj.result != null
        && isComplete(String(obj.result))) return true;
    }
    return false;
  };
}
