// Worker thread entry: parses log files off the main thread so the HTTP server stays responsive.

import { parentPort } from 'node:worker_threads';
import { runTask, type Task } from './tasks.js';

parentPort?.on('message', (msg: { id: number; task: Task }) => {
  try {
    const result = runTask(msg.task);
    parentPort!.postMessage({ id: msg.id, result });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
