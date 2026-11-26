#!/usr/bin/env node
import { parseArgs, hasFlag } from './lib/args.mjs';
import { cmdDetach, cmdWait } from './lib/detach.mjs';
import { cmdDoctor, cmdInitProject } from './lib/doctor.mjs';
import { isRefuse } from './lib/fail.mjs';
import { cmdConsult, ensureTask } from './lib/flow-consult.mjs';
import { cmdAssess, cmdAssessOutcome, cmdAssessReport, ensureAssessTask, loadOpenAssessTask } from './lib/flow-assess.mjs';
import { cmdAsk, cmdClose, cmdJob, cmdList, cmdSeal, cmdStart, cmdStatus } from './lib/flow-full.mjs';
import { clearPending, readPending } from './lib/guard.mjs';
import { printHuman } from './lib/human.mjs';
import { readVersion, sourceStamp } from './lib/paths.mjs';

const HELP = `consensus referee ${readVersion()}

Usage: node referee.mjs <command> [options]

Commands:
  start        create a full or advise task (--mode --chair --project --goal [--cochair] [--continue-from])
  seal         record the chair verdict (--task --phase finish-line|signoff --file)
  ask          run the co-CTO for the current round (--task --phase [--detach] [--keep-copy])
  job          log a worker dispatch (--task --lane --note)
  consult      advise-mode CTO opinion (--project --brief --seats [--task] [--stage] [--detach])
  assess       task sizing trial (--project --brief [--assessor] [--rules-said suggest|no] [--triggers] [--detach])
  assess-outcome record task outcome (--task --files-changed --gate-failures --consensus [--owner-view] [--note])
  assess-report summarize the trial ([--all])
  wait         poll a detached call (--task [--minutes 9])
  status       ledger summary (--task)
  list         task index ([--open])
  close        abandon a task (--task --outcome abandoned --reason)
  doctor       check Node, ledger, seat binaries (no tokens)
  init-project print or append the AGENTS.md consult block ([--dir] [--write])

--json is the default. --human prints a short summary.
Exit codes: 0 success, 2 refusal, 1 internal error.
`;

function emit(obj, human) {
  if (human) printHuman(obj);
  else process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function dispatch(args, argv) {
  if (hasFlag(args, 'help') || args._[0] === 'help') {
    return { help: HELP, ok: true, _plain: HELP };
  }
  if (hasFlag(args, 'version') || args._[0] === 'version') {
    return { ok: true, version: readVersion(), sourceStamp: sourceStamp(), _plain: readVersion() };
  }
  const cmd = args._[0];
  if (!cmd) return { help: HELP, ok: true, _plain: HELP };

  if (hasFlag(args, 'detach') && (cmd === 'ask' || cmd === 'consult' || cmd === 'assess')) {
    if (cmd === 'consult' && !args.task) {
      const ledger = ensureTask(args);
      args.task = ledger.id;
      argv = [...argv, '--task', ledger.id];
    }
    if (cmd === 'assess' && !args.task) {
      const ledger = ensureAssessTask(args);
      args.task = ledger.id;
      argv = [...argv, '--task', ledger.id];
    } else if (cmd === 'assess') {
      loadOpenAssessTask(String(args.task));
    }
    return cmdDetach(args, argv);
  }

  switch (cmd) {
    case 'start': return cmdStart(args);
    case 'seal': return cmdSeal(args);
    case 'ask': return cmdAsk(args);
    case 'job': return cmdJob(args);
    case 'consult': return cmdConsult(args);
    case 'assess': return cmdAssess(args);
    case 'assess-outcome': return cmdAssessOutcome(args);
    case 'assess-report': return cmdAssessReport(args);
    case 'wait': return cmdWait(args);
    case 'status': return cmdStatus(args);
    case 'list': return cmdList(args);
    case 'close': return cmdClose(args);
    case 'doctor': return cmdDoctor(args);
    case 'init-project': return cmdInitProject(args);
    default:
      return { ok: false, code: 'BAD_ARGS', message: `Unknown command ${cmd}`, _refuse: true };
  }
}

function finishPending(args) {
  const id = args.task ? String(args.task) : null;
  if (!id) return;
  try {
    const pending = readPending(id);
    if (pending && pending.pid === process.pid) clearPending(id, 'finished');
  } catch { /* an invalid task id was already refused; there is nothing to clear */ }
}

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const human = hasFlag(args, 'human');

try {
  const result = await dispatch(args, argv);
  if (result && result._plain && (hasFlag(args, 'help') || hasFlag(args, 'version') || !args._[0] || args._[0] === 'help' || args._[0] === 'version')) {
    process.stdout.write(`${result._plain.trimEnd()}\n`);
    finishPending(args);
    process.exit(0);
  }
  const { _plain, _refuse, ...publicResult } = result || { ok: false };
  emit(publicResult, human);
  finishPending(args);
  if (publicResult.ok) process.exit(0);
  process.exit(2);
} catch (err) {
  if (isRefuse(err)) {
    const body = { ok: false, code: err.code, message: err.message, ...(err.extra || {}) };
    emit(body, human);
    finishPending(args);
    process.exit(2);
  }
  emit({ ok: false, code: 'INTERNAL', message: err && err.message ? err.message : String(err) }, human);
  finishPending(args);
  process.exit(1);
}
