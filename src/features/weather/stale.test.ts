import { test } from "node:test";
import assert from "node:assert/strict";
import { SAVED_FOR_MS, savedForecast } from "./stale.ts";

const HOUR = 60 * 60_000;
const data = { current: { temp: 12 }, daily: [{ date: "2026-11-01" }, { date: "2026-11-02" }, { date: "2026-11-03" }] };
const saved = { key: "51.47,-0.36", at: 1_000_000, data };

test("the saved forecast stands in for a failed fetch: same place, not too old, past days dropped", () => {
  const got = savedForecast(saved, "51.47,-0.36", saved.at + 3 * HOUR, "2026-11-02");
  assert.deepEqual(got, { current: { temp: 12 }, daily: [{ date: "2026-11-02" }, { date: "2026-11-03" }], savedAt: saved.at });
  assert.equal(savedForecast(null, "51.47,-0.36", saved.at, "2026-11-02"), null);
  assert.equal(savedForecast(saved, "48.85,2.35", saved.at, "2026-11-02"), null);
  assert.equal(savedForecast(saved, "51.47,-0.36", saved.at + SAVED_FOR_MS + 1, "2026-11-02"), null);
});
