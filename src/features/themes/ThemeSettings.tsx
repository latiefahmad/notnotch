import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { Button, Group, Row, Select, StyleCards, Switch, TextField } from "../../ui/controls";
import { formatTime } from "../../lib/format";
import { openFile, revealFile } from "../../platform/services";
import { settings, updateSettings } from "../../settings/store";
import { t } from "../../i18n";
import { contrast, parseColor, toHex, withAlpha, type Rgba } from "./color";
import { ColorPicker } from "./ColorPicker";
import { HALF_HOURS, activeThemeId, isNight } from "./daynight";
import { original } from "./history";
import {
  activeTheme,
  allThemes,
  deleteCustomTheme,
  discardEdits,
  draft,
  draftName,
  editClosedNotch,
  editColor,
  exportTheme,
  forcedColors,
  importFromFolder,
  overwriteTheme,
  pickTheme,
  saveAsNew,
  savedTheme,
  startEditing,
  themesFolder,
  undoEdit,
} from "./store";
import { BUILT_IN_THEMES, EDITOR_KEYS, FONTS, FONT_NAMES, findTheme, isBuiltIn, resolveTheme, type Adjustment, type FontId, type ThemeFile, type ThemeKey } from "./themes";

/** Settings → Themes: the theme, day and night, the colour editor and theme files. */
export function ThemeSettings() {
  return (
    <>
      <ThemeChoice />
      <DayNight />
      <ThemeEditor />
      <ThemeFiles />
    </>
  );
}

const KEY_LABELS: Record<Adjustment["key"], string> = {
  background: "Hintergrund",
  foreground: "Vordergrund",
  secondary: "Zweiter Text",
  tertiary: "Dritter Text",
  accent: "Akzent",
  link: "Links",
  warning: "Warnung",
  critical: "Kritisch",
  success: "Erfolg",
  elevated: "Menüs",
  yellow: "Gelb",
};

function ThemeChoice() {
  const themes = settings.use().themes;
  activeTheme.use(); // re-render when day turns to night
  const forced = forcedColors.use();
  const editing = draft.use();
  const [pending, setPending] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const current = findTheme(activeThemeId(themes, new Date()), themes.custom);
  const list = [...BUILT_IN_THEMES, ...themes.custom];

  const choose = (id: string) => {
    setConfirmDelete(false);
    if (editing && editing.past.length > 0) return setPending(id);
    discardEdits();
    pickTheme(id);
  };

  return (
    <Group title={t("Theme")} id="settings-themes">
      {forced && <Row label={t("Windows-Kontrastdesign ist an")} hint={t("NotNotch zeigt die Systemfarben, bis es ausgeschaltet wird")} />}
      <div className="p-2">
        <StyleCards
          label={t("Theme")}
          value={current.id}
          onChange={choose}
          options={list.map((theme) => ({ value: theme.id, label: theme.name, preview: <ThemePreview theme={theme} /> }))}
        />
      </div>
      {pending && (
        <Row label={t("Ungespeicherte Farben verwerfen?")}>
          <div className="flex gap-1.5">
            <Button onClick={() => setPending(null)}>{t("Weiter bearbeiten")}</Button>
            <Button
              primary
              onClick={() => {
                discardEdits();
                pickTheme(pending);
                setPending(null);
              }}
            >
              {t("Verwerfen")}
            </Button>
          </div>
        </Row>
      )}
      {isBuiltIn(current.id) ? (
        current.author && <Row label={current.name} hint={t("Farben von {author}, {license}-Lizenz", { author: current.author, license: current.license ?? "" })} />
      ) : (
        <Row label={current.name} hint={t("Eigenes Theme")}>
          <Button
            onClick={() => {
              if (!confirmDelete) return setConfirmDelete(true);
              setConfirmDelete(false);
              discardEdits();
              deleteCustomTheme(current.id);
            }}
          >
            {confirmDelete ? t("Wirklich löschen") : t("Löschen")}
          </Button>
        </Row>
      )}
      <Row label={t("Schrift")} hint={t("Für die ganze App. Terminal und Timer behalten ihre Schrift")}>
        <Select
          value={themes.font}
          options={(Object.keys(FONT_NAMES) as FontId[]).map((value) => ({ value, label: FONT_NAMES[value], font: FONTS[value] }))}
          onChange={(font) => updateSettings((cur) => ({ themes: { ...cur.themes, font } }))}
        />
      </Row>
      <Row label={t("Farbige Symbole")} hint={t("Werkzeugleiste, Einstellungen, Wetter und Werte der geschlossenen Notch in eigenen Farben")}>
        <Switch
          label={t("Farbige Symbole")}
          checked={themes.iconColors}
          onChange={(iconColors) => updateSettings((cur) => ({ themes: { ...cur.themes, iconColors } }))}
        />
      </Row>
      <Row label={t("Tönung vom Albumcover")} hint={t("Das offene Panel nimmt leicht die Farbe des laufenden Songs an")}>
        <Switch
          label={t("Tönung vom Albumcover")}
          checked={themes.coverTint}
          onChange={(coverTint) => updateSettings((cur) => ({ themes: { ...cur.themes, coverTint } }))}
        />
      </Row>
    </Group>
  );
}

/** A tiny panel in the theme's colours: accent dot, two text lines, warning and critical dots. */
function ThemePreview({ theme }: { theme: ThemeFile }) {
  const v = useMemo(() => resolveTheme(theme).vars, [theme]);
  return (
    <span className="flex h-full w-full items-center gap-1.5 px-2 forced-color-adjust-none" style={{ background: v["--color-notch"] }}>
      <span className="size-2 shrink-0 rounded-full" style={{ background: v["--theme-accent"] }} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="h-1 w-4/5 rounded-full" style={{ background: v["--color-label"] }} />
        <span className="h-1 w-1/2 rounded-full" style={{ background: v["--color-label-3"] }} />
      </span>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: v["--color-orange"] }} />
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: v["--color-red"] }} />
    </span>
  );
}

function DayNight() {
  const { themes } = settings.use();
  activeTheme.use(); // the "now" hint follows the change
  const s = themes.schedule;
  const set = (patch: Partial<typeof s>) => updateSettings((x) => ({ themes: { ...x.themes, schedule: { ...x.themes.schedule, ...patch } } }));
  const options = allThemes().map((theme) => ({ value: theme.id, label: theme.name }));
  // formatTime follows the 12 or 24 hour setting.
  const times = HALF_HOURS.map((v) => ({ value: v, label: formatTime(new Date(2000, 0, 1, Number(v.slice(0, 2)), Number(v.slice(3)))) }));

  const turnOn = (on: boolean) => {
    if (!on) return set({ on });
    // Start from the theme in use: it keeps its place by day if it is light, by night if it is dark.
    const currentDark = resolveTheme(findTheme(themes.id, themes.custom)).dark;
    set(currentDark ? { on, night: themes.id } : { on, day: themes.id });
  };

  return (
    <Group title={t("Tag und Nacht")} id="settings-daynight">
      <Row
        label={t("Nach Uhrzeit wechseln")}
        hint={s.on ? (isNight(s, new Date()) ? t("Jetzt gilt das Nacht-Theme") : t("Jetzt gilt das Tag-Theme")) : t("Ein Theme für den Tag, eins für die Nacht")}
      >
        <Switch checked={s.on} onChange={turnOn} label={t("Nach Uhrzeit wechseln")} />
      </Row>
      {s.on && (
        <>
          <Row label={t("Tag ab")}>
            <div className="flex gap-1.5">
              <Select width="w-24" value={s.dayStart} options={times} onChange={(dayStart) => set({ dayStart })} />
              <Select width="w-32" value={s.day} options={options} onChange={(day) => set({ day })} />
            </div>
          </Row>
          <Row label={t("Nacht ab")}>
            <div className="flex gap-1.5">
              <Select width="w-24" value={s.nightStart} options={times} onChange={(nightStart) => set({ nightStart })} />
              <Select width="w-32" value={s.night} options={options} onChange={(night) => set({ night })} />
            </div>
          </Row>
        </>
      )}
    </Group>
  );
}

const ratio = (r: number) => `${(Math.floor(r * 10) / 10).toFixed(1)}:1`;

function ThemeEditor() {
  const h = draft.use();
  const theme = activeTheme.use();
  const [open, setOpen] = useState<ThemeKey | null>(null);
  const name = draftName.use();

  if (!h)
    return (
      <Group title={t("Farben")} id="settings-colors">
        <Row label={t("Farben anpassen")} hint={t("Beginnt beim aktuellen Theme, jede Änderung ist sofort zu sehen")}>
          <Button
            onClick={() => {
              startEditing(t("{name} (eigenes)", { name: savedTheme().name }));
              setOpen(null);
            }}
          >
            {t("Bearbeiten")}
          </Button>
        </Row>
      </Group>
    );

  const file = h.present;
  const changed = h.past.length > 0;
  const custom = !isBuiltIn(original(h).id);
  const bg = theme.colors.background;
  const swatches = [...new Set(EDITOR_KEYS.map((k) => theme.vars[varFor[k]]).concat(["#000000", "#ffffff"]))].filter((c) => parseColor(c)?.a === 1);

  return (
    <Group title={t("Farben")} id="settings-colors">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5 text-footnote">
        <span className="font-semibold text-label">{t("Titel")}</span>
        <span className="text-label-2">{t("Text")}</span>
        <span className="text-label-3">{t("Hinweis")}</span>
        <span className="ms-auto text-link">{t("Akzent")}</span>
        <span className="text-orange">{t("Warnung")}</span>
        <span className="text-red">{t("Kritisch")}</span>
      </div>
      {EDITOR_KEYS.map((key) => {
        const shown = theme.colors[key];
        const written = parseColor(file.colors[key]) ?? shown;
        return (
          <Fragment key={key}>
            <button
              onClick={() => setOpen(open === key ? null : key)}
              aria-expanded={open === key}
              className="pressable pressable-fill flex min-h-9 w-full items-center gap-2.5 px-3 py-1.5 text-start"
            >
              <span className="size-4 shrink-0 rounded-full ring-1 ring-separator forced-color-adjust-none" style={{ background: theme.vars[varFor[key]] }} />
              <span className="flex-1 text-body text-label">{t(KEY_LABELS[key])}</span>
              {key !== "background" && <span className="tabular text-caption text-label-3">{ratio(contrast(shown, bg))}</span>}
              <span className="tabular w-16 text-end text-caption text-label-2">{hexOf(written)}</span>
            </button>
            {open === key && <ColorPicker value={withAlpha(written, 1)} onChange={(c) => editColor(key, c)} swatches={swatches} />}
          </Fragment>
        );
      })}
      <Row label={t("Geschlossene Notch einfärben")} hint={t("Sonst bleibt sie schwarz wie der Bildschirmrand")}>
        <Switch checked={file.closedNotch === "background"} onChange={editClosedNotch} label={t("Geschlossene Notch einfärben")} />
      </Row>
      {theme.adjustments.length > 0 && (
        <div className="flex flex-col gap-0.5 px-3 py-2 text-caption text-label-3">
          <span className="text-label-2">{t("Für die Lesbarkeit angepasst")}</span>
          {theme.adjustments.map((a) => (
            <span key={a.key}>
              {a.met
                ? t("{name}: {from} wird {to} (hatte {ratio}, braucht {min})", { name: t(KEY_LABELS[a.key]), from: a.from, to: a.to, ratio: ratio(a.ratio), min: ratio(a.minimum) })
                : t("{name}: {from} erreicht {min} nicht, bestmöglich {to}", { name: t(KEY_LABELS[a.key]), from: a.from, to: a.to, min: ratio(a.minimum) })}
            </span>
          ))}
        </div>
      )}
      <Row label={t("Änderungen")} hint={changed ? t("Nicht gespeichert") : t("Noch keine")}>
        <div className="flex gap-1.5">
          <Button disabled={!changed} onClick={undoEdit} icon={ArrowCounterClockwise}>
            {t("Rückgängig")}
          </Button>
          <Button onClick={discardEdits}>{changed ? t("Verwerfen") : t("Schließen")}</Button>
        </div>
      </Row>
      <Row label={<TextField value={name} onChange={(v) => draftName.set(v)} placeholder={t("Name")} width="w-36" />}>
        <div className="flex gap-1.5">
          {custom && (
            <Button disabled={!changed} onClick={overwriteTheme}>
              {t("Überschreiben")}
            </Button>
          )}
          <Button primary disabled={!name.trim()} onClick={() => saveAsNew(name)}>
            {t("Als neu sichern")}
          </Button>
        </div>
      </Row>
    </Group>
  );
}

const varFor: Record<(typeof EDITOR_KEYS)[number], string> = {
  background: "--color-notch",
  foreground: "--color-label",
  accent: "--theme-accent",
  warning: "--color-orange",
  critical: "--color-red",
};

const hexOf = (c: Rgba) => toHex(c).toUpperCase();

function ThemeFiles() {
  const [message, setMessage] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);
  const run = (job: () => Promise<ReactNode>) => {
    setBusy(true);
    job()
      .then(setMessage, (e) => setMessage(t(String(e))))
      .finally(() => setBusy(false));
  };

  return (
    <Group title={t("Theme-Dateien")} id="settings-theme-files">
      <Row label={t("Aktuelles Theme exportieren")} hint={t("Als JSON-Datei in den Theme-Ordner")}>
        <Button
          disabled={busy}
          onClick={() =>
            run(async () => {
              const path = await exportTheme();
              if (!path) return t("Heruntergeladen");
              return (
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{t("Gespeichert: {path}", { path })}</span>
                  <Button onClick={() => revealFile(path)}>{t("Zeigen")}</Button>
                </span>
              );
            })
          }
        >
          {t("Exportieren")}
        </Button>
      </Row>
      <Row label={t("Aus dem Theme-Ordner importieren")} hint={t("Liest jede .json-Datei im Ordner")}>
        <div className="flex gap-1.5">
          <Button disabled={busy} onClick={() => void themesFolder().then((dir) => (dir ? openFile(dir) : undefined))}>
            {t("Ordner öffnen")}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await importFromFolder();
                const names = r.added.map((x) => x.name).join(", ");
                return (
                  <span className="flex flex-col gap-0.5">
                    <span>
                      {r.added.length + r.unchanged + r.failed.length === 0
                        ? t("Keine .json-Dateien im Ordner")
                        : t("{n} importiert, {u} schon vorhanden {names}", { n: r.added.length, u: r.unchanged, names })}
                    </span>
                    {r.failed.map((f) => (
                      <span key={f.file} className="text-orange">
                        {f.file}: {f.problems.map((p) => t(p.key, p.vars)).join("; ")}
                      </span>
                    ))}
                  </span>
                );
              })
            }
          >
            {t("Importieren")}
          </Button>
        </div>
      </Row>
      {message && <div className="px-3 py-2 text-caption text-label-2">{message}</div>}
    </Group>
  );
}
