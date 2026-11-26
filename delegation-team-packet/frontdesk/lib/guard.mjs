// The guard: ONE decision function for every tool. Each tool's hook payload is first turned into a plain request (normalize), then
// decide() answers allow or deny with reason codes. In shadow mode (the first install) the answer is only logged; in enforce mode the
// thin hook turns a deny into a refusal. Pure functions, no dependencies, no file access: the hook loads the context.
//
// Payload shapes are proved for Claude Code and Muse Code; Codex's are not yet proved, so its
// normalizer is deliberately loose and everything it cannot place stays "other" (allowed, but logged by name for discovery).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonBounded } from './fsx.mjs';
import { eligibleEngineer } from './eligible.mjs';

export const MODE = { SHADOW: 'shadow', ENFORCE: 'enforce' };
const sha12 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

export async function effectiveMode(L, tool, env = process.env, { readFile = fsReadFile } = {}) {
  const forced = env.FRONTDESK_GUARD_MODE;
  if (forced !== undefined) {
    if (forced === MODE.ENFORCE || forced === MODE.SHADOW) return forced;
    throw modeError('FRONTDESK_GUARD_MODE must be shadow or enforce');
  }
  let saved;
  try { saved = await readJsonBounded(path.join(L.state, 'mode.json'), { maxBytes: 1024 * 1024, readFile }); }
  catch (error) {
    if (error.code === 'ENOENT') return MODE.SHADOW;
    throw modeError(error.message, error);
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw modeError('mode.json must contain an object');
  const value = saved[tool] ?? saved.default;
  if (value === undefined) return MODE.SHADOW;
  if (value === MODE.SHADOW || value === MODE.ENFORCE) return value;
  throw modeError(`mode.json has an invalid value for ${tool}`);
}

const fsReadFile = (...args) => fs.promises.readFile(...args);
function modeError(message, cause) { return Object.assign(new Error(message, cause ? { cause } : undefined), { kind: 'mode_unreadable' }); }

// ---- Workflow scripts: find every agent(...) call and what it pins --------------------------------------------------------
// A light scanner (not a full parser): it skips comments and string literals, then reads each agent( call's argument list.
export function analyzeWorkflow(script) {
  const src = String(script || '');
  const calls = [];
  let i = 0;
  const n = src.length;
  const skipString = (q, at) => { let j = at + 1; while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; } return j + 1; };
  const skipTemplate = (at) => { let j = at + 1, depth = 0; while (j < n) { const c = src[j]; if (c === '\\') { j += 2; continue; } if (c === '`' && depth === 0) return j + 1; if (c === '$' && src[j + 1] === '{') { depth++; j += 2; continue; } if (c === '}' && depth > 0) { depth--; j++; continue; } j++; } return j; };
  function readArgs(open) { // returns { text, end } for the balanced (...) starting at open
    let j = open + 1, depth = 1;
    while (j < n && depth > 0) {
      const c = src[j];
      if (c === '"' || c === "'") { j = skipString(c, j); continue; }
      if (c === '`') { j = skipTemplate(j); continue; }
      if (c === '/' && src[j + 1] === '/') { while (j < n && src[j] !== '\n') j++; continue; }
      if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e < 0 ? n : e + 2; continue; }
      if (c === '(') depth++; else if (c === ')') depth--;
      j++;
    }
    return { text: src.slice(open + 1, j - 1), end: j };
  }
  function splitTopLevel(text) {
    const parts = []; let depth = 0, last = 0, j = 0;
    while (j < text.length) {
      const c = text[j];
      if (c === '"' || c === "'") { let k = j + 1; while (k < text.length && text[k] !== c) { if (text[k] === '\\') k++; k++; } j = k + 1; continue; }
      if (c === '`') { let k = j + 1, d = 0; while (k < text.length) { if (text[k] === '\\') { k += 2; continue; } if (text[k] === '`' && d === 0) break; if (text[k] === '$' && text[k + 1] === '{') { d++; k += 2; continue; } if (text[k] === '}' && d > 0) { d--; k++; continue; } k++; } j = k + 1; continue; }
      if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
      else if (c === ',' && depth === 0) { parts.push(text.slice(last, j)); last = j + 1; }
      j++;
    }
    parts.push(text.slice(last));
    return parts.map((s) => s.trim());
  }
  // Top-level properties of an object literal: [{ key, value }]. A spread element or a shorthand property is reported with value null.
  const props = (objText) => splitTopLevel(objText.slice(1, -1)).filter((p) => p.length).map((p) => {
    if (p.startsWith('...')) return { key: '...', value: null, spread: true };
    const k = p.indexOf(':');
    return k < 0 ? { key: p.replace(/^['"]|['"]$/g, ''), value: null } : { key: p.slice(0, k).trim().replace(/^['"]|['"]$/g, ''), value: p.slice(k + 1).trim() };
  });
  const strLit = (v) => { const m = v && v.match(/^(?:'([^'\\]*)'|"([^"\\]*)")$/); return m ? (m[1] ?? m[2]) : null; };
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipString(c, i); continue; }
    if (c === '`') { i = skipTemplate(i); continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    const m = /^agent\s*\(/.exec(src.slice(i, i + 40));
    if (m && !/[A-Za-z0-9_$.]/.test(src[i - 1] || ' ')) {
      const open = i + m[0].length - 1;
      const { text, end } = readArgs(open);
      const parts = splitTopLevel(text);
      const opts = parts[1] ?? '';
      const isObject = /^\{[\s\S]*\}$/.test(opts);
      const call = { readable: !opts || isObject, model: null, agentType: null, effort: null, pinned: false };
      if (isObject) {
        const ps = props(opts);
        const get = (k) => ps.find((p) => p.key === k);
        const pm = get('model'), pa = get('agentType'), pe = get('effort');
        call.model = strLit(pm?.value); call.agentType = strLit(pa?.value); call.effort = strLit(pe?.value);
        const dynamic = (p, lit) => !!p && lit === null;                // the key is there but its value is not a string literal
        call.modelKeyDynamic = dynamic(pm, call.model); call.agentTypeKeyDynamic = dynamic(pa, call.agentType);
        call.pinned = !!(call.model || call.agentType);
        if (call.modelKeyDynamic || call.agentTypeKeyDynamic || ps.some((p) => p.spread)) call.readable = false;
      } else if (opts) call.readable = false;
      calls.push(call);
      i = end;
      continue;
    }
    i++;
  }
  return { total: calls.length, pinned: calls.filter((x) => x.pinned && x.readable).length, unpinned: calls.filter((x) => !x.pinned).length, unreadable: calls.filter((x) => !x.readable).length, calls, hash: sha12(src) };
}

// ---- Normalizers: tool payload -> plain request ----------------------------------------------------------------------------
const isGeneric = (t) => !t || ['general-purpose', 'fork', 'general', 'default'].includes(String(t).toLowerCase());

export function normalize(tool, payload, env = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const ti = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const name = p.tool_name ?? null;
  const base = { tool, event: p.hook_event_name ?? null, name, session: p.session_id ? String(p.session_id).slice(0, 8) : null, cwd: p.cwd ? path.basename(String(p.cwd).replace(/[\\/]+$/, '')) : null,
    callerIsSubagent: !!p.agent_id, callerAgentType: p.agent_type ?? null, sessionModel: typeof p.model === 'string' ? p.model : null, envWorker: !!(env.DELEGATION_DISPATCHED || env.CONSENSUS_SEAT) };
  if (tool === 'claude') {
    if (name === 'Agent' || name === 'Task') return { ...base, kind: 'agent_spawn', sub: ti.subagent_type ?? null, namesModel: ti.model != null, model: typeof ti.model === 'string' ? ti.model : null, background: !!ti.run_in_background };
    if (name === 'Workflow') { const wf = analyzeWorkflow(ti.script); return { ...base, kind: 'workflow', sub: null, namesModel: wf.calls.some((c) => !!c.model), model: null, workflow: { total: wf.total, pinned: wf.pinned, unpinned: wf.unpinned, unreadable: wf.unreadable, hash: wf.hash, calls: wf.calls } }; }
    return { ...base, kind: 'other' };
  }
  if (tool === 'muse') {
    if (name === 'subagent_spawn') return { ...base, kind: 'subagent_spawn', sub: ti.role ?? null, namesModel: ti.model != null, model: typeof ti.model === 'string' ? ti.model : null };
    return { ...base, kind: 'other' };
  }
  if (tool === 'codex') {
    // Unproved: any tool whose name looks like starting an agent is treated as a spawn; its arguments are read if present.
    if (name && /agent/i.test(name) && /(spawn|start|create|new|fork)/i.test(name)) {
      return { ...base, kind: 'spawn_agent', sub: ti.agent_type ?? ti.agent ?? ti.role ?? null, namesModel: ti.model != null || ti.reasoning_effort != null, model: typeof ti.model === 'string' ? ti.model : null, effort: ti.reasoning_effort ?? null };
    }
    return { ...base, kind: 'other' };
  }
  return { ...base, kind: 'other' };
}

// ---- The decision ---------------------------------------------------------------------------------------------------------
// ctx = { commissioned: Set of engineer keys, helpers: { <name>: { kind: 'role'|'legacy', engineer: 'family|effort', model, effort } }, families: Set of commissioned families }
export function decide(req, ctx = {}) {
  if (req.kind === 'other') return { decision: 'allow', reasons: ['not_a_delegation_call'] };
  const reasons = [];
  if (req.envWorker) reasons.push('worker_delegation_env');
  if (req.callerIsSubagent) reasons.push('worker_delegation_subagent');
  const commissioned = ctx.commissioned || new Set();
  const helpers = ctx.helpers || {};
  const checkExclusions = (h) => {
    if (!h || !ctx.excluded?.size) return;
    const family = h.family || h.engineer?.split('|')[0] || h.model;
    const e = { family, commissioned: true, routes: h.routes || [{ route: h.route, exec: h.exec || { model: h.model } }] };
    if (eligibleEngineer(e, ctx).reasons.some((x) => x.code === 'excluded_here')) reasons.push('excluded_here');
  };
  switch (req.kind) {
    case 'agent_spawn': {
      if (req.namesModel) reasons.push('names_model');
      if (isGeneric(req.sub)) reasons.push('inherits_boss_model');
      else {
        const h = helpers[String(req.sub).toLowerCase()];
        checkExclusions(h);
        if (!h) reasons.push('unknown_helper');
        else if (!commissioned.has(h.engineer)) reasons.push(h.kind === 'role' ? 'stale_helper' : 'decommissioned_engineer');
      }
      break;
    }
    case 'workflow': {
      const w = req.workflow;
      if (w.total > 0 && w.unpinned > 0) reasons.push('workflow_unpinned_agent');
      if (w.unreadable > 0) reasons.push('workflow_unreadable_options');
      for (const c of w.calls) {
        const wh = c.agentType ? helpers[String(c.agentType).toLowerCase()] : null;
        checkExclusions(wh);
        if (c.agentType && !wh) reasons.push('workflow_unknown_helper');
        else if (wh && !commissioned.has(wh.engineer)) reasons.push('decommissioned_engineer');
        if (c.model) reasons.push('names_model');
      }
      break;
    }
    case 'subagent_spawn': reasons.push('native_subagent'); break;
    case 'spawn_agent': {
      checkExclusions(helpers[String(req.sub).toLowerCase()]);
      if (req.namesModel) reasons.push('names_model');
      if (!req.sub || isGeneric(req.sub)) reasons.push('inherits_boss_model');
      else if (!helpers[String(req.sub).toLowerCase()]) reasons.push('unknown_helper');
      break;
    }
    default: break;
  }
  const uniq = [...new Set(reasons)];
  return { decision: uniq.length ? 'deny' : 'allow', reasons: uniq.length ? uniq : ['ok'] };
}

export const REFUSAL = {
  excluded_here: 'That engineer or model is switched off on this machine. Run role plan for an eligible engineer.',
  names_model: 'Delegate by role: do not name a model or effort. Run the front desk instead (role call --role <CTO|Tech lead|Developer|Junior>).',
  inherits_boss_model: 'This helper would run on the boss model. Delegate by role through the front desk, or use a role helper.',
  unknown_helper: 'That helper is not one of the installed role helpers. Delegate by role through the front desk.',
  decommissioned_engineer: 'That helper runs an engineer the owner has decommissioned. Delegate by role through the front desk.',
  stale_helper: 'That role helper no longer matches the installed ladder. Run role doctor.',
  workflow_unpinned_agent: 'Every agent() in a Workflow must name a role helper (agentType) or go through the front desk; otherwise it inherits the boss model.',
  workflow_unreadable_options: 'The options of an agent() call could not be read statically. Write them as literals, for example agent(prompt, { agentType: "developer" }).',
  worker_delegation_env: 'You are a dispatched worker: do not delegate.',
  worker_delegation_subagent: 'A subagent may not delegate further.',
  native_subagent: 'Native subagents run the parent model. Delegate by role through the front desk.',
};
export const refusalText = (reasons) => reasons.map((r) => REFUSAL[r]).filter(Boolean)[0] || 'Delegate by role through the front desk (role call --role <role>).';
