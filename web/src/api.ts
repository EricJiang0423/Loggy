import type { InstructionsInfo, SessionDetail, SessionSummary, ServerState, UsageMeter } from '../../src/shared/types';

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

async function post<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  state: () => get<ServerState>('api/state'),
  sessions: (since: number) => get<{ gen: number; full: boolean; sessions: SessionSummary[]; removed: string[] }>(`api/sessions?since=${since}`),
  session: (id: string, signal?: AbortSignal) => get<SessionDetail>(`api/session?id=${encodeURIComponent(id)}`, signal),
  search: (q: string, signal?: AbortSignal) => get<{ ids: string[] }>(`api/search?q=${encodeURIComponent(q)}`, signal),
  usage: () => get<{ meters: UsageMeter[] }>('api/usage'),
  instructions: (project: string) => get<InstructionsInfo & { globals: { path: string; exists: boolean }[] }>(`api/instructions?project=${encodeURIComponent(project)}`),
  instructionVersion: (project: string, file: string, sha?: string, global = false) =>
    get<{ content: string; diff: string }>(
      `api/instructions/version?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}${sha ? `&sha=${sha}` : ''}${global ? '&global=1' : ''}`,
    ),
  summarize: (id: string, lang: string) => post<{ ai: SessionDetail['ai'] }>(`api/summarize?id=${encodeURIComponent(id)}&lang=${lang}`),
  setGroupBy: (groupBy: ServerState['groupBy']) => post<ServerState>(`api/settings?groupBy=${groupBy}`),
  rescan: (full: boolean) => post<{ ok: boolean }>(`api/rescan${full ? '?full=1' : ''}`),
};
