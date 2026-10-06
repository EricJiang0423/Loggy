import { useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../../../src/shared/types';
import { api } from '../api';
import { Calendar } from '../components/Calendar';
import { HarnessFilter, knobKey, LABELS, Seg, useDebounced, usePersisted } from '../components/common';
import { DetailPanel } from '../components/DetailPanel';
import { SessionList } from '../components/SessionList';
import { useI18n, type Key } from '../i18n';
import { refreshSessions, useStore } from '../store';
import type { ColorDim } from '../colors';

export type OutcomeFilter = 'all' | 'live' | 'done' | 'leftover' | 'abandoned';
type Sort = 'recent' | 'start' | 'cost' | 'duration' | 'changes';


const isLive = (s: SessionSummary) => s.status === 'running' || s.status === 'stalled' || s.status === 'needs_input';

export function SessionsPage({ selectedId, onSelect, query }: { selectedId?: string; onSelect: (id: string) => void; query: string }) {
  const { t } = useI18n();
  const list = useStore((s) => s.list);
  const loaded = useStore((s) => s.loaded);
  const [view, setView] = usePersisted<'list' | 'calendar'>('loggy.view', 'calendar');
  const [harnessList, setHarnessList] = usePersisted<string>('loggy.harnesses', '');
  const harnesses = useMemo(() => harnessList.split(',').filter(Boolean), [harnessList]);
  const [knob, setKnob] = usePersisted<string>('loggy.knob', '');
  const [project, setProject] = usePersisted<string>('loggy.project', '');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [subagents, setSubagents] = usePersisted<boolean>('loggy.subagents', false);
  const [withChanges, setWithChanges] = usePersisted<boolean>('loggy.withChanges', false);
  const [starred, setStarred] = usePersisted<boolean>('loggy.starred', false);
  const [label, setLabel] = usePersisted<string>('loggy.label', '');
  const [sort, setSort] = usePersisted<Sort>('loggy.sort', 'recent');
  const [storedColorBy, setColorBy] = usePersisted<ColorDim>('loggy.colorBy', 'outcome');
  const colorBy: ColorDim = ['outcome', 'agent', 'project', 'category', 'model'].includes(storedColorBy) ? storedColorBy : 'outcome';
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

  const present = useMemo(() => [...new Set(list.map((s) => s.agent))].sort((a, b) => ['claude', 'codex', 'kimi'].indexOf(a) - ['claude', 'codex', 'kimi'].indexOf(b)), [list]);
  // Every harness setting seen (e.g. permission=plan), most used first.
  const knobOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of list) for (const [k, vals] of Object.entries(s.knobs ?? {})) for (const [v, n] of Object.entries(vals)) if (k !== 'model') m.set(`${k}=${v}`, (m.get(`${k}=${v}`) ?? 0) + n);
    return [...m].sort((a, b) => a[0].localeCompare(b[0]));
  }, [list]);
  const [knobName, knobValue] = knob.split('=');

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
          (!harnesses.length || harnesses.includes(s.agent)) &&
          (!knob || (s.knobs?.[knobName]?.[knobValue] ?? 0) > 0) &&
          (!project || s.projectPath === project) &&
          (!withChanges || s.filesChanged > 0) &&
          (!starred || s.mark?.star) &&
          (!label || (label === 'none' ? !s.mark?.label : s.mark?.label === label)) &&
          (!hits || hits.has(s.id)),
      ),
    [list, subagents, harnesses, knob, knobName, knobValue, project, withChanges, starred, label, hits],
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
        <HarnessFilter value={harnesses} onChange={(v) => setHarnessList(v.join(','))} present={present} />
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
            {subagents || withChanges || starred || label || knob ? ` · ${Number(subagents) + Number(withChanges) + Number(starred) + Number(!!label) + Number(!!knob)}` : ''}
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
            <label className="chk">
              <input type="checkbox" checked={starred} onChange={(e) => setStarred(e.target.checked)} />
              {t('sessions.starred')}
            </label>
            <select className="sel" value={label} onChange={(e) => setLabel(e.target.value)} aria-label={t('sessions.anyLabel')}>
              <option value="">{t('sessions.anyLabel')}</option>
              <option value="none">{t('mark.none')}</option>
              {LABELS.map((l) => (
                <option key={l} value={l}>
                  {t(`mark.${l}` as Key)}
                </option>
              ))}
            </select>
            <select className="sel" value={knob} onChange={(e) => setKnob(e.target.value)} aria-label={t('sessions.anyKnob')}>
              <option value="">{t('sessions.anyKnob')}</option>
              {knobOptions.map(([k]) => (
                <option key={k} value={k}>
                  {t(knobKey(k.split('=')[0]))}: {k.split('=').slice(1).join('=')}
                </option>
              ))}
            </select>
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
