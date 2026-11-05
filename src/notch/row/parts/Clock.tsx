import { useEffect, useState } from "react";
import { useSecondTick } from "../../../features/timer/store";
import { measureText } from "../measure";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Fixed room: every digit as wide as an 8, and the wider of AM and PM on a 12 h clock. */
export function clockWidth(seconds: boolean, h12: boolean): number {
  const base = seconds ? "88:88:88" : "88:88";
  return h12 ? Math.max(measureText(`${base} AM`), measureText(`${base} PM`)) : measureText(base);
}

/** Re-renders once a minute, 50 ms after it turns. */
function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const next = () => {
      const t = Date.now();
      setNow(t);
      id = window.setTimeout(next, 60_000 - (t % 60_000) + 50);
    };
    next();
    return () => window.clearTimeout(id);
  }, [active]);
  return now;
}

/** `paused` (under a notice) stops the ticking; it catches up on the first tick after. */
export function Clock({ seconds, h12, paused }: { seconds: boolean; h12: boolean; paused: boolean }) {
  const minute = useMinuteTick(!seconds && !paused), second = useSecondTick(seconds && !paused);
  const d = new Date(seconds ? second : minute), h = d.getHours();
  const time = `${h12 ? h % 12 || 12 : pad2(h)}:${pad2(d.getMinutes())}${seconds ? `:${pad2(d.getSeconds())}` : ""}${h12 ? (h < 12 ? " AM" : " PM") : ""}`;
  return (
    <span className="tabular block whitespace-nowrap text-center text-footnote font-medium text-label" style={{ width: clockWidth(seconds, h12) }}>
      {time}
    </span>
  );
}
