import { expect, test } from 'vitest';
import { classifySessions, type ClassifyInput } from '../src/server/classify';

const sessions: ClassifyInput[] = [
  { id: 'claude:1', project: 'loggy', projectPath: '/w/loggy', title: 'Fix rewind merge', type: 'bugfix' },
  { id: 'claude:2', project: 'loggy', projectPath: '/w/loggy', title: 'Add calendar view', type: 'implementation' },
  { id: 'codex:3', project: 'futures', projectPath: '/w/futures', title: 'Daily report', type: 'docs' },
  { id: 'codex:4', project: 'futures', projectPath: '/w/futures', title: 'Fix crawler', type: 'bugfix' },
];

test('projects are described, grouped into categories, and every session gets one', async () => {
  const prompts: string[] = [];
  const complete = async (system: string, user: string) => {
    prompts.push(`${system}\n${user}`);
    if (system.includes('STEP 1')) return JSON.stringify({ projects: [{ key: 'P1', description: 'A log dashboard' }, { key: 'P2', description: 'Futures research and reports' }] });
    if (system.includes('STEP 2')) return '```json\n' + JSON.stringify({ categories: [{ name: 'Dev tools', description: 'tools' }, { name: 'Quant research', description: 'research' }], projects: [{ key: 'P1', category: 'Dev tools' }, { key: 'P2', category: 'Quant research' }] }) + '\n```';
    return JSON.stringify({ sessions: [{ key: 'S1', category: 'Dev tools' }, { key: 'S2', category: 'Dev tools' }, { key: 'S3', category: 'Quant research' }, { key: 'S4', category: 'Not a category' }] });
  };
  const r = await classifySessions(sessions, complete, { lang: 'en', previous: ['Quant research'] });
  expect(r.categories.map((c) => c.name)).toEqual(['Dev tools', 'Quant research']);
  expect(r.projects['/w/loggy']).toEqual({ name: 'loggy', description: 'A log dashboard', category: 'Dev tools' });
  expect(r.sessions['claude:2']).toBe('Dev tools');
  expect(r.sessions['codex:4']).toBe('Quant research'); // unknown answer falls back to the project's category
  expect(prompts[1]).toContain('Quant research'); // earlier names are offered for reuse
  expect(prompts).toHaveLength(3);
});
