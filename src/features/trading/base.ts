import { settings, updateSettings } from "../../settings/store";
import { BASES, baseForRegion } from "./portfolio";

/*
 * Base currency. Until one is stored (picked in Settings or adopted from Trading 212), the
 * region of the WebView's language (navigator.language, e.g. "en-GB" → GBP) decides. An
 * upgrade from the Trading 212-only version adopts that account's currency on the first fetch,
 * so its history carries over.
 */

export function regionBase(): string {
  try {
    return baseForRegion(new Intl.Locale(navigator.language || "en-US").maximize().region ?? "");
  } catch {
    return "EUR";
  }
}

export function effectiveBase(stored: string): string {
  return stored || regionBase();
}

/** Stores `currency` as the base if none is stored yet. Returns true when it did. */
export function adoptBase(currency: string | null | undefined): boolean {
  const c = currency?.toUpperCase();
  if (settings.get().trading.base || !c || !(BASES as readonly string[]).includes(c)) return false;
  updateSettings((s) => ({ trading: { ...s.trading, base: c } }));
  return true;
}
