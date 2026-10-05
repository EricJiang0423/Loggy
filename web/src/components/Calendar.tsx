import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '../../../src/shared/types';
import { OTHER_KEY, colorFor, dimValue, legendEntries, outcomeColor, series, slotMap, type ColorDim } from '../colors';
import { addDays, dateTime, day, duration, money, shortDay, startOfWeek, time } from '../format';
import { useI18n, type Key } from '../i18n';
import { useStore } from '../store';
import { cssVar, StatusBadge, useThemeVersion } from './common';

const GUTTER = 44;
const BUCKET = 600_000;
const MERGE_GAP = 3; // buckets
const DAY = 86400_000;

interface Piece {
  s: SessionSummary;
  day: number;
  y0: number; // ms from day start
  y1: number;
  buckets: [number, number][]; // [ms from day start, count]
  inputs: number[];
  lane: number;
  lanes: number;
  max: number;
}

interface Hit {
  x: number;
  y: number;
  w: number;
  h: number;
  s: SessionSummary;
}

function layoutWeek(sessions: SessionSummary[], weekStart: number): Piece[] {
  const weekEnd = addDays(weekStart, 7);
  const dayStarts = Array.from({ length: 8 }, (_, i) => addDays(weekStart, i));
  const pieces: Piece[] = [];
  for (const s of sessions) {
    if (s.end < weekStart || s.start >= weekEnd) continue;
    const bs = s.buckets.length ? s.buckets : ([[Math.floor(s.start / BUCKET), 1]] as [number, number][]);
    const max = Math.max(1, ...bs.map((b) => b[1]));
    // Merge buckets into segments, then split segments by day.
    let segStart = -1;
    let prev = -1;
    let segBuckets: [number, number][] = [];
    const flush = () => {
      if (segStart < 0) return;
      const t0 = segStart * BUCKET;
      const t1 = (prev + 1) * BUCKET;
      for (let d = 0; d < 7; d++) {
        const ds = dayStarts[d];
        const de = dayStarts[d + 1];
        if (t1 <= ds || t0 >= de) continue;
        const y0 = Math.max(t0, ds) - ds;
        const y1 = Math.min(t1, de) - ds;
        const buckets = segBuckets.filter(([b]) => b * BUCKET >= ds && b * BUCKET < de).map(([b, c]) => [b * BUCKET - ds, c] as [number, number]);
        const inputs = s.inputTimes.filter((t) => t >= Math.max(t0, ds) && t < Math.min(t1, de)).map((t) => t - ds);
        pieces.push({ s, day: d, y0, y1, buckets, inputs, lane: 0, lanes: 1, max });
      }
    };
    for (const [b, c] of bs) {
      if (b * BUCKET >= weekEnd || (b + 1) * BUCKET <= weekStart) continue;
      if (segStart >= 0 && b - prev <= MERGE_GAP) {
        prev = b;
        segBuckets.push([b, c]);
      } else {
        flush();
        segStart = b;
        prev = b;
        segBuckets = [[b, c]];
      }
    }
    flush();
  }
  // Lanes: within each day, a session keeps one lane; overlapping clusters share the width.
  for (let d = 0; d < 7; d++) {
    const dayPieces = pieces.filter((p) => p.day === d);
    const spans = new Map<string, { y0: number; y1: number; lane: number; cluster: number }>();
    for (const p of dayPieces) {
      const sp = spans.get(p.s.id);
      if (sp) {
        sp.y0 = Math.min(sp.y0, p.y0);
        sp.y1 = Math.max(sp.y1, p.y1);
      } else spans.set(p.s.id, { y0: p.y0, y1: p.y1, lane: 0, cluster: 0 });
    }
    const sorted = [...spans.values()].sort((a, b) => a.y0 - b.y0 || b.y1 - a.y1);
    const clusterLanes: number[] = [];
    let cluster = -1;
    let clusterEnd = -1;
    let laneEnds: number[] = [];
    for (const sp of sorted) {
      if (sp.y0 >= clusterEnd) {
        cluster++;
        clusterLanes[cluster] = 0;
        laneEnds = [];
      }
      let lane = laneEnds.findIndex((e) => e <= sp.y0);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(sp.y1);
      } else laneEnds[lane] = sp.y1;
      sp.lane = lane;
      sp.cluster = cluster;
      clusterLanes[cluster] = Math.max(clusterLanes[cluster], lane + 1);
      clusterEnd = Math.max(clusterEnd, sp.y1);
    }
    for (const p of dayPieces) {
      const sp = spans.get(p.s.id)!;
      p.lane = sp.lane;
      p.lanes = clusterLanes[sp.cluster];
    }
  }
  return pieces;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const DIMS: ColorDim[] = ['outcome', 'agent', 'project', 'component', 'model'];

export function Calendar({
  sessions,
  all,
  selected,
  onSelect,
  colorBy,
  setColorBy,
}: {
  sessions: SessionSummary[];
  all: SessionSummary[];
  selected?: string;
  onSelect: (id: string) => void;
  colorBy: ColorDim;
  setColorBy: (d: ColorDim) => void;
}) {
  const { t, lang } = useI18n();
  const now = useStore((s) => s.now);
  const themeV = useThemeVersion();
  const [weekStart, setWeekStart] = useState(() => {
    const sel = all.find((s) => s.id === selected);
    return startOfWeek(sel ? sel.start : Date.now());
  });
  const [hourPx, setHourPx] = useState(() => {
    try {
      return Number(localStorage.getItem('loggy.hourPx')) || 36;
    } catch {
      return 36;
    }
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hits = useRef<Hit[]>([]);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<{ s: SessionSummary; x: number; y: number } | null>(null);
  const scrolledFor = useRef<number>(-1);
  const hoverId = hover?.s.id;

  useEffect(() => {
    try {
      localStorage.setItem('loggy.hourPx', String(hourPx));
    } catch {
      // ignore
    }
  }, [hourPx]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const slots = useMemo(() => slotMap(all, colorBy), [all, colorBy]);
  const pieces = useMemo(() => layoutWeek(sessions, weekStart), [sessions, weekStart]);
  const weekSessions = useMemo(() => [...new Map(pieces.map((p) => [p.s.id, p.s])).values()], [pieces]);

  // Scroll to the first activity of the week (or 8:00) when the week changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrolledFor.current === weekStart) return;
    scrolledFor.current = weekStart;
    const firstMs = pieces.length ? Math.min(...pieces.map((p) => p.y0)) : 8 * 3600_000;
    el.scrollTop = Math.max(0, (Math.min(firstMs, 8 * 3600_000) / 3600_000) * hourPx - 10);
  }, [weekStart, pieces, hourPx]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const H = 24 * hourPx;
    const W = width;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colW = (W - GUTTER) / 7;
    const ink = cssVar('--ink');
    const line = cssVar('--line');
    const muted = cssVar('--muted');
    const surface = cssVar('--surface');
    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, W, H);
    const todayIdx = Math.floor((now - weekStart) / DAY);
    if (todayIdx >= 0 && todayIdx < 7) {
      ctx.fillStyle = cssVar('--today');
      ctx.fillRect(GUTTER + todayIdx * colW, 0, colW, H);
    }
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const labelEvery = hourPx < 22 ? 3 : hourPx < 34 ? 2 : 1;
    for (let h = 0; h <= 24; h++) {
      const y = Math.round(h * hourPx) + 0.5;
      ctx.strokeStyle = line;
      ctx.beginPath();
      ctx.moveTo(GUTTER, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      if (h > 0 && h < 24 && h % labelEvery === 0) {
        ctx.fillStyle = muted;
        ctx.fillText(`${String(h).padStart(2, '0')}:00`, GUTTER - 6, y);
      }
    }
    for (let d = 0; d <= 7; d++) {
      const x = Math.round(GUTTER + d * colW) + 0.5;
      ctx.strokeStyle = line;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    const newHits: Hit[] = [];
    const scale = hourPx / 3600_000;
    const bucketH = Math.max(1, BUCKET * scale);
    for (const p of pieces) {
      const laneW = colW / p.lanes;
      const x = GUTTER + p.day * colW + p.lane * laneW + 1.5;
      const w = Math.max(3, laneW - 3);
      const y = p.y0 * scale;
      const h = Math.max(3, (p.y1 - p.y0) * scale);
      const color = colorFor(p.s, colorBy, slots);
      ctx.save();
      roundRect(ctx, x, y, w, h, 3);
      ctx.clip();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.14;
      ctx.fillRect(x, y, w, h);
      for (const [b, c] of p.buckets) {
        ctx.globalAlpha = 0.3 + 0.7 * Math.min(1, c / p.max);
        ctx.fillRect(x, b * scale, w, bucketH);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
      const isSel = p.s.id === selected;
      const isHover = hoverId === p.s.id;
      roundRect(ctx, x, y, w, h, 3);
      ctx.strokeStyle = isSel ? ink : color;
      ctx.lineWidth = isSel ? 2 : isHover ? 1.5 : 1;
      ctx.stroke();
      if (w >= 6) {
        for (const ti of p.inputs) {
          ctx.beginPath();
          ctx.arc(x + Math.min(5, w / 2), ti * scale, Math.min(2.5, w / 3), 0, Math.PI * 2);
          ctx.fillStyle = surface;
          ctx.fill();
          ctx.strokeStyle = ink;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      if (p.s.status === 'running' && h > 4) {
        ctx.fillStyle = color;
        ctx.fillRect(x, y + h - 2, w, 2);
      }
      newHits.push({ x, y, w, h, s: p.s });
    }
    if (todayIdx >= 0 && todayIdx < 7) {
      const y = ((now - addDays(weekStart, todayIdx)) / 3600_000) * hourPx;
      ctx.strokeStyle = '#d03b3b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(GUTTER + todayIdx * colW, y);
      ctx.lineTo(GUTTER + (todayIdx + 1) * colW, y);
      ctx.stroke();
    }
    hits.current = newHits;
  }, [pieces, width, hourPx, colorBy, slots, selected, hoverId, weekStart, now, themeV]);

  // Ctrl/Cmd + wheel zooms around the pointer.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const offset = e.clientY - rect.top;
      setHourPx((cur) => {
        const next = Math.max(14, Math.min(180, cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        const ratio = next / cur;
        requestAnimationFrame(() => {
          el.scrollTop = (el.scrollTop + offset) * ratio - offset;
        });
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const hitAt = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    for (let i = hits.current.length - 1; i >= 0; i--) {
      const h = hits.current[i];
      if (x >= h.x - 2 && x <= h.x + h.w + 2 && y >= h.y - 2 && y <= h.y + h.h + 2) return h.s;
    }
    return undefined;
  };

  const legend = useMemo(() => legendEntries(weekSessions, colorBy, slots), [weekSessions, colorBy, slots]);

  const legendLabel = (v: string) => {
    if (!v) return t('cal.none');
    if (v === OTHER_KEY) return t('cal.other');
    if (colorBy === 'outcome') {
      return ['running', 'stalled', 'needs_input'].includes(v) ? t(`status.${v}` as Key) : t(`outcome.${v}` as Key);
    }
    if (colorBy === 'agent') return t(v === 'claude' ? 'agent.claude' : 'agent.codex');
    return v;
  };
  const legendColor = (v: string) => {
    if (colorBy === 'outcome') return outcomeColor(v as SessionSummary['outcome']);
    if (colorBy === 'agent') return series(v === 'claude' ? 1 : 0);
    const i = slots.get(v);
    return series(i === undefined ? -1 : i);
  };

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const todayIdx = Math.floor((now - weekStart) / DAY);

  return (
    <div className="cal">
      <div className="cal-head">
        <button className="btn icon ghost" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label={t('cal.prev')} title={t('cal.prev')}>
          ‹
        </button>
        <b className="num">
          {shortDay(weekStart, lang)} – {shortDay(addDays(weekStart, 6), lang)}
        </b>
        <button className="btn icon ghost" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label={t('cal.next')} title={t('cal.next')}>
          ›
        </button>
        <button className="btn" onClick={() => setWeekStart(startOfWeek(Date.now()))} disabled={weekStart === startOfWeek(now)}>
          {t('cal.thisWeek')}
        </button>
        <span className="muted">{t('cal.sessionsInWeek', { n: weekSessions.length })}</span>
        <span className="spacer" />
        <label className="field">
          {t('cal.colorBy')}
          <select className="sel" value={colorBy} onChange={(e) => setColorBy(e.target.value as ColorDim)}>
            {DIMS.map((d) => (
              <option key={d} value={d}>
                {t(`cal.color.${d}` as Key)}
              </option>
            ))}
          </select>
        </label>
        <span className="sep" />
        <div className="zoom" role="group" aria-label={t('cal.zoomReset')}>
          <button className="btn icon" onClick={() => setHourPx((h) => Math.max(14, h / 1.25))} aria-label={t('cal.zoomOut')} title={t('cal.zoomOut')}>
            −
          </button>
          <button className="btn num" onClick={() => setHourPx(36)} title={t('cal.zoomReset')}>
            {Math.round((hourPx / 36) * 100)}%
          </button>
          <button className="btn icon" onClick={() => setHourPx((h) => Math.min(180, h * 1.25))} aria-label={t('cal.zoomIn')} title={t('cal.zoomIn')}>
            +
          </button>
        </div>
      </div>
      <div className="legend">
        {legend.map(([v, n]) => (
          <span key={v || '(none)'}>
            <i className="sw" style={{ background: legendColor(v) }} />
            {legendLabel(v)} <b className="num">{n}</b>
          </span>
        ))}
        <span className="hint" title={t('cal.hint')} aria-label={t('cal.hint')}>
          ?
        </span>
      </div>
      <div className="cal-days">
        <div />
        {days.map((d, i) => (
          <div key={d} className={i === todayIdx ? 'today' : ''}>
            {day(d, lang)}
          </div>
        ))}
      </div>
      <div className="cal-scroll" ref={scrollRef}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${t('sessions.calendar')} ${shortDay(weekStart, lang)}`}
          onMouseMove={(e) => {
            const s = hitAt(e);
            if (!s) {
              if (hover) setHover(null);
              return;
            }
            setHover({ s, x: e.clientX, y: e.clientY });
          }}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            const s = hitAt(e);
            if (s) onSelect(s.id);
          }}
          style={{ cursor: hover ? 'pointer' : 'default' }}
        />
      </div>
      {hover && (
        <div className="cal-tip" style={{ left: Math.min(hover.x + 14, window.innerWidth - 330), top: Math.min(hover.y + 14, window.innerHeight - 140) }}>
          <div className="t">{hover.s.title || hover.s.sessionId}</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '3px 0' }}>
            <StatusBadge s={hover.s} />
            <span className="muted">{hover.s.project}</span>
          </div>
          <div className="num">
            {dateTime(hover.s.start, lang)} – {time(hover.s.end, lang)} · {duration(hover.s.end - hover.s.start, lang)}
          </div>
          <div className="num muted">
            {t('detail.inputs', { n: hover.s.userInputs })} · {money(hover.s.totalCostUSD ?? hover.s.costUSD, lang)}
            {hover.s.commits ? ` · ${t('out.commits', { n: hover.s.commits })}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}
