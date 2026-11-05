import type { ReactNode } from "react";
import { Drop, Plus, X } from "@phosphor-icons/react";
import { openOn } from "../../notch/nav";
import { measureText } from "../../notch/row/measure";
import { Marquee } from "../../notch/row/Marquee";
import { NOTICE_BUTTON as BUTTON, NoticeButton } from "../../notch/row/NoticeButton";
import { t } from "../../i18n";
import { todayTotal } from "./water";
import { water, waterActions } from "./store";
import { formatMl } from "./format";

const ICON = 17, GAP = 6, TEXT_MAX = 260;

/** "Time to drink · 750 ml / 2 L" with Drink and Later, for the closed notch. A click on the text opens Water. */
export function waterNotice(goalMl: number): { width: number; key: string; body: ReactNode } {
  const total = todayTotal(water.get().log, Date.now());
  const text = `${t("Zeit zu trinken")} · ${formatMl(total)} / ${formatMl(goalMl)}`;
  const textW = measureText(text), shown = Math.min(textW, TEXT_MAX);
  return {
    width: ICON + shown + 2 * BUTTON + 4 * GAP,
    key: "water",
    body: (
      <span className="flex h-full items-center" style={{ gap: GAP }}>
        {/* Not stopped: the click also opens the notch, on Water even while a timer or call runs. */}
        <button className="pointer-events-auto flex h-full items-center" style={{ gap: GAP }} onClick={() => openOn("water")}>
          <Drop size={ICON} weight="fill" style={{ color: "var(--color-link)" }} />
          <Marquee text={text} textWidth={textW} width={shown} paused={false} once />
        </button>
        <NoticeButton label={t("Trinken")} onClick={() => waterActions.drink()}>
          <Plus size={12} weight="bold" />
        </NoticeButton>
        <NoticeButton label={t("Später")} onClick={waterActions.dismiss}>
          <X size={12} weight="bold" />
        </NoticeButton>
      </span>
    ),
  };
}
