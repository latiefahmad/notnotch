import { toBase, type Rates } from "../trading/portfolio.ts";

/**
 * `amount` of `from` in `to`. ECB rates are units per one base, so two other currencies cross through the base;
 * null when either has no rate.
 */
export function convertMoney(amount: number, from: string, to: string, rates: Rates): number | null {
  const inBase = toBase(amount, from, rates);
  const c = to.toUpperCase();
  if (inBase === null) return null;
  if (c === rates.base) return inBase;
  const r = rates.fx[c];
  return r > 0 ? inBase * r : null;
}

/** The currencies the rates cover, the base included, sorted. */
export const currencies = (rates: Rates): string[] => [...new Set([rates.base, ...Object.keys(rates.fx)])].sort();
