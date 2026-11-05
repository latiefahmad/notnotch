import { ArrowDown, ArrowUp, Lightning, LockSimple, SignOut, Thermometer, type Icon } from "@phosphor-icons/react";
import { t } from "../../../i18n";
import { fps, useFpsPolling } from "../../../features/system/gaming";
import { batteryLevel } from "../../../features/system/battery";
import { compactRate, compactWatts, WIDEST } from "../../../features/system/format";
import { ofRate, ofShare, schemeColor, type Level } from "../../../features/system/levels";
import { system } from "../../../features/system/store";
import { tempLevel } from "../../../features/system/temps";
import { settings } from "../../../settings/store";
import { activeTheme } from "../../../features/themes/store";
import type { ClosedSettings } from "../parts";
import { CAPTION_FONT, measureText } from "../measure";

export type ReadingId = "fps" | "cpu" | "ram" | "gpu" | "down" | "up" | "power" | "battery" | "temp";
/** `source`: which sensor a temperature comes from; `estimate`: power summed from parts, not measured. */
export interface Reading { id: ReadingId; value: number | null; level: Level; source?: "cpu" | "gpu"; estimate?: boolean }

export const READING_GAP = 6;
/** MARK: the C / G letter after the thermometer. */
const DIAL = 16, DIAL_GAP = 3, GLYPH = 11, MARK = 6;
const LETTER: Partial<Record<ReadingId, string>> = { cpu: "C", ram: "M", gpu: "G" };
/** Settings, Tools, Hardware, "Coloured icons". Tuned for the black closed notch; a theme that paints the closed notch keeps its own ink. */
const ICON_COLORS: Partial<Record<ReadingId, string>> = {
  cpu: "#f87171", ram: "#a78bfa", gpu: "#34d399", down: "#22d3ee", up: "#f472b6", power: "#fbbf24", battery: "#4ade80", temp: "#fb923c",
};
const GLYPHS: Partial<Record<ReadingId, Icon>> = { down: ArrowDown, up: ArrowUp, power: Lightning, temp: Thermometer };

/** Each reading reserves its widest figure (tabular digits are each as wide as an 8), so the row never shifts. */
const widest = (id: ReadingId) => (id === "down" || id === "up" ? WIDEST.rate : id === "power" ? WIDEST.watts : id === "temp" ? WIDEST.temp : WIDEST.percent);
const digits = (id: ReadingId) => measureText(widest(id).replace(/[0-9]/g, "8"));
const lead = (id: ReadingId) => (id === "fps" ? measureText("FPS", CAPTION_FONT) : id === "battery" ? BATTERY_W : LETTER[id] ? DIAL : id === "temp" ? GLYPH + MARK : GLYPH);
export const readingWidth = (id: ReadingId) => lead(id) + DIAL_GAP + digits(id);

/** Once the GPU has answered with a number it has counters; before that (or never, without them) it stays out of the row. */
let gpuSeen = false;

/**
 * The readings to show, in order: FPS first during gaming (polled here, once a second), then CPU, RAM, GPU, then the
 * opt-in ones: download and upload, power, battery, temperature (CPU, else the GPU shown). Gaming forces CPU, RAM and GPU
 * on even when the part or the single readings are off. Battery, power and temperature stay out while the machine has
 * none to give. The values come from the system store's own rhythms (GPU every 2 s while it is in the row); the ping is
 * never woken here.
 */
export function useReadings(closed: ClosedSettings, gaming: boolean): Reading[] {
  useFpsPolling(gaming);
  const f = fps.use();
  const st = system.use();
  const stats = st.stats;
  if (stats?.gpu != null) gpuSeen = true;
  if (!gaming && (!closed.parts.readings || !stats)) return [];
  const on = closed.readings, list: Reading[] = [];
  const share = (id: ReadingId, v: number | null) => list.push({ id, value: v, level: ofShare(v ?? 0) });
  if (gaming) list.push({ id: "fps", value: f.value, level: 0 });
  if (gaming || on.cpu) share("cpu", stats?.cpu ?? null);
  if (gaming || on.ram) share("ram", stats ? (stats.memUsed / stats.memTotal) * 100 : null);
  if ((gaming || on.gpu) && gpuSeen) share("gpu", stats?.gpu ?? null);
  if (!closed.parts.readings) return list;
  if (on.net) {
    list.push({ id: "down", value: st.net?.down ?? null, level: ofRate(st.net?.down ?? 0) });
    list.push({ id: "up", value: st.net?.up ?? null, level: ofRate(st.net?.up ?? 0) });
  }
  if (on.power && st.power) list.push({ id: "power", value: st.power.watts, level: 0, estimate: st.power.estimate });
  if (on.battery && st.battery) list.push({ id: "battery", value: st.battery.percent, level: batteryLevel(st.battery) });
  if (on.temp && st.cpuTemp !== null) list.push({ id: "temp", value: st.cpuTemp, level: tempLevel("cpu", st.cpuTemp), source: "cpu" });
  else if (on.temp && st.gpuTemp !== null) list.push({ id: "temp", value: st.gpuTemp, level: tempLevel("gpu", st.gpuTemp), source: "gpu" });
  return list;
}

const text = ({ id, value: v, estimate }: Reading) => {
  if (v === null) return "-";
  if (id === "down" || id === "up") return compactRate(v);
  // "~" as in the tool: a sum of parts, not a measurement.
  if (id === "power") return `${estimate ? "~" : ""}${compactWatts(v)}W`;
  if (id === "temp") return `${Math.round(v)}°`;
  return `${Math.round(v)}%`;
};

/** What a screen reader says for the readings that have no dial letter of their own. */
function spoken(r: Reading): string | undefined {
  const name =
    r.id === "down" ? t("Download") : r.id === "up" ? t("Upload") : r.id === "power" ? t("Leistung") : r.id === "battery" ? t("Akku")
    : r.id === "temp" ? t(r.source === "gpu" ? "GPU-Temperatur" : "CPU-Temperatur") : null;
  return name === null ? undefined : `${name} ${text(r)}`;
}

/** A dial open at the bottom with its letter, then the number; FPS as a word, the others with a small glyph. */
export function ReadingView({ reading }: { reading: Reading }) {
  const { id, value, level, source } = reading;
  const { system: sys, themes: { iconColors } } = settings.use();
  const themedNotch = !!activeTheme.use().closedNotch;
  const color = id === "fps" ? "var(--color-label)" : schemeColor(sys.colors, level);
  // Fixed colours, not the theme's hues: the closed notch stays black on light themes too.
  const iconColor = iconColors && !themedNotch ? ICON_COLORS[id] : undefined;
  const G = GLYPHS[id];
  const label = spoken(reading);
  return (
    <span className="flex shrink-0 items-center" style={{ gap: DIAL_GAP, width: readingWidth(id), color }} role={label ? "img" : undefined} aria-label={label}>
      <span className="flex shrink-0 items-center" style={{ color: iconColor }}>
        {id === "fps" ? (
          <span className="text-caption font-medium text-label-3">FPS</span>
        ) : LETTER[id] ? (
          <Dial letter={LETTER[id]} value={value ?? 0} arc={iconColor ? color : undefined} />
        ) : id === "battery" ? (
          <BatteryGlyph value={value ?? 0} />
        ) : G ? (
          <span className="flex shrink-0 items-center" aria-hidden>
            <G size={GLYPH} weight="bold" />
            {/* C or G: which sensor the temperature is from. */}
            {id === "temp" && (
              <span className="text-[8px] leading-none font-bold" style={{ width: MARK }}>
                {LETTER[source ?? "cpu"]}
              </span>
            )}
          </span>
        ) : null}
      </span>
      {/* Left-aligned next to its own icon: the space left for wider figures falls before the next reading. */}
      <span className="tabular text-left text-footnote font-medium transition-colors duration-300" style={{ width: digits(id) }} aria-hidden={label ? true : undefined}>
        {id === "fps" ? <FpsValue /> : text(reading)}
      </span>
    </span>
  );
}

/** `arc`: the value's colour when the icon has a colour of its own, so a red CPU letter never reads as high load. */
function Dial({ letter, value, arc }: { letter: string; value: number; arc?: string }) {
  const v = Math.min(100, Math.max(0, value)) * 0.75;
  return (
    <svg width={DIAL} height={DIAL} viewBox="0 0 16 16" className="shrink-0" aria-hidden>
      {/* 270 degrees from bottom left round to bottom right, the gap at the bottom. */}
      <g transform="rotate(135 8 8)" fill="none" strokeWidth="2" strokeLinecap="round">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeOpacity={0.25} pathLength={100} strokeDasharray="75 100" />
        {v > 0 && <circle cx="8" cy="8" r="7" stroke={arc ?? "currentColor"} pathLength={100} strokeDasharray={`${v} 100`} />}
      </g>
      <text x="8" y="8.5" textAnchor="middle" dominantBaseline="middle" fontSize="7" fontWeight="700" fill="currentColor">
        {letter}
      </text>
    </svg>
  );
}

const BATTERY_W = 17;
/** A battery outline filled to its charge. */
function BatteryGlyph({ value }: { value: number }) {
  const fill = (Math.min(100, Math.max(0, value)) / 100) * 11;
  return (
    <svg width={BATTERY_W} height={10} viewBox="0 0 17 10" className="shrink-0" aria-hidden>
      <rect x="0.75" y="0.75" width="14" height="8.5" rx="2" fill="none" stroke="currentColor" strokeOpacity={0.5} strokeWidth="1.5" />
      <rect x="15.5" y="3.5" width="1.5" height="3" rx="0.5" fill="currentColor" fillOpacity={0.5} />
      {fill > 0 && <rect x="2.25" y="2.25" width={fill} height="5.5" rx="1" fill="currentColor" />}
    </svg>
  );
}

/** Lock = not unlocked yet (Settings, Display), sign-out = unlocked, active after the next sign-in, dash = no frame measured yet. */
function FpsValue() {
  const f = fps.use();
  if (f.error === "no-admin") return <LockSimple size={11} weight="bold" className="inline text-label-3" aria-label={t("FPS freischalten: Einstellungen → Darstellung")} />;
  if (f.error === "relogin") return <SignOut size={11} weight="bold" className="inline text-orange" aria-label={t("Einmal ab- und wieder anmelden, dann laufen die FPS")} />;
  return <>{f.value === null ? "-" : Math.round(f.value)}</>;
}
