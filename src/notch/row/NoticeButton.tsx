import { useEffect, useRef, type ReactNode } from "react";
import { noticeHover } from "../useNotchState";

/**
 * Pointer handlers for a button inside a closed-notch notice: while the pointer is on it, hovering does not open
 * the notch; after a click that holds until the pointer leaves the notch, so the notch does not open under it.
 */
export function useNoticeHover() {
  const over = useRef(false), used = useRef(false);
  // Only the button the pointer is on may let go, and not after it was used.
  const release = () => {
    if (over.current && !used.current) noticeHover.set(false);
    over.current = false;
  };
  useEffect(() => release, []);
  return {
    onPointerEnter: () => {
      over.current = true;
      used.current = false;
      noticeHover.set(true);
    },
    onPointerLeave: release,
    used: () => void (used.current = true),
  };
}

/** Diameter in CSS px, for the notice width. */
export const NOTICE_BUTTON = 22;

/** Side padding of a button that shows its label as text (`wide`). */
export const NOTICE_BUTTON_PAD = 8;

/** A small round button in a closed-notch notice: acts without opening the notch. `wide` shows `children` as a text pill. */
export function NoticeButton({ label, onClick, children, wide }: { label: string; onClick: () => void; children: ReactNode; wide?: boolean }) {
  const hover = useNoticeHover();
  return (
    <button
      aria-label={label}
      title={label}
      className="pressable pointer-events-auto flex shrink-0 items-center justify-center rounded-full bg-fill-2 text-label hover:bg-fill-3"
      style={wide ? { height: NOTICE_BUTTON, paddingInline: NOTICE_BUTTON_PAD } : { width: NOTICE_BUTTON, height: NOTICE_BUTTON }}
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
      onClick={(e) => {
        e.stopPropagation();
        hover.used();
        onClick();
      }}
    >
      {children}
    </button>
  );
}
