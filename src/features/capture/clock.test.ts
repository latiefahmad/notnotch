import { test } from "node:test";
import assert from "node:assert/strict";
import { elapsedAt, formatElapsed, type RecClock } from "./clock.ts";

test("counts on while recording, stands still while paused", () => {
  const start: RecClock = { phase: "recording", elapsedMs: 0, at: 1_000 };
  assert.equal(elapsedAt(start, 4_500), 3_500);
  // Paused at 3.5 s: Rust reports 3500 and the display holds it.
  const paused: RecClock = { phase: "paused", elapsedMs: 3_500, at: 4_500 };
  assert.equal(elapsedAt(paused, 60_000), 3_500);
  // Resumed a minute later: counts on from 3.5 s, not from the wall clock.
  const resumed: RecClock = { phase: "recording", elapsedMs: 3_500, at: 64_500 };
  assert.equal(elapsedAt(resumed, 66_000), 5_000);
  // A clock that runs a little behind the report never shows less than reported.
  assert.equal(elapsedAt(resumed, 64_000), 3_500);
  assert.equal(elapsedAt({ phase: "idle", elapsedMs: 0, at: 0 }, 99), 0);
});

test("format", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(7_999), "0:07");
  assert.equal(formatElapsed(754_000), "12:34");
  assert.equal(formatElapsed(3_723_000), "1:02:03");
  assert.equal(formatElapsed(-5), "0:00");
});
