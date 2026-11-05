import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BellSimple, BellSimpleSlash, EyeSlash, GearSix, Trash, X } from "@phosphor-icons/react";
import { springs } from "../../design/motion";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { settings } from "../../settings/store";
import { Button, Empty } from "../../ui/controls";
import { usePresenting } from "../privacy/store";
import { locale, t } from "../../i18n";
import { noticeSource } from "../../platform/services";
import { noticeText, shortTime } from "./format";
import { AppIcon, ProgressRing } from "./NoticePop";
import { clearHistory, deleteNotice, dismissPop, history, setAppRule, setNoticesEnabled } from "./store";

/** Notice history: newest first, with the app's logo, name, title, text and a short time. Kept in memory only. */
export function NoticesView() {
  const s = settings.use();
  const list = history.use();
  const presenting = usePresenting();
  const now = useMinuteTick();

  // The page shows them all; the closed notch need not repeat the latest one afterwards.
  useEffect(() => dismissPop(), []);

  if (!s.notices.enabled) {
    return (
      <Empty
        icon={BellSimple}
        title={t("Live-Mitteilungen sind aus")}
        text={t("Zeigt Mitteilungen von Windows und von notnotch-notify in der Notch. Alles bleibt auf diesem PC.")}
        action={<Button onClick={() => setNoticesEnabled(true)}>{t("Einschalten")}</Button>}
      />
    );
  }

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-1">
      <HeaderActions>
        <HeaderButton label={t("Mitteilungs-Einstellungen")} onClick={() => navigate("settings", "notices")}>
          <GearSix size={14} weight="bold" />
        </HeaderButton>
        <HeaderButton label={t("Alle löschen")} onClick={clearHistory} disabled={list.length === 0}>
          <Trash size={14} weight="bold" />
        </HeaderButton>
      </HeaderActions>
      {list.length === 0 ? (
        <Empty icon={BellSimple} title={t("Keine Mitteilungen")} text={t("Neue Mitteilungen erscheinen hier und bleiben bis zum Beenden von NotNotch.")} />
      ) : (
        <div className="-mx-1 flex-1 overflow-y-auto px-1 [scrollbar-width:none]">
          <AnimatePresence initial={false}>
            {list.map((n) => (
              <motion.div
                key={n.id}
                layout="position"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={springs.snappy}
                className="group overflow-hidden"
              >
                {/* A Windows notice opens its app, as a click on the toast would; notnotch-notify ones have no app to open. */}
                <div
                  className={`flex items-start gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-fill-1 ${n.source === "windows" ? "cursor-pointer" : ""}`}
                  role={n.source === "windows" ? "button" : undefined}
                  tabIndex={n.source === "windows" ? 0 : undefined}
                  title={n.source === "windows" ? t("{app} öffnen", { app: n.appName }) : undefined}
                  onClick={n.source === "windows" ? () => noticeSource.openApp(n.appId) : undefined}
                  onKeyDown={n.source === "windows" ? (e) => e.key === "Enter" && noticeSource.openApp(n.appId) : undefined}
                >
                  <div className="pt-0.5">
                    <AppIcon n={n} size={20} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-caption text-label-3">{n.appName}</span>
                      <span className="ms-auto shrink-0 tabular text-caption text-label-4">{shortTime(n.at, now, s.units.clock, t, locale())}</span>
                    </div>
                    {presenting ? (
                      <div className="text-body text-label-3">{t("Ausgeblendet")}</div>
                    ) : (
                      <>
                        {n.title && <div className="truncate text-body font-medium text-label">{n.title}</div>}
                        {noticeText(n, t) && <div className="line-clamp-2 text-caption whitespace-pre-line text-label-2">{noticeText(n, t)}</div>}
                      </>
                    )}
                  </div>
                  {n.progress !== null && n.progress !== undefined && (
                    <div className="pt-1">
                      <ProgressRing value={n.progress} size={16} />
                    </div>
                  )}
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <RowButton label={t("Stumm: nur hier anzeigen")} onClick={() => setAppRule(n.appId, "mute")}>
                      <BellSimpleSlash size={13} weight="bold" />
                    </RowButton>
                    <RowButton label={t("Von dieser App ausblenden")} onClick={() => setAppRule(n.appId, "hide")}>
                      <EyeSlash size={13} weight="bold" />
                    </RowButton>
                    <RowButton label={t("Löschen")} onClick={() => deleteNotice(n.id)}>
                      <X size={13} weight="bold" />
                    </RowButton>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function RowButton(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      className="pressable flex size-6 items-center justify-center rounded-full text-label-3 hover:bg-fill-2 hover:text-label"
    >
      {props.children}
    </button>
  );
}

/** Now, updated every 30 s while the page is open, for the short times. */
function useMinuteTick(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
