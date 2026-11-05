import { shade, todayCount } from "../../../features/github/contributions";
import { github } from "../../../features/github/store";
import { localDate } from "../../../platform/services";
import { measureText } from "../measure";
import { t } from "../../../i18n";

/** Today's count and shade once the calendar has loaded (the GitHub store polls while the part is on screen). */
export function useGithubToday(): { count: number; level: number } | null {
  const { data } = github.use();
  if (!data) return null;
  const today = localDate(new Date());
  return { count: todayCount(data.days, today), level: data.days.find((d) => d.date === today)?.level ?? 0 };
}

const SQUARE = 10, GAP = 5;

/** Room for the square and the count. */
export const githubWidth = (count: number) => SQUARE + GAP + measureText("8".repeat(String(count).length));

/** Today's GitHub contributions: a square in today's shade and the count. */
export function GithubPart({ count, level }: { count: number; level: number }) {
  return (
    <span className="flex items-center whitespace-nowrap text-footnote font-medium text-label" style={{ gap: GAP }} title={t("GitHub-Beiträge heute")}>
      <span className="shrink-0 rounded-[2.5px]" style={{ width: SQUARE, height: SQUARE, background: count || level ? shade(Math.max(1, level)) : shade(0) }} />
      <span className="tabular">{count}</span>
    </span>
  );
}
