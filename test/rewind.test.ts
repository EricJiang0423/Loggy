import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { detailFile, summarizeFile } from '../src/core/parse';
import { Indexer } from '../src/server/indexer';
import { Pool } from '../src/server/pool';

// Claude Code's rewind forks the conversation: a new session file starts with a copy of the
// records up to the chosen point (same uuid and timestamp, new sessionId), then continues.
// The original file keeps everything, including the turns that were rewound.

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
let root = '';
let dir = '';
let fileA = '';
let fileB = '';

function rec(sessionId: string, uuid: string, parentUuid: string | null, ts: string, body: object) {
  return { parentUuid, isSidechain: false, cwd: '/w/app', sessionId, version: '2.1.290', gitBranch: 'main', uuid, timestamp: ts, ...body };
}
const human = (sid: string, uuid: string, parent: string | null, ts: string, text: string) =>
  rec(sid, uuid, parent, ts, { type: 'user', promptId: `p-${uuid}`, origin: { kind: 'human' }, message: { role: 'user', content: text } });
const reply = (sid: string, uuid: string, parent: string, ts: string, msgId: string, text: string, out: number) =>
  rec(sid, uuid, parent, ts, { type: 'assistant', message: { id: msgId, model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: out } } });

// Original: three exchanges. The rewind goes back to after the first one.
const original = (sid: string) => [
  { type: 'custom-title', customTitle: 'Rewind demo', sessionId: sid },
  human(sid, 'u1', null, '2026-10-05T10:00:00Z', 'first'),
  reply(sid, 'a1', 'u1', '2026-10-05T10:00:10Z', 'm1', 'one', 100),
  human(sid, 'u2', 'a1', '2026-10-05T10:05:00Z', 'second'),
  reply(sid, 'a2', 'u2', '2026-10-05T10:05:10Z', 'm2', 'two', 200),
  human(sid, 'u3', 'a2', '2026-10-05T10:10:00Z', 'third'),
  reply(sid, 'a3', 'u3', '2026-10-05T10:10:10Z', 'm3', 'three', 300),
];
const forked = () => [
  { type: 'custom-title', customTitle: 'Rewind demo', sessionId: B },
  ...original(B).slice(1, 3), // copy of u1, a1 with the new session id
  human(B, 'u4', 'a1', '2026-10-05T10:20:00Z', 'second, done differently'),
  reply(B, 'a4', 'u4', '2026-10-05T10:20:10Z', 'm4', 'four', 400),
];

const write = (f: string, recs: object[]) => fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loggy-rewind-'));
  dir = path.join(root, 'claude', 'projects', '-w-app');
  fs.mkdirSync(path.join(dir, A, 'subagents'), { recursive: true });
  fileA = path.join(dir, `${A}.jsonl`);
  fileB = path.join(dir, `${B}.jsonl`);
  write(fileA, original(A));
  // The fork is created later than the original.
  const later = new Date(Date.now() + 5000);
  write(fileB, forked());
  fs.utimesSync(fileB, later, later);
  write(path.join(dir, A, 'subagents', 'agent-k1.jsonl'), [
    { ...human(A, 'k1', null, '2026-10-05T10:05:20Z', 'look'), isSidechain: true },
    { ...reply(A, 'k2', 'k1', '2026-10-05T10:05:30Z', 'mk', 'found', 5), isSidechain: true },
  ]);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('rewind', () => {
  test('a fork shares the lineage of its original and skips the copied records', () => {
    const a = summarizeFile(fileA, 'claude').summary;
    const plain = summarizeFile(fileB, 'claude').summary;
    expect(plain.lineage).toBe(a.lineage);
    const own = summarizeFile(fileB, 'claude', undefined, { skipFrom: [fileA] }).summary;
    expect(own.turns).toBe(1);
    expect(own.tokens.output).toBe(400);
    expect(own.forkTs).toBe(Date.parse('2026-10-05T10:00:10Z'));
  });

  test('the original and its fork are one session, counted once', async () => {
    const ix = new Indexer({ claudeDirs: [path.join(root, 'claude')], codexDirs: [], piDirs: [] }, new Pool(undefined), path.join(root, 'data'));
    await ix.scan();
    const all = ix.summaries();
    const main = all.filter((s) => !s.isSubagent);
    expect(main.length).toBe(1);
    const s = main[0];
    expect(s.sessionId).toBe(B); // the live, resumable one
    expect(s.turns).toBe(4); // 3 in the original (2 rewound) + 1 after the rewind
    expect(s.tokens.output).toBe(100 + 200 + 300 + 400);
    expect(s.rewinds).toBe(1);
    expect(s.rewoundInputs).toBe(2);
    expect(s.start).toBe(Date.parse('2026-10-05T10:00:00Z'));
    const kid = all.find((x) => x.isSubagent)!;
    expect(kid.parentId).toBe(s.id);
    expect(s.children).toBe(1);

    const d = detailFile(ix.pagesOf(s.id).map((e) => e.file), 'claude');
    expect(d.turns.map((t) => t.rewound ?? false)).toEqual([false, true, true, false]);
    expect(d.timeline.filter((i) => i.kind === 'user').map((i) => i.text)).toEqual(['first', 'second', 'third', 'second, done differently']);
    expect(d.timeline.some((i) => i.kind === 'system' && i.text === 'rewind')).toBe(true);
    expect(d.timeline.filter((i) => i.rewound).length).toBeGreaterThan(0);
  });
});
