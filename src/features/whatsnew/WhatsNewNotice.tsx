import type { ReactNode } from "react";
import { ArrowCircleUp, Gift, X } from "@phosphor-icons/react";
import { openOn } from "../../notch/nav";
import { measureText } from "../../notch/row/measure";
import { Marquee } from "../../notch/row/Marquee";
import { NOTICE_BUTTON as BUTTON, NoticeButton } from "../../notch/row/NoticeButton";
import { t } from "../../i18n";
import type { WhatsNew } from "./model";
import { dismissWhatsNew, opened } from "./store";

const ICON = 17, GAP = 6, TEXT_MAX = 260;

/** "NotNotch 1.0.1 · What's new" or "NotNotch 1.0.1 available" with a dismiss button, for the closed notch. A click on the text opens the page. */
export function whatsNewNotice(news: NonNullable<WhatsNew>): { width: number; key: string; body: ReactNode } {
  const available = news.kind === "available";
  const text = available ? t("NotNotch {v} verfügbar", { v: news.version }) : t("NotNotch {v} · Neuerungen", { v: news.version });
  const textW = measureText(text), shown = Math.min(textW, TEXT_MAX);
  const Icon = available ? ArrowCircleUp : Gift;
  return {
    width: ICON + shown + BUTTON + 3 * GAP,
    key: `whatsnew:${news.kind}:${news.version}`,
    body: (
      <span className="flex h-full items-center" style={{ gap: GAP }}>
        {/* Not stopped: the click also opens the notch, on the page. */}
        <button
          className="pointer-events-auto flex h-full items-center"
          style={{ gap: GAP }}
          onClick={() => {
            opened.set(news);
            openOn("whatsnew");
          }}
        >
          <Icon size={ICON} weight="fill" style={{ color: "var(--color-link)" }} />
          <Marquee text={text} textWidth={textW} width={shown} paused={false} once />
        </button>
        <NoticeButton label={t("Ausblenden")} onClick={() => dismissWhatsNew(news)}>
          <X size={12} weight="bold" />
        </NoticeButton>
      </span>
    ),
  };
}
