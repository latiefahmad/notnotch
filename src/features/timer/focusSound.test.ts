import { test } from "node:test";
import assert from "node:assert/strict";
import { SWELL_S, fillLoop, focusSoundFor, normalizeFocusSound, swell } from "./focusSound.ts";

test("plays only while a focus timer started in this run is running", () => {
  const running = { mode: "focus", endsAt: 5000 };
  assert.equal(focusSoundFor(running, "rain", false, null), "rain");
  assert.equal(focusSoundFor(running, "off", false, null), "off");
  assert.equal(focusSoundFor(running, "rain", true, null), "off", "muted");
  assert.equal(focusSoundFor({ mode: "break", endsAt: 5000 }, "rain", false, null), "off", "break");
  assert.equal(focusSoundFor({ mode: "focus", endsAt: null }, "rain", false, null), "off", "paused, reset or finished");
  // Still running from before NotNotch started: silent until paused and started again.
  assert.equal(focusSoundFor(running, "rain", false, 5000), "off");
  assert.equal(focusSoundFor({ mode: "focus", endsAt: 9000 }, "rain", false, 5000), "rain");
});

test("unknown saved sound is off", () => {
  assert.equal(normalizeFocusSound("pink"), "pink");
  assert.equal(normalizeFocusSound("thunder"), "off");
  assert.equal(normalizeFocusSound(undefined), "off");
});

test("swell rises and falls once per period", () => {
  assert.ok(Math.abs(swell(0) - 0.15) < 1e-9);
  assert.ok(Math.abs(swell(SWELL_S / 2) - 1) < 1e-9);
  assert.ok(Math.abs(swell(SWELL_S) - swell(0)) < 1e-9);
  assert.ok(swell(SWELL_S / 4) > swell(0) && swell(SWELL_S / 4) < 1);
});

/** Mean step between neighbouring samples relative to the level: low for deep, smooth noise. */
function roughness(x: Float32Array): number {
  let steps = 0, sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i] * x[i];
    if (i) steps += Math.abs(x[i] - x[i - 1]);
  }
  return steps / (x.length - 1) / Math.sqrt(sum / x.length);
}

test("loops are deterministic, in range and get deeper from white to brown", () => {
  const rate = 8000;
  const loops = Object.fromEntries((["white", "pink", "brown", "rain", "waves"] as const).map((s) => [s, fillLoop(s, rate, 2)]));
  for (const [name, x] of Object.entries(loops)) {
    assert.equal(x.length, 2 * rate, name);
    assert.ok(x.every((v) => v >= -1 && v <= 1 && Number.isFinite(v)), name);
  }
  assert.deepEqual(fillLoop("pink", rate, 2), loops.pink);
  assert.ok(roughness(loops.white) > roughness(loops.pink));
  assert.ok(roughness(loops.pink) > roughness(loops.brown));
  // The loop point is as smooth as any other step of brown noise.
  const b = loops.brown;
  assert.ok(Math.abs(b[0] - b[b.length - 1]) < 5 * roughness(b) * 0.15);
});
