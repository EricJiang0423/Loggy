import { useEffect, useMemo, useState } from 'react';
import { api, type GitCommitRow, type GitShow } from '../api';
import { BarChart, Legend, type Series } from '../components/Charts';
import { DiffView, Seg, useDebounced, usePersisted } from '../components/common';
import { series as seriesColor } from '../colors';
import { compact, dateTime, int } from '../format';
import { useI18n } from '../i18n';

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

  useEffect(() => {
    api.gitProjects().then((r) => setProjects(r.projects), () => setProjects([]));
  }, []);
  const current = projects?.some((p) => p.path === project) ? project : projects?.[0]?.path ?? '';

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
    if (!current || !sel) return setShow(null);
    let on = true; // a slower earlier response must not replace the newer one
    api.gitShow(current, sel).then(
      (r) => on && setShow(r),
      (e) => on && setErr(String(e.message ?? e)),
    );
    return () => {
      on = false;
    };
  }, [current, sel]);

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
              {(commits ?? []).map((c) => (
                <div key={c.sha} className={`ver ${c.sha === sel ? 'sel' : ''}`} onClick={() => setSel(c.sha)}>
                  <div className="subj">{c.subject}</div>
                  <div className="muted num" style={{ fontSize: 11, display: 'flex', gap: 8 }}>
                    <span className="chip">{c.sha.slice(0, 7)}</span>
                    <span>{dateTime(Date.parse(c.date), lang)}</span>
                    <span className="add">+{compact(c.added, lang)}</span>
                    <span className="del">−{compact(c.removed, lang)}</span>
                    {c.session && <span className="ink2">● {t('git.bySession')}</span>}
                  </div>
                </div>
              ))}
              {commits && !commits.length && <div className="empty-state">{t('git.none')}</div>}
            </div>
          </div>
          <div className="pane">
            <div className="pane-body">
              {show && (
                <div className="cards">
                  <section className="card">
                    <pre className="git-msg">{show.message.trim()}</pre>
                    {commits?.find((c) => c.sha === sel)?.session && (
                      <button className="btn" onClick={() => onOpen(commits!.find((c) => c.sha === sel)!.session!)}>
                        {t('git.openSession')}
                      </button>
                    )}
                  </section>
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
