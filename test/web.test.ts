import { expect, test } from 'vitest';
import type { SessionSummary } from '../src/shared/types';
import { OTHER_KEY, legendEntries, slotMap } from '../web/src/colors';
import { comparablePeriod, earliestStart } from '../web/src/format';

test('the calendar legend folds projects without a color into one Other row', () => {
  const week = Array.from({ length: 20 }, (_, i) => ({ project: `p${i}`, models: [] }) as unknown as SessionSummary);
  const slots = slotMap(week, 'project');
  const rows = legendEntries(week, 'project', slots);
  expect(rows.length).toBe(9);
  expect(rows[rows.length - 1]).toEqual([OTHER_KEY, 12]);
});

test('period-over-period changes need data covering the whole previous period', () => {
  const day = 86400_000;
  const prevFrom = 100 * day;
  expect(comparablePeriod(prevFrom + 10 * day, prevFrom)).toBe(false);
  expect(comparablePeriod(prevFrom - day, prevFrom)).toBe(true);
});

test('sessions without a start time do not stretch the period back to 1970', () => {
  const s = (start: number) => ({ start }) as SessionSummary;
  expect(earliestStart([s(0), s(5000), s(3000)], 9999)).toBe(3000);
  expect(earliestStart([s(0)], 9999)).toBe(9999);
});
