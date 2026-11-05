/**
 * A typed number in either convention: "1,000.50", "1.234,5", "1,5" or "1 000". With both marks the last one is the
 * decimal; a lone comma before exactly three digits groups thousands ("1,000", as the English interface writes it),
 * any other lone comma is the decimal ("1,5", "0,500"). null when nothing readable is left.
 */
export function parseAmount(input: string): number | null {
  let s = input.replace(/[\s  ']/g, "");
  if (!/\d/.test(s) || !/^-?[\d.,]+$/.test(s)) return null;
  const count = (c: string) => s.split(c).length - 1;
  const dots = count("."), commas = count(",");
  if (dots && commas) {
    const decimal = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    if (count(decimal) > 1) return null;
    s = s.replaceAll(decimal === "." ? "," : ".", "").replace(decimal, ".");
  } else if (commas > 1 || dots > 1) {
    s = s.replaceAll(commas ? "," : ".", "");
  } else if (commas) {
    const [whole, part] = s.split(",");
    s = part.length === 3 && !/^-?0?$/.test(whole) ? whole + part : `${whole}.${part}`;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
