import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionDetail, TimelineItem } from '../../../src/shared/types';
import { time } from '../format';
import { useI18n, type Key } from '../i18n';

const PAGE = 150;

const LABEL: Record<TimelineItem['kind'], Key> = {
  user: 'tl.you',
  assistant: 'tl.agent',
  tool: 'tl.tool',
  result: 'tl.result',
  system: 'tl.system',
  question: 'tl.question',
};

/** Conversation timeline. Renders in pages as you scroll so long sessions stay fast. */
export function Timeline({ detail, onHide }: { detail?: SessionDetail; onHide: () => void }) {
  const { t, lang } = useI18n();
  const [showTools, setShowTools] = useState(() => {
    try {
      return localStorage.getItem('loggy.tlTools') === 'true';
    } catch {
      return false;
    }
  });
  const [limit, setLimit] = useState(PAGE);
  const ref = useRef<HTMLDivElement>(null);
  const items = useMemo(
    () => (detail?.timeline ?? []).filter((i) => showTools || (i.kind !== 'tool' && i.kind !== 'result')),
    [detail, showTools],
  );
  useEffect(() => {
    setLimit(PAGE);
    ref.current?.scrollTo({ top: 0 });
  }, [detail?.summary.id]);

  const shown = items.slice(0, limit);
  let lastTurn = -1;
  return (
    <>
      <div className="toolbar" style={{ borderBottom: '1px solid var(--line)' }}>
        <b>{t('detail.timeline')}</b>
        <span className="muted num">{items.length}</span>
        <span className="spacer" />
        <label className="chk">
          <input
            type="checkbox"
            checked={showTools}
            onChange={(e) => {
              setShowTools(e.target.checked);
              try {
                localStorage.setItem('loggy.tlTools', String(e.target.checked));
              } catch {
                // ignore
              }
            }}
          />
          {t('tl.showTools')}
        </label>
        <button className="btn icon" onClick={onHide} aria-label={t('detail.hideTimeline')} title={t('detail.hideTimeline')}>
          ×
        </button>
      </div>
      <div
        className="pane-body"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight > el.scrollHeight - 400 && limit < items.length) setLimit((l) => l + PAGE);
        }}
      >
        {!detail ? (
          <div className="empty-state">{t('detail.loading')}</div>
        ) : items.length === 0 ? (
          <div className="empty-state">{t('tl.empty')}</div>
        ) : (
          <div className="tl">
            {shown.map((it, i) => {
              const sep =
                it.turn !== lastTurn && it.turn > 0 ? (
                  <div className="tl-turn num" key={`turn-${it.turn}-${i}`}>
                    #{it.turn}
                  </div>
                ) : null;
              lastTurn = it.turn;
              return [
                sep,
                <div key={i} className={`tl-item ${it.kind} ${it.isError ? 'error' : ''}`}>
                  {it.kind !== 'system' && (
                    <div className="when num">
                      <span>{t(LABEL[it.kind])}</span>
                      {it.tool && <span className="mono">{it.tool}</span>}
                      <span>{time(it.ts, lang)}</span>
                    </div>
                  )}
                  {it.text}
                  {it.cut ? <div className="muted">{t('tl.truncated', { n: it.cut })}</div> : null}
                </div>,
              ];
            })}
            {(items.length > shown.length || detail.timelineTotal > detail.timeline.length) && (
              <div className="muted" style={{ textAlign: 'center', fontSize: 11 }}>
                {t('tl.more', { shown: shown.length, total: Math.max(items.length, detail.timelineTotal) })}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
