import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { MicrophoneStage } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import { media, type NowPlaying } from "../../platform/media";
import { settings } from "../../settings/store";
import { linesOf, useAskTranslation, useLyricIndex, useLyrics, useRomanized } from "./lyrics";
import type { LyricWord } from "./lrc";
import { t } from "../../i18n";

/** Height the panel adds to the notch (separator included). */
export const LYRICS_PANEL = 136;
/** After the wheel moves the list, it stays where the user put it this long. */
const HOLD_SCROLL_MS = 3000;

/**
 * Synced lyrics under the controls: the sung line bright and centred, the others dim, scrolling along by itself. With
 * word timing the sung line lights up word by word; translation and romanisation sit small under each line when on.
 * A click on a line jumps there when the player allows seeking.
 */
export function LyricsPanel({ np }: { np: NowPlaying }) {
  const music = settings.use().music;
  const state = useLyrics(np, true);
  // Translation first: a romanisation arriving later must not restart the request to the provider.
  const lines = useRomanized(useAskTranslation(np, linesOf(state), music.lyricTranslation && music.lyricAskTranslation), music.lyricRoman);
  const index = useLyricIndex(lines, np);
  const list = useRef<HTMLDivElement>(null);
  const userScrolledAt = useRef(0);

  useEffect(() => {
    const el = list.current;
    if (!el || performance.now() - userScrolledAt.current < HOLD_SCROLL_MS) return;
    const row = el.children[Math.max(0, index)] as HTMLElement | undefined;
    if (row) el.scrollTo({ top: row.offsetTop - (el.clientHeight - row.offsetHeight) / 2, behavior: "smooth" });
  }, [index, lines]);

  const message =
    state?.kind === "loading" ? t("Songtext wird gesucht …")
    : state?.kind === "instrumental" ? t("Instrumental")
    : state?.kind === "offline" ? t("Die Songtext-Quellen sind gerade nicht erreichbar")
    : state?.kind === "skipped" ? t("Songtexte nur für Songs bis 20 Minuten mit bekannter Länge")
    : state?.kind === "nosource" ? t("Keine Songtext-Quelle ist an")
    : !lines ? t("Kein synchronisierter Songtext für diesen Song")
    : null;

  return (
    <motion.div
      className="flex min-h-0 flex-1 flex-col"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: { ...content.enter, delay: 0.06 } }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      <div className="mx-0.5 mt-2 mb-1 h-px shrink-0 bg-separator" />
      {message ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-footnote text-label-3">
          <MicrophoneStage size={14} weight="bold" />
          {message}
        </div>
      ) : (
        <div
          ref={list}
          className="relative min-h-0 flex-1 overflow-y-auto py-10 [scrollbar-width:none]"
          style={{ maskImage: "linear-gradient(180deg, transparent, #000 28%, #000 72%, transparent)" }}
          onWheel={() => (userScrolledAt.current = performance.now())}
        >
          {lines!.map((line, i) => (
            <button
              key={i}
              disabled={!np.canSeek}
              onClick={() => media.seek(line.time)}
              className={`block w-full px-2 py-[3px] text-center text-body font-semibold leading-snug transition-colors duration-300 enabled:cursor-pointer ${
                i === index ? "text-label" : "text-label-4 enabled:hover:text-label-2"
              }`}
            >
              {i === index && line.words && music.lyricWords ? <SungWords words={line.words} np={np} /> : line.text || "•••"}
              {music.lyricRoman && line.roman && <span className="block text-footnote font-medium opacity-70">{line.roman}</span>}
              {music.lyricTranslation && line.translation && <span className="block text-footnote font-medium opacity-70">{line.translation}</span>}
            </button>
          ))}
        </div>
      )}
    </motion.div>
  );
}

/** The sung line, word by word: words already sung bright, the rest dim. Only this line re-renders per word. */
function SungWords({ words, np }: { words: LyricWord[]; np: NowPlaying }) {
  const word = useLyricIndex(words, np);
  return words.map((w, j) => (
    <span key={j} className={`transition-colors duration-200 ${j <= word ? "text-label" : "text-label-3"}`}>
      {w.text}
    </span>
  ));
}
