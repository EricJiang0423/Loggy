import { useMemo, useState, type ReactNode } from 'react';
import type { SessionSummary } from '../../../src/shared/types';
import { agentColor, series as seriesColor } from '../colors';
import { BarChart, DataTable, Heatmap, Legend, type Series } from '../components/Charts';
import { agentKey, HarnessFilter, KNOBS, knobKey, Seg, StatusBadge, usePersisted, useThemeVersion } from '../components/common';
import { addDays, comparablePeriod, compact, earliestStart, duration, hours, int, money, pct, shortDay, startOfDay, weekday } from '../format';
import { useI18n, type Key } from '../i18n';
import { useStore } from '../store';

type Range = '7' | '30' | '90' | 'all';
const BUCKET = 600_000;
const DAY = 86400_000;
const AGENT_ORDER = ['claude', 'codex', 'kimi'];

interface Agg {
  cost: number;
  active: number;
  wait: number;
  sessions: number;
  commits: number;
  lines: number;
  cacheRead: number;
  cacheBase: number;
  peak: number;
  turns: number;
  interrupts: number;
  tools: number;
  toolErrors: number;
}

function aggregate(sessions: SessionSummary[], from: number, to: number): Agg {
  const a: Agg = { cost: 0, active: 0, wait: 0, sessions: 0, commits: 0, lines: 0, cacheRead: 0, cacheBase: 0, peak: 0, turns: 0, interrupts: 0, tools: 0, toolErrors: 0 };
  const perBucket = new Map<number, number>();
  for (const s of sessions) {
    if (s.start < from || s.start >= to) continue;
    a.cost += s.costUSD;
    a.cacheRead += s.tokens.cacheRead;
    a.cacheBase += s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite;
    a.tools += s.toolCalls;
    a.toolErrors += s.toolErrors;
    if (s.isSubagent) continue;
    a.active += s.activeMs;
    a.wait += s.waitMs;
    a.sessions++;
    a.commits += s.commits;
    a.lines += s.linesAdded + s.linesRemoved;
    a.turns += s.turns;
    a.interrupts += s.interrupts;
    for (const [b] of s.buckets) perBucket.set(b, (perBucket.get(b) ?? 0) + 1);
  }
  for (const v of perBucket.values()) a.peak = Math.max(a.peak, v);
  return a;
}

export function EfficiencyPage({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, lang } = useI18n();
  useThemeVersion();
  const list = useStore((s) => s.list);
  const now = useStore((s) => s.now);
  const [range, setRange] = useState<Range>('30');
  const [harnessList, setHarnessList] = usePersisted<string>('loggy.harnesses', '');
  const harnesses = useMemo(() => harnessList.split(',').filter(Boolean), [harnessList]);
  const present = useMemo(() => [...new Set(list.map((s) => s.agent as string))].sort((a, b) => AGENT_ORDER.indexOf(a) - AGENT_ORDER.indexOf(b)), [list]);
  const shown = present.filter((a) => !harnesses.length || harnesses.includes(a));
  const [project, setProject] = useState('');
  const [tables, setTables] = useState<Record<string, boolean>>({});

  const projects = useMemo(() => [...new Map(list.map((s) => [s.projectPath, s.project])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [list]);
  const scoped = useMemo(() => list.filter((s) => (!harnesses.length || harnesses.includes(s.agent)) && (!project || s.projectPath === project)), [list, harnesses, project]);

  const earliest = useMemo(() => earliestStart(scoped, now), [scoped, now]);
  const days = range === 'all' ? Math.max(7, Math.ceil((now - startOfDay(earliest)) / DAY) + 1) : Number(range);
  const to = startOfDay(now) + DAY;
  const from = addDays(to, -days);
  const prevFrom = addDays(from, -days);

  const cur = useMemo(() => aggregate(scoped, from, to), [scoped, from, to]);
  const prev = useMemo(() => (range === 'all' ? undefined : aggregate(scoped, prevFrom, from)), [scoped, prevFrom, from, range]);
  // Claude Code deletes old transcripts, so a partly covered previous period would inflate changes.
  const hasPrev = prev && comparablePeriod(earliest, prevFrom) && scoped.some((s) => s.start >= prevFrom && s.start < from);

  const daily = useMemo(() => {
    const idx = (ts: number) => Math.floor((startOfDay(ts) - from) / DAY);
    const labels: string[] = [];
    const starts: number[] = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(from, i);
      starts.push(d);
      labels.push(shortDay(d, lang));
    }
    const cost: Record<string, number[]> = Object.fromEntries(AGENT_ORDER.map((a) => [a, Array(days).fill(0)]));
    const active = Array(days).fill(0);
    const wait = Array(days).fill(0);
    const peakMaps: Map<number, number>[] = Array.from({ length: days }, () => new Map());
    const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const s of scoped) {
      const i = idx(s.start);
      if (i < 0 || i >= days) continue;
      cost[s.agent][i] += s.costUSD;
      if (s.isSubagent) continue;
      active[i] += s.activeMs / 3600_000;
      wait[i] += s.waitMs / 3600_000;
      for (const [b] of s.buckets) {
        const ts = b * BUCKET;
        const di = idx(ts);
        if (di < 0 || di >= days) continue;
        const m = peakMaps[di];
        m.set(b, (m.get(b) ?? 0) + 1);
        const d = new Date(ts);
        heat[(d.getDay() + 6) % 7][d.getHours()]++;
      }
    }
    const peak = peakMaps.map((m) => Math.max(0, ...m.values()));
    return { labels, starts, cost, active, wait, peak, heat };
  }, [scoped, from, days, lang]);

  // Output speed per model over the period (estimated from log timestamps).
  const speedRows = useMemo(() => {
    const m = new Map<string, [number, number]>();
    for (const s of scoped) {
      if (s.end < from || s.start >= to) continue;
      for (const [model, [tok, ms]] of Object.entries(s.speed ?? {})) {
        const cur = m.get(model) ?? [0, 0];
        m.set(model, [cur[0] + tok, cur[1] + ms]);
      }
    }
    return [...m.entries()]
      .filter(([, [tok, ms]]) => tok >= 2000 && ms > 0)
      .map(([model, [tok, ms]]) => ({ model, tokens: tok, rate: (tok / ms) * 1000 }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 12);
  }, [scoped, from, to]);

  const cmp = useMemo(() => {
    const rows = shown.map((a) => {
      const g = aggregate(
        list.filter((s) => s.agent === a && (!project || s.projectPath === project)),
        from,
        to,
      );
      return { a, g };
    });
    return rows;
  }, [list, project, from, to, shown.join()]);

  // Harness settings per harness: share of turns run with each value, and how often it changed.
  const knobStats = useMemo(() => {
    const out = new Map<string, Map<string, { vals: Map<string, number>; turns: number; switches: number }>>();
    for (const s of scoped) {
      if (s.isSubagent || s.start < from || s.start >= to) continue;
      const per = out.get(s.agent) ?? new Map();
      out.set(s.agent, per);
      for (const [k, vals] of Object.entries(s.knobs ?? {})) {
        const st = per.get(k) ?? { vals: new Map(), turns: 0, switches: 0 };
        per.set(k, st);
        for (const [v, n] of Object.entries(vals)) {
          st.vals.set(v, (st.vals.get(v) ?? 0) + n);
          st.turns += n;
        }
        st.switches += s.knobSwitches?.[k] ?? 0;
      }
    }
    const knobs = KNOBS.filter((k) => [...out.values()].some((per) => [...(per.get(k)?.vals.keys() ?? [])].some((v) => v !== 'off')));
    return { out, knobs };
  }, [scoped, from, to]);

  const byProject = useMemo(() => {
    const m = new Map<string, { name: string; path: string; g: Agg }>();
    const groups = new Map<string, SessionSummary[]>();
    for (const s of scoped) {
      if (s.start < from || s.start >= to) continue;
      const arr = groups.get(s.projectPath) ?? [];
      arr.push(s);
      groups.set(s.projectPath, arr);
    }
    for (const [p, arr] of groups) m.set(p, { name: arr[0].project, path: p, g: aggregate(arr, from, to) });
    return [...m.values()].sort((a, b) => b.g.cost - a.g.cost);
  }, [scoped, from, to]);

  const anomalies = useMemo(() => {
    const inRange = scoped.filter((s) => s.start >= from && s.start < to && !s.isSubagent);
    const costs = inRange.map((s) => s.totalCostUSD ?? s.costUSD).sort((a, b) => a - b);
    const p90 = costs.length ? costs[Math.floor(costs.length * 0.9)] : Infinity;
    const out: { s: SessionSummary; reason: string }[] = [];
    for (const s of inRange) {
      const cost = s.totalCostUSD ?? s.costUSD;
      if (cost >= Math.max(1, p90) && s.commits === 0 && s.filesChanged === 0) out.push({ s, reason: t('anom.costNoOutput', { cost: money(cost, lang) }) });
      else if (s.ctxPeakPct >= 85) out.push({ s, reason: t('anom.ctx', { pct: pct(s.ctxPeakPct, lang) }) });
      else if (s.maxToolCallsPerTurn >= 60) out.push({ s, reason: t('anom.toolLoop', { n: s.maxToolCallsPerTurn }) });
      else if (s.toolCalls >= 20 && s.toolErrors / s.toolCalls >= 0.3) out.push({ s, reason: t('anom.errors', { pct: pct((s.toolErrors / s.toolCalls) * 100, lang) }) });
      else if (s.uncommittedEdits && s.outcome === 'leftover' && s.status === 'ended') out.push({ s, reason: t('anom.leftover') });
    }
    return out.sort((a, b) => b.s.end - a.s.end).slice(0, 30);
  }, [scoped, from, to, t, lang]);

  const delta = (c: number, p: number | undefined, goodWhenUp: boolean | null) => {
    if (!hasPrev || p === undefined) return <div className="d">{range === 'all' ? ' ' : t('kpi.noPrev')}</div>;
    if (p === 0) return <div className="d">{t('kpi.vsPrev')}</div>;
    const ch = ((c - p) / p) * 100;
    const cls = goodWhenUp === null || Math.abs(ch) < 1 ? '' : (ch > 0) === goodWhenUp ? 'up' : 'down';
    return (
      <div className={`d ${cls}`}>
        {ch > 0 ? '▲' : ch < 0 ? '▼' : '•'} {pct(Math.abs(ch), lang)} {t('kpi.vsPrev')}
      </div>
    );
  };
  const kpi = (label: Key, value: string, d: ReactNode) => (
    <div className="kpi">
      <div className="l">{t(label)}</div>
      <div className="v">{value}</div>
      {d}
    </div>
  );
  const hit = cur.cacheBase ? (cur.cacheRead / cur.cacheBase) * 100 : 0;
  const prevHit = prev && prev.cacheBase ? (prev.cacheRead / prev.cacheBase) * 100 : undefined;

  const costSeries: Series[] = shown.map((a) => ({ key: a, label: t(agentKey(a)), color: agentColor(a), values: daily.cost[a] }));
  const timeSeries: Series[] = [
    { key: 'active', label: t('chart.working'), color: seriesColor(2), values: daily.active },
    { key: 'wait', label: t('chart.waiting'), color: seriesColor(3), values: daily.wait },
  ];
  const peakSeries: Series[] = [{ key: 'peak', label: t('chart.peak'), color: seriesColor(6), values: daily.peak }];
  const fmtH = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}${lang === 'zh-CN' ? '时' : 'h'}`;
  const tt = (i: number) => shortDay(daily.starts[i], lang);
  const toggle = (k: string) => setTables((x) => ({ ...x, [k]: !x[k] }));
  const chartCard = (k: string, title: Key, legendSeries: Series[], chart: ReactNode, table: ReactNode, wide = false) => (
    <div className={`chart-card ${wide ? 'wide' : ''}`}>
      <h3>
        <span className="h">{t(title)}</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => toggle(k)}>
          {tables[k] ? t('chart.chart') : t('chart.table')}
        </button>
      </h3>
      <Legend series={legendSeries} />
      {tables[k] ? table : chart}
    </div>
  );

  return (
    <div className="page">
      <div className="toolbar">
        <Seg
          value={range}
          onChange={setRange}
          options={(['7', '30', '90', 'all'] as Range[]).map((r) => ({ value: r, label: t(`range.${r}` as Key) }))}
        />
        <HarnessFilter value={harnesses} onChange={(v) => setHarnessList(v.join(','))} present={present} />
        <select className="sel" value={project} onChange={(e) => setProject(e.target.value)} aria-label={t('sessions.allProjects')}>
          <option value="">{t('sessions.allProjects')}</option>
          {projects.map(([p, n]) => (
            <option key={p} value={p}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="eff">
        <div className="kpis">
          {kpi('kpi.cost', money(cur.cost, lang), delta(cur.cost, prev?.cost, null))}
          {kpi('kpi.active', hours(cur.active, lang), delta(cur.active, prev?.active, null))}
          {kpi('kpi.wait', hours(cur.wait, lang), delta(cur.wait, prev?.wait, null))}
          {kpi('kpi.sessions', int(cur.sessions, lang), delta(cur.sessions, prev?.sessions, null))}
          {kpi('kpi.commits', int(cur.commits, lang), delta(cur.commits, prev?.commits, true))}
          {kpi('kpi.lines', compact(cur.lines, lang), delta(cur.lines, prev?.lines, true))}
          {kpi('kpi.cacheHit', cur.cacheBase ? pct(hit, lang) : '–', delta(hit, prevHit, true))}
          {kpi('kpi.parallel', int(cur.peak, lang), delta(cur.peak, prev?.peak, null))}
        </div>
        <div className="charts">
          {chartCard(
            'cost',
            'chart.dailyCost',
            costSeries,
            <BarChart labels={daily.labels} series={costSeries} format={(v) => money(v, lang)} tooltipTitle={tt} />,
            <DataTable labels={daily.labels} series={costSeries} format={(v) => money(v, lang)} firstHeader={t('chart.day')} />,
          )}
          {chartCard(
            'time',
            'chart.dailyTime',
            timeSeries,
            <BarChart labels={daily.labels} series={timeSeries} mode="group" format={fmtH} tooltipTitle={tt} />,
            <DataTable labels={daily.labels} series={timeSeries} format={fmtH} firstHeader={t('chart.day')} />,
          )}
          {chartCard(
            'heat',
            'chart.heatmap',
            [],
            <Heatmap grid={daily.heat} rowLabels={Array.from({ length: 7 }, (_, i) => weekday(i, lang))} unit={t('chart.heatmapUnit')} />,
            <DataTable
              labels={Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`)}
              series={Array.from({ length: 7 }, (_, d) => ({ key: String(d), label: weekday(d, lang), color: '', values: daily.heat[d] }))}
              format={(v) => int(v, lang)}
              firstHeader=""
            />,
          )}
          {chartCard(
            'peak',
            'chart.parallel',
            peakSeries,
            <BarChart labels={daily.labels} series={peakSeries} format={(v) => int(v, lang)} tooltipTitle={tt} />,
            <DataTable labels={daily.labels} series={peakSeries} format={(v) => int(v, lang)} firstHeader={t('chart.day')} />,
          )}
          <div className="chart-card">
            <h3><span className="h">{t('cmp.title')}</span></h3>
            <table className="grid">
              <thead>
                <tr>
                  <th>{t('cmp.metric')}</th>
                  {cmp.map(({ a }) => (
                    <th key={a} className="r">
                      <span className="dot" style={{ background: agentColor(a), marginRight: 5 }} />
                      {t(agentKey(a))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['cmp.sessions', (g: Agg) => int(g.sessions, lang)],
                    ['cmp.cost', (g: Agg) => money(g.cost, lang)],
                    ['cmp.costPerSession', (g: Agg) => (g.sessions ? money(g.cost / g.sessions, lang) : '–')],
                    ['cmp.costPerCommit', (g: Agg) => (g.commits ? money(g.cost / g.commits, lang) : '–')],
                    ['cmp.turnTime', (g: Agg) => (g.turns ? duration(g.active / g.turns, lang) : '–')],
                    ['cmp.interrupts', (g: Agg) => (g.turns ? pct((g.interrupts / g.turns) * 100, lang, 1) : '–')],
                    ['cmp.toolErrors', (g: Agg) => (g.tools ? pct((g.toolErrors / g.tools) * 100, lang, 1) : '–')],
                    ['cmp.cacheHit', (g: Agg) => (g.cacheBase ? pct((g.cacheRead / g.cacheBase) * 100, lang) : '–')],
                    ['cmp.linesPerDollar', (g: Agg) => (g.cost ? compact(g.lines / g.cost, lang) : '–')],
                  ] as [Key, (g: Agg) => string][]
                ).map(([k, f]) => (
                  <tr key={k}>
                    <td>{t(k)}</td>
                    {cmp.map(({ a, g }) => (
                      <td key={a} className="r">
                        {f(g)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              {t('cmp.note')}
            </div>
          </div>
          {knobStats.knobs.length > 0 && (
            <div className="chart-card wide">
              <h3><span className="h">{t('eff.knobs')}</span></h3>
              <table className="grid knobs">
                <thead>
                  <tr>
                    <th>{t('cmp.metric')}</th>
                    {shown.filter((a) => knobStats.out.has(a)).map((a) => (
                      <th key={a}>
                        <span className="dot" style={{ background: agentColor(a), marginRight: 5 }} />
                        {t(agentKey(a))}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {knobStats.knobs.map((k) => (
                    <tr key={k}>
                      <td className="nw">{t(knobKey(k))}</td>
                      {shown.filter((a) => knobStats.out.has(a)).map((a) => {
                        const st = knobStats.out.get(a)?.get(k);
                        if (!st || !st.turns) return <td key={a} className="muted">–</td>;
                        const top = [...st.vals].sort((x, y) => y[1] - x[1]);
                        return (
                          <td key={a}>
                            {top.slice(0, 3).map(([v, n]) => (
                              <span key={v} className="knob-val">
                                <span className="mono">{v}</span> {pct((n / st.turns) * 100, lang)}
                              </span>
                            ))}
                            {top.length > 3 && <span className="muted">+{top.length - 3}</span>}
                            {st.switches > 0 && <div className="muted" style={{ fontSize: 11 }}>{t('eff.switches', { n: st.switches })}</div>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                {t('eff.knobsNote')}
              </div>
            </div>
          )}
          <div className="chart-card">
            <h3><span className="h">{t('proj.title')}</span></h3>
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th>{t('proj.name')}</th>
                    <th className="r">{t('kpi.sessions')}</th>
                    <th className="r">{t('cmp.cost')}</th>
                    <th className="r">{t('kpi.active')}</th>
                    <th className="r">{t('kpi.commits')}</th>
                    <th className="r">{t('kpi.lines')}</th>
                  </tr>
                </thead>
                <tbody>
                  {byProject.map((p) => (
                    <tr key={p.path} title={p.path}>
                      <td className="nw">{p.name}</td>
                      <td className="r">{p.g.sessions}</td>
                      <td className="r">{money(p.g.cost, lang)}</td>
                      <td className="r">{duration(p.g.active, lang)}</td>
                      <td className="r">{p.g.commits}</td>
                      <td className="r">{compact(p.g.lines, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {speedRows.length > 0 && (
            <div className="chart-card">
              <h3>
                <span className="h">{t('eff.speed')}</span>
              </h3>
              <table className="grid">
                <thead>
                  <tr>
                    <th>{t('speed.model')}</th>
                    <th className="r">{t('eff.speed')}</th>
                    <th className="r">{t('speed.tokens')}</th>
                  </tr>
                </thead>
                <tbody>
                  {speedRows.map((r) => (
                    <tr key={r.model}>
                      <td className="mono">{r.model}</td>
                      <td className="r">{t('eff.speedValue', { n: r.rate.toFixed(0) })}</td>
                      <td className="r">{compact(r.tokens, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                {t('speed.note')}
              </div>
            </div>
          )}
          <div className="chart-card wide">
            <h3><span className="h">{t('anom.title')}</span></h3>
            {anomalies.length === 0 ? (
              <div className="muted">{t('anom.none')}</div>
            ) : (
              <table className="grid">
                <tbody>
                  {anomalies.map(({ s, reason }) => (
                    <tr key={s.id} className="click" onClick={() => onOpen(s.id)}>
                      <td style={{ width: 90 }}>
                        <StatusBadge s={s} />
                      </td>
                      <td>
                        <div className="clip">{s.title}</div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {s.project} · {shortDay(s.start, lang)}
                        </div>
                      </td>
                      <td>{reason}</td>
                      <td className="r">{money(s.totalCostUSD ?? s.costUSD, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
