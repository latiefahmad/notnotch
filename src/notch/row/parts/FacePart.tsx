import { useEffect, useRef } from "react";
import { rowVisible } from "../visibility";

/*
 * The face in the closed notch: two eyes and a smile, in the row's ink. It blinks now and then and
 * its eyes follow the pointer, so the notch feels awake without a per-frame React render.
 *
 * The row is 30 px tall and a part gets about 18 of it, so only what reads at that size is here:
 * two eyes and a short smile. Cheeks and long outlines are left out; at this size they turn into
 * noise. Everything is set on `transform` straight through refs (the Equalizer's way), never through
 * state: the animation costs no renders and stops when the row stops.
 */

const EYE = 9;
/** The eyes nearly touch: in the reference they are the face, not two separate dots. */
const GAP = 1;

/** Room for the face: two eyes side by side, the smile under them is narrower. */
export const FACE_WIDTH = EYE * 2 + GAP;
/** How far the catch-light may travel inside an eye, in px. Kept small: it must stay on the eye. */
const REACH = 1.1;
/** A blink every 2.4 to 6.4 s: fast enough to feel alive, slow enough not to nag. */
const BLINK_MIN_MS = 2400;
const BLINK_MAX_MS = 6400;

/**
 * `paused` (under a notice, or the notch is not on screen) freezes the face: no loop runs and the
 * eyes hold their last look.
 */
export function FacePart({ paused }: { paused: boolean }) {
  const eyes = useRef<(HTMLSpanElement | null)[]>([]);
  const shins = useRef<(HTMLSpanElement | null)[]>([]);
  const root = useRef<HTMLSpanElement>(null);
  // The loop reads this, so it never needs to restart when the pointer moves.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const visible = rowVisible.use();

  useEffect(() => {
    // Only track the pointer while the row is on screen: a hidden notch has nothing to look at.
    if (!visible) return;
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    };
    const leave = () => {
      pointer.current = null;
    };
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.removeEventListener("pointerleave", leave);
    };
  }, [visible]);

  useEffect(() => {
    if (paused) return;
    // The setting that asks for less motion also stills the face (Notch's MotionConfig, reducedMotion="user").
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    let frame = 0;
    let blinkTimer = 0;
    let last = performance.now();

    const move = () => {
      const p = pointer.current;
      const box = root.current?.getBoundingClientRect();
      if (!p || !box) return;
      // Look towards the pointer, measured from the face: the offset is capped by REACH, so the
      // highlights never leave the eyes.
      const dx = Math.max(-REACH, Math.min(REACH, ((p.x - (box.left + box.width / 2)) / box.width) * REACH * 2));
      const dy = Math.max(-REACH, Math.min(REACH, ((p.y - (box.top + box.height / 2)) / box.height) * REACH * 2));
      for (const shine of shins.current) shine?.style.setProperty("transform", `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`);
    };

    const tick = (now: number) => {
      // The pointer only needs to be read on a real frame; 20-30 fps is plenty for a 22 px face.
      if (now - last >= 33) {
        last = now;
        move();
      }
      frame = requestAnimationFrame(tick);
    };

    const blink = () => {
      for (const eye of eyes.current) eye?.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(0.1)" }, { transform: "scaleY(1)" }], { duration: 150, easing: "ease-in-out" });
      schedule();
    };
    const schedule = () => {
      blinkTimer = window.setTimeout(blink, BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS));
    };

    schedule();
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(blinkTimer);
    };
  }, [paused]);

  return (
    <span ref={root} className="flex shrink-0 flex-col items-center" style={{ width: FACE_WIDTH }} aria-hidden>
      <span className="flex" style={{ gap: GAP }}>
        {[0, 1].map((i) => (
          <span
            key={i}
            ref={(el) => {
              eyes.current[i] = el;
            }}
            className="relative block shrink-0 rounded-full bg-label"
            style={{ width: EYE, height: EYE, transformOrigin: "center" }}
          >
            {/* The catch-light: it moves with the pointer, which is what reads as "looking". */}
            <span
              ref={(el) => {
                shins.current[i] = el;
              }}
              className="absolute rounded-full bg-notch"
              style={{ width: EYE / 4.5, height: EYE / 4.5, top: EYE * 0.2, left: EYE * 0.2, transition: "transform 90ms ease-out" }}
            />
          </span>
        ))}
      </span>
      {/* A short smile under the eyes. Only a curve reads as a mouth at this size: a straight rule
          looks like a separator, and a rounded box has no bend at all. */}
      <svg width={FACE_WIDTH * 0.6} height={3} viewBox="0 0 12 3" aria-hidden style={{ marginTop: -0.5 }}>
        <path d="M1 0.6 Q6 4 11 0.6" fill="none" stroke="var(--color-label)" strokeWidth={1.4} strokeLinecap="round" />
      </svg>
    </span>
  );
}
