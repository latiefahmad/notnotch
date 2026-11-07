// Settings model of the closed notch's row: which parts show and in what order. Pure, so the saved shape can be repaired (and tested) without the app around it.

export const PART_IDS = ["timer", "discord", "rings", "title", "readings", "equalizer", "clock", "github", "calendar", "script", "downloads", "face"] as const;
export type PartId = (typeof PART_IDS)[number];
/** Readings of the closed row; net, power, battery and temp are opt-in. */
export const READING_KEYS = ["cpu", "ram", "gpu", "net", "power", "battery", "temp"] as const;
export type ReadingKey = (typeof READING_KEYS)[number];
export interface ClosedSettings { order: PartId[]; parts: Record<PartId, boolean>; readings: Record<ReadingKey, boolean>; clockSeconds: boolean; lineProgress: boolean; quotaAlerts: boolean; downloadAlerts: boolean; statusAlerts: StatusAlerts }
/** `hideOsd` is not an alert: it hides the Windows volume and brightness indicator while NotNotch shows its own (status.ts osdHidden). */
export interface StatusAlerts { power: boolean; net: boolean; bt: boolean; volume: boolean; brightness: boolean; lock: boolean; hideOsd: boolean }

export const CLOSED_DEFAULTS: ClosedSettings = {
  order: [...PART_IDS],
  parts: { timer: true, discord: true, rings: true, title: false, readings: false, equalizer: true, clock: false, github: false, calendar: false, script: false, downloads: true, face: false },
  readings: { cpu: true, ram: true, gpu: true, net: false, power: false, battery: false, temp: false },
  clockSeconds: false, lineProgress: true, quotaAlerts: true, downloadAlerts: true,
  statusAlerts: { power: true, net: true, bt: true, volume: true, brightness: true, lock: true, hideOsd: false },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

/** Whatever was saved (0.1 had no `closed` at all) becomes a valid value: valid fields kept, unknown ids dropped, missing parts appended in default order. */
export function normalizeClosed(saved: unknown): ClosedSettings {
  const s = isObj(saved) ? saved : {}, d = CLOSED_DEFAULTS;
  const order = (Array.isArray(s.order) ? s.order : []).filter((id, i, all): id is PartId => PART_IDS.includes(id as PartId) && all.indexOf(id) === i);
  for (const id of PART_IDS) if (!order.includes(id)) order.push(id);
  const parts = isObj(s.parts) ? s.parts : {}, readings = isObj(s.readings) ? s.readings : {}, alerts = isObj(s.statusAlerts) ? s.statusAlerts : {};
  return {
    order,
    parts: Object.fromEntries(PART_IDS.map((id) => [id, bool(parts[id], d.parts[id])])) as Record<PartId, boolean>,
    readings: Object.fromEntries(READING_KEYS.map((k) => [k, bool(readings[k], d.readings[k])])) as Record<ReadingKey, boolean>,
    clockSeconds: bool(s.clockSeconds, d.clockSeconds), lineProgress: bool(s.lineProgress, d.lineProgress), quotaAlerts: bool(s.quotaAlerts, d.quotaAlerts),
    downloadAlerts: bool(s.downloadAlerts, d.downloadAlerts),
    statusAlerts: Object.fromEntries(Object.entries(d.statusAlerts).map(([k, v]) => [k, bool(alerts[k], v)])) as unknown as StatusAlerts,
  };
}

/** "title · artist"; with only one of them, just that one. */
export const trackCaption = (title: string, artist: string) => [title.trim(), artist.trim()].filter(Boolean).join(" · ");

/**
 * The tool a part of the closed row opens, with a click or with the hover that opens the notch over it: the cover, the title,
 * a lyric line and the equalizer open the music, the timer and the clock the timer, and so on. null: the notch opens as usual.
 */
export function partTool(part: string): string | null {
  switch (part) {
    case "cover":
    case "lyric":
    case "title":
    case "equalizer":
      return "media";
    case "timer":
    case "clock":
      return "timer";
    case "rings":
      return "usage";
    case "readings":
      return "system";
    case "script":
      return "notices";
    // The face has no tool of its own: it is only there to be looked at.
    case "face":
      return null;
    case "awake":
      return "overview";
    case "downloads":
      return "shelf";
    case "discord":
    case "github":
    case "calendar":
      return part;
    default:
      return null;
  }
}
