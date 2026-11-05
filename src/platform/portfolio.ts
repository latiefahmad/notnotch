import { invoke } from "@tauri-apps/api/core";
import { isNative } from "./native";
import { secrets, type SecretName } from "./services";
import { showcase, showcaseCash, showcaseDayChange, showcasePositions, showcaseRealized } from "../dev/showcase-data";
import type { Account, History, Rates } from "../features/trading/portfolio";

/*
 * Bridge to the portfolio backend (src-tauri/src/trading.rs). In the browser it returns
 * sample accounts for the providers whose key is set in the mock secrets.
 *
 * Error codes: no-key, unauthorized, forbidden, rate, bad-key, unknown-provider, network:…, api:…
 */

export function fetchAccount(provider: string, env: string): Promise<Account> {
  return isNative ? invoke<Account>("portfolio_fetch", { provider, env }) : mockAccount(provider);
}

export function fetchRates(base: string, crypto: string[], fiats: string[]): Promise<Rates> {
  return isNative ? invoke<Rates>("portfolio_prices", { base, crypto, fiats }) : Promise.resolve(mockRates(base));
}

export interface RecordEntry {
  scope: string;
  value: number;
  pnl: number;
  invested: number;
  /** Value of positions without a cost basis. */
  noCost: number;
  /** Trading 212 env whose old history seeds this scope once (same currency only). */
  seed?: string;
}

/** Stores today's point per scope and returns each scope's history. */
export function recordHistory(base: string, entries: RecordEntry[]): Promise<Record<string, History>> {
  const today = localDate(new Date());
  return isNative ? invoke<Record<string, History>>("portfolio_record", { base, today, entries }) : Promise.resolve(mockHistory(entries));
}

/** The key of `provider` was deleted: forget its cache, ledger and history. */
export function forgetAccount(provider: string): Promise<void> {
  return isNative ? invoke("portfolio_forget", { provider }) : Promise.resolve();
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- Browser samples ----------

const mockKeys: Record<string, SecretName> = {
  t212: "t212.key",
  kraken: "kraken.key",
  coinbase: "coinbase.key",
  binance: "binance.key",
  bitpanda: "bitpanda.key",
  etoro: "etoro.key",
  ibkr: "ibkr.token",
};

const none = { price: null, priceCurrency: null, value: null, cost: null, currency: null };

async function mockAccount(provider: string): Promise<Account> {
  await new Promise((r) => setTimeout(r, showcase ? 160 : 450));
  const key = mockKeys[provider];
  if (!key || !(await secrets.has(key))) throw "no-key";
  const base = { trades: [], realized: null, partial: false, warning: null };
  if (provider === "t212") {
    return {
      ...base,
      holdings: [
        ...showcasePositions.map((p) => ({
          symbol: p.ticker,
          name: p.name,
          kind: "stock" as const,
          quantity: p.quantity,
          price: p.currentPrice,
          priceCurrency: p.priceCurrency,
          value: p.value,
          cost: p.cost,
          currency: "EUR",
        })),
        { ...none, symbol: "EUR", name: "", kind: "fiat", quantity: showcaseCash, value: showcaseCash, currency: "EUR" },
      ],
      realized: { amount: showcaseRealized, currency: "EUR" },
    };
  }
  if (provider === "kraken") {
    return {
      ...base,
      holdings: [
        { ...none, symbol: "BTC", name: "", kind: "crypto", quantity: 0.0825 },
        { ...none, symbol: "ETH", name: "", kind: "crypto", quantity: 1.4 },
        { ...none, symbol: "EUR", name: "", kind: "fiat", quantity: 230.5 },
      ],
      trades: [
        { time: 1, legs: [{ asset: "EUR", fiat: true, net: -2600 }, { asset: "BTC", fiat: false, net: 0.0825 }] },
        { time: 2, legs: [{ asset: "EUR", fiat: true, net: -3150 }, { asset: "ETH", fiat: false, net: 1.4 }] },
      ],
    };
  }
  return {
    ...base,
    holdings: [
      { ...none, symbol: "SOL", name: "", kind: "crypto", quantity: 12 },
      { ...none, symbol: "USD", name: "", kind: "fiat", quantity: 140 },
    ],
    warning: provider === "binance" ? "key-can-trade" : null,
  };
}

/** Units per 1 EUR. */
const eur: Record<string, number> = { EUR: 1, USD: 1.17, GBP: 0.86, CHF: 0.93, JPY: 176, CAD: 1.6, AUD: 1.78, SEK: 11, NOK: 11.6, DKK: 7.46, PLN: 4.25, CZK: 24.4 };
const coinsEur: Record<string, number> = { BTC: 58_200, ETH: 2_140, SOL: 142 };

function mockRates(base: string): Rates {
  const b = eur[base] ?? 1;
  return {
    base,
    crypto: Object.fromEntries(Object.entries(coinsEur).map(([k, v]) => [k, v * b])),
    fx: Object.fromEntries(Object.entries(eur).map(([k, v]) => [k, v / b])),
    date: "2026-10-30",
    failed: [],
  };
}

/** 30 days of growth with a dip, ending at today's P&L; intraday from 9:00 every 2 min. */
function mockHistory(entries: RecordEntry[]): Record<string, History> {
  const out: Record<string, History> = {};
  for (const e of entries) {
    const change = showcase && e.scope === "all" ? showcaseDayChange : e.value * 0.009;
    const yesterday = e.pnl - change;
    const history = [];
    for (let i = 30; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const f = (30 - i) / 30;
      const pnl = i === 0 ? e.pnl : i === 1 ? yesterday : yesterday - e.value * 0.05 * (1 - f) + Math.sin(i * 0.9) * e.value * 0.004 - Math.max(0, 1 - Math.abs(i - 14) / 5) * e.value * 0.014;
      history.push({ date: localDate(d), value: e.value - e.pnl + pnl, invested: e.invested, pnl, noCost: e.noCost });
    }
    const start = new Date();
    start.setHours(9, 0, 0, 0);
    const steps = Math.max(2, Math.floor((Date.now() - start.getTime()) / 120_000));
    const intraday = Array.from({ length: steps }, (_, i) => {
      const f = i / (steps - 1);
      const p = i === steps - 1 ? e.pnl : yesterday + change * f + Math.sin(i * 0.8) * change * 0.15 * (1 - f) - Math.sin(f * Math.PI) * change * 0.2;
      return { t: start.getTime() + i * 120_000, value: e.value - e.pnl + p, pnl: p, noCost: e.noCost };
    });
    out[e.scope] = { history, intraday };
  }
  return out;
}
