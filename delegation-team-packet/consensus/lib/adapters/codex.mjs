import fs from 'node:fs';
import path from 'node:path';
import { readUtf8 } from '../fsx.mjs';
import { loadLocalJson } from '../paths.mjs';
import { buildChildEnv, emptyAdapterResult, resolveSeatBinary, spawnSeat } from '../spawn.mjs';

const STRIP = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CURSOR_API_KEY', 'XAI_API_KEY', 'MUSE_API_KEY'];

function scanEvents(stdout) {
  let sessionId = null;
  let usage = null;
  let lastText = '';
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      sessionId = pickSession(ev) || sessionId;
      if (ev && (ev.type === 'turn.completed' || ev.usage || ev['turn.completed'])) {
        usage = ev.usage || ev['turn.completed']?.usage || usage;
      }
      const msg = pickMessage(ev);
      if (msg) lastText = msg;
    } catch { /* not jsonl */ }
  }
  return { sessionId, usage, lastText };
}

function pickSession(ev) {
  if (!ev || typeof ev !== 'object') return null;
  return ev.thread_id || ev.threadId || ev.thread?.thread_id || ev.item?.thread_id || null;
}

function pickMessage(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'agent_message' || ev.type === 'item.completed') {
    return ev.text || ev.message || ev.item?.text || ev.item?.content || '';
  }
  return ev.agent_message || ev.message || null;
}

export function buildCodexArgs(opts, finalPath, local = {}) {
  const args = [];
  if (opts.resume) {
    // `codex exec resume` accepts neither -s/--sandbox nor -C/--cd (codex-cli 0.155.0-alpha.9.2),
    // so the read-only sandbox is pinned through the config override and the
    // working directory is set on the process.
    args.push('exec', 'resume', opts.resume, '--json', '-o', finalPath, '--output-schema', opts.schemaPath,
      '-c', 'sandbox_mode=read-only', '-c', `model_reasoning_effort=${opts.seat.effort}`);
    if (opts.seat.serviceTier) args.push('-c', `service_tier=${opts.seat.serviceTier}`);
    args.push('--skip-git-repo-check');
  } else {
    args.push('exec', '--json', '-o', finalPath, '--output-schema', opts.schemaPath,
      '-s', 'read-only', '-m', opts.seat.model, '-c', `model_reasoning_effort=${opts.seat.effort}`);
    if (opts.seat.serviceTier) args.push('-c', `service_tier=${opts.seat.serviceTier}`);
    args.push('-C', opts.projectDir, '--skip-git-repo-check');
  }
  if (local.codexIgnoreUserConfig) args.push('--ignore-user-config');
  args.push('-');
  return args;
}

export async function run(opts) {
  const bin = resolveSeatBinary('codex');
  const base = emptyAdapterResult(opts.callDir);
  if (!bin) return { ...base, status: 'unavailable', errorText: 'codex binary not found' };
  const finalPath = path.join(opts.callDir, 'final.txt');
  const args = buildCodexArgs(opts, finalPath, loadLocalJson());
  const spawned = await spawnSeat({
    bin,
    args,
    cwd: opts.projectDir,
    prompt: opts.prompt,
    env: opts.env || buildChildEnv({
      taskId: opts.taskId,
      callIndex: opts.callIndex,
      stripKeys: STRIP,
      stripWindowsApps: process.platform === 'win32',
    }),
    timeoutMs: opts.timeoutMs,
    stdoutPath: path.join(opts.callDir, 'stdout.txt'),
    stderrPath: path.join(opts.callDir, 'stderr.txt'),
    detachedGroup: true,
    ready: finalReady(finalPath, opts.isComplete),
  });
  const events = scanEvents(spawned.rawText);
  let rawText = '';
  if (fs.existsSync(finalPath)) {
    const t = readUtf8(finalPath).trim();
    if (t) rawText = t;
  }
  if (!rawText) rawText = events.lastText || spawned.rawText || '';
  const status = spawned.status === 'completed' && spawned.exitCode && !rawText ? 'failed' : spawned.status;
  return {
    ...base,
    status,
    exitCode: spawned.exitCode,
    signal: spawned.signal,
    rawText,
    sessionId: events.sessionId,
    usage: events.usage,
    durationMs: spawned.durationMs,
    errorText: spawned.errorText,
    endedBy: spawned.endedBy,
  };
}

// The declared output is `-o final.txt`, which codex writes when the turn ends. Once it holds a
// valid verdict the call is over, even if codex itself does not exit.
export function finalReady(finalPath, isComplete) {
  if (typeof isComplete !== 'function') return null;
  return () => {
    let text = '';
    try { text = readUtf8(finalPath).trim(); } catch { return false; }
    return Boolean(text) && isComplete(text);
  };
}
