// Optional AI summary of a session (title, bullets, decisions, request status). Runs only
// when the user clicks the button and an Anthropic API key is configured.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AiSummary, SessionDetail } from '../shared/types.js';
import { ensureDir } from './config.js';

const SummarySchema = z.object({
  title: z.string(),
  bullets: z.array(z.string()),
  decisions: z.array(z.string()),
  requests: z.array(
    z.object({
      text: z.string(),
      kind: z.enum(['consult', 'request', 'follow_up', 'polish']),
      done: z.boolean(),
    }),
  ),
  type: z.string(),
  workComplete: z.boolean(),
});

const MAX_INPUT_CHARS = 120_000;

export function aiAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

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

const SYSTEM = `You summarize a coding-agent session for the person who ran it, so they can see at a glance what happened.
Write in the requested language. Be concrete and short; do not invent facts that are not in the transcript.
- title: what the session was about, at most 60 characters.
- bullets: 2-6 short points on what was done or found.
- decisions: choices made during the session and why (empty if none).
- requests: every user request in order. kind is "consult" for questions or discussion, "request" for the first ask of a task, "follow_up" for an added or changed ask, "polish" for finishing touches such as commit, rename or docs. done says whether the agent completed it.
- type: one or two words for the kind of work (for example implementation, bug fix, refactor, research, review, docs).
- workComplete: true when every request was finished and nothing is left for the user to follow up.`;

export async function summarizeWithAi(dataDir: string, model: string, detail: Omit<SessionDetail, 'ai'>, lang: string): Promise<AiSummary> {
  const client = new Anthropic();
  const language = lang.startsWith('zh') ? 'Simplified Chinese' : 'English';
  const response = await client.messages.parse({
    model,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: `Language: ${language}\n\n<transcript>\n${transcriptFor(detail)}\n</transcript>` }],
    output_config: { format: zodOutputFormat(SummarySchema) },
  });
  const parsed = response.parsed_output;
  if (!parsed) throw new Error(response.stop_reason === 'refusal' ? 'The model declined to summarize this session.' : 'The model returned no summary.');
  const summary: AiSummary = { ...parsed, lang, model, createdAt: Date.now() };
  fs.writeFileSync(path.join(cacheDir(dataDir), `${keyOf(detail.summary.id)}.json`), JSON.stringify(summary));
  return summary;
}

export function aiErrorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Invalid Anthropic API key.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API. Try again shortly.';
  if (err instanceof Anthropic.BadRequestError) return `Request rejected: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
