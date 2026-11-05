// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck/SettingsCollapsedSize.cs.
import { t } from "../i18n";
import { settings, updateSettings, type Settings } from "../settings/store";
import { toSaved } from "../features/window/panelSize";
import { Button, Row, Slider } from "../ui/controls";
import { CAPSULE_TOP_DEFAULT, CLOSED_SIZE_DEFAULTS, LIMITS, type ClosedSize } from "./collapsed";
import { monitor, monitorMetrics } from "./monitor";
import { closedEdit } from "./ClosedResize";

/** The sizes each style's rows change; the capsule's distance from the edge is display.y besides. */
const KEYS: Record<Settings["display"]["idleStyle"], (keyof ClosedSize)[]> = {
  notch: ["notchWidth", "notchHeight"],
  capsule: ["capsuleWidth", "capsuleHeight"],
  line: ["lineLength", "lineThickness", "lineTop"],
};

/**
 * Settings rows under the closed style's picker: the chosen style's size, the capsule's and the line's distance from the edge, and a reset
 * to that style's defaults. The ranges stop at the notch's monitor, so the thumb shows what is drawn; a larger value saved on another
 * monitor stays until its slider is moved.
 */
export function SizeSettings() {
  const s = settings.use();
  monitor.use();
  const style = s.display.idleStyle, c = s.closedSize, m = monitorMetrics();
  const set = (patch: Partial<ClosedSize>) => updateSettings((cur) => ({ closedSize: { ...cur.closedSize, ...patch } }));
  const isDefault = KEYS[style].every((k) => c[k] === CLOSED_SIZE_DEFAULTS[k]) && (style !== "capsule" || s.display.y === CAPSULE_TOP_DEFAULT);
  const reset = () =>
    updateSettings((cur) => ({
      closedSize: { ...cur.closedSize, ...Object.fromEntries(KEYS[style].map((k) => [k, CLOSED_SIZE_DEFAULTS[k]])) },
      ...(style === "capsule" && { display: { ...cur.display, y: CAPSULE_TOP_DEFAULT } }),
    }));
  // Widths are in the page's CSS px, as the monitor's size; display.y is saved at 100 %.
  const wide = Math.floor(m.width);
  const lowest = Math.floor(toSaved(m.height - c.capsuleHeight, s.behavior.scale));

  return (
    <>
      <Row label={t("Größe")} hint={style === "line" ? undefined : t("Der Inhalt wächst mit der Höhe, für mehr Inhalt wird sie von selbst breiter")}>
        <div className="flex gap-2">
          {/* The panel closes onto the closed shape, which shows grips until Done (ClosedResize.tsx). */}
          <Button onClick={() => closedEdit.set(true)}>{t("Auf der Notch anpassen")}</Button>
          <Button disabled={isDefault} onClick={reset}>
            {t("Zurücksetzen")}
          </Button>
        </div>
      </Row>
      {style === "notch" && (
        <>
          <SizeRow label={t("Breite")} value={c.notchWidth} min={LIMITS.notchWidth[0]} max={Math.min(LIMITS.notchWidth[1], wide)} onChange={(notchWidth) => set({ notchWidth })} />
          <SizeRow label={t("Höhe")} value={c.notchHeight} min={LIMITS.notchHeight[0]} max={LIMITS.notchHeight[1]} onChange={(notchHeight) => set({ notchHeight })} />
        </>
      )}
      {style === "capsule" && (
        <>
          <SizeRow label={t("Breite")} value={c.capsuleWidth} min={LIMITS.capsuleWidth[0]} max={Math.min(LIMITS.capsuleWidth[1], wide)} onChange={(capsuleWidth) => set({ capsuleWidth })} />
          <SizeRow label={t("Höhe")} value={c.capsuleHeight} min={LIMITS.capsuleHeight[0]} max={LIMITS.capsuleHeight[1]} onChange={(capsuleHeight) => set({ capsuleHeight })} />
          <SizeRow
            label={t("Abstand zum Rand")}
            hint={t("Nah am Rand klappt sie wie die Notch vom Rand auf")}
            value={s.display.y}
            min={LIMITS.capsuleTop[0]}
            max={Math.min(LIMITS.capsuleTop[1], lowest)}
            onChange={(y) => updateSettings((cur) => ({ display: { ...cur.display, y } }))}
          />
        </>
      )}
      {style === "line" && (
        <>
          <SizeRow label={t("Länge")} value={c.lineLength} min={LIMITS.lineLength[0]} max={Math.min(LIMITS.lineLength[1], wide)} onChange={(lineLength) => set({ lineLength })} />
          <SizeRow label={t("Dicke")} value={c.lineThickness} min={LIMITS.lineThickness[0]} max={LIMITS.lineThickness[1]} step={0.5} onChange={(lineThickness) => set({ lineThickness })} />
          <SizeRow label={t("Abstand zum Rand")} value={c.lineTop} min={LIMITS.lineTop[0]} max={LIMITS.lineTop[1]} onChange={(lineTop) => set({ lineTop })} />
        </>
      )}
    </>
  );
}

/** A slider with its value in px; the thumb stays within the range even when the saved value lies beyond it. */
function SizeRow(props: { label: string; hint?: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  const step = props.step ?? 1, max = Math.max(props.min + step, props.max);
  const shown = Math.min(max, Math.max(props.min, props.value));
  return (
    <Row label={props.label} hint={props.hint}>
      <div className="flex w-52 items-center gap-2">
        <Slider label={props.label} value={shown} min={props.min} max={max} step={step} onChange={props.onChange} />
        <span className="tabular w-14 shrink-0 text-end text-caption text-label-2">{shown} px</span>
      </div>
    </Row>
  );
}
