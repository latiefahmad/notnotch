import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MusicNotesSimple, SlidersHorizontal, Sparkle, CheckCircle } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import { t } from "../../i18n";
import { navigate } from "../../notch/nav";
import { tabs } from "../../notch/tabs";
import { EdgeSettings } from "../../notch/EdgeSettings";
import { settings, updateSettings } from "../../settings/store";
import { Button, Group, StyleCards } from "../../ui/controls";
import { ClosedStyle, OpenRows, ShortcutRow } from "../settings/SettingsView";
import { applyPreset, matchPreset, type PresetFields, type PresetId } from "./presets";

const STEPS = 3;

/** Kept while the notch closes and opens again mid-setup (the view is rebuilt); cleared when it ends. */
let session: { step: number; preset: PresetId; original: PresetFields } | null = null;

const pick = ({ tools, closed, music }: PresetFields): PresetFields => ({ tools, closed, music });

/** First run: a preset, the closed look and edge, and how to open it. Skippable at every step. */
export function SetupView() {
  const [state, setState] = useState(() => (session ??= { step: 0, preset: matchPreset(settings.get()), original: pick(settings.get()) }));
  const set = (patch: Partial<typeof state>) => setState((session = { ...state, ...patch }));
  const finish = () => {
    session = null;
    updateSettings({ setup: { done: true } });
    navigate(settings.get().tools.find((x) => x.enabled)?.id ?? tabs[0].id);
  };
  const last = state.step === STEPS - 1;

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-2">
      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={state.step}
            className="absolute inset-0 flex flex-col gap-3 overflow-y-auto pb-2 [scrollbar-width:none]"
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          >
            {state.step === 0 && <PresetStep preset={state.preset} original={state.original} onPick={(preset) => set({ preset })} />}
            {state.step === 1 && (
              <>
                <Lead>{t("Wie NotNotch geschlossen aussieht und an welchem Rand.")}</Lead>
                <Group>
                  <ClosedStyle />
                  <EdgeSettings />
                </Group>
              </>
            )}
            {state.step === 2 && (
              <>
                <Lead>{t("Öffnen mit dem Tastenkürzel, oder mit dem Zeiger auf der Notch.")}</Lead>
                <Group>
                  <ShortcutRow />
                  <OpenRows />
                </Group>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-2">
        <div className="flex flex-1">{!last && <Button onClick={finish}>{t("Überspringen")}</Button>}</div>
        <div role="img" aria-label={t("Schritt {n} von {m}", { n: state.step + 1, m: STEPS })} className="flex items-center gap-1">
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} className={`h-1.5 rounded-full transition-[width,background-color] duration-200 ${i === state.step ? "w-4 bg-label" : "w-1.5 bg-fill-3"}`} />
          ))}
        </div>
        <div className="flex flex-1 justify-end gap-1.5">
          {state.step > 0 && <Button onClick={() => set({ step: state.step - 1 })}>{t("Zurück")}</Button>}
          <Button primary onClick={last ? finish : () => set({ step: state.step + 1 })}>
            {last ? t("Fertig") : t("Weiter")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Lead({ children }: { children: string }) {
  return <p className="px-1 text-footnote text-label-2">{children}</p>;
}

const icon = (I: typeof Sparkle) => <I size={18} weight="bold" className="mt-1" />;

function PresetStep({ preset, original, onPick }: { preset: PresetId; original: PresetFields; onPick: (p: PresetId) => void }) {
  const tools = settings.use().tools;
  const enabledCount = tools.filter((x) => x.enabled).length;
  const choose = (p: PresetId) => {
    onPick(p);
    updateSettings((cur) => applyPreset(cur, p, original));
  };
  const hint = {
    music: t("Wiedergabe und Timer; geschlossen Songtitel mit Songtext und Equalizer"),
    productivity: t("Timer, To-Dos, Notiz, Zwischenablage, Ablage, Converter und Wetter"),
    ai: t("Ask, AI-Nutzung und Terminal; geschlossen die Kontingent-Ringe"),
    custom: t("Die Tools antippen, die du willst"),
  }[preset];

  return (
    <>
      <Lead>{t("Was soll NotNotch zeigen? Alles lässt sich später in den Einstellungen ändern.")}</Lead>
      <StyleCards
        label={t("Voreinstellung")}
        columns={4}
        value={preset}
        onChange={choose}
        options={[
          { value: "music", label: t("Musik"), preview: icon(MusicNotesSimple) },
          { value: "productivity", label: t("Produktivität"), preview: icon(CheckCircle) },
          { value: "ai", label: t("AI"), preview: icon(Sparkle) },
          { value: "custom", label: t("Eigene"), preview: icon(SlidersHorizontal) },
        ]}
      />
      <p className="px-1 text-caption text-label-3">{hint}</p>
      {preset === "custom" && (
        <div className="flex flex-wrap gap-1.5">
          {tools.map((tool) => {
            const tab = tabs.find((x) => x.id === tool.id);
            if (!tab) return null;
            return (
              <button
                key={tool.id}
                aria-pressed={tool.enabled}
                // One tool stays on, as in Settings, Tools.
                onClick={() =>
                  (!tool.enabled || enabledCount > 1) &&
                  updateSettings((cur) => ({ tools: cur.tools.map((x) => (x.id === tool.id ? { ...x, enabled: !x.enabled } : x)) }))
                }
                className={`pressable flex h-7 items-center gap-1.5 rounded-full px-2.5 text-footnote transition-colors duration-150 ${
                  tool.enabled ? "bg-fill-3 text-label" : "bg-fill-1 text-label-3 hover:text-label-2"
                }`}
              >
                <tab.icon size={13} weight={tool.enabled ? "fill" : "bold"} />
                {t(tab.label)}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
