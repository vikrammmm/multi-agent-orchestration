#!/usr/bin/env node
import fs from 'node:fs';
const [,, name, ...argv] = process.argv;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(process.env.FIXTURE_TOOL_CFG,'utf8')); } catch {}
const ver = (cfg.versions||{})[name]||'';
if (argv[0]==='--version'){process.stdout.write(ver+'\n');process.exit(0);}
if (name==='cursor-agent'&&argv[0]==='models'){
  if(cfg.cursorFail){process.stdout.write('not logged in\n');process.exit(1);}
  process.stdout.write('Available models\n'+(cfg.cursorModels||[]).join('\n')+'\n');
  process.exit(0);
}
process.exit(0);
