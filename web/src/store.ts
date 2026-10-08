import { useSyncExternalStore } from 'react';
import { liveStatus } from '../../src/shared/status';
import type { IndexProgress, SessionSummary, ServerState } from '../../src/shared/types';
import { api } from './api';

export interface StoreState {
  sessions: Map<string, SessionSummary>;
  list: SessionSummary[];
  gen: number;
  server?: ServerState;
  progress?: IndexProgress;
  online: boolean;
  loaded: boolean;
  now: number;
}

let state: StoreState = { sessions: new Map(), list: [], gen: 0, online: true, loaded: false, now: Date.now() };
const listeners = new Set<() => void>();

function set(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useStore<T>(select: (s: StoreState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

export function getState(): StoreState {
  return state;
}

function withStatus(list: SessionSummary[], now: number): SessionSummary[] {
  return list.map((s) => ({ ...s, status: liveStatus(s, now) }));
}

let fetching = false;
let again = false;

export async function refreshSessions(): Promise<void> {
  if (fetching) {
    again = true;
    return;
  }
  fetching = true;
  try {
    const d = await api.sessions(state.gen);
    const map = d.full ? new Map<string, SessionSummary>() : new Map(state.sessions);
    for (const id of d.removed) map.delete(id);
    for (const s of d.sessions) map.set(s.id, s);
    const now = Date.now();
    set({ sessions: map, list: withStatus([...map.values()], now), gen: d.gen, loaded: true, online: true, now });
  } catch {
    set({ online: false });
  } finally {
    fetching = false;
    if (again) {
      again = false;
      void refreshSessions();
    }
  }
}

export async function refreshServer(): Promise<void> {
  try {
    const server = await api.state();
    set({ server, progress: server.progress, online: true });
  } catch {
    set({ online: false });
  }
}

let started = false;

export function startSync(): void {
  if (started) return;
  started = true;
  void refreshServer();
  void refreshSessions();
  const es = new EventSource('api/events');
  es.addEventListener('hello', (e) => {
    const d = JSON.parse((e as MessageEvent).data);
    set({ online: true, progress: d.progress });
    if (d.gen !== state.gen) void refreshSessions();
  });
  es.addEventListener('update', () => {
    void refreshSessions();
  });
  es.addEventListener('remote', () => {
    void refreshServer();
  });
  es.addEventListener('progress', (e) => {
    const progress = JSON.parse((e as MessageEvent).data) as IndexProgress;
    set({ progress });
    if (progress.phase === 'ready') void refreshServer();
  });
  es.onerror = () => set({ online: false });
  es.onopen = () => set({ online: true });
  // Live status depends on the clock; recompute it regularly.
  window.setInterval(() => {
    const now = Date.now();
    set({ now, list: withStatus([...state.sessions.values()], now) });
  }, 15_000);
}
