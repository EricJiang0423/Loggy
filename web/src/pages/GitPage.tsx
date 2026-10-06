import { useEffect, useMemo, useState } from 'react';
import type { CommitInfo, SessionDetail } from '../../../src/shared/types';
import { api, type GitCommitRow, type GitShow } from '../api';
import { BarChart, Legend, type Series } from '../components/Charts';
import { DiffView, Seg, useDebounced, usePersisted } from '../components/common';
import { series as seriesColor } from '../colors';
import { compact, dateTime, displayTitle, int } from '../format';
import { graphLayout, type GraphRow } from '../gitGraph';
import { useI18n } from '../i18n';
import { useStore } from '../store';

const LANE = 12;
const ROW_H = 46;
const MAX_LANES = 8;

/** The lines and the dot of one commit row. */
function GraphCell({ row, width, color }: { row: GraphRow; width: number; color?: string }) {
  const x = (l: number) => l * LANE + LANE / 2 + 2;
  const w = Math.min(width, MAX_LANES) * LANE + 4;
  return (
    <svg width={w} height={ROW_H} className="git-graph" aria-hidden>
      {row.segs.map(([a, y1, b, y2], i) => (
        <path key={i} d={a === b ? `M${x(a)} ${y1 * ROW_H}V${y2 * ROW_H}` : `M${x(a)} ${y1 * ROW_H}C${x(a)} ${((y1 + y2) / 2) * ROW_H} ${x(b)} ${((y1 + y2) / 2) * ROW_H} ${x(b)} ${y2 * ROW_H}`} />
      ))}
      <circle cx={x(row.lane)} cy={ROW_H / 2} r={color ? 4.5 : 3.5} style={color ? { fill: color, stroke: color } : undefined} />
    </svg>
  );
}

type Tab = 'commits' | 'lines';

/** Commits of a project with their diff and the session that made them; code size over time. */
export function GitPage({ onOpen }: { onOpen: (sessionId: string) => void }) {
  const { t, lang } = useI18n();
  const [projects, setProjects] = useState<{ path: string; name: string }[] | null>(null);
  const [project, setProject] = usePersisted<string>('loggy.gitProject', '');
  const [tab, setTab] = usePersisted<Tab>('loggy.gitTab', 'commits');
  const [q, setQ] = useState('');
  const [pathFilter, setPathFilter] = useState('');
  const dq = useDebounced(q, 250);
  const dpath = useDebounced(pathFilter, 250);
  const [commits, setCommits] = useState<GitCommitRow[] | null>(null);
  const [sel, setSel] = useState<string | undefined>();
  const [show, setShow] = useState<GitShow | null>(null);
  const [lines, setLines] = useState<{ days: string[]; series: Record<string, number[]> } | null>(null);
  const [err, setErr] = useState<string | undefined>();
  const list = useStore((st) => st.list);
  const byId = useMemo(() => new Map(list.map((x) => [x.id, x])), [list]);
  const graph = useMemo(() => (commits ? graphLayout(commits) : null), [commits]);
  // each session that made commits gets its own color
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of commits ?? []) if (c.session && !m.has(c.session)) m.set(c.session, seriesColor(m.size % 8));
    return m;
  }, [commits]);
  const selCommit = commits?.find((c) => c.sha === sel);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);

  useEffect(() => {
    api.gitProjects().then((r) => setProjects(r.projects), () => setProjects([]));
  }, []);
  const current = projects?.some((p) => p.path === project) ? project : projects?.[0]?.path ?? '';

  // a commit id belongs to one repository
  useEffect(() => {
    setCommits(null);
    setSel(undefined);
    setShow(null);
  }, [current]);

  useEffect(() => {
    if (!current || tab !== 'commits') return;
    setErr(undefined);
    api.gitLog(current, dq, dpath).then(
      (r) => {
        setCommits(r.commits);
        setSel((s) => (s && r.commits.some((c) => c.sha === s) ? s : r.commits[0]?.sha));
      },
      (e) => setErr(String(e.message ?? e)),
    );
  }, [current, tab, dq, dpath]);

  useEffect(() => {
    if (!current || !sel || !commits?.some((c) => c.sha === sel)) return setShow(null);
    let on = true; // a slower earlier response must not replace the newer one
    api.gitShow(current, sel).then(
      (r) => on && setShow(r),
      (e) => on && setErr(String(e.message ?? e)),
    );
    return () => {
      on = false;
    };
  }, [current, sel, commits]);

  const selSession = selCommit?.session;
  useEffect(() => {
    if (!selSession) return setSessionDetail(null);
    let on = true;
    api.session(selSession).then(
      (d) => on && setSessionDetail(d),
      () => on && setSessionDetail(null),
    );
    return () => {
      on = false;
    };
  }, [selSession]);

  // The selected commit's session, turn by turn, with the commits each turn made.
  const turns = useMemo(() => {
    if (!sessionDetail || sessionDetail.summary.id !== selSession) return [];
    const m = new Map<number, CommitInfo[]>();
    const add = (c: CommitInfo) => m.set(c.turn, [...(m.get(c.turn) ?? []), c]);
    for (const c of sessionDetail.commits) if (c.sha) add(c);
    // Commits matched by time (a quiet `git commit` prints no id) go to the turn running then.
    const known = new Set(sessionDetail.commits.map((c) => c.sha.slice(0, 7)));
    for (const c of commits ?? []) {
      if (c.session !== selSession || known.has(c.sha.slice(0, 7))) continue;
      const ts = Date.parse(c.date);
      const turn = sessionDetail.turns.filter((t) => t.start <= ts).pop()?.idx;
      if (turn) add({ sha: c.sha, ts, message: c.subject, turn });
    }
    for (const list of m.values()) list.sort((a, b) => a.ts - b.ts);
    return [...m].sort((a, b) => a[0] - b[0]).map(([turn, cs]) => ({ turn, prompt: sessionDetail.turns[turn - 1]?.prompt ?? '', commits: cs }));
  }, [sessionDetail, selSession, commits]);
  const turnOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of turns) for (const c of x.commits) m.set(c.sha.slice(0, 7), x.turn);
    return m;
  }, [turns]);
  const listed = (sha: string) => commits?.find((c) => c.sha.startsWith(sha.slice(0, 7)));

  useEffect(() => {
    if (!current || tab !== 'lines') return;
    setLines(null);
    api.gitLines(current).then(setLines, (e) => setErr(String(e.message ?? e)));
  }, [current, tab]);

  const chart = useMemo(() => {
    if (!lines) return null;
    const last = lines.days.length - 1;
    const dirs = Object.entries(lines.series).sort((a, b) => b[1][last] - a[1][last]);
    const top = dirs.slice(0, 7);
    const rest = dirs.slice(7);
    const s: Series[] = top.map(([k, v], i) => ({ key: k, label: k, color: seriesColor(i), values: v }));
    if (rest.length) s.push({ key: 'other', label: t('cal.other'), color: seriesColor(-1), values: lines.days.map((_, i) => rest.reduce((n, [, v]) => n + v[i], 0)) });
    return s;
  }, [lines, t]);

  if (projects && !projects.length) return <div className="empty-state">{t('git.noProjects')}</div>;
  return (
    <div className="page">
      <div className="toolbar">
        <select className="sel" value={current} onChange={(e) => setProject(e.target.value)} aria-label={t('git.project')}>
          {(projects ?? []).map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="sep" />
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: 'commits', label: t('git.commits') },
            { value: 'lines', label: t('git.lines') },
          ]}
        />
        {tab === 'commits' && (
          <>
            <span className="spacer" />
            <input className="input" style={{ width: 200 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('git.search')} />
            <input className="input mono" style={{ width: 200 }} value={pathFilter} onChange={(e) => setPathFilter(e.target.value)} placeholder={t('git.path')} />
          </>
        )}
      </div>
      {err && <div className="err" style={{ padding: '6px 14px' }}>{err}</div>}
      {tab === 'commits' ? (
        <div className="gitview">
          <div className="pane">
            <div className="pane-body">
              {(commits ?? []).map((c, i) => {
                const owner = c.session ? byId.get(c.session) : undefined;
                const turn = c.session === selSession ? turnOf.get(c.sha.slice(0, 7)) : undefined;
                return (
                  <div key={c.sha} className={`ver gitrow ${c.sha === sel ? 'sel' : ''} ${c.session && c.session === selSession ? 'same' : ''}`} onClick={() => setSel(c.sha)}>
                    {graph && <GraphCell row={graph.rows[i]} width={graph.width} color={c.session ? colorOf.get(c.session) : undefined} />}
                    <div className="gitrow-body">
                      <div className="subj">
                        {c.refs.map((r) => (
                          <span key={r} className="git-ref">
                            {r}
                          </span>
                        ))}
                        {c.subject}
                      </div>
                      <div className="muted num gitrow-meta">
                        <span className="chip">{c.sha.slice(0, 7)}</span>
                        <span>{dateTime(Date.parse(c.date), lang)}</span>
                        <span className="add">+{compact(c.added, lang)}</span>
                        <span className="del">−{compact(c.removed, lang)}</span>
                        {c.session && (
                          <span className="git-sess" style={{ color: colorOf.get(c.session) }} title={owner ? displayTitle(owner) : undefined}>
                            ● {turn ? `${t('git.turn', { n: turn })} · ` : ''}
                            {owner ? displayTitle(owner) : t('git.session')}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {!commits && !err && <div className="empty-state">{t('git.loading')}</div>}
              {commits && !commits.length && <div className="empty-state">{t('git.none')}</div>}
            </div>
          </div>
          <div className="pane">
            <div className="pane-body">
              {show && (
                <div className="cards">
                  <section className="card">
                    <pre className="git-msg">{show.message.trim()}</pre>
                    {selSession && (
                      <button className="btn" onClick={() => onOpen(selSession)}>
                        {t('git.openSession')}
                      </button>
                    )}
                  </section>
                  {turns.length > 0 && (
                    <section className="card">
                      <h3>
                        <span className="h">{t('git.byTurn')}</span>
                        <span className="muted git-sess">{byId.get(selSession!) ? displayTitle(byId.get(selSession!)!) : ''}</span>
                      </h3>
                      {turns.map((x) => (
                        <div key={x.turn} className="gt-turn">
                          <div className="gt-prompt">
                            <span className="muted num">{t('git.turn', { n: x.turn })}</span> {x.prompt.slice(0, 160)}
                          </div>
                          {x.commits.map((c) => {
                            const row = listed(c.sha);
                            return (
                              <div
                                key={c.sha}
                                className={`gt-commit ${row ? '' : 'off'} ${row?.sha === sel ? 'sel' : ''}`}
                                onClick={() => row && setSel(row.sha)}
                                title={row ? undefined : t('git.notListed')}
                              >
                                <span className="chip">{c.sha.slice(0, 7)}</span>
                                <span className="subj">{row?.subject ?? c.message?.split('\n')[0] ?? ''}</span>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </section>
                  )}
                  <section className="card">
                    <h3>
                      <span className="h">{t('git.files', { n: show.files.length })}</span>
                    </h3>
                    <ul className="plain">
                      {show.files.map((f) => (
                        <li key={f.path}>
                          <span className="file" title={f.path} onClick={() => setPathFilter(f.path)} style={{ cursor: 'pointer' }}>
                            {f.path}
                          </span>
                          <span className="num add">+{f.added}</span>
                          <span className="num del">−{f.removed}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section className="card">
                    <DiffView text={show.diff} />
                    {show.cut && <div className="muted">{t('git.cut')}</div>}
                  </section>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="eff">
          {!lines ? (
            <div className="muted">{t('common.loading')}</div>
          ) : (
            <div className="chart-card">
              <h3>
                <span className="h">{t('git.lines')}</span>
                <span className="muted num">{int(Object.values(lines.series).reduce((n, v) => n + v[v.length - 1], 0), lang)}</span>
              </h3>
              {chart && <Legend series={chart} />}
              {chart && <BarChart labels={lines.days.map((d) => d.slice(5))} series={chart} format={(v) => int(v, lang)} height={260} />}
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                {t('git.linesNote')}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
