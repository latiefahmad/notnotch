import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationFrame, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { ArrowUpRight, MicrophoneStage, MusicNoteSimple, Pause, Play, Repeat, RepeatOnce, Shuffle, SkipBack, SkipForward } from "@phosphor-icons/react";
import { artwork as artworkSwap, content, springs } from "../../design/motion";
import { useSmoothArtwork } from "./artwork";
import { livePosition, media, useNowPlaying, type NowPlaying } from "../../platform/media";
import { holdOpen } from "../../notch/useNotchState";
import { requestSize } from "../../notch/size";
import { findTab } from "../../notch/tabs";
import { MIXER_MAX_ROWS, MIXER_ROW, MixerList, MixerToggle, useMixer } from "./Mixer";
import { Equalizer } from "./Equalizer";
import { LYRICS_PANEL, LyricsPanel } from "./LyricsPanel";
import { SourcePanel, SourceToggle, sourcePanelRows } from "./SourcePanel";
import { offersSources } from "./sources";
import { setMusic } from "./music";
import { sinePath } from "./shapes";
import { settings } from "../../settings/store";
import { t } from "../../i18n";

type Panel = "mixer" | "sources" | "lyrics" | null;

/*
 * Layout like the expanded Dynamic Island:
 *   [Cover] Title / Artist                   [EQ]     ← click: open the playing app
 *   0:52 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -3:10
 *   [Spotify ⇅]     ⇄   ⏮   ⏯   ⏭   ↻          [🎤][⌄]
 *   (one panel below: player menu, lyrics or mixer; the notch grows down)
 * The player menu only shows with two or more players, shuffle and repeat only where the app offers them.
 */
export function NowPlayingView() {
  const np = useNowPlaying();
  const mix = useMixer();
  const music = settings.use().music;
  // The lyrics stay open from one visit to the next; the other panels close with the notch.
  const [panel, setPanelState] = useState<Panel>(() => (music.lyricsOpen ? "lyrics" : null));
  const setPanel = (p: Panel) => {
    setPanelState(p);
    if ((p === "lyrics") !== music.lyricsOpen) setMusic({ lyricsOpen: p === "lyrics" });
  };
  const toggle = (p: Panel) => setPanel(panel === p ? null : p);
  const source = mix.source?.name;
  // The player menu closes for good when the choice goes away (a player quit), so it doesn't pop up again later.
  const noChoice = panel === "sources" && !!np && !offersSources(np.sources, music.pinned);
  useEffect(() => {
    if (noChoice) setPanelState(null);
  }, [noChoice]);
  const shown = noChoice ? null : panel;

  // A panel grows the notch by its rows (at most MIXER_MAX_ROWS, then it scrolls).
  const mixerRows = Math.min(MIXER_MAX_ROWS, (mix.system ? 1 : 0) + Math.max(1, mix.apps.length));
  const extra = !np ? 0
    : shown === "mixer" ? mixerRows * MIXER_ROW + 14
    : shown === "sources" ? sourcePanelRows(np, music.pinned) * MIXER_ROW + 14
    : shown === "lyrics" ? LYRICS_PANEL
    : 0;
  useEffect(() => {
    if (!extra) return requestSize("media", null);
    const base = findTab("media")!.size;
    requestSize("media", { w: base.w, h: base.h + extra });
  }, [extra]);
  useEffect(() => () => requestSize("media", null), []);

  if (!np) return <Empty />;

  return (
    <div className="flex h-full flex-col px-5 pt-1 pb-2">
      <div className="flex items-center gap-3">
        <button
          onClick={() => void media.openSource()}
          title={source ? t("In {app} öffnen", { app: source }) : t("App öffnen")}
          className="group/source pressable flex min-w-0 flex-1 items-center gap-3 rounded-[12px] text-start"
        >
          <Artwork np={np} />
          <div className="relative min-w-0 flex-1">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={np.title}
                initial={{ opacity: 0, filter: "blur(4px)" }}
                animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
                exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
              >
                <div className="truncate text-title font-semibold">{np.title}</div>
                <div className="truncate text-body text-label-2">{np.artist}</div>
              </motion.div>
            </AnimatePresence>
          </div>
        </button>
        <Equalizer key={music.eqStyle} playing={np.isPlaying} height={16} look={music.eqStyle} />
      </div>
      <Progress np={np} wavy={music.progressStyle === "wavy"} />
      <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="flex min-w-0 justify-start">
          <SourceToggle np={np} open={shown === "sources"} onToggle={() => toggle("sources")} />
        </div>
        <Controls np={np} />
        <div className="flex min-w-0 items-center justify-end gap-1">
          <button
            onClick={() => toggle("lyrics")}
            aria-pressed={shown === "lyrics"}
            aria-label={t("Songtext")}
            title={t("Songtext")}
            className={`pressable pressable-fill flex size-7 items-center justify-center rounded-full transition-colors duration-150 ${
              shown === "lyrics" ? "bg-fill-2 text-label" : "text-label-3 hover:text-label-2"
            }`}
          >
            <MicrophoneStage size={14} weight="bold" />
          </button>
          <MixerToggle open={shown === "mixer"} onToggle={() => toggle("mixer")} />
        </div>
      </div>
      <AnimatePresence mode="popLayout">
        {shown === "mixer" && <MixerList key="mixer" data={mix} />}
        {shown === "sources" && <SourcePanel key="sources" np={np} />}
        {shown === "lyrics" && <LyricsPanel key="lyrics" np={np} />}
      </AnimatePresence>
    </div>
  );
}

/** Shared with the overview: clicking the activity flies the cover here. */
export const ARTWORK_LAYOUT_ID = "now-playing-artwork";

function Artwork({ np }: { np: NowPlaying }) {
  const artwork = useSmoothArtwork(np.artwork);
  return (
    // Outer wrapper flies (layout), inner one scales on pause; separate so they don't fight over transform.
    <motion.div layoutId={ARTWORK_LAYOUT_ID} transition={springs.morph} className="size-14 shrink-0">
      {/* Paused: the cover shrinks back slightly and dims, like Apple Music. */}
      <motion.div
        className="relative size-14 shrink-0"
        initial={false}
        animate={{ transform: np.isPlaying ? "scale(1)" : "scale(0.9)" }}
        transition={springs.snappy}
      >
        <AnimatePresence initial={false}>
          {artwork ? (
            <motion.img
              key={artwork}
              src={artwork}
              alt=""
              draggable={false}
              className="absolute inset-0 size-full rounded-[12px] object-cover"
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)", transition: artworkSwap.enter }}
              exit={{ opacity: 0, transition: artworkSwap.exit }}
            />
          ) : (
            // No cover (some browser players): a calm placeholder instead of a gap.
            <motion.div
              key="placeholder"
              className="absolute inset-0 flex items-center justify-center rounded-[12px] bg-fill-2 text-label-3"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: artworkSwap.enter }}
              exit={{ opacity: 0, transition: artworkSwap.exit }}
            >
              <MusicNoteSimple size={22} weight="fill" />
            </motion.div>
          )}
        </AnimatePresence>
        <motion.div
          className="pointer-events-none absolute inset-0 rounded-[12px]"
          initial={false}
          animate={{ backgroundColor: np.isPlaying ? "rgb(0 0 0 / 0)" : "rgb(0 0 0 / 0.35)" }}
          transition={{ duration: 0.25 }}
        />
        {/* Hover: hint that a click opens the app. */}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[12px] bg-black/45 text-label opacity-0 transition-opacity duration-150 group-hover/source:opacity-100">
          <ArrowUpRight size={20} weight="bold" />
        </span>
      </motion.div>
    </motion.div>
  );
}

/** Wavy progress, in px: like the iOS 16 lock screen. The wave travels while playing and flattens when paused. */
const WAVY = { amp: 3, wavelength: 22, speed: 4, settle: 0.25, inset: 3 };

/**
 * Progress + seeking. Drag or click to jump; while grabbed the bar gets thicker and
 * brighter and the times show the target (like Apple Music).
 * The seek only happens on release, one seek per gesture.
 * `wavy`: the played part is a sine instead of a straight bar; seeking stays the same.
 */
function Progress({ np, wavy }: { np: NowPlaying; wavy: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  // Target position (0..1) while dragging; ref for the frame loop, state for the times.
  const scrubRef = useRef<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState(false);
  const npRef = useRef(np);
  npRef.current = np;

  const ratio = () => {
    const n = npRef.current;
    return scrubRef.current ?? (n.duration > 0 ? livePosition(n) / n.duration : 0);
  };
  const progress = useMotionValue(ratio());
  // Wavy: track width, wave state and the last drawn state, so a paused, settled wave writes nothing.
  const width = useRef(0);
  const played = useRef<SVGPathElement>(null);
  const rest = useRef<SVGPathElement>(null);
  const wave = useRef({ amp: np.isPlaying ? 1 : 0, phase: 0, drawn: "" });
  const reduced = useReducedMotion();
  useAnimationFrame((_, delta) => {
    progress.set(ratio());
    const w = width.current - 2 * WAVY.inset;
    if (!wavy || w <= 0 || !played.current || !rest.current) return;
    const s = wave.current;
    const target = npRef.current.isPlaying ? 1 : 0;
    const dt = Math.min(0.05, delta / 1000);
    // Reduced motion: a still wave, no travel and no glide to flat.
    if (reduced) s.amp = target;
    else {
      s.amp += (target - s.amp) * (1 - Math.exp(-dt / WAVY.settle));
      if (Math.abs(target - s.amp) < 0.002) s.amp = target;
      if (target) s.phase = (s.phase - dt * WAVY.speed) % (2 * Math.PI);
    }
    const x = progress.get() * w;
    const key = `${w} ${x.toFixed(2)} ${s.amp.toFixed(3)} ${s.phase.toFixed(3)}`;
    if (key === s.drawn) return;
    s.drawn = key;
    played.current.setAttribute("d", sinePath(x, 8, WAVY.amp * s.amp, WAVY.wavelength, s.phase));
    rest.current.setAttribute("d", `M${x.toFixed(2)} 8H${w}`);
  });
  // Translate instead of stretch: no distorted round end, no raster artifacts while seeking.
  const transform = useTransform(progress, (p) => `translateX(${((p - 1) * 100).toFixed(3)}%)`);

  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const hasTrack = np.duration > 0;
  useEffect(() => {
    const el = track.current;
    if (!wavy || !el) return;
    const ro = new ResizeObserver(() => {
      width.current = el.clientWidth;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [wavy, hasTrack]);

  // Unknown duration (live stream): keep the row as a placeholder so nothing jumps.
  if (!hasTrack) return <div className="mt-3.5 h-[14px]" />;

  const pos = scrub !== null ? scrub * np.duration : livePosition(np);
  const active = scrub !== null || (hover && np.canSeek);

  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const move = (clientX: number) => {
    scrubRef.current = at(clientX);
    setScrub(scrubRef.current);
  };
  const end = (commit: boolean) => {
    if (scrubRef.current === null) return;
    if (commit) media.seek(scrubRef.current * np.duration);
    scrubRef.current = null;
    setScrub(null);
    holdOpen(false);
  };

  return (
    // Time runs left to right on the bar in any language, as on every player.
    <div dir="ltr" className="mt-3.5 flex items-center gap-2.5">
      <span className={`tabular w-9 text-caption font-medium transition-colors duration-150 ${scrub !== null ? "text-label" : "text-label-3"}`}>
        {format(pos)}
      </span>
      {/* Hit area taller than the bar so it's easy to grab. */}
      <div
        ref={track}
        className={`relative flex h-4 flex-1 items-center ${np.canSeek ? "touch-none" : ""}`}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onPointerDown={(e) => {
          if (!np.canSeek || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          holdOpen(true);
          move(e.clientX);
        }}
        onPointerMove={(e) => scrubRef.current !== null && move(e.clientX)}
        onPointerUp={() => end(true)}
        onPointerCancel={() => end(false)}
        onLostPointerCapture={() => end(true)}
      >
        {wavy ? (
          <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
            <g
              transform={`translate(${WAVY.inset} 0)`}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-[stroke-width] duration-150 ease-out ${active ? "stroke-[5px]" : "stroke-[3.5px]"}`}
            >
              <path ref={rest} className="stroke-fill-2" />
              <path ref={played} className={`transition-[stroke] duration-150 ${active ? "stroke-label" : "stroke-label-2"}`} />
            </g>
          </svg>
        ) : (
          <div
            className={`relative w-full overflow-hidden rounded-full bg-fill-2 transition-[height] duration-150 ease-out ${active ? "h-[9px]" : "h-[5px]"}`}
          >
            <motion.div
              className={`absolute inset-0 rounded-full transition-colors duration-150 ${active ? "bg-label" : "bg-label-2"}`}
              style={{ transform }}
            />
          </div>
        )}
      </div>
      <span className={`tabular w-9 text-end text-caption font-medium transition-colors duration-150 ${scrub !== null ? "text-label" : "text-label-3"}`}>
        -{format(np.duration - pos)}
      </span>
    </div>
  );
}

function Controls({ np }: { np: NowPlaying }) {
  const playing = np.isPlaying;
  // Either one offered: both slots stay, so play/pause keeps the centre.
  const modes = np.shuffle !== null || np.repeat !== null;
  return (
    // Transport keys keep their order in any language, like the time bar above.
    <div dir="ltr" className={`flex items-center justify-center ${modes ? "gap-4" : "gap-6"}`}>
      {modes && (
        <ModeButton label={t("Zufallswiedergabe")} active={!!np.shuffle} offered={np.shuffle !== null} onClick={media.toggleShuffle}>
          <Shuffle size={16} weight="bold" />
        </ModeButton>
      )}
      <IconButton label={t("Vorheriger Titel")} onClick={media.previous}>
        <SkipBack size={20} weight="fill" />
      </IconButton>
      <IconButton label={playing ? t("Pause") : t("Abspielen")} onClick={media.toggle}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={playing ? "pause" : "play"}
            className="flex"
            initial={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
            animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" }}
            exit={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
            transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
          >
            {playing ? <Pause size={26} weight="fill" /> : <Play size={26} weight="fill" />}
          </motion.span>
        </AnimatePresence>
      </IconButton>
      <IconButton label={t("Nächster Titel")} onClick={media.next}>
        <SkipForward size={20} weight="fill" />
      </IconButton>
      {modes && (
        <ModeButton
          label={np.repeat === "track" ? t("Titel wiederholen") : np.repeat === "list" ? t("Alle wiederholen") : t("Wiederholen aus")}
          active={!!np.repeat && np.repeat !== "none"}
          offered={np.repeat !== null}
          onClick={media.cycleRepeat}
        >
          {np.repeat === "track" ? <RepeatOnce size={16} weight="bold" /> : <Repeat size={16} weight="bold" />}
        </ModeButton>
      )}
    </div>
  );
}

/** Shuffle or repeat: dim while off, bright with a dot while on, an empty slot where the app has no such control. */
function ModeButton(props: { label: string; active: boolean; offered: boolean; onClick: () => void; children: React.ReactNode }) {
  if (!props.offered) return <span className="size-8" aria-hidden />;
  return (
    <button
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      onClick={props.onClick}
      className={`pressable pressable-fill relative flex size-8 items-center justify-center rounded-full transition-colors duration-150 ${
        props.active ? "text-label" : "text-label-3 hover:text-label-2"
      }`}
    >
      {props.children}
      <span className={`absolute bottom-0.5 size-1 rounded-full bg-label transition-opacity duration-150 ${props.active ? "opacity-100" : "opacity-0"}`} />
    </button>
  );
}

function IconButton(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-label={props.label}
      onClick={props.onClick}
      className="pressable pressable-fill flex size-10 items-center justify-center rounded-full text-label"
    >
      {props.children}
    </button>
  );
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center text-body text-label-3">{t("Gerade läuft nichts")}</div>
  );
}

function format(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
