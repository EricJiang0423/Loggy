// Smart categories: the model first says what each project is doing, then groups the projects
// into a few broad categories, then puts every recent session in one of them. Earlier category
// names are offered back so the categories (and their colors) stay stable from day to day.

import fs from 'node:fs';
import path from 'node:path';

export interface ClassifyInput {
  id: string;
  project: string;
  projectPath: string;
  title: string;
  type?: string;
}

export interface Categories {
  updatedAt: number;
  model?: string;
  lang: string;
  categories: { name: string; description: string }[];
  /** projectPath -> what the project is doing and its category */
  projects: Record<string, { name: string; description: string; category: string }>;
  /** session id -> category */
  sessions: Record<string, string>;
}

type Complete = (system: string, user: string) => Promise<string>;

const MAX_TITLES = 25;
const SESSION_BATCH = 80;

function json(text: string): any {
  const body = text.replace(/```(?:json)?/gi, '');
  const from = body.indexOf('{');
  const to = body.lastIndexOf('}');
  if (from === -1 || to <= from) throw new Error('The model did not return JSON.');
  return JSON.parse(body.slice(from, to + 1));
}

const language = (lang: string) => (lang.startsWith('zh') ? 'Simplified Chinese' : 'English');

export async function classifySessions(list: ClassifyInput[], complete: Complete, o: { lang: string; previous?: string[]; model?: string }): Promise<Categories> {
  const byProject = new Map<string, ClassifyInput[]>();
  for (const s of list) byProject.set(s.projectPath, [...(byProject.get(s.projectPath) ?? []), s]);
  const projects = [...byProject.entries()].map(([projectPath, items], i) => ({ key: `P${i + 1}`, projectPath, name: items[0].project, items }));

  // Step 1: what each project is doing.
  const step1 = json(
    await complete(
      `STEP 1. For each project, write one short sentence in ${language(o.lang)} saying what it is about and what was done in it recently, based on its session titles. Reply with only JSON: {"projects": [{"key": "P1", "description": "..."}]}.`,
      projects.map((p) => `${p.key} ${p.name} (${p.items.length} sessions): ${p.items.slice(0, MAX_TITLES).map((s) => s.title.slice(0, 60)).join(' | ')}`).join('\n'),
    ),
  );
  const desc = new Map<string, string>((step1.projects ?? []).map((p: { key: string; description: string }) => [p.key, String(p.description ?? '')]));

  // Step 2: a few broad categories, and each project's category.
  const prev = o.previous?.length ? `\nCategories used before (reuse a name when it still fits): ${o.previous.join(', ')}` : '';
  const step2 = json(
    await complete(
      `STEP 2. Group these projects into 4 to 8 broad categories of work. Category names are short (at most 12 characters in Chinese or 3 words in English), in ${language(o.lang)}, distinct and not overlapping. Every project gets exactly one category. Reply with only JSON: {"categories": [{"name": "...", "description": "one sentence"}], "projects": [{"key": "P1", "category": "..."}]}.${prev}`,
      projects.map((p) => `${p.key} ${p.name}: ${desc.get(p.key) ?? ''}`).join('\n'),
    ),
  );
  const categories: Categories['categories'] = (step2.categories ?? [])
    .filter((c: { name?: unknown }) => typeof c?.name === 'string' && c.name.trim())
    .map((c: { name: string; description?: string }) => ({ name: c.name.trim(), description: String(c.description ?? '') }));
  const names = new Set(categories.map((c) => c.name));
  const projectCat = new Map<string, string>();
  for (const a of step2.projects ?? []) if (names.has(a?.category)) projectCat.set(a.key, a.category);

  const out: Categories = { updatedAt: Date.now(), model: o.model, lang: o.lang, categories, projects: {}, sessions: {} };
  for (const p of projects) {
    out.projects[p.projectPath] = { name: p.name, description: desc.get(p.key) ?? '', category: projectCat.get(p.key) ?? categories[0]?.name ?? '' };
  }

  // Step 3: every session, so a project that mixes kinds of work is split up.
  const keyed = list.map((s, i) => ({ key: `S${i + 1}`, s }));
  for (let i = 0; i < keyed.length; i += SESSION_BATCH) {
    const batch = keyed.slice(i, i + SESSION_BATCH);
    let answer: any = {};
    try {
      answer = json(
        await complete(
          `STEP 3. Put each session in one of these categories: ${categories.map((c) => `"${c.name}" (${c.description})`).join('; ')}. The project's category is a hint, not a rule. Reply with only JSON: {"sessions": [{"key": "S1", "category": "..."}]}.`,
          batch.map(({ key, s }) => `${key} [${out.projects[s.projectPath]?.category ?? ''}] ${s.project}: ${s.title.slice(0, 80)}${s.type ? ` (${s.type})` : ''}`).join('\n'),
        ),
      );
    } catch {
      // keep the project's category for this batch
    }
    const got = new Map<string, string>((answer.sessions ?? []).map((a: { key: string; category: string }) => [a.key, a.category]));
    for (const { key, s } of batch) {
      const c = got.get(key);
      out.sessions[s.id] = c && names.has(c) ? c : out.projects[s.projectPath].category;
    }
  }
  return out;
}

export function readCategories(dataDir: string): Categories | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'categories.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeCategories(dataDir: string, c: Categories): void {
  fs.writeFileSync(path.join(dataDir, 'categories.json'), JSON.stringify(c, null, 2));
}
