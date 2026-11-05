import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown, Check, Coffee, Eye, EyeSlash, Headphones, Moon, MusicNoteSimple, SpeakerHifi, SpeakerHigh, SpeakerLow, SpeakerNone, SpeakerSimpleHigh, SpeakerSimpleSlash, Sun, SunDim, Timer } from "@phosphor-icons/react";
import { DiscordLogo } from "../../ui/brands";
import { content, springs } from "../../design/motion";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { requestSize } from "../../notch/size";
import { findTab } from "../../notch/tabs";
import { togglePresentation, usePresenting } from "../privacy/store";
import { useNowPlaying } from "../../platform/media";
import { systemControls, type AudioOutput, type FocusState, type VolumeState } from "../../platform/services";
import { MIXER_MAX_ROWS, MIXER_ROW } from "../now-playing/Mixer";
import { outputIcon } from "./outputs";
import { useDiscordCall } from "../discord/store";
import { Equalizer } from "../now-playing/Equalizer";
import { ARTWORK_LAYOUT_ID } from "../now-playing/NowPlayingView";
import { formatClock, timer, useRemaining } from "../timer/store";
import { Look, clockFace } from "../timer/Look";
import { lookTint } from "../timer/looks";
import { describe, useForecast } from "../weather/store";
import { useHue } from "../themes/hues";
import { WeatherIcon } from "../weather/WeatherView";
import { settings } from "../../settings/store";
import { formatTemp, formatTimeParts } from "../../lib/format";
import { locale, t } from "../../i18n";
import { QuoteLine } from "../quotes/QuoteLine";
import { Select } from "../../ui/controls";
import { AWAKE_MINUTES, awakeLeft, awakeOn, formatLeft } from "./awake";
import { awake, startAwake, stopAwake } from "./store";

/*
 *   14:32                                    ☀ 18°
 *   Sunday, 5 October                Vienna · Clear
 *   ┌──────────────────────────────────────────────┐
 *   │ ▣ Song – Artist                        ▮▮▮▮  │   ← what's playing (click opens the tool)
 *   └──────────────────────────────────────────────┘
 *   [☾ Focus  ]  [☕ Keep awake ⌄]  [🔊 ━━━━━━━  42 %]
 *
 * Like Control Center: an overview plus the two toggles you need all the time.
 */
export function OverviewView() {
  const presenting = usePresenting();
  const quotes = settings.use().productivity.quotes;

  // Playback devices: read when Overview shows and each time the list opens, so one plugged in meanwhile shows up.
  const [outputs, setOutputs] = useState<AudioOutput[]>([]);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const loadOutputs = () => void systemControls.outputs().then(setOutputs).catch(() => setOutputs([]));
  useEffect(loadOutputs, []);
  const choice = outputs.length > 1;
  const listOpen = outputsOpen && choice;
  const pickOutput = (id: string) => {
    setOutputsOpen(false);
    setOutputs((list) => list.map((o) => ({ ...o, default: o.id === id })));
    void systemControls.setOutput(id).catch(() => {}).finally(loadOutputs);
  };

  // The notch's monitor brightness: the row shows only where NotNotch can set it, read every few seconds (keys, other apps).
  const [bright, setBright] = useState<number | null>(null);
  const brightBusy = useRef(false);
  // Until when a reading would undo the slider: writes still going out, or just landed.
  const brightHold = useRef(0);
  const brightMisses = useRef(0);
  useEffect(() => {
    const quiet = () => brightBusy.current || Date.now() < brightHold.current;
    const load = () =>
      !quiet() &&
      void systemControls.brightness().then((v) => {
        if (quiet()) return;
        // DDC/CI misses a read now and then: the row goes only after three in a row.
        brightMisses.current = v === null ? brightMisses.current + 1 : 0;
        if (v !== null || brightMisses.current >= 3) setBright(v);
      });
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  // The open list grows the notch by its rows, like the player menu in Now Playing; the brightness row by its height and gap.
  const extra = (listOpen ? Math.min(MIXER_MAX_ROWS, outputs.length) * MIXER_ROW + 14 : 0) + (bright !== null ? BRIGHTNESS_ROW : 0);
  useEffect(() => {
    if (!extra) return requestSize("overview", null);
    const base = findTab("overview")!.size;
    requestSize("overview", { w: base.w, h: base.h + extra });
  }, [extra, quotes]);
  useEffect(() => () => requestSize("overview", null), []);

  return (
    <div className="flex h-full flex-col gap-2.5 px-4 pt-1 pb-3">
      <HeaderActions>
        <HeaderButton label={presenting ? t("Präsentationsmodus beenden") : t("Präsentationsmodus")} active={presenting} onClick={togglePresentation}>
          {presenting ? <EyeSlash size={14} weight="fill" /> : <Eye size={14} weight="bold" />}
        </HeaderButton>
      </HeaderActions>
      <Header />
      <Activity />
      <div className="flex gap-2">
        <FocusTile />
        <AwakeTile />
        <VolumeTile
          device={choice ? (outputs.find((o) => o.default)?.name ?? "") : null}
          open={listOpen}
          onDevices={() => {
            if (!outputsOpen) loadOutputs();
            setOutputsOpen(!outputsOpen);
          }}
        />
      </div>
      {listOpen && <OutputList outputs={outputs} onPick={pickOutput} />}
      {bright !== null && <BrightnessTile level={bright} busy={brightBusy} hold={brightHold} onLevel={setBright} />}
      {quotes && <QuoteLine />}
    </div>
  );
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Header() {
  const now = useNow();
  const forecast = useForecast();
  const place = settings.use().weather;
  const weather = forecast && forecast !== "error" ? describe(forecast.current.code, forecast.current.day) : null;
  const { clockLook, clockColor } = settings.use().timer;
  const { time, period } = formatTimeParts(now);
  const date = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long" }).format(now);

  return (
    <div className="flex items-end justify-between gap-4">
      <div className={clockLook === "standard" ? undefined : "flex min-w-0 flex-1 flex-col"}>
        {clockLook === "standard" ? (
          <div className="tabular text-[34px] leading-none font-semibold tracking-[-0.03em] text-label" style={{ color: lookTint(clockColor) }}>
            {time}
            {period && <span className="ms-1 text-title font-semibold tracking-normal text-label-3">{period}</span>}
          </div>
        ) : (
          <div className="flex max-w-[340px]">
            <Look look={clockLook} {...clockFace(now)} running mode="focus" tint={lookTint(clockColor)} h={38} />
          </div>
        )}
        <div className="mt-1 text-footnote text-label-3">{date}</div>
      </div>
      <button onClick={() => navigate("weather")} className="pressable flex flex-col items-end text-end" title={t("Wetter öffnen")}>
        <AnimatePresence mode="popLayout" initial={false}>
          {weather && forecast && forecast !== "error" ? (
            <motion.div
              key="w"
              className="flex items-center gap-1.5"
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            >
              <WeatherIcon icon={weather.icon} hue={weather.hue} size={22} className="text-label" />
              <span className="tabular text-[22px] leading-none font-semibold tracking-[-0.02em] text-label">{formatTemp(forecast.current.temp)}</span>
            </motion.div>
          ) : (
            <motion.div key="s" className="h-[22px] w-16 rounded-[6px] bg-fill-1" exit={{ opacity: 0, transition: content.exit }} />
          )}
        </AnimatePresence>
        <div className="mt-1 max-w-[220px] truncate text-footnote text-label-3">
          {place ? `${place.name}${weather ? ` · ${weather.text}` : ""}` : t("Ort wird erkannt …")}
        </div>
      </button>
    </div>
  );
}

/** What's running, in the same priority as the closed notch: timer, call, music. */
function Activity() {
  const np = useNowPlaying();
  const call = useDiscordCall();
  const tm = timer.use();
  const remaining = useRemaining();
  const timerLive = tm.endsAt !== null || tm.finished;

  let item: { key: string; tab: string; icon: ReactNode; title: string; detail: string; trailing?: ReactNode } | null = null;
  if (timerLive) {
    item = {
      key: "timer",
      tab: "timer",
      icon: <Timer size={18} weight="bold" className={tm.mode === "focus" ? "text-orange" : "text-green"} />,
      title: tm.finished ? t(tm.mode === "focus" ? "Fokus abgelaufen" : "Pause abgelaufen") : t(tm.mode === "focus" ? "Fokus" : "Pause"),
      detail: tm.finished ? t("Zum Schließen öffnen") : t("noch {time}", { time: formatClock(remaining) }),
    };
  } else if (call) {
    item = {
      key: "discord",
      tab: "discord",
      icon: <DiscordLogo size={18} weight="fill" className="text-label" />,
      title: call.channelName,
      detail: [call.guildName, t(call.members.length === 1 ? "{n} Person" : "{n} Personen", { n: call.members.length })].filter(Boolean).join(" · "),
      trailing: <Equalizer playing={call.members.some((m) => m.speaking)} tint="bg-green" />,
    };
  } else if (np) {
    item = {
      key: "media",
      tab: "media",
      icon: np.artwork ? (
        // Same layoutId as the cover in Now Playing, so a click flies it there.
        <motion.img layoutId={ARTWORK_LAYOUT_ID} transition={springs.morph} src={np.artwork} alt="" draggable={false} className="size-7 rounded-[6px] object-cover" />
      ) : (
        <MusicNoteSimple size={18} weight="fill" className="text-label-2" />
      ),
      title: np.title,
      detail: np.artist,
      trailing: <Equalizer playing={np.isPlaying} />,
    };
  }

  return (
    <div className="relative h-11 overflow-hidden rounded-[12px] bg-fill-1">
      <AnimatePresence mode="popLayout" initial={false}>
        {item ? (
          <motion.button
            key={item.key}
            onClick={() => navigate(item.tab)}
            className="pressable pressable-wide pressable-fill absolute inset-0 flex items-center gap-2.5 px-2.5 text-start"
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          >
            <span className="flex size-7 shrink-0 items-center justify-center">{item.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-footnote font-medium text-label">{item.title}</span>
              <span className="block truncate text-caption text-label-3">{item.detail}</span>
            </span>
            {item.trailing && <span className="shrink-0 pe-1">{item.trailing}</span>}
          </motion.button>
        ) : (
          <motion.div
            key="idle"
            className="absolute inset-0 flex items-center justify-center text-footnote text-label-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: content.enter }}
            exit={{ opacity: 0, transition: content.exit }}
          >
            {t("Gerade läuft nichts")}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Windows focus on/off. Light = on (like Control Center). */
function FocusTile() {
  const [focus, setFocus] = useState<FocusState | null>(null);
  useEffect(() => {
    const load = () => void systemControls.focus().then(setFocus).catch(() => setFocus(null));
    load();
    // Also toggled elsewhere (taskbar, Clock app) → follow it.
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);
  const active = !!focus?.active;
  const hue = useHue("indigo");
  const label = focus?.kind === "dnd" ? t("Nicht stören") : t("Fokus");

  return (
    <button
      aria-pressed={active}
      disabled={!focus}
      onClick={() => {
        setFocus((f) => f && { ...f, active: !active });
        void systemControls.setFocus(!active).then(setFocus).catch(() => systemControls.focus().then(setFocus));
      }}
      className={`pressable flex h-10 min-w-[150px] shrink-0 items-center gap-2.5 rounded-[12px] px-2.5 transition-colors duration-200 disabled:opacity-40 ${
        active ? "bg-label text-black" : "bg-fill-1 text-label"
      }`}
    >
      <motion.span
        className={`flex size-6 items-center justify-center rounded-full ${active ? "bg-black/10" : "bg-fill-2"}`}
        animate={{ rotate: active ? 0 : -30 }}
        transition={springs.snappy}
      >
        <Moon size={14} weight="fill" style={!active && hue ? { color: hue } : undefined} />
      </motion.span>
      <span className="min-w-0 text-start">
        <span className="block truncate text-footnote font-semibold">{label}</span>
        <span className={`block text-caption ${active ? "text-black/55" : "text-label-3"}`}>{active ? t("An") : t("Aus")}</span>
      </span>
    </button>
  );
}

/** Keeps the PC and the display awake. A tap is until turned off; the caret picks a duration, shown as the time left. */
function AwakeTile() {
  const a = awake.use();
  const now = useNow().getTime();
  const active = awakeOn(a, now);
  const hue = useHue("amber");
  const left = awakeLeft(a, now);
  const mode = !active ? "off" : a?.minutes == null ? "on" : String(a.minutes);
  const options = [
    ...AWAKE_MINUTES.map((m) => ({ value: String(m), label: m < 60 ? t("{n} Min.", { n: m }) : t("{n} Std.", { n: m / 60 }) })),
    { value: "on", label: t("Bis zum Ausschalten") },
    { value: "off", label: t("Aus") },
  ];

  return (
    <div className={`flex h-10 min-w-[150px] shrink-0 items-center rounded-[12px] transition-colors duration-200 ${active ? "bg-label text-black" : "bg-fill-1 text-label"}`}>
      <button aria-pressed={active} onClick={() => (active ? stopAwake() : startAwake(null))} className="pressable flex h-full min-w-0 flex-1 items-center gap-2.5 ps-2.5">
        <motion.span
          className={`flex size-6 shrink-0 items-center justify-center rounded-full ${active ? "bg-black/10" : "bg-fill-2"}`}
          animate={{ rotate: active ? 0 : -30 }}
          transition={springs.snappy}
        >
          <Coffee size={14} weight="fill" style={!active && hue ? { color: hue } : undefined} />
        </motion.span>
        <span className="min-w-0 text-start">
          <span className="block truncate text-footnote font-semibold">{t("Wach halten")}</span>
          <span className={`tabular block truncate text-caption ${active ? "text-black/55" : "text-label-3"}`}>
            {!active ? t("Aus") : left === null ? t("An") : t("noch {time}", { time: formatLeft(left) })}
          </span>
        </span>
      </button>
      <Select
        width="shrink-0 pe-1"
        value={mode}
        options={options}
        onChange={(v) => (v === "off" ? stopAwake() : startAwake(v === "on" ? null : Number(v)))}
        trigger={{
          label: t("Dauer wählen"),
          menuWidth: 150,
          className: `pressable flex size-6 items-center justify-center rounded-full ${active ? "text-black/55 hover:text-black" : "text-label-3 hover:text-label"}`,
          content: <CaretDown size={11} weight="bold" />,
        }}
      />
    </div>
  );
}

const OUTPUT_ICONS = { headphones: Headphones, "speaker-hifi": SpeakerHifi, speaker: SpeakerSimpleHigh };

function OutputIcon({ name, className }: { name: string; className?: string }) {
  const Icon = OUTPUT_ICONS[outputIcon(name)];
  return <Icon size={15} weight="fill" className={className} />;
}

/** The active playback devices; picking one makes it the Windows default. */
function OutputList({ outputs, onPick }: { outputs: AudioOutput[]; onPick: (id: string) => void }) {
  return (
    <motion.div
      className="flex shrink-0 flex-col"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: { ...content.enter, delay: 0.06 } }}
    >
      <div className="mx-0.5 mb-[3px] h-px bg-separator" />
      <div
        role="listbox"
        aria-label={t("Ausgabegerät")}
        className="-mx-1 overflow-y-auto px-1 [scrollbar-width:none]"
        style={{ maxHeight: MIXER_MAX_ROWS * MIXER_ROW }}
      >
        {outputs.map((o) => (
          <button
            key={o.id}
            role="option"
            aria-selected={o.default}
            onClick={() => onPick(o.id)}
            className="pressable flex w-full items-center gap-2.5 rounded-[10px] px-2 text-start hover:bg-fill-1"
            style={{ height: MIXER_ROW }}
          >
            <OutputIcon name={o.name} className={`shrink-0 ${o.default ? "text-label" : "text-label-3"}`} />
            <span className={`min-w-0 flex-1 truncate text-footnote ${o.default ? "font-medium text-label" : "text-label-2"}`}>{o.name}</span>
            {o.default && <Check size={13} weight="bold" className="shrink-0 text-label" />}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

/** Thick volume slider like Control Center: drag anywhere, icon = mute. `device` is the default output's name, null with nothing to choose from. */
/** A tile (h-10) and the gap above it (gap-2.5). */
const BRIGHTNESS_ROW = 50;

/** The notch's monitor brightness, 0..100. A drag sends one write at a time and then the latest level: DDC/CI answers slowly. */
/** `busy`: a drag is under way. `hold`: until when the parent's poll must not overwrite the level (writes in flight, plus a second). */
function BrightnessTile({ level, busy, hold, onLevel }: { level: number; busy: { current: boolean }; hold: { current: number }; onLevel: (percent: number) => void }) {
  const sunHue = useHue("amber");
  const track = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const next = useRef<number | null>(null);
  const push = (percent: number) => {
    next.current = percent;
    hold.current = Infinity;
    if (sending.current) return;
    sending.current = true;
    const run = () => {
      const value = next.current;
      next.current = null;
      if (value === null) {
        sending.current = false;
        hold.current = Date.now() + 1000;
        return;
      }
      void systemControls.setBrightness(value).catch(() => {}).finally(run);
    };
    run();
  };
  const set = (percent: number) => {
    const p = Math.round(Math.min(100, Math.max(0, percent)));
    onLevel(p);
    push(p);
  };
  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * 100;
  };
  const Icon = level < 50 ? SunDim : Sun;

  return (
    <div className="flex h-10 items-center gap-2 rounded-[12px] bg-fill-1 pe-3 ps-1.5">
      <span className="flex size-7 shrink-0 items-center justify-center text-label-2" style={sunHue ? { color: sunHue } : undefined}>
        <Icon size={15} weight="fill" />
      </span>
      <div
        ref={track}
        // Filled from the left in every language, like the volume.
        dir="ltr"
        role="slider"
        tabIndex={0}
        aria-label={t("Helligkeit")}
        aria-valuenow={level}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-6 min-w-0 flex-1 cursor-pointer touch-none overflow-hidden rounded-full bg-fill-2 outline-none"
        onPointerDown={(e) => {
          busy.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          set(at(e.clientX));
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && set(at(e.clientX))}
        onPointerUp={() => (busy.current = false)}
        onPointerCancel={() => (busy.current = false)}
        onWheel={(e) => set(level + (e.deltaY < 0 ? 2 : -2))}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") set(level + (e.key === "ArrowRight" ? 5 : -5));
        }}
      >
        <motion.div
          className="absolute inset-0 origin-left rounded-full bg-label"
          initial={false}
          animate={{ transform: `scaleX(${level / 100})` }}
          transition={busy.current ? { duration: 0 } : springs.snappy}
        />
      </div>
      <span className="tabular w-8 shrink-0 text-end text-caption font-semibold text-label-2">{level}</span>
    </div>
  );
}

function VolumeTile({ device, open, onDevices }: { device: string | null; open: boolean; onDevices: () => void }) {
  const speakerHue = useHue("sky");
  const outputHue = useHue("teal");
  const [vol, setVol] = useState<VolumeState | null>(null);
  const dragging = useRef(false);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => !dragging.current && void systemControls.volume().then(setVol).catch(() => {});
    load();
    // Keyboard volume keys or taskbar → follow them.
    const id = setInterval(load, 1000);
    return () => clearInterval(id);
  }, []);

  const level = vol ? (vol.muted ? 0 : vol.level) : 0;
  const set = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const l = Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * 100) / 100;
    setVol({ level: l, muted: false });
    void systemControls.setVolume({ level: l });
  };
  const Icon = vol?.muted || level === 0 ? SpeakerSimpleSlash : level < 0.34 ? SpeakerNone : level < 0.67 ? SpeakerLow : SpeakerHigh;

  return (
    <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[12px] bg-fill-1 pe-3 ps-1.5">
      <button
        aria-label={vol?.muted ? t("Stummschaltung aufheben") : t("Stumm")}
        disabled={!vol}
        onClick={() => vol && void systemControls.setVolume({ muted: !vol.muted }).then(setVol)}
        className={`pressable flex size-7 shrink-0 items-center justify-center rounded-full ${vol?.muted ? "text-red" : "text-label-2 hover:text-label"}`}
        style={!vol?.muted && speakerHue ? { color: speakerHue } : undefined}
      >
        <Icon size={15} weight="fill" />
      </button>
      <div
        ref={track}
        // Filled from the left in every language: the pointer math reads from the left.
        dir="ltr"
        role="slider"
        tabIndex={0}
        aria-label={t("Lautstärke")}
        aria-valuenow={Math.round(level * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-6 min-w-0 flex-1 cursor-pointer touch-none overflow-hidden rounded-full bg-fill-2 outline-none"
        onPointerDown={(e) => {
          if (!vol) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          set(e.clientX);
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && set(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onWheel={(e) => {
          if (!vol) return;
          const l = Math.min(1, Math.max(0, level + (e.deltaY < 0 ? 0.02 : -0.02)));
          setVol({ level: l, muted: false });
          void systemControls.setVolume({ level: l });
        }}
        onKeyDown={(e) => {
          if (!vol || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
          const l = Math.min(1, Math.max(0, level + (e.key === "ArrowRight" ? 0.05 : -0.05)));
          setVol({ level: l, muted: false });
          void systemControls.setVolume({ level: l });
        }}
      >
        <motion.div
          className="absolute inset-0 origin-left rounded-full bg-label"
          initial={false}
          animate={{ transform: `scaleX(${level})` }}
          transition={dragging.current ? { duration: 0 } : springs.snappy}
        />
      </div>
      <span className="tabular w-8 shrink-0 text-end text-caption font-semibold text-label-2">{vol ? Math.round(level * 100) : "–"}</span>
      {device !== null && (
        <button
          aria-label={t("Ausgabegerät")}
          aria-expanded={open}
          title={device || t("Ausgabegerät")}
          onClick={onDevices}
          className={`pressable -me-1.5 flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-150 ${
            open ? "bg-fill-2 text-label" : "text-label-2 hover:text-label"
          }`}
          style={!open && outputHue ? { color: outputHue } : undefined}
        >
          <OutputIcon name={device} />
        </button>
      )}
    </div>
  );
}
