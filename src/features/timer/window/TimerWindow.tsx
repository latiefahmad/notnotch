import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Pause, Play, X } from "@phosphor-icons/react";
import { content, pulse } from "../../../design/motion";
import { settings } from "../../../settings/store";
import { closeTimerWindow } from "../../../platform/services";
import { isNative } from "../../../platform/native";
import { timer, timerActions, useRemaining } from "../store";
import { POS_KEY } from "../detach";
import { Look } from "../Look";
import { modeTint } from "../looks";
import { t } from "../../../i18n";

/*
 *   ╭──────────────────────────────────╮
 *   │  24:59  ━━━━━━━━━━━━━━━━   [⏯]  │   drag anywhere to move
 *   │                            [✕]  │   ✕ only closes this window
 *   ╰──────────────────────────────────╯
 */
export function TimerWindow() {
  const s = timer.use();
  const { timer: timerSettings, alarm } = settings.use();
  const look = timerSettings.look;
  const remaining = useRemaining(look === "hud");
  const running = s.endsAt !== null;
  const tint = modeTint(s.mode, timerSettings.color);

  // Finished: pulse about as long as the alarm rings (same rule as in store.ts), then stay dimmed.
  // Ringing itself lives in the notch window only.
  const reduced = useReducedMotion();
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    if (!s.finished) return setPulsing(false);
    setPulsing(true);
    const id = window.setTimeout(() => setPulsing(false), (alarm.duration === -1 ? 120 : Math.max(3, alarm.duration)) * 1000);
    return () => window.clearTimeout(id);
  }, [s.finished, alarm.duration]);

  // Remember where it was put; Rust checks the spot is still on a monitor next time.
  useEffect(() => {
    if (!isNative) return;
    const off = getCurrentWindow().onMoved(({ payload }) => {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x: payload.x, y: payload.y }));
      } catch {
        // Storage full or blocked: it opens at the default spot next time.
      }
    });
    return () => void off.then((f) => f());
  }, []);

  return (
    <div className="h-full p-1.5">
      <div
        className="group flex h-full items-center gap-3 rounded-[20px] bg-notch pe-2.5 ps-4 ring-1 ring-fill-2"
        onMouseDown={(e) => {
          if (e.button === 0 && isNative && !(e.target as Element).closest("button")) void getCurrentWindow().startDragging();
        }}
      >
        <motion.div
          className="flex min-w-0 flex-1"
          animate={{ opacity: s.finished ? (pulsing && !reduced ? [1, 0.45] : 0.6) : 1 }}
          transition={s.finished && pulsing && !reduced ? pulse : content.enter}
        >
          <Look look={look} remaining={s.finished ? 0 : remaining} duration={s.duration} running={running} mode={s.mode} tint={tint} h={40} />
        </motion.div>
        <div className="flex flex-col gap-1">
          <SmallButton
            label={s.finished ? t("Schließen") : running ? t("Pause") : t("Start")}
            onClick={s.finished ? timerActions.dismiss : running ? timerActions.pause : timerActions.start}
            tint={tint}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={s.finished ? "done" : running ? "pause" : "play"}
                className="flex"
                initial={{ opacity: 0, transform: "scale(0.6)" }}
                animate={{ opacity: 1, transform: "scale(1)" }}
                exit={{ opacity: 0, transform: "scale(0.6)" }}
                transition={content.exit}
              >
                {s.finished ? <Check size={13} weight="bold" /> : running ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
              </motion.span>
            </AnimatePresence>
          </SmallButton>
          <SmallButton label={t("Timer-Fenster schließen")} onClick={() => void closeTimerWindow()}>
            <X size={11} weight="bold" />
          </SmallButton>
        </div>
      </div>
    </div>
  );
}

function SmallButton(props: { label: string; onClick: () => void; tint?: string; children: ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className="pressable pressable-fill flex size-7 items-center justify-center rounded-full bg-fill-1 text-label-2 hover:text-label"
      style={props.tint ? { color: props.tint, backgroundColor: `color-mix(in srgb, ${props.tint} 18%, transparent)` } : undefined}
    >
      {props.children}
    </button>
  );
}
