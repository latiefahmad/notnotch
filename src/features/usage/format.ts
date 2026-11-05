import { locale, t } from "../../i18n";
import type { Totals } from "./tokens";

const formats = new Map<string, Intl.NumberFormat>();
// Keyed by locale too, so a formatter made for one language is never reused for another.
const format = (name: string, make: () => Intl.NumberFormat) => {
  const key = `${locale()}|${name}`;
  let f = formats.get(key);
  if (!f) formats.set(key, (f = make()));
  return f;
};

/** "1.2M", "830K". */
export const formatTokens = (n: number) => format("tokens", () => new Intl.NumberFormat(locale(), { notation: "compact", maximumFractionDigits: 1 })).format(n);

/** "$3.40", "¥42.15": the short symbol, since the currency is clear from the card. */
export const formatAmount = (n: number, currency = "USD") =>
  format(currency, () => new Intl.NumberFormat(locale(), { style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 })).format(n);

/** "$3.40", "$3.40+" when some models have no price, "no price" when none has. */
export function formatCost(x: Totals): string {
  if (x.tokens > 0 && x.unpriced === x.tokens) return t("ohne Preis");
  return formatAmount(x.cost) + (x.unpriced > 0 ? "+" : "");
}
