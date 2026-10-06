import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionSummary } from '../../../src/shared/types';
import { api } from '../api';
import { useI18n, type Key } from '../i18n';
import { refreshSessions } from '../store';

export const LABELS = ['discuss', 'doing', 'later', 'done'] as const;

/** Star toggle; saves right away. */
export function Star({ s }: { s: Pick<SessionSummary, 'id' | 'mark'> }) {
  const { t } = useI18n();
  const on = !!s.mark?.star;
  return (
    <button
      className={`star ${on ? 'on' : ''}`}
      title={t(on ? 'mark.unstar' : 'mark.star')}
      aria-label={t(on ? 'mark.unstar' : 'mark.star')}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        void api.mark(s.id, { star: !on }).then(() => refreshSessions());
      }}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

export function AgentBadge({ agent }: { agent: string }) {
  const { t } = useI18n();
  return <span className={`badge ${agent}`}>{t(`agent.${agent}` as Key)}</span>;
}

/** Live status when the session is active, otherwise the outcome. */
export function StatusBadge({ s }: { s: Pick<SessionSummary, 'status' | 'outcome'> }) {
  const { t } = useI18n();
  const live = s.status === 'running' || s.status === 'stalled' || s.status === 'needs_input';
  const key = live ? s.status : s.outcome;
  const hint = live ? (s.status === 'stalled' ? t('status.stalled.hint') : undefined) : s.outcome !== 'empty' ? t(`outcome.${s.outcome}.hint` as Key) : undefined;
  return (
    <span className={`status ${key}`} title={hint}>
      {s.status === 'running' && <span className="pulse" aria-hidden />}
      {live ? t(`status.${s.status}` as Key) : t(`outcome.${s.outcome}` as Key)}
    </span>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} aria-pressed={o.value === value}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      className="btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setDone(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setDone(false), 1500);
      }}
      title={text}
    >
      {done ? t('detail.copied') : label}
    </button>
  );
}

export function Card({ title, extra, children }: { title: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <h3>
        <span className="h">{title}</span>
        <span className="spacer" />
        {extra}
      </h3>
      <div className="body">{children}</div>
    </section>
  );
}

/** Re-renders when the theme changes, for canvas and SVG colors computed in JS. */
export function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const on = () => setV((x) => x + 1);
    window.addEventListener('loggy-theme', on);
    return () => window.removeEventListener('loggy-theme', on);
  }, []);
  return v;
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Unified diff with added, removed and hunk lines colored. */
export function DiffView({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <pre className="code">
      {lines.map((l, i) => {
        const cls = l.startsWith('+') && !l.startsWith('+++') ? 'a' : l.startsWith('-') && !l.startsWith('---') ? 'r' : l.startsWith('@@') ? 'h' : '';
        return cls ? (
          <span key={i} className={cls}>
            {l}
          </span>
        ) : (
          <span key={i}>
            {l}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

/** State kept in localStorage (per viewer). */
export function usePersisted<T extends string | boolean>(key: string, initial: T): [T, (v: T) => void] {
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
