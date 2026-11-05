// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck/MainWindow.CompactColumn.cs.
import { useLayoutEffect, type ReactNode } from "react";
import { motion } from "motion/react";
import { AlarmIcon, ArrowFatLineUp, BatteryHigh, BatteryLow, BatteryWarning, Bluetooth, CheckCircle, Coffee, DeviceMobile, GameController, Headphones, Keyboard, Mouse, NumberSquareOne, Pause, Play, Plug, SpeakerHifi, SpeakerHigh, SpeakerLow, SpeakerNone, SpeakerX, Stop, Sun, SunDim, Watch, WifiHigh, WifiSlash, type Icon } from "@phosphor-icons/react";
import { content, pulse } from "../../design/motion";
import { t } from "../../i18n";
import { ringing, timerActions, useSecondTick } from "../../features/timer/store";
import { pauseRecording, recording, stopRecording } from "../../features/capture/store";
import { elapsedAt, formatElapsed } from "../../features/capture/clock";
import { statusAlert } from "../../features/status/store";
import { topNotice } from "./notices";
import { partTool } from "./parts";
import { asks, popping } from "../../features/notices/store";
import { askColumn } from "../../features/notices/AskNotice";
import { AppIcon } from "../../features/notices/NoticePop";
import { dueTasks } from "../../features/todos/store";
import { colorVar } from "../../features/todos/colors";
import { openOn } from "../nav";
import type { StatusAlert } from "./status";
import { useNowPlaying } from "../../platform/media";
import { settings } from "../../settings/store";
import { LiveArtwork } from "../../features/now-playing/LiveActivity";
import { Equalizer, RELEASE_CAPTURE_MS } from "../../features/now-playing/Equalizer";
import { timer } from "../../features/timer/store";
import { useDiscordCall } from "../../features/discord/store";
import { useGamingLive } from "../../features/system/gaming";
import { usage } from "../../features/usage/store";
import { Dots, dotsWidth, usePrivacyDots } from "../../features/privacy/PrivacyDots";
import { awake } from "../../features/overview/store";
import { COLUMN, columnWidth, fitLines, ringLines, stack } from "../column";
import { useHeld } from "./CompactRow";
import { NOTICE_BUTTON, NoticeButton, useNoticeHover } from "./NoticeButton";
import { useRowVisible } from "./visibility";
import { CAPTION_FONT, fontEpoch, measureText } from "./measure";
import { RING, Ring, ringProviders, ringValue } from "./parts/Rings";
import { ReadingView, readingWidth, useReadings } from "./parts/Readings";
import { Clock, clockWidth } from "./parts/Clock";
import { TimerPart, timerWidth } from "./parts/TimerPart";
import { DISCORD_WIDTH, DiscordPart } from "./parts/DiscordPart";
import { GithubPart, githubWidth, useGithubToday } from "./parts/GithubPart";

interface Line { id: string; w: number; h: number; draw: () => ReactNode }

const NOTICE_ICON = 17;
/** The recording line: dot 8, time 14, two buttons, 4 between. */
const REC_STACK = 8 + 14 + 2 * NOTICE_BUTTON + 3 * 4;
const STATUS_ICON: Record<StatusAlert["icon"], Icon> = {
  plug: Plug, battery: BatteryHigh, wifi: WifiHigh, "wifi-off": WifiSlash, headphones: Headphones,
  "speaker-hifi": SpeakerHifi, mouse: Mouse, keyboard: Keyboard, gamepad: GameController, phone: DeviceMobile, watch: Watch, bluetooth: Bluetooth,
  "speaker-high": SpeakerHigh, "speaker-low": SpeakerLow, "speaker-none": SpeakerNone, "speaker-x": SpeakerX, sun: Sun, "sun-dim": SunDim, "caps-lock": ArrowFatLineUp, "num-lock": NumberSquareOne,
};
/** The HUD's level bar under the icon: 3 high, 4 below the icon. */
const LEVEL_H = 3, LEVEL_GAP = 4;
const TONE: Record<StatusAlert["tone"], string> = { normal: "var(--color-label)", warning: "var(--color-orange)", critical: "var(--color-red)" };

/**
 * The notice as an icon on its own line (the notice text is too wide for a column), by the same priority as NoticeLayer: a finished
 * timer's alarm, which dismisses it (after a running recording: its dot, time, pause and stop); the status alert's icon; a live notice's app logo; a due to-do's alarm, which opens the To-dos.
 * `urgentOnly` (the idle line, dimmed focus mode) leaves out the live notice, as on top. Saved, download, quota, track, calendar and water notices stay off the column.
 */
function useNoticeLine(urgentOnly: boolean): Line | null {
  const finished = timer.use().finished;
  const ring = ringing.use();
  const timerHover = useNoticeHover();
  const status = statusAlert.use();
  const pop = popping.use();
  const ask = asks.use()[0];
  const due = dueTasks.use();
  const rec = recording.use();
  const recRunning = rec.phase === "recording";
  useSecondTick(recRunning, rec.at);
  const kind = topNotice({ recording: rec.phase !== "idle", timer: finished, ask: !!ask, saved: false, download: false, status: !!status, notice: !urgentOnly && !!pop, quota: false, track: false, calendar: false, reminder: due.length > 0, water: false, whatsnew: false });
  const line = (id: string, draw: () => ReactNode): Line => ({ id, w: NOTICE_ICON, h: 20, draw });
  if (kind === "recording") {
    // Stacked: dot, time, pause or resume, stop. The width is the time's, measured with zeros so it only changes with a new digit.
    const label = formatElapsed(elapsedAt(rec, Date.now()));
    const w = Math.max(NOTICE_BUTTON, Math.ceil(measureText(label.replace(/\d/g, "0"), CAPTION_FONT)));
    return {
      id: "notice-recording",
      w,
      h: REC_STACK,
      draw: () => (
        <span className="flex flex-col items-center" style={{ gap: 4 }}>
          <motion.span className="size-2 rounded-full bg-red" animate={{ opacity: recRunning ? [1, 0.35] : 0.45 }} transition={recRunning ? pulse : content.exit} />
          <span className="tabular text-caption font-medium whitespace-nowrap text-label">{label}</span>
          <NoticeButton label={recRunning ? t("Pause") : t("Fortsetzen")} onClick={() => pauseRecording(recRunning)}>
            {recRunning ? <Pause size={12} weight="fill" /> : <Play size={12} weight="fill" />}
          </NoticeButton>
          <NoticeButton label={t("Aufnahme beenden")} onClick={stopRecording}>
            <Stop size={12} weight="fill" />
          </NoticeButton>
        </span>
      ),
    };
  }
  if (kind === "ask" && ask) return { id: `notice-ask-${ask.id}`, ...askColumn(ask) };
  if (kind === "timer")
    return line("notice-timer", () => (
      <button
        aria-label={t("Schließen")}
        className="pointer-events-auto flex"
        style={{ color: "var(--color-green)" }}
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
            <AlarmIcon size={NOTICE_ICON} weight="fill" />
          </motion.span>
        ) : (
          <CheckCircle size={NOTICE_ICON} weight="fill" />
        )}
      </button>
    ));
  if (kind === "status" && status) {
    const I = status.icon === "battery" && status.tone !== "normal" ? (status.tone === "critical" ? BatteryWarning : BatteryLow) : STATUS_ICON[status.icon];
    if (status.level !== undefined) {
      const level = status.level;
      // One id per kind, so a held key moves the bar in place.
      return {
        id: `notice-${status.kind}`,
        w: NOTICE_ICON,
        h: NOTICE_ICON + LEVEL_GAP + LEVEL_H,
        draw: () => (
          <span className="flex flex-col items-center" style={{ gap: LEVEL_GAP, color: TONE[status.tone] }}>
            <I size={NOTICE_ICON} weight="fill" />
            <span className="overflow-hidden rounded-full bg-fill-3" style={{ width: NOTICE_ICON, height: LEVEL_H }}>
              <span className="block h-full rounded-full" style={{ width: `${level}%`, background: status.icon === "speaker-x" ? "var(--color-label-3)" : "currentColor" }} />
            </span>
          </span>
        ),
      };
    }
    return line(`notice-${status.kind}-${status.icon}`, () => <I size={NOTICE_ICON} weight="fill" style={{ color: TONE[status.tone] }} />);
  }
  if (kind === "notice" && pop) return line(`notice-pop-${pop.id}`, () => <AppIcon n={pop} size={NOTICE_ICON} />);
  if (kind === "reminder") {
    const task = due[0];
    return line(`notice-reminder-${task.id}`, () => (
      // Not stopped: the click also opens the notch, which then lands on the To-dos.
      <button aria-label={t("Zeit ist um")} className="pointer-events-auto flex" onClick={() => openOn("todos")}>
        <motion.span className="flex" style={{ color: colorVar(task.color) ?? "var(--color-orange)" }} animate={{ opacity: [1, 0.45] }} transition={{ ...pulse, repeat: 5 }}>
          <AlarmIcon size={NOTICE_ICON} weight="fill" />
        </motion.span>
      </button>
    ));
  }
  return null;
}

/**
 * The closed notch's content on a side edge: the row's parts one below the other, each centred on its own line, in the row's order with
 * the cover first and the privacy dots last, under the notice line if there is one. The song title is left out: a scrolling title does
 * not fit across a column, and neither does a lyric line, the next event or the downloads, so the title's lyric mode and the lyrics-only notch keep the column as it is.
 * Lines that do not fit in the longest notch are dropped from the end. `parts` false (the idle line or dimmed focus mode, opened only by
 * an urgent notice) shows the notice line alone and keeps the row's polling off. Reports its length and width; the shape is that plus
 * its insets and pads. Drawn at the content scale like the row (Notch.tsx): `room` is the longest it gets at its designed size.
 */
export function CompactColumn({ parts, room, onSize }: { parts: boolean; room: number; onSize: (size: { length: number; width: number }) => void }) {
  useRowVisible(parts);
  fontEpoch.use();
  const notice = useNoticeLine(!parts);
  const gh = useGithubToday();
  const s = settings.use(), closed = s.closed;
  const np = useNowPlaying();
  const playing = useHeld(!!np?.isPlaying, RELEASE_CAPTURE_MS);
  const running = timer.use().endsAt !== null;
  const call = useDiscordCall();
  const rings = ringProviders(usage.use().providers);
  const readings = useReadings(closed, useGamingLive());
  const dots = usePrivacyDots();
  const awakeOn = !!awake.use();
  const h12 = s.units.clock === "12";

  const fixed: Line[] = [];
  const readingLines: Line[] = [];
  let ringsAt = -1;
  if (np) fixed.push({ id: "cover", w: 20, h: 20, draw: () => <LiveArtwork artwork={np.artwork} /> });
  for (const id of closed.order) {
    if (!closed.parts[id] && id !== "readings") continue;
    if (id === "timer" && running) fixed.push({ id, w: timerWidth(timer.get().duration), h: 20, draw: () => <TimerPart paused={false} /> });
    else if (id === "discord" && call) fixed.push({ id, w: DISCORD_WIDTH, h: 20, draw: () => <DiscordPart call={call} paused={false} /> });
    else if (id === "equalizer" && np && playing) fixed.push({ id, w: 16, h: 16, draw: () => <Equalizer playing={np.isPlaying} /> });
    else if (id === "github" && gh) fixed.push({ id, w: githubWidth(gh.count), h: 16, draw: () => <GithubPart count={gh.count} level={gh.level} /> });
    else if (id === "clock") fixed.push({ id, w: clockWidth(closed.clockSeconds, h12), h: 16, draw: () => <Clock seconds={closed.clockSeconds} h12={h12} paused={false} /> });
    else if (id === "rings" && rings.length) ringsAt = fixed.length;
    else if (id === "readings" && readings.length) {
      // Readings stand where the part is in the order; marked by a placeholder replaced below.
      fixed.push({ id: "readings", w: 0, h: 0, draw: () => null });
      for (const r of readings) readingLines.push({ id: `reading-${r.id}`, w: readingWidth(r.id), h: 16, draw: () => <ReadingView reading={r} /> });
    }
  }
  if (awakeOn) fixed.push({ id: "awake", w: 13, h: 13, draw: () => <Coffee size={13} weight="fill" className="text-label-2" aria-label={t("PC bleibt wach")} /> });
  if (dots.length) fixed.push({ id: "privacy", w: dotsWidth(dots.length), h: 8, draw: () => <Dots dots={dots} /> });

  const width = columnWidth([notice?.w ?? 0, ...(parts ? [...fixed.map((l) => l.w), rings.length ? RING : 0] : [])], parts ? readingLines.map((l) => l.w) : []);
  const { perLine, lines: ringRows } = ringLines(rings.length, RING, COLUMN.ringGap, width);
  const ringLinesList: Line[] = Array.from({ length: ringRows }, (_, row) => {
    const slice = rings.slice(row * perLine, (row + 1) * perLine);
    return {
      id: `rings-${row}`,
      w: slice.length * RING + (slice.length - 1) * COLUMN.ringGap,
      h: RING,
      draw: () => (
        <span className="flex items-center" style={{ gap: COLUMN.ringGap }}>
          {slice.map((r) => <Ring key={r.id} id={r.id} value={ringValue(r)} />)}
        </span>
      ),
    };
  });
  const all: Line[] = notice ? [notice] : [];
  if (parts) fixed.forEach((l, i) => {
    if (i === ringsAt) all.push(...ringLinesList);
    if (l.id === "readings") all.push(...readingLines);
    else all.push(l);
  });
  if (parts && ringsAt === fixed.length) all.push(...ringLinesList);

  const shown = all.slice(0, fitLines(all.map((l) => l.h), COLUMN.gap, room));
  const { tops, length } = stack(shown.map((l) => l.h), COLUMN.gap);
  useLayoutEffect(() => onSize({ length, width }), [length, width, onSize]);

  return (
    <motion.div
      className="absolute top-1/2 left-1/2"
      style={{ width, height: length, marginLeft: -width / 2, marginTop: -length / 2 }}
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      {shown.map((l, i) => (
        <div key={l.id} data-open={partTool(l.id.startsWith("reading-") ? "readings" : l.id.split("-")[0]) ?? undefined} className="absolute inset-x-0 flex items-center justify-center" style={{ top: tops[i], height: l.h }}>
          {l.draw()}
        </div>
      ))}
    </motion.div>
  );
}
