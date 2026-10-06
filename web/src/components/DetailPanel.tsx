import { useEffect, useMemo, useRef, useState } from 'react';
import type { CompletionCheck, SessionDetail, SessionSummary } from '../../../src/shared/types';
import { api } from '../api';
import { compact, dateTime, duration, money, pct, relative, shortPath, time } from '../format';
import { useI18n, type Key } from '../i18n';
import { refreshSessions, useStore } from '../store';
import { AgentBadge, Card, CopyButton, KNOBS, knobKey, LABELS, Star, StatusBadge, usePersisted } from './common';
import { splitReasons } from '../split';
import { Timeline } from './Timeline';

const cache = new Map<string, SessionDetail>();

function useDetail(id: string | undefined, summary: SessionSummary | undefined) {
  const [detail, setDetail] = useState<SessionDetail | undefined>(id ? cache.get(id) : undefined);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const version = summary ? `${summary.mtime}:${summary.end}:${summary.turns}` : '';
  useEffect(() => {
    if (!id) return;
    const key = `${id}@${version}`;
    const hit = cache.get(key);
    if (hit) {
      setDetail(hit);
      setError(undefined);
      return;
    }
    // Keep what is on screen while the newer version loads, so the panel doesn't flicker.
    const stale = [...cache.entries()].reverse().find(([k]) => k.startsWith(`${id}@`))?.[1];
    setDetail((cur) => (cur && cur.summary.id === id ? cur : stale));
    setError(undefined);
    setLoading(true);
    const ac = new AbortController();
    const timer = setTimeout(
      () => {
        api
          .session(id, ac.signal)
          .then((d) => {
            cache.set(key, d);
            if (cache.size > 25) cache.delete(cache.keys().next().value!);
            setDetail(d);
            setLoading(false);
          })
          .catch((e) => {
            if (ac.signal.aborted) return;
            setError(String(e.message ?? e));
            setLoading(false);
          });
      },
      stale ? 400 : 0,
    );
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [id, version]);
  return { detail: detail && detail.summary.id === id ? detail : undefined, error, loading, setDetail };
}

export function DetailPanel({
  id,
  showTimeline,
  setShowTimeline,
  onSelect,
}: {
  id?: string;
  showTimeline: boolean;
  setShowTimeline: (v: boolean) => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const summary = useStore((s) => (id ? s.list.find((x) => x.id === id) : undefined));
  const { detail, error, loading, setDetail } = useDetail(id, summary);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [id]);

  if (!id) {
    return (
      <>
        <div className="pane">
          <div className="empty-state">{t('sessions.select')}</div>
        </div>
        {showTimeline && <div className="pane tl-pane" />}
      </>
    );
  }
  const s = summary ?? detail?.summary;
  return (
    <>
      <div className="pane">
        {s ? <Header s={s} detail={detail} onSelect={onSelect} showTimeline={showTimeline} setShowTimeline={setShowTimeline} /> : null}
        <div className="pane-body" ref={bodyRef}>
          {error && !detail && <div className="empty-state err">{t('detail.loadError', { msg: error })}</div>}
          {!detail && !error && <div className="empty-state">{t('detail.loading')}</div>}
          {detail && s && (
            <Body
              s={s}
              d={detail}
              onSelect={onSelect}
              onAi={(ai) => {
                const next = (d: SessionDetail) => ({ ...d, ai, completion: { ...d.completion, workComplete: ai?.workComplete ?? null } });
                for (const [k, d] of cache) if (k.startsWith(`${detail.summary.id}@`)) cache.set(k, next(d));
                setDetail(next(detail));
              }}
            />
          )}
          {loading && detail && <div className="muted" style={{ padding: '0 14px 10px' }}>{t('common.loading')}</div>}
        </div>
      </div>
      {showTimeline && (
        <div className="pane tl-pane">
          <Timeline detail={detail} onHide={() => setShowTimeline(false)} />
        </div>
      )}
    </>
  );
}

function Header({
  s,
  detail,
  onSelect,
  showTimeline,
  setShowTimeline,
}: {
  s: SessionSummary;
  detail?: SessionDetail;
  onSelect: (id: string) => void;
  showTimeline: boolean;
  setShowTimeline: (v: boolean) => void;
}) {
  const { t, lang } = useI18n();
  const now = useStore((x) => x.now);
  const tokens = s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite;
  const tool = s.agent === 'claude' ? 'claude --resume ' + s.sessionId : s.agent === 'kimi' ? 'kimi --resume ' + s.sessionId : s.agent === 'pi' ? 'pi --continue' : 'codex resume ' + s.sessionId;
  const resume = s.isSubagent ? undefined : `cd ${quote(s.cwd)} && ${tool}`;
  const list = useStore((x) => x.list);
  const next = useMemo(() => list.filter((x) => x.continues === s.id), [list, s.id]);
  const split = splitReasons(s, detail).map(([k, n]) => t(k, { n })).join(' · ');
  return (
    <div className="detail-head">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Star s={s} />
        <StatusBadge s={s} />
        <AgentBadge agent={s.agent} />
        {s.category && <span className="badge">{s.category}</span>}
        {(s.refusals ?? 0) > 0 && <span className="badge refused">{t('detail.refusals', { n: s.refusals! })}</span>}
        <span className="chip" title={s.sessionId}>
          {s.sessionId.replace(/^session_/, '').slice(0, 8)}
        </span>
        {s.isSubagent && s.parentId && (
          <button className="btn" onClick={() => onSelect(s.parentId!)}>
            ↑ {t('detail.parent')}
          </button>
        )}
        {s.continues && (
          <button className="btn" onClick={() => onSelect(s.continues!)}>
            ← {t('detail.continues')}
          </button>
        )}
        {next.map((x) => (
          <button className="btn" key={x.id} onClick={() => onSelect(x.id)} title={x.title}>
            {t('detail.continuedBy')} →
          </button>
        ))}
        {s.forkedFrom && (
          <button className="btn" onClick={() => onSelect(s.forkedFrom!)}>
            {t('detail.forkedFrom')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <select
          className="sel"
          value={s.mark?.label ?? ''}
          onChange={(e) => void api.mark(s.id, { label: (e.target.value || null) as never }).then(() => refreshSessions())}
          aria-label={t('mark.none')}
        >
          <option value="">{t('mark.none')}</option>
          {LABELS.map((l) => (
            <option key={l} value={l}>
              {t(`mark.${l}` as Key)}
            </option>
          ))}
        </select>
        {resume && <CopyButton text={resume} label={t('detail.resume')} />}
        {!showTimeline && (
          <button className="btn" onClick={() => setShowTimeline(true)}>
            {t('detail.timeline')}
          </button>
        )}
      </div>
      <h2>{detail?.ai?.title || s.title || s.sessionId}</h2>
      <div className="kv">
        <span title={s.cwd}>{shortPath(s.projectPath || s.cwd)}</span>
        {s.branch && <span className="mono">{s.branch}</span>}
        {s.models.length > 0 && <span>{s.models.join(', ')}</span>}
      </div>
      <div className="kv num" style={{ marginTop: 4 }}>
        <span>
          {t('detail.started')} <b>{dateTime(s.start, lang)}</b>
        </span>
        <span>
          {t('detail.lastActivity')} <b>{relative(s.end, lang, now)}</b>
        </span>
        <span>
          {t('detail.duration')} <b>{duration(s.end - s.start, lang)}</b>
        </span>
        <span>{t('detail.inputs', { n: s.userInputs })}</span>
        <span title={`input ${s.tokens.input} · output ${s.tokens.output} · cache read ${s.tokens.cacheRead} · cache write ${s.tokens.cacheWrite}`}>
          <b>{compact(tokens, lang)}</b> {t('detail.tokens')}
        </span>
        <span title={t('detail.cost')}>
          <b>{money(s.costUSD, lang)}</b>
          {(s.children ?? 0) > 0 && ` (+${money((s.totalCostUSD ?? s.costUSD) - s.costUSD, lang)} ${t('detail.subagents', { n: s.children! })})`}
        </span>
        <span title={t('detail.ctx')}>
          ctx <b>{pct(s.ctxPeakPct, lang)}</b>
        </span>
        {(s.rewinds ?? 0) > 0 && <span>{t('detail.rewinds', { n: s.rewinds!, m: s.rewoundInputs ?? 0 })}</span>}
      </div>
      {split && (
        <div className="muted" style={{ marginTop: 4, color: 'var(--warn-ink)' }} title={t('split.why')}>
          {t('split.hint', { why: split })}
        </div>
      )}
      {!s.isSubagent && detail && <HandoffBar s={s} detail={detail} />}
    </div>
  );
}

/** Start the next conversation: pick the agent and where it opens, Loggy does the rest. */
function HandoffBar({ s, detail }: { s: SessionSummary; detail: SessionDetail }) {
  const { t, lang } = useI18n();
  const aiOn = useStore((x) => x.server?.aiAvailable);
  const [to, setTo] = usePersisted<'claude' | 'codex'>('loggy.handoffTo', s.agent === 'codex' ? 'codex' : 'claude');
  const [target, setTarget] = usePersisted<'cmux' | 'terminal' | 'app' | 'copy'>('loggy.handoffTarget', 'cmux');
  const [msg, setMsg] = useState<{ text: string; err?: boolean; manual?: string } | undefined>();
  useEffect(() => setMsg(undefined), [s.id]);
  // A clipboard write can hang waiting for permission: give up after a second and show the text instead.
  const copy = (x: string) =>
    Promise.race([navigator.clipboard.writeText(x).then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 1000))]);
  /** The handoff text, from an AI summary that covers the whole session when AI is set up. */
  const build = async () => {
    let ai = detail.ai;
    if (aiOn && (!ai || (ai.basis && ai.basis.end < s.end))) {
      setMsg({ text: t('handoff.summarizing') });
      ai = await api.summarize(s.id, lang).then((r) => r.ai, () => ai);
    }
    return handoff(s, { ...detail, ai }, t);
  };
  const copyOnly = async () => {
    const text = await build();
    setMsg((await copy(text)) ? { text: t('detail.copied') } : { text: t('handoff.copyFailed'), manual: text });
  };
  const go = async () => {
    // Ask once, on a click, so 'time to split' notifications can show later.
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
    try {
      const text = await build();
      // The desktop apps take no message from outside: the handoff goes to the clipboard to paste.
      const copiedText = target === 'app' ? await copy(text) : true;
      setMsg({ text: t('handoff.working') });
      const r = await api.handoff({ id: s.id, to, target, text, lang });
      const cmd = `cd ${quote(r.cwd)} && ${r.command}`;
      const ok = target === 'copy' || r.note === 'cmuxBlocked' ? await copy(cmd) : copiedText;
      const done = t(r.note === 'cmuxBlocked' ? 'handoff.cmuxBlocked' : (`handoff.done.${target}` as Key));
      setMsg(ok ? { text: done } : { text: t('handoff.copyFailed'), manual: target === 'app' ? text : cmd });
    } catch (e) {
      // fetch() throws a TypeError when the Loggy server is not running.
      setMsg({ text: e instanceof TypeError ? t('handoff.offline') : (e as Error).message, err: true });
    }
  };
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
      <select className="sel" value={to} onChange={(e) => setTo(e.target.value as typeof to)} aria-label={t('handoff.to')}>
        <option value="claude">Claude Code</option>
        <option value="codex">Codex</option>
      </select>
      <select className="sel" value={target} onChange={(e) => setTarget(e.target.value as typeof target)} aria-label={t('handoff.target')}>
        {(['cmux', 'terminal', 'app', 'copy'] as const).map((x) => (
          <option key={x} value={x}>
            {t(`handoff.target.${x}` as Key)}
          </option>
        ))}
      </select>
      <button className="btn primary" onClick={go}>
        {t('handoff.go')}
      </button>
      <button className="btn" onClick={copyOnly}>
        {t('detail.handoff')}
      </button>
      {msg && <span className={msg.err ? 'err' : 'muted'} style={{ fontSize: 12 }}>{msg.text}</span>}
      {msg?.manual && <textarea className="input note" readOnly rows={3} value={msg.manual} onFocus={(e) => e.currentTarget.select()} style={{ width: '100%' }} />}
    </div>
  );
}

/** One line of a prompt without pasted-content wrappers, shortened. */
function clean(text: string, max: number): string {
  const one = text.replace(/<\\?\/?pasted_content[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** A prompt to start the next conversation (in either agent) where this one left off. */
function handoff(s: SessionSummary, d: SessionDetail, t: ReturnType<typeof useI18n>['t']): string {
  const ai = d.ai;
  const sec = (label: Key, items?: string[]) => (items?.length ? [`${t(label)}:`, ...items.map((x) => `- ${x}`), ''] : []);
  const asks = d.turns.filter((x) => !x.rewound && x.prompt.trim()).map((x) => clean(x.prompt, 200));
  const last = [...d.turns].reverse().find((x) => x.response)?.response;
  const files = [...d.files].sort((a, b) => b.added + b.removed - (a.added + a.removed));
  return [
    t('handoff.head', { id: `${s.agent}:${s.sessionId}`, title: ai?.title || s.title }),
    `${t('handoff.where')}: ${s.cwd}${s.branch ? ` (${s.branch})` : ''}`,
    `${t('handoff.log')}: ${s.file}`,
    '',
    ...(ai
      ? [
          ...sec('handoff.done', ai.bullets),
          ...sec('handoff.decisions', ai.decisions),
          ...sec('handoff.unverified', [...(ai.unverified ?? []), ...(ai.openQuestions ?? [])]),
          ...sec('handoff.next', ai.nextSteps),
          ...sec('handoff.recent', asks.slice(-3)),
        ]
      : [`${t('handoff.goal')}: ${clean(s.firstPrompt, 200)}`, '', ...sec('handoff.recent', asks.slice(1).slice(-5)), ...sec('handoff.last', last ? [clean(last, 600)] : [])]),
    ...sec('handoff.commits', d.commits.map((c) => `${c.sha.slice(0, 7)} ${c.message ?? ''}`.trim())),
    ...sec('handoff.files', [
      ...files.slice(0, 15).map((f) => `${relPath(f.path, s.cwd)} (+${f.added} −${f.removed})`),
      ...(files.length > 15 ? [t('handoff.moreFiles', { n: files.length - 15 })] : []),
    ]),
    s.uncommittedEdits ? t('handoff.uncommitted') : '',
    t('handoff.ask'),
  ]
    .filter((x, i, a) => x || a[i - 1])
    .join('\n');
}

function quote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

function Check({ ok, label, na, unknown }: { ok: boolean | null; label: string; na?: string; unknown?: string }) {
  const cls = ok === null ? 'na' : ok ? 'ok' : 'bad';
  return (
    <span className={`check ${cls}`}>
      {ok === null ? '–' : ok ? '✓' : '✗'} {label}
      {ok === null && (na || unknown) ? <span className="muted"> ({unknown ?? na})</span> : null}
    </span>
  );
}

function Completion({ c, hasEdits, live }: { c: CompletionCheck; hasEdits: boolean; live: boolean }) {
  const { t } = useI18n();
  return (
    <Card title={t('check.title')}>
      <div className="checks">
        <Check ok={live ? null : c.turnEnded} label={t('check.turnEnded')} unknown={live ? t('req.running') : undefined} />
        <Check ok={c.notAwaitingReply} label={t('check.notAwaiting')} />
        <Check ok={c.noBackground} label={t('check.noBackground')} />
        <Check ok={c.committed} label={t('check.committed')} na={hasEdits ? undefined : t('check.na')} />
        <Check ok={c.workComplete} label={t('check.workComplete')} unknown={t('check.unknown')} />
      </div>
    </Card>
  );
}

function Body({ s, d, onAi, onSelect }: { s: SessionSummary; d: SessionDetail; onAi: (ai: SessionDetail['ai']) => void; onSelect: (id: string) => void }) {
  const { t, lang } = useI18n();
  const [showAllFiles, setShowAllFiles] = useState(false);
  const files = showAllFiles ? d.files : d.files.slice(0, 12);
  return (
    <div className="cards">
      <Completion c={d.completion} hasEdits={d.files.length > 0} live={s.status === 'running' || s.status === 'stalled'} />
      <AiCard s={s} d={d} onAi={onAi} />
      <Card
        title={t('out.title')}
        extra={
          <span className="muted num">
            {t('out.commits', { n: d.commits.length })} · {t('out.pushes', { n: s.pushes })} · {t('out.files', { n: d.files.length })}
          </span>
        }
      >
        {d.commits.length > 0 && (
          <ul className="plain" style={{ marginBottom: 6 }}>
            {d.commits.map((c, i) => (
              <li key={`${c.sha}-${i}`}>
                <span className="chip">{c.sha.slice(0, 7) || '?'}</span>
                <span className="clip">{c.message ?? ''}</span>
                <span className="muted num" style={{ marginLeft: 'auto' }}>
                  {time(c.ts, lang)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {d.files.length === 0 ? (
          <div className="muted">{t('out.noFiles')}</div>
        ) : (
          <ul className="plain">
            {files.map((f) => (
              <li key={f.path}>
                <span className="file" title={f.path}>
                  {relPath(f.path, s.cwd)}
                </span>
                <span className="num add">+{f.added}</span>
                <span className="num del">−{f.removed}</span>
              </li>
            ))}
            {d.files.length > 12 && (
              <li>
                <button className="btn" onClick={() => setShowAllFiles(!showAllFiles)}>
                  {showAllFiles ? '−' : `+${d.files.length - 12}`}
                </button>
              </li>
            )}
          </ul>
        )}
        {d.questions.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
              {t('out.questions')}
            </div>
            {d.questions.flatMap((q, i) =>
              q.questions.map((qq, j) => (
                <div key={`${i}-${j}`} style={{ marginBottom: 4 }}>
                  <div>❓ {qq.question}</div>
                  <div className="muted">
                    → {qq.answer ?? t('out.noAnswer')}
                  </div>
                </div>
              )),
            )}
          </div>
        )}
      </Card>
      <Requests d={d} />
      <Efficiency s={s} />
      <Harness s={s} d={d} />
      <Notes s={s} />
      <Related id={s.id} onSelect={onSelect} />
      <Turns d={d} />
    </div>
  );
}

function relPath(p: string, cwd: string): string {
  return cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : shortPath(p);
}

/** Every summary is shown in the same order; empty sections are left out. */
const AI_SECTIONS = [
  ['bullets', 'ai.bullets'],
  ['decisions', 'ai.decisions'],
  ['unverified', 'ai.unverified'],
  ['concerns', 'ai.concerns'],
  ['openQuestions', 'ai.openQuestions'],
  ['nextSteps', 'ai.nextSteps'],
] as const satisfies readonly (readonly [keyof NonNullable<SessionDetail['ai']>, Key])[];
const TYPES = ['implementation', 'bugfix', 'refactor', 'research', 'review', 'docs', 'ops', 'other'];

function AiCard({ s, d, onAi }: { s: SessionSummary; d: SessionDetail; onAi: (ai: SessionDetail['ai']) => void }) {
  const { t, lang } = useI18n();
  const available = useStore((x) => x.server?.aiAvailable);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const run = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.summarize(s.id, lang);
      onAi(r.ai);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ai = d.ai;
  const button = available ? (
    <button className={`btn ${ai ? '' : 'primary'}`} onClick={run} disabled={busy}>
      {busy ? t('ai.working') : ai ? t('ai.regenerate') : t('ai.generate')}
    </button>
  ) : null;
  return (
    <Card title={t('ai.title')} extra={button}>
      {ai ? (
        <>
          <div className="ai-title">{ai.title}</div>
          {AI_SECTIONS.map(([key, label]) =>
            (ai[key] ?? []).length > 0 ? (
              <div className={`ai-sec ${key}`} key={key}>
                <div className="ai-h">{t(label)}</div>
                <ul className="bullets">
                  {(ai[key] ?? []).map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
          {ai.format !== 2 && <div className="muted" style={{ fontSize: 11 }}>{t('ai.oldFormat')}</div>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
            <span className="badge">
              {t('ai.type')}: {TYPES.includes(ai.type) ? t(`ai.type.${ai.type}` as Key) : ai.type}
            </span>
            {s.component && <span className="badge">{s.component}</span>}
            <span className="muted" style={{ fontSize: 11 }}>
              {t('ai.by', { model: ai.model })} · {relative(ai.createdAt, lang)}
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="muted" style={{ fontSize: 11 }}>
            {t('ai.firstPrompt')}
          </div>
          <div className="clip" style={{ marginBottom: 6 }}>
            {s.firstPrompt || '–'}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {s.component && <span className="badge">{s.component}</span>}
            {s.hasPlan && <span className="badge">plan</span>}
            {s.compactions > 0 && <span className="badge">compact ×{s.compactions}</span>}
          </div>
          {!available && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {t('ai.disabled')}
            </div>
          )}
        </>
      )}
      {err && <div className="err">{t('ai.error', { msg: err })}</div>}
    </Card>
  );
}

function Requests({ d }: { d: SessionDetail }) {
  const { t, lang } = useI18n();
  const kinds = d.ai?.requests ?? [];
  return (
    <Card title={t('req.title')} extra={<span className="muted">{t('detail.turns', { n: d.turns.length })}</span>}>
      {d.turns.map((turn, i) => {
        const k = kinds[i];
        const icon = turn.interrupted ? '✗' : !turn.ended ? '…' : k ? (k.done ? '✓' : '○') : '✓';
        const color = turn.interrupted ? 'var(--serious-ink)' : !turn.ended ? 'var(--accent-ink)' : k && !k.done ? 'var(--warn-ink)' : 'var(--good-ink)';
        return (
          <div className={`req ${turn.rewound ? 'rewound' : ''}`} key={turn.idx}>
            <span className="ic" style={{ color }}>
              {icon}
            </span>
            <div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                {k && <span className="badge">{t(`req.kind.${k.kind}` as Key)}</span>}
                <span className="clip" style={{ flex: 1, minWidth: 0 }}>
                  {turn.prompt || '–'}
                </span>
              </div>
              <div className="muted num" style={{ fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span>{time(turn.start, lang)}</span>
                {turn.rewound && <span>{t('turns.rewound')}</span>}
                {turn.interrupted && <span>{t('req.interrupted')}</span>}
                {!turn.ended && !turn.interrupted && <span>{t('req.running')}</span>}
                {turn.commits.map((c) => (
                  <span className="chip" key={c}>
                    {c.slice(0, 7)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

/** Harness settings the session ran with, and when they were switched. */
function Harness({ s, d }: { s: SessionSummary; d: SessionDetail }) {
  const { t, lang } = useI18n();
  // A mode that stayed off the whole session says nothing.
  const knobs = KNOBS.filter((k) => Object.keys(s.knobs?.[k] ?? {}).some((v) => v !== 'off'));
  if (!knobs.length) return null;
  const changes: { turn: number; ts: number; knob: string; from: string; to: string }[] = [];
  let prev: Record<string, string> = {};
  for (const turn of d.turns) {
    for (const [k, v] of Object.entries(turn.knobs ?? {})) if (prev[k] !== undefined && prev[k] !== v) changes.push({ turn: turn.idx, ts: turn.start, knob: k, from: prev[k], to: v });
    prev = { ...prev, ...turn.knobs };
  }
  return (
    <Card title={t('knobs.title')}>
      <table className="grid">
        <tbody>
          {knobs.map((k) => (
            <tr key={k}>
              <td className="nw muted">{t(knobKey(k))}</td>
              <td>
                {Object.entries(s.knobs![k])
                  .sort((a, b) => b[1] - a[1])
                  .map(([v, n]) => (
                    <span key={v} className="knob-val">
                      <span className="mono">{v}</span> <span className="muted">{t('knobs.turns', { n })}</span>
                    </span>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {changes.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>
            {t('knobs.changes')}
          </div>
          {changes.slice(-20).map((c, i) => (
            <div key={i} className="num" style={{ fontSize: 12 }}>
              <span className="muted">
                {t('git.turn', { n: c.turn })} · {time(c.ts, lang)}
              </span>{' '}
              {t(knobKey(c.knob))}: <span className="mono">{c.from}</span> → <span className="mono">{c.to}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Turns({ d }: { d: SessionDetail }) {
  const { t, lang } = useI18n();
  return (
    <Card title={t('turns.title')}>
      <div style={{ overflowX: 'auto' }}>
        <table className="grid">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('turns.time')}</th>
              <th>{t('turns.prompt')}</th>
              <th className="r">{t('turns.tokens')}</th>
              <th className="r">{t('turns.cost')}</th>
              <th className="r">{t('turns.ctx')}</th>
              <th className="r">{t('turns.tools')}</th>
              <th className="r">{t('turns.files')}</th>
            </tr>
          </thead>
          <tbody>
            {d.turns.map((turn) => (
              <tr key={turn.idx} className={turn.rewound ? 'rewound' : ''}>
                <td className="num">{turn.idx}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {time(turn.start, lang)}
                  <div className="muted">{duration(turn.end - turn.start, lang)}</div>
                </td>
                <td>
                  <span className="clip">{turn.prompt}</span>
                  {turn.rewound && <span className="muted"> · {t('turns.rewound')}</span>}
                </td>
                <td className="r">{compact(turn.tokens, lang)}</td>
                <td className="r">{money(turn.costUSD, lang)}</td>
                <td className="r">{pct(turn.ctxPct, lang)}</td>
                <td className="r">
                  {turn.toolCalls}
                  {turn.toolErrors > 0 && <span className="del"> ({turn.toolErrors})</span>}
                </td>
                <td className="r">{turn.files.length || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Efficiency({ s }: { s: SessionSummary }) {
  const { t, lang } = useI18n();
  const list = useStore((x) => x.list);
  const avg = useMemo(() => {
    const peers = list.filter((x) => x.projectPath === s.projectPath && !x.isSubagent && x.commits > 0);
    const cost = peers.reduce((n, x) => n + (x.totalCostUSD ?? x.costUSD), 0);
    const commits = peers.reduce((n, x) => n + x.commits, 0);
    return commits ? cost / commits : undefined;
  }, [list, s.projectPath]);
  const cacheBase = s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite;
  const cacheHit = cacheBase ? (s.tokens.cacheRead / cacheBase) * 100 : 0;
  const perCommit = s.commits ? (s.totalCostUSD ?? s.costUSD) / s.commits : undefined;
  const sp = Object.values(s.speed ?? {}).reduce((a, [tok, ms]) => [a[0] + tok, a[1] + ms], [0, 0]);
  const speed = sp[1] > 0 ? (sp[0] / sp[1]) * 1000 : undefined;
  return (
    <Card title={t('eff.block')}>
      <div className="stats">
        <div className="stat">
          <div className="l">{t('eff.active')}</div>
          <div className="v num">{duration(s.activeMs, lang)}</div>
        </div>
        <div className="stat">
          <div className="l">{t('eff.wait')}</div>
          <div className="v num">{duration(s.waitMs, lang)}</div>
        </div>
        <div className="stat">
          <div className="l">{t('eff.toolsPerTurn')}</div>
          <div className="v num">{s.turns ? (s.toolCalls / s.turns).toFixed(1) : '–'}</div>
          <div className="s">max {s.maxToolCallsPerTurn}</div>
        </div>
        <div className="stat">
          <div className="l">{t('eff.errors')}</div>
          <div className="v num">{s.toolCalls ? pct((s.toolErrors / s.toolCalls) * 100, lang) : '–'}</div>
        </div>
        <div className="stat">
          <div className="l">{t('eff.cacheHit')}</div>
          <div className="v num">{cacheBase ? pct(cacheHit, lang) : '–'}</div>
        </div>
        <div className="stat">
          <div className="l">{t('eff.costPerCommit')}</div>
          <div className="v num">{perCommit === undefined ? '–' : money(perCommit, lang)}</div>
          {avg !== undefined && <div className="s">{t('eff.vsProject', { v: money(avg, lang) })}</div>}
        </div>
        {speed !== undefined && (
          <div className="stat">
            <div className="l">{t('eff.speed')}</div>
            <div className="v num">{t('eff.speedValue', { n: speed.toFixed(0) })}</div>
          </div>
        )}
      </div>
      {s.ctxParts && (
        <div className="muted num" style={{ fontSize: 12, marginTop: 10 }}>
          {t('eff.ctxParts')}: {t('eff.ctxPartsValue', { read: compact(s.ctxParts[1], lang), write: compact(s.ctxParts[2], lang), fresh: compact(s.ctxParts[0], lang) })}
        </div>
      )}
    </Card>
  );
}

/** Your note for the session, saved as you type. */
function Notes({ s }: { s: SessionSummary }) {
  const { t } = useI18n();
  const [text, setText] = useState(s.mark?.note ?? '');
  const [saved, setSaved] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    setText(s.mark?.note ?? '');
    first.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (text === (s.mark?.note ?? '')) return;
    const id = window.setTimeout(() => {
      void api.mark(s.id, { note: text }).then(() => {
        setSaved(true);
        void refreshSessions();
      });
    }, 600);
    setSaved(false);
    return () => window.clearTimeout(id);
  }, [text, s.id]);
  return (
    <Card title={t('mark.note')} extra={saved ? <span className="muted">{t('mark.saved')}</span> : undefined}>
      <textarea className="input note" rows={3} value={text} placeholder={t('mark.notePlaceholder')} onChange={(e) => setText(e.target.value)} />
    </Card>
  );
}

/** Other sessions that edited the same files. */
function Related({ id, onSelect }: { id: string; onSelect: (id: string) => void }) {
  const { t, lang } = useI18n();
  const list = useStore((x) => x.sessions);
  const [related, setRelated] = useState<{ id: string; shared: number }[]>([]);
  useEffect(() => {
    let on = true;
    api
      .related(id)
      .then((r) => on && setRelated(r.related))
      .catch(() => on && setRelated([]));
    return () => {
      on = false;
    };
  }, [id]);
  const rows = related.map((r) => ({ ...r, s: list.get(r.id) })).filter((r) => r.s);
  if (!rows.length) return null;
  return (
    <Card title={t('rel.title')}>
      <ul className="plain">
        {rows.map(({ id: rid, shared, s: o }) => (
          <li key={rid} className="link-row" onClick={() => onSelect(rid)}>
            <StatusBadge s={o!} />
            <span className="clip" style={{ flex: 1, minWidth: 0 }}>
              {o!.ai?.title ?? o!.title}
            </span>
            <span className="muted num">{t('rel.shared', { n: shared })}</span>
            <span className="muted num">{dateTime(o!.start, lang)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
