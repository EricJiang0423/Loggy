// API-equivalent price estimates in USD per million tokens. Subscription users are not
// billed per token; these numbers show what the same usage would cost on the API.
// Users can override or extend the table with ~/.loggy/pricing.json.

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write; defaults to 1.25x input. */
  cacheWrite5m?: number;
  /** 1-hour cache write; defaults to 2x input. */
  cacheWrite1h?: number;
}

interface Rule {
  match: RegExp;
  price: Price;
}

const RULES: Rule[] = [
  // Claude (Anthropic first-party rates)
  { match: /fable-5-1|mythos-5-1/, price: { input: 10, output: 50, cacheRead: 0.25 } },
  { match: /fable|mythos/, price: { input: 10, output: 50, cacheRead: 1 } },
  { match: /opus-5-5/, price: { input: 4, output: 20, cacheRead: 0.2 } },
  { match: /opus-(5|4-[5-9])/, price: { input: 5, output: 25, cacheRead: 0.5 } },
  { match: /opus/, price: { input: 15, output: 75, cacheRead: 1.5 } },
  { match: /sonnet-5/, price: { input: 2, output: 10, cacheRead: 0.2 } },
  { match: /sonnet/, price: { input: 3, output: 15, cacheRead: 0.3 } },
  { match: /haiku-4/, price: { input: 1, output: 5, cacheRead: 0.1 } },
  { match: /haiku/, price: { input: 0.8, output: 4, cacheRead: 0.08 } },
  // OpenAI / Codex (estimates; override in pricing.json for exact rates)
  { match: /mini/, price: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite5m: 0.25, cacheWrite1h: 0.25 } },
  { match: /gpt|codex|o\d/, price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 1.25, cacheWrite1h: 1.25 } },
];

const FALLBACK: Price = { input: 3, output: 15, cacheRead: 0.3 };

let overrides: Record<string, Price> = {};
const cache = new Map<string, Price>();

export function setPriceOverrides(table: Record<string, Price>): void {
  overrides = table;
  cache.clear();
}

export function priceFor(model: string | undefined): Price {
  const key = (model ?? '').toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  let price = FALLBACK;
  const exact = Object.entries(overrides).find(([k]) => k.toLowerCase() === key);
  if (exact) price = exact[1];
  else {
    const prefix = Object.entries(overrides).find(([k]) => key.includes(k.toLowerCase()));
    if (prefix) price = prefix[1];
    else price = RULES.find((r) => r.match.test(key))?.price ?? FALLBACK;
  }
  cache.set(key, price);
  return price;
}

export interface UsageForCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export function costOf(model: string | undefined, u: UsageForCost): number {
  const p = priceFor(model);
  const w5 = p.cacheWrite5m ?? p.input * 1.25;
  const w1 = p.cacheWrite1h ?? p.input * 2;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite5m * w5 + u.cacheWrite1h * w1) / 1e6;
}

/** Context window guess when the log does not state one. */
export function contextWindowFor(model: string | undefined, observedMax: number): number {
  const m = (model ?? '').toLowerCase();
  if (observedMax > 200_000) return 1_000_000;
  if (/haiku|claude-3/.test(m)) return 200_000;
  if (/\[1m\]/.test(m)) return 1_000_000;
  return 200_000;
}
