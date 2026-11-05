import { motion } from "motion/react";
import { ArrowClockwise, GithubLogo, SlidersHorizontal, WarningCircle } from "@phosphor-icons/react";
import { content, spin } from "../../design/motion";
import { formatAgo } from "../../lib/format";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { localDate, openGithubProfile } from "../../platform/services";
import { settings } from "../../settings/store";
import { Button, Empty, Skeleton } from "../../ui/controls";
import { locale, t } from "../../i18n";
import { shade, streaks, todayCount, weekColumns, type Day } from "./contributions";
import { github, refreshGithub, useGithubViewer } from "./store";

const WEEKS = 36;
const CELL = 10, GAP = 3;

export const githubError: Record<string, string> = {
  "not-found": "Diesen GitHub-Nutzer gibt es nicht",
  "token-rejected": "GitHub hat den Token abgelehnt, in den Einstellungen ersetzen oder löschen",
  "rate-limited": "GitHub drosselt gerade, später erneut",
  offline: "Keine Verbindung",
  parse: "GitHub-Seite nicht lesbar, ein Token in den Einstellungen hilft",
  failed: "Abruf fehlgeschlagen",
};

/*
 *   latiefahmad   626 in the last year   Today 3   Streak 5 days   Longest 21 days
 *   ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪
 *   ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪   (the last 36 weeks, Sunday on top)
 */
export function GithubView() {
  useGithubViewer();
  const user = settings.use().github.user.trim();
  const { data, error, loading } = github.use();

  const actions = (
    <HeaderActions>
      <HeaderButton label={t("Aktualisieren")} disabled={!user} onClick={() => void refreshGithub(true)}>
        <motion.span className="flex" animate={{ rotate: loading ? 360 : 0 }} transition={loading ? spin : { duration: 0 }}>
          <ArrowClockwise size={14} weight="bold" />
        </motion.span>
      </HeaderButton>
      <HeaderButton label={t("GitHub-Einstellungen")} onClick={() => navigate("settings", "github")}>
        <SlidersHorizontal size={14} weight="bold" />
      </HeaderButton>
    </HeaderActions>
  );

  if (!user) {
    return (
      <>
        {actions}
        <Empty
          icon={GithubLogo}
          title={t("Kein GitHub-Nutzer")}
          text={t("Trage deinen GitHub-Namen ein. Gelesen wird nur die öffentliche Seite, ohne Anmeldung.")}
          action={<Button onClick={() => navigate("settings", "github")}>{t("Nutzer eintragen")}</Button>}
        />
      </>
    );
  }
  if (!data) {
    return (
      <>
        {actions}
        {error ? (
          <Empty icon={WarningCircle} title={t(githubError[error] ?? "Abruf fehlgeschlagen")} action={<Button onClick={() => void refreshGithub(true)}>{t("Erneut versuchen")}</Button>} />
        ) : (
          <div className="flex h-full flex-col gap-3 px-5 pt-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
      </>
    );
  }

  const today = localDate(new Date());
  const { current, longest } = streaks(data.days, today);
  const days = (n: number) => t(n === 1 ? "{n} Tag" : "{n} Tage", { n });
  return (
    <motion.div
      className="flex h-full flex-col gap-3 px-5 pt-1 pb-2"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
    >
      {actions}
      <div className="flex items-baseline gap-5 text-caption text-label-3">
        <button
          title={t("Auf GitHub öffnen")}
          onClick={() => openGithubProfile(data.user)}
          className="pressable -mx-1 flex min-w-0 items-center gap-2 self-center rounded-full px-1 hover:bg-fill-1"
        >
          {/* GitHub redirects /<user>.png to the avatar; Rust only returns names that pass valid_user. */}
          <img
            src={`https://github.com/${data.user}.png?size=64`}
            alt=""
            className="size-5 shrink-0 rounded-full bg-fill-2"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
          <span className="truncate text-footnote font-semibold text-label">{data.user}</span>
        </button>
        <Stat label={t("Letztes Jahr")} value={data.total.toLocaleString(locale())} />
        <Stat label={t("Heute")} value={String(todayCount(data.days, today))} />
        <Stat label={t("Serie")} value={days(current)} />
        <Stat label={t("Längste")} value={days(longest)} />
      </div>
      <Heatmap days={data.days} today={today} />
      <div className="mt-auto text-caption text-label-4" title={error ? t(githubError[error] ?? "") : undefined}>
        {error ? t("Stand {ago}", { ago: formatAgo(Date.now() - data.fetchedAt) }) : formatAgo(Date.now() - data.fetchedAt)}
      </div>
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5">
      {label}
      <span className="tabular font-semibold text-label">{value}</span>
    </span>
  );
}

function dayTitle(d: Day): string {
  const date = new Date(`${d.date}T12:00:00`).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short" });
  if (d.count === 0 && d.level === 0) return t("Keine Beiträge am {date}", { date });
  if (d.count === 0) return date;
  return t(d.count === 1 ? "1 Beitrag am {date}" : "{n} Beiträge am {date}", { n: d.count, date });
}

function Heatmap({ days, today }: { days: Day[]; today: string }) {
  const weeks = weekColumns(days, today, WEEKS);
  return (
    <div className="flex" style={{ gap: GAP }} role="img" aria-label={t("Beiträge der letzten {n} Wochen", { n: WEEKS })}>
      {weeks.map((week, w) => (
        <div key={w} className="flex flex-col" style={{ gap: GAP }}>
          {week.map((d, i) =>
            d ? (
              <span key={i} title={dayTitle(d)} className="rounded-[2.5px]" style={{ width: CELL, height: CELL, background: shade(d.level) }} />
            ) : (
              <span key={i} style={{ width: CELL, height: CELL }} />
            ),
          )}
        </div>
      ))}
    </div>
  );
}
