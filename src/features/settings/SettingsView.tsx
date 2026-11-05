import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, Reorder } from "motion/react";
import {
  AppWindow,
  ArrowsInLineHorizontal,
  BellSimple,
  CalendarBlank,
  ChartDonut,
  CheckCircle,
  Clock,
  Cpu,
  DownloadSimple,
  GithubLogo,
  DotsSixVertical,
  Keyboard,
  LockSimple,
  MagnifyingGlass,
  Monitor,
  MusicNote,
  Palette,
  Play,
  Plugs,
  PuzzlePiece,
  Bug,
  TerminalWindow,
  SlidersHorizontal,
  Sparkle,
  SquaresFour,
  SignOut,
  Stop,
  Timer,
  Waveform,
  type Icon,
} from "@phosphor-icons/react";
import { content, fade, springs } from "../../design/motion";
import { alarmSounds, playAlarm, stopAlarm, type AlarmDuration } from "../../lib/sound";
import { nav, navigate } from "../../notch/nav";
import { findTab, setupTab } from "../../notch/tabs";
import { PluginSettings } from "../plugins/PluginSettings";
import { plugins } from "../plugins/store";
import {
  autostart,
  build,
  display,
  openSponsors,
  openBugReport,
  openStoreReview,
  portable,
  secrets,
  systemDiagnostics,
  unlockFps,
  type MonitorInfo,
  type SecretName,
} from "../../platform/services";
import { diagnosticsText } from "./diagnostics";
import { searchSettings, type SearchEntry } from "./search";
import { github } from "../github/store";
import { settings, updateAsk, updateSettings, type AskProvider } from "../../settings/store";
import { DiscordLogo } from "../../ui/brands";
import { Button, Group, Row, Segmented, Select, Slider, StyleCards, Switch, TextField } from "../../ui/controls";
import type { ClosedSettings, PartId } from "../../notch/row/parts";
import { effortLevels, providerInfo } from "../ask/providers";
import { discordState, reconnectDiscord } from "../discord/store";
import { fps } from "../system/gaming";
import { PlaceSearch } from "../weather/WeatherView";
import { VaultSettings } from "../vault/VaultSettings";
import { ClockLookSettings, TimerLookSettings } from "../timer/LookSettings";
import { focusSounds, type FocusSound } from "../timer/focusSound";
import { ProductivitySettings } from "../water/WaterSettings";
import { TerminalSettings } from "../terminal/TerminalSettings";
import { MusicSettings } from "../now-playing/MusicSettings";
import { setMusic } from "../now-playing/music";
import { UsageSettings } from "../usage/UsageSettings";
import { SystemSettings } from "../system/SystemSettings";
import { LauncherSettings } from "../launcher/LauncherSettings";
import { GithubSettings } from "../github/GithubSettings";
import { CalendarSettings } from "../calendar/CalendarSettings";
import { NoticesSettings } from "../notices/NoticesSettings";
import { WindowSettings, keyText } from "../window/WindowSettings";
import { keycaps } from "../window/hotkeys";
import { hotkeyStatus } from "../window/store";
import { TradingSettings } from "../trading/TradingSettings";
import { detectPlace } from "../weather/store";
import { focusMode, setFocusMode } from "../../notch/focus";
import { checkForUpdate, installUpdate, update } from "../../lib/update";
import { EdgeSettings } from "../../notch/EdgeSettings";
import { SizeSettings } from "../../notch/SizeSettings";
import { PortableNote } from "../portable/PortableNote";
import { between, changelog, markSeen, useUnseen } from "../../lib/changelog";
import { privacy, togglePresentation, usePresenting } from "../privacy/store";
import { english, LANGUAGE_NAMES, LANGUAGES, t, tBackend, type LanguageSetting } from "../../i18n";
import { ChangelogList } from "../whatsnew/ChangelogList";
import { isMac } from "../../platform/native";
import { ThemeSettings } from "../themes/ThemeSettings";
import { hueVar, useIconColors, type Hue } from "../themes/hues";

type PageId = "general" | "display" | "window" | "tools" | "timer" | "ai" | "accounts" | "themes" | "notices" | "plugins";

const pages: { id: PageId; label: string; icon: Icon; hue: Hue }[] = [
  { id: "general", label: "Allgemein", icon: SlidersHorizontal, hue: "slate" },
  { id: "display", label: "Darstellung", icon: Monitor, hue: "blue" },
  { id: "window", label: "Fenster", icon: AppWindow, hue: "indigo" },
  { id: "tools", label: "Tools", icon: SquaresFour, hue: "orange" },
  { id: "timer", label: "Timer", icon: Timer, hue: "amber" },
  { id: "ai", label: "AI", icon: Sparkle, hue: "violet" },
  { id: "accounts", label: "Verbindungen", icon: Plugs, hue: "teal" },
  { id: "themes", label: "Themen", icon: Palette, hue: "pink" },
  { id: "notices", label: "Mitteilungen", icon: BellSimple, hue: "red" },
  { id: "plugins", label: "Plugins", icon: PuzzlePiece, hue: "green" },
];

/** Deep links from other tools (`navigate("settings", "<section>")`) → page holding that section. */
const sectionPage: Record<string, PageId> = {
  weather: "general",
  updates: "general",
  display: "display",
  presentation: "display",
  window: "window",
  alarm: "timer",
  ask: "ai",
  usage: "ai",
  discord: "accounts",
  trading: "accounts",
  vault: "tools",
  todos: "tools",
  water: "tools",
  terminal: "tools",
  themes: "themes",
  system: "tools",
  launcher: "tools",
  github: "accounts",
  calendar: "accounts",
  notices: "notices",
  plugins: "plugins",
};

/** Last open page survives closing/opening the notch (the component is rebuilt). */
let savedPage: PageId = "general";

type Hit = SearchEntry & { page: PageId; groupId: string };

const textOf = (el: Element | null | undefined) => el?.textContent?.trim() ?? "";
/** The Row whose label and group a hit names, inside `root`. */
const findRow = (root: Element, h: Hit) =>
  [...root.querySelectorAll<HTMLElement>("[data-row]")].find((r) => textOf(r.querySelector("[data-row-label]")) === h.label && (r.closest("section")?.id ?? "") === h.groupId);

/** Every Row of the pages rendered under `root` (one `data-page` wrapper each), with its group's title and the English texts. */
function readRows(root: HTMLElement): Hit[] {
  const seen = new Set<string>();
  return [...root.querySelectorAll<HTMLElement>("[data-page]")].flatMap((pageEl) =>
    [...pageEl.querySelectorAll("[data-row]")].flatMap((row) => {
      const page = pageEl.dataset.page as PageId;
      const section = row.closest("section");
      const groupId = section?.id ?? "";
      const label = textOf(row.querySelector("[data-row-label]"));
      const key = `${page}|${groupId}|${label}`;
      if (!label || seen.has(key)) return [];
      seen.add(key);
      const hint = textOf(row.querySelector("[data-row-hint]"));
      const group = textOf(section?.querySelector(":scope > h3"));
      return [{ page, groupId, label, hint, group, en: { label: english(label), hint: english(hint), group: english(group) } }];
    }),
  );
}

/**
 * Settings like macOS: categories on the left, only their content on the right.
 * Other tools jump straight to their section via `navigate("settings", "<section>")`.
 */
export function SettingsView() {
  const { section } = nav.use();
  const [page, setPageState] = useState<PageId>(() => (section && sectionPage[section]) || savedPage);
  const iconColors = useIconColors();
  const scroller = useRef<HTMLDivElement>(null);
  const setPage = (p: PageId) => {
    savedPage = p;
    setPageState(p);
  };
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Hit[]>([]);
  const [target, setTarget] = useState<Hit | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const hidden = useRef<HTMLDivElement>(null);
  const searching = query.trim() !== "";
  const results = searching ? searchSettings(rows, query) : [];

  // The index is the real pages, rendered hidden while searching and read again on every keystroke, so it never goes stale.
  useLayoutEffect(() => {
    if (searching && hidden.current) setRows(readRows(hidden.current));
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      field.current?.focus();
      field.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openHit = (h: Hit) => {
    setQuery("");
    setPage(h.page);
    setTarget(h);
  };

  useEffect(() => {
    if (!target) return;
    // Like the deep link below: the row only exists after the page switch.
    const id = window.setTimeout(() => {
      const box = scroller.current;
      const row = box && findRow(box, target);
      if (!row) return;
      const group = row.closest("section");
      const fits = !!group && row.getBoundingClientRect().bottom - group.getBoundingClientRect().top <= box.clientHeight;
      (fits ? group : row).scrollIntoView({ behavior: "smooth", block: fits ? "start" : "center" });
      row.animate([{ backgroundColor: "var(--color-fill-3)" }, { backgroundColor: "var(--color-fill-3)", offset: 0.4 }, { backgroundColor: "transparent" }], { duration: 1600, easing: "ease-out" });
    }, 120);
    return () => window.clearTimeout(id);
  }, [target]);

  useEffect(() => {
    if (!section || !sectionPage[section]) return;
    setPage(sectionPage[section]);
    // The section only exists after the page switch.
    const id = window.setTimeout(
      () => scroller.current?.querySelector<HTMLElement>(`#settings-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
      120,
    );
    return () => window.clearTimeout(id);
  }, [section]);

  return (
    <div className="flex h-full gap-3 px-4 pt-1 pb-3">
      <nav className="flex w-[136px] shrink-0 flex-col gap-0.5">
        <label className="mb-1 flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] bg-fill-1 px-2 text-label-3 focus-within:bg-fill-2">
          <MagnifyingGlass size={12} weight="bold" className="shrink-0" />
          <input
            ref={field}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape" || !query) return;
              // Esc clears first; only an empty field lets it through to close the notch.
              e.stopPropagation();
              setQuery("");
            }}
            placeholder={t("Suchen")}
            aria-label={t("Suchen")}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-footnote text-label outline-none placeholder:text-label-4"
          />
        </label>
        {pages.map((p) => {
          const active = p.id === page && !searching;
          return (
            <button
              key={p.id}
              onClick={() => {
                setQuery("");
                setPage(p.id);
              }}
              aria-current={active ? "page" : undefined}
              className={`pressable relative flex h-8 items-center gap-2 rounded-[8px] px-2.5 text-start text-body transition-colors duration-150 ${
                active ? "text-label" : "text-label-3 hover:text-label-2"
              }`}
            >
              {active && <motion.span layoutId="settings-page" className="absolute inset-0 rounded-[8px] bg-fill-2" transition={springs.snappy} />}
              <p.icon size={15} weight={active ? "fill" : "bold"} className="relative shrink-0" style={iconColors ? { color: hueVar(p.hue) } : undefined} />
              <span className="relative truncate">{t(p.label)}</span>
            </button>
          );
        })}
        {/* Not a page: opens GitHub's form, with this version filled in. */}
        <button
          onClick={openBugReport}
          title={t("Öffnet das Formular auf GitHub, mit deiner NotNotch-Version schon eingetragen")}
          className="pressable relative flex min-h-8 items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-start text-body text-label-3 transition-colors duration-150 hover:text-label-2"
        >
          <Bug size={15} weight="bold" className="relative shrink-0" style={iconColors ? { color: hueVar("rose") } : undefined} />
          {/* Longer in some languages than the pages' names: it wraps rather than being cut. */}
          <span className="relative leading-tight">{t("Fehler melden")}</span>
        </button>
      </nav>
      {/* Ref on the stable container: popLayout doesn't pass refs to the child. */}
      <div ref={scroller} className="relative min-w-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={searching ? "search" : page}
            className="absolute inset-0 flex flex-col gap-4 overflow-y-auto pb-6 [scrollbar-width:none]"
            style={{ maskImage: "linear-gradient(180deg, #000 calc(100% - 28px), transparent)" }}
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          >
            {searching ? <SearchResults hits={results} onOpen={openHit} /> : <PageContent page={page} />}
          </motion.div>
        </AnimatePresence>
      </div>
      {searching && (
        // Every page, never shown: only read for the index. The LayoutGroup keeps their layoutIds apart from the visible ones.
        <div ref={hidden} hidden inert>
          <LayoutGroup id="settings-search">
            {pages.map((p) => (
              <div key={p.id} data-page={p.id}>
                <PageContent page={p.id} />
              </div>
            ))}
          </LayoutGroup>
        </div>
      )}
    </div>
  );
}

function SearchResults({ hits, onOpen }: { hits: Hit[]; onOpen: (h: Hit) => void }) {
  if (!hits.length) return <div className="px-3 pt-2 text-caption text-label-3">{t("Nichts gefunden")}</div>;
  return (
    <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-[12px] bg-fill-1">
      {hits.map((h) => {
        const pageName = t(pages.find((p) => p.id === h.page)!.label);
        return (
          <button
            key={`${h.page}|${h.groupId}|${h.label}`}
            onClick={() => onOpen(h)}
            className="flex min-h-9 flex-col items-stretch px-3 py-1.5 text-start outline-none hover:bg-fill-2 focus-visible:bg-fill-2"
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate text-body text-label">{h.label}</span>
              <span className="shrink-0 text-caption text-label-4">{[...new Set([pageName, h.group])].filter(Boolean).join(" · ")}</span>
            </span>
            {h.hint && <span className="text-caption text-label-3">{h.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** One settings page's groups; also rendered hidden for the search index. */
function PageContent({ page }: { page: PageId }) {
  return (
    <>
      {page === "general" && (
        <>
          <General />
          <Weather />
          <Updates />
          <Support />
        </>
      )}
      {page === "display" && (
        <>
          <Display />
          <MusicSettings />
          <Presentation />
        </>
      )}
      {page === "window" && <WindowSettings />}
      {page === "tools" && (
        <>
          <Tools />
          <SystemSettings />
          <VaultSettings />
          <ProductivitySettings />
          <TerminalSettings />
          <LauncherSettings />
        </>
      )}
      {page === "timer" && (
        <>
          <Alarm />
          <FocusSoundSettings />
          <TimerLookSettings />
          <ClockLookSettings />
        </>
      )}
      {page === "notices" && <NoticesSettings />}
      {page === "plugins" && <PluginSettings />}
      {page === "ai" && (
        <>
          <Ask />
          <UsageSettings />
          <KeysNote />
        </>
      )}
      {page === "accounts" && (
        <>
          <Discord />
          <TradingSettings />
          <GithubSettings />
          <CalendarSettings />
          <KeysNote />
        </>
      )}
      {page === "themes" && <ThemeSettings />}
    </>
  );
}

/** Version, update check and install on click. Nothing downloads unasked. */
function Updates() {
  const auto = settings.use().updates.auto;
  const u = update.use();
  const unseen = useUnseen();
  // Remember what was new when the section opened, so the labels stay while reading.
  const [fresh] = useState(() => new Set(unseen.map((e) => e.version)));
  const [showLog, setShowLog] = useState(false);
  const busy = u.phase === "checking" || u.phase === "downloading";
  const status = {
    idle: undefined,
    checking: t("Suche …"),
    current: t("Du hast die neueste Version"),
    available: t("Neue Version gefunden"),
    downloading: t("Wird geladen … {n} %", { n: Math.round(u.progress * 100) }),
    error: t("Prüfung fehlgeschlagen – später erneut versuchen"),
  }[u.phase];
  const upcoming = u.notes && u.version && u.current ? between(u.notes, u.current, u.version) : [];

  return (
    <Group title={t("Updates")} id="settings-updates">
      <Row label={t("Version {v}", { v: u.current ?? "–" })} hint={status}>
        {!u.store && (
          <Button disabled={busy} onClick={() => void checkForUpdate()}>
            {t("Jetzt suchen")}
          </Button>
        )}
      </Row>
      {u.store && <Row label={t("Updates kommen über den Microsoft Store")} />}
      <DiagnosticsRow />
      <PortableNote />
      <AnimatePresence initial={false}>
        {(u.phase === "available" || u.phase === "downloading") && u.version && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden">
            <Row label={t("Version {v} verfügbar", { v: u.version })} hint={t("Lädt, installiert und startet neu")}>
              {u.phase === "downloading" ? (
                <div className="h-1.5 w-28 overflow-hidden rounded-full bg-fill-2">
                  <div className="h-full origin-left rtl:origin-right rounded-full bg-label transition-transform duration-150 ease-linear" style={{ transform: `scaleX(${u.progress})` }} />
                </div>
              ) : (
                <Button primary onClick={() => void installUpdate()}>
                  {t("Jetzt aktualisieren")}
                </Button>
              )}
            </Row>
            {upcoming.length > 0 && <ChangelogList entries={upcoming} />}
          </motion.div>
        )}
      </AnimatePresence>
      <Row
        label={
          <span className="flex items-center gap-1.5">
            {t("Neuerungen")}
            {unseen.length > 0 && !showLog && <span className="size-[7px] rounded-full bg-link" />}
          </span>
        }
        hint={unseen.length > 0 ? t(unseen.length === 1 ? "Neu in Version {v}" : "{n} Versionen seit deinem letzten Update", { v: unseen[0].version, n: unseen.length }) : undefined}
      >
        <Button
          onClick={() => {
            if (!showLog) markSeen();
            setShowLog((v) => !v);
          }}
        >
          {showLog ? t("Ausblenden") : t("Anzeigen")}
        </Button>
      </Row>
      <AnimatePresence initial={false}>
        {showLog && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden">
            <ChangelogList entries={between(changelog, null, u.current ?? changelog[0].version)} fresh={fresh} />
          </motion.div>
        )}
      </AnimatePresence>
      {!u.store && (
        <Row label={t("Automatisch suchen")} hint={t("Einmal täglich, anonym bei GitHub – ohne deine Daten")}>
          <Switch label={t("Automatisch suchen")} checked={auto} onChange={(on) => updateSettings({ updates: { auto: on } })} />
        </Row>
      )}
    </Group>
  );
}

/** Copies a plain-text block for bug reports (diagnostics.ts): versions, Windows, monitors, settings and error codes only. */
function DiagnosticsRow() {
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const copy = async () => {
    const s = settings.get();
    const u = update.get();
    try {
      const [sys, info, port] = await Promise.all([systemDiagnostics(), build.info(), portable.info()]);
      const text = diagnosticsText({
        version: u.current ?? "unknown",
        build: info.store ? "store" : port.portable ? "portable" : "installer",
        os: sys.os,
        osBuild: sys.build,
        arch: sys.arch,
        machine: sys.machine,
        scales: sys.scales,
        panelScale: s.behavior.scale,
        tools: s.tools.filter((x) => x.enabled).map((x) => x.id),
        closedStyle: s.display.idleStyle,
        edge: s.dock.edge,
        anchor: s.dock.anchor,
        errors: [
          ["update", u.phase === "error" ? "check-failed" : null],
          ["github", github.get().error],
          ["fps", fps.get().error],
          ["discord", discordState.get().error],
        ],
      });
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied(null), 1600);
  };
  const hint =
    copied === "ok"
      ? t("Kopiert")
      : copied === "failed"
        ? t("Kopieren fehlgeschlagen")
        : t("Version, Windows, Bildschirme und Einstellungen für einen Fehlerbericht, ohne persönliche Daten");
  return (
    <Row label={t("Diagnose kopieren")} hint={hint}>
      <Button onClick={() => void copy()}>{t("Kopieren")}</Button>
    </Row>
  );
}

function Support() {
  const { store } = update.use();
  return (
    <Group title={t("Unterstützen")} id="settings-support">
      <Row label={t("NotNotch unterstützen")} hint={t("Kostenlos und ohne Werbung. Spenden über GitHub Sponsors sind freiwillig")}>
        <Button onClick={openSponsors}>{t("Sponsern")}</Button>
      </Row>
      {store && (
        <Row label={t("NotNotch bewerten")} hint={t("Eine Bewertung im Microsoft Store hilft anderen, NotNotch zu finden")}>
          <Button onClick={openStoreReview}>{t("Bewerten")}</Button>
        </Row>
      )}
    </Group>
  );
}

/** Versions with their short notes; `fresh` marks the ones new since your last update. */
function KeysNote() {
  return (
    <div className="flex items-start gap-1.5 px-3 pb-1 text-caption text-label-4">
      <LockSimple size={11} weight="bold" className="mt-0.5 shrink-0" />
      {t("Schlüssel liegen in der Windows-Anmeldeinformationsverwaltung. Alles bleibt auf diesem PC.")}
    </div>
  );
}

function Ask() {
  const s = settings.use();
  return (
    <Group title={t("AI-Chat")} id="settings-ask">
      <Row label={t("Anbieter")}>
        <Segmented<AskProvider>
          id="ask-provider"
          size="sm"
          value={s.ask.provider}
          onChange={(provider) => updateSettings({ ask: { ...s.ask, provider } })}
          options={(Object.keys(providerInfo) as AskProvider[]).map((p) => ({ value: p, label: providerInfo[p].label }))}
        />
      </Row>
      {s.ask.provider === "custom" && (
        <Row label={t("Base-URL")} hint={t("OpenAI-kompatibel, endet meist auf /v1")}>
          <TextField
            value={s.ask.configs.custom.baseUrl}
            onChange={(baseUrl) => updateAsk("custom", { baseUrl: baseUrl.trim() })}
            placeholder="https://…/v1"
            width="w-52"
          />
        </Row>
      )}
      <SecretRow name={`ai.${s.ask.provider}` as SecretName} label={t("API-Schlüssel")} />
      <Row label={t("Modell")} hint={s.ask.provider === "openrouter" ? t("Modell-ID von openrouter.ai/models") : undefined}>
        <TextField
          value={s.ask.configs[s.ask.provider].model}
          onChange={(model) => updateAsk(s.ask.provider, { model: model.trim() })}
          placeholder={t(providerInfo[s.ask.provider].modelHint)}
          width="w-52"
        />
      </Row>
      <Row label="Effort" hint={t("Wie gründlich das Modell nachdenkt")}>
        <Segmented
          id="ask-effort-settings"
          size="sm"
          value={s.ask.configs[s.ask.provider].effort}
          onChange={(effort) => updateAsk(s.ask.provider, { effort })}
          options={effortLevels}
        />
      </Row>
    </Group>
  );
}

/** Open on hover or click, and the hover delay (also in the first-run setup). */
export function OpenRows() {
  const s = settings.use();
  return (
    <>
      <Row label={t("Öffnen")}>
        <Segmented
          id="open-mode"
          size="sm"
          value={s.openMode}
          onChange={(openMode) => updateSettings({ openMode })}
          options={[
            { value: "hover", label: t("Hover") },
            { value: "click", label: t("Klick") },
          ]}
        />
      </Row>
      <AnimatePresence initial={false}>
        {s.openMode === "hover" && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden">
            <Row label={t("Hover-Verzögerung")}>
              <Segmented
                id="hover-delay"
                size="sm"
                value={s.hoverDelay}
                onChange={(hoverDelay) => updateSettings({ hoverDelay })}
                options={[
                  { value: "fast", label: t("Schnell") },
                  { value: "normal", label: t("Normal") },
                  { value: "patient", label: t("Geduldig") },
                ]}
              />
            </Row>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** The open shortcut as keycaps, with a warning when another program holds it. */
export function ShortcutRow() {
  const keys = settings.use().behavior.hotkeys.open;
  const openKey = hotkeyStatus.use().open;
  return (
    <Row
      label={t("Tastenkürzel")}
      hint={
        openKey === "in-use" ? (
          <span className="text-orange">{t("Ein anderes Programm nutzt diese Kombination, sie ist nicht aktiv; ändern unter Fenster")}</span>
        ) : (
          t("Öffnet und schließt die Notch von überall; ändern unter Fenster")
        )
      }
    >
      {/* Key combinations read left to right in any language. */}
      <span dir="ltr" className="flex items-center gap-1 text-caption text-label-2">
        <Keyboard size={13} weight="bold" className="text-label-3" />
        {keycaps(keys).map(keyText).map((k) => (
          <kbd key={k} className="rounded-[5px] bg-fill-2 px-1.5 py-0.5 font-sans text-caption">{k}</kbd>
        ))}
      </span>
    </Row>
  );
}

function General() {
  const s = settings.use();
  const [auto, setAuto] = useState<boolean | null>(null);
  const autostartLabel = isMac ? t("Bei der Anmeldung öffnen") : t("Mit Windows starten");
  const [autoError, setAutoError] = useState<string | null>(null);
  useEffect(() => {
    void autostart.get().then(setAuto);
  }, []);

  return (
    <Group>
      <Row label={t("Sprache")}>
        <Select<LanguageSetting>
          width="w-40"
          value={s.lang}
          onChange={(lang) => updateSettings({ lang })}
          options={LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_NAMES[l] }))}
        />
      </Row>
      <Row label={t("Uhrzeit")}>
        <Segmented
          id="clock-format"
          size="sm"
          value={s.units.clock}
          onChange={(clock) => updateSettings((p) => ({ units: { ...p.units, clock } }))}
          options={[
            { value: "24", label: t("24 Std.") },
            { value: "12", label: t("12 Std.") },
          ]}
        />
      </Row>
      <OpenRows />
      <Row label={t("Schließen-Verzögerung")} hint={t("Wie lange die Notch offen bleibt, nachdem der Zeiger sie verlassen hat")}>
        <Segmented
          id="close-delay"
          size="sm"
          value={s.behavior.closeDelay}
          onChange={(closeDelay) => updateSettings((cur) => ({ behavior: { ...cur.behavior, closeDelay } }))}
          options={[
            { value: "fast", label: t("Schnell") },
            { value: "normal", label: t("Normal") },
            { value: "patient", label: t("Geduldig") },
          ]}
        />
      </Row>
      <Row label={autostartLabel} hint={autoError ?? undefined}>
        {auto !== null && (
          <Switch
            label={autostartLabel}
            checked={auto}
            onChange={(v) => {
              setAuto(v);
              setAutoError(null);
              // Windows can refuse (the Store build's startup task switched off in Task Manager): say so and show the real state.
              autostart.set(v).catch((e) => {
                setAutoError(tBackend(String(e)));
                void autostart.get().then(setAuto);
              });
            }}
          />
        )}
      </Row>
      <ShortcutRow />
      <Row label={t("Einrichtung")} hint={t("Voreinstellung, Aussehen und Öffnen noch einmal wählen")}>
        <Button onClick={() => navigate(setupTab.id)}>{t("Erneut starten")}</Button>
      </Row>
    </Group>
  );
}

const statusAlerts: [keyof ClosedSettings["statusAlerts"], string, string][] = [
  ["power", "Ladegerät und Akku", "Beim Ein- und Ausstecken, Akku bei 20 und 10 %"],
  ["net", "Netzwerk", "Wenn das Internet wegfällt und zurückkommt"],
  ["bt", "Bluetooth-Geräte", "Beim Verbinden oder Trennen, mit Akku, wenn das Gerät ihn meldet"],
  ["volume", "Lautstärke", "Mit Pegel, wenn sich die Lautstärke oder Stummschaltung ändert"],
  ["brightness", "Helligkeit", "Eingebauter Bildschirm sofort, externe Monitore über DDC/CI alle 2 Sekunden"],
  ["lock", "Feststell- und Num-Taste", "Wenn die Feststelltaste oder die Num-Taste umgeschaltet wird"],
  ["hideOsd", "Windows-Anzeige ausblenden", "Blendet die Lautstärke- und Helligkeitsanzeige von Windows aus, solange NotNotch läuft; braucht Lautstärke und Helligkeit"],
];

/** Where and when the notch shows up. */
function Display() {
  const s = settings.use();
  const d = s.display;
  const focus = focusMode.use();
  const fpsError = fps.use().error;
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  useEffect(() => {
    void display.monitors().then(setMonitors);
  }, []);
  const label = (m: MonitorInfo, i: number) => `${m.primary ? t("Hauptbildschirm") : t("Bildschirm {n}", { n: i + 1 })} · ${m.width}×${m.height}`;

  return (
    <Group id="settings-display">
      {monitors.length > 1 && (
        <Row
          label={t("Monitor")}
          hint={d.monitorMode === "follow" ? t("Geschlossen wandert die Notch auf den Bildschirm mit dem Mauszeiger") : d.monitorMode === "all" ? t("Eine geschlossene Notch auf jedem Bildschirm; sie öffnet sich dort, wo du sie berührst") : undefined}
        >
          <Select
            width="w-52"
            value={d.monitorMode !== "chosen" ? d.monitorMode : (d.monitor ?? monitors.find((m) => m.primary)?.name ?? monitors[0].name)}
            onChange={(value) =>
              updateSettings((cur) => ({
                display:
                  value === "follow" || value === "all"
                    ? { ...cur.display, monitorMode: value }
                    : { ...cur.display, monitorMode: "chosen", monitor: monitors.find((m) => m.name === value)?.primary ? null : value },
              }))
            }
            options={[
              { value: "follow", label: t("Dem Mauszeiger folgen") },
              { value: "all", label: t("Alle Monitore") },
              ...monitors.map((m, i) => ({ value: m.name, label: label(m, i) })),
            ]}
          />
        </Row>
      )}
      <EdgeSettings />
      {(d.offset !== 0 || d.y !== 5) && (
        <Row label={t("Position")} hint={t("Notch an der Kopfzeile oder geschlossen ziehen, um sie zu verschieben")}>
          <Button onClick={() => updateSettings((cur) => ({ display: { ...cur.display, offset: 0, y: 5 } }))}>
            <span className="flex items-center gap-1.5">
              <ArrowsInLineHorizontal size={13} weight="bold" /> {t("Zur Mitte")}
            </span>
          </Button>
        </Row>
      )}
      <ClosedStyle />
      <SizeSettings />
      <ClosedParts />
      <Row label={t("Fortschritt auf der Linie")} hint={t("Zeigt, wie weit das Lied ist, solange Musik läuft")}>
        <Switch label={t("Fortschritt auf der Linie")} checked={s.closed.lineProgress} onChange={(lineProgress) => updateSettings((cur) => ({ closed: { ...cur.closed, lineProgress } }))} />
      </Row>
      <Row label={t("Hinweis bei Kontingent 70 und 90 %")} hint={t("Braucht den Teil AI-Nutzung")}>
        <Switch label={t("Hinweis bei Kontingent 70 und 90 %")} checked={s.closed.quotaAlerts} onChange={(quotaAlerts) => updateSettings((cur) => ({ closed: { ...cur.closed, quotaAlerts } }))} />
      </Row>
      <Row label={t("Hinweis bei fertigem Download")} hint={t("Mit Im Ordner zeigen und Zur Ablage, nicht in den Ruhezeiten")}>
        <Switch label={t("Hinweis bei fertigem Download")} checked={s.closed.downloadAlerts} onChange={(downloadAlerts) => updateSettings((cur) => ({ closed: { ...cur.closed, downloadAlerts } }))} />
      </Row>
      <Row label={t("Statusmeldungen")} />
      {statusAlerts.map(([k, label, hint]) => (
        <Row key={k} label={t(label)} hint={t(hint)}>
          <Switch label={t(label)} checked={s.closed.statusAlerts[k]} onChange={(v) => updateSettings((cur) => ({ closed: { ...cur.closed, statusAlerts: { ...cur.closed.statusAlerts, [k]: v } } }))} />
        </Row>
      ))}
      <Row label={t("Fokus-Modus")} hint={t("Klicks gehen durch. 3× schnell auf die Notch klicken schaltet um – oder im Tray-Menü.")}>
        <Switch label={t("Fokus-Modus")} checked={focus} onChange={setFocusMode} />
      </Row>
      <Row
        label={t("Fokus-Darstellung")}
        hint={d.focusStyle === "line" ? t("Nur eine dünne Linie am Rand, ohne Musik und Co.") : t("Halb durchsichtig, Musik und Co. bleiben sichtbar")}
      >
        <Segmented
          id="focus-style"
          size="sm"
          value={d.focusStyle}
          onChange={(focusStyle) => updateSettings((cur) => ({ display: { ...cur.display, focusStyle } }))}
          options={[
            { value: "dim", label: t("Durchsichtig") },
            { value: "line", label: t("Linie") },
          ]}
        />
      </Row>
      <Row
        label={t("Gaming-Modus")}
        hint={t("FPS und Auslastung in der geschlossenen Notch")}
      >
        <Segmented
          id="gaming-mode"
          size="sm"
          value={s.gaming.mode}
          onChange={(mode) => updateSettings({ gaming: { mode } })}
          options={[
            { value: "off", label: t("Aus") },
            { value: "fullscreen", label: t("Bei Vollbild") },
            { value: "on", label: t("Immer") },
          ]}
        />
      </Row>
      {fpsError === "no-admin" && <FpsUnlockRow />}
      {fpsError === "relogin" && (
        <Row label={t("FPS freischalten")} hint={t("Fertig – einmal ab- und wieder anmelden, dann laufen die FPS")}>
          <SignOut size={18} weight="bold" className="text-orange" />
        </Row>
      )}
      <Row label={t("Aufnahme-Punkte")} hint={t("Grün: Mikrofon/Kamera aktiv · Rot: Bildschirm wird aufgenommen")}>
        <Switch label={t("Aufnahme-Punkte")} checked={s.privacyDots} onChange={(privacyDots) => updateSettings({ privacyDots })} />
      </Row>
    </Group>
  );
}

/** Closed look: notch, capsule or line, with previews (also in the first-run setup). */
export function ClosedStyle() {
  const style = settings.use().display.idleStyle;
  return (
    <div className="pb-3">
      <Row
        label={t("Geschlossen")}
        hint={
          style === "line"
            ? t("Nur eine dünne Linie, ein abgelaufener Timer klappt trotzdem auf")
            : style === "capsule"
              ? t("Schwebt frei, zum Verschieben ziehen")
              : t("Die Notch zeigt Musik, Timer und Co.")
        }
      />
      <div className="px-3">
        <StyleCards
          label={t("Geschlossen")}
          value={style}
          onChange={(idleStyle) => updateSettings((cur) => ({ display: { ...cur.display, idleStyle } }))}
          options={[
            { value: "notch", label: t("Notch"), preview: <ShapePreview d="M6 0H54C51 0 50 1.5 50 4V8C50 11 48 13 45 13H15C12 13 10 11 10 8V4C10 1.5 9 0 6 0Z" /> },
            { value: "capsule", label: t("Kapsel"), preview: <ShapePreview d="M16.5 4H43.5A4.5 4.5 0 0 1 43.5 13H16.5A4.5 4.5 0 0 1 16.5 4Z" /> },
            { value: "line", label: t("Linie"), preview: <ShapePreview d="M15 0H45A1 1 0 0 1 45 2H15A1 1 0 0 1 15 0Z" /> },
          ]}
        />
      </div>
    </div>
  );
}

/** Miniature of a closed shape hanging from the screen's top edge (viewBox 60 × 16). */
function ShapePreview({ d }: { d: string }) {
  return (
    <svg width={90} height={24} viewBox="0 0 60 16" aria-hidden>
      <path d={d} fill="currentColor" />
    </svg>
  );
}

const partInfo: Record<PartId, { label: string; icon: Icon; hue: Hue }> = {
  timer: { label: "Timer", icon: Timer, hue: "orange" },
  discord: { label: "Discord", icon: DiscordLogo, hue: "indigo" },
  rings: { label: "AI-Nutzung", icon: ChartDonut, hue: "purple" },
  title: { label: "Songtitel", icon: MusicNote, hue: "pink" },
  readings: { label: "Auslastung", icon: Cpu, hue: "red" },
  equalizer: { label: "Equalizer", icon: Waveform, hue: "pink" },
  clock: { label: "Uhrzeit", icon: Clock, hue: "blue" },
  github: { label: "GitHub heute", icon: GithubLogo, hue: "violet" },
  calendar: { label: "Nächster Termin", icon: CalendarBlank, hue: "red" },
  script: { label: "Skript-Anzeigen (notnotch-notify)", icon: TerminalWindow, hue: "slate" },
  downloads: { label: "Downloads", icon: DownloadSimple, hue: "teal" },
};

/** Small labelled switch for a part's own options, next to its main switch. */
function SubSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <span className="flex items-center gap-1.5 text-caption text-label-3 select-none">
      {label}
      <Switch label={label} checked={checked} onChange={onChange} />
    </span>
  );
}

/** Parts of the closed row (notch and capsule share them): drag to reorder, switch on/off. Same pattern as `Tools()`. */
function ClosedParts() {
  const { closed: c, music } = settings.use();
  const [dragging, setDragging] = useState<PartId | null>(null);
  const setClosed = (patch: (cur: ClosedSettings) => Partial<ClosedSettings>) => updateSettings((cur) => ({ closed: { ...cur.closed, ...patch(cur.closed) } }));
  // Only these always show; battery, power and temperature can be missing, so they cannot keep the part alone.
  const readingsOn = (["cpu", "ram", "gpu"] as const).filter((k) => c.readings[k]).length;
  const iconColors = useIconColors();

  return (
    <div>
      <Row label={t("Inhalt")} hint={t("Gilt für Notch und Kapsel, zum Sortieren ziehen")} />
      <Reorder.Group as="div" axis="y" values={c.order} onReorder={(order: PartId[]) => setClosed(() => ({ order }))} className="divide-y divide-separator">
        {c.order.map((id) => {
          const { label, icon: I, hue } = partInfo[id];
          const on = c.parts[id];
          return (
            <Reorder.Item
              key={id}
              value={id}
              as="div"
              transition={springs.snappy}
              onDragStart={() => setDragging(id)}
              onDragEnd={() => setDragging(null)}
              whileDrag={{ scale: 1.02 }}
              className={`group relative flex h-9 cursor-grab items-center gap-2.5 px-3 active:cursor-grabbing ${
                dragging === id ? "z-10 rounded-[10px] bg-elevated shadow-[0_6px_18px_rgb(0_0_0/0.45)]" : ""
              }`}
            >
              <DotsSixVertical size={13} weight="bold" className="-ms-1 text-label-4 transition-colors group-hover:text-label-3" />
              <I size={15} weight="bold" className={on && iconColors ? "" : on ? "text-label-2" : "text-label-4"} style={on && iconColors ? { color: hueVar(hue) } : undefined} />
              <span className={`flex-1 text-body select-none ${on ? "text-label" : "text-label-3"}`}>{t(label)}</span>
              <div onPointerDown={(e) => e.stopPropagation()} className="flex items-center gap-3">
                {on && id === "readings" &&
                  (["cpu", "ram", "gpu"] as const).map((k) => (
                    <SubSwitch
                      key={k}
                      label={k.toUpperCase()}
                      checked={c.readings[k]}
                      // One reading stays on, otherwise the part would be empty.
                      onChange={(v) => (v || readingsOn > 1) && setClosed((cur) => ({ readings: { ...cur.readings, [k]: v } }))}
                    />
                  ))}
                {on && id === "clock" && <SubSwitch label={t("Sekunden")} checked={c.clockSeconds} onChange={(clockSeconds) => setClosed(() => ({ clockSeconds }))} />}
                {on && id === "title" && <SubSwitch label={t("Songtext")} checked={music.titleLyrics} onChange={(titleLyrics) => setMusic({ titleLyrics })} />}
                <Switch label={t(label)} checked={on} onChange={(v) => setClosed((cur) => ({ parts: { ...cur.parts, [id]: v } }))} />
              </div>
            </Reorder.Item>
          );
        })}
      </Reorder.Group>
    </div>
  );
}

/** Presentation mode: one switch, plus automatic while the screen is recorded or shared. */
function Presentation() {
  const { manual, auto } = settings.use().presentation;
  const presenting = usePresenting();
  const recording = privacy.use().screen;
  return (
    <Group title={t("Präsentationsmodus")} id="settings-presentation">
      <Row
        label={t("Präsentationsmodus")}
        hint={presenting && !manual ? t("Aktiv – Bildschirmaufnahme erkannt") : t("Blendet Zwischenablage, Kontostände, Tresor, Aufnahmen und Ablage aus")}
      >
        <Switch label={t("Präsentationsmodus")} checked={presenting} onChange={togglePresentation} />
      </Row>
      <Row label={t("Bei Bildschirmaufnahme")} hint={t("Teams, Discord, OBS … – schaltet sich danach wieder ab")}>
        <Switch
          label={t("Bei Bildschirmaufnahme")}
          checked={auto}
          onChange={(on) => updateSettings((cur) => ({ presentation: { ...cur.presentation, auto: on } }))}
        />
      </Row>
      {auto && recording && !presenting && (
        <Row label={t("Für diese Aufnahme aus")} hint={t("Schaltet sich bei der nächsten wieder ein")} />
      )}
    </Group>
  );
}

const discordStatus: Record<string, string> = {
  off: "Aus – Tool „Discord“ einschalten",
  "no-config": "Client-ID und Secret fehlen",
  "no-client": "Discord läuft nicht",
  connecting: "Verbinde …",
  authorizing: "In Discord bestätigen",
  ready: "Verbunden",
  error: "Fehler",
};

/** Discord call: your own app in the developer portal (the only way Discord grants voice scopes). */
function Discord() {
  const s = settings.use();
  const state = discordState.use();
  const [id, setId] = useState(s.discord.clientId);
  const save = () => updateSettings({ discord: { clientId: id.trim() } });
  return (
    <Group title="Discord" id="settings-discord">
      <Row label={t("Status")} hint={state.error ? tBackend(state.error) : undefined}>
        <span className={`text-caption ${state.status === "ready" ? "text-green" : "text-label-2"}`}>{t(discordStatus[state.status] ?? state.status)}</span>
      </Row>
      <Row label={t("Client-ID")}>
        <div className="flex items-center gap-1.5">
          <TextField value={id} onChange={setId} onSubmit={save} placeholder="123456789012345678" width="w-40" />
          {id.trim() !== s.discord.clientId && <Button onClick={save}>{t("Sichern")}</Button>}
        </div>
      </Row>
      <SecretRow name="discord.secret" label={t("Client-Secret")} onSaved={reconnectDiscord} />
      <div className="px-3 py-2 text-caption text-label-3">
        {t("discord.com/developers → New Application → OAuth2: Client-ID und Client-Secret kopieren und unter Redirects http://localhost eintragen und speichern. Beim ersten Verbinden fragt Discord einmal nach.")}
      </div>
    </Group>
  );
}

const durations: { value: string; label: string }[] = [
  { value: "0", label: "1×" },
  { value: "5", label: "5 s" },
  { value: "15", label: "15 s" },
  { value: "30", label: "30 s" },
  { value: "-1", label: "Bis Stopp" },
];

/** Timer alarm: sound, volume, duration, with preview. */
function Alarm() {
  const a = settings.use().alarm;
  const [previewing, setPreviewing] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const set = (patch: Partial<typeof a>) => updateSettings((cur) => ({ alarm: { ...cur.alarm, ...patch } }));

  const preview = (next = a) => {
    window.clearTimeout(timer.current);
    playAlarm(next.sound, next.volume, 0);
    setPreviewing(true);
    timer.current = window.setTimeout(() => setPreviewing(false), 2500);
  };
  useEffect(() => () => stopAlarm(), []);

  return (
    <Group id="settings-alarm">
      <Row label={t("Alarm-Ton")}>
        <div className="flex items-center gap-1.5">
          <button
            aria-label={previewing ? t("Stopp") : t("Probehören")}
            title={previewing ? t("Stopp") : t("Probehören")}
            onClick={() => {
              if (!previewing) return preview();
              stopAlarm();
              setPreviewing(false);
            }}
            className="pressable pressable-fill flex size-7 items-center justify-center rounded-full bg-fill-2 text-label"
          >
            {previewing ? <Stop size={11} weight="fill" /> : <Play size={11} weight="fill" />}
          </button>
          <Select
            width="w-36"
            value={a.sound}
            onChange={(sound) => {
              set({ sound });
              preview({ ...a, sound });
            }}
            options={alarmSounds.map((o) => ({ ...o, label: t(o.label) }))}
          />
        </div>
      </Row>
      <Row label={t("Lautstärke")}>
        <div className="flex w-52 items-center gap-2">
          <Slider label={t("Lautstärke")} value={Math.round(a.volume * 100)} min={5} max={100} step={5} onChange={(v) => set({ volume: v / 100 })} />
          <span className="tabular w-8 text-end text-caption text-label-2">{Math.round(a.volume * 100)}</span>
        </div>
      </Row>
      <Row label={t("Dauer")} hint={t("Wie lange der Alarm klingelt")}>
        <Segmented id="alarm-duration" size="sm" value={String(a.duration)} onChange={(v) => set({ duration: Number(v) as AlarmDuration })} options={durations.map((o) => ({ ...o, label: t(o.label) }))} />
      </Row>
    </Group>
  );
}

/** Timer: background sound while a focus timer runs, and its volume. */
function FocusSoundSettings() {
  const { focusSound, focusVolume } = settings.use().timer;
  const set = (patch: Partial<{ focusSound: FocusSound; focusVolume: number }>) => updateSettings((cur) => ({ timer: { ...cur.timer, ...patch } }));
  return (
    <Group id="settings-focus-sound">
      <Row label={t("Fokus-Klang")} hint={t("Spielt, solange ein Fokus-Timer läuft")}>
        <Select width="w-44" value={focusSound} onChange={(v) => set({ focusSound: v })} options={focusSounds.map((o) => ({ ...o, label: t(o.label) }))} />
      </Row>
      <Row label={t("Lautstärke")}>
        <div className="flex w-52 items-center gap-2">
          <Slider label={t("Lautstärke")} value={Math.round(focusVolume * 100)} min={5} max={100} step={5} onChange={(v) => set({ focusVolume: v / 100 })} />
          <span className="tabular w-8 text-end text-caption text-label-2">{Math.round(focusVolume * 100)}</span>
        </div>
      </Row>
    </Group>
  );
}

/** FPS without admin: unlock once instead of running the notch as administrator every time. */
function FpsUnlockRow() {
  const [state, setState] = useState<"idle" | "busy" | "ok" | "relogin" | "cancelled" | "failed">("idle");
  const hint = {
    idle: t("Einmalige Windows-Abfrage, danach nie wieder Administratorrechte"),
    busy: t("Bitte die Windows-Abfrage bestätigen …"),
    ok: t("Freigeschaltet – die FPS laufen"),
    relogin: t("Fertig – einmal ab- und wieder anmelden, dann laufen die FPS"),
    cancelled: t("Abgebrochen"),
    failed: t("Hat nicht geklappt – NotNotch einmal als Administrator starten"),
  }[state];
  return (
    <Row label={t("FPS freischalten")} hint={hint}>
      {state === "ok" || state === "relogin" ? (
        <CheckCircle size={18} weight="fill" className="text-green" />
      ) : (
        <Button
          disabled={state === "busy"}
          onClick={() => {
            setState("busy");
            void unlockFps().then(setState);
          }}
        >
          {t("Freischalten")}
        </Button>
      )}
    </Row>
  );
}

/** Weather location: automatic via IP or fixed, right here without opening the weather tool. */
function Weather() {
  const { weather: w, units } = settings.use();
  const [searching, setSearching] = useState(false);
  return (
    <Group title={t("Wetter")} id="settings-weather">
      <Row label={t("Standort")} hint={w?.auto ? t("Ungefähr, aus deiner IP-Adresse") : undefined}>
        <Segmented<"auto" | "manual">
          id="weather-mode"
          size="sm"
          value={!w || w.auto ? "auto" : "manual"}
          onChange={(m) => {
            if (m === "auto") {
              setSearching(false);
              void detectPlace(true);
            } else setSearching(true);
          }}
          options={[
            { value: "auto", label: t("Automatisch") },
            { value: "manual", label: t("Manuell") },
          ]}
        />
      </Row>
      <Row label={t("Einheit")}>
        <Segmented
          id="temp-unit"
          size="sm"
          value={units.temp}
          onChange={(temp) => updateSettings((p) => ({ units: { ...p.units, temp } }))}
          options={[
            { value: "c", label: "°C" },
            { value: "f", label: "°F" },
          ]}
        />
      </Row>
      <Row label={t("Ort")}>
        <Button onClick={() => setSearching((v) => !v)}>{w?.name ?? t("Wird erkannt …")}</Button>
      </Row>
      <AnimatePresence initial={false}>
        {searching && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden">
            <div className="p-2">
              <PlaceSearch compact canCancel onDone={() => setSearching(false)} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Group>
  );
}

/** Show/hide tools and drag to reorder. At least one stays on. */
function Tools() {
  const s = settings.use();
  // Plugin tools are listed once their list has been read.
  plugins.use();
  const enabledCount = s.tools.filter((x) => x.enabled).length;
  const [dragging, setDragging] = useState<string | null>(null);

  return (
    <Group>
      <Reorder.Group
        as="div"
        axis="y"
        values={s.tools.map((x) => x.id)}
        onReorder={(ids: string[]) => updateSettings((cur) => ({ tools: ids.map((id) => cur.tools.find((x) => x.id === id)!) }))}
        className="divide-y divide-separator"
      >
        {s.tools.map((tool) => {
          const tab = findTab(tool.id);
          if (!tab) return null;
          return (
            <Reorder.Item
              key={tool.id}
              value={tool.id}
              as="div"
              transition={springs.snappy}
              onDragStart={() => setDragging(tool.id)}
              onDragEnd={() => setDragging(null)}
              whileDrag={{ scale: 1.02 }}
              className={`group relative flex h-9 cursor-grab items-center gap-2.5 px-3 active:cursor-grabbing ${
                dragging === tool.id ? "z-10 rounded-[10px] bg-elevated shadow-[0_6px_18px_rgb(0_0_0/0.45)]" : ""
              }`}
            >
              <DotsSixVertical size={13} weight="bold" className="-ms-1 text-label-4 transition-colors group-hover:text-label-3" />
              <tab.icon size={15} weight="bold" className={tool.enabled ? "text-label-2" : "text-label-4"} />
              <span className={`flex-1 text-body select-none ${tool.enabled ? "text-label" : "text-label-3"}`}>{t(tab.label)}</span>
              <div onPointerDown={(e) => e.stopPropagation()}>
                <Switch
                  label={t(tab.label)}
                  checked={tool.enabled}
                  onChange={(enabled) => {
                    if (!enabled && enabledCount <= 1) return;
                    updateSettings((cur) => ({ tools: cur.tools.map((x) => (x.id === tool.id ? { ...x, enabled } : x)) }));
                  }}
                />
              </div>
            </Reorder.Item>
          );
        })}
      </Reorder.Group>
    </Group>
  );
}

/**
 * Field for a key. Stored values are never read back, it only shows
 * "saved ✓". Typing a new one overwrites it, saving empty deletes it.
 */
export function SecretRow({ name, label, hint, onSaved }: { name: SecretName; label: string; hint?: string; onSaved?: () => void }) {
  const [stored, setStored] = useState(false);
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValue("");
    void secrets.has(name).then(setStored);
  }, [name]);

  const save = async () => {
    await secrets.set(name, value);
    setStored(!!value.trim());
    setValue("");
    setSaved(true);
    setTimeout(() => setSaved(false), 1400);
    onSaved?.();
  };

  return (
    <Row label={label} hint={hint}>
      <div className="flex items-center gap-1.5">
        <AnimatePresence>
          {(saved || (stored && !value)) && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
              <CheckCircle size={14} weight="fill" className="text-green" />
            </motion.span>
          )}
        </AnimatePresence>
        <TextField secret value={value} onChange={setValue} onSubmit={() => void save()} placeholder={stored ? t("Gespeichert") : t("Einfügen")} width="w-40" />
        {(value || stored) && (
          <Button onClick={() => void save()} disabled={!value && !stored}>
            {value ? t("Sichern") : t("Löschen")}
          </Button>
        )}
      </div>
    </Row>
  );
}
