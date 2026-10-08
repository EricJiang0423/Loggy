import type { InstructionsInfo, MarkLabel, SessionDetail, SessionMark, SessionSummary, ServerState } from '../../src/shared/types';

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
  auto: boolean;
  lang: 'zh-CN' | 'en';
  apiKey?: string;
}

export interface GitCommitRow {
  sha: string;
  author: string;
  date: string;
  subject: string;
  parents: string[];
  refs: string[];
  added: number;
  removed: number;
  files: number;
  session?: string;
}

export interface GitShow {
  sha: string;
  message: string;
  files: { path: string; added: number; removed: number }[];
  diff: string;
  cut: boolean;
}

const enc = encodeURIComponent;

export const api = {
  gitProjects: () => get<{ projects: { path: string; name: string }[] }>('api/git/projects'),
  gitLog: (project: string, q: string, path: string) => get<{ commits: GitCommitRow[] }>(`api/git/log?project=${enc(project)}&q=${enc(q)}&path=${enc(path)}`),
  gitShow: (project: string, sha: string) => get<GitShow>(`api/git/show?project=${enc(project)}&sha=${enc(sha)}`),
  gitLines: (project: string) => get<{ days: string[]; series: Record<string, number[]> }>(`api/git/lines?project=${enc(project)}`),
  state: () => get<ServerState>('api/state'),
  sessions: (since: number) => get<{ gen: number; full: boolean; sessions: SessionSummary[]; removed: string[] }>(`api/sessions?since=${since}`),
  session: (id: string, signal?: AbortSignal) => get<SessionDetail>(`api/session?id=${encodeURIComponent(id)}`, signal),
  handoff: (body: { id: string; to: 'claude' | 'codex'; target: 'cmux' | 'terminal' | 'app' | 'copy'; text: string; lang: string }) =>
    postJson<{ file: string; cwd: string; command: string; note?: 'cmuxBlocked' }>('api/handoff', body),
  mark: (id: string, patch: { star?: boolean; label?: MarkLabel | null; note?: string }) => postJson<{ mark: SessionMark | null }>('api/mark', { id, ...patch }),
  related: (id: string) => get<{ related: { id: string; shared: number }[] }>(`api/related?id=${encodeURIComponent(id)}`),
  search: (q: string, signal?: AbortSignal) => get<{ ids: string[] }>(`api/search?q=${encodeURIComponent(q)}`, signal),
  instructions: (project: string) => get<InstructionsInfo & { globals: { path: string; exists: boolean }[] }>(`api/instructions?project=${encodeURIComponent(project)}`),
  instructionVersion: (project: string, file: string, sha?: string, global = false) =>
    get<{ content: string; diff: string }>(
      `api/instructions/version?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}${sha ? `&sha=${sha}` : ''}${global ? '&global=1' : ''}`,
    ),
  summarize: (id: string, lang: string) => post<{ ai: SessionDetail['ai'] }>(`api/summarize?id=${encodeURIComponent(id)}&lang=${lang}`),
  setGroupBy: (groupBy: ServerState['groupBy']) => post<ServerState>(`api/settings?groupBy=${groupBy}`),
  setHarness: (agent: string, on: boolean) => post<ServerState>(`api/settings?harness=${agent}&on=${on ? 1 : 0}`),
  saveAi: (body: AiForm) => postJson<ServerState>('api/settings/ai', body),
  testAi: (body: AiForm) => postJson<{ ok: boolean; model: string; ms: number; reply?: string; error?: string }>('api/ai/test', body),
  classify: () => postJson<unknown>('api/ai/classify', {}),
  runAuto: () => postJson<NonNullable<ServerState['ai']['autoStatus']>>('api/ai/auto/run', {}),
  remote: (body: { host?: string; on?: boolean; cloud?: boolean; add?: { target: string; port?: number; identity?: string }; remove?: string }) => postJson<ServerState>('api/remote', body),
  rescan: (full: boolean) => post<{ ok: boolean }>(`api/rescan${full ? '?full=1' : ''}`),
};
