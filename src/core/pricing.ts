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

/** OpenAI rates; without a separate cache-write price, writes cost the same as input. */
function openai(input: number, cacheRead: number, output: number, cacheWrite = input): Price {
  return { input, output, cacheRead, cacheWrite5m: cacheWrite, cacheWrite1h: cacheWrite };
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
  // OpenAI list prices, short context (developers.openai.com/api/docs/pricing, 2026-10)
  { match: /gpt-6-astra/, price: openai(10, 1, 50, 12.5) },
  { match: /gpt-6\.1-sol/, price: openai(2, 0.1, 10, 2.5) },
  { match: /gpt-6-sol/, price: openai(2, 0.2, 10, 2.5) },
  { match: /gpt-6-luna/, price: openai(0.1, 0.01, 0.5, 0.125) },
  { match: /gpt-5\.6-sol/, price: openai(4, 0.4, 20, 5) },
  { match: /gpt-5\.6-terra/, price: openai(2, 0.2, 12, 2.5) },
  { match: /gpt-5\.6-luna/, price: openai(0.2, 0.02, 1.2, 0.25) },
  { match: /gpt-5\.5-pro/, price: openai(30, 30, 180) },
  { match: /mini/, price: openai(0.25, 0.025, 2) }, // estimate
  { match: /gpt-5\.5/, price: openai(5, 0.5, 30) },
  { match: /gpt-5\.4/, price: openai(2.5, 0.25, 15) },
  { match: /gpt-5\.3-codex/, price: openai(1.75, 0.175, 14) },
  // Other models seen through Claude Code or Codex (official list prices, 2026-10)
  { match: /glm-?5\.?3-?flashx/, price: { input: 0.37, output: 1.25, cacheRead: 0.075, cacheWrite5m: 0.37, cacheWrite1h: 0.37 } }, // docs.z.ai
  { match: /glm-?5\.?3-?flash/, price: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite5m: 0.15, cacheWrite1h: 0.15 } },
  { match: /glm-?5\.?[23]/, price: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite5m: 1.4, cacheWrite1h: 1.4 } },
  { match: /deepseek.*pro/, price: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite5m: 1.32, cacheWrite1h: 1.32 } }, // peak rate; off-peak is half
  { match: /deepseek/, price: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite5m: 0.3, cacheWrite1h: 0.3 } },
  { match: /kimi[-/]?k3|(^|\/)k3(-|$)/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3, cacheWrite1h: 6 } }, // platform.kimi.ai
  { match: /mimo.*pro-ultraspeed/, price: { input: 4.35, output: 8.7, cacheRead: 0.036, cacheWrite5m: 4.35, cacheWrite1h: 4.35 } }, // mimo.mi.com
  { match: /mimo.*pro/, price: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite5m: 0.435, cacheWrite1h: 0.435 } },
  { match: /mimo.*flash/, price: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite5m: 0.14, cacheWrite1h: 0.14 } },
  // Other OpenAI / Codex models without a published price (e.g. codex-auto-review): estimate
  { match: /gpt|codex|o\d/, price: openai(1.25, 0.125, 10) },
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
  if (/\[1m\]|fable|mythos|(opus|sonnet)-5/.test(m)) return 1_000_000;
  return 200_000;
}
