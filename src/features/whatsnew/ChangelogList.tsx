import { motion } from "motion/react";
import { content } from "../../design/motion";
import { locale, t } from "../../i18n";
import type { ChangelogEntry } from "../../platform/services";

/** Versions with their date and items, newest first; `fresh` marks the ones not seen before. Settings and What's new. */
export function ChangelogList({ entries, fresh }: { entries: ChangelogEntry[]; fresh?: Set<string> }) {
  const date = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", year: "numeric" });
  return (
    <div className="flex flex-col gap-3 px-3 pt-1.5 pb-3">
      {entries.map((e, i) => (
        <motion.div
          key={e.version}
          initial={{ opacity: 0, transform: "translateY(4px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)" }}
          transition={{ ...content.enter, delay: 0.04 * Math.min(i, 6) }}
        >
          <div className="flex items-baseline gap-1.5 text-caption">
            <span className="tabular font-semibold text-label">{e.version}</span>
            {fresh?.has(e.version) && <span className="font-medium text-link">{t("Neu")}</span>}
            <span className="ms-auto text-label-3">{date.format(new Date(`${e.date}T12:00:00`))}</span>
          </div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {e.items.map((item, j) => (
              <li key={j} className={`flex gap-2 text-footnote ${item.highlight ? "font-semibold text-label" : "text-label-2"}`}>
                <span aria-hidden className={`mt-[7px] size-[3px] shrink-0 rounded-full ${item.highlight ? "bg-label" : "bg-label-3"}`} />
                <span>{item.en}</span>
              </li>
            ))}
          </ul>
        </motion.div>
      ))}
    </div>
  );
}
