import { useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../../src/shared/types';
import { api } from '../api';
import { Calendar } from '../components/Calendar';
import { Seg, useDebounced } from '../components/common';
import { DetailPanel } from '../components/DetailPanel';
import { SessionList } from '../components/SessionList';
import { useI18n } from '../i18n';
import { refreshSessions, useStore } from '../store';
import type { ColorDim } from '../colors';

export type OutcomeFilter = 'all' | 'live' | 'done' | 'leftover' | 'abandoned';
type Sort = 'recent' | 'start' | 'cost' | 'duration' | 'changes';
type AgentFilter = 'all' | 'claude' | 'codex';

function usePersisted<T extends string | boolean>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      return (typeof initial === 'boolean' ? raw === 'true' : raw) as T;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(key, String(nv));
      } catch {
        // ignore
      }
    },
  ];
}

const isLive = (s: SessionSummary) => s.status === 'running' || s.status === 'stalled' || s.status === 'needs_input';

export function SessionsPage({ selectedId, onSelect, query }: { selectedId?: string; onSelect: (id: string) => void; query: string }) {
  const { t } = useI18n();
  const list = useStore((s) => s.list);
  const loaded = useStore((s) => s.loaded);
  const [view, setView] = usePersisted<'list' | 'calendar'>('loggy.view', 'calendar');
  const [agent, setAgent] = usePersisted<AgentFilter>('loggy.agent', 'all');
  const [project, setProject] = usePersisted<string>('loggy.project', '');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [subagents, setSubagents] = usePersisted<boolean>('loggy.subagents', false);
  const [withChanges, setWithChanges] = usePersisted<boolean>('loggy.withChanges', false);
  const [sort, setSort] = usePersisted<Sort>('loggy.sort', 'recent');
  const [colorBy, setColorBy] = usePersisted<ColorDim>('loggy.colorBy', 'outcome');
  const [showTimeline, setShowTimeline] = usePersisted<boolean>('loggy.timeline', true);
  const q = useDebounced(query.trim(), 150);
  const [hits, setHits] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!q) {
      setHits(null);
      return;
    }
    const ac = new AbortController();
    api
      .search(q, ac.signal)
      .then((r) => setHits(new Set(r.ids)))
      .catch(() => undefined);
    return () => ac.abort();
  }, [q, list.length]);

  const projects = useMemo(() => {
    const m = new Map<string, { path: string; name: string; last: number; n: number }>();
    for (const s of list) {
      const p = m.get(s.projectPath) ?? { path: s.projectPath, name: s.project, last: 0, n: 0 };
      p.n++;
      p.last = Math.max(p.last, s.end);
      m.set(s.projectPath, p);
    }
    return [...m.values()].sort((a, b) => b.last - a.last);
  }, [list]);

  // Filters other than the outcome chips; the chips show counts within this set.
  const base = useMemo(
    () =>
      list.filter(
        (s) =>
          (subagents || !s.isSubagent) &&
          (agent === 'all' || s.agent === agent) &&
          (!project || s.projectPath === project) &&
          (!withChanges || s.filesChanged > 0) &&
          (!hits || hits.has(s.id)),
      ),
    [list, subagents, agent, project, withChanges, hits],
  );

  const counts = useMemo(() => {
    const c = { all: base.length, live: 0, done: 0, leftover: 0, abandoned: 0 };
    for (const s of base) {
      if (isLive(s)) c.live++;
      else if (s.outcome === 'done') c.done++;
      else if (s.outcome === 'leftover') c.leftover++;
      else if (s.outcome === 'abandoned') c.abandoned++;
    }
    return c;
  }, [base]);

  const filtered = useMemo(() => {
    const f = base.filter((s) => outcome === 'all' || (outcome === 'live' ? isLive(s) : !isLive(s) && s.outcome === outcome));
    const by: Record<Sort, (a: SessionSummary, b: SessionSummary) => number> = {
      recent: (a, b) => b.end - a.end,
      start: (a, b) => b.start - a.start,
      cost: (a, b) => (b.totalCostUSD ?? b.costUSD) - (a.totalCostUSD ?? a.costUSD),
      duration: (a, b) => b.end - b.start - (a.end - a.start),
      changes: (a, b) => b.linesAdded + b.linesRemoved - (a.linesAdded + a.linesRemoved),
    };
    return f.sort(by[sort]);
  }, [base, outcome, sort]);

  const selected = selectedId ?? filtered[0]?.id;

  const chip = (k: OutcomeFilter, label: string, n: number) => (
    <button className={`pill ${outcome === k ? 'on' : ''}`} onClick={() => setOutcome(k)} aria-pressed={outcome === k}>
      {label} <span className="count">{n}</span>
    </button>
  );

  return (
    <div className="page">
      <div className="toolbar">
        <Seg
          value={view}
          onChange={setView}
          options={[
            { value: 'list', label: t('sessions.list') },
            { value: 'calendar', label: t('sessions.calendar') },
          ]}
        />
        <span className="sep" />
        <div className="seg" role="group" aria-label={t('sessions.all')}>
          {chip('all', t('sessions.all'), counts.all)}
          {chip('live', t('status.running'), counts.live)}
          {chip('done', t('outcome.done'), counts.done)}
          {chip('leftover', t('outcome.leftover'), counts.leftover)}
          {chip('abandoned', t('outcome.abandoned'), counts.abandoned)}
        </div>
        {hits && <span className="muted">{t('sessions.searchResults', { n: base.length })}</span>}
        <span className="spacer" />
        <select className="sel" value={agent} onChange={(e) => setAgent(e.target.value as AgentFilter)} aria-label={t('agent.all')}>
          <option value="all">{t('agent.all')}</option>
          <option value="claude">{t('agent.claude')}</option>
          <option value="codex">{t('agent.codex')}</option>
        </select>
        <select className="sel" value={project} onChange={(e) => setProject(e.target.value)} aria-label={t('sessions.allProjects')}>
          <option value="">{t('sessions.allProjects')}</option>
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name} ({p.n})
            </option>
          ))}
        </select>
        {view === 'list' && (
          <select className="sel" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t('sessions.sort')}>
            <option value="recent">{t('sort.recent')}</option>
            <option value="start">{t('sort.start')}</option>
            <option value="cost">{t('sort.cost')}</option>
            <option value="duration">{t('sort.duration')}</option>
            <option value="changes">{t('sort.changes')}</option>
          </select>
        )}
        <details className="menu">
          <summary>
            {t('sessions.options')}
            {subagents || withChanges ? ` · ${Number(subagents) + Number(withChanges)}` : ''}
          </summary>
          <div className="menu-body">
            <label className="chk">
              <input type="checkbox" checked={subagents} onChange={(e) => setSubagents(e.target.checked)} />
              {t('sessions.subagents')}
            </label>
            <label className="chk">
              <input type="checkbox" checked={withChanges} onChange={(e) => setWithChanges(e.target.checked)} />
              {t('sessions.withChanges')}
            </label>
          </div>
        </details>
        <button className="btn icon ghost" onClick={() => void refreshSessions()} title={t('sessions.reload')} aria-label={t('sessions.reload')}>
          ↻
        </button>
      </div>
      <div className={`sessions ${showTimeline ? '' : 'no-tl'}`}>
        <div className="pane">
          {!loaded ? (
            <div className="empty-state">{t('common.loading')}</div>
          ) : list.length === 0 ? (
            <div className="empty-state">{t('sessions.emptyAll')}</div>
          ) : view === 'list' ? (
            filtered.length ? (
              <SessionList sessions={filtered} selected={selected} onSelect={onSelect} />
            ) : (
              <div className="empty-state">{t('sessions.empty')}</div>
            )
          ) : (
            <Calendar sessions={filtered} all={list} selected={selected} onSelect={onSelect} colorBy={colorBy} setColorBy={setColorBy} />
          )}
        </div>
        <DetailPanel id={selected} showTimeline={showTimeline} setShowTimeline={setShowTimeline} onSelect={onSelect} />
      </div>
    </div>
  );
}
