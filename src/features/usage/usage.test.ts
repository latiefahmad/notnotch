import { test } from "node:test";
import assert from "node:assert/strict";
import { cost, effective, findPrices, normalizeModel, validPrices, PRICES } from "./pricing.ts";
import { byModel, dayStart, sumRows, totals, type TokenBucket, type TokenReport } from "./tokens.ts";
import { normalizeCards, shownIds, USAGE_IDS } from "./cards.ts";

const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const counts = (c: Partial<TokenBucket> = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...c });

test("model names normalise to one spelling", () => {
  assert.equal(normalizeModel("claude-opus-4-5-20251101"), "claude-opus-4-5");
  assert.equal(normalizeModel("anthropic/claude-sonnet-4.5"), "claude-sonnet-4-5");
  assert.equal(normalizeModel(" Claude-Opus-5-5[1m] "), "claude-opus-5-5");
  // GPT versions keep their dot.
  assert.equal(normalizeModel("openai/gpt-5.1-codex"), "gpt-5.1-codex");
});

test("prices: table, cache defaults, tiers and manual override", () => {
  // Opus 5.5: 4 / 20, cache read 0.20, write 1.25x = 5, one-hour 2x = 8 (USD per million).
  near(cost("claude-opus-5-5", 0, counts({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 1e6 }), {}), 4 + 20 + 0.2 + 5 + 8);
  // Sonnet 4.5 with more than 200K prompt tokens takes the long-context price.
  near(cost("claude-sonnet-4-5-20250929", 2, counts({ input: 1e6 }), {}), 6);
  near(cost("claude-sonnet-4-5", 1, counts({ input: 1e6 }), {}), 3);
  // Haiku 5.5 above 100K.
  near(cost("claude-haiku-5-5", 1, counts({ output: 1e6 }), {}), 2.5);
  // Codex: cached input at the cache price.
  near(cost("gpt-5-codex", 0, counts({ input: 1e6, cacheRead: 1e6 }), {}), 1.25 + 0.125);
  assert.equal(cost("gpt-9-mystery", 0, counts({ input: 5 }), {}), null);
  // A price set by hand wins and is flat.
  const manual = { "claude-opus-5-5": { input: 1, output: 2 } };
  near(cost("claude-opus-5-5-20260101", 0, counts({ input: 1e6, output: 1e6, cacheRead: 1e6 }), manual), 1 + 2 + 0.1);
  assert.equal(findPrices("claude-opus-5-5", manual)?.manual, true);
  assert.deepEqual(effective(PRICES["claude-opus-5-5"], 0), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 });
  // Every table entry is itself valid.
  for (const [id, p] of Object.entries(PRICES)) assert.ok(validPrices(p), id);
  assert.equal(validPrices({ input: -1, output: 2 }), false);
  assert.equal(validPrices({ input: 1, output: Number.NaN }), false);
  assert.equal(validPrices({ input: 1 } as never), false);
});

test("every model id found in the real logs on 2026-10-31 has a price", () => {
  // From ~/.claude/projects on Andrea's PC, dated snapshot included; "<synthetic>" lines carry no tokens.
  const seen = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-7", "claude-haiku-5-5", "claude-fable-5-1", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
  for (const id of seen) assert.ok(findPrices(id, {}), id);
  assert.equal(findPrices("<synthetic>", {}), null);
  assert.equal(findPrices("claude-haiku-4-5-20251001", {})?.prices.input, 1);
});

test("local days", () => {
  const now = new Date(2026, 9, 31, 15, 30).getTime();
  assert.equal(dayStart(now, 0), new Date(2026, 9, 31).getTime());
  assert.equal(dayStart(now, 6), new Date(2026, 9, 25).getTime());
  // Across a month start.
  assert.equal(dayStart(new Date(2026, 10, 2, 1).getTime(), 3), new Date(2026, 9, 30).getTime());
});

const today = dayStart(Date.now(), 0);
const b = (daysBack: number, model: string, c: Partial<TokenBucket>): TokenBucket => ({ ...counts(c), at: today - daysBack * 86_400_000 + 3_600_000, model, band: 0 });
const report: TokenReport = {
  since: 0,
  tools: [
    { id: "claude", found: true, files: 2, unreadable: 0, buckets: [b(8, "claude-opus-5-5", { output: 1e6 }), b(3, "claude-opus-5-5", { input: 1e6 }), b(0, "claude-opus-5-5", { output: 1e6 }), b(0, "claude-sonnet-5-5", { input: 2e6 }), b(0, "mystery", { input: 10 })] },
    { id: "codex", found: true, files: 1, unreadable: 0, buckets: [b(1, "gpt-5-codex", { output: 1e6 })] },
  ],
};

test("totals by day", () => {
  const claude = report.tools[0].buckets;
  const day = totals(claude, dayStart(Date.now(), 0), {});
  assert.equal(day.tokens, 3e6 + 10);
  near(day.cost, 20 + 4);
  assert.equal(day.unpriced, 10);
  const week = totals(claude, dayStart(Date.now(), 6), {});
  assert.equal(week.tokens, 4e6 + 10);
  near(week.cost, 20 + 4 + 4);
});

test("rows by model, filtered by tool and range", () => {
  const rows = byModel(report, new Set(["claude", "codex"]), dayStart(Date.now(), 6), {});
  assert.deepEqual(rows.map((r) => [r.tool, r.model, r.tokens]), [
    ["claude", "claude-opus-5-5", 2e6],
    ["claude", "claude-sonnet-5-5", 2e6],
    ["codex", "gpt-5-codex", 1e6],
    ["claude", "mystery", 10],
  ]);
  const onlyCodex = byModel(report, new Set(["codex"]), dayStart(Date.now(), 29), {});
  assert.deepEqual(onlyCodex.map((r) => r.model), ["gpt-5-codex"]);
  const sum = sumRows(rows);
  assert.equal(sum.tokens, 5e6 + 10);
  near(sum.cost, 24 + 4 + 10);
  assert.equal(sum.unpriced, 10);
});

test("cards: saved data is normalised", () => {
  assert.deepEqual(normalizeCards(undefined).order, USAGE_IDS);
  const n = normalizeCards({ order: ["zai", "claude", "claude", "grok" as never], names: { claude: "  Work  ", codex: " ", grok: "x" } as never, prices: { "Claude-Opus-5.5": { input: 1, output: 2 }, bad: { input: -1, output: 1 } } });
  assert.deepEqual(n.order.slice(0, 2), ["zai", "claude"]);
  assert.equal(n.order.length, USAGE_IDS.length);
  assert.deepEqual(n.names, { claude: "Work" });
  assert.deepEqual(Object.keys(n.prices), ["claude-opus-5-5"]);
  assert.deepEqual(shownIds(n.order, { claude: true, zai: true, codex: false }), ["zai", "claude"]);
});
