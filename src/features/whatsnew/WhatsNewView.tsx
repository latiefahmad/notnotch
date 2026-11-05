import { useEffect, useState } from "react";
import { Heart, Star } from "@phosphor-icons/react";
import { between, changelog, useUnseen } from "../../lib/changelog";
import { checkForUpdate, installUpdate, update } from "../../lib/update";
import { openSponsors, openStoreReview } from "../../platform/services";
import { t } from "../../i18n";
import { Button } from "../../ui/controls";
import { ChangelogList } from "./ChangelogList";
import type { WhatsNew } from "./model";
import { dismissWhatsNew, opened } from "./store";

/*
 *   New in NotNotch 1.0.1
 *   1.0.1                    8 Nov 2026
 *   · A month in the Calendar …
 *   ─────────────────────────────────────
 *   NotNotch is free … support it.   [♥ Support on GitHub]
 */
export function WhatsNewView() {
  const u = update.use();
  const unseen = useUnseen();
  // Opening the page marks its notice seen, which empties `unseen`: what to show is taken once, on mount.
  const [news] = useState<WhatsNew>(() => opened.get() ?? (unseen[0] ? { kind: "updated", version: unseen[0].version } : null));
  const [installed] = useState(() => (unseen.length ? unseen : changelog.filter((e) => e.version === u.current)));
  useEffect(() => {
    if (news) dismissWhatsNew(news);
  }, [news]);

  // The offer stays the page's subject even if the download fails or a check runs meanwhile; only the button follows the phase.
  const available = news?.kind === "available";
  const entries = available ? (u.notes && u.current ? between(u.notes, u.current, news.version) : []) : installed;
  const version = news?.version ?? u.current;
  // Left by closing, the page must not come back with this notice when the notch opens on it again.
  useEffect(() => () => opened.set(null), []);

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-3">
      <h2 className="px-3 pb-1 text-title font-semibold text-label">
        {available ? t("NotNotch {v} ist verfügbar", { v: version ?? "" }) : t("Neu in NotNotch {v}", { v: version ?? "" })}
      </h2>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 [scrollbar-width:none]" style={{ maskImage: "linear-gradient(180deg, #000 calc(100% - 20px), transparent)" }}>
        <ChangelogList entries={entries} />
      </div>
      <div className="mx-3 flex items-center gap-3 border-t border-separator pt-3">
        <p className="min-w-0 flex-1 text-caption text-label-3">{t("NotNotch ist kostenlos, ohne Werbung, und wird von einer Person entwickelt. Wenn es dir gefällt, kannst du es unterstützen.")}</p>
        {u.store && (
          <Button icon={Star} onClick={openStoreReview}>
            {t("NotNotch bewerten")}
          </Button>
        )}
        <Button icon={Heart} primary={!available} onClick={openSponsors}>
          {t("Auf GitHub unterstützen")}
        </Button>
        {available &&
          (u.phase === "downloading" ? (
            <span className="tabular shrink-0 text-footnote text-label-2">{t("Wird geladen … {n} %", { n: Math.round(u.progress * 100) })}</span>
          ) : u.phase === "available" ? (
            <Button primary onClick={() => void installUpdate()}>
              {t("Jetzt aktualisieren")}
            </Button>
          ) : (
            // A failed download, or a check under way: the offer has to be found again before it installs.
            <Button primary disabled={u.phase === "checking"} onClick={() => void checkForUpdate()}>
              {t("Erneut versuchen")}
            </Button>
          ))}
      </div>
    </div>
  );
}
