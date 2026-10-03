import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { isDark } from '../colors';
import { useThemeVersion } from './common';

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(480);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * p;
}

/** Rounded top only (data end), flat at the baseline. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="chart-legend">
      {series.map((s) => (
        <span key={s.key}>
          <i style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function BarChart({
  labels,
  series,
  mode = 'stack',
  format,
  height = 180,
  tooltipTitle,
}: {
  labels: string[];
  series: Series[];
  mode?: 'stack' | 'group';
  format: (v: number) => string;
  height?: number;
  tooltipTitle?: (i: number) => string;
}) {
  useThemeVersion();
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const padL = 46;
  const padB = 22;
  const padT = 6;
  const plotW = Math.max(50, width - padL - 4);
  const plotH = height - padB - padT;
  const n = labels.length;
  const totals = labels.map((_, i) => (mode === 'stack' ? series.reduce((s, x) => s + (x.values[i] ?? 0), 0) : Math.max(0, ...series.map((x) => x.values[i] ?? 0))));
  const max = niceMax(Math.max(0, ...totals));
  const slot = plotW / Math.max(1, n);
  const barW = Math.max(2, Math.min(28, slot * 0.7));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 46))));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const bars: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const cx = padL + slot * i + slot / 2;
    if (mode === 'stack') {
      let acc = 0;
      const visible = series.filter((s) => (s.values[i] ?? 0) > 0);
      visible.forEach((s, k) => {
        const v = s.values[i] ?? 0;
        const y0 = y(acc);
        const y1 = y(acc + v);
        acc += v;
        const h = Math.max(0, y0 - y1 - (k > 0 ? 2 : 0));
        if (h <= 0) return;
        const top = k === visible.length - 1;
        bars.push(top ? <path key={`${s.key}-${i}`} d={barPath(cx - barW / 2, y1, barW, h, 4)} fill={s.color} /> : <rect key={`${s.key}-${i}`} x={cx - barW / 2} y={y1} width={barW} height={h} fill={s.color} />);
      });
    } else {
      const gw = Math.max(2, (barW - 2 * (series.length - 1)) / series.length);
      series.forEach((s, k) => {
        const v = s.values[i] ?? 0;
        if (v <= 0) return;
        const x = cx - barW / 2 + k * (gw + 2);
        bars.push(<path key={`${s.key}-${i}`} d={barPath(x, y(v), gw, padT + plotH - y(v), 4)} fill={s.color} />);
      });
    }
  }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg
        className="chart"
        width={width}
        height={height}
        role="img"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const i = Math.floor((e.clientX - rect.left - padL) / slot);
          if (i >= 0 && i < n) setHover({ i, x: e.clientX, y: e.clientY });
          else setHover(null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <g className="grid">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={padL} x2={width} y1={y(v)} y2={y(v)} />
              <text x={padL - 6} y={y(v)} textAnchor="end" dominantBaseline="middle">
                {format(v)}
              </text>
            </g>
          ))}
        </g>
        {hover && <rect x={padL + slot * hover.i} y={padT} width={slot} height={plotH} fill="var(--surface-3)" opacity={0.6} />}
        {bars}
        <line className="base" x1={padL} x2={width} y1={padT + plotH + 0.5} y2={padT + plotH + 0.5} />
        {labels.map((l, i) =>
          i % labelEvery === 0 ? (
            <text key={i} x={padL + slot * i + slot / 2} y={height - 6} textAnchor="middle">
              {l}
            </text>
          ) : null,
        )}
      </svg>
      {hover && (
        <div className="ctip" style={{ left: Math.min(hover.x + 12, window.innerWidth - 200), top: hover.y + 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>{tooltipTitle ? tooltipTitle(hover.i) : labels[hover.i]}</div>
          {series.map((s) => (
            <div className="row2" key={s.key}>
              <span>
                <i className="dot" style={{ background: s.color, marginRight: 5 }} />
                {s.label}
              </span>
              <b className="num">{format(s.values[hover.i] ?? 0)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 7 x 24 heatmap, single-hue sequential ramp. */
export function Heatmap({ grid, rowLabels, unit }: { grid: number[][]; rowLabels: string[]; unit: string }) {
  useThemeVersion();
  const { lang } = useI18n();
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<{ r: number; c: number; x: number; y: number } | null>(null);
  const padL = 40;
  const padB = 18;
  const cell = Math.max(8, Math.min(26, (width - padL) / 24));
  const h = cell * 7 + padB;
  const max = Math.max(1, ...grid.flat());
  // Sequential blue: more activity reads as more ink, on either surface.
  const light = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const ramp = isDark() ? ['#184f95', '#1c5cab', '#256abf', '#3987e5', '#5598e7', '#86b6ef', '#cde2fb'] : light;
  const color = (v: number) => (v <= 0 ? 'var(--surface-3)' : ramp[Math.min(ramp.length - 1, Math.floor((v / max) * (ramp.length - 0.001)))]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg className="chart" width={width} height={h} role="img" onMouseLeave={() => setHover(null)}>
        {grid.map((row, r) => (
          <g key={r}>
            <text x={padL - 6} y={r * cell + cell / 2} textAnchor="end" dominantBaseline="middle">
              {rowLabels[r]}
            </text>
            {row.map((v, c) => (
              <rect
                key={c}
                x={padL + c * cell + 1}
                y={r * cell + 1}
                width={cell - 2}
                height={cell - 2}
                rx={2}
                fill={color(v)}
                stroke={hover && hover.r === r && hover.c === c ? 'var(--ink)' : 'none'}
                onMouseEnter={(e) => setHover({ r, c, x: e.clientX, y: e.clientY })}
              />
            ))}
          </g>
        ))}
        {[0, 3, 6, 9, 12, 15, 18, 21].map((hh) => (
          <text key={hh} x={padL + hh * cell + cell / 2} y={h - 4} textAnchor="middle">
            {String(hh).padStart(2, '0')}
          </text>
        ))}
      </svg>
      {hover && (
        <div className="ctip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <b>
            {rowLabels[hover.r]} {String(hover.c).padStart(2, '0')}:00
          </b>
          <div>
            {new Intl.NumberFormat(lang).format(grid[hover.r][hover.c])} {unit}
          </div>
        </div>
      )}
    </div>
  );
}

export function DataTable({ labels, series, format, firstHeader }: { labels: string[]; series: Series[]; format: (v: number) => string; firstHeader: string }) {
  return (
    <div style={{ maxHeight: 220, overflow: 'auto' }}>
      <table className="grid">
        <thead>
          <tr>
            <th>{firstHeader}</th>
            {series.map((s) => (
              <th key={s.key} className="r">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((l, i) => (
            <tr key={i}>
              <td className="num">{l}</td>
              {series.map((s) => (
                <td key={s.key} className="r">
                  {format(s.values[i] ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
