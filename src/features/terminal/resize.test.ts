import { test } from "node:test";
import assert from "node:assert/strict";
import { createResizer, type Timers } from "./resize.ts";

/** Manual clock: `tick(ms)` runs what is due. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => {
      due.set(next, { at: now + ms, fn });
      return next++;
    },
    clear: (id) => void due.delete(id as number),
  };
  const tick = (ms: number) => {
    now += ms;
    for (const [id, t] of [...due]) if (t.at <= now) (due.delete(id), t.fn());
  };
  return { timers, tick };
}

test("only the size it settles on is sent", () => {
  const { timers, tick } = fakeTimers();
  const sent: string[] = [];
  const r = createResizer((c, rows) => sent.push(`${c}x${rows}`), 80, timers);
  r.push(80, 20);
  tick(40);
  r.push(84, 21);
  tick(40);
  r.push(88, 22);
  assert.deepEqual(sent, []);
  tick(80);
  assert.deepEqual(sent, ["88x22"]);
});

test("the same size is not sent twice", () => {
  const { timers, tick } = fakeTimers();
  const sent: string[] = [];
  const r = createResizer((c, rows) => sent.push(`${c}x${rows}`), 80, timers);
  r.push(88, 22);
  tick(100);
  r.push(90, 22);
  r.push(88, 22);
  tick(100);
  assert.deepEqual(sent, ["88x22"]);
});

test("slivers from a hidden container are ignored", () => {
  const { timers, tick } = fakeTimers();
  const sent: string[] = [];
  const r = createResizer((c, rows) => sent.push(`${c}x${rows}`), 80, timers);
  r.push(1, 1);
  r.push(0, 30);
  r.push(Number.NaN, 30);
  tick(100);
  assert.deepEqual(sent, []);
});

test("reset: a new session at the current size sends nothing, then follows again", () => {
  const { timers, tick } = fakeTimers();
  const sent: string[] = [];
  const r = createResizer((c, rows) => sent.push(`${c}x${rows}`), 80, timers);
  r.push(70, 20);
  r.reset(88, 22);
  tick(100);
  r.push(88, 22);
  tick(100);
  assert.deepEqual(sent, []);
  r.push(90, 24);
  r.flush();
  assert.deepEqual(sent, ["90x24"]);
});
