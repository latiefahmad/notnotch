import type { ReactNode } from "react";
import { Group, Row, StyleCards } from "../../ui/controls";
import { settings, updateSettings } from "../../settings/store";
import { Look, clockFace } from "./Look";
import { LOOK_COLORS, TIMER_LOOKS, lookColorLabels, lookLabels, lookTint, type ClockLook, type LookColor } from "./looks";
import { t } from "../../i18n";

/** Settings > Timer: the look of the big countdown, each card a still preview at 18:24 of 25 min. */
export function TimerLookSettings() {
  const { look, color } = settings.use().timer;
  return (
    <Group title={t("Timer-Stil")} id="settings-timer-look">
      <Row label={t("Farbe")} hint={t("Für den Fokus-Timer, auch in der geschlossenen Notch; Pausen bleiben grün")}>
        <ColorDots value={color} onChange={(c) => updateSettings((s) => ({ timer: { ...s.timer, color: c } }))} />
      </Row>
      <div className="px-3 py-2.5">
        <StyleCards
          label={t("Timer-Stil")}
          value={look}
          onChange={(v) => updateSettings((s) => ({ timer: { ...s.timer, look: v } }))}
          options={TIMER_LOOKS.map((l) => ({
            value: l,
            label: t(lookLabels[l]),
            preview: (
              <span className="flex h-full w-full items-center px-1.5">
                <Look look={l} remaining={1104} duration={1500} running={false} mode="focus" tint={lookTint(color)} h={20} />
              </span>
            ),
          }))}
        />
      </div>
    </Group>
  );
}

/** Settings > Timer: the Overview clock in its usual text or in one of the timer looks, previewed at 20:06 on a Sunday. */
export function ClockLookSettings() {
  const { clockLook, clockColor } = settings.use().timer;
  const face = clockFace(new Date(2026, 10, 1, 20, 6));
  const options: { value: ClockLook; label: string; preview: ReactNode }[] = [
    {
      value: "standard",
      label: t("Standard"),
      preview: (
        <span className="tabular px-1.5 text-[17px] leading-none font-semibold tracking-[-0.03em]" style={{ color: lookTint(clockColor) }}>
          {face.clock?.text}
        </span>
      ),
    },
    ...TIMER_LOOKS.map((l) => ({
      value: l,
      label: t(lookLabels[l]),
      preview: (
        <span className="flex h-full w-full items-center px-1.5">
          <Look look={l} {...face} running={false} mode="focus" tint={lookTint(clockColor)} h={20} />
        </span>
      ),
    })),
  ];
  return (
    <Group title={t("Uhr-Stil")} id="settings-clock-look">
      <Row label={t("Farbe")} hint={t("Für die Uhr in der Übersicht")}>
        <ColorDots value={clockColor} onChange={(c) => updateSettings((s) => ({ timer: { ...s.timer, clockColor: c } }))} />
      </Row>
      <div className="px-3 py-2.5">
        <StyleCards
          label={t("Uhr-Stil")}
          value={clockLook}
          onChange={(v) => updateSettings((s) => ({ timer: { ...s.timer, clockLook: v } }))}
          options={options}
        />
      </div>
    </Group>
  );
}

/** One dot per colour, the chosen one ringed; the accent follows the theme, white is the text colour. */
function ColorDots({ value, onChange }: { value: LookColor; onChange: (c: LookColor) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5" role="radiogroup" aria-label={t("Farbe")}>
      {LOOK_COLORS.map((c) => (
        <button
          key={c}
          role="radio"
          aria-checked={value === c}
          aria-label={t(lookColorLabels[c])}
          title={t(lookColorLabels[c])}
          onClick={() => onChange(c)}
          className={`pressable size-4 shrink-0 rounded-full ${value === c ? "ring-2 ring-label ring-offset-2 ring-offset-notch" : ""} ${c === "white" ? "border border-separator" : ""}`}
          style={{ background: lookTint(c) }}
        />
      ))}
    </div>
  );
}
