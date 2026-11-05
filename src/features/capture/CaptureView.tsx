import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BoundingBox, Camera, Crop, FilmStrip, FolderOpen, ImageSquare, Microphone, MicrophoneSlash, Pause, Play, Record, SpeakerHigh, SpeakerSlash, Stop, Trash, Tray, type Icon } from "@phosphor-icons/react";
import { fade, pulse, springs } from "../../design/motion";
import { formatBytes, formatTime } from "../../lib/format";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { capture, openFile, revealFile, type CaptureDetails, type CaptureFile, type CaptureSource } from "../../platform/services";
import { settings, updateSettings, type Settings } from "../../settings/store";
import { Button, Empty, Segmented, Select } from "../../ui/controls";
import { useSecondTick } from "../timer/store";
import { usePresenting } from "../privacy/store";
import { locale, t } from "../../i18n";
import { elapsedAt, formatElapsed } from "./clock";
import { libraryEpoch, pauseRecording, recording, startRecording, stopRecording, takeShot } from "./store";

/*
 * Capture: screenshots (all screens, one monitor, or a region) and screen recordings
 * (a monitor or a window, 30 or 60 fps, microphone and system audio), with the saved
 * files below. NotNotch hides itself from the capture, so the open notch is never in it.
 */

type Patch = Partial<Settings["capture"]>;
const setCapture = (patch: Patch) => updateSettings((s) => ({ capture: { ...s.capture, ...patch } }));

export function CaptureView() {
  const cfg = settings.use().capture;
  const rec = recording.use();
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Starting the encoder takes one or two seconds.
  const [starting, setStarting] = useState(false);
  const idle = rec.phase === "idle";

  // Windows come and go: the list is read again whenever a recording ends.
  useEffect(() => {
    if (idle) void capture.sources().then(setSources);
  }, [idle]);

  const monitors = sources.filter((s) => s.kind === "monitor");
  const label = (s: CaptureSource) => (s.kind === "monitor" ? t("Bildschirm {n}", { n: monitors.indexOf(s) + 1 }) : s.name);
  const shotTarget = monitors.some((m) => m.id === cfg.shotTarget) ? cfg.shotTarget : "all";
  const source = sources.find((s) => s.id === cfg.source)?.id ?? monitors[0]?.id ?? "";

  const run = async (job: () => Promise<void>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      await job();
    } catch (e) {
      setError(errorText(String(e), fallback));
    } finally {
      setBusy(false);
    }
  };
  const shoot = (region: boolean) =>
    run(() => (region ? takeShot("region", null) : shotTarget === "all" ? takeShot("all", null) : takeShot("monitor", shotTarget.slice("monitor:".length))), t("Bildschirmfoto fehlgeschlagen"));

  const record = () => {
    setStarting(true);
    void run(() => startRecording(source, cfg.fps, cfg.mic, cfg.system, cfg.border), t("Aufnahme konnte nicht starten")).finally(() => setStarting(false));
  };

  // A sound-only recording is the Recorder's: here it only says why Record waits.
  const warning = error ?? (rec.audio ? (idle ? null : t("Es läuft schon eine Aufnahme")) : failureText(rec.failed));

  return (
    <div className="flex h-full flex-col gap-2 px-4 pt-1 pb-2">
      <HeaderActions>
        <HeaderButton label={t("Bildschirmfotos auch in die Ablage")} active={cfg.shelf} onClick={() => setCapture({ shelf: !cfg.shelf })}>
          <Tray size={14} weight={cfg.shelf ? "fill" : "bold"} />
        </HeaderButton>
        <HeaderButton label={cfg.border ? t("Gelben Aufnahmerahmen ausblenden") : t("Gelben Aufnahmerahmen zeigen")} active={cfg.border} onClick={() => setCapture({ border: !cfg.border })}>
          <BoundingBox size={14} weight="bold" />
        </HeaderButton>
      </HeaderActions>

      <div className="flex items-center gap-2">
        <span className="min-w-[84px] shrink-0 whitespace-nowrap text-footnote text-label-2">{t("Bildschirmfoto")}</span>
        {monitors.length > 1 && (
          <Select
            value={shotTarget}
            width="w-36"
            options={[{ value: "all", label: t("Alle Bildschirme") }, ...monitors.map((m) => ({ value: m.id, label: label(m) }))]}
            onChange={(v) => setCapture({ shotTarget: v })}
          />
        )}
        <Button icon={Camera} disabled={busy} onClick={() => void shoot(false)}>
          {t("Aufnehmen")}
        </Button>
        <Button icon={Crop} disabled={busy} onClick={() => void shoot(true)}>
          {t("Bereich")}
        </Button>
      </div>

      <div className="flex h-7 items-center gap-2">
        <span className="min-w-[84px] shrink-0 whitespace-nowrap text-footnote text-label-2">{t("Video")}</span>
        {idle || rec.audio ? (
          <>
            <Select
              value={source}
              width="w-44"
              options={sources.map((s) => ({ value: s.id, label: label(s) }))}
              onChange={(v) => setCapture({ source: v })}
            />
            <Segmented id="capture-fps" size="sm" value={String(cfg.fps)} options={[{ value: "30", label: "30" }, { value: "60", label: "60" }]} onChange={(v) => setCapture({ fps: v === "60" ? 60 : 30 })} />
            <Toggle on={cfg.mic} icons={[Microphone, MicrophoneSlash]} labels={[t("Mit Mikrofon"), t("Ohne Mikrofon")]} onChange={(mic) => setCapture({ mic })} />
            <Toggle on={cfg.system} icons={[SpeakerHigh, SpeakerSlash]} labels={[t("Mit Systemton"), t("Ohne Systemton")]} onChange={(system) => setCapture({ system })} />
            <Button icon={Record} primary disabled={busy || !source || !idle} onClick={record}>
              {starting ? t("Startet …") : t("Aufzeichnen")}
            </Button>
          </>
        ) : (
          <Running />
        )}
      </div>

      <AnimatePresence>
        {warning && (
          <motion.p className="-mt-1 truncate text-caption text-orange" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
            {warning}
          </motion.p>
        )}
      </AnimatePresence>

      <Library />
    </div>
  );
}

/** Rust sends short codes (src-tauri/src/capture); anything unknown gets the action's own message. */
export function errorText(code: string, fallback: string): string {
  const known: Record<string, string> = {
    busy: t("Es läuft schon eine Aufnahme"),
    "window-closed": t("Das Fenster ist geschlossen"),
    "unknown-source": t("Quelle nicht gefunden"),
    "no-monitor": t("Bildschirm nicht gefunden"),
    "no-folder": t("Ordner nicht verfügbar"),
    "save-failed": t("Datei konnte nicht gespeichert werden"),
    "not-capture": t("Keine Aufnahme von NotNotch"),
    "delete-failed": t("Löschen fehlgeschlagen"),
    "no-media": t("Für Aufnahmen fehlt das Media Feature Pack von Windows"),
    "no-mic": t("Mikrofon nicht verfügbar"),
    "no-audio": t("Kein Ton verfügbar"),
  };
  return known[code] ?? fallback;
}

export function failureText(failed: string[]): string | null {
  if (failed.includes("save")) return t("Die Aufnahme konnte nicht gespeichert werden");
  if (failed.includes("video")) return t("Aufnahme gestoppt: Bild oder Encoder ausgefallen");
  if (failed.includes("partial")) return t("Aufnahme vorzeitig beendet, das Aufgenommene ist gespeichert");
  const parts = [failed.includes("system") && t("Systemton nicht verfügbar"), failed.includes("mic") && t("Mikrofon nicht verfügbar")].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Elapsed time with pause/resume and stop, in place of the recording options. */
export function Running() {
  const rec = recording.use();
  const running = rec.phase === "recording";
  useSecondTick(running, rec.at);
  return (
    <div className="flex items-center gap-2">
      <motion.span
        className={`size-2 rounded-full ${running ? "bg-red" : "bg-label-3"}`}
        animate={running ? { opacity: [1, 0.35] } : { opacity: 1 }}
        transition={running ? pulse : fade}
      />
      <span className="tabular w-14 text-body font-medium text-label">{formatElapsed(elapsedAt(rec, Date.now()))}</span>
      <Button icon={running ? Pause : Play} onClick={() => pauseRecording(running)}>
        {running ? t("Pause") : t("Fortsetzen")}
      </Button>
      <Button icon={Stop} primary onClick={stopRecording}>
        {t("Stopp")}
      </Button>
    </div>
  );
}

export function Toggle(props: { on: boolean; icons: [Icon, Icon]; labels: [string, string]; onChange: (on: boolean) => void }) {
  const I = props.on ? props.icons[0] : props.icons[1];
  const label = props.on ? props.labels[0] : props.labels[1];
  return (
    <button
      aria-label={label}
      aria-pressed={props.on}
      title={label}
      onClick={() => props.onChange(!props.on)}
      className={`pressable flex size-7 shrink-0 items-center justify-center rounded-full ${props.on ? "bg-fill-3 text-label" : "bg-fill-1 text-label-3 hover:text-label-2"}`}
    >
      <I size={14} weight="bold" />
    </button>
  );
}

// ---------- Saved files ----------

/** Newest cards shown; older files stay on disk and in Explorer. */
const LIBRARY_MAX = 60;

/** Thumbnails and durations by path and modification time, kept while the app runs. */
export const detailCache = new Map<string, CaptureDetails>();
export const cacheKey = (f: CaptureFile) => `${f.path}|${f.modified}`;

function Library() {
  const epoch = libraryEpoch.use();
  const [files, setFiles] = useState<CaptureFile[]>([]);
  const [filter, setFilter] = useState<"all" | "shot" | "video">("all");
  const [, setLoaded] = useState(0);

  useEffect(() => {
    let alive = true;
    void capture.list().then((list) => alive && setFiles(list));
    return () => void (alive = false);
  }, [epoch]);

  // Sound-only recordings are the Recorder tool's.
  const shown = files.filter((f) => f.kind !== "audio" && (filter === "all" || f.kind === filter)).slice(0, LIBRARY_MAX);

  // Details only for the cards on screen: the newest of the chosen filter.
  const missingKey = shown.filter((f) => !detailCache.has(cacheKey(f))).map(cacheKey).join("\n");
  useEffect(() => {
    const missing = shown.filter((f) => !detailCache.has(cacheKey(f)));
    if (!missing.length) return;
    let alive = true;
    void capture.details(missing.map((f) => f.path)).then((ds) => {
      missing.forEach((f) => {
        const d = ds.find((x) => x.path === f.path);
        if (d) detailCache.set(cacheKey(f), d);
      });
      if (alive) setLoaded((n) => n + 1);
    });
    return () => void (alive = false);
    // `shown` is derived; the key says when the cards needing details change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Segmented
          id="capture-filter"
          size="sm"
          value={filter}
          options={[{ value: "all", label: t("Alle") }, { value: "shot", label: t("Bildschirmfotos") }, { value: "video", label: t("Videos") }]}
          onChange={setFilter}
        />
      </div>
      {shown.length === 0 ? (
        <div className="min-h-0 flex-1 rounded-[14px] bg-fill-1">
          <Empty icon={filter === "video" ? FilmStrip : ImageSquare} title={t("Noch nichts aufgenommen")} text={t("Bildschirmfotos und Videos erscheinen hier")} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto [scrollbar-width:none]">
          <AnimatePresence initial={false} mode="popLayout">
            {shown.map((f) => (
              <motion.div
                key={f.path}
                layout
                transition={springs.snappy}
                initial={{ opacity: 0, transform: "scale(0.94)" }}
                animate={{ opacity: 1, transform: "scale(1)" }}
                exit={{ opacity: 0, transform: "scale(0.94)", transition: fade }}
                className="group relative h-full w-[132px] shrink-0"
              >
                <Card file={f} details={detailCache.get(cacheKey(f))} onDeleted={() => libraryEpoch.set((n) => n + 1)} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

export function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  const day = today ? t("Heute") : new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short" }).format(d);
  return `${day} ${formatTime(d)}`;
}

function Card({ file, details, onDeleted }: { file: CaptureFile; details?: CaptureDetails; onDeleted: () => void }) {
  const video = file.kind === "video";
  const I = video ? FilmStrip : ImageSquare;
  // A thumbnail can show anything that was on screen: only the icon while presenting.
  const thumb = usePresenting() ? null : details?.thumb;
  const [armed, onDelete] = useDelete(file.path, onDeleted);

  return (
    <div className="relative flex size-full flex-col overflow-hidden rounded-[14px] bg-fill-1">
      <button onClick={() => void openFile(file.path)} title={t("{name} öffnen", { name: file.name })} className="pressable relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {thumb ? <img src={thumb} alt="" draggable={false} className="absolute inset-0 size-full object-cover" /> : <I size={28} weight="duotone" className="text-label-2" />}
        {video && (
          <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            <span className="flex size-8 items-center justify-center rounded-full bg-black/55 text-label backdrop-blur-md">
              <Play size={14} weight="fill" />
            </span>
          </span>
        )}
        {video && details?.durationMs != null && (
          <span className="tabular absolute end-1.5 bottom-1.5 rounded-[6px] bg-black/60 px-1.5 text-caption text-label">{formatElapsed(details.durationMs)}</span>
        )}
      </button>
      <div className="px-2 pt-1.5 pb-1">
        <p className="truncate text-caption font-medium text-label" title={file.name}>{when(file.modified)}</p>
        <div className="flex items-center justify-between">
          <span className="tabular text-caption text-label-3">{formatBytes(file.size, 0)}</span>
          <span className={`flex transition-opacity duration-150 group-hover:opacity-100 ${armed ? "opacity-100" : "opacity-0"}`}>
            <IconBtn label={t("Im Explorer zeigen")} icon={FolderOpen} onClick={() => revealFile(file.path)} />
            <IconBtn label={armed ? t("Zum Löschen erneut klicken") : t("Löschen")} icon={Trash} danger={armed} onClick={onDelete} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Delete takes a second click within a few seconds: [armed, click]. */
export function useDelete(path: string, onDeleted: () => void): [boolean, () => void] {
  const [armed, setArmed] = useState(false);
  const disarm = useRef(0);
  useEffect(() => () => window.clearTimeout(disarm.current), []);
  const onDelete = () => {
    if (!armed) {
      setArmed(true);
      disarm.current = window.setTimeout(() => setArmed(false), 3000);
      return;
    }
    window.clearTimeout(disarm.current);
    void capture.remove(path).then(onDeleted, () => setArmed(false));
  };
  return [armed, onDelete];
}

export function IconBtn({ label, icon: I, onClick, danger }: { label: string; icon: Icon; onClick: () => void; danger?: boolean }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={`pressable flex size-5 items-center justify-center ${danger ? "text-red" : "text-label-3 hover:text-label"}`}>
      <I size={12} weight={danger ? "fill" : "bold"} />
    </button>
  );
}
