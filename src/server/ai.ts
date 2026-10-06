// Optional AI summary of a session (title, bullets, decisions, request status). Runs only
// when the user clicks the button. Works with the Anthropic API, an Anthropic-format gateway
// or any OpenAI-compatible endpoint (e.g. a model deployed inside a company).

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AiSummary, SessionDetail } from '../shared/types.js';
import { ensureDir } from './config.js';

/** What the user saved in Settings (settings.json). */
export interface AiSettings {
  enabled?: boolean;
  /** API format: Anthropic Messages or OpenAI Chat Completions. */
  provider?: 'anthropic' | 'openai';
  baseURL?: string;
  model?: string;
  apiKey?: string;
  /** Read the key from this environment variable instead of storing it. */
  apiKeyEnv?: string;
  /** Anthropic format only: send the key as x-api-key or as a bearer token. */
  auth?: 'x-api-key' | 'bearer';
  headers?: Record<string, string>;
  /** Summarize recent sessions in the background. */
  auto?: boolean;
  /** Language of every summary, so they all read the same. */
  lang?: 'zh-CN' | 'en';
}

/** The endpoint actually used. */
export interface AiConfig {
  provider: 'anthropic' | 'openai';
  baseURL?: string;
  model: string;
  apiKey?: string;
  auth: 'x-api-key' | 'bearer';
  headers: Record<string, string>;
  source: 'settings' | 'env';
}

/** Saved settings win; without them Loggy falls back to ANTHROPIC_* environment variables. */
export function resolveAi(s: AiSettings | undefined, env: Record<string, string | undefined>, defaultModel: string): AiConfig | undefined {
  if (s?.enabled === false) return undefined;
  if (s && (s.provider || s.baseURL || s.model || s.apiKey || s.apiKeyEnv)) {
    const provider = s.provider ?? 'anthropic';
    const baseURL = s.baseURL?.trim().replace(/\/+$/, '') || undefined;
    const official = provider === 'anthropic' && !baseURL;
    const apiKey = s.apiKey || (s.apiKeyEnv ? env[s.apiKeyEnv] : undefined) || (official ? env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN : undefined) || undefined;
    if (provider === 'openai' && !baseURL) return undefined;
    if (!apiKey && !baseURL) return undefined;
    const auth = s.auth ?? (official && !s.apiKey && !s.apiKeyEnv && !env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN ? 'bearer' : 'x-api-key');
    return { provider, baseURL, model: s.model?.trim() || defaultModel, apiKey, auth, headers: s.headers ?? {}, source: 'settings' };
  }
  const apiKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) return undefined;
  return { provider: 'anthropic', baseURL: env.ANTHROPIC_BASE_URL || undefined, model: defaultModel, apiKey, auth: env.ANTHROPIC_API_KEY ? 'x-api-key' : 'bearer', headers: {}, source: 'env' };
}

/** Version of the summary layout; summaries in an older layout are made again. */
export const SUMMARY_FORMAT = 2;

export const WORK_TYPES = ['implementation', 'bugfix', 'refactor', 'research', 'review', 'docs', 'ops', 'other'] as const;

const SummarySchema = z.object({
  title: z.string(),
  bullets: z.array(z.string()),
  decisions: z.array(z.string()),
  unverified: z.array(z.string()),
  concerns: z.array(z.string()),
  openQuestions: z.array(z.string()),
  nextSteps: z.array(z.string()),
  requests: z.array(
    z.object({
      text: z.string(),
      kind: z.enum(['consult', 'request', 'follow_up', 'polish']),
      done: z.boolean(),
    }),
  ),
  type: z.enum(WORK_TYPES),
  workComplete: z.boolean(),
});

const MAX_INPUT_CHARS = 120_000;

function cacheDir(dataDir: string): string {
  return ensureDir(path.join(dataDir, 'summaries'));
}

function keyOf(id: string): string {
  return crypto.createHash('sha1').update(id).digest('hex');
}

export function readAiSummary(dataDir: string, id: string): AiSummary | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir(dataDir), `${keyOf(id)}.json`), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Every saved summary that knows its session id. */
export function readAllAiSummaries(dataDir: string): Map<string, AiSummary> {
  const out = new Map<string, AiSummary>();
  for (const f of fs.readdirSync(cacheDir(dataDir))) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(cacheDir(dataDir), f), 'utf8')) as AiSummary;
      if (s.id) out.set(s.id, s);
    } catch {
      // ignore a broken file
    }
  }
  return out;
}

/** Builds a compact transcript: user requests, replies, tools, files and commits. */
export function transcriptFor(d: Omit<SessionDetail, 'ai'>): string {
  const parts: string[] = [];
  parts.push(`Project: ${d.summary.project} (${d.summary.cwd})`);
  if (d.summary.branch) parts.push(`Branch: ${d.summary.branch}`);
  for (const t of d.turns) {
    parts.push(`\n## Turn ${t.idx}${t.interrupted ? ' (interrupted)' : ''}`);
    const userItems = d.timeline.filter((i) => i.turn === t.idx && i.kind === 'user').map((i) => i.text.slice(0, 3000));
    parts.push(`User: ${userItems.join('\n---\n') || t.prompt}`);
    const tools = d.timeline.filter((i) => i.turn === t.idx && i.kind === 'tool').map((i) => `${i.tool}: ${i.text.slice(0, 120)}`);
    if (tools.length) parts.push(`Tools (${tools.length}): ${tools.slice(0, 25).join(' | ')}`);
    if (t.files.length) parts.push(`Files changed: ${t.files.slice(0, 30).join(', ')}`);
    const commits = d.commits.filter((c) => c.turn === t.idx).map((c) => `${c.sha.slice(0, 7)} ${c.message ?? ''}`);
    if (commits.length) parts.push(`Commits: ${commits.join('; ')}`);
    const q = d.questions.filter((x) => x.turn === t.idx).flatMap((x) => x.questions.map((qq) => `${qq.question} -> ${qq.answer ?? '(no answer)'}`));
    if (q.length) parts.push(`Questions asked: ${q.join('; ')}`);
    if (t.response) parts.push(`Assistant (final): ${t.response.slice(0, 1500)}`);
  }
  let text = parts.join('\n');
  if (text.length > MAX_INPUT_CHARS) {
    const head = text.slice(0, MAX_INPUT_CHARS * 0.3);
    const tail = text.slice(-MAX_INPUT_CHARS * 0.7);
    text = `${head}\n\n[... middle of the session omitted ...]\n\n${tail}`;
  }
  return text;
}

export const languageName = (lang: string) => (lang.startsWith('zh') ? 'Simplified Chinese' : 'English');

/** The language rule, stated in the system prompt and again after the transcript. */
export const languageRule = (lang: string) =>
  `Write every text value in ${languageName(lang)}, even when the transcript or the session titles are in another language. Keep code, file paths, commands and product or model names as they are.`;

const HAN = /\p{Script=Han}/gu;

/**
 * Whether text is in the wanted language: Chinese needs mostly Chinese characters, English almost
 * none. Code spans, paths, URLs and dotted names are left out, since they stay as they are.
 */
export function inLanguage(texts: string[], lang: string): boolean {
  const text = texts.join('\n').replace(/`[^`]*`/g, ' ').replace(/\S*[/\\.:_]\S*/g, ' ');
  const han = (text.match(HAN) ?? []).length;
  const words = (text.match(/[A-Za-z]{2,}/g) ?? []).length;
  if (han + words < 3) return true;
  const share = han / (han + words);
  return lang.startsWith('zh') ? share >= 0.4 : share < 0.1;
}

/** Every free-text value of a summary. */
export function summaryTexts(s: Pick<AiSummary, 'title' | 'bullets' | 'decisions' | 'unverified' | 'concerns' | 'openQuestions' | 'nextSteps' | 'requests'>): string[] {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const reqs = Array.isArray(s.requests) ? s.requests.map((q) => (typeof q?.text === 'string' ? q.text : '')) : [];
  return [typeof s.title === 'string' ? s.title : '', ...list(s.bullets), ...list(s.decisions), ...list(s.unverified), ...list(s.concerns), ...list(s.openQuestions), ...list(s.nextSteps), ...reqs];
}

const SYSTEM = `You summarize a coding-agent session for the person who ran it, so they can see at a glance what happened.
Be concrete and short; do not invent facts that are not in the transcript.
Every summary has the same fields, in this order. Lists may be empty; never add other fields.
- title: what the session was about, at most 60 characters, no trailing period.
- bullets: 2-6 short points on what was done or found, each one sentence.
- decisions: choices made during the session and why.
- unverified: things that were done or claimed but not checked (tests not run, UI not looked at, assumptions).
- concerns: risks or problems that may still be there.
- openQuestions: questions to the user that were not answered.
- nextSteps: concrete things left for the user to do next, most important first, at most 3.
- requests: every user request in order. kind is "consult" for questions or discussion, "request" for the first ask of a task, "follow_up" for an added or changed ask, "polish" for finishing touches such as commit, rename or docs. done says whether the agent completed it.
- type: exactly one of implementation, bugfix, refactor, research, review, docs, ops, other.
- workComplete: true when every request was finished and nothing is left for the user to follow up.`;

const JSON_SHAPE = `Reply with only a JSON object, no prose and no code fences, with these keys:
title (string), bullets, decisions, unverified, concerns, openQuestions, nextSteps (arrays of strings),
requests (array of {"text": string, "kind": "consult" | "request" | "follow_up" | "polish", "done": boolean}),
type ("implementation" | "bugfix" | "refactor" | "research" | "review" | "docs" | "ops" | "other"), workComplete (boolean).`;

/** Reads the summary JSON from a model reply (tolerates code fences and stray text). */
export function parseSummaryJson(text: string): z.infer<typeof SummarySchema> {
  const body = text.replace(/```(?:json)?/gi, '');
  const from = body.indexOf('{');
  const to = body.lastIndexOf('}');
  if (from === -1 || to <= from) throw new Error('The model did not return JSON.');
  const result = SummarySchema.safeParse(JSON.parse(body.slice(from, to + 1)));
  if (!result.success) throw new Error(`The model returned an incomplete summary (${result.error.issues.map((i) => i.path.join('.')).join(', ')}).`);
  return result.data;
}

function anthropicClient(c: AiConfig): Anthropic {
  return new Anthropic({
    // Explicit values, so ANTHROPIC_* variables never redirect a configured endpoint.
    baseURL: c.baseURL ?? 'https://api.anthropic.com',
    apiKey: c.auth === 'x-api-key' ? (c.apiKey ?? null) : null,
    authToken: c.auth === 'bearer' ? (c.apiKey ?? null) : null,
    defaultHeaders: c.headers,
    maxRetries: 1,
    timeout: 180_000,
  });
}

/** One plain completion; returns the reply text. */
export async function complete(c: AiConfig, system: string, user: string, maxTokens: number): Promise<string> {
  if (c.provider === 'openai') {
    const res = await fetch(`${c.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}), ...c.headers },
      body: JSON.stringify({ model: c.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(180_000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${c.baseURL}: ${raw.slice(0, 300)}`);
    const content = JSON.parse(raw).choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((p: { text?: string }) => p.text ?? '').join('');
    throw new Error('The endpoint returned no message content.');
  }
  const msg = await anthropicClient(c).messages.create({ model: c.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

async function summaryOnce(c: AiConfig, system: string, user: string): Promise<z.infer<typeof SummarySchema>> {
  if (c.provider === 'anthropic' && !c.baseURL) {
    // The Anthropic API enforces the schema; gateways and other models get a JSON instruction.
    const response = await anthropicClient(c).messages.parse({
      model: c.model,
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: zodOutputFormat(SummarySchema) },
    });
    if (!response.parsed_output) throw new Error(response.stop_reason === 'refusal' ? 'The model declined to summarize this session.' : 'The model returned no summary.');
    return response.parsed_output;
  }
  return parseSummaryJson(await complete(c, `${system}\n\n${JSON_SHAPE}`, user, 8000));
}

export async function summarizeWithAi(dataDir: string, c: AiConfig, detail: Omit<SessionDetail, 'ai'>, lang: string): Promise<AiSummary> {
  const language = languageName(lang);
  const system = `${SYSTEM}\n\nLanguage: ${languageRule(lang)}`;
  const user = `<transcript>\n${transcriptFor(detail)}\n</transcript>\n\n${languageRule(lang)}`;
  let parsed = await summaryOnce(c, system, user);
  if (!inLanguage(summaryTexts(parsed), lang)) {
    // Models drift into the transcript's language; ask once more, then give up rather than save it.
    parsed = await summaryOnce(c, system, `${user}\n\nA previous answer was not written in ${language}. Every text value must be in ${language}.`);
    if (!inLanguage(summaryTexts(parsed), lang)) throw new Error(`The model did not write the summary in ${language}.`);
  }
  const s = detail.summary;
  const summary: AiSummary = { ...parsed, id: s.id, format: SUMMARY_FORMAT, lang, model: c.model, createdAt: Date.now(), basis: { end: s.end, turns: s.turns } };
  fs.writeFileSync(path.join(cacheDir(dataDir), `${keyOf(detail.summary.id)}.json`), JSON.stringify(summary));
  return summary;
}

/** Sends a tiny request to check address, key and model. */
export async function testAi(c: AiConfig): Promise<{ ok: boolean; model: string; ms: number; reply?: string; error?: string }> {
  const t0 = Date.now();
  try {
    const reply = await complete(c, 'Reply with the single word OK.', 'ping', 256);
    return { ok: true, model: c.model, ms: Date.now() - t0, reply: reply.trim().slice(0, 60) };
  } catch (err) {
    return { ok: false, model: c.model, ms: Date.now() - t0, error: aiErrorMessage(err) };
  }
}

export function aiErrorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was rejected.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited. Try again shortly.';
  if (err instanceof Anthropic.NotFoundError) return `Not found: ${err.message} (check the address and the model name).`;
  if (err instanceof Anthropic.BadRequestError) return `Request rejected: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return `Cannot reach the endpoint: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
