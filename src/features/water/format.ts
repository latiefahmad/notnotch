import { locale } from "../../i18n";

/** "750 ml", "1.5 L". */
export function formatMl(ml: number): string {
  if (ml < 1000) return `${Math.round(ml)} ml`;
  return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(ml / 1000)} L`;
}
