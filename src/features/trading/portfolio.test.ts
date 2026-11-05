import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTotals,
  averageCost,
  baseForRegion,
  manualAccount,
  parseAmount,
  priceNeeds,
  seriesFor,
  summarize,
  toBase,
  todayChange,
  combineChanges,
  mergeRates,
  type Account,
  type Holding,
  type Rates,
  type Trade,
} from "./portfolio.ts";

const near = (a: number | null, b: number, eps = 1e-6) => assert.ok(a !== null && Math.abs(a - b) <= eps, `${a} is not near ${b}`);

// 1 EUR = 1.25 USD = 0.8 GBP; BTC at 50,000 EUR.
const rates: Rates = { base: "EUR", crypto: { BTC: 50_000, ETH: 2_000 }, fx: { USD: 1.25, GBP: 0.8 }, failed: [] };

const holding = (h: Partial<Holding> & { symbol: string }): Holding => ({
  name: "",
  kind: "crypto",
  quantity: 0,
  price: null,
  priceCurrency: null,
  value: null,
  cost: null,
  currency: null,
  ...h,
});
const account = (a: Partial<Account>): Account => ({ holdings: [], trades: [], realized: null, partial: false, warning: null, ...a });
const trade = (time: number, ...legs: [string, number][]): Trade => ({
  time,
  legs: legs.map(([asset, net]) => ({ asset, net, fiat: ["EUR", "USD", "GBP"].includes(asset) })),
});

test("currency conversion", () => {
  assert.equal(toBase(100, "EUR", rates), 100);
  assert.equal(toBase(125, "usd", rates), 100);
  assert.equal(toBase(80, "GBP", rates), 100);
  assert.equal(toBase(1, "CHF", rates), null);
});

test("average cost: buys, partial sell, realized", () => {
  const r = averageCost([trade(2, ["BTC", -0.5], ["EUR", 30_000]), trade(1, ["EUR", -10_000], ["BTC", 0.5]), trade(1.5, ["USD", -25_000], ["BTC", 0.5])], rates);
  // Bought 1 BTC for 10,000 + 20,000 EUR; sold half for 30,000 → realized 15,000.
  near(r.basis.BTC.quantity, 0.5);
  near(r.basis.BTC.cost, 15_000);
  near(r.realized, 15_000);
  assert.equal(r.skipped, 0);
});

test("average cost: a coin swap moves the cost basis", () => {
  const r = averageCost([trade(1, ["EUR", -1_000], ["USDT", 1_000]), trade(2, ["USDT", -400], ["ETH", 0.2])], rates);
  near(r.basis.USDT.cost, 600);
  near(r.basis.ETH.cost, 400);
  near(r.basis.ETH.quantity, 0.2);
  near(r.realized, 0);
});

test("average cost: sells without a buy and unknown currencies are skipped", () => {
  const r = averageCost([trade(1, ["BTC", -1], ["EUR", 50_000]), trade(2, ["CHF", -100], ["BTC", 0.01]), trade(3, ["EUR", -100], ["USD", 125])], rates);
  assert.equal(r.skipped, 2);
  assert.equal(r.realized, 0);
  assert.equal(r.basis.BTC, undefined);
});

test("summary with provider values (Trading 212 style)", () => {
  const s = summarize(
    account({
      holdings: [
        holding({ symbol: "AAPL", kind: "stock", quantity: 2, value: 500, cost: 400, currency: "USD" }),
        holding({ symbol: "USD", kind: "fiat", quantity: 125, value: 125, currency: "USD" }),
      ],
      realized: { amount: 25, currency: "USD" },
    }),
    rates,
  );
  near(s.value, 500);
  near(s.cash, 100);
  near(s.invested, 320);
  near(s.unrealized, 80);
  near(s.realized, 20);
  assert.equal(s.lines.length, 1);
  near(s.lines[0].price, 200);
});

test("summary prices coins and uses trade cost basis", () => {
  const s = summarize(
    account({
      holdings: [holding({ symbol: "BTC", quantity: 0.5 }), holding({ symbol: "EUR", kind: "fiat", quantity: 10 }), holding({ symbol: "DOGE", quantity: 100 })],
      trades: [trade(1, ["EUR", -20_000], ["BTC", 0.5])],
    }),
    rates,
  );
  near(s.value, 25_010);
  near(s.cash, 10);
  near(s.invested, 20_000);
  near(s.unrealized, 5_000);
  assert.deepEqual(s.missing, ["DOGE"]);
  assert.equal(s.lines.at(-1)?.symbol, "DOGE");
  assert.equal(s.lines.at(-1)?.value, null);
});

test("summary: withdrawn coins keep the average cost, extra coins make P&L approximate", () => {
  const withdrawn = summarize(account({ holdings: [holding({ symbol: "BTC", quantity: 0.25 })], trades: [trade(1, ["EUR", -20_000], ["BTC", 0.5])] }), rates);
  near(withdrawn.lines[0].cost, 10_000);
  near(withdrawn.lines[0].pnl, 2_500);
  assert.equal(withdrawn.lines[0].approx, false);

  const deposited = summarize(account({ holdings: [holding({ symbol: "BTC", quantity: 1 })], trades: [trade(1, ["EUR", -20_000], ["BTC", 0.5])] }), rates);
  // Value 50,000; trades explain half of it (25,000) against a cost of 20,000.
  near(deposited.lines[0].pnl, 5_000);
  assert.equal(deposited.lines[0].approx, true);
});

test("manual portfolio: coins priced live, stocks at the manual price", () => {
  const a = manualAccount([
    { id: "1", symbol: "btc", name: "Bitcoin", kind: "crypto", quantity: 0.1, cost: 4_000, currency: "EUR", price: null, priceDate: null },
    { id: "2", symbol: "VWCE", name: "", kind: "stock", quantity: 10, cost: 1_000, currency: "GBP", price: 96, priceDate: "2026-10-30" },
  ]);
  const s = summarize(a, rates);
  near(s.value, 5_000 + 1_200);
  near(s.invested, 4_000 + 1_250);
  near(s.unrealized, 1_000 - 50);
  assert.deepEqual(priceNeeds([a], "EUR"), { crypto: ["BTC"], fiats: ["GBP"] });
});

test("totals add up across accounts", () => {
  const t = addTotals([
    { value: 1, cash: 2, invested: 3, unrealized: 4, realized: 5, noCost: 6 },
    { value: 10, cash: 20, invested: 30, unrealized: 40, realized: 50, noCost: 60 },
  ]);
  assert.deepEqual(t, { value: 11, cash: 22, invested: 33, unrealized: 44, realized: 55, noCost: 66 });
});

test("amounts typed with either separator", () => {
  assert.equal(parseAmount("1.234,5"), 1234.5);
  assert.equal(parseAmount("1,234.5"), 1234.5);
  assert.equal(parseAmount("0,5"), 0.5);
  // The converter's rule: a lone comma before three digits groups thousands. Read as 1 before, a holding was 1000x too small.
  assert.equal(parseAmount("1,000"), 1000);
  assert.equal(parseAmount(" 12 "), 12);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("abc"), null);
});

test("base currency from the region", () => {
  assert.equal(baseForRegion("GB"), "GBP");
  assert.equal(baseForRegion("us"), "USD");
  assert.equal(baseForRegion("IT"), "EUR");
});

test("today's change and chart series", () => {
  const h = {
    history: [
      { date: "2026-10-30", value: 1_000, invested: 900, pnl: 100 },
      { date: "2026-10-31", value: 1_050, invested: 900, pnl: 150 },
    ],
    intraday: [
      { t: 1, value: 1_010, pnl: 110 },
      { t: 2, value: 1_050, pnl: 150 },
    ],
  };
  assert.deepEqual(todayChange(150, h), { change: 50, pct: 5, from: 1_000, since: null });
  assert.deepEqual(todayChange(150, { history: [], intraday: h.intraday }), { change: 40, pct: (40 / 1_010) * 100, from: 1_010, since: 1 });
  assert.equal(todayChange(150, { history: [], intraday: [] }), null);
  assert.deepEqual(seriesFor(h, "1d"), [100, 110, 150]);
  assert.deepEqual(seriesFor(h, "7d"), [100, 150]);
});

test("value without cost basis counts for today and the chart", () => {
  const s = summarize(account({ holdings: [holding({ symbol: "BTC", quantity: 0.1 }), holding({ symbol: "ETH", quantity: 1, value: 2_000, cost: 1_500, currency: "EUR" })] }), rates);
  near(s.noCost, 5_000);
  near(s.unrealized, 500);
  const h = {
    history: [
      { date: "2026-10-30", value: 6_400, invested: 1_500, pnl: 400, noCost: 4_900 },
      { date: "2026-10-31", value: 7_000, invested: 1_500, pnl: 500, noCost: 5_000 },
    ],
    intraday: [],
  };
  // P&L +100 and the uncosted BTC +100.
  assert.equal(todayChange(500 + 5_000, h)?.change, 200);
  assert.deepEqual(seriesFor(h, "7d"), [5_300, 5_500]);
  // Coins beyond what trades explain are part of it too.
  const approx = summarize(account({ holdings: [holding({ symbol: "BTC", quantity: 1 })], trades: [trade(1, ["EUR", -20_000], ["BTC", 0.5])] }), rates);
  near(approx.noCost, 25_000);
});

test("the total's today only compares accounts present both days", () => {
  const a = { change: 50, pct: 5, from: 1_000, since: null };
  const fresh = { change: 9_000, pct: 900, from: 1_000, since: 123 };
  assert.deepEqual(combineChanges([a, null, fresh]), { change: 50, pct: 5, from: 1_000, since: null });
  assert.deepEqual(combineChanges([null, fresh, { ...fresh, change: 10, since: 456 }]), { change: 9_010, pct: (9_010 / 2_000) * 100, from: 2_000, since: 456 });
  assert.equal(combineChanges([null, null]), null);
});

test("prices of a failed source come from the previous refresh", () => {
  const prev: Rates = { base: "EUR", crypto: { BTC: 1, ETH: 2 }, fx: { USD: 1.2 }, failed: [] };
  const next: Rates = { base: "EUR", crypto: {}, fx: { USD: 1.3 }, failed: ["coingecko"] };
  assert.deepEqual(mergeRates(next, prev).crypto, { BTC: 1, ETH: 2 });
  assert.deepEqual(mergeRates(next, prev).fx, { USD: 1.3 });
  assert.deepEqual(mergeRates(next, { ...prev, base: "USD" }).crypto, {});
});
