import { t } from "../../i18n";

/** Split out of UsageView, so NoticeLayer's usage notice in the closed row doesn't pull the whole tool view into the startup bundle. */
const windowLabels: Record<string, string> = {
  session: "Session",
  weekly: "Woche",
  "weekly-opus": "Woche · Opus",
  "weekly-sonnet": "Woche · Sonnet",
  "session-3p": "Session · Claude/GPT",
  "weekly-3p": "Woche · Claude/GPT",
  daily: "Heute",
  monthly: "Monat",
  "key-limit": "Schlüssellimit",
  "monthly-tools": "Tool-Aufrufe im Monat",
};

/** The limit window's name, translated ("model:Opus" is just "Opus"). */
export function windowLabel(kind: string): string {
  return kind.startsWith("model:") ? kind.slice(6) : t(windowLabels[kind] ?? kind);
}
