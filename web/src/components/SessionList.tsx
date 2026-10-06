import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../../../src/shared/types';
import { compact, dateTime, displayTitle, duration, money } from '../format';
import { useI18n, type Key } from '../i18n';
import { shouldSplitNow } from '../split';
import { AgentBadge, Star, StatusBadge } from './common';

const ROW = 70;
const OVERSCAN = 8;

/** Virtualized list: only the rows in view are rendered. */
export function SessionList({ sessions, selected, onSelect }: { sessions: SessionSummary[]; selected?: string; onSelect: (id: string) => void }) {
  const { t, lang } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(800);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Keyboard navigation with up/down.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'j' && e.key !== 'k') return;
      const i = sessions.findIndex((s) => s.id === selected);
      const next = e.key === 'ArrowDown' || e.key === 'j' ? Math.min(sessions.length - 1, i + 1) : Math.max(0, i - 1);
      const s = sessions[next];
      if (!s) return;
      e.preventDefault();
      onSelect(s.id);
      const el = ref.current;
      if (el) {
        const top = next * ROW;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessions, selected, onSelect]);

  const first = Math.max(0, Math.floor(scroll / ROW) - OVERSCAN);
  const last = Math.min(sessions.length, Math.ceil((scroll + height) / ROW) + OVERSCAN);
  const rows = [];
  for (let i = first; i < last; i++) {
    const s = sessions[i];
    rows.push(
      <div
        key={s.id}
        className={`row ${s.id === selected ? 'sel' : ''}`}
        style={{ top: i * ROW }}
        onClick={() => onSelect(s.id)}
        role="option"
        aria-selected={s.id === selected}
      >
        <div className="title">
          <Star s={s} />
          <StatusBadge s={s} />
          <span className="t">{displayTitle(s)}</span>
        </div>
        <div className="right num">
          {(s.linesAdded > 0 || s.linesRemoved > 0) && (
            <span>
              <span className="add">+{compact(s.linesAdded, lang)}</span> <span className="del">−{compact(s.linesRemoved, lang)}</span>
            </span>
          )}
          <b>{money(s.totalCostUSD ?? s.costUSD, lang)}</b>
        </div>
        <div className="meta">
          <AgentBadge agent={s.agent} />
          {s.isSubagent && <span className="badge">sub</span>}
          {shouldSplitNow(s) && <span className="badge refused">{t('split.badge')}</span>}
          {s.mark?.label && <span className="badge">{t(`mark.${s.mark.label}` as Key)}</span>}
          <span>{s.project}</span>
          <span className="num">{dateTime(s.start, lang)}</span>
          <span className="num">{duration(s.end - s.start, lang)}</span>
          <span>{t('detail.inputs', { n: s.userInputs })}</span>
          {s.commits > 0 && <span>{t('out.commits', { n: s.commits })}</span>}
          {(s.children ?? 0) > 0 && <span>{t('detail.subagents', { n: s.children! })}</span>}
        </div>
        <div className="next">{s.ai && !s.ai.complete && s.ai.next[0] ? t('list.next', { s: s.ai.next[0] }) : ''}</div>
      </div>,
    );
  }
  return (
    <div className="pane-body" ref={ref} onScroll={(e) => setScroll(e.currentTarget.scrollTop)} role="listbox" tabIndex={0}>
      <div className="list" style={{ height: sessions.length * ROW }}>
        {rows}
      </div>
    </div>
  );
}
