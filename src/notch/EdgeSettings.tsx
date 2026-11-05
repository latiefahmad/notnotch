import { t } from "../i18n";
import { settings, updateSettings } from "../settings/store";
import { Row, Segmented } from "../ui/controls";
import { hasTaskbar, overTaskbar, type Edge } from "./edge";
import { monitor, monitorMetrics } from "./monitor";

/** Settings rows: the screen edge the notch and the line hang from, and (with a taskbar on that edge) whether from the screen's edge or the taskbar's. The capsule floats freely, so it has neither. */
export function EdgeSettings() {
  const s = settings.use();
  monitor.use();
  if (s.display.idleStyle === "capsule") return null;
  const { edge, anchor } = s.dock;
  const m = monitorMetrics();
  const taskbar = hasTaskbar(edge, m.width, m.height, { x: m.workLeft, y: m.workTop, width: m.workWidth, height: m.workHeight });
  const setDock = (patch: Partial<typeof s.dock>) => updateSettings((cur) => ({ dock: { ...cur.dock, ...patch } }));
  return (
    <>
      <Row label={t("Bildschirmrand")} hint={t("Geschlossen auch an einen anderen Rand ziehen")}>
        <Segmented<Edge>
          id="dock-edge"
          size="sm"
          value={edge}
          // A new edge starts at its middle and with its own default anchor.
          onChange={(next) => updateSettings((cur) => ({ dock: { edge: next, anchor: "auto" }, display: { ...cur.display, offset: 0 } }))}
          options={[
            { value: "top", label: t("Rand oben") },
            { value: "bottom", label: t("Rand unten") },
            { value: "left", label: t("Rand links") },
            { value: "right", label: t("Rand rechts") },
          ]}
        />
      </Row>
      {taskbar && (
        <Row label={t("Hängt an")} hint={t("Über der Taskleiste verdeckt die Notch einen Teil davon")}>
          <Segmented
            id="dock-anchor"
            size="sm"
            value={overTaskbar(edge, anchor) ? "screen" : "taskbar"}
            onChange={(next) => setDock({ anchor: next })}
            options={[
              { value: "screen", label: t("Bildschirmkante") },
              { value: "taskbar", label: t("Taskleiste") },
            ]}
          />
        </Row>
      )}
    </>
  );
}
