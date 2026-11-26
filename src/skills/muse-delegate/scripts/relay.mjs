#!/usr/bin/env node
/**
 * muse-delegate · relay.mjs
 *
 * Dispatch a coding brief to the Meta Muse CLI (`muse exec --json`) and write
 * a structured result.json the orchestrator can review.
 *
 * Usage:
 *   node relay.mjs --brief <file> [--cd <dir>] [--lane <name>]
 *                  [--model <id>] [--effort <level>] [--read-only]
 *                  [--session <id>] [--resume-last]
 *                  [--provider <mode>] [--timeout <dur>] [--out-dir <dir>]
 *
 * Options:
 *   --brief <file>        Path to the brief (or pipe on stdin).
 *   --prompt-file <file>  Alias for --brief.
 *   --cd <dir>            Working directory for muse (default: cwd).
 *   --lane <name>         Fleet lane from delegate-setup; dials apply; flags win.
 *   --model <id>          Muse model id (e.g. muse-spark-1.3).
 *   --effort <level>      Reasoning effort: none|minimal|low|medium|high|xhigh|max|ultra.
 *   --reasoning-effort    Alias for --effort.
 *   --read-only           Pass --disable-write to muse.
 *   --session <uuid>      Continue a specific session (muse exec --session-id <uuid>).
 *   --resume-last         Continue the most recent session in --cd (found via
 *                         muse export --last, then muse exec --session-id).
 *   --provider <mode>     Pass --provider <mode> to muse exec (e.g. echo for testing).
 *   --timeout <dur>       Watchdog duration (default: 30m; e.g. 2h, 45m).
 *   --out-dir <dir>       Artifact directory (default: system temp).
 *   -h, --help            Print this help.
 *
 * Result (result.json):
 *   schema, tool, status, ok, exitCode, sessionId, model, effort, readOnly,
 *   finalText, rawEventCount, museVersion, museVersionCheck, lane, startedAt,
 *   finishedAt, briefPath, eventsPath, stderrPath, sentToModels,
 *   contributorCheck, museContributorSetting, modelWarning (when set),
 *   museStopped (when the relay stopped muse, or could not confirm that what
 *   muse started is gone), museLeftRunning (when muse left processes running
 *   at its end: a count on Windows, true elsewhere), error (on failure).
 *
 * Meta's contributor tier (Meta may use the content to train its models) is
 * banned for team work. Every run passes --contributor-mode off, which wins
 * over the machine's own Muse setting and the MUSE_CONTRIBUTOR_MODE variable
 * for that run. A Muse older than 1.4.15 is refused
 * before it runs (status muse_too_old); a Muse that refuses the flag anyway
 * fails the run, which is never retried without it. The relay also removes
 * MUSE_CONTRIBUTOR_MODE from muse's environment. A --model, lane model or
 * --provider that names the contributor tier is refused before muse starts.
 * The model ids muse reports actually sending requests to are recorded in
 * sentToModels; if any of them is a contributor model anyway, the relay stops
 * muse and every process it started, and reports status
 * "contributor_tier_used". That stop is a backstop: muse reports the model
 * only after a request was answered. contributorCheck says what the stream
 * showed: verified (only standard models), unverified (muse reported no model
 * at all: stop and tell the person), contributor_tier_used, not_sent (muse
 * provably never sent anything: it refused the flag before its first event, it
 * was never started, or the Windows guard could not be set up) or
 * not_applicable (echo provider).
 *
 * Stopping muse: on Windows muse runs inside a job object held by a small
 * PowerShell guard started by the relay, so every process muse starts stays in
 * the job, also after muse itself has ended; a stop ends the whole job and is
 * confirmed by the job's own count of running processes. Processes muse leaves
 * running when it ends are stopped too (museLeftRunning says how many), and if
 * the relay itself dies, the job ends with it. The guard starts muse suspended
 * and lets it run only after it has recorded that; it refuses to start muse
 * (exit 97, status "unavailable") when it cannot watch the relay, when
 * PowerShell runs in Constrained Language Mode (WDAC or AppLocker), or when any
 * step of setting up the job fails. Elsewhere muse leads its own process group,
 * which the relay stops with SIGTERM, then SIGKILL, also when muse ends and
 * leaves something in the group running; if the relay gets SIGINT, SIGTERM or
 * SIGHUP it stops that group first (status cancelled). A relay killed with
 * SIGKILL cannot stop anything (POSIX). museStopped is true only when the stop
 * was confirmed.
 *
 * Exit codes: 2 = usage error (no result written); 127 = muse not found;
 *   1 = session_not_found or muse_too_old (muse not run), muse or the Windows
 *   guard could not be started (muse not run; the guard itself exits 97);
 *   3 = contributor_tier_used (muse stopped); 124 = timeout (muse stopped);
 *   129 / 130 / 143 / 149 = cancelled by SIGHUP / SIGINT / SIGTERM / SIGBREAK;
 *   0 = completed; non-zero mirrors muse's exit on failure.
 *
 * Several turns in one call: muse may add a turn of its own (for example when
 * a shell command it moved to the background finishes after it answered).
 * finalText then joins every turn's text in order, each under a
 * "--- muse turn N of M ---" line, and result.json gains a warning field.
 */

import { spawn, spawnSync, execSync } from "node:child_process";
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, rmSync,
} from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";

const DEFAULT_TIMEOUT = "30m";
const IMPLEMENTER_KEY = "muse";
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MUSE_EFFORT = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Any model id that names Meta's contributor tier (e.g. muse-spark-1.3-contributor).
const CONTRIBUTOR_ID = /contributor/i;
const CONTRIBUTOR_EXIT = 3;
// The relay requires Muse 1.4.15 or newer for --contributor-mode off.
const MUSE_MIN_VERSION = "1.4.15";

// The environment every muse process gets: no self-update during a job, and no inherited
// MUSE_CONTRIBUTOR_MODE (it can switch the contributor tier on; the flag wins anyway).
function museEnv(extra = {}) {
  const env = { ...process.env, MUSE_UPDATE_INTERVAL_SECONDS: "999999", ...extra };
  for (const k of Object.keys(env)) if (k.toUpperCase() === "MUSE_CONTRIBUTOR_MODE") delete env[k];
  return env;
}

// This machine's own Muse setting, read only, for result.json: on | off | absent | unreadable.
function museContributorSetting() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const file = join(base, "muse", "settings.json");
  if (!existsSync(file)) return "absent";
  try {
    return JSON.parse(readFileSync(file, "utf8")).contributor_mode_enabled === true ? "on" : "off";
  } catch {
    return "unreadable";
  }
}

// Windows: muse runs through cmd, muse.cmd, a PowerShell launcher and the real binary, and anything it starts can
// outlive it, so neither killing the direct child nor taskkill /t on a pid that may already be gone is enough. The
// relay starts this guard instead: it creates a job object that ends every process inside it when the job's last
// handle closes (so also when the guard or the relay dies), starts muse suspended in the working directory it is
// given, puts it in the job, records that in the status file and only then lets it run. Everything muse starts is in
// the job from its first instruction. When muse ends, when the relay asks (stop file) or when the relay is gone, the
// guard ends the whole job, waits until the job counts no running process, writes what happened to the status file
// and exits with muse's exit code. It writes nothing to stdout, which is muse's event stream.
// Exit 97 with status "unavailable": muse was not started (or was started suspended and ended before it ran): the
// guard runs in Constrained Language Mode, cannot watch the relay, or a step of setting up the job failed. The
// status file is written with cmdlets only, so that this also works in Constrained Language Mode.
const GUARD_EXIT = 97;
const GUARD_PS = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$statusFile = $env:MUSE_RELAY_GUARD_STATUS
$stopFile = $env:MUSE_RELAY_GUARD_STOP
$cmdLine = $env:MUSE_RELAY_GUARD_CMD
$workDir = $env:MUSE_RELAY_GUARD_CWD
$parentPid = $env:MUSE_RELAY_GUARD_PARENT
function Write-Status($o) {
  $tmp = $statusFile + '.tmp'
  Set-Content -LiteralPath $tmp -Value (ConvertTo-Json -InputObject $o -Compress) -Encoding Ascii
  Move-Item -LiteralPath $tmp -Destination $statusFile -Force
}
function Stop-Unavailable($why) {
  try { [Console]::Error.WriteLine('relay guard: ' + $why) } catch { }
  try { Write-Status @{ guard = 'unavailable'; error = [string]$why } } catch { }
  exit 97
}
$mode = '' + $ExecutionContext.SessionState.LanguageMode
if ($mode -ne 'FullLanguage') {
  Stop-Unavailable ('Windows PowerShell runs in ' + $mode + ' on this machine (WDAC or AppLocker), which blocks the guard')
}
try {
  foreach ($n in 'MUSE_RELAY_GUARD_STATUS', 'MUSE_RELAY_GUARD_STOP', 'MUSE_RELAY_GUARD_CMD', 'MUSE_RELAY_GUARD_CWD', 'MUSE_RELAY_GUARD_PARENT') { [Environment]::SetEnvironmentVariable($n, $null) }
} catch { Stop-Unavailable ('cannot clear its own settings: ' + $_.Exception.Message) }
try { $relay = [Diagnostics.Process]::GetProcessById([int]$parentPid); $null = $relay.Handle }
catch { Stop-Unavailable ('cannot watch the relay process ' + $parentPid + ': ' + $_.Exception.Message) }
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MuseRelayGuard {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long A, B; public uint LimitFlags; public UIntPtr C, D; public uint E; public UIntPtr F; public uint G, H; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct Ext { public Basic B; public Io I; public UIntPtr A, C, D, E; }
  [StructLayout(LayoutKind.Sequential)] struct Acct { public long A, B, C, D; public uint E, TotalProcesses, ActiveProcesses, F; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Si { public int cb; public string r, d, t; public int x, y, w, h, cx, cy, fill, flags; public short show, r2; public IntPtr r3, stdIn, stdOut, stdErr; }
  [StructLayout(LayoutKind.Sequential)] struct Pi { public IntPtr process, thread; public int pid, tid; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref Ext i, int l);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int c, out Acct i, int l, IntPtr r);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr j, uint code);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref Si si, out Pi pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr p, uint c);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr p, out uint c);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static IntPtr job, proc, thread;
  public static int Pid;
  static Exception Fail(string what) { return new Exception(what + " failed (Windows error " + Marshal.GetLastWin32Error() + ")"); }
  // Creates the job and muse's first process, suspended and inside the job; Resume lets it run.
  public static void Start(string cmdLine, string dir) {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw Fail("CreateJobObject");
    Ext e = new Ext();
    e.B.LimitFlags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref e, Marshal.SizeOf(typeof(Ext)))) throw Fail("SetInformationJobObject");
    Si si = new Si();
    si.cb = Marshal.SizeOf(typeof(Si));
    si.flags = 0x100;
    si.stdIn = GetStdHandle(-10); si.stdOut = GetStdHandle(-11); si.stdErr = GetStdHandle(-12);
    foreach (IntPtr h in new IntPtr[] { si.stdIn, si.stdOut, si.stdErr }) {
      if (h != IntPtr.Zero && h != new IntPtr(-1) && !SetHandleInformation(h, 1, 1)) throw Fail("SetHandleInformation");
    }
    Pi pi;
    if (!CreateProcess(null, new System.Text.StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, true, 0x4, IntPtr.Zero,
        String.IsNullOrEmpty(dir) ? null : dir, ref si, out pi)) throw Fail("CreateProcess");
    if (!AssignProcessToJobObject(job, pi.process)) {
      int err = Marshal.GetLastWin32Error();
      TerminateProcess(pi.process, 97);
      throw new Exception("AssignProcessToJobObject failed (Windows error " + err + ")");
    }
    proc = pi.process; thread = pi.thread; Pid = pi.pid;
  }
  public static void Resume() {
    if (ResumeThread(thread) == 0xFFFFFFFF) {
      int err = Marshal.GetLastWin32Error();
      TerminateJobObject(job, 97);
      throw new Exception("ResumeThread failed (Windows error " + err + ")");
    }
    CloseHandle(thread);
  }
  public static bool Exited(uint ms) { return WaitForSingleObject(proc, ms) == 0; }
  public static int ExitCode() { uint c; GetExitCodeProcess(proc, out c); return unchecked((int)c); }
  public static int Active() { Acct a; return QueryInformationJobObject(job, 1, out a, Marshal.SizeOf(typeof(Acct)), IntPtr.Zero) ? (int)a.ActiveProcesses : -1; }
  public static void Kill() { TerminateJobObject(job, 1); }
  // After Kill: waits up to ms for the job to count no running process, and returns the last count.
  public static int WaitEmpty(int ms) {
    int a = Active();
    for (int waited = 0; a != 0 && waited < ms; waited += 100) { System.Threading.Thread.Sleep(100); a = Active(); }
    return a;
  }
}
'@
} catch { Stop-Unavailable ('cannot load the job object code (Add-Type): ' + $_.Exception.Message) }
try { [MuseRelayGuard]::Start($cmdLine, $workDir) } catch { Stop-Unavailable ([string]$_.Exception.Message) }
if (Test-Path -LiteralPath $stopFile) {
  $inJob = [MuseRelayGuard]::Active()
  [MuseRelayGuard]::Kill()
  $active = [MuseRelayGuard]::WaitEmpty(10000)
  Write-Status @{ guard = 'job'; state = 'ended'; reason = 'stop-requested'; started = $false; museExit = 1; inJobAtEnd = $inJob; active = $active }
  exit 1
}
try { Write-Status @{ guard = 'job'; state = 'running'; pid = [MuseRelayGuard]::Pid } }
catch { [MuseRelayGuard]::Kill(); Stop-Unavailable ('cannot write its status file: ' + $_.Exception.Message) }
try { [MuseRelayGuard]::Resume() } catch { Stop-Unavailable ([string]$_.Exception.Message) }
$reason = 'muse-exited'
while (-not [MuseRelayGuard]::Exited(200)) {
  if (Test-Path -LiteralPath $stopFile) { $reason = 'stop-requested'; break }
  if ($relay.HasExited) { $reason = 'relay-gone'; break }
}
$code = 1
if ($reason -eq 'muse-exited') { $code = [MuseRelayGuard]::ExitCode() }
$inJob = [MuseRelayGuard]::Active()
[MuseRelayGuard]::Kill()
$active = [MuseRelayGuard]::WaitEmpty(10000)
Write-Status @{ guard = 'job'; state = 'ended'; reason = $reason; started = $true; pid = [MuseRelayGuard]::Pid; museExit = $code; inJobAtEnd = $inJob; active = $active }
exit $code
`;

// The guard runs in the artifact folder; muse gets the working directory explicitly (lpCurrentDirectory).
function startGuarded(cmd, { cwd, env, stopFile, statusFile }) {
  const ps = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const comspec = process.env.ComSpec || "cmd.exe";
  return spawn(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(GUARD_PS, "utf16le").toString("base64")], {
    cwd: dirname(statusFile), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: {
      ...env,
      MUSE_RELAY_GUARD_CMD: `"${comspec}" /d /s /c "${cmd}"`, MUSE_RELAY_GUARD_CWD: cwd,
      MUSE_RELAY_GUARD_STATUS: statusFile, MUSE_RELAY_GUARD_STOP: stopFile, MUSE_RELAY_GUARD_PARENT: String(process.pid),
    },
  });
}

function readGuardStatus(guard) {
  try { return JSON.parse(readFileSync(guard.statusFile, "utf8")); } catch { return null; }
}

function alive(pid, group = false) {
  try { process.kill(group ? -pid : pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function waitUntil(check, ms) {
  return new Promise((done) => {
    const end = Date.now() + ms;
    const tick = () => { if (check()) done(true); else if (Date.now() >= end) done(false); else setTimeout(tick, 100); };
    tick();
  });
}
// Stop muse and every process it started; resolves true only once that is confirmed.
// Windows: ask the guard (stop file) and take its word, which comes from the job's own process count; a guard that
// does not answer is killed, which ends its job too, but nothing is left to confirm that, so it counts as unconfirmed.
// The guard is the relay's direct child and is never signalled after it has exited.
// POSIX: muse leads its own process group. Its id stays reserved while any member of the group lives, so the group
// can be signalled after muse itself has ended without reaching anything else.
async function stopMuse(child, guard) {
  if (!child || !child.pid) return true;
  const running = () => child.exitCode === null && child.signalCode === null;
  if (guard) {
    if (running()) {
      try { writeFileSync(guard.stopFile, "stop\n"); } catch { /* the wait below decides */ }
      if (!(await waitUntil(() => !running(), 20_000))) {
        try { child.kill(); } catch { /* gone */ }
        return false;
      }
    }
    const st = readGuardStatus(guard);
    return st?.state === "ended" && st.active === 0;
  }
  const pid = child.pid;
  const signal = (sig) => { try { process.kill(-pid, sig); } catch { if (running()) { try { child.kill(sig); } catch { /* gone */ } } } };
  signal("SIGTERM");
  if (await waitUntil(() => !alive(pid, true), 2_000)) return true;
  signal("SIGKILL");
  return waitUntil(() => !alive(pid, true), 5_000);
}

// Exit codes for a relay stopped by a signal (128 + the signal's number).
const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGBREAK: 149 };

// The first x.y.z in `muse --version`, compared with MUSE_MIN_VERSION: "ok", "old" or "unparsed".
function versionCheck(version) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version || "");
  if (!m) return "unparsed";
  const have = m.slice(1).map(Number);
  const need = MUSE_MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (have[i] !== need[i]) return have[i] > need[i] ? "ok" : "old";
  return "ok";
}
const FRESH_RUN_HINT = "Start a fresh run instead (no --session / --resume-last) "
  + "with a full brief that restates all needed context.";

function fail(msg, code = 2) {
  process.stderr.write(`relay: ${msg}\n`);
  process.exit(code);
}

function parseDuration(s) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const ms = (BigInt(m[1] || 0) * 3600n + BigInt(m[2] || 0) * 60n + BigInt(m[3] || 0)) * 1000n;
  return ms > 0n && ms <= 2_147_483_647n ? Number(ms) : null;
}

function applyLane(opts, flagged) {
  if (!opts.lane) return;
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../delegate-setup/scripts/lane.mjs",
  );
  if (!existsSync(script)) fail("--lane requires delegate-setup installed beside this relay");
  const r = spawnSync(
    process.execPath,
    [script, "resolve", "--cwd", opts.cd, "--lane", opts.lane, "--implementer", IMPLEMENTER_KEY],
    { encoding: "utf8", env: process.env },
  );
  if (r.status !== 0) {
    fail((r.stderr || "lane resolve failed").trim().replace(/^lane\.mjs:\s*/, ""));
  }
  let resolved;
  try {
    const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
    resolved = JSON.parse(lines[lines.length - 1]);
  } catch {
    fail("lane resolve returned invalid JSON");
  }
  for (const [k, v] of Object.entries(resolved.dials || {})) {
    if (!flagged.has(k)) opts[k] = v;
  }
}

function parseArgs(argv) {
  const flagged = new Set();
  const opts = {
    lane: null, cd: process.cwd(), brief: null,
    model: null, effort: null, readOnly: false,
    session: null, resumeLast: false,
    provider: null, timeout: DEFAULT_TIMEOUT, outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) fail(`${a} requires a value`);
      i += 1;
      return v;
    };
    switch (a) {
      case "-h": case "--help": {
        const src = readFileSync(new URL(import.meta.url), "utf8");
        const m = src.match(/\/\*\*([\s\S]*?)\*\//);
        process.stdout.write(m ? `${m[1].replace(/^\s*\* ?/gm, "").trim()}\n` : "relay.mjs\n");
        process.exit(0);
        break;
      }
      case "--brief": case "--prompt-file": opts.brief = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--lane": opts.lane = next(); break;
      case "--model": opts.model = next(); flagged.add("model"); break;
      case "--effort": case "--reasoning-effort": opts.effort = next(); flagged.add("effort"); break;
      case "--read-only": opts.readOnly = true; flagged.add("readOnly"); break;
      case "--session": opts.session = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--provider": opts.provider = next(); break;
      case "--timeout": opts.timeout = next(); flagged.add("timeout"); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      default: fail(`unknown option: ${a}`);
    }
  }
  applyLane(opts, flagged);
  if (opts.model && !SAFE_MODEL.test(opts.model)) {
    fail("--model contains unsupported characters (allowed: letters, digits, . _ : -)");
  }
  if (opts.model && CONTRIBUTOR_ID.test(opts.model)) {
    fail(`--model ${opts.model} is Meta's contributor tier, which may train on your data and is banned; `
      + "use the standard id (for example muse-spark-1.3)");
  }
  if (opts.provider && !SAFE_MODEL.test(opts.provider)) {
    fail("--provider contains unsupported characters (allowed: letters, digits, . _ : -)");
  }
  if (opts.provider && CONTRIBUTOR_ID.test(opts.provider)) {
    fail(`--provider ${opts.provider} names Meta's contributor tier, which may train on your data and is banned`);
  }
  if (opts.effort && !MUSE_EFFORT.has(opts.effort)) {
    fail(`--effort must be one of: ${[...MUSE_EFFORT].join(", ")}`);
  }
  if (parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid; use a positive h/m/s duration`);
  }
  if (opts.resumeLast && opts.session) {
    fail("--resume-last and --session are mutually exclusive");
  }
  if (opts.session && !SESSION_UUID.test(opts.session)) {
    fail(`--session needs a session UUID (result.json sessionId), got "${opts.session}"; `
      + "muse continues sessions headlessly only by UUID");
  }
  return opts;
}

function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function museVersion() {
  try {
    return execSync("muse --version", { encoding: "utf8", shell: true, timeout: 10_000, env: museEnv() })
      .trim().split(/\r?\n/)[0] || "unknown";
  } catch {
    return null;
  }
}

// `muse resume` is interactive-only (it rejects --json), so a follow-up runs
// `muse exec --session-id <uuid>`, which appends a turn to that session. For an
// unknown id that flag silently starts a blank session, so first confirm the
// session exists (or, for --resume-last, find the newest one in --cd) with
// `muse export`, which reads only local files. Returns { id } or { error }.
function resolveSession(opts, outDir) {
  const lookupPath = join(outDir, "session-lookup.json");
  const target = opts.resumeLast ? "--last" : `--session "${opts.session}"`;
  const r = spawnSync(`muse export ${target} --out "${lookupPath}"`, {
    cwd: opts.cd, shell: true, encoding: "utf8", timeout: 120_000,
    env: museEnv(),
  });
  let id = null;
  if (r.status === 0) {
    try {
      const sessions = JSON.parse(readFileSync(lookupPath, "utf8")).sessions || [];
      const root = sessions.find((s) => s.session_id === s.root_session_id) || sessions[0];
      id = opts.session || root?.session_id || null;
    } catch { /* unreadable export: treated as not found */ }
  }
  // The export is a full transcript copy; only the id was needed.
  rmSync(lookupPath, { force: true });
  if (id && SESSION_UUID.test(id)) return { id };
  const why = (r.error?.message || r.stderr || r.stdout || "").trim().split(/\r?\n/)[0]
    || `muse export exited with code ${r.status}`;
  const which = opts.resumeLast ? `the most recent session in ${opts.cd}` : `session ${opts.session}`;
  return { error: `cannot continue ${which}: ${why}. ${FRESH_RUN_HINT}` };
}

function buildCmd(opts, briefPath, sessionId) {
  // muse is a .cmd shim; spawn via shell:true. Values are quoted for cmd.exe.
  const q = (v) => `"${v}"`;
  const parts = ["muse", "exec"];
  if (opts.provider) parts.push("--provider", opts.provider);
  if (sessionId) parts.push("--session-id", sessionId);
  parts.push("--json", "--approval-mode", "never", "--trust-workspace");
  // Never Meta's contributor tier, whatever ~/.config/muse/settings.json says (this run only; not persisted).
  parts.push("--contributor-mode", "off");
  parts.push("--prompt-file", q(briefPath));
  // --model and --reasoning-effort are meta-provider flags; skip them for echo.
  const isEcho = opts.provider === "echo";
  if (opts.model && !isEcho) parts.push("--model", opts.model);
  if (opts.effort && !isEcho) parts.push("--reasoning-effort", opts.effort);
  if (opts.readOnly) parts.push("--disable-write");
  return parts.join(" ");
}

// The model ids muse reports sending requests to: provider facets look like
// {"kind":"provider","provider":"meta","request_id":...,"model":"muse-spark-1.3"}.
// Walks the whole event so a change of nesting does not hide them.
function collectSentModels(node, into, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return;
  if (Array.isArray(node)) { for (const x of node) collectSentModels(x, into, depth + 1); return; }
  if (node.kind === "provider" && typeof node.model === "string") into.add(node.model);
  for (const v of Object.values(node)) if (v && typeof v === "object") collectSentModels(v, into, depth + 1);
}

function writeResult(resultPath, fields) {
  writeFileSync(resultPath, `${JSON.stringify(fields, null, 2)}\n`, "utf8");
  return fields;
}

// One `muse exec` can run more than one turn: when a shell command muse moved
// to the background finishes after it has answered, its runtime submits a turn
// of its own (client_id "muse-runtime-background-terminal", empty prompt).
// Turns are keyed by command_id in arrival order. Each keeps its closing text
// (run.terminal.completed payload.text) and its streamed run.output.delta
// text, which stands in when the turn was cut off before it closed.
function trackTurn(turns, ev) {
  const type = ev?.payload_type;
  if (type !== "runtime.command.accepted" && type !== "run.output.delta"
    && type !== "run.terminal.completed") return;
  const id = ev.payload?.command_id || ev.causation_id || "unknown";
  if (!turns.has(id)) turns.set(id, { clientId: null, streamed: "", closing: null });
  const turn = turns.get(id);
  const text = typeof ev.payload?.text === "string" ? ev.payload.text : "";
  if (type === "runtime.command.accepted") turn.clientId = ev.payload?.client_id || null;
  else if (type === "run.output.delta") turn.streamed += text;
  else turn.closing = text;
}

// finalText and warning for result.json. One turn gives its text exactly as
// before; several are joined in order under a header line each, so a later
// turn's short note no longer replaces the answer that came before it.
function summarizeTurns(turns) {
  const list = [...turns.values()].map((t, i) => ({ ...t, n: i + 1, text: t.closing || t.streamed }));
  if (list.length <= 1) return { finalText: list[0]?.text ?? "", warning: null };
  const header = (t) => `--- muse turn ${t.n} of ${list.length}`
    + `${t.clientId ? ` (started by muse itself: ${t.clientId})` : ""} ---`;
  const finalText = list.filter((t) => t.text.trim())
    .map((t) => `${header(t)}\n${t.text.trim()}`).join("\n\n");
  const own = list.filter((t) => t.clientId).map((t) => t.n);
  const warning = `muse ran ${list.length} turns in this call`
    + (own.length ? `; turn ${own.join(", ")} ${own.length > 1 ? "were" : "was"} started by muse `
      + "itself, not by the brief" : "")
    + ". finalText holds every turn's text in order: read all of it, not only the last turn.";
  return { finalText, warning };
}

function printSummary(result, resultPath) {
  const lines = [
    "",
    `relay: ${result.status} (exit ${result.exitCode})  ·  muse ${result.museVersion ?? "?"}`,
  ];
  if (result.sessionId) lines.push(`session: ${result.sessionId}`);
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.warning) lines.push(`warning: ${result.warning}`);
  if (result.contributorCheck) {
    const sent = result.sentToModels?.length ? result.sentToModels.join(", ") : "none reported";
    lines.push(`contributor check: ${result.contributorCheck} (sent to: ${sent})`);
    if (result.contributorCheck === "unverified") {
      lines.push("contributor check: muse reported no model for its requests, so the relay cannot tell whether "
        + "Meta's contributor tier was used. Stop and tell the person before using Muse again.");
    }
  }
  if (result.modelWarning) lines.push(`warning: ${result.modelWarning}`);
  if (result.museLeftRunning) {
    const n = result.museLeftRunning === true ? "one or more" : result.museLeftRunning;
    lines.push(`note: muse left ${n} process(es) running when it ended; the relay stopped them. Check the worktree `
      + "for partial writes (for example a leftover .git/index.lock).");
  }
  if (result.museStopped === false) lines.push("warning: the relay could not confirm that muse stopped; check for a running muse process.");
  lines.push("", "--- muse final message ---");
  lines.push(result.finalText || "(no final message captured)");
  lines.push("--- end ---", "", `result: ${resultPath}`);
  lines.push("relay does not commit. Review the diff, re-run gates, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = opts.outDir
    || join(tmpdir(), "muse-relay", `${basename(opts.cd) || "run"}-${ts}`);
  mkdirSync(outDir, { recursive: true });

  const briefPath = join(outDir, "brief.txt");
  const eventsPath = join(outDir, "events.jsonl");
  const stderrPath = join(outDir, "stderr.txt");
  const resultPath = join(outDir, "result.json");
  writeFileSync(briefPath, brief, "utf8");
  writeFileSync(eventsPath, "", "utf8");
  writeFileSync(stderrPath, "", "utf8");
  const startedAt = new Date().toISOString();

  const version = museVersion();
  if (version === null) {
    const r = writeResult(resultPath, {
      schema: "delegate-relay.result.v1", tool: "muse", status: "muse_unavailable",
      ok: false, exitCode: 127, sessionId: null, model: opts.model, effort: opts.effort,
      readOnly: opts.readOnly, finalText: "", rawEventCount: 0,
      lane: opts.lane, startedAt, finishedAt: new Date().toISOString(),
      briefPath, eventsPath, stderrPath,
      error: "`muse` not found on PATH. Install Muse Code and ensure muse.cmd is on PATH.",
    });
    printSummary(r, resultPath);
    process.stderr.write("relay: `muse` not found on PATH\n");
    process.exit(127);
  }
  // An older Muse does not know --contributor-mode; refuse it before it runs. A version that cannot be read runs
  // (with the flag, which such a Muse refuses if it does not know it) and is recorded as "unparsed".
  const museVersionCheck = versionCheck(version);
  if (museVersionCheck === "old") {
    const error = `this Muse (${version}) is older than ${MUSE_MIN_VERSION}, the first version known to accept `
      + "--contributor-mode off; update Muse. The relay never runs Muse without that flag.";
    const r = writeResult(resultPath, {
      schema: "delegate-relay.result.v1", tool: "muse", status: "muse_too_old",
      ok: false, exitCode: 1, sessionId: null, model: opts.model, effort: opts.effort,
      readOnly: opts.readOnly, finalText: "", rawEventCount: 0, museVersion: version, museVersionCheck,
      lane: opts.lane, startedAt, finishedAt: new Date().toISOString(),
      briefPath, eventsPath, stderrPath, error,
    });
    printSummary(r, resultPath);
    process.stderr.write(`relay: ${error}\n`);
    process.exit(1);
  }

  let resumeId = null;
  if (opts.session || opts.resumeLast) {
    const found = resolveSession(opts, outDir);
    if (found.error) {
      const r = writeResult(resultPath, {
        schema: "delegate-relay.result.v1", tool: "muse", status: "session_not_found",
        ok: false, exitCode: 1, sessionId: opts.session, model: opts.model, effort: opts.effort,
        readOnly: opts.readOnly, finalText: "", rawEventCount: 0, museVersion: version,
        lane: opts.lane, startedAt, finishedAt: new Date().toISOString(),
        briefPath, eventsPath, stderrPath, error: found.error,
      });
      appendFileSync(stderrPath, `${found.error}\n`);
      printSummary(r, resultPath);
      process.stderr.write(`relay: ${found.error}\n`);
      process.exit(1);
    }
    resumeId = found.id;
    process.stderr.write(`relay: continuing muse session ${resumeId}\n`);
  }

  const cmd = buildCmd(opts, briefPath, resumeId);
  process.stderr.write(`relay: running: ${cmd}\n`);

  // DELEGATION_DISPATCHED marks the child as a dispatched worker so the consensus referee refuses to run inside it.
  // Windows: muse runs inside the guard's job (see GUARD_PS). POSIX: muse leads its own process group (detached),
  // so stopMuse can stop everything it started; the signal handlers below stop that group if the relay is cancelled.
  const env = museEnv({ DELEGATION_DISPATCHED: "1" });
  const setting = museContributorSetting();
  const guard = process.platform === "win32"
    ? { stopFile: join(outDir, "muse-guard.stop"), statusFile: join(outDir, "muse-guard.json") } : null;
  let child;
  if (guard) {
    rmSync(guard.stopFile, { force: true });
    rmSync(guard.statusFile, { force: true });
    child = startGuarded(cmd, { cwd: opts.cd, env, ...guard });
  } else {
    child = spawn(cmd, { cwd: opts.cd, stdio: ["ignore", "pipe", "pipe"], shell: true, env, detached: true });
  }

  let sessionId = null;
  let finalText = "";
  let warning = null;
  let closingText = "";
  const turns = new Map();
  let terminalOk = false;
  let rawEventCount = 0;
  let settled = false;
  const sentModels = new Set();
  const sentToModels = () => [...sentModels];
  const contributorCheck = () => {
    if (opts.provider === "echo") return "not_applicable";
    const ids = sentToModels();
    if (ids.some((m) => CONTRIBUTOR_ID.test(m))) return "contributor_tier_used";
    return ids.length ? "verified" : "unverified";
  };
  // Fields every result written after muse started carries.
  const checked = () => {
    const ids = sentToModels();
    const other = opts.model ? ids.filter((m) => m !== opts.model) : [];
    return {
      museVersionCheck, sentToModels: ids, contributorCheck: contributorCheck(), museContributorSetting: setting,
      ...(other.length ? { modelWarning: `muse reported sending requests to ${other.join(", ")}, `
        + `not only to the requested ${opts.model}` } : {}),
    };
  };
  const hasContributor = () => sentToModels().some((m) => CONTRIBUTOR_ID.test(m));
  const museEnded = () => child.exitCode !== null || child.signalCode !== null;

  // The run ends with the relay stopping muse: the --timeout watchdog, a contributor model in the stream, or a
  // signal to the relay. A contributor model seen at any point, also while the stop was under way, outranks the
  // other two. The error text says whether the stop was confirmed.
  async function stopAndReport(kind, sig = null) {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    // POSIX: muse itself has already ended, but its group still has members: those were left behind.
    const leftBehind = !guard && museEnded() && alive(child.pid, true);
    const museStopped = await stopMuse(child, guard);
    const st = guard ? readGuardStatus(guard) : null;
    const left = st ? (st.reason === "muse-exited" && st.inJobAtEnd > 0 ? st.inJobAtEnd : 0) : leftBehind;
    // Windows: the stop came before the guard let muse run, so nothing was sent.
    const neverStarted = st?.started === false;
    // The last stdout chunk may have arrived without a trailing newline.
    if (lineBuf.trim()) {
      try { collectSentModels(JSON.parse(lineBuf.trim()), sentModels); } catch { /* partial line */ }
    }
    if (hasContributor()) kind = "contributor";
    ({ finalText, warning } = summarizeTurns(turns));
    const how = museStopped ? "the relay stopped it and every process it started"
      : "the relay tried to stop it and every process it started but could not confirm that they are gone; "
        + "check for running muse processes";
    let status; let exitCode; let error;
    if (kind === "contributor") {
      const bad = sentToModels().filter((m) => CONTRIBUTOR_ID.test(m));
      status = "contributor_tier_used"; exitCode = CONTRIBUTOR_EXIT;
      error = `muse sent requests to Meta's contributor tier (${bad.join(", ")}) although the run passed `
        + `--contributor-mode off; ${how}. Do not use Muse on this machine until this is explained, `
        + "and tell the person: check contributor_mode_enabled in ~/.config/muse/settings.json and the Muse version.";
    } else if (kind === "timeout") {
      status = "timeout"; exitCode = 124;
      error = `muse did not finish within --timeout ${opts.timeout}; ${how}`;
    } else {
      status = "cancelled"; exitCode = SIGNAL_EXIT[sig] || 130;
      error = `the relay received ${sig} while muse was running; ${how}`;
    }
    const r = writeResult(resultPath, {
      schema: "delegate-relay.result.v1", tool: "muse", status,
      ok: false, exitCode, sessionId, model: opts.model, effort: opts.effort,
      readOnly: opts.readOnly, finalText, rawEventCount, museVersion: version,
      lane: opts.lane, startedAt, finishedAt: new Date().toISOString(),
      briefPath, eventsPath, stderrPath, ...checked(), ...(neverStarted ? { contributorCheck: "not_sent" } : {}),
      museStopped, ...(left ? { museLeftRunning: left } : {}), error,
      ...(warning ? { warning } : {}),
    });
    printSummary(r, resultPath);
    process.exit(exitCode);
  }

  const timeoutMs = parseDuration(opts.timeout);
  const watchdog = setTimeout(() => { stopAndReport("timeout"); }, timeoutMs);

  // Cancelling the relay stops muse first. Needed on POSIX, where muse leads its own process group and so no
  // longer gets the terminal's Ctrl-C or a signal sent to the relay's group; on Windows the guard's job ends with
  // the relay anyway, and this records why.
  for (const sig of Object.keys(SIGNAL_EXIT)) {
    if (sig === "SIGBREAK" && process.platform !== "win32") continue;
    process.on(sig, () => { stopAndReport("cancelled", sig); });
  }

  // Parse JSONL line-by-line from stdout.
  // Session ID: event.stream.id (present on every event).
  // Terminal event: payload_type === "run.terminal.completed"
  //   → payload.terminal === "completed" means success; payload.text is that turn's closing text.
  // Turns: see trackTurn; the last terminal event decides success, as before.
  let lineBuf = "";
  child.stdout.on("data", (chunk) => {
    appendFileSync(eventsPath, chunk);
    lineBuf += chunk.toString("utf8");
    let nl;
    while ((nl = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line) continue;
      rawEventCount += 1;
      try {
        const ev = JSON.parse(line);
        if (!sessionId && ev?.stream?.id) sessionId = ev.stream.id;
        trackTurn(turns, ev);
        if (ev?.payload_type === "run.terminal.completed") {
          closingText = typeof ev.payload?.text === "string" ? ev.payload.text : "";
          terminalOk = ev.payload?.terminal === "completed";
        }
        collectSentModels(ev, sentModels);
      } catch { /* skip malformed line */ }
      // Muse sent work to the contributor tier although the run said --contributor-mode off: stop muse and
      // everything it started so no further requests go there, and report it.
      if (!settled && hasContributor()) { stopAndReport("contributor"); return; }
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(stderrPath, chunk);
  });

  // POSIX: muse has ended. Anything it left in its group may hold its output open, and then "close" would wait for it
  // until --timeout. Two seconds after muse's exit the relay stops the group; the close handler records it.
  let sweptAfterExit = false;
  if (!guard) {
    child.on("exit", () => {
      setTimeout(() => {
        if (settled || !alive(child.pid, true)) return;
        sweptAfterExit = true;
        stopMuse(child, null);
      }, 2_000).unref();
    });
  }

  // The guard (Windows) or the shell (POSIX) could not be started at all: nothing ran, so nothing was sent.
  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    ({ finalText, warning } = summarizeTurns(turns));
    const neverRan = child.pid === undefined && rawEventCount === 0;
    const what = guard ? "Windows PowerShell for the relay's process guard" : "the shell that runs muse";
    const r = writeResult(resultPath, {
      schema: "delegate-relay.result.v1", tool: "muse", status: "failed",
      ok: false, exitCode: 1, sessionId, model: opts.model, effort: opts.effort,
      readOnly: opts.readOnly, finalText, rawEventCount, museVersion: version,
      lane: opts.lane, startedAt, finishedAt: new Date().toISOString(),
      briefPath, eventsPath, stderrPath, ...checked(),
      ...(neverRan ? { contributorCheck: "not_sent" } : {}),
      error: neverRan ? `the relay could not start ${what} (${err.message}); Muse was not run.` : String(err.message),
      ...(warning ? { warning } : {}),
    });
    printSummary(r, resultPath);
    process.exit(1);
  });

  child.on("close", (code) => { finish(code); });

  async function finish(code) {
    if (settled) return;
    // The last stdout chunk may have arrived without a trailing newline.
    if (lineBuf.trim()) {
      try { collectSentModels(JSON.parse(lineBuf.trim()), sentModels); } catch { /* partial line */ }
    }
    // Muse has ended; stopAndReport settles the run and confirms that nothing it started is still running.
    if (hasContributor()) { stopAndReport("contributor"); return; }
    settled = true;
    clearTimeout(watchdog);
    ({ finalText, warning } = summarizeTurns(turns));
    const st = guard ? readGuardStatus(guard) : null;
    // Only exit 97 together with the guard's own "unavailable" status proves that muse never ran. Anything else
    // without a status (the guard crashed, or could not write it) stays unconfirmed below.
    if (guard && code === GUARD_EXIT && st?.guard === "unavailable") {
      const error = `the relay could not start Muse inside its process guard (${st.error || "unknown reason"}); `
        + "Muse was not run. Tell the person: the guard needs Windows PowerShell 5.1 in Full Language mode (not "
        + "locked down by WDAC or AppLocker) with Add-Type allowed.";
      const r = writeResult(resultPath, {
        schema: "delegate-relay.result.v1", tool: "muse", status: "failed",
        ok: false, exitCode: 1, sessionId, model: opts.model, effort: opts.effort,
        readOnly: opts.readOnly, finalText, rawEventCount, museVersion: version,
        lane: opts.lane, startedAt, finishedAt: new Date().toISOString(),
        briefPath, eventsPath, stderrPath, ...checked(), contributorCheck: "not_sent", error,
      });
      printSummary(r, resultPath);
      process.exit(1);
    }
    // POSIX: stop whatever muse left in its group (also when the exit sweep above already began).
    const leftBehind = !guard && (sweptAfterExit || alive(child.pid, true));
    const groupStopped = leftBehind ? await stopMuse(child, null) : true;
    // Use terminal event as primary success signal (echo provider exits 1 even on success).
    const succeeded = terminalOk;
    const exitCode = code ?? 1;
    const status = succeeded ? "completed" : "failed";
    let error = closingText || `muse exited with code ${exitCode}`;
    let refusedFlag = false;
    if (!succeeded && rawEventCount === 0 && sentToModels().length === 0) {
      // A Muse that does not know the flag refuses it on one line, before its first event. Never retry without it.
      let errText = "";
      try { errText = readFileSync(stderrPath, "utf8"); } catch { /* none */ }
      if (errText.split(/\r?\n/).some((l) => /--contributor-mode/.test(l)
        && /unexpected|unknown|unrecognized|not expected|invalid/i.test(l))) {
        refusedFlag = true;
        error = `this Muse (${version}) does not accept --contributor-mode; update Muse to ${MUSE_MIN_VERSION} `
          + "or newer. The relay never runs Muse without it.";
      }
    }
    // What muse left running when it ended (stopped by the guard or the group stop), and whether that was confirmed.
    const left = guard ? (st?.state === "ended" && st.inJobAtEnd > 0 ? st.inJobAtEnd : 0) : leftBehind;
    const unconfirmed = guard ? !(st?.state === "ended" && st.active === 0) : !groupStopped;
    const r = writeResult(resultPath, {
      schema: "delegate-relay.result.v1", tool: "muse", status,
      ok: succeeded, exitCode, sessionId, model: opts.model, effort: opts.effort,
      readOnly: opts.readOnly, finalText, rawEventCount, museVersion: version,
      lane: opts.lane, startedAt, finishedAt: new Date().toISOString(),
      briefPath, eventsPath, stderrPath, ...checked(),
      ...(refusedFlag ? { contributorCheck: "not_sent" } : {}),
      ...(left ? { museLeftRunning: left } : {}),
      ...(unconfirmed ? { museStopped: false } : {}),
      ...(!succeeded ? { error } : {}),
      ...(warning ? { warning } : {}),
    });
    printSummary(r, resultPath);
    process.exit(succeeded ? 0 : exitCode === 0 ? 1 : exitCode);
  }
}

main();
