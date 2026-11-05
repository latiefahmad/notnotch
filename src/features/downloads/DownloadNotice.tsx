import type { ReactNode } from "react";
import { CheckCircle, FolderOpen, Tray } from "@phosphor-icons/react";
import { measureText } from "../../notch/row/measure";
import { Marquee } from "../../notch/row/Marquee";
import { NOTICE_BUTTON as BUTTON, NoticeButton } from "../../notch/row/NoticeButton";
import { revealFile, type DownloadFinished } from "../../platform/services";
import { addToShelf } from "../shelf/ShelfView";
import { t } from "../../i18n";
import { dismissDownload } from "./store";

const ICON = 17, GAP = 6, TEXT_MAX = 240;

/** "Downloaded report.pdf" with Show in folder and Add to Shelf, for the closed notch. */
export function downloadNotice(d: DownloadFinished & { at: number }): { width: number; key: string; body: ReactNode } {
  const text = t("{name} heruntergeladen", { name: d.name });
  const textW = measureText(text), shown = Math.min(textW, TEXT_MAX);
  return {
    width: ICON + shown + 2 * BUTTON + 3 * GAP,
    key: `download:${d.at}`,
    body: (
      <span className="flex h-full items-center" style={{ gap: GAP }}>
        <CheckCircle size={ICON} weight="fill" className="shrink-0" style={{ color: "var(--color-green)" }} />
        <Marquee text={text} textWidth={textW} width={shown} paused={false} once />
        <NoticeButton label={t("Im Ordner zeigen")} onClick={() => { revealFile(d.path); dismissDownload(); }}>
          <FolderOpen size={12} weight="fill" />
        </NoticeButton>
        <NoticeButton label={t("Zur Ablage hinzufügen")} onClick={() => { addToShelf([d.path]); dismissDownload(); }}>
          <Tray size={12} weight="fill" />
        </NoticeButton>
      </span>
    ),
  };
}
