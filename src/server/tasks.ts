import type { AccState } from '../core/acc.js';
import { detailFile, summarizeFile } from '../core/parse.js';
import { setPriceOverrides, type Price } from '../core/pricing.js';
import type { Agent } from '../shared/types.js';

export type Task =
  | { kind: 'summary'; file: string; agent: Agent; resume?: { state: AccState; offset: number }; skipFrom?: string[] }
  | { kind: 'detail'; files: string[]; agent: Agent }
  | { kind: 'prices'; table: Record<string, Price> };

export function runTask(task: Task): unknown {
  switch (task.kind) {
    case 'summary':
      return summarizeFile(task.file, task.agent, task.resume, { skipFrom: task.skipFrom });
    case 'detail':
      return detailFile(task.files, task.agent);
    case 'prices':
      setPriceOverrides(task.table);
      return true;
  }
}
