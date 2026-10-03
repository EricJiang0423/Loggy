import type { AccState } from '../core/acc.js';
import { detailFile, summarizeFile } from '../core/parse.js';
import { setPriceOverrides, type Price } from '../core/pricing.js';
import type { Agent } from '../shared/types.js';

export type Task =
  | { kind: 'summary'; file: string; agent: Agent; resume?: { state: AccState; offset: number } }
  | { kind: 'detail'; file: string; agent: Agent }
  | { kind: 'prices'; table: Record<string, Price> };

export function runTask(task: Task): unknown {
  switch (task.kind) {
    case 'summary':
      return summarizeFile(task.file, task.agent, task.resume);
    case 'detail':
      return detailFile(task.file, task.agent);
    case 'prices':
      setPriceOverrides(task.table);
      return true;
  }
}
