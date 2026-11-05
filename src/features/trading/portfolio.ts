/*
 * Portfolio maths, pure: currency conversion, average cost from trades, values and P&L per
 * account and in total. The Rust providers deliver accounts in the shape below; prices come
 * from `Rates` (CoinGecko for coins, ECB rates for currencies).
 *
 * Rules:
 * - A holding's value is the provider's value when it gives one, else quantity × price.
 * - Cash (fiat) has no P&L and is not "invested".
 * - Cost basis: from the provider, from the manual entry, or the average cost of the trades.
 *   Costs in another currency are converted at today's rate (no historic FX).
 * - When trades explain less than the balance (deposits, staking rewards), P&L covers the
 *   explained part only and the line is marked approximate.
 * - Holdings without a price are listed as missing and left out of every total.
 */

export type Kind = "crypto" | "fiat" | "stock";

export interface Holding {
  symbol: string;
  name: string;
  kind: Kind;
  quantity: number;
  price: number | null;
  priceCurrency: string | null;
  value: number | null;
  cost: number | null;
  currency: string | null;
}

export interface Leg {
  asset: string;
  fiat: boolean;
  /** Signed balance change, net of fees. */
  net: number;
}

export interface Trade {
  /** Unix seconds. */
  time: number;
  legs: Leg[];
}

export interface Money {
  amount: number;
  currency: string;
}

export interface Account {
  holdings: Holding[];
  trades: Trade[];
  realized: Money | null;
  partial: boolean;
  warning: string | null;
}

export interface Rates {
  base: string;
  /** Price of one coin in `base`. */
  crypto: Record<string, number>;
  /** Units of a currency per one `base`. */
  fx: Record<string, number>;
  /** The ECB day `fx` is from ("2026-10-31"); null until rates arrived once. */
  date?: string | null;
  failed: string[];
}

export interface Line {
  symbol: string;
  name: string;
  kind: Kind;
  quantity: number;
  /** Per unit, in base currency. */
  price: number | null;
  value: number | null;
  cost: number | null;
  pnl: number | null;
  /** P&L covers only the part of the balance that trades explain. */
  approx: boolean;
}

export interface Totals {
  value: number;
  cash: number;
  invested: number;
  unrealized: number;
  realized: number;
  /** Value of positions without a cost basis: not in P&L, but its change counts for "today". */
  noCost: number;
}

export interface Summary extends Totals {
  /** Positions (cash is only in `cash`), largest first. */
  lines: Line[];
  /** Symbols without a price, left out of the totals. */
  missing: string[];
  partial: boolean;
}

/** Base currencies offered (supported by both price sources). */
export const BASES = ["EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "CZK"] as const;

const regionBase: Record<string, string> = {
  US: "USD", GB: "GBP", CH: "CHF", LI: "CHF", JP: "JPY", CA: "CAD", AU: "AUD", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK",
};

/** Default base currency for a region code ("GB" → GBP); the euro otherwise. */
export function baseForRegion(region: string): string {
  return regionBase[region.toUpperCase()] ?? "EUR";
}

export function toBase(amount: number, currency: string, rates: Rates): number | null {
  const c = currency.toUpperCase();
  if (c === rates.base) return amount;
  const r = rates.fx[c];
  return r > 0 ? amount / r : null;
}

export interface Basis {
  quantity: number;
  cost: number;
}

/**
 * Average cost per coin from trades (in base currency), in time order.
 * - One coin leg and fiat legs: a buy (coin up) adds quantity and the fiat paid; a sell
 *   removes the average cost of the coins sold and realizes proceeds minus that cost.
 * - Two coin legs (one down, one up): the cost basis moves from the sold coin to the bought one.
 * - Sells of coins no trade bought, and trades in a currency without a rate, are skipped and counted.
 */
export function averageCost(trades: Trade[], rates: Rates): { basis: Record<string, Basis>; realized: number; skipped: number } {
  const basis: Record<string, Basis> = {};
  let realized = 0;
  let skipped = 0;
  const pos = (asset: string) => (basis[asset] ??= { quantity: 0, cost: 0 });
  /** Takes `qty` coins out of a position and returns their cost (null if there are none). */
  const take = (asset: string, qty: number): number | null => {
    const p = basis[asset];
    if (!p || p.quantity <= 0) return null;
    const f = Math.min(1, qty / p.quantity);
    const out = p.cost * f;
    p.cost -= out;
    p.quantity = Math.max(0, p.quantity - qty);
    return out;
  };

  for (const trade of [...trades].sort((a, b) => a.time - b.time)) {
    const coins = trade.legs.filter((l) => !l.fiat && l.net !== 0);
    const fiat = trade.legs.filter((l) => l.fiat);
    let fiatNet = 0;
    let priced = true;
    for (const l of fiat) {
      const v = toBase(l.net, l.asset, rates);
      if (v === null) priced = false;
      else fiatNet += v;
    }
    if (coins.length === 1 && fiat.length > 0) {
      if (!priced) {
        skipped++;
        continue;
      }
      const c = coins[0];
      if (c.net > 0) {
        const p = pos(c.asset);
        p.quantity += c.net;
        p.cost += Math.max(0, -fiatNet);
      } else {
        const out = take(c.asset, -c.net);
        if (out === null) skipped++;
        else realized += fiatNet - out;
      }
    } else if (coins.length === 2 && fiat.length === 0) {
      const sold = coins.find((l) => l.net < 0);
      const bought = coins.find((l) => l.net > 0);
      if (!sold || !bought) continue;
      const moved = take(sold.asset, -sold.net);
      if (moved === null) {
        skipped++;
        continue;
      }
      const p = pos(bought.asset);
      p.quantity += bought.net;
      p.cost += moved;
    }
    // Fiat-only trades (currency exchange) change no coin position.
  }
  return { basis, realized, skipped };
}

/** One account in base currency. */
export function summarize(account: Account, rates: Rates): Summary {
  const { basis, realized: tradeRealized } = averageCost(account.trades, rates);
  const lines: Line[] = [];
  const missing: string[] = [];
  let cash = 0;
  let noCost = 0;

  for (const h of account.holdings) {
    const value = valueOf(h, rates);
    if (value === null) {
      missing.push(h.symbol);
      if (h.kind !== "fiat") lines.push({ symbol: h.symbol, name: h.name, kind: h.kind, quantity: h.quantity, price: null, value: null, cost: null, pnl: null, approx: false });
      continue;
    }
    if (h.kind === "fiat") {
      cash += value;
      continue;
    }
    let cost: number | null = null;
    let pnl: number | null = null;
    let approx = false;
    const costCurrency = h.currency ?? h.priceCurrency;
    if (h.cost !== null && costCurrency) {
      cost = toBase(h.cost, costCurrency, rates);
      pnl = cost === null ? null : value - cost;
    } else if (basis[h.symbol] && basis[h.symbol].quantity > 0 && h.quantity > 0) {
      const b = basis[h.symbol];
      if (b.quantity >= h.quantity * 0.98) {
        // Coins withdrawn or fees: the rest keeps the average cost per coin.
        cost = (b.cost / b.quantity) * h.quantity;
        pnl = value - cost;
      } else {
        approx = true;
        cost = b.cost;
        pnl = value * (b.quantity / h.quantity) - b.cost;
        noCost += value * (1 - b.quantity / h.quantity);
      }
    }
    if (pnl === null) noCost += value;
    lines.push({ symbol: h.symbol, name: h.name, kind: h.kind, quantity: h.quantity, price: h.quantity ? value / h.quantity : null, value, cost, pnl, approx });
  }
  lines.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));

  const realizedProvider = account.realized ? toBase(account.realized.amount, account.realized.currency, rates) : 0;
  const sum = (f: (l: Line) => number | null) => lines.reduce((s, l) => s + (f(l) ?? 0), 0);
  return {
    lines,
    missing,
    partial: account.partial,
    cash,
    value: sum((l) => l.value) + cash,
    invested: sum((l) => l.cost),
    unrealized: sum((l) => l.pnl),
    realized: (realizedProvider ?? 0) + tradeRealized,
    noCost,
  };
}

function valueOf(h: Holding, rates: Rates): number | null {
  if (h.value !== null && h.currency) {
    const v = toBase(h.value, h.currency, rates);
    if (v !== null) return v;
  }
  if (h.kind === "fiat") return toBase(h.quantity, h.symbol, rates);
  if (h.kind === "crypto" && rates.crypto[h.symbol.toUpperCase()] !== undefined) return rates.crypto[h.symbol.toUpperCase()] * h.quantity;
  if (h.price !== null && h.priceCurrency) return toBase(h.price * h.quantity, h.priceCurrency, rates);
  return null;
}

export function addTotals(list: Totals[]): Totals {
  const t: Totals = { value: 0, cash: 0, invested: 0, unrealized: 0, realized: 0, noCost: 0 };
  for (const x of list) {
    t.value += x.value;
    t.cash += x.cash;
    t.invested += x.invested;
    t.unrealized += x.unrealized;
    t.realized += x.realized;
    t.noCost += x.noCost;
  }
  return t;
}

/**
 * Rates after a refresh: values of a source that failed this time come from the previous
 * rates (same base), so a CoinGecko hiccup does not blank every coin.
 */
export function mergeRates(next: Rates, prev: Rates | null): Rates {
  if (!prev || prev.base !== next.base || !next.failed.length) return next;
  return {
    ...next,
    crypto: next.failed.includes("coingecko") ? { ...prev.crypto, ...next.crypto } : next.crypto,
    fx: next.failed.includes("frankfurter") ? { ...prev.fx, ...next.fx } : next.fx,
  };
}

/** What to ask the price service for: coins without a provider value, and every currency seen. */
export function priceNeeds(accounts: Account[], base: string): { crypto: string[]; fiats: string[] } {
  const crypto = new Set<string>();
  const fiats = new Set<string>();
  for (const a of accounts) {
    for (const h of a.holdings) {
      if (h.kind === "crypto" && (h.value === null || !h.currency)) crypto.add(h.symbol.toUpperCase());
      if (h.kind === "fiat") fiats.add(h.symbol.toUpperCase());
      if (h.currency) fiats.add(h.currency.toUpperCase());
      if (h.priceCurrency) fiats.add(h.priceCurrency.toUpperCase());
    }
    for (const t of a.trades) for (const l of t.legs) if (l.fiat) fiats.add(l.asset.toUpperCase());
    if (a.realized) fiats.add(a.realized.currency.toUpperCase());
  }
  fiats.delete(base.toUpperCase());
  return { crypto: [...crypto].sort(), fiats: [...fiats].sort() };
}

// ---------- Manual portfolio ----------

export interface ManualHolding {
  id: string;
  symbol: string;
  name: string;
  kind: "crypto" | "stock";
  quantity: number;
  /** Total cost basis in `currency`; null = unknown. */
  cost: number | null;
  currency: string;
  /** Stocks and ETFs: price per unit in `currency`, entered by hand. */
  price: number | null;
  /** Local date of the manual price, "YYYY-MM-DD". */
  priceDate: string | null;
}

export function manualAccount(list: ManualHolding[]): Account {
  return {
    holdings: list.map((m) => ({
      symbol: m.symbol.toUpperCase(),
      name: m.name,
      kind: m.kind,
      quantity: m.quantity,
      price: m.kind === "stock" ? m.price : null,
      priceCurrency: m.kind === "stock" && m.price !== null ? m.currency : null,
      value: null,
      cost: m.cost,
      currency: m.currency,
    })),
    trades: [],
    realized: null,
    partial: false,
    warning: null,
  };
}

/** Typed amounts read as in the converter, so "1,000" is a thousand in both. */
export { parseAmount } from "../convert/parse.ts";

// ---------- History ----------

export interface Snapshot {
  date: string;
  value: number;
  invested: number;
  pnl: number;
  /** Missing in files written before it existed. */
  noCost?: number;
}

export interface Point {
  t: number;
  value: number;
  pnl: number;
  noCost?: number;
}

export interface History {
  history: Snapshot[];
  intraday: Point[];
}

/**
 * What "today" and the chart follow: P&L plus the value of positions without a cost basis.
 * P&L ignores deposits and purchases; the second part has no cost, so only its value can move.
 */
export function performance(x: { pnl: number; noCost?: number }): number {
  return x.pnl + (x.noCost ?? 0);
}

export interface DayChange {
  change: number;
  pct: number | null;
  /** Value the percentage refers to (yesterday's, or the first point today). */
  from: number;
  /** null = against yesterday; else since this time today (ms). */
  since: number | null;
}

/**
 * Today = performance now − performance at the end of yesterday (percent of yesterday's value).
 * Without yesterday: since the first point today. Without either: null.
 */
export function todayChange(now: number, h: History): DayChange | null {
  const prev = h.history.length >= 2 ? h.history[h.history.length - 2] : null;
  const first = h.intraday.length >= 2 ? h.intraday[0] : null;
  const ref = prev ?? first;
  if (!ref) return null;
  const change = now - performance(ref);
  return { change, pct: ref.value > 0 ? (change / ref.value) * 100 : null, from: ref.value, since: prev ? null : first!.t };
}

/**
 * The total's "today" from the accounts' own changes, so an account that is new, loading or
 * failing does not show up as a jump. Accounts with a yesterday win; if none has one, the
 * accounts with points today count since the latest of their first points.
 */
export function combineChanges(parts: (DayChange | null)[]): DayChange | null {
  const known = parts.filter((p) => p !== null);
  const daily = known.filter((p) => p.since === null);
  const use = daily.length ? daily : known;
  if (!use.length) return null;
  const change = use.reduce((s, p) => s + p.change, 0);
  const from = use.reduce((s, p) => s + p.from, 0);
  return { change, from, pct: from > 0 ? (change / from) * 100 : null, since: daily.length ? null : Math.max(...use.map((p) => p.since ?? 0)) };
}

export type Range = "1d" | "7d" | "30d" | "all";

/** Performance history for the range: 1D from intraday points, otherwise one point per day. */
export function seriesFor(h: History, r: Range): number[] {
  if (r === "1d") {
    const prev = h.history.length >= 2 ? performance(h.history[h.history.length - 2]) : null;
    const points = h.intraday.map(performance);
    return prev !== null && points.length ? [prev, ...points] : points;
  }
  const days = r === "7d" ? 8 : r === "30d" ? 31 : Infinity;
  return h.history.slice(-days).map(performance);
}
