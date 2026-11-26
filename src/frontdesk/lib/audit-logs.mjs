// Retrospective audit of what Claude Code and Codex actually delegated, read from their own session logs (read only, nothing is
// written). It is the "before" picture for the role ladder and the cross-check for the guard log. Muse keeps its sessions in a binary
// journal, so Muse is audited from the guard log only. Prompts are never read into the report: only structure and counts.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const inc = (o, k, n = 1) => { const key = k == null || k === '' ? '(none)' : String(k); o[key] = (o[key] || 0) + n; };

function walk(dir, test, out = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, test, out); else if (test(e.name, p)) out.push(p); }
  return out;
}
const recent = (f, sinceMs) => { try { return fs.statSync(f).mtimeMs >= sinceMs; } catch { return false; } };
const RELAY = /relay\.mjs|(qwen|codex|muse|cursor)-delegate|referee\.mjs/;

async function* lines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) yield l;
}

export async function scanClaude(home, { sinceMs = 0 } = {}) {
  const root = path.join(home, '.claude', 'projects');
  const files = walk(root, (n) => n.endsWith('.jsonl')).filter((f) => recent(f, sinceMs));
  const r = { transcripts: files.length, mainSessions: 0, agentCalls: { total: 0, byType: {}, namingModel: 0 }, workflowAgents: { total: 0, byModel: {} }, subagentRuns: { total: 0, byAgentType: {}, byModel: {} },
    relayDispatches: { total: 0, byTool: {}, byLane: {}, explicitModel: 0, noLaneNoModel: 0 }, mainModels: {} };
  for (const f of files) {
    const isSub = /[\\/]subagents[\\/]/.test(f);
    const seen = new Set();
    const models = {};
    for await (const line of lines(f)) {
      if (!line.includes('"assistant"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'assistant' || !o.message) continue;
      const m = o.message;
      if (m.model && m.model !== '<synthetic>' && !seen.has(m.id || o.uuid)) { seen.add(m.id || o.uuid); inc(models, m.model); }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type !== 'tool_use') continue;
        const i = c.input || {};
        if (!isSub && (c.name === 'Agent' || c.name === 'Task')) { r.agentCalls.total++; inc(r.agentCalls.byType, i.subagent_type); if (i.model != null) r.agentCalls.namingModel++; }
        if (!isSub && (c.name === 'Bash' || c.name === 'PowerShell')) {
          const cmd = String((c.input && c.input.command) || '');
          if (RELAY.test(cmd)) {
            const tool = (cmd.match(/(codex|cursor|muse|qwen)-delegate/) || [])[1] || (/referee/.test(cmd) ? 'referee' : 'other');
            const lane = (cmd.match(/--lane[ =]+["']?([\w.-]+)/) || [])[1] || null;
            const model = (cmd.match(/--model[ =]+["']?([\w.-]+)/) || [])[1] || null;
            r.relayDispatches.total++; inc(r.relayDispatches.byTool, tool); if (lane) inc(r.relayDispatches.byLane, lane);
            if (model) r.relayDispatches.explicitModel++; if (!lane && !model && tool !== 'referee') r.relayDispatches.noLaneNoModel++;
          }
        }
      }
    }
    const top = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '(unknown)';
    if (isSub) {
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* no meta */ }
      const kind = meta.agentType || '(unknown)';
      r.subagentRuns.total++; inc(r.subagentRuns.byAgentType, kind); inc(r.subagentRuns.byModel, top);
      if (kind === 'workflow-subagent') { r.workflowAgents.total++; inc(r.workflowAgents.byModel, top); }
    } else { r.mainSessions++; inc(r.mainModels, top); }
  }
  return r;
}

export async function scanCodex(home, { sinceMs = 0 } = {}) {
  const root = path.join(home, '.codex', 'sessions');
  const files = walk(root, (n) => /^rollout-.*\.jsonl$/.test(n)).filter((f) => recent(f, sinceMs));
  const r = { rollouts: files.length, spawns: { total: 0, byModel: {}, byEffort: {}, byAgentType: {}, namingModel: 0 }, subagentSessions: 0 };
  for (const f of files) {
    for await (const line of lines(f)) {
      if (line.length > 400000 && !line.includes('"spawn_agent"') && !line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
      if (!line.includes('spawn_agent') && !line.includes('turn_context') && !line.includes('session_meta')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const p = o.payload || {};
      if (o.type === 'session_meta' && p.source && p.source.subagent) r.subagentSessions++;
      if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call') && p.name === 'spawn_agent') {
        let a = {}; try { a = JSON.parse(p.arguments || p.input || '{}'); } catch { /* arguments not JSON */ }
        r.spawns.total++; inc(r.spawns.byModel, a.model); inc(r.spawns.byEffort, a.reasoning_effort); inc(r.spawns.byAgentType, a.agent_type || a.role);
        if (a.model != null || a.reasoning_effort != null) r.spawns.namingModel++;
      }
    }
    // Requested versus actual effort needs the child rollout linked to its parent's spawn; not done yet, so the audit does not claim it.
  }
  return r;
}

export async function auditLogs(home, { days = 14, now = Date.now() } = {}) {
  const sinceMs = now - days * 86400000;
  const [claude, codex] = await Promise.all([scanClaude(home, { sinceMs }), scanCodex(home, { sinceMs })]);
  return { days, since: new Date(sinceMs).toISOString().slice(0, 10), claude, codex,
    unrouted: { claudeAgentCalls: claude.agentCalls.total, claudeWorkflowAgents: claude.workflowAgents.total, claudeRelayDispatches: claude.relayDispatches.total, codexSpawns: codex.spawns.total } };
}

export function formatAudit(a) {
  const top = (o, n = 6) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  return [
    `Session logs, last ${a.days} days (since ${a.since}); no role calls exist yet, so everything below is "before" data`,
    `Claude Code: ${a.claude.mainSessions} main sessions (models: ${top(a.claude.mainModels)})`,
    `  Agent tool calls ${a.claude.agentCalls.total} (types: ${top(a.claude.agentCalls.byType)}); naming a model: ${a.claude.agentCalls.namingModel}`,
    `  subagent runs ${a.claude.subagentRuns.total} (by type: ${top(a.claude.subagentRuns.byAgentType)}; by model: ${top(a.claude.subagentRuns.byModel)})`,
    `  Workflow agents ${a.claude.workflowAgents.total} (models: ${top(a.claude.workflowAgents.byModel)})`,
    `  relay and referee dispatches ${a.claude.relayDispatches.total} (tools: ${top(a.claude.relayDispatches.byTool)}; lanes: ${top(a.claude.relayDispatches.byLane)}); with an explicit model ${a.claude.relayDispatches.explicitModel}; with neither lane nor model ${a.claude.relayDispatches.noLaneNoModel}`,
    `Codex: ${a.codex.rollouts} rollouts, ${a.codex.subagentSessions} subagent sessions; spawn_agent calls ${a.codex.spawns.total} (naming a model or effort: ${a.codex.spawns.namingModel}); models: ${top(a.codex.spawns.byModel)}; efforts: ${top(a.codex.spawns.byEffort)}`,
    'Muse: sessions are a binary journal; see the guard log for Muse.',
  ].join('\n');
}
