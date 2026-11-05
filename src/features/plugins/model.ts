// Widget plugins: the manifest as Rust checked it, and the checks on every message a plugin page sends (docs/plugins.md). Pure.

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  /** One of ICON_NAMES. */
  icon: string;
  entry: string;
  size: { w: number; h: number };
  permissions: { network: string[]; storage: boolean; notices: boolean };
}

/** The API version a page talks (`notnotch: 1` in every message). */
export const API = 1;
/** Where the notch webview loads plugin pages from (src-tauri/src/plugins.rs; also frame-src in tauri.conf.json). */
export const PLUGIN_ORIGIN = "http://notnotchplugin.localhost";
export const pageUrl = (m: PluginManifest) => `${PLUGIN_ORIGIN}/${m.id}/${m.entry}`;

/** Plugins are tools with this prefix in the tool list. */
export const toolId = (id: string) => `plugin:${id}`;
export const pluginOf = (tool: string): string | null => (tool.startsWith("plugin:") ? tool.slice(7) : null);

/** Icons a plugin or a notnotch-notify part may name (the same list as ICONS in src-tauri/src/notify_wire.rs). */
export const ICON_NAMES = [
  "puzzle", "star", "heart", "bell", "clock", "timer", "calendar", "cloud", "sun", "moon", "chart", "code", "terminal", "music", "book",
  "quote", "globe", "rocket", "lightning", "check", "warning", "flag", "fire", "coffee", "game", "build", "bug", "branch", "download",
  "upload", "cpu", "battery", "wifi", "money", "cart", "mail", "chat", "user", "home", "leaf",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** The open panel's size bounds for a plugin, header and dock included (as in the manifest check). */
export const SIZE = { minW: 320, maxW: 740, minH: 160, maxH: 540 } as const;

export function clampSize(w: number, h: number): { w: number; h: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  return { w: clamp(w, SIZE.minW, SIZE.maxW), h: clamp(h, SIZE.minH, SIZE.maxH) };
}

export type ReqId = number | string;

export type PluginRequest =
  | { type: "hello" }
  | { type: "theme" }
  | { type: "storage.keys" }
  | { type: "storage.get"; key: string }
  | { type: "storage.remove"; key: string }
  | { type: "storage.set"; key: string; value: unknown }
  | { type: "fetch"; url: string; method?: string; headers?: Record<string, string>; body?: string }
  | { type: "notify"; title: string; body?: string }
  | { type: "resize"; w: number; h: number };

/** `ignore`: not a NotNotch message, or one without an id to answer; `error`: answered with the code. */
export type Parsed = { kind: "ignore" } | { kind: "error"; id: ReqId; error: string } | { kind: "ok"; id: ReqId; req: PluginRequest };

const MAX_VALUE = 32 * 1024;
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const str = (max: number, min = 0) => (v: unknown) => typeof v === "string" && v.length >= min && v.length <= max;
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const key = str(128, 1);
const json = (v: unknown) => {
  try {
    const s = JSON.stringify(v);
    return s !== undefined && s.length <= MAX_VALUE;
  } catch {
    return false;
  }
};
const headers = (v: unknown) => isPlain(v) && Object.keys(v).length <= 16 && Object.values(v).every(str(2048));
const method = (v: unknown) => typeof v === "string" && METHODS.includes(v);

type Check = (v: unknown) => boolean;
/** Per type: its fields, each with its check and whether it must be there. Anything else in a message refuses it. */
const SPEC: Record<PluginRequest["type"], Record<string, [Check, boolean]>> = {
  hello: {},
  theme: {},
  "storage.keys": {},
  "storage.get": { key: [key, true] },
  "storage.remove": { key: [key, true] },
  "storage.set": { key: [key, true], value: [json, true] },
  fetch: { url: [str(2048, 1), true], method: [method, false], headers: [headers, false], body: [str(64 * 1024), false] },
  notify: { title: [str(80, 1), true], body: [str(300), false] },
  resize: { w: [finite, true], h: [finite, true] },
};

/** Checks one message from a plugin page. The caller has already checked it came from that plugin's frame. */
export function parseRequest(data: unknown): Parsed {
  if (!isPlain(data) || data.notnotch !== API) return { kind: "ignore" };
  const { notnotch: _api, id, type, ...rest } = data;
  const idOk = (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) || (typeof id === "string" && id.length > 0 && id.length <= 64);
  if (!idOk) return { kind: "ignore" };
  if (typeof type !== "string" || !Object.hasOwn(SPEC, type)) return { kind: "error", id, error: "unknown-type" };
  const spec = SPEC[type as PluginRequest["type"]];
  if (Object.keys(rest).some((k) => !Object.hasOwn(spec, k))) return { kind: "error", id, error: "bad-field" };
  for (const [k, [check, required]] of Object.entries(spec)) {
    const v = rest[k];
    if (v === undefined ? required : !check(v)) return { kind: "error", id, error: "bad-field" };
  }
  const req = { type, ...rest } as PluginRequest;
  // Only plain JSON is stored, whatever structured clone carried.
  if (req.type === "storage.set") req.value = JSON.parse(JSON.stringify(req.value));
  return { kind: "ok", id, req };
}

/** Whether the manifest grants what the request needs. */
export function permitted(req: PluginRequest, m: PluginManifest): boolean {
  if (req.type.startsWith("storage.")) return m.permissions.storage;
  if (req.type === "fetch") return m.permissions.network.length > 0;
  if (req.type === "notify") return m.permissions.notices;
  return true;
}

/** Notices a plugin may show: at most NOTICE_MAX in NOTICE_WINDOW_MS. `times` is the plugin's own list. */
export const NOTICE_MAX = 3;
export const NOTICE_WINDOW_MS = 60_000;
export function allowNotice(times: number[], now: number): boolean {
  while (times.length && now - times[0] >= NOTICE_WINDOW_MS) times.shift();
  if (times.length >= NOTICE_MAX) return false;
  times.push(now);
  return true;
}

/** Text from a plugin shown in NotNotch: no control characters or direction overrides. */
export const plainText = (s: string) => s.replace(/[\p{Cc}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu, " ").replace(/\s+/g, " ").trim();
