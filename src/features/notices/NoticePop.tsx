import type { ReactNode } from "react";
import { t } from "../../i18n";
import { Marquee } from "../../notch/row/Marquee";
import { measureText } from "../../notch/row/measure";
import { popLine } from "./format";
import type { Notice } from "./history";

const ICON = 16, GAP = 6, NAME_MAX = 76, RING = 14;

/** The app's logo, or its initial when Windows gave none (notnotch-notify, desktop programs without a logo). */
export function AppIcon({ n, size }: { n: Pick<Notice, "icon" | "appName">; size: number }) {
  if (n.icon) return <img src={n.icon} alt="" width={size} height={size} className="shrink-0 rounded-[4px] object-contain" draggable={false} />;
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-[4px] bg-fill-3 font-semibold text-label-2"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }}
    >
      {(n.appName.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

export function ProgressRing({ value, size }: { value: number; size: number }) {
  const r = size / 2 - 1.5, c = 2 * Math.PI * r, f = Math.min(1, Math.max(0, value / 100));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90" role="img" aria-label={`${Math.round(value)} %`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-fill-3)" strokeWidth={2} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-label)" strokeWidth={2} strokeDasharray={`${c * f} ${c}`} strokeLinecap="round" />
    </svg>
  );
}

/** Content of a notice in the closed notch: logo, app name, then title and text scrolling once. `max` is the widest it may be. */
export function noticePop(n: Notice, max: number): { width: number; key: string; body: ReactNode } {
  const text = popLine(n, t);
  const ring = n.progress !== null && n.progress !== undefined;
  const nameW = Math.min(NAME_MAX, measureText(n.appName)), textW = measureText(text);
  const fixed = ICON + GAP + nameW + GAP + (ring ? RING + GAP : 0);
  const room = Math.max(0, max - fixed);
  return {
    width: fixed + Math.min(textW, room),
    // A progress update keeps the key, so it changes in place instead of fading out and in.
    key: `notice:${n.replace ? `${n.appId}:${n.replace}` : n.id}`,
    body: (
      <span className="flex h-full items-center" style={{ gap: GAP }}>
        <AppIcon n={n} size={ICON} />
        <span className="truncate text-footnote font-medium text-label-2" style={{ width: nameW }}>{n.appName}</span>
        <Marquee key={text} text={text} textWidth={textW} width={Math.min(textW, room)} paused={false} once />
        {ring && <ProgressRing value={n.progress ?? 0} size={RING} />}
      </span>
    ),
  };
}
