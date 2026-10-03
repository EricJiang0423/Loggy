import { useEffect, useMemo, useRef, useState } from 'react';
import type { CompletionCheck, SessionDetail, SessionSummary } from '../../../src/shared/types';
import { api } from '../api';
import { compact, dateTime, duration, money, pct, relative, shortPath, time } from '../format';
import { useI18n, type Key } from '../i18n';
import { useStore } from '../store';
import { AgentBadge, Card, CopyButton, StatusBadge } from './common';
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
    const stale = [...cache.entries()].find(([k]) => k.startsWith(`${id}@`))?.[1];
    setDetail(stale);
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
          {detail && s && <Body s={s} d={detail} onAi={(ai) => setDetail({ ...detail, ai, completion: { ...detail.completion, workComplete: ai?.workComplete ?? null } })} />}
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
  const resume = s.isSubagent ? undefined : s.agent === 'claude' ? `cd ${quote(s.cwd)} && claude --resume ${s.sessionId}` : `cd ${quote(s.cwd)} && codex resume ${s.sessionId}`;
  return (
    <div className="detail-head">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <StatusBadge s={s} />
        <AgentBadge agent={s.agent} />
        <span className="chip" title={s.sessionId}>
          {s.sessionId.slice(0, 8)}
        </span>
        {s.isSubagent && s.parentId && (
          <button className="btn" onClick={() => onSelect(s.parentId!)}>
            ↑ {t('detail.parent')}
          </button>
        )}
        {s.forkedFrom && (
          <button className="btn" onClick={() => onSelect(s.forkedFrom!)}>
            {t('detail.forkedFrom')}
          </button>
        )}
        <span style={{ flex: 1 }} />
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
      </div>
    </div>
  );
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

function Body({ s, d, onAi }: { s: SessionSummary; d: SessionDetail; onAi: (ai: SessionDetail['ai']) => void }) {
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
      <Turns d={d} />
    </div>
  );
}

function relPath(p: string, cwd: string): string {
  return cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : shortPath(p);
}

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
          <ul className="bullets">
            {ai.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          {ai.decisions.length > 0 && (
            <>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                {t('ai.decisions')}
              </div>
              <ul className="bullets">
                {ai.decisions.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
            <span className="badge">
              {t('ai.type')}: {ai.type}
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
          <div className="req" key={turn.idx}>
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
              <tr key={turn.idx}>
                <td className="num">{turn.idx}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {time(turn.start, lang)}
                  <div className="muted">{duration(turn.end - turn.start, lang)}</div>
                </td>
                <td>
                  <span className="clip">{turn.prompt}</span>
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
      </div>
    </Card>
  );
}
