// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/MonitorFormat.cs.
// Number formatting for the Hardware tool and the closed row's readings. Numbers and units come apart because the
// tool draws units smaller and lighter than their numbers. Pure, so it is tested without the app.

export interface Quantity { n: string; unit: string }

const one = (v: number) => v.toFixed(1);
const whole = (v: number) => String(Math.round(v));
const finite = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);

/** Bytes per second as KB/s below 1 MB/s, then MB/s, then GB/s (decimal units, as Task Manager). */
export function rate(bytesPerSecond: number): Quantity {
  const v = finite(bytesPerSecond);
  if (v >= 999_500_000) return { n: one(v / 1e9), unit: "GB/s" };
  if (v >= 999_500) return { n: one(v / 1e6), unit: "MB/s" };
  return { n: whole(v / 1000), unit: "KB/s" };
}

/** At most three digits and one letter for the closed row: "84K", "1.2M", "120M". One decimal only under 10, so the widest is "999M". */
export function compactRate(bytesPerSecond: number): string {
  const v = finite(bytesPerSecond);
  const short = (x: number) => (x < 9.95 ? one(x) : whole(x));
  if (v >= 999_500_000) return short(v / 1e9) + "G";
  if (v >= 999_500) return short(v / 1e6) + "M";
  return whole(v / 1000) + "K";
}

/** The widest figures each closed-row reading can show, for the room it reserves. */
export const WIDEST = { rate: "888M", watts: "~888W", percent: "100%", temp: "188°" } as const;

/** Watts with one decimal under 100, whole from there: "38.2", "112". */
export const watts = (w: number) => (finite(w) < 99.95 ? one(finite(w)) : whole(finite(w)));

/** Whole watts from 10 on, one decimal under, at most 999: "8.4", "38". */
export const compactWatts = (w: number) => (finite(w) < 9.95 ? one(finite(w)) : whole(Math.min(finite(w), 999)));

/** "4.21" GHz from MHz. */
export const ghz = (mhz: number) => (finite(mhz) / 1000).toFixed(2);

/** Process memory: "512M" below 1000 MB, "4.1G" from there. */
export function processMemory(bytes: number): string {
  const mb = finite(bytes) / 1_048_576;
  return mb >= 999.5 ? one(mb / 1024) + "G" : whole(mb) + "M";
}

/** A process's CPU (percent of one core) as a share of the whole machine; one decimal under 10 so a small busy process does not read 0, at most 100. */
export function processShare(percentOfOneCore: number, cores: number): string {
  const v = Math.min(100, finite(percentOfOneCore) / Math.max(cores, 1));
  return v < 9.95 ? one(v) : whole(v);
}

/** Gigabytes with one decimal: "12.4". */
export const gigabytes = (bytes: number) => one(finite(bytes) / 1024 ** 3);

/** A time in the two largest units that apply: "3 h 12 min", "12 min", "< 1 min". */
export function duration(minutes: number): string {
  const m = Math.round(finite(minutes));
  if (m < 1) return "< 1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/** A drive's figures in one unit chosen by its size: whole GB from 10 GB, or TB with one decimal from 1000 GB. */
export function driveSizes(used: number, total: number): { used: string; total: string; unit: "GB" | "TB" } {
  const tb = total / 1024 ** 3 >= 999.5;
  const scale = tb ? 1024 ** 4 : 1024 ** 3;
  const fig = (b: number) => (tb || b / scale < 9.95 ? one(b / scale) : whole(b / scale));
  return { used: fig(finite(used)), total: fig(finite(total)), unit: tb ? "TB" : "GB" };
}
