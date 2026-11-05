import { useEffect, useRef, useState } from "react";
import { ArrowLineUp, X } from "@phosphor-icons/react";
import { isMac } from "../../platform/native";
import { windowShell, type RunningApp } from "../../platform/services";
import { settings } from "../../settings/store";
import { tabs, settingsTab } from "../../notch/tabs";
import { Button, Group, Row, Segmented, Select, Switch, TextField } from "../../ui/controls";
import { t } from "../../i18n";
import { altGrRisk, conflicts, keycaps, record, type HotkeyKind, type RecordError } from "./hotkeys";
import { CONTEXTS, MAX_APP_RULES, addRule, newRule, ruleKey, type AppRule, type Behavior, type ScreenContext } from "./model";
import { currentQuick, quickSize, type QuickSize } from "./panelSize";
import { hotkeyStatus, pauseHotkeys, takenByLauncher, updateBehavior } from "./store";

const contextLabel: Record<ScreenContext, string> = {
  maximized: "Maximiertes Fenster",
  borderless: "Randloses Vollbild",
  exclusive: "Exklusives Vollbild",
};
const contextHint: Record<ScreenContext, string> = {
  maximized: "Ein Fenster, das den Bildschirm bis zur Taskleiste füllt",
  borderless: "Spiele, Videos und Browser im Vollbild (F11)",
  exclusive: "Spiele, die den Bildschirm für sich allein nehmen",
};
const behaviorOptions = (): { value: Behavior; label: string }[] => [
  { value: "normal", label: t("Behalten") },
  { value: "line", label: t("Linie") },
  { value: "hide", label: t("Ausblenden") },
];

/** Window rules, app rules, shortcuts, panel size and scale, mouse. */
export function WindowSettings() {
  return (
    <>
      <Rules />
      <AppRules />
      <Shortcuts />
      <Panel />
      <Mouse />
    </>
  );
}

function Rules() {
  const s = settings.use();
  const r = s.behavior.rules;
  const gaming = s.gaming.mode !== "off";
  return (
    <Group title={t("Wenn ein Fenster den Bildschirm füllt")} id="settings-window">
      {CONTEXTS.map((c) => (
        <Row key={c} label={t(contextLabel[c])} hint={gaming && c !== "maximized" ? t("Der Gaming-Modus hält NotNotch hier sichtbar") : t(contextHint[c])}>
          <Segmented
            id={`rule-${c}`}
            size="sm"
            value={r[c]}
            onChange={(v) => updateBehavior((b) => ({ rules: { ...b.rules, [c]: v } }))}
            options={behaviorOptions()}
          />
        </Row>
      ))}
      <Row label={t("Auch Fenster dahinter prüfen")} hint={t("Ein maximiertes oder randloses Fenster hinter dem aktiven zählt auch")}>
        <Switch label={t("Auch Fenster dahinter prüfen")} checked={r.background} onChange={(background) => updateBehavior((b) => ({ rules: { ...b.rules, background } }))} />
      </Row>
      <Row label={t("Nach vorne holen")} hint={t("Wenn ein anderes Fenster über NotNotch liegt")}>
        <Button icon={ArrowLineUp} onClick={windowShell.raise}>
          {t("Jetzt")}
        </Button>
      </Row>
    </Group>
  );
}

function AppRules() {
  const apps = settings.use().behavior.apps;
  const [running, setRunning] = useState<RunningApp[]>([]);
  const [pick, setPick] = useState("");
  const [typed, setTyped] = useState("");
  useEffect(() => {
    void windowShell.apps().then(setRunning);
  }, []);
  const known = new Set(apps.map(ruleKey));
  const choices = running.filter((a) => !known.has(ruleKey(a)) && !known.has(ruleKey({ name: a.name, path: "" })));
  const add = (rule: AppRule) => updateBehavior((b) => ({ apps: addRule(b.apps, rule) }));
  const full = apps.length >= MAX_APP_RULES;
  const set = (key: string, patch: Partial<AppRule>) => updateBehavior((b) => ({ apps: b.apps.map((a) => (ruleKey(a) === key ? { ...a, ...patch } : a)) }));
  const options = [{ value: "follow", label: t("Wie oben") }, ...behaviorOptions()];

  return (
    <Group title={t("App-Regeln")}>
      {apps.map((a) => {
        const key = ruleKey(a);
        const file = a.path ? a.path.split(/[\\/]/).pop() : `${a.name}.exe`;
        return (
          <div key={key} className="px-3 py-2" title={a.path || undefined}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-body text-label">{a.name}</span>
                <span className="truncate text-caption text-label-3">{file}</span>
              </div>
              <button
                aria-label={t("{name} entfernen", { name: a.name })}
                title={t("Entfernen")}
                className="pressable shrink-0 text-label-3 hover:text-label-2"
                onClick={() => updateBehavior((b) => ({ apps: b.apps.filter((x) => ruleKey(x) !== key) }))}
              >
                <X size={13} weight="bold" />
              </button>
            </div>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              {CONTEXTS.map((c) => (
                <div key={c} className="flex min-w-0 flex-col gap-1">
                  <span className="truncate text-caption text-label-3">{t(contextLabel[c])}</span>
                  <Select<string> width="w-full" value={a[c] ?? "follow"} onChange={(v) => set(key, { [c]: v === "follow" ? null : (v as Behavior) })} options={options} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <Row label={t("Laufende App")} hint={apps.length === 0 ? t("Eigene Regeln für eine App, nach ihrer .exe") : undefined}>
        <div className="flex items-center gap-2">
          <Select<string>
            width="w-40"
            value={pick}
            onChange={setPick}
            options={[{ value: "", label: t("App wählen …") }, ...choices.map((a) => ({ value: a.path, label: a.name }))]}
          />
          <Button
            disabled={!pick || full}
            onClick={() => {
              const app = running.find((a) => a.path === pick);
              if (app) add(newRule(app.name, app.path));
              setPick("");
            }}
          >
            {t("Hinzufügen")}
          </Button>
        </div>
      </Row>
      <Row label={t("Nach Name")} hint={t("Für Apps, die gerade nicht laufen")}>
        <div className="flex items-center gap-2">
          <TextField
            value={typed}
            onChange={setTyped}
            placeholder="game.exe"
            width="w-40"
            onSubmit={() => {
              if (!typed.trim() || full) return;
              add(newRule(typed));
              setTyped("");
            }}
          />
          <Button
            disabled={!typed.trim() || full}
            onClick={() => {
              add(newRule(typed));
              setTyped("");
            }}
          >
            {t("Hinzufügen")}
          </Button>
        </div>
      </Row>
    </Group>
  );
}

const hotkeyLabel: Record<HotkeyKind, string> = { open: "Öffnen und schließen", hide: "NotNotch aus- und einblenden", resize: "Größe ändern", find: "Auf dem Bildschirm suchen" };
const hotkeyHint: Record<HotkeyKind, string> = {
  open: "Öffnet und schließt die Notch von überall",
  hide: "Blendet NotNotch aus, bis du es wieder drückst",
  resize: "Mit Alt, einer weiteren Taste und den Pfeiltasten: ←/→ Breite, ↑/↓ Höhe des offenen Tools",
  find: "Liest den Text auf allen Bildschirmen und öffnet die Suche darin",
};
const recordErrors: Record<RecordError, string> = {
  "need-modifier": "Buchstaben und Ziffern brauchen Strg, Alt oder Win; F1 bis F24 gehen allein",
  "resize-modifiers": "Alt und eine weitere Taste (Strg, Umschalt oder Win) halten",
  "resize-arrow": "Halte die Tasten und drücke eine Pfeiltaste",
  "unsupported-key": "Diese Taste geht nicht als Tastenkürzel",
};

function Shortcuts() {
  return (
    <Group title={t("Tastenkürzel")}>
      <HotkeyRow kind="open" />
      <HotkeyRow kind="hide" />
      <HotkeyRow kind="resize" />
      {!isMac && <HotkeyRow kind="find" />}
    </Group>
  );
}

/** A keycap in the interface language: Ctrl is "Strg" and Space "Leertaste" in German. */
export const keyText = (k: string) => (k === "Ctrl" ? t("Strg") : k === "Space" ? t("Leertaste") : k === "Alt" ? t("Alt") : k);

/** Click the box, press the combination. Esc cancels, Backspace clears. */
function HotkeyRow({ kind }: { kind: HotkeyKind }) {
  const s = settings.use(), hotkeys = s.behavior.hotkeys;
  const status = hotkeyStatus.use()[kind];
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<RecordError | null>(null);
  const box = useRef<HTMLButtonElement>(null);
  const value = hotkeys[kind];
  const clash = conflicts(hotkeys, takenByLauncher(s))[kind];
  const altGr = altGrRisk(kind, value);

  const stop = () => {
    setRecording(false);
    pauseHotkeys(false);
  };
  const save = (text: string) => updateBehavior((b) => ({ hotkeys: { ...b.hotkeys, [kind]: text } }));
  // A recorder left open (the panel closed) must not keep the shortcuts off.
  useEffect(() => () => pauseHotkeys(false), []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return stop();
    const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
    if (plain && (e.code === "Backspace" || e.code === "Delete")) {
      save("");
      setError(null);
      return stop();
    }
    const r = record(kind, e.nativeEvent, !isMac);
    if (!r) return;
    if ("error" in r) return setError(r.error);
    save(r.text);
    setError(null);
    stop();
  };

  const hint = error
    ? t(recordErrors[error])
    : clash
      ? t("Schon belegt von „{name}“, bitte eine andere Kombination", { name: clash === "launcher" ? t("Launcher") : t(hotkeyLabel[clash]) })
      : status === "in-use"
        ? t("Ein anderes Programm nutzt diese Kombination, sie ist nicht aktiv")
        : status === "invalid"
          ? t("Nicht erkannt, bitte neu aufnehmen")
          : altGr
            ? t("Strg+Alt ist auf vielen Tastaturen AltGr und tippt dann z. B. @ oder €; besser Umschalt oder Win dazunehmen")
            : t(hotkeyHint[kind]);
  const warn = !!error || !!clash || status === "in-use" || status === "invalid" || altGr;
  const caps = keycaps(value, t("Pfeiltasten")).map(keyText);

  return (
    <Row label={t(hotkeyLabel[kind])} hint={<span className={warn ? "text-orange" : undefined}>{hint}</span>}>
      <div className="flex shrink-0 items-center gap-1">
        <button
          ref={box}
          data-no-drag
          aria-label={t("Tastenkürzel für „{name}“ aufnehmen", { name: t(hotkeyLabel[kind]) })}
          onClick={() => {
            setError(null);
            setRecording(true);
            pauseHotkeys(true);
            box.current?.focus();
          }}
          onBlur={() => recording && stop()}
          onKeyDown={onKeyDown}
          // Key combinations read left to right in any language.
          dir="ltr"
          className={`pressable flex h-7 min-w-24 items-center justify-center gap-1 rounded-[8px] px-2 text-caption outline-none ${
            recording ? "bg-fill-3 text-label ring-1 ring-label-3" : "bg-fill-2 text-label-2"
          }`}
        >
          {recording ? (
            t("Kombination drücken …")
          ) : caps.length ? (
            caps.map((k, i) => (
              <kbd key={i} className="rounded-[5px] bg-fill-2 px-1.5 py-0.5 font-sans text-caption">
                {k}
              </kbd>
            ))
          ) : (
            <span className="text-label-3">{t("Nicht gesetzt")}</span>
          )}
        </button>
        {value && !recording && (
          <button aria-label={t("Tastenkürzel entfernen")} title={t("Tastenkürzel entfernen")} className="pressable p-1 text-label-3 hover:text-label-2" onClick={() => save("")}>
            <X size={12} weight="bold" />
          </button>
        )}
      </div>
    </Row>
  );
}

function Panel() {
  const b = settings.use().behavior;
  const all = [...tabs, settingsTab];
  const defs = Object.fromEntries(all.map((tab) => [tab.id, tab.size]));
  const quick = currentQuick(defs, b.sizes);
  return (
    <Group title={t("Offenes Panel")}>
      <Row label={t("Größe")} hint={t("Pro Tool an den Rändern des offenen Panels ziehen; Doppelklick setzt zurück")}>
        <Segmented<QuickSize | "custom">
          id="panel-size"
          size="sm"
          value={quick ?? "custom"}
          onChange={(q) => {
            if (q === "custom") return;
            updateBehavior({ sizes: q === "standard" ? {} : Object.fromEntries(all.map((tab) => [tab.id, quickSize(tab.size, q)])) });
          }}
          options={[
            { value: "compact", label: t("Kompakt") },
            { value: "standard", label: t("Standard") },
            { value: "spacious", label: t("Geräumig") },
          ]}
        />
      </Row>
      <Row label={t("Skalierung")} hint={t("Zeichnet NotNotch größer, wie eine höhere Windows-Skalierung nur für NotNotch")}>
        <Segmented<"100" | "150">
          id="panel-scale"
          size="sm"
          value={String(b.scale) as "100" | "150"}
          onChange={(v) => updateBehavior({ scale: v === "150" ? 150 : 100 })}
          options={[
            { value: "100", label: "100 %" },
            { value: "150", label: "150 %" },
          ]}
        />
      </Row>
    </Group>
  );
}

function Mouse() {
  const b = settings.use().behavior;
  return (
    <Group title={t("Maus")}>
      <Row label={t("Rechtsklick öffnet die Einstellungen")}>
        <Switch label={t("Rechtsklick öffnet die Einstellungen")} checked={b.rightClickSettings} onChange={(rightClickSettings) => updateBehavior({ rightClickSettings })} />
      </Row>
      <Row label={t("Mausrad wechselt das Tool")} hint={t("Über dem offenen Panel, wo nichts scrollt")}>
        <Switch label={t("Mausrad wechselt das Tool")} checked={b.wheelTools} onChange={(wheelTools) => updateBehavior({ wheelTools })} />
      </Row>
    </Group>
  );
}
