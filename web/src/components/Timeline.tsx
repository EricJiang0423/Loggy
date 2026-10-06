import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionDetail, TimelineItem } from '../../../src/shared/types';
import { time } from '../format';
import { useI18n, type Key } from '../i18n';
import { Seg } from './common';

const PAGE = 150;

const LABEL: Record<TimelineItem['kind'], Key> = {
  user: 'tl.you',
  assistant: 'tl.agent',
  tool: 'tl.tool',
  result: 'tl.result',
  system: 'tl.system',
  question: 'tl.question',
};

/** all: everything; final: your inputs and each turn's last reply; mine: only your inputs. */
type View = 'all' | 'final' | 'mine';

function stored<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function systemText(text: string, t: (k: Key) => string): string {
  if (text === 'rewind') return t('tl.sys.rewind');
  if (text === 'compact') return t('tl.sys.compact');
  if (text.startsWith('interrupted')) return t('tl.sys.interrupted');
  return text;
}

/** A question card: each question with its options, the chosen answer marked. */
function Question({ text, answers }: { text: string; answers: Map<string, string | undefined> }) {
  return (
    <>
      {text.split('\n\n').map((block, i) => {
        const [question, ...options] = block.split('\n');
        const answer = answers.get(question.trim());
        return (
          <div key={i} className="q-block">
            <div>{question}</div>
            {options.map((o, j) => {
              const label = o.replace(/^•\s*/, '');
              const chosen = answer !== undefined && (answer === label || answer.split(', ').includes(label));
              return (
                <div key={j} className={`q-opt ${chosen ? 'chosen' : ''}`}>
                  {chosen ? '✓' : '·'} {label}
                </div>
              );
            })}
            {answer !== undefined && !options.some((o) => o.replace(/^•\s*/, '') === answer) && <div className="q-opt chosen">✓ {answer}</div>}
          </div>
        );
      })}
    </>
  );
}

/** Conversation timeline. Renders in pages as you scroll so long sessions stay fast. */
export function Timeline({ detail, onHide }: { detail?: SessionDetail; onHide: () => void }) {
  const { t, lang } = useI18n();
  const [view, setView] = useState<View>(() => stored<View>('loggy.tlView', 'all'));
  const [showTools, setShowTools] = useState(() => stored<string>('loggy.tlTools', 'false') === 'true');
  const [limit, setLimit] = useState(PAGE);
  const ref = useRef<HTMLDivElement>(null);

  const { items, hidden, inputNo, inputs, answers } = useMemo(() => {
    const all = detail?.timeline ?? [];
    const lastReply = new Map<number, number>();
    all.forEach((it, i) => it.kind === 'assistant' && lastReply.set(it.turn, i));
    const inputNo = new Map<TimelineItem, number>();
    for (const it of all) if (it.kind === 'user') inputNo.set(it, inputNo.size + 1);
    const answers = new Map<string, string | undefined>();
    for (const q of detail?.questions ?? []) for (const qq of q.questions) answers.set(qq.question.trim(), qq.answer);
    let hidden = 0;
    const items = all.filter((it, i) => {
      if (it.kind === 'user' || (it.kind === 'system' && it.text === 'rewind')) return true;
      if (view === 'mine') return false;
      const middle = it.kind === 'tool' || it.kind === 'result' || (it.kind === 'assistant' && lastReply.get(it.turn) !== i);
      if (view === 'final' && middle) {
        hidden++;
        return false;
      }
      return showTools || (it.kind !== 'tool' && it.kind !== 'result');
    });
    return { items, hidden, inputNo, inputs: inputNo.size, answers };
  }, [detail, view, showTools]);

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
        <Seg
          value={view}
          onChange={(v) => {
            setView(v);
            store('loggy.tlView', v);
          }}
          options={[
            { value: 'all', label: t('tl.viewAll') },
            { value: 'final', label: t('tl.hideMiddle') },
            { value: 'mine', label: t('tl.onlyMine') },
          ]}
        />
        {view === 'all' && (
          <label className="chk">
            <input
              type="checkbox"
              checked={showTools}
              onChange={(e) => {
                setShowTools(e.target.checked);
                store('loggy.tlTools', String(e.target.checked));
              }}
            />
            {t('tl.showTools')}
          </label>
        )}
        <button className="btn icon ghost" onClick={onHide} aria-label={t('detail.hideTimeline')} title={t('detail.hideTimeline')}>
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
            {view === 'final' && hidden > 0 && <div className="muted tl-note">{t('tl.hidden', { n: hidden })}</div>}
            {shown.map((it, i) => {
              const sep =
                view !== 'mine' && it.turn !== lastTurn && it.turn > 0 ? (
                  <div className="tl-turn num" key={`turn-${it.turn}-${i}`}>
                    #{it.turn}
                  </div>
                ) : null;
              lastTurn = it.turn;
              const no = inputNo.get(it);
              return [
                sep,
                <div key={i} className={`tl-item ${it.kind} ${it.isError ? 'error' : ''} ${it.rewound ? 'rewound' : ''} ${it.text === 'rewind' && it.kind === 'system' ? 'rewind' : ''}`}>
                  {it.kind !== 'system' && (
                    <div className="when num">
                      <span>{t(LABEL[it.kind])}</span>
                      {it.tool && <span className="mono">{it.tool}</span>}
                      <span>{time(it.ts, lang)}</span>
                      {no !== undefined && (
                        <span>
                          {no}/{inputs}
                        </span>
                      )}
                      {it.rewound && <span>{t('turns.rewound')}</span>}
                    </div>
                  )}
                  {it.kind === 'system' ? systemText(it.text, t) : it.kind === 'question' ? <Question text={it.text} answers={answers} /> : it.text}
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
