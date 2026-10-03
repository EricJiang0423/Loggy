import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { DICTS, translate } from '../web/src/i18n';

test('Chinese and English have the same keys and placeholders', () => {
  const en = DICTS.en;
  const zh = DICTS['zh-CN'];
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  for (const k of Object.keys(en) as (keyof typeof en)[]) {
    const vars = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort();
    expect(vars(zh[k]), k).toEqual(vars(en[k]));
  }
});

test('English plurals', () => {
  expect(translate('en', 'out.commits', { n: 1 })).toBe('1 commit');
  expect(translate('en', 'out.commits', { n: 3 })).toBe('3 commits');
  expect(translate('zh-CN', 'out.commits', { n: 3 })).toBe('3 个提交');
});

test('no Japanese text in the UI sources', () => {
  const dir = path.join(__dirname, '../web/src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(tsx?|css|html)$/.test(f.name)) files.push(p);
    }
  };
  walk(dir);
  for (const f of files) expect(/[぀-ヿ]/.test(fs.readFileSync(f, 'utf8')), f).toBe(false);
});
