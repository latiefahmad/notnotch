import { settings, updateSettings } from "../../settings/store";
import { Group, Row, Segmented, Select, Switch } from "../../ui/controls";
import { t } from "../../i18n";
import { formatMinutes } from "./water";
import { waterActions } from "./store";
import { formatMl } from "./format";

const BOTTLES = [250, 330, 500, 750, 1000];
const GOALS = [1500, 2000, 2500, 3000];
const EVERY = [30, 45, 60, 90, 120];
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h * 60), label: formatMinutes(h * 60) }));

/** Settings → Tools: to-do reminders, the Overview quote and the water reminder. */
export function ProductivitySettings() {
  const s = settings.use();
  const p = s.productivity;
  const w = p.water;
  const toolOn = (id: string) => s.tools.some((x) => x.id === id && x.enabled);
  const set = (patch: Partial<typeof p>) => updateSettings((cur) => ({ productivity: { ...cur.productivity, ...patch } }));
  // A saved value outside the chips (older version, other screen) still shows as its own chip.
  const withValue = (list: number[], v: number) => (list.includes(v) ? list : [...list, v].sort((a, b) => a - b));

  return (
    <>
      <Group id="settings-todos" title={t("To-Dos und Übersicht")}>
        <Row label={t("Ton bei Erinnerungen")} hint={toolOn("todos") ? t("Der Alarm-Ton des Timers, einmal") : t("Braucht das Tool To-Dos")}>
          <Switch label={t("Ton bei Erinnerungen")} checked={p.reminderSound} onChange={(reminderSound) => set({ reminderSound })} />
        </Row>
        <Row label={t("Zitat in der Übersicht")} hint={t("Eine kurze Zeile für die schweren Stunden")}>
          <Switch label={t("Zitat in der Übersicht")} checked={p.quotes} onChange={(quotes) => set({ quotes })} />
        </Row>
      </Group>
      <Group id="settings-water" title={t("Wasser")}>
        <Row label={t("Erinnerungen")} hint={toolOn("water") ? t("Ein Hinweis in der geschlossenen Notch, bis das Tagesziel erreicht ist") : t("Braucht das Tool Wasser")}>
          <Switch label={t("Erinnerungen")} checked={w.remind} onChange={(remind) => waterActions.setConfig({ remind })} />
        </Row>
        <Row label={t("Flasche")} hint={t("So viel zählt ein Klick auf Trinken")}>
          <Segmented id="water-bottle" size="sm" value={String(w.bottleMl)} onChange={(v) => waterActions.setConfig({ bottleMl: Number(v) })} options={withValue(BOTTLES, w.bottleMl).map((v) => ({ value: String(v), label: formatMl(v) }))} />
        </Row>
        <Row label={t("Tagesziel")}>
          <Segmented id="water-goal" size="sm" value={String(w.goalMl)} onChange={(v) => waterActions.setConfig({ goalMl: Number(v) })} options={withValue(GOALS, w.goalMl).map((v) => ({ value: String(v), label: formatMl(v) }))} />
        </Row>
        <Row label={t("Erinnern alle")}>
          <Segmented id="water-every" size="sm" value={String(w.everyMin)} onChange={(v) => waterActions.setConfig({ everyMin: Number(v) })} options={withValue(EVERY, w.everyMin).map((v) => ({ value: String(v), label: t("{n} Min.", { n: v }) }))} />
        </Row>
        <Row label={t("Zeitraum")} hint={t("Außerhalb davon keine Erinnerungen")}>
          <div className="flex items-center gap-1.5">
            <Select width="w-20" value={String(w.from - (w.from % 60))} onChange={(v) => waterActions.setConfig({ from: Number(v) })} options={HOURS} />
            <span className="text-caption text-label-3">{t("bis")}</span>
            <Select width="w-20" value={String(w.to - (w.to % 60))} onChange={(v) => waterActions.setConfig({ to: Number(v) })} options={HOURS} />
          </div>
        </Row>
      </Group>
    </>
  );
}
