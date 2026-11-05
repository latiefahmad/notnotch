import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { animate, motion, useMotionValue } from "motion/react";
import { glideCycle, planTurn, type Cycle } from "./cycles";
import type { CarouselWindow } from "./layout";

/**
 * Runs a cycle as two motion values (shift and opacity). Rests are a setTimeout; only the moving stretches are a Motion
 * animation, of the cycle's own time, so the curve stays the one in cycles.ts. Paused, it freezes where it is and later
 * goes on from there. A new cycle starts from 0. `done` (the title's laps) ends it at its start.
 */
export function useCycle(cycle: Cycle | null, paused: boolean, done?: (played: number) => boolean) {
  const x = useMotionValue(0), opacity = useMotionValue(1), time = useMotionValue(0);
  const played = useRef(0), last = useRef(cycle);
  if (last.current !== cycle) {
    last.current = cycle;
    played.current = 0;
  }
  useEffect(() => {
    const show = (t: number) => {
      x.set(cycle ? cycle.shift(t) : 0);
      opacity.set(cycle ? cycle.opacity(t) : 1);
    };
    const offTime = time.on("change", show);
    if (!cycle || paused) {
      show(cycle && !done?.(played.current) ? played.current % cycle.period : 0);
      return offTime;
    }
    const origin = performance.now() / 1000 - played.current;
    let id = 0, anim: ReturnType<typeof animate> | undefined;
    const step = () => {
      anim?.stop();
      const t = (played.current = performance.now() / 1000 - origin);
      if (done?.(t)) return show(0);
      // The exact remainder, never a sum of stretches: a boundary off by an ulp would land in the stretch before.
      const at = t % cycle.period, now = cycle.stretch(at);
      let next = cycle.stretch(now.end);
      if (next.start < now.start) next = { ...next, start: next.start + cycle.period, end: next.end + cycle.period };
      const turn = planTurn(now, next, at);
      time.jump(at);
      show(at);
      if (turn.into !== undefined) {
        const s = now.moving ? now : next, from = s.start + Math.max(0, turn.into);
        anim = animate(time, [from, s.end], { duration: s.end - from, delay: Math.max(0, -turn.into), ease: "linear" });
      }
      id = window.setTimeout(step, turn.wait * 1000);
    };
    step();
    return () => {
      window.clearTimeout(id);
      anim?.stop();
      // A new cycle has already reset the time to 0 during render; only a pause keeps it.
      if (last.current === cycle) played.current = performance.now() / 1000 - origin;
      offTime();
    };
  }, [cycle, paused, done, x, opacity, time]);
  return { x, opacity };
}

/** Rings or readings: the strip of whole items, gliding through its window when not all of them fit. */
export function Carousel({ items, gap, window: win, width, paused }: { items: ReactNode[]; gap: number; window: CarouselWindow; width: number; paused: boolean }) {
  const rotating = win.count < items.length && win.travel > 0;
  const cycle = useMemo(() => (rotating ? glideCycle(win.travel) : null), [rotating, win.travel]);
  const { x, opacity } = useCycle(cycle, paused);
  return (
    <div className="flex h-full items-center overflow-clip" style={{ width }}>
      <motion.div className="flex shrink-0 items-center" style={{ gap, x, opacity }}>
        {items}
      </motion.div>
    </div>
  );
}
