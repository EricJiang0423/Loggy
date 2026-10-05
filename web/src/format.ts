import type { Lang } from './i18n';

const nf = new Map<string, Intl.NumberFormat>();
function fmt(lang: Lang, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = lang + JSON.stringify(opts);
  let f = nf.get(key);
  if (!f) nf.set(key, (f = new Intl.NumberFormat(lang, opts)));
  return f;
}

/** Earliest session start; empty sessions have no start (0) and are skipped. */
export function earliestStart(sessions: { start: number }[], fallback: number): number {
  let min = Infinity;
  for (const s of sessions) if (s.start && s.start < min) min = s.start;
  return min === Infinity ? fallback : min;
}

/** A previous period is comparable only when the logs reach back to its start. */
export function comparablePeriod(earliest: number, prevFrom: number): boolean {
  return earliest <= prevFrom;
}

export function money(v: number, lang: Lang): string {
  if (!Number.isFinite(v)) return '–';
  if (v === 0) return '$0';
  if (v < 0.01) return '<$0.01';
  return '$' + fmt(lang, { maximumFractionDigits: v >= 100 ? 0 : 2, minimumFractionDigits: v >= 100 ? 0 : 2 }).format(v);
}

export function compact(v: number, lang: Lang): string {
  if (!Number.isFinite(v)) return '–';
  if (Math.abs(v) < 1000) return fmt(lang, { maximumFractionDigits: 0 }).format(v);
  if (lang === 'zh-CN') {
    if (Math.abs(v) >= 1e8) return fmt(lang, { maximumFractionDigits: 1 }).format(v / 1e8) + '亿';
    if (Math.abs(v) >= 1e4) return fmt(lang, { maximumFractionDigits: 1 }).format(v / 1e4) + '万';
  }
  return fmt(lang, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

export function int(v: number, lang: Lang): string {
  return fmt(lang, { maximumFractionDigits: 0 }).format(v);
}

export function pct(v: number, lang: Lang, digits = 0): string {
  if (!Number.isFinite(v)) return '–';
  return fmt(lang, { style: 'percent', maximumFractionDigits: digits }).format(v / 100);
}

export function duration(ms: number, lang: Lang): string {
  if (!Number.isFinite(ms) || ms <= 0) return lang === 'zh-CN' ? '0分' : '0m';
  const m = Math.round(ms / 60_000);
  const zh = lang === 'zh-CN';
  if (m < 1) return zh ? `${Math.max(1, Math.round(ms / 1000))}秒` : `${Math.max(1, Math.round(ms / 1000))}s`;
  if (m < 60) return zh ? `${m}分` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return zh ? `${h}小时${rm ? `${rm}分` : ''}` : `${h}h${rm ? ` ${rm}m` : ''}`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return zh ? `${d}天${rh ? `${rh}小时` : ''}` : `${d}d${rh ? ` ${rh}h` : ''}`;
}

export function hours(ms: number, lang: Lang): string {
  const h = ms / 3600_000;
  return fmt(lang, { maximumFractionDigits: h < 10 ? 1 : 0 }).format(h) + (lang === 'zh-CN' ? ' 小时' : ' h');
}

const dtf = new Map<string, Intl.DateTimeFormat>();
function dfmt(lang: Lang, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = lang + JSON.stringify(opts);
  let f = dtf.get(key);
  if (!f) dtf.set(key, (f = new Intl.DateTimeFormat(lang, opts)));
  return f;
}

export function time(ts: number, lang: Lang): string {
  return dfmt(lang, { hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);
}

export function dateTime(ts: number, lang: Lang): string {
  if (!ts) return '–';
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return dfmt(lang, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hour12: false }).format(ts);
}

export function day(ts: number, lang: Lang): string {
  return dfmt(lang, { month: 'numeric', day: 'numeric', weekday: 'short' }).format(ts);
}

export function shortDay(ts: number, lang: Lang): string {
  return dfmt(lang, { month: 'numeric', day: 'numeric' }).format(ts);
}

export function weekday(i: number, lang: Lang): string {
  // i: 0 = Monday
  const base = new Date(2024, 0, 1 + i); // 2024-01-01 is a Monday
  return dfmt(lang, { weekday: 'short' }).format(base);
}

export function relative(ts: number, lang: Lang, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 45_000) return lang === 'zh-CN' ? '刚刚' : 'just now';
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const m = Math.round(diff / 60_000);
  if (m < 60) return rtf.format(-m, 'minute');
  const h = Math.round(m / 60);
  if (h < 36) return rtf.format(-h, 'hour');
  return rtf.format(-Math.round(h / 24), 'day');
}

export function future(ts: number, lang: Lang, now = Date.now()): string {
  const diff = ts - now;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const m = Math.round(diff / 60_000);
  if (m < 60) return rtf.format(Math.max(m, 0), 'minute');
  const h = Math.round(m / 60);
  if (h < 36) return rtf.format(h, 'hour');
  return rtf.format(Math.round(h / 24), 'day');
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfWeek(ts: number): number {
  const d = new Date(startOfDay(ts));
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

export function addDays(ts: number, n: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function shortPath(p: string): string {
  return p.replace(/^\/(Users|home)\/[^/]+/, '~');
}
