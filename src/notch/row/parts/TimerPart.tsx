import { Timer } from "@phosphor-icons/react";
import { formatClock, remainingOf, timer, useSecondTick } from "../../../features/timer/store";
import { measureText } from "../measure";
import { modeTint } from "../../../features/timer/looks";
import { settings } from "../../../settings/store";

const ICON = 17, GAP = 4;

/** Room for the longest the countdown can read: the full duration, every digit an 8 ("180:00" too). */
export const timerWidth = (duration: number) => ICON + GAP + measureText(formatClock(duration).replace(/\d/g, "8"));

/** A running timer: icon and countdown, in the focus colour (Settings, Timer) or green for a break. Finished, it belongs to the notices. */
export function TimerPart({ paused }: { paused: boolean }) {
  const s = timer.use();
  const color = settings.use().timer.color;
  // Ticks when the countdown's own second changes, not the wall clock's; not at all under a notice.
  const now = useSecondTick(s.endsAt !== null && !paused, (s.endsAt ?? 0) % 1000);
  return (
    <span className="flex shrink-0 items-center" style={{ gap: GAP, color: modeTint(s.mode, color) }}>
      <Timer size={ICON} weight="bold" className="shrink-0" />
      <span className="tabular whitespace-nowrap text-footnote font-medium" style={{ width: timerWidth(s.duration) - ICON - GAP }}>
        {formatClock(remainingOf(s, now))}
      </span>
    </span>
  );
}
