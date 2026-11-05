import { test } from "node:test";
import assert from "node:assert/strict";
import { glideCycle, marqueeCycle, planTurn, type Cycle } from "./cycles.ts";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not near ${b}`);

test("glide", () => {
  const c = glideCycle(60);
  assert.equal(c.period, 2.5 + 5 + 2 + 0.5);
  assert.equal(c.shift(1), 0); assert.equal(c.shift(7.6), -60); assert.equal(c.shift(c.period - 0.1), 0);
  assert.equal(c.opacity(9.5 + 0.125), 0.5); assert.equal(c.moving(1), false); assert.equal(c.moving(3), true);
});
test("glide curve", () => {
  const c = glideCycle(60);
  near(c.shift(5), -30, 1e-6);   // (.4, 0, .6, 1) is symmetric
  assert.ok(c.shift(3) > -6 && c.shift(3) < 0, "eases in, slower than linear at the start");
  for (let t = 2.5, last = 0; t <= 7.5; t += 0.05) { assert.ok(c.shift(t) <= last + 1e-9 && c.shift(t) >= -60 - 1e-9); last = c.shift(t); }
});
test("glide fade back", () => {
  const c = glideCycle(60);
  assert.equal(c.shift(9.6), -60); assert.equal(c.shift(9.8), 0);   // jumps back while invisible, at 9.75
  assert.equal(c.opacity(1), 1); assert.equal(c.opacity(9.5), 1); assert.equal(c.opacity(9.75), 0); assert.equal(c.opacity(9.875), 0.5);
  assert.equal(c.moving(8), false); assert.equal(c.moving(9.6), true);
});
test("glide wraps any t", () => {
  const c = glideCycle(60);
  assert.equal(c.shift(7.6 + 10), -60); assert.equal(c.shift(7.6 - 10), -60); assert.equal(c.opacity(-0.125), 0.5);
  assert.equal(c.shift(Number.NaN), 0);
});
test("stretches", () => {
  const c = glideCycle(60);
  assert.deepEqual(c.stretch(1), { moving: false, start: 0, end: 2.5 });
  assert.deepEqual(c.stretch(3), { moving: true, start: 2.5, end: 7.5 });
  assert.deepEqual(c.stretch(8), { moving: false, start: 7.5, end: 9.5 });
  assert.deepEqual(c.stretch(9.6), { moving: true, start: 9.5, end: 10 });
  assert.deepEqual(c.stretch(10), c.stretch(0));
});
test("marquee", () => {
  const m = marqueeCycle(48);
  assert.equal(m.period, 5); assert.equal(m.done(14.9), false); assert.equal(m.done(15), true);
  assert.equal(m.shift(1), 0); near(m.shift(2.5), -24); assert.equal(m.shift(4), -48); near(m.shift(5 + 2.5), -24);
  assert.equal(m.opacity(2.5), 1);
  assert.deepEqual(m.stretch(2), { moving: true, start: 1.5, end: 3.5 }); assert.equal(m.moving(4.5), false);
});
test("turn", () => {
  assert.deepEqual(planTurn({ moving: true, start: 2, end: 5 }, { moving: false, start: 5, end: 7 }, 3), { into: 1, wait: 2 });
  assert.equal(planTurn({ moving: false, start: 0, end: 2.5 }, { moving: true, start: 2.5, end: 5 }, 1).wait, 1.45);
  assert.equal(planTurn({ moving: false, start: 4, end: 7 }, { moving: false, start: 0, end: 1.5 }, 5).wait, 2);
});
test("turn hands a move over just before it starts", () => {
  const t = planTurn({ moving: false, start: 0, end: 2.5 }, { moving: true, start: 2.5, end: 5 }, 2.47);
  near(t.into!, -0.03); near(t.wait, 2.53);
  assert.equal("into" in planTurn({ moving: false, start: 0, end: 2.5 }, { moving: true, start: 2.5, end: 5 }, 1), false);
});
test("the next stretch starts exactly where the one before ends", () => {
  // Wrapping a time already inside the period must not move it by an ulp, or the lookup at a boundary lands in the stretch before.
  for (let x = 1; x <= 400; x += 0.37) for (const c of [glideCycle(x), marqueeCycle(x)]) {
    let s = c.stretch(0);
    assert.equal(s.start, 0);
    for (let i = 0; i < 4; i++) {
      const n = c.stretch(s.end);
      assert.equal(n.start, s.end % c.period, `after ${JSON.stringify(s)} comes ${JSON.stringify(n)}`);
      if (!s.moving && n.moving) near(planTurn(s, n, s.end - 0.03).into!, -0.03);   // handed over early, not when the timer wakes
      if (s.end >= c.period) break;
      s = n;
    }
    assert.equal(s.end, c.period);
  }
});
test("a timer driven by planTurn runs a clock only around the moves", () => {
  for (const c of [glideCycle(40), marqueeCycle(100)] as Cycle[]) {
    let now = 0, clock = 0, moves = 0, steps = 0, timely = true;
    while (now < 10 * c.period && steps++ < 2000) {   // bounded, so a planner that stops advancing fails instead of hanging
      const at = now % c.period, s = c.stretch(at), n = c.stretch(s.end), turn = planTurn(s, n, at), move = s.moving ? s : n;
      if (turn.into !== undefined) {
        moves++;
        timely &&= turn.into >= -0.05 - 1e-9 && turn.into <= move.end - move.start; clock += turn.wait + 0.005;
      }
      now += turn.wait + 0.005 + 0.01;   // the timer lands a little late
    }
    let moving = 0;
    for (let t = 0; t < c.period; t += 0.001) if (c.moving(t)) moving += 0.001;
    assert.ok(timely && moves >= 10);
    assert.ok(clock / 10 <= moving + 2 * (0.05 + 0.03) && clock / 10 >= moving - 0.05, `${clock / 10} s of clock for ${moving} s moving`);
  }
});
