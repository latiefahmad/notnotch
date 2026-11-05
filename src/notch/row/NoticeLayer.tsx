import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlarmIcon, ArrowFatLineUp, BatteryHigh, BatteryLow, BatteryWarning, Bluetooth, CheckCircle, DeviceMobile, FilmStrip, GameController, Headphones, Keyboard, Mouse, NumberSquareOne, Pause, Play, Plug, SpeakerHifi, SpeakerHigh, SpeakerLow, SpeakerNone, SpeakerX, Stop, Sun, SunDim, Watch, Waveform, WifiHigh, WifiSlash, type Icon } from "@phosphor-icons/react";
import { pauseRecording, recording, saved, stopRecording, type Saved } from "../../features/capture/store";
import { elapsedAt, formatElapsed } from "../../features/capture/clock";
import { openFile } from "../../platform/services";
import { content, pulse } from "../../design/motion";
import { useNowPlaying } from "../../platform/media";
import type { UsageId } from "../../platform/services";
import { settings } from "../../settings/store";
import { ringing, timer, timerActions, useSecondTick } from "../../features/timer/store";
import { usage } from "../../features/usage/store";
import { statusAlert } from "../../features/status/store";
import { windowLabel } from "../../features/usage/UsageView";
import { dueTasks } from "../../features/todos/store";
import { reminderNotice } from "../../features/todos/ReminderNotice";
import { waterDue } from "../../features/water/store";
import { waterNotice } from "../../features/water/WaterNotice";
import { calendarDue } from "../../features/calendar/store";
import { calendarNotice } from "../../features/calendar/CalendarNotice";
import { useWhatsNew } from "../../features/whatsnew/store";
import { whatsNewNotice } from "../../features/whatsnew/WhatsNewNotice";
import { brandName } from "../../ui/brands";
import { formatIn } from "../../lib/format";
import { t } from "../../i18n";
import { QUOTA, SAVED, TRACK, armTrack, detectRise, newQuotaTracker, observeTrack, topNotice, type QuotaRise, type TrackGate } from "./notices";
import type { StatusAlert } from "./status";
import { trackCaption } from "./parts";
import { fontEpoch, measureText } from "./measure";
import { Marquee } from "./Marquee";
import { NOTICE_BUTTON as REC_BUTTON, NoticeButton, useNoticeHover } from "./NoticeButton";
import { Ring } from "./parts/Rings";
import { asks, popping } from "../../features/notices/store";
import { askNotice } from "../../features/notices/AskNotice";
import { noticePop } from "../../features/notices/NoticePop";
import { usePresenting } from "../../features/privacy/store";
import { finishedDownload } from "../../features/downloads/store";
import { downloadNotice } from "../../features/downloads/DownloadNotice";

const ICON = 17, GAP = 6, QUOTA_RING = 14, NAME_MAX = 76, REC_DOT = 8, THUMB_W = 28, LEVEL_BAR = 56;
const STATUS_ICON: Record<StatusAlert["icon"], Icon> = {
  plug: Plug, battery: BatteryHigh, wifi: WifiHigh, "wifi-off": WifiSlash, headphones: Headphones,
  "speaker-hifi": SpeakerHifi, mouse: Mouse, keyboard: Keyboard, gamepad: GameController, phone: DeviceMobile, watch: Watch, bluetooth: Bluetooth,
  "speaker-high": SpeakerHigh, "speaker-low": SpeakerLow, "speaker-none": SpeakerNone, "speaker-x": SpeakerX, sun: Sun, "sun-dim": SunDim, "caps-lock": ArrowFatLineUp, "num-lock": NumberSquareOne,
};
const TONE = { normal: "var(--color-label)", warning: "var(--color-orange)", critical: "var(--color-red)" } as const;

/** The capture saved in the last SAVED.showMs (also one taken while the notch was open, for what is left of its time). */
function useSaved(): Saved | null {
  const last = saved.use();
  const [shown, setShown] = useState<Saved | null>(null);
  useEffect(() => {
    const left = last ? SAVED.showMs - (Date.now() - last.at) : 0;
    if (!last || left <= 0) return setShown(null);
    setShown(last);
    const id = window.setTimeout(() => setShown(null), left);
    return () => window.clearTimeout(id);
  }, [last]);
  return shown;
}

/** The last quota level rise, for QUOTA.showMs. The tracker seeds on the first answer seen, so mounting at 95% does not alert. */
function useQuotaRise(): QuotaRise | null {
  const { providers, updatedAt } = usage.use();
  const tracker = useRef(newQuotaTracker());
  const [rise, setRise] = useState<QuotaRise | null>(null);
  useEffect(() => {
    if (updatedAt === null) return;
    const r = detectRise(tracker.current, providers);
    if (r) setRise(r);
  }, [providers, updatedAt]);
  // A new rise is a new object, so it starts its own 5 s.
  useEffect(() => {
    if (!rise) return;
    const id = window.setTimeout(() => setRise(null), QUOTA.showMs);
    return () => window.clearTimeout(id);
  }, [rise]);
  return rise;
}

/** "title · artist" for TRACK.showMs when a changed track starts playing within TRACK.armMs, only while `on` (the title part is off). */
function useTrackCaption(on: boolean): string | null {
  const np = useNowPlaying();
  const key = np ? `${np.title}\n${np.artist}` : "";
  const playing = !!np?.isPlaying;
  const gate = useRef<TrackGate>({ until: null }), lastKey = useRef(key);
  const [shown, setShown] = useState<{ text: string } | null>(null);
  useEffect(() => {
    const now = performance.now();
    if (key !== lastKey.current) {
      lastKey.current = key;
      armTrack(gate.current, now, on && !!np);
    }
    if (np && observeTrack(gate.current, playing, now)) setShown({ text: trackCaption(np.title ?? "", np.artist ?? "") });
    // np is read only when the key or playing changed; its position updates must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, playing, on]);
  useEffect(() => {
    if (!shown) return;
    const id = window.setTimeout(() => setShown(null), TRACK.showMs);
    return () => window.clearTimeout(id);
  }, [shown]);
  return on && shown ? shown.text : null;
}

/**
 * Covers the closed row with the most important notice: a running recording (time, pause and stop, until it ends),
 * a finished timer (until dismissed by a click), a screenshot or recording just saved, a status alert
 * (charger, network, headphones, the volume and brightness HUD), a live notice from Windows or notnotch-notify (features/notices), a quota that crossed a level,
 * a new track while the title part is off, an event about to start, a due to-do, the water reminder or a new version.
 * Reports its content width while one shows, null otherwise; the shape takes that width. Mounted with the row, and on the idle line
 * or in focus mode while a finished timer, a recording, a status alert or a due to-do opens it into the notch (`urgentOnly`).
 * Drawn `scale` times its designed size like the row; `max` is the widest it gets at that size.
 */
export function NoticeLayer({ max, scale, onWidth, urgentOnly }: { max: number; scale: number; onWidth: (content: number | null) => void; urgentOnly: boolean }) {
  fontEpoch.use();
  const timerHover = useNoticeHover();
  const savedHover = useNoticeHover();
  const { closed, productivity } = settings.use();
  const finished = timer.use().finished;
  const ring = ringing.use();
  const rise = useQuotaRise();
  const track = useTrackCaption(!closed.parts.title);
  const status = statusAlert.use();
  const pop = popping.use();
  const ask = asks.use()[0];
  const due = dueTasks.use();
  const drink = waterDue.use();
  const meeting = calendarDue.use();
  const news = useWhatsNew();
  const rec = recording.use();
  const recRunning = rec.phase === "recording";
  useSecondTick(recRunning, rec.at);
  const shot = useSaved();
  const download = finishedDownload.use();
  // The thumbnail can show anything that was on screen: not while presenting.
  const presenting = usePresenting();
  // On the idle line and in focus mode only what cannot wait: a recording, the finished timer, a status alert (its store already skips focus mode) and a due reminder.
  const kind = topNotice({
    recording: rec.phase !== "idle",
    timer: finished,
    // A question shows on the idle line too: a coding agent waits on it.
    ask: !!ask,
    saved: !urgentOnly && !!shot && !presenting,
    download: !urgentOnly && !!download,
    status: !!status,
    notice: !urgentOnly && !!pop,
    quota: !urgentOnly && !!rise && closed.quotaAlerts,
    track: !urgentOnly && !!track,
    calendar: !urgentOnly && !!meeting,
    reminder: due.length > 0,
    water: !urgentOnly && drink,
    whatsnew: !urgentOnly && !!news,
  });

  let width = 0, key = "", body: ReactNode = null;
  if (kind === "recording") {
    const label = formatElapsed(elapsedAt(rec, Date.now()));
    // Measured with zeros so the width only changes when a digit is added, not every second.
    width = REC_DOT + GAP + measureText(label.replace(/\d/g, "0")) + GAP + 2 * REC_BUTTON + 4;
    key = "recording";
    // A click or hover on the notice opens the tool that records (data-open, as the row's parts), its buttons excepted.
    body = (
      <span className="pointer-events-auto flex h-full items-center" style={{ gap: GAP }} data-open={rec.audio ? "recorder" : "capture"}>
        <motion.span
          className="shrink-0 rounded-full bg-red"
          style={{ width: REC_DOT, height: REC_DOT }}
          animate={{ opacity: recRunning ? [1, 0.35] : 0.45 }}
          transition={recRunning ? pulse : content.exit}
        />
        <span className="tabular grow whitespace-nowrap text-footnote font-medium text-label">{label}</span>
        <span className="flex" style={{ gap: 4 }}>
          <NoticeButton label={recRunning ? t("Pause") : t("Fortsetzen")} onClick={() => pauseRecording(recRunning)}>
            {recRunning ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
          </NoticeButton>
          <NoticeButton label={t("Aufnahme beenden")} onClick={stopRecording}>
            <Stop size={13} weight="fill" />
          </NoticeButton>
        </span>
      </span>
    );
  } else if (kind === "saved" && shot) {
    const label = shot.kind === "shot" ? t("Bildschirmfoto gespeichert") : shot.kind === "audio" ? t("Tonaufnahme gespeichert") : t("Aufnahme gespeichert");
    width = (shot.thumb ? THUMB_W : ICON) + GAP + measureText(label);
    key = `saved:${shot.at}`;
    body = (
      <button
        aria-label={t("Öffnen")}
        className="pointer-events-auto flex h-full items-center text-label"
        style={{ gap: GAP }}
        // Opens the file; neither the click nor hovering it may open the notch.
        onPointerEnter={savedHover.onPointerEnter}
        onPointerLeave={savedHover.onPointerLeave}
        onClick={(e) => {
          e.stopPropagation();
          savedHover.used();
          void openFile(shot.path);
        }}
      >
        {shot.thumb ? (
          <img src={shot.thumb} alt="" draggable={false} className="h-[18px] rounded-[4px] object-cover" style={{ width: THUMB_W }} />
        ) : shot.kind === "audio" ? (
          <Waveform size={ICON} weight="fill" />
        ) : (
          <FilmStrip size={ICON} weight="fill" />
        )}
        <span className="whitespace-nowrap text-footnote font-medium">{label}</span>
      </button>
    );
  } else if (kind === "download" && download) {
    ({ width, key, body } = downloadNotice(download));
  } else if (kind === "timer") {
    const label = t("Abgelaufen");
    width = ICON + GAP + measureText(label);
    key = "timer";
    body = (
      <button
        aria-label={t("Schließen")}
        className="pointer-events-auto flex h-full items-center"
        style={{ gap: GAP, color: "var(--color-green)" }}
        // Only dismisses: neither the click nor hovering it may open the notch.
        onPointerEnter={timerHover.onPointerEnter}
        onPointerLeave={timerHover.onPointerLeave}
        onClick={(e) => {
          e.stopPropagation();
          timerHover.used();
          timerActions.dismiss();
        }}
      >
        {ring ? (
          <motion.span className="flex" animate={{ opacity: [1, 0.35] }} transition={pulse}>
            <AlarmIcon size={ICON} weight="fill" />
          </motion.span>
        ) : (
          <CheckCircle size={ICON} weight="fill" />
        )}
        <span className="whitespace-nowrap text-footnote font-medium">{label}</span>
      </button>
    );
  } else if (kind === "status" && status) {
    const I = status.icon === "battery" && status.tone !== "normal" ? (status.tone === "critical" ? BatteryWarning : BatteryLow) : STATUS_ICON[status.icon];
    // The volume and brightness HUD adds a level bar; its text keeps the width of "100 %", so the notch holds still while the level moves.
    const bar = status.level === undefined ? 0 : LEVEL_BAR + GAP;
    const textW = Math.min(Math.max(measureText(status.text), bar && measureText(t("{p} %", { p: 100 }))), max - ICON - GAP - bar);
    width = ICON + GAP + bar + textW;
    // One key per kind: a newer alert of the same kind swaps its text in place instead of cross-fading.
    key = `status:${status.kind}`;
    body = (
      <span className="flex h-full items-center" style={{ gap: GAP, color: TONE[status.tone] }}>
        <I size={ICON} weight="fill" className="shrink-0" />
        {status.level !== undefined && (
          <span className="h-1 shrink-0 overflow-hidden rounded-full bg-fill-3" style={{ width: LEVEL_BAR }}>
            <span
              className="block h-full rounded-full transition-[width] duration-150 ease-out"
              // Muted keeps the level, greyed, as Windows shows it.
              style={{ width: `${status.level}%`, background: status.icon === "speaker-x" ? "var(--color-label-3)" : "currentColor" }}
            />
          </span>
        )}
        <span className={`truncate text-footnote font-medium ${bar ? "tabular" : ""}`} style={{ width: textW }}>{status.text}</span>
      </span>
    );
  } else if (kind === "ask" && ask) {
    ({ width, key, body } = askNotice(ask, max));
  } else if (kind === "notice" && pop) {
    ({ width, key, body } = noticePop(pop, max));
  } else if (kind === "quota" && rise) {
    const used = Math.round(Math.min(100, Math.max(0, rise.used)));
    const name = brandName[rise.provider as UsageId] ?? rise.provider;
    const text = [t("{w} {p}% genutzt", { w: windowLabel(rise.kind), p: used }), rise.resetsAt !== null ? formatIn(rise.resetsAt - Date.now()) : ""].filter(Boolean).join(" · ");
    const nameW = Math.min(NAME_MAX, measureText(name)), textW = measureText(text), room = max - QUOTA_RING - nameW - 2 * GAP;
    width = QUOTA_RING + nameW + 2 * GAP + Math.min(textW, room);
    key = `quota:${rise.provider}:${rise.kind}:${used}`;
    body = (
      <span className="pointer-events-auto flex h-full items-center" style={{ gap: GAP }} data-open="usage">
        <Ring id={rise.provider as UsageId} value={used} size={QUOTA_RING} />
        <span className="truncate text-footnote font-medium text-label" style={{ width: nameW }}>{name}</span>
        <Marquee text={text} textWidth={textW} width={Math.min(textW, room)} paused={false} once />
      </span>
    );
  } else if (kind === "track" && track) {
    const textW = measureText(track);
    width = Math.min(textW, max);
    key = `track:${track}`;
    body = (
      <span className="pointer-events-auto flex h-full items-center" data-open="media">
        <Marquee text={track} textWidth={textW} width={width} paused={false} once />
      </span>
    );
  } else if (kind === "calendar" && meeting) ({ width, key, body } = calendarNotice(meeting));
  else if (kind === "reminder") ({ width, key, body } = reminderNotice(due));
  else if (kind === "water") ({ width, key, body } = waterNotice(productivity.water.goalMl));
  else if (kind === "whatsnew" && news) ({ width, key, body } = whatsNewNotice(news));
  const dpi = (window.devicePixelRatio || 1) * scale;
  // An even number of device pixels, as the row, so the centred notice starts on a whole one.
  width = Math.min(max, (Math.ceil((width * dpi) / 2 - 1e-9) * 2) / dpi);
  useLayoutEffect(() => onWidth(kind ? width : null), [kind, width, onWidth]);
  useEffect(() => () => onWidth(null), [onWidth]);

  return (
    <motion.div className="pointer-events-none absolute inset-0" exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}>
      <AnimatePresence>
        {kind && (
          <motion.div
            key={key}
            className="absolute top-0 left-1/2 flex h-[30px] items-center justify-center"
            style={{ width, marginLeft: -width / 2 }}
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          >
            {body}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
