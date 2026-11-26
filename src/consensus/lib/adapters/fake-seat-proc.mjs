// A stand-in seat process for the fake seats that test how the referee ends a call whose process
// does not exit (lib/spawn.mjs). Never used by a real seat.
//
//   node fake-seat-proc.mjs <mode> <pidFile> [finalPath]   (the verdict text arrives on stdin)
//
// hang-after-output  writes the verdict to finalPath (when given) and to stdout as codex-style
//                    JSONL, then waits forever on a child that holds stdout open.
// orphan-then-hang   leaves a grandchild that holds stdout open outside the process tree (its
//                    parent has exited, and it runs in its own group), then waits forever without
//                    any output: a tree kill cannot close the pipe.
// orphan-then-exit   leaves the same grandchild, prints the verdict on stdout and exits 0.
//
// Every process it starts appends its pid to pidFile, so a test can check and clean them up.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [mode, pidFile, finalPath] = process.argv.slice(2);
const SLEEP = 'setInterval(() => {}, 1000)';

function notePid(pid) {
  fs.appendFileSync(pidFile, `${pid}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { text += d; });
    process.stdin.on('end', () => resolve(text.trim()));
    process.stdin.on('error', () => resolve(text.trim()));
  });
}

function holder(detached) {
  const child = spawn(process.execPath, ['-e', SLEEP], {
    stdio: ['ignore', 'inherit', 'inherit'], detached, windowsHide: true,
  });
  notePid(child.pid);
  return child;
}

function orphanHolder() {
  // The middle process starts the holder and exits at once, so the holder's parent is gone.
  const code = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const c = spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP)}], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true });`,
    `fs.appendFileSync(${JSON.stringify(pidFile)}, c.pid + '\\n');`,
    'c.unref();',
  ].join('\n');
  const middle = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  notePid(middle.pid);
  return new Promise((resolve) => middle.on('exit', resolve));
}

notePid(process.pid);
const verdict = await readStdin();

if (mode === 'hang-after-output') {
  if (finalPath) fs.writeFileSync(finalPath, `${verdict}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: verdict } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
  holder(false);
  setInterval(() => {}, 1000);
} else if (mode === 'orphan-then-hang') {
  await orphanHolder();
  setInterval(() => {}, 1000);
} else if (mode === 'orphan-then-exit') {
  await orphanHolder();
  process.stdout.write(`${verdict}\n`, () => process.exit(0));
} else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(3);
}
