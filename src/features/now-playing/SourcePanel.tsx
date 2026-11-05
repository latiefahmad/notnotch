import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { CaretUpDown, Check, PushPinSimple } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import { media, type NowPlaying, type SourceInfo } from "../../platform/media";
import { settings } from "../../settings/store";
import { MIXER_MAX_ROWS, MIXER_ROW } from "./Mixer";
import { setMusic } from "./music";
import { offersSources, sourceName, sourceRows } from "./sources";
import { t } from "../../i18n";

/** Rows of the player menu, for the notch's height. */
export const sourcePanelRows = (np: NowPlaying, pinned: string | null) => Math.min(MIXER_MAX_ROWS, sourceRows(np.sources, pinned).length);

/** Left of the controls when several players have a session: the shown app's name, opens the menu. */
export function SourceToggle({ np, open, onToggle }: { np: NowPlaying; open: boolean; onToggle: () => void }) {
  const pinned = settings.use().music.pinned;
  if (!offersSources(np.sources, pinned)) return null;
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      title={t("Player wählen")}
      className={`pressable pressable-fill flex h-7 max-w-full min-w-0 items-center gap-1 rounded-full px-2.5 text-caption font-medium transition-colors duration-150 ${
        open ? "bg-fill-2 text-label" : "text-label-3 hover:text-label-2"
      }`}
    >
      {pinned && <PushPinSimple size={11} weight="fill" className="shrink-0" />}
      <span className="truncate">{sourceName(np.appId)}</span>
      <CaretUpDown size={11} weight="bold" className="shrink-0" />
    </button>
  );
}

/**
 * Automatic, or one app pinned: a pinned app stays in the notch even while another one plays, until Automatic is
 * picked again. A pinned app that was closed stays listed as not running.
 */
export function SourcePanel({ np }: { np: NowPlaying }) {
  const pinned = settings.use().music.pinned;
  const [tracks, setTracks] = useState<SourceInfo[]>([]);
  // Titles are read when the menu opens and whenever the sessions change, not on every poll.
  const ids = np.sources.map((s) => `${s.appId}:${s.isPlaying}`).join();
  useEffect(() => {
    let alive = true;
    void media.sources().then((list) => alive && setTracks(list));
    return () => {
      alive = false;
    };
  }, [ids, np.title]);

  const rows = sourceRows(np.sources, pinned);
  return (
    <motion.div
      className="flex min-h-0 flex-1 flex-col"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: { ...content.enter, delay: 0.06 } }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      <div className="mx-0.5 mt-2 mb-1.5 h-px shrink-0 bg-separator" />
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 [scrollbar-width:none]" role="listbox" aria-label={t("Player wählen")}>
        {rows.map((row) => {
          const track = row.appId ? tracks.find((s) => s.appId === row.appId) : null;
          const detail = !row.appId
            ? t("Zeigt, was gerade spielt")
            : !row.running
              ? t("Läuft nicht")
              : [track?.title, track?.artist].filter(Boolean).join(" · ");
          return (
            <button
              key={row.appId ?? "auto"}
              role="option"
              aria-selected={row.checked}
              onClick={() => setMusic({ pinned: row.appId })}
              className="pressable flex w-full items-center gap-2.5 rounded-[10px] px-2 text-start hover:bg-fill-1"
              style={{ height: MIXER_ROW }}
            >
              <span className={`size-1.5 shrink-0 rounded-full ${row.isPlaying ? "bg-accent" : "bg-label-4"} ${row.appId ? "" : "opacity-0"}`} />
              <span className={`w-28 shrink-0 truncate text-footnote ${row.checked ? "font-medium text-label" : "text-label-2"}`}>
                {row.appId ? row.name : t("Automatisch")}
              </span>
              <span className="min-w-0 flex-1 truncate text-caption text-label-3">{detail}</span>
              {row.checked && <Check size={13} weight="bold" className="shrink-0 text-label" />}
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}
