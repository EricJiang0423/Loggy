import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { runTask, type Task } from './tasks.js';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** Small worker pool. Falls back to running tasks inline when no worker script is available. */
export class Pool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { id: number; task: Task; priority: boolean }[] = [];
  private pending = new Map<number, Pending>();
  private busy = new Map<Worker, number>();
  private nextId = 1;

  constructor(workerUrl: URL | undefined, size = Math.max(1, Math.min((os.availableParallelism?.() ?? os.cpus().length) - 1, 6))) {
    if (!workerUrl || !fs.existsSync(fileURLToPath(workerUrl))) return;
    for (let i = 0; i < size; i++) {
      const w = new Worker(workerUrl);
      w.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (this.busy.get(w) === msg.id) this.busy.delete(w);
        if (!this.busy.has(w) && !this.idle.includes(w)) this.idle.push(w);
        if (p) {
          if (msg.error !== undefined) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        }
        this.pump();
      });
      w.on('error', (err) => {
        const id = this.busy.get(w);
        if (id !== undefined) this.pending.get(id)?.reject(err);
      });
      w.unref();
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  get size(): number {
    return Math.max(1, this.workers.length);
  }

  /** Priority tasks (e.g. a detail request from the UI) jump the queue. */
  run<T>(task: Task, priority = false): Promise<T> {
    if (!this.workers.length) {
      return new Promise((resolve, reject) => {
        setImmediate(() => {
          try {
            resolve(runTask(task) as T);
          } catch (e) {
            reject(e as Error);
          }
        });
      });
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      if (priority) this.queue.unshift({ id, task, priority });
      else this.queue.push({ id, task, priority });
      this.pump();
    });
  }

  /** Sends a task to every worker (used for configuration). */
  async broadcast(task: Task): Promise<void> {
    runTask(task);
    await Promise.all(
      this.workers.map(
        (w) =>
          new Promise<void>((resolve) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve: () => resolve(), reject: () => resolve() });
            w.postMessage({ id, task });
          }),
      ),
    );
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.busy.set(w, job.id);
      w.postMessage({ id: job.id, task: job.task });
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
