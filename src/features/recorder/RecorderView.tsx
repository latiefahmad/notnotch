import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FolderOpen, Microphone, MicrophoneSlash, Play, Record, SpeakerHigh, SpeakerSlash, Trash, Waveform } from "@phosphor-icons/react";
import { fade, springs } from "../../design/motion";
import { formatBytes } from "../../lib/format";
import { capture, openFile, revealFile, type CaptureFile } from "../../platform/services";
import { settings, updateSettings, type Settings } from "../../settings/store";
import { Button, Empty } from "../../ui/controls";
import { t } from "../../i18n";
import { formatElapsed } from "../capture/clock";
import { IconBtn, Running, Toggle, cacheKey, detailCache, errorText, failureText, useDelete, when } from "../capture/CaptureView";
import { libraryEpoch, recording, startRecording } from "../capture/store";

/*
 * Recorder: sound only, from the microphone, the system audio (what a call or video plays) or both mixed,
 * into an M4A in Music\NotNotch\Recordings. It runs through the Capture tool's recording (one at a time),
 * and NotNotch tells no one: whether others must know is up to the person recording, hence the one-time note.
 */

const setRecorder = (patch: Partial<Settings["recorder"]>) => updateSettings((s) => ({ recorder: { ...s.recorder, ...patch } }));

export function RecorderView() {
  const cfg = settings.use().recorder;
  const rec = recording.use();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const idle = rec.phase === "idle";

  const record = () => {
    setError(null);
    setStarting(true);
    startRecording("audio", 30, cfg.mic, cfg.system, false)
      .catch((e) => setError(errorText(String(e), t("Aufnahme konnte nicht starten"))))
      .finally(() => setStarting(false));
  };
  const warning = error ?? (rec.audio ? failureText(rec.failed) : null);

  return (
    <div className="flex h-full flex-col gap-2 px-4 pt-1 pb-2">
      <div className="flex h-7 items-center gap-2">
        {rec.audio && !idle ? (
          <Running />
        ) : (
          <>
            <Toggle on={cfg.mic} icons={[Microphone, MicrophoneSlash]} labels={[t("Mit Mikrofon"), t("Ohne Mikrofon")]} onChange={(mic) => setRecorder({ mic })} />
            <Toggle on={cfg.system} icons={[SpeakerHigh, SpeakerSlash]} labels={[t("Mit Systemton"), t("Ohne Systemton")]} onChange={(system) => setRecorder({ system })} />
            <Button icon={Record} primary disabled={starting || !idle || (!cfg.mic && !cfg.system)} onClick={record}>
              {starting ? t("Startet …") : t("Aufzeichnen")}
            </Button>
            {!idle && <span className="truncate text-caption text-label-3">{t("Es läuft schon eine Aufnahme")}</span>}
          </>
        )}
      </div>

      <AnimatePresence>
        {warning && (
          <motion.p className="-mt-1 truncate text-caption text-orange" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
            {warning}
          </motion.p>
        )}
      </AnimatePresence>

      {!cfg.noted && (
        <div className="flex items-center gap-2 rounded-[12px] bg-fill-1 px-3 py-2">
          <p className="min-w-0 flex-1 text-caption text-label-2">{t("NotNotch benachrichtigt niemanden. In vielen Ländern darf ein Gespräch nur mit Zustimmung aller aufgenommen werden.")}</p>
          <Button onClick={() => setRecorder({ noted: true })}>{t("Verstanden")}</Button>
        </div>
      )}

      <Recordings />
    </div>
  );
}

/** Newest recordings shown; older ones stay in the folder. */
const LIST_MAX = 40;

function Recordings() {
  const epoch = libraryEpoch.use();
  const [files, setFiles] = useState<CaptureFile[]>([]);
  const [, setLoaded] = useState(0);

  useEffect(() => {
    let alive = true;
    void capture.list().then((list) => alive && setFiles(list.filter((f) => f.kind === "audio").slice(0, LIST_MAX)));
    return () => void (alive = false);
  }, [epoch]);

  // Durations for the rows not read yet.
  const missingKey = files.filter((f) => !detailCache.has(cacheKey(f))).map(cacheKey).join("\n");
  useEffect(() => {
    const missing = files.filter((f) => !detailCache.has(cacheKey(f)));
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
    // The key says when the rows needing details change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey]);

  if (files.length === 0) {
    return (
      <div className="min-h-0 flex-1 rounded-[14px] bg-fill-1">
        <Empty icon={Waveform} title={t("Noch nichts aufgenommen")} text={t("Tonaufnahmen erscheinen hier")} />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto [scrollbar-width:none]">
      <AnimatePresence initial={false} mode="popLayout">
        {files.map((f) => (
          <motion.div
            key={f.path}
            layout
            transition={springs.snappy}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: fade }}
            className="group shrink-0"
          >
            <Row file={f} durationMs={detailCache.get(cacheKey(f))?.durationMs ?? null} onDeleted={() => libraryEpoch.set((n) => n + 1)} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Row({ file, durationMs, onDeleted }: { file: CaptureFile; durationMs: number | null; onDeleted: () => void }) {
  const [armed, onDelete] = useDelete(file.path, onDeleted);
  return (
    <div className="flex h-9 items-center gap-2 rounded-[10px] bg-fill-1 ps-1 pe-2">
      <button
        onClick={() => void openFile(file.path)}
        title={t("{name} öffnen", { name: file.name })}
        className="pressable flex size-7 shrink-0 items-center justify-center rounded-full bg-fill-2 text-label"
      >
        <Play size={12} weight="fill" />
      </button>
      <span className="min-w-0 flex-1 truncate text-footnote font-medium text-label" title={file.name}>
        {when(file.modified)}
      </span>
      {durationMs != null && <span className="tabular text-caption text-label-2">{formatElapsed(durationMs)}</span>}
      <span className="tabular w-14 text-end text-caption text-label-3">{formatBytes(file.size, 0)}</span>
      <span className={`flex transition-opacity duration-150 group-hover:opacity-100 ${armed ? "opacity-100" : "opacity-0"}`}>
        <IconBtn label={t("Im Explorer zeigen")} icon={FolderOpen} onClick={() => revealFile(file.path)} />
        <IconBtn label={armed ? t("Zum Löschen erneut klicken") : t("Löschen")} icon={Trash} danger={armed} onClick={onDelete} />
      </span>
    </div>
  );
}
