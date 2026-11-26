#!/usr/bin/env node
// Shadow mode records delegation structure only and always exits cleanly. Enforce mode turns every fault or deny into a refusal.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { layout } from './lib/paths.mjs';
import { readJsonBounded } from './lib/fsx.mjs';
import { logRecord } from './lib/hooklog.mjs';
import { excludedIds, exclusionProblems } from './lib/receipts.mjs';
import { normalize, decide, refusalText, MODE, effectiveMode } from './lib/guard.mjs';

const PROCESS_STARTED_AT = Date.now();
export const STDIN_MAX_BYTES = 256 * 1024;
const SCRIPT = fileURLToPath(import.meta.url);

class HookInputError extends Error {
  constructor(kind, name) { super(); this.kind = kind; this.name = name; }
}

function deadlineFor(env) {
  const n = Number(env.FRONTDESK_HOOK_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

function readStdin(input, registerCancel = () => {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    const cleanup = () => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      input.removeListener('error', onError);
    };
    const finish = () => {
      if (settled) return;
      settled = true; cleanup();
      resolve(Buffer.concat(chunks, size).toString('utf8'));
    };
    registerCancel(() => {
      if (settled) return;
      settled = true; cleanup(); input.pause(); resolve(null);
    });
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > STDIN_MAX_BYTES) {
        settled = true; cleanup(); input.pause();
        reject(new HookInputError('payload_too_large', 'PayloadTooLargeError'));
      } else chunks.push(bytes);
    };
    const onEnd = () => finish();
    const onError = (error) => { if (!settled) { settled = true; cleanup(); reject(error); } };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('close', onEnd);
    input.once('error', onError);
    input.resume();
  });
}

async function loadContext(L, readFile) {
  const read = (file, fallback) => readJsonBounded(file, { fallback, maxBytes: 1024 * 1024, readFile });
  const cur = await read(L.current, null);
  if (!cur) return null;
  const dir = path.join(L.generations, cur.dir);
  const gc = await read(path.join(dir, 'guard-ctx.json'), null);
  if (!gc) return null;
  const helpers = (await read(path.join(dir, 'helpers.json'), { helpers: {} })).helpers || {};
  const receipt = await read(L.receipt, {});
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || exclusionProblems(receipt).length) throw Object.assign(new Error('invalid receipt exclusions'), { kind: 'receipt_invalid' });
  return { commissioned: new Set(gc.commissioned || []), helpers, excluded: excludedIds(receipt), generation: cur.generation ?? gc.generation, release: cur.release ?? gc.release };
}

const error = (name) => Object.assign(new Error(), { name });
const scriptPath = () => { try { return fs.realpathSync(SCRIPT); } catch { return SCRIPT; } };

export function runHook({ tool, input = process.stdin, env = process.env, L = layout(), logger = logRecord, stderr = process.stderr, startedAt = PROCESS_STARTED_AT, readFile = fs.promises.readFile } = {}) {
  const deadline = deadlineFor(env);
  let mode = env.FRONTDESK_GUARD_MODE === MODE.ENFORCE ? MODE.ENFORCE : MODE.SHADOW;
  return new Promise((resolve) => {
    let done = false;
    let watchdog, cancelInput = () => {}, cancelStage = () => {};
    const elapsed = () => Date.now() - startedAt;
    const refusal = (kind) => `Delegation guard fault (${kind}): refusing this delegation call. Run role doctor.`;
    const finish = (code, stderrText = null) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      cancelInput();
      cancelStage();
      if (!stderrText) { resolve(code); return; }
      let timedOut = false;
      const fallback = setTimeout(() => { timedOut = true; resolve(code); }, 25);
      try {
        stderr.write(stderrText + '\n', () => {
          if (timedOut) return;
          clearTimeout(fallback); resolve(code);
        });
      } catch { clearTimeout(fallback); resolve(code); }
    };
    const finishForMode = (kind) => finish(mode === MODE.ENFORCE ? 2 : 0, mode === MODE.ENFORCE ? refusal(kind) : null);
    const withDeadline = async (promise, cancel = () => {}) => {
      const left = deadline - elapsed();
      if (left <= 0) throw Object.assign(error('TimeoutError'), { kind: 'deadline' });
      let timer;
      try {
        return await Promise.race([
          Promise.resolve(promise),
          new Promise((_, reject) => { timer = setTimeout(() => { cancel(); reject(Object.assign(error('TimeoutError'), { kind: 'deadline' })); }, left); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    const fail = (kind, err) => {
      if (done) return;
      const code = mode === MODE.ENFORCE ? 2 : 0;
      const message = mode === MODE.ENFORCE ? refusal(kind) : null;
      if (elapsed() >= deadline) { finish(code, message); return; }
      const record = { tool, mode, fault: kind, errorName: String(err?.name || 'Error'), ms: Math.max(0, Math.round(elapsed())) };
      void withDeadline(Promise.resolve().then(() => logger(L, record))).catch(() => {}).finally(() => finish(code, message));
    };
    const checkDeadline = () => elapsed() < deadline;
    const write = async (record) => {
      if (!checkDeadline()) { finishForMode('deadline'); return false; }
      try { await withDeadline(Promise.resolve().then(() => logger(L, record))); }
      catch (e) { fail('log_write', e); return false; }
      if (done || !checkDeadline()) { finishForMode('deadline'); return false; }
      return true;
    };

    watchdog = setTimeout(() => finishForMode('deadline'), Math.max(0, deadline - elapsed()));

    void (async () => {
      try {
        const modeAbort = new AbortController();
        cancelStage = () => modeAbort.abort();
        try { mode = await withDeadline(effectiveMode(L, tool, env, { readFile: (file) => readFile(file, { signal: modeAbort.signal }) }), () => modeAbort.abort()); }
        catch (e) {
          if (done) return;
          // Phase 1a stays watch-only when the stored mode cannot be read; doctor and the installer surface the fault.
          fail(e.kind || 'exception', e);
          return;
        } finally { cancelStage = () => {}; }
        if (!checkDeadline()) { finishForMode('deadline'); return; }
        const raw = await withDeadline(readStdin(input, (cancel) => { cancelInput = cancel; }));
        if (done) return;
        if (!checkDeadline()) { finishForMode('deadline'); return; }
        let payload;
        try { payload = JSON.parse(raw); }
        catch (e) { fail('bad_payload', e); return; }
        if (!checkDeadline()) { finishForMode('deadline'); return; }
        const req = normalize(tool, payload, env);
        if (!checkDeadline()) { finishForMode('deadline'); return; }
        const contextAbort = new AbortController();
        cancelStage = () => contextAbort.abort();
        let ctx;
        try { ctx = await withDeadline(loadContext(L, (file) => readFile(file, { signal: contextAbort.signal })), () => contextAbort.abort()); }
        finally { cancelStage = () => {}; }
        if (done) return;
        if (!checkDeadline()) { finishForMode('deadline'); return; }
        if (!ctx) { fail('no_generation', error('NoGenerationError')); return; }
        const verdict = decide(req, ctx);
        if (!checkDeadline()) { finishForMode('deadline'); return; }
        const agentish = req.kind !== 'other' || /agent/i.test(req.name || '');
        const record = agentish
          ? { tool, event: req.event, kind: req.kind, name: req.name, sub: req.sub ?? null, names_model: !!req.namesModel, model: req.model ?? null,
            caller: req.callerIsSubagent ? 'subagent' : req.envWorker ? 'env-worker' : 'main', session: req.session, cwd: req.cwd, gen: ctx.generation, mode, decision: verdict.decision, reasons: verdict.reasons,
            wf: req.workflow ? { total: req.workflow.total, pinned: req.workflow.pinned, unpinned: req.workflow.unpinned, unreadable: req.workflow.unreadable, hash: req.workflow.hash } : undefined,
            ms: Math.max(0, Math.round(elapsed())) }
          : mode === MODE.SHADOW ? { tool, event: req.event, toolName: req.name, counts: { payloadKeys: Object.keys(payload || {}).length, toolInputKeys: Object.keys(payload?.tool_input || {}).length } } : null;
        if (record && !await write(record)) return;
        if (mode === MODE.ENFORCE && verdict.decision === 'deny') finish(2, refusalText(verdict.reasons));
        else finish(0);
      } catch (e) {
        if (done) return;
        if (e?.kind === 'deadline' || elapsed() >= deadline) { finishForMode('deadline'); return; }
        fail(e.kind || 'exception', e);
      }
    })();
  });
}

let isMain = false;
try { isMain = !!process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === scriptPath(); } catch { /* an unresolved entry point is not the main script */ }
if (isMain) process.exit(await runHook({ tool: process.argv[2], startedAt: PROCESS_STARTED_AT }));
