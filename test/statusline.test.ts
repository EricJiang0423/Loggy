import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { readStatuslineMeters } from '../src/server/statusline';

test('reads snapshots written by `loggy statusline`', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-sl-'));
  const now = Date.now();
  const lines = [
    { ts: now - 3600_000, five: 10, seven: 30 },
    { ts: now - 60_000, five: 25, fiveReset: now + 7200_000, seven: 31, sevenReset: now + 86400_000, model: 'Opus 5.5' },
  ];
  fs.writeFileSync(path.join(dir, 'statusline.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{bad json\n');
  const [m] = readStatuslineMeters(dir);
  expect(m.agent).toBe('claude');
  expect(m.fiveHour?.usedPercent).toBe(25);
  expect(m.sevenDay?.usedPercent).toBe(31);
  expect(m.history).toEqual([
    [lines[0].ts, 10],
    [lines[1].ts, 25],
  ]);
  fs.rmSync(dir, { recursive: true });
});
