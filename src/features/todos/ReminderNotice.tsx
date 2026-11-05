import type { ReactNode } from "react";
import { motion } from "motion/react";
import { AlarmIcon, Check, ClockClockwise } from "@phosphor-icons/react";
import { pulse } from "../../design/motion";
import { openOn } from "../../notch/nav";
import { ROW } from "../../notch/row/layout";
import { measureText } from "../../notch/row/measure";
import { Marquee } from "../../notch/row/Marquee";
import { NOTICE_BUTTON as BUTTON, NoticeButton } from "../../notch/row/NoticeButton";
import { t } from "../../i18n";
import { todoActions } from "./store";
import { colorVar } from "./colors";
import type { Task } from "./model";

const ICON = 17, GAP = 6, TEXT_MAX = 300;

/** "Time's up · task" with snooze and done, for the closed notch. A click on the text opens the To-dos. */
export function reminderNotice(due: Task[]): { width: number; key: string; body: ReactNode } {
  const task = due[0];
  const more = due.length > 1 ? ` · ${t("+{n} weitere", { n: due.length - 1 })}` : "";
  const text = `${t("Zeit ist um")} · ${task.text}${more}`;
  const textW = measureText(text), room = Math.min(TEXT_MAX, ROW.maxSurface - 2 * ROW.insetNotch - ICON - 2 * BUTTON - 4 * GAP);
  const shown = Math.min(textW, room);
  return {
    width: ICON + shown + 2 * BUTTON + 4 * GAP,
    key: `reminder:${task.id}:${task.alertAt}`,
    body: (
      <span className="flex h-full items-center" style={{ gap: GAP }}>
        {/* Not stopped: the click also opens the notch, which then lands on the To-dos. */}
        <button className="pointer-events-auto flex h-full items-center" style={{ gap: GAP }} onClick={() => openOn("todos")}>
          <motion.span className="flex" style={{ color: colorVar(task.color) ?? "var(--color-orange)" }} animate={{ opacity: [1, 0.45] }} transition={{ ...pulse, repeat: 5 }}>
            <AlarmIcon size={ICON} weight="fill" />
          </motion.span>
          <Marquee text={text} textWidth={textW} width={shown} paused={false} once />
        </button>
        <NoticeButton label={t("10 Min. später")} onClick={() => todoActions.snooze(task.id)}>
          <ClockClockwise size={12} weight="bold" />
        </NoticeButton>
        <NoticeButton label={t("Erledigt")} onClick={() => todoActions.done(task.id)}>
          <Check size={12} weight="bold" />
        </NoticeButton>
      </span>
    ),
  };
}
