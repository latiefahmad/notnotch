// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/ColorMath.cs and src/BrimDeck/SettingsThemeEditor.cs.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { TextField } from "../../ui/controls";
import { t } from "../../i18n";
import { fromHsv, parseColor, toHex, toHsv, type Rgba } from "./color";

/**
 * Colour picker: a saturation and brightness square, a hue strip and a hex field. Drawn in the
 * page instead of the browser's picker, which opens a window of its own and would close the notch.
 * Arrow keys move both (Shift for bigger steps).
 */
export function ColorPicker({ value, onChange, swatches }: { value: Rgba; onChange: (c: Rgba) => void; swatches: string[] }) {
  const [hsv, setHsv] = useState(() => toHsv(value));
  const [hex, setHex] = useState(toHex(value));
  // A colour from outside (undo, another key): follow it, but keep our own hue for grays.
  useEffect(() => {
    if (toHex(fromHsv(...hsv)) === toHex(value)) return;
    const [h, s, v] = toHsv(value);
    setHsv([s === 0 ? hsv[0] : h, s, v]);
    setHex(toHex(value));
  }, [value]); // hsv is read, not a dependency: only an outside change moves the picker

  const set = (next: [number, number, number]) => {
    setHsv(next);
    const c = fromHsv(...next);
    setHex(toHex(c));
    onChange(c);
  };

  const square = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const fromSquare = (e: PointerEvent) => {
    const r = square.current!.getBoundingClientRect();
    set([hsv[0], clamp01((e.clientX - r.left) / r.width), 1 - clamp01((e.clientY - r.top) / r.height)]);
  };
  const fromStrip = (e: PointerEvent) => {
    const r = strip.current!.getBoundingClientRect();
    set([clamp01((e.clientX - r.left) / r.width) * 360, hsv[1], hsv[2]]);
  };
  const drag = (handler: (e: PointerEvent) => void) => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      handler(e);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => e.currentTarget.hasPointerCapture(e.pointerId) && handler(e),
  });
  const keys = (e: KeyboardEvent, dx: (d: number) => void, dy?: (d: number) => void) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const map: Record<string, () => void> = {
      ArrowLeft: () => dx(-step),
      ArrowRight: () => dx(step),
      ArrowUp: () => dy?.(step),
      ArrowDown: () => dy?.(-step),
    };
    if (!map[e.key]) return;
    e.preventDefault();
    map[e.key]();
  };

  const [h, s, v] = hsv;
  return (
    <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
      <div
        ref={square}
        role="slider"
        tabIndex={0}
        aria-label={t("Sättigung und Helligkeit")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(s * 100)}
        aria-valuetext={t("Sättigung {s} %, Helligkeit {v} %", { s: Math.round(s * 100), v: Math.round(v * 100) })}
        className="relative h-24 w-full cursor-crosshair touch-none rounded-[8px] outline-none forced-color-adjust-none focus-visible:ring-1 focus-visible:ring-label-3"
        style={{ background: `linear-gradient(to top, black, transparent), linear-gradient(to right, white, hsl(${h} 100% 50%))` }}
        {...drag(fromSquare)}
        onKeyDown={(e) =>
          keys(
            e,
            (d) => set([h, clamp01(s + d), v]),
            (d) => set([h, s, clamp01(v + d)]),
          )
        }
      >
        <span
          aria-hidden
          className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white shadow-[0_0_0_3px_rgb(0_0_0/0.35)]"
          style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: toHex(fromHsv(h, s, v)) }}
        />
      </div>
      <div
        ref={strip}
        role="slider"
        tabIndex={0}
        aria-label={t("Farbton")}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(h)}
        className="relative h-3 w-full cursor-pointer touch-none rounded-full outline-none forced-color-adjust-none focus-visible:ring-1 focus-visible:ring-label-3"
        style={{ background: `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360].map((x) => `hsl(${x} 100% 50%)`).join(", ")})` }}
        {...drag(fromStrip)}
        onKeyDown={(e) => keys(e, (d) => set([(h + d * 360 + 360) % 360, s, v]))}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white shadow-[0_0_0_3px_rgb(0_0_0/0.35)]"
          style={{ left: `${(h / 360) * 100}%`, background: `hsl(${h} 100% 50%)` }}
        />
      </div>
      <div className="flex items-center gap-2">
        <TextField
          value={hex}
          width="w-24"
          onChange={(text) => {
            setHex(text);
            const c = parseColor(text.startsWith("#") ? text : `#${text}`);
            if (c && /^#?[0-9a-f]{6}$/i.test(text.trim())) {
              const next = toHsv(c);
              setHsv([next[1] === 0 ? h : next[0], next[1], next[2]]);
              onChange({ ...c, a: 1 });
            }
          }}
        />
        <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
          {swatches.map((sw) => (
            <button
              key={sw}
              aria-label={sw}
              title={sw}
              onClick={() => {
                const c = parseColor(sw);
                if (c) set(toHsv(c));
              }}
              className="pressable size-5 rounded-full ring-1 ring-separator forced-color-adjust-none"
              style={{ background: sw }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
