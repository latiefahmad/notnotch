// Rules for the closed notch's status alerts (power, network, Bluetooth devices, the volume and brightness HUD, Caps Lock and Num Lock): which transition deserves a short message. Pure; `tr` is passed in so this stays free of i18n.

export interface PowerState { ac: boolean; percent: number | null; battery: boolean }
export interface StatusAlert {
  kind: "power" | "net" | "bt" | "volume" | "brightness" | "lock";
  icon: "plug" | "battery" | "wifi" | "wifi-off" | "headphones" | "speaker-hifi" | "mouse" | "keyboard" | "gamepad" | "phone" | "watch" | "bluetooth" | "speaker-high" | "speaker-low" | "speaker-none" | "speaker-x" | "sun" | "sun-dim" | "caps-lock" | "num-lock";
  text: string;
  tone: "normal" | "warning" | "critical";
  /** 0..100, drawn as a level bar (volume and brightness only). */
  level?: number;
}
/** Which low-battery levels already fired in this discharge. */
export interface LowBattery { warned20: boolean; warned10: boolean }
type Tr = (de: string, vars?: Record<string, string | number>) => string;

export const STATUS = { showMs: 2500, low: 20, critical: 10 } as const;

/**
 * Plug/unplug, then low battery on reaching 20 % and 10 % (each once per discharge). Updates `low`; plugging in resets it.
 * Unplugging at a low level alerts once in that level's tone; a first state already low only marks the level as seen.
 */
export function powerAlert(prev: PowerState | null, next: PowerState, low: LowBattery, tr: Tr): StatusAlert | null {
  if (next.ac) { low.warned20 = low.warned10 = false; }
  if (!next.battery) return null;
  const p = next.percent;
  const level = next.ac || p === null ? null : p <= STATUS.critical ? "critical" : p <= STATUS.low ? "warning" : null;
  const fresh = level !== null && !(level === "critical" ? low.warned10 : low.warned20);
  if (level) { low.warned20 = true; low.warned10 ||= level === "critical"; }
  if (!prev) return null;
  if (prev.ac !== next.ac) return next.ac
    ? { kind: "power", icon: "plug", text: p === null ? tr("Lädt") : tr("Lädt · {p} %", { p }), tone: "normal" }
    : { kind: "power", icon: "battery", text: p === null ? tr("Am Akku") : tr("Akku · {p} %", { p }), tone: level ?? "normal" };
  return fresh && level && p !== null ? { kind: "power", icon: "battery", text: tr("Akku {p} %", { p }), tone: level } : null;
}

/** What the alerts compare against: `null` (or no devices) until a seed or an event says otherwise. */
export interface StatusKnown { power: PowerState | null; online: boolean | null; devices: Set<string> }

/**
 * Merges a seed (the command or the event, in either order, partial or complete) into what is known: it fills only the
 * fields still unknown, so a later, fuller seed completes an early partial one and never overwrites what an event set.
 */
export function mergeSeed(known: StatusKnown, seed: { power: PowerState | null; online: boolean | null; devices: readonly string[] }): StatusKnown {
  return { power: known.power ?? seed.power, online: known.online ?? seed.online, devices: new Set([...known.devices, ...seed.devices]) };
}

/** Only a change of state; the first reading (`prev` null) is silent. */
export function netAlert(prev: boolean | null, next: boolean, tr: Tr): StatusAlert | null {
  if (prev === null || prev === next) return null;
  return { kind: "net", icon: next ? "wifi" : "wifi-off", text: tr(next ? "Online" : "Offline"), tone: "normal" };
}

/** A Bluetooth device connecting or leaving (sysevents.rs); `categories` are Windows' device categories, such as "Audio.Headphone" or "Input.Mouse". */
export interface BluetoothEvent { name: string; connected: boolean; battery: number | null; categories: string[] }

/** First match wins, so headphones and headsets are not taken for a phone. */
const BT_ICONS: [RegExp, StatusAlert["icon"]][] = [
  [/headphone|headset/, "headphones"], [/speaker/, "speaker-hifi"], [/mouse/, "mouse"], [/keyboard/, "keyboard"],
  [/gam|joystick/, "gamepad"], [/phone/, "phone"], [/watch|wearable/, "watch"],
];

/** The icon for a device by its categories; one NotNotch does not know shows the Bluetooth mark. */
export function btIcon(categories: readonly string[]): StatusAlert["icon"] {
  const c = categories.join(" ").toLowerCase();
  return BT_ICONS.find(([re]) => re.test(c))?.[1] ?? "bluetooth";
}

/** A device without a name says nothing useful, so it does not alert. */
export function btAlert(event: BluetoothEvent, tr: Tr): StatusAlert | null {
  const name = event.name.trim();
  if (!name) return null;
  const text = !event.connected ? tr("{n} · Getrennt", { n: name }) : event.battery === null ? name : tr("{n} · {p} %", { n: name, p: event.battery });
  return { kind: "bt", icon: btIcon(event.categories), text, tone: "normal" };
}

/** A volume or brightness reading from sysevents.rs and brightness.rs, which already drop repeats, NotNotch's own changes and the start. */
export interface LevelEvent { kind: "volume" | "brightness"; level: number; muted: boolean }

/** The HUD: the icon follows the level (half way splits low and high), the bar shows it, the text says the percent or that it is muted. */
export function levelAlert(e: LevelEvent, tr: Tr): StatusAlert {
  const p = Math.round(Math.min(100, Math.max(0, e.level)));
  if (e.kind === "brightness") return { kind: "brightness", icon: p < 50 ? "sun-dim" : "sun", text: tr("{p} %", { p }), tone: "normal", level: p };
  const icon = e.muted ? "speaker-x" : p === 0 ? "speaker-none" : p < 50 ? "speaker-low" : "speaker-high";
  return { kind: "volume", icon, text: e.muted ? tr("Stummgeschaltet") : tr("{p} %", { p }), tone: "normal", level: p };
}

/** A Caps Lock or Num Lock toggle from sysevents.rs, which sends only changes, never the state at start. */
export interface LockEvent { key: "caps" | "num"; on: boolean }

export function lockAlert(e: LockEvent, tr: Tr): StatusAlert {
  const text = e.key === "caps" ? tr(e.on ? "Feststelltaste an" : "Feststelltaste aus") : tr(e.on ? "Num-Taste an" : "Num-Taste aus");
  return { kind: "lock", icon: e.key === "caps" ? "caps-lock" : "num-lock", text, tone: "normal" };
}

/**
 * Whether the Windows indicator is hidden: only while NotNotch's HUD stands in for both volume and brightness (Windows draws them in
 * one flyout) and can show, so not in focus mode nor over a fullscreen app, where status alerts are dropped.
 */
export function osdHidden(alerts: { volume: boolean; brightness: boolean; hideOsd: boolean }, focus: boolean, fullscreen: boolean): boolean {
  return alerts.hideOsd && alerts.volume && alerts.brightness && !focus && !fullscreen;
}
