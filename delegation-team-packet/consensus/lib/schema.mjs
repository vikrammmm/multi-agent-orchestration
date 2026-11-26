import { readJson } from './fsx.mjs';
import { schemaPath } from './paths.mjs';

const cache = new Map();

export function loadSchema(phase) {
  if (!cache.has(phase)) cache.set(phase, readJson(schemaPath(phase)));
  return cache.get(phase);
}

export function extractJson(text) {
  if (text == null) return null;
  const raw = String(text).replace(/^\uFEFF/, '').trim();
  if (!raw) return null;
  const bare = tryParseObject(raw);
  if (bare) return bare;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const fenced = tryParseObject(fence[1].trim());
    if (fenced) return fenced;
  }
  const block = lastObjectBlock(raw);
  if (block) return tryParseObject(block);
  return null;
}

function tryParseObject(s) {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* not json */ }
  return null;
}

function lastObjectBlock(text) {
  let end = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === '}') { end = i; break; }
  }
  if (end === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      depth -= 1;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null;
}

export function validatePhase(phase, value) {
  const schema = loadSchema(phase);
  const errors = [];
  checkValue(value, schema, '', errors);
  if (phase === 'signoff' && value && value.verdict === 'NOT_DONE' && !usableNotDone(value)) {
    errors.push('signoff NOT_DONE needs a blocking item with checklist_line or defect+evidence');
  }
  // Keys the schema does not declare are dropped rather than rejected: validation stays
  // structural (required keys, enums, types) and undeclared text never reaches the reports.
  const pruned = errors.length === 0 ? pruneUnknown(value, schema) : value;
  return { ok: errors.length === 0, errors, value: pruned };
}

export function pruneUnknown(value, schema) {
  if (!schema || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return schema.items ? value.map((item) => pruneUnknown(item, schema.items)) : value;
  }
  if (!schema.properties) return value;
  const out = {};
  for (const [key, sub] of Object.entries(schema.properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = pruneUnknown(value[key], sub);
  }
  if (schema.additionalProperties !== false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value[key];
    }
  }
  return out;
}

export function usableNotDone(verdict) {
  const blocking = Array.isArray(verdict.blocking) ? verdict.blocking : [];
  return blocking.some((item) => {
    if (!item || typeof item !== 'object') return false;
    if (item.checklist_line !== undefined && item.checklist_line !== null) return true;
    const defect = item.defect != null && String(item.defect).trim() !== '';
    const evidence = item.evidence != null && String(item.evidence).trim() !== '';
    return defect && evidence;
  });
}

export function blockingKey(verdict) {
  const blocking = Array.isArray(verdict?.blocking) ? verdict.blocking : [];
  const keys = blocking.map((item) => {
    if (item && item.checklist_line !== undefined && item.checklist_line !== null) {
      return String(item.checklist_line);
    }
    const defect = String(item?.defect || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return defect.slice(0, 80);
  });
  keys.sort();
  return keys.join('|');
}

function checkValue(value, schema, path, errors) {
  if (!schema) return;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null;
  if (value === null) {
    if (types && !types.includes('null')) errors.push(`${path || '$'} must not be null`);
    return;
  }
  if (types) {
    const got = Array.isArray(value) ? 'array' : typeof value;
    const mapped = got === 'number' && Number.isInteger(value) ? 'integer' : got;
    if (!types.includes(mapped) && !(mapped === 'integer' && types.includes('number'))) {
      errors.push(`${path || '$'} expected ${types.join('|')}, got ${got}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path || '$'} must be one of ${schema.enum.join(', ')}`);
  }
  if (schema.type === 'object' || (!schema.type && schema.properties)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path || '$'} missing required key ${key}`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        checkValue(value[key], sub, path ? `${path}.${key}` : key, errors);
      }
    }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return;
    (value || []).forEach((item, i) => checkValue(item, schema.items || {}, `${path}[${i}]`, errors));
  }
}

export function isParseableText(text) {
  return extractJson(text) != null;
}
