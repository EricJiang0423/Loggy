import type { UsageMeter } from '../../../src/shared/types';
import { agentColor, STATUS } from '../colors';
import { future, pct, relative } from '../format';
import { useI18n } from '../i18n';
import { useStore } from '../store';

function levelColor(p: number): string {
  if (p >= 90) return STATUS.critical;
  if (p >= 70) return STATUS.warning;
  return STATUS.good;
}

/** Minutes until 100% at the pace of the last hour, if rising. */
function eta(history: [number, number][], now: number): number | undefined {
  const recent = history.filter(([t]) => now - t < 3600_000);
  if (recent.length < 2) return undefined;
  const [t0, p0] = recent[0];
  const [t1, p1] = recent[recent.length - 1];
  if (p1 <= p0 || t1 <= t0) return undefined;
  const rate = (p1 - p0) / (t1 - t0);
  return t1 + (100 - p1) / rate;
}

export function Sparkline({ points, width = 56, height = 18, color }: { points: [number, number][]; width?: number; height?: number; color: string }) {
  if (points.length < 2) return <svg width={width} height={height} aria-hidden />;
  const t0 = points[0][0];
  const t1 = points[points.length - 1][0];
  const span = Math.max(1, t1 - t0);
  const d = points
    .map(([t, p], i) => `${i ? 'L' : 'M'}${(((t - t0) / span) * (width - 2) + 1).toFixed(1)},${(height - 1 - (Math.min(100, p) / 100) * (height - 2)).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={width} height={height} aria-hidden style={{ display: 'block' }}>
      <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--axis)" strokeWidth={1} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

function Bar({ value }: { value: number | undefined }) {
  const v = value ?? 0;
  return (
    <div className="meter-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)}>
      <div style={{ width: `${Math.min(100, Math.max(value === undefined ? 0 : 2, v))}%`, background: levelColor(v) }} />
    </div>
  );
}

function Meter({ m, onSetup }: { m: UsageMeter; onSetup: () => void }) {
  const { t, lang } = useI18n();
  const now = useStore((s) => s.now);
  const name = m.agent === 'claude' ? 'Claude' : m.label === 'codex' ? 'Codex' : `Codex · ${m.label}`;
  const five = m.fiveHour?.usedPercent;
  const seven = m.sevenDay?.usedPercent;
  const fiveEta = eta(m.history, now);
  const hasBars = five !== undefined || seven !== undefined;
  return (
    <div className="meter" tabIndex={0} aria-label={`${name} ${t('usage.title')}`}>
      <span className="meter-name">
        <span className="dot" style={{ background: agentColor(m.agent) }} />
        {name}
      </span>
      {hasBars ? (
        <div className="meter-bars num">
          <span className="muted">{t('usage.5h')}</span>
          <Bar value={five} />
          <span>{five === undefined ? '–' : pct(five, lang)}</span>
          <span className="muted">{t('usage.7d')}</span>
          <Bar value={seven} />
          <span>{seven === undefined ? '–' : pct(seven, lang)}</span>
        </div>
      ) : (
        <span className="muted">{m.status ? t('usage.status', { s: m.status }) : t('usage.none')}</span>
      )}
      {m.history.length > 1 && <Sparkline points={m.history} color={agentColor(m.agent)} />}
      <div className="tip" role="tooltip">
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {name} · {t('usage.title')}
        </div>
        {m.fiveHour && (
          <div>
            {t('usage.5h')}: <b>{pct(m.fiveHour.usedPercent, lang)}</b>
            {m.fiveHour.resetsAt ? ` · ${t('usage.resets', { t: future(m.fiveHour.resetsAt, lang, now) })}` : ''}
          </div>
        )}
        {m.sevenDay && (
          <div>
            {t('usage.7d')}: <b>{pct(m.sevenDay.usedPercent, lang)}</b>
            {m.sevenDay.resetsAt ? ` · ${t('usage.resets', { t: future(m.sevenDay.resetsAt, lang, now) })}` : ''}
          </div>
        )}
        {fiveEta && fiveEta - now < 5 * 3600_000 && <div className="err">{t('usage.eta', { t: future(fiveEta, lang, now) })}</div>}
        {m.status && <div className="muted">{t('usage.status', { s: m.status })}{m.quotaType ? ` (${m.quotaType})` : ''}</div>}
        <div className="muted">{relative(m.ts, lang, now)}</div>
        {m.agent === 'claude' && !hasBars && (
          <button className="btn" style={{ marginTop: 6 }} onClick={onSetup}>
            {t('usage.setup')}
          </button>
        )}
      </div>
    </div>
  );
}

export function UsageMeters({ onSetup }: { onSetup: () => void }) {
  const meters = useStore((s) => s.meters);
  if (!meters.length) return null;
  return (
    <div className="meters">
      {meters.map((m) => (
        <Meter key={`${m.agent}:${m.label}`} m={m} onSetup={onSetup} />
      ))}
    </div>
  );
}
