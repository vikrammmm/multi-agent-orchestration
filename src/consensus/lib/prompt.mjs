import path from 'node:path';
import { readUtf8, toLf } from './fsx.mjs';
import { loadLimits } from './limits.mjs';
import { promptPath, schemaPath } from './paths.mjs';

const TEMPLATES = {
  'finish-line': 'finish-line.md',
  signoff: 'signoff.md',
  consult: 'consult.md',
  assess: 'assess.md',
  merge: 'merge.md',
  confirm: 'confirm.md',
  retry: 'retry-json.md',
};

export function loadTemplate(name) {
  return toLf(readUtf8(promptPath(name)));
}

export function schemaText(phase) {
  return toLf(readUtf8(schemaPath(phase)));
}

export function render(template, vars) {
  return toLf(String(template).replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) => (
    Object.prototype.hasOwnProperty.call(vars, key)
      ? (vars[key] == null ? '' : String(vars[key]))
      : m
  )));
}

export function inlineOrPath(content, filePath, maxBytes) {
  const text = content == null ? '' : String(content);
  const size = Buffer.byteLength(text, 'utf8');
  if (size > maxBytes) return `(not inlined; ${size} bytes; read the file at ${filePath})`;
  return text;
}

export function materialsBundle(materialsDir, texts = {}) {
  return {
    dir: materialsDir,
    goal: texts.goal || '',
    plan: texts.plan || '',
    checklist: texts.checklist || '',
    diff: texts.diff || '',
    tests: texts.tests || '',
    brief: texts.brief || '',
    goalPath: path.join(materialsDir, 'goal.md'),
    planPath: path.join(materialsDir, 'plan.md'),
    checklistPath: path.join(materialsDir, 'checklist.md'),
    diffPath: path.join(materialsDir, 'diff.patch'),
    testsPath: path.join(materialsDir, 'tests.txt'),
    briefPath: path.join(materialsDir, 'brief.md'),
  };
}

export function buildPrompt({ phase, project, materials, extra = {}, objections = '', previous = '' }) {
  const file = TEMPLATES[phase];
  if (!file) throw new Error(`Unknown prompt phase ${phase}`);
  const max = (loadLimits().inlineMaterialMaxBytes) || 153600;
  const schemaPhase = phase === 'retry' ? (extra.retryPhase || 'consult') : phase;
  const rules = render(loadTemplate('_rules.md'), { PROJECT: project || '' });
  let objectionsBlock = '';
  if (phase === 'merge' && objections) {
    objectionsBlock = render(loadTemplate('merge-objections.md'), {
      OBJECTIONS_LIST: extra.OBJECTIONS_LIST || objections,
      DRAFT: extra.DRAFT || '',
    });
  }
  return render(loadTemplate(file), {
    RULES: rules,
    GOAL: inlineOrPath(materials.goal, materials.goalPath, max),
    PLAN: inlineOrPath(materials.plan, materials.planPath, max),
    CHECKLIST: inlineOrPath(materials.checklist, materials.checklistPath, max),
    DIFF: inlineOrPath(materials.diff, materials.diffPath, max),
    TESTS: inlineOrPath(materials.tests, materials.testsPath, max),
    BRIEF: inlineOrPath(materials.brief, materials.briefPath, max),
    ANSWER_A: extra.ANSWER_A || '',
    ANSWER_B: extra.ANSWER_B || '',
    DRAFT: extra.DRAFT || '',
    OBJECTIONS: objectionsBlock,
    SCHEMA: schemaText(schemaPhase),
    PROJECT: project || '',
    MATERIALS_DIR: materials.dir || '',
    STAGE: extra.STAGE || '',
    PREVIOUS: previous,
    OBJECTIONS_LIST: extra.OBJECTIONS_LIST || '',
  });
}
