// Categorical palette (fixed order, validated for CVD separation) and status colors.
// Colors are assigned to entities by a stable order, never by their rank in a filtered view.

import type { LiveStatus, Outcome, SessionSummary } from '../../src/shared/types';

export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const OTHER = { light: '#a8a7a1', dark: '#6b6a64' };

export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };

export function isDark(): boolean {
  return document.documentElement.dataset.resolvedTheme === 'dark';
}

export function series(i: number): string {
  const arr = isDark() ? SERIES_DARK : SERIES_LIGHT;
  return i < 0 || i >= arr.length ? (isDark() ? OTHER.dark : OTHER.light) : arr[i];
}

/** Agents keep fixed slots: Claude orange, Codex blue, Pi green. */
const AGENT_SLOT: Record<string, number> = { claude: 1, codex: 0, pi: 2 };

export function agentColor(agent: string): string {
  const slot = AGENT_SLOT[agent];
  return series(slot === undefined ? -1 : slot);
}

export function outcomeColor(o: Outcome | LiveStatus): string {
  switch (o) {
    case 'done':
      return STATUS.good;
    case 'leftover':
      return STATUS.warning;
    case 'needs_input':
      return series(6);
    case 'abandoned':
      return STATUS.serious;
    case 'running':
      return series(0);
    case 'stalled':
      return STATUS.critical;
    default:
      return isDark() ? OTHER.dark : OTHER.light;
  }
}

export type ColorDim = 'outcome' | 'agent' | 'project' | 'category' | 'model';

export function dimValue(s: SessionSummary, dim: ColorDim): string {
  switch (dim) {
    case 'outcome':
      return s.status === 'running' || s.status === 'stalled' || s.status === 'needs_input' ? s.status : s.outcome;
    case 'agent':
      return s.agent;
    case 'project':
      return s.project || '';
    case 'category':
      return s.category ?? '';
    case 'model':
      return s.models[s.models.length - 1] ?? '';
  }
}

/**
 * Stable color slots for a dimension: the 7 values with the most sessions overall get
 * slots 0..6 (ordered by name so they never reshuffle when counts shift), the rest are "Other".
 */
export function slotMap(all: SessionSummary[], dim: ColorDim, order?: string[]): Map<string, number> {
  // Categories come in a fixed order from the server, so each keeps its color.
  if (order?.length) return new Map(order.slice(0, 8).map((k, i) => [k, i]));
  const counts = new Map<string, number>();
  for (const s of all) {
    const v = dimValue(s, dim);
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([k]) => k)
    .sort((a, b) => a.localeCompare(b));
  return new Map(top.map((k, i) => [k, i]));
}

export const OTHER_KEY = '\u0000other';

/** Legend rows: values without a color slot share one "Other" row (last), the rest by count. */
export function legendEntries(sessions: SessionSummary[], dim: ColorDim, slots: Map<string, number>): [string, number][] {
  const fold = dim !== 'outcome' && dim !== 'agent';
  const counts = new Map<string, number>();
  for (const s of sessions) {
    let v = dimValue(s, dim);
    if (fold && v && !slots.has(v)) v = OTHER_KEY;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (a[0] === OTHER_KEY ? 1 : b[0] === OTHER_KEY ? -1 : b[1] - a[1]));
}

export function colorFor(s: SessionSummary, dim: ColorDim, slots: Map<string, number>): string {
  if (dim === 'outcome') return outcomeColor(dimValue(s, dim) as Outcome);
  if (dim === 'agent') return agentColor(s.agent);
  const v = dimValue(s, dim);
  const i = slots.get(v);
  return series(i === undefined ? -1 : i);
}
