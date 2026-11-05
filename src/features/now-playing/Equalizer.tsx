import { useEffect, useRef } from "react";
import { audioLevelsAvailable, subscribeLevels, subscribeSpectrum } from "../../platform/audio";
import { wavePath } from "./shapes";

/*
 * Four bars in the accent color, bass on the left, treble on the right. The Music tool can
 * also show 12 thinner bars (Spectrum) or a line through those 12 bands (Wave).
 *
 * One animation loop for every state, so nothing ever switches hard:
 * - Playing + real levels (WASAPI loopback, ~40 values/s): bars follow the sound.
 * - Silence on track change or seek: gentle "breathing" instead of dropping to zero.
 * - In the browser or without levels: the same soft motion, synthetic.
 * - Paused: bars glide to a calm, even height.
 * Values go straight to `transform` (no React render per frame) and are smoothed per
 * frame over time: fast attack, slower release, like an analog meter.
 */
const MIN = 0.2;
const IDLE = 0.24;
/** Smoothing time constants (s). */
const ATTACK = 0.045;
const RELEASE = 0.14;
const SETTLE = 0.18;
/** GSMTC briefly reports "paused" on seek/track change; ignore it for this long. */
const PAUSE_DEBOUNCE_MS = 320;
/** Keep the capture open briefly after pausing so resuming reacts instantly. */
export const RELEASE_CAPTURE_MS = 2000;
/** Below one 60 Hz frame with room for timer jitter: 60 Hz draws every frame, 120 Hz
 *  every 2nd (60 fps), 144 Hz every 2nd (72 fps), 165 Hz every 3rd (55 fps), 240 Hz
 *  every 4th (60 fps). Always whole frames, so the pacing stays even. */
const MIN_FRAME_MS = 13;

/** Soft fake motion per bar (layered sine waves at different speeds). */
function synthetic(i: number, t: number): number {
  const a = Math.sin(t * (5.1 + i * 1.3) + i * 1.7);
  const b = Math.sin(t * (2.3 + i * 0.7) + i * 0.9);
  return 0.5 + 0.32 * a + 0.18 * b;
}

export type EqualizerLook = "bars" | "spectrum" | "wave";
const SPECTRUM_BANDS = 12;
const WAVE_WIDTH = 28;
const WAVE_STROKE = 1.75;

/**
 * `tint` = Tailwind background class for the bars (Discord: green instead of accent).
 * `look` is read once: give the element a `key` that changes with it.
 */
export function Equalizer({ playing, height = 12, tint = "bg-accent", look = "bars" }: { playing: boolean; height?: number; tint?: string; look?: EqualizerLook }) {
  const count = look === "bars" ? 4 : SPECTRUM_BANDS;
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const wave = useRef<SVGPathElement>(null);
  const playingRef = useRef(playing);
  const levels = useRef<{ values: readonly number[]; at: number } | null>(null);
  const wake = useRef<() => void>(() => {});

  // Apply pause with a slight delay (flicker on seek), start immediately.
  useEffect(() => {
    if (playing) {
      playingRef.current = true;
      wake.current();
      return;
    }
    const id = window.setTimeout(() => {
      playingRef.current = false;
      wake.current();
    }, PAUSE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [playing]);

  // Subscribe to real levels; unsubscribe with a delay after pausing.
  const off = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!audioLevelsAvailable) return;
    if (playing) {
      const store = (values: readonly number[]) => {
        levels.current = { values, at: performance.now() };
      };
      off.current ??= look === "bars" ? subscribeLevels(store) : subscribeSpectrum(store);
      return;
    }
    const id = window.setTimeout(() => {
      off.current?.();
      off.current = null;
    }, RELEASE_CAPTURE_MS);
    return () => window.clearTimeout(id);
  }, [playing, look]);
  useEffect(
    () => () => {
      off.current?.();
      off.current = null;
    },
    [],
  );

  // Animation loop: runs while something moves, sleeps when paused and settled.
  useEffect(() => {
    const value = Array<number>(count).fill(IDLE);
    let frame = 0;
    let last = performance.now();
    let quiet = 0;

    const tick = (now: number) => {
      // Cap at ~60 fps: on 120/144/240 Hz screens every 2nd (3rd) frame, evenly
      // paced. Levels only arrive 40×/s, more frames don't add motion.
      if (now - last < MIN_FRAME_MS) {
        frame = requestAnimationFrame(tick);
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now / 1000;
      const live = levels.current && now - levels.current.at < 400 ? levels.current.values : null;
      const loud = live ? Math.max(...live) : 0;
      // Silence while playing (track change, seek) → breathe gently after 150 ms.
      quiet = live && loud > 0.06 ? 0 : quiet + dt;
      const breathe = Math.min(1, Math.max(0, (quiet - 0.15) / 0.35));

      let settled = true;
      for (let i = 0; i < count; i++) {
        let target: number;
        let tau: number;
        if (!playingRef.current) {
          target = IDLE;
          tau = SETTLE;
        } else {
          const real = live ? MIN + (1 - MIN) * live[i] : 0;
          const soft = MIN + (live ? 0.3 : 0.75) * synthetic(i, t);
          target = live ? real * (1 - breathe) + soft * breathe : soft;
          tau = target > value[i] ? ATTACK : RELEASE;
        }
        value[i] += (target - value[i]) * (1 - Math.exp(-dt / tau));
        if (Math.abs(target - value[i]) > 0.002) settled = false;
        const bar = bars.current[i];
        if (bar) bar.style.transform = `scaleY(${value[i].toFixed(3)})`;
      }
      wave.current?.setAttribute("d", wavePath(value, WAVE_WIDTH, height, WAVE_STROKE / 2 + 0.25));

      frame = playingRef.current || !settled ? requestAnimationFrame(tick) : 0;
    };

    wake.current = () => {
      if (frame) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    wake.current();
    return () => {
      cancelAnimationFrame(frame);
      wake.current = () => {};
    };
  }, [count, height]);

  if (look === "wave")
    return (
      <svg width={WAVE_WIDTH} height={height} className="overflow-visible" aria-hidden>
        <path
          ref={wave}
          d={wavePath(Array<number>(count).fill(IDLE), WAVE_WIDTH, height, WAVE_STROKE / 2 + 0.25)}
          fill="none"
          // The tint's colour token directly: Tailwind would not see a stroke class built from it at runtime.
          stroke={`var(--color-${tint.replace(/^bg-/, "")})`}
          strokeWidth={WAVE_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transition: "stroke 400ms ease" }}
        />
      </svg>
    );
  // Spectrum: thinner bars, scaled from the middle like the four, so it reads as one family.
  return (
    <div className={`flex items-center ${look === "bars" ? "gap-[2px]" : "gap-[1px]"}`} style={{ height }} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className={`h-full rounded-full ${look === "bars" ? "w-[2.5px]" : "w-[1.5px]"} ${tint}`}
          style={{ transform: `scaleY(${IDLE})`, transition: "background-color 400ms ease" }}
        />
      ))}
    </div>
  );
}
