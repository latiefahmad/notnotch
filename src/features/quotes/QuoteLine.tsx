import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import { t } from "../../i18n";
import { QUOTES, quoteIndex } from "./quotes";

/** Height Overview grows by while the line shows (src/notch/tabs.ts): the 14 px line and the 10 px gap above it. */
export const QUOTE_LINE_H = 24;

/** Next presses survive closing the notch, until the app restarts. */
let skip = 0;

/** One line: the day's quote and its author, Next for another. The full source shows on hover. */
export function QuoteLine() {
  const [n, setN] = useState(skip);
  const q = QUOTES[quoteIndex(Date.now(), n)];
  return (
    <div className="flex h-[14px] shrink-0 items-center gap-2" title={`${q.text} (${q.author}, ${q.source})`}>
      <div className="relative min-w-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.p
            key={n}
            className="truncate text-caption text-label-3"
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          >
            <span className="text-label-2 italic">{q.text}</span> · {q.author}
          </motion.p>
        </AnimatePresence>
      </div>
      <button
        aria-label={t("Nächstes Zitat")}
        title={t("Nächstes Zitat")}
        onClick={() => setN((skip = n + 1))}
        className="pressable flex size-4 shrink-0 items-center justify-center rounded-full text-label-3 hover:text-label-2"
      >
        <ArrowRight size={11} weight="bold" className="rtl:-scale-x-100" />
      </button>
    </div>
  );
}
