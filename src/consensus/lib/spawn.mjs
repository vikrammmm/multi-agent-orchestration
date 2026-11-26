import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fsx.mjs';
import { loadLocalJson } from './paths.mjs';

const MEM_CAP = 4 * 1024 * 1024;

export function quoteWinArg(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

export function resolveBinary(name, override) {
  if (override && fs.existsSync(override)) return path.resolve(override);
  if (name && path.isAbsolute(name) && fs.existsSync(name)) return name;
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const pathext = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const hasExt = Boolean(name && path.extname(name));
  for (const dir of dirs) {
    const candidates = [];
    if (hasExt) candidates.push(path.join(dir, name));
    else {
      for (const ext of pathext) candidates.push(path.join(dir, name + ext));
      if (process.platform !== 'win32') candidates.push(path.join(dir, name));
    }
    for (const c of candidates) {
      try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* skip */ }
    }
  }
  return null;
}

export function resolveSeatBinary(binaryName) {
  const local = loadLocalJson();
  const override = local.binaries && local.binaries[binaryName];
  return resolveBinary(binaryName, override || null);
}

function isCmdLauncher(bin) {
  const ext = path.extname(bin).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

const WINDOWS_APPS_ENTRY = /(^|[\\/])WindowsApps([\\/]|$)/i;

export function buildChildEnv({ taskId, callIndex, stripKeys, stripWindowsApps }) {
  const env = { ...process.env };
  // Environment names are case-insensitive on Windows and the spread copy keeps the stored
  // casing, so the API-key variables are removed by case-insensitive comparison everywhere.
  const strip = new Set((stripKeys || []).map((k) => String(k).toLowerCase()));
  for (const key of Object.keys(env)) {
    if (strip.has(key.toLowerCase())) delete env[key];
  }
  env.CONSENSUS_SEAT = '1';
  if (taskId) env.CONSENSUS_TASK_ID = String(taskId);
  if (callIndex != null) env.CONSENSUS_CALL = String(callIndex);
  if (stripWindowsApps) {
    // The key may be spelled PATH or Path; rewrite every spelling.
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() !== 'PATH') continue;
      env[key] = String(env[key]).split(path.delimiter)
        .filter((p) => !WINDOWS_APPS_ENTRY.test(p))
        .join(path.delimiter);
    }
  }
  return env;
}

// How a seat call ends (`endedBy` in the call's meta.json; SPEC section 10, guard 5):
//   exit             the process exited and its output pipes closed: the normal case;
//   output-ready     the adapter's declared output was complete and valid, but the process was
//                    still running SETTLE_MS later, so the referee killed its tree;
//   exit-pipes-held  the process exited, but something it left behind kept the output pipes
//                    open, so the referee stopped reading PIPE_GRACE_MS after the exit (what was
//                    left in the seat's process group is killed at the exit, POSIX only);
//   timeout          the watchdog expired and the referee killed the tree.
// After a kill the referee waits at most PIPE_GRACE_MS for the pipes and then closes its own
// ends, so neither a process that survives the kill nor one outside the tree that still holds a
// pipe can keep a call, and with it the task, waiting.
const SETTLE_MS = 20 * 1000;
const PIPE_GRACE_MS = 5 * 1000;
const READY_POLL_MS = 1000;
const TASKKILL_MS = 15 * 1000;

// CONSENSUS_SEAT_SETTLE_MS (used by the tests) may shorten the settle time, never lengthen it.
export function settleMs() {
  const env = process.env.CONSENSUS_SEAT_SETTLE_MS;
  if (env && String(env).trim()) {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return Math.min(n, SETTLE_MS);
  }
  return SETTLE_MS;
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Only while the root still runs: until Node has seen its exit it holds the process handle,
    // so the pid cannot belong to another program yet. The timeout keeps a stuck taskkill from
    // holding the referee.
    if (hasExited(child)) return;
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: TASKKILL_MS });
    return;
  }
  // The seat leads its own process group (detachedGroup).
  try { process.kill(-child.pid, 'SIGKILL'); } catch {
    if (!hasExited(child)) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

// Called as the seat's exit is reported: whatever is still in its process group was left behind
// by it. Only now is the group id certainly still the seat's; a few seconds later an emptied
// group's number could belong to another program. Windows has no safe equivalent for an exited
// root, so there the referee only stops reading.
function killLeftovers(child, detachedGroup) {
  if (process.platform === 'win32' || !detachedGroup || !child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* nothing left */ }
}

function spawnSpec(bin, args, opts) {
  if (process.platform === 'win32' && isCmdLauncher(bin)) {
    const quoted = [bin, ...args].map(quoteWinArg).join(' ');
    return {
      file: process.env.ComSpec || 'cmd.exe',
      argv: ['/d', '/s', '/c', `"${quoted}"`],
      extra: { windowsVerbatimArguments: true, windowsHide: true },
    };
  }
  return { file: bin, argv: args, extra: process.platform === 'win32' ? { windowsHide: true } : {} };
}

// `ready({ stdout })`, when given, says whether the seat's declared output is complete and valid
// (`stdout()` returns the output so far). It is polled while the process runs; once it holds, the
// process gets `settleAfterMs` to exit on its own before the referee ends the call itself.
export function spawnSeat({
  bin, args, cwd, prompt, env, timeoutMs, stdoutPath, stderrPath, detachedGroup,
  ready = null, settleAfterMs = settleMs(), graceMs = PIPE_GRACE_MS,
}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = { chunks: [], size: 0, open: true };
    const err = { chunks: [], size: 0, open: true };
    ensureDir(path.dirname(stdoutPath));
    ensureDir(path.dirname(stderrPath));
    const outFd = fs.openSync(stdoutPath, 'w');
    const errFd = fs.openSync(stderrPath, 'w');
    const spec = spawnSpec(bin, args, {});
    const childOpts = {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...spec.extra,
    };
    if (detachedGroup && process.platform !== 'win32') childOpts.detached = true;
    let child;
    try {
      child = spawn(spec.file, spec.argv, childOpts);
    } catch (e) {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      resolve(finish('unavailable', started, null, null, '', e.message || String(e)));
      return;
    }
    let settled = false;
    let ending = null; // 'timeout' or 'output-ready' once the referee ends the call itself
    let readyAt = null;
    let exitCode = null;
    let exitSignal = null;
    const timers = [];
    const after = (ms, fn) => { timers.push(setTimeout(fn, ms)); };

    child.on('error', (e) => {
      if (settled) return;
      const status = e && e.code === 'ENOENT' ? 'unavailable' : 'failed';
      settle(status, null, null, e.message || String(e), 'spawn-error');
    });
    after(timeoutMs || 45 * 60 * 1000, () => {
      // An exited process is already being wound up by its exit grace (below).
      if (hasExited(child)) return;
      // A declared output that is already complete stands, even when the watchdog expires.
      end(readyAt || isReady() ? 'output-ready' : 'timeout');
    });
    if (typeof ready === 'function') {
      const poll = setInterval(() => {
        if (settled || ending || hasExited(child) || !isReady()) return;
        clearInterval(poll);
        readyAt = Date.now();
        after(settleAfterMs, () => { if (!hasExited(child)) end('output-ready'); });
      }, READY_POLL_MS);
      timers.push(poll);
    }

    pipe(child.stdout, outFd, out);
    pipe(child.stderr, errFd, err);
    // A child that exits before reading its input makes stdin emit EPIPE; without a listener
    // that would crash the referee in the middle of a call.
    if (child.stdin) child.stdin.on('error', () => { /* child closed its input early */ });
    try {
      child.stdin.end(prompt == null ? '' : String(prompt), 'utf8');
    } catch { /* closed */ }

    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      if (settled || ending) return;
      killLeftovers(child, detachedGroup);
      // 'close' normally follows at once. A pipe still open after the grace belongs to something
      // the seat left behind outside its group: stop reading.
      after(graceMs, () => {
        if (settled || ending) return;
        stopReading('exit-pipes-held', '');
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      const why = ending || 'exit';
      settle(why === 'timeout' ? 'timeout' : 'completed', code ?? exitCode, signal ?? exitSignal,
        why === 'timeout' ? 'watchdog expired' : '', why);
    });

    function isReady() {
      if (typeof ready !== 'function') return false;
      try { return Boolean(ready({ stdout: () => mem(out) })); } catch { return false; }
    }

    function end(why) {
      if (settled || ending) return;
      ending = why;
      killTree(child);
      after(graceMs, () => stopReading(why, why === 'timeout'
        ? 'watchdog expired; the output pipes were still open after the process tree was killed'
        : ''));
    }

    function stopReading(why, errorText) {
      if (settled) return;
      for (const s of [child.stdout, child.stderr, child.stdin]) {
        try { if (s) s.destroy(); } catch { /* */ }
      }
      try { child.unref(); } catch { /* */ }
      settle(why === 'timeout' ? 'timeout' : 'completed', exitCode, exitSignal, errorText, why);
    }

    function settle(status, code, signal, errorText, why) {
      settled = true;
      for (const t of timers) clearTimeout(t);
      out.open = false;
      err.open = false;
      try { fs.closeSync(outFd); } catch { /* */ }
      try { fs.closeSync(errFd); } catch { /* */ }
      resolve(finish(status, started, code, signal, mem(out), errorText, why));
    }
  });
}

function pipe(stream, fd, bag) {
  if (!stream) return;
  stream.on('data', (buf) => {
    // After the call has ended the descriptor is closed and its number may be reused.
    if (!bag.open) return;
    try { fs.writeSync(fd, buf); } catch { /* */ }
    if (bag.size < MEM_CAP) {
      const take = buf.subarray(0, MEM_CAP - bag.size);
      bag.chunks.push(take);
      bag.size += take.length;
    }
  });
}

function mem(bag) {
  return Buffer.concat(bag.chunks, bag.size).toString('utf8');
}

function finish(status, started, exitCode, signal, rawText, errorText, endedBy = null) {
  return {
    status,
    exitCode,
    signal,
    rawText: rawText || '',
    errorText: errorText || '',
    durationMs: Date.now() - started,
    endedBy,
  };
}

// First line of `<bin> --version` (stdout or stderr), or null. No tokens are spent.
export function binaryVersion(bin, timeoutMs = 8000) {
  const opts = { encoding: 'utf8', timeout: timeoutMs, windowsHide: true };
  let r;
  if (process.platform === 'win32' && isCmdLauncher(bin)) {
    const quoted = [bin, '--version'].map(quoteWinArg).join(' ');
    r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${quoted}"`], { ...opts, windowsVerbatimArguments: true });
  } else {
    r = spawnSync(bin, ['--version'], opts);
  }
  return ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/)[0] || null;
}

function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// true, false, or null when either side carries no x.y.z version.
export function versionAtLeast(text, min) {
  const a = parseVersion(text);
  const b = parseVersion(min);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

export function emptyAdapterResult(callDir) {
  return {
    status: 'failed',
    exitCode: null,
    signal: null,
    stdoutPath: path.join(callDir, 'stdout.txt'),
    stderrPath: path.join(callDir, 'stderr.txt'),
    rawText: '',
    sessionId: null,
    usage: null,
    durationMs: 0,
    errorText: '',
    flagsDropped: [],
    endedBy: null,
  };
}
