// The AI usage cards: which sources exist, their order and names, and the prices set by hand. Pure, so the settings store can normalise saved data.
import type { UsageId } from "../../platform/services";
import { normalizeModel, validPrices, type Prices } from "./pricing.ts";

const ALL: Record<UsageId, true> = { claude: true, codex: true, gemini: true, cursor: true, openrouter: true, deepseek: true, zai: true };
/** Every source in its default order. */
export const USAGE_IDS = Object.keys(ALL) as UsageId[];

export interface UsageCards {
  /** Order of the cards (and rings); every id once. Which are shown is `settings.usage`. */
  order: UsageId[];
  /** Names typed by the user; missing = the brand name. */
  names: Partial<Record<UsageId, string>>;
  /** Prices set by hand, by normalised model id, USD per million tokens. */
  prices: Record<string, Prices>;
}

export const USAGE_CARDS_DEFAULTS: UsageCards = { order: [...USAGE_IDS], names: {}, prices: {} };

export const NAME_MAX = 32;

/** Saved data from any older version → a valid value: unknown ids dropped, missing ones appended, bad names and prices removed. */
export function normalizeCards(saved: Partial<UsageCards> | null | undefined): UsageCards {
  const known = new Set<string>(USAGE_IDS);
  const order = [...new Set((Array.isArray(saved?.order) ? saved.order : []).filter((id) => known.has(id)))];
  for (const id of USAGE_IDS) if (!order.includes(id)) order.push(id);
  const names: UsageCards["names"] = {};
  for (const [id, name] of Object.entries(saved?.names ?? {})) {
    if (known.has(id) && typeof name === "string" && name.trim()) names[id as UsageId] = name.trim().slice(0, NAME_MAX);
  }
  const prices: UsageCards["prices"] = {};
  for (const [model, p] of Object.entries(saved?.prices ?? {})) if (model.trim() && validPrices(p)) prices[normalizeModel(model)] = p;
  return { order, names, prices };
}

/** The enabled sources in card order. */
export function shownIds(order: UsageId[], enabled: Partial<Record<UsageId, boolean>>): UsageId[] {
  return order.filter((id) => enabled[id]);
}
