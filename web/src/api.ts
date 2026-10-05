import type { InstructionsInfo, SessionDetail, SessionSummary, ServerState } from '../../src/shared/types';

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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json();
  if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`);
  return out as T;
}

/** The AI settings form; apiKey: undefined keeps the saved key, '' removes it. */
export interface AiForm {
  enabled: boolean;
  provider: 'anthropic' | 'openai';
  baseURL: string;
  model: string;
  auth: 'x-api-key' | 'bearer';
  apiKeyEnv: string;
  headers: Record<string, string>;
  apiKey?: string;
}

export const api = {
  state: () => get<ServerState>('api/state'),
  sessions: (since: number) => get<{ gen: number; full: boolean; sessions: SessionSummary[]; removed: string[] }>(`api/sessions?since=${since}`),
  session: (id: string, signal?: AbortSignal) => get<SessionDetail>(`api/session?id=${encodeURIComponent(id)}`, signal),
  search: (q: string, signal?: AbortSignal) => get<{ ids: string[] }>(`api/search?q=${encodeURIComponent(q)}`, signal),
  instructions: (project: string) => get<InstructionsInfo & { globals: { path: string; exists: boolean }[] }>(`api/instructions?project=${encodeURIComponent(project)}`),
  instructionVersion: (project: string, file: string, sha?: string, global = false) =>
    get<{ content: string; diff: string }>(
      `api/instructions/version?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}${sha ? `&sha=${sha}` : ''}${global ? '&global=1' : ''}`,
    ),
  summarize: (id: string, lang: string) => post<{ ai: SessionDetail['ai'] }>(`api/summarize?id=${encodeURIComponent(id)}&lang=${lang}`),
  setGroupBy: (groupBy: ServerState['groupBy']) => post<ServerState>(`api/settings?groupBy=${groupBy}`),
  saveAi: (body: AiForm) => postJson<ServerState>('api/settings/ai', body),
  testAi: (body: AiForm) => postJson<{ ok: boolean; model: string; ms: number; reply?: string; error?: string }>('api/ai/test', body),
  rescan: (full: boolean) => post<{ ok: boolean }>(`api/rescan${full ? '?full=1' : ''}`),
};
