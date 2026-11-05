// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/Pricing.cs (Normalize, Find, Estimate, Effective).
// Cost of logged tokens from a built-in list-price table, with prices set by hand winning. BrimDeck fetches a remote catalog; NotNotch keeps a
// fixed table so nothing leaves the PC, and a model missing from it stays unpriced until the user sets a price.

/** USD per million tokens. Missing cache prices follow the usual rule: read 0.1x, write 1.25x, one-hour write 2x the input price. */
export interface Prices { input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number }

/** A table entry; `above` applies to buckets whose prompt band is at least `band` (1: over 100K prompt tokens, 2: over 200K). */
export interface ModelPrices extends Prices { above?: { band: number; prices: Prices } }

export interface TokenCounts { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }

const same = (ids: string[], p: ModelPrices) => Object.fromEntries(ids.map((id) => [id, p]));

/**
 * List prices as published by the makers. Codex used with a ChatGPT plan has no per-token bill, so its figure is what the same tokens would
 * cost on the API.
 * - Anthropic: checked 2026-10-31 against https://platform.claude.com/docs/en/about-claude/pricing (model table of 2026-10-06), cache
 *   multipliers from the prompt caching page. Opus 4.1 / 4 and the Claude 3.x entries are the older published prices.
 * - OpenAI: https://openai.com/api/pricing/, only the GPT-5, 5.1 and 5.2 models whose prices were known when this table was written; later
 *   GPT models are left out on purpose and stay unpriced until set by hand. Check them again when a newer Codex model shows up.
 */
export const PRICES: Record<string, ModelPrices> = {
  ...same(["claude-fable-5-1", "claude-mythos-5-1"], { input: 10, output: 50, cacheRead: 0.25 }),
  ...same(["claude-fable-5", "claude-mythos-5"], { input: 10, output: 50, cacheRead: 1 }),
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  ...same(["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"], { input: 5, output: 25 }),
  ...same(["claude-opus-4-1", "claude-opus-4"], { input: 15, output: 75 }),
  ...same(["claude-sonnet-5-5", "claude-sonnet-5"], { input: 2, output: 10, cacheRead: 0.2 }),
  "claude-sonnet-4-6": { input: 3, output: 15 },
  ...same(["claude-sonnet-4-5", "claude-sonnet-4"], { input: 3, output: 15, above: { band: 2, prices: { input: 6, output: 22.5 } } }),
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, above: { band: 1, prices: { input: 0.5, output: 2.5 } } },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  ...same(["gpt-5", "gpt-5-codex", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max"], { input: 1.25, output: 10, cacheRead: 0.125 }),
  ...same(["gpt-5-mini", "gpt-5.1-codex-mini"], { input: 0.25, output: 2, cacheRead: 0.025 }),
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005 },
  ...same(["gpt-5.2", "gpt-5.2-codex"], { input: 1.75, output: 14, cacheRead: 0.175 }),
};

/** One spelling per model: lower case, no vendor prefix, no dated snapshot, no context tag; Claude versions with "-" ("4.6" → "4-6"). */
export function normalizeModel(model: string): string {
  let m = model.trim().toLowerCase().replace(/^(anthropic|openai)\//, "").replace(/\[[^\]]*\]$/, "");
  if (m.startsWith("claude-")) m = m.replace(/(\d)\.(?=\d)/g, "$1-");
  return m.replace(/-\d{8}$/, "");
}

/** The prices for a model: set by hand first, then the table; null when unknown. */
export function findPrices(model: string, manual: Record<string, Prices>): { prices: ModelPrices; manual: boolean } | null {
  const key = normalizeModel(model);
  if (manual[key]) return { prices: manual[key], manual: true };
  return PRICES[key] ? { prices: PRICES[key], manual: false } : null;
}

/** The prices that apply to one bucket, with missing cache prices filled in. */
export function effective(p: ModelPrices, band: number): Required<Prices> {
  const tier: Prices = p.above && band >= p.above.band ? p.above.prices : p;
  return {
    input: tier.input,
    output: tier.output,
    cacheRead: tier.cacheRead ?? tier.input * 0.1,
    cacheWrite: tier.cacheWrite ?? tier.input * 1.25,
    cacheWrite1h: tier.cacheWrite1h ?? tier.input * 2,
  };
}

/** USD for these tokens, or null when the model has no price. */
export function cost(model: string, band: number, t: TokenCounts, manual: Record<string, Prices>): number | null {
  const found = findPrices(model, manual);
  if (!found) return null;
  const p = effective(found.prices, band);
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite + t.cacheWrite1h * p.cacheWrite1h) / 1e6;
}

/** A price typed by hand is valid when input and output are set and nothing is negative or absurd. */
export function validPrices(p: Partial<Prices> | null | undefined): p is Prices {
  const ok = (v: unknown, required: boolean) => (v === undefined ? !required : typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10_000);
  return !!p && ok(p.input, true) && ok(p.output, true) && ok(p.cacheRead, false) && ok(p.cacheWrite, false) && ok(p.cacheWrite1h, false);
}
