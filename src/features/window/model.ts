// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/Settings.cs (window rules) and ScreenPolicy.cs (rule keys).
// The window behaviour settings group: its shape, defaults and the repair of saved values. Pure.
// The rules themselves are resolved in Rust (src-tauri/src/screen_policy.rs), which reads the same shape.

import { normalize, type HotkeyKind } from "./hotkeys.ts";
import { fitScale, normalizeSizes, type PanelScale, type Size } from "./panelSize.ts";

/** What the notch does in a context: keep its style, switch to the line, or hide. */
export type Behavior = "normal" | "line" | "hide";
export type ScreenContext = "maximized" | "borderless" | "exclusive";
export const CONTEXTS: ScreenContext[] = ["maximized", "borderless", "exclusive"];

/** One app's own answers by executable; null follows the global rule. */
export interface AppRule {
  name: string;
  path: string;
  maximized: Behavior | null;
  borderless: Behavior | null;
  exclusive: Behavior | null;
}

export type CloseDelay = "fast" | "normal" | "patient";
export const closeDelayMs: Record<CloseDelay, number> = { fast: 180, normal: 400, patient: 800 };

export interface WindowSettings {
  rules: Record<ScreenContext, Behavior> & { background: boolean };
  apps: AppRule[];
  hotkeys: Record<HotkeyKind, string>;
  /** Open size per tool id, dragged at the panel's edges; missing = the tool's default. */
  sizes: Record<string, Size>;
  scale: PanelScale;
  closeDelay: CloseDelay;
  rightClickSettings: boolean;
  wheelTools: boolean;
}

export const MAX_APP_RULES = 32;

/** What display.rs reads as `rules` (screen_policy.rs Rules). */
export type RulesPayload = WindowSettings["rules"] & { apps: AppRule[] };

export const WINDOW_DEFAULTS: WindowSettings = {
  rules: { maximized: "normal", borderless: "normal", exclusive: "normal", background: true },
  apps: [],
  hotkeys: { open: "Ctrl+Alt+Space", hide: "", resize: "", find: "Ctrl+Alt+KeyF" },
  sizes: {},
  scale: 100,
  closeDelay: "fast",
  rightClickSettings: true,
  wheelTools: true,
};

const BEHAVIORS: Behavior[] = ["normal", "line", "hide"];
const behavior = (v: unknown, fallback: Behavior): Behavior => (BEHAVIORS.includes(v as Behavior) ? (v as Behavior) : fallback);
const follow = (v: unknown): Behavior | null => (BEHAVIORS.includes(v as Behavior) ? (v as Behavior) : null);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** "C:\Games\Foo.exe" → "Foo". */
export function exeName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.exe$/i, "");
}

/** The list's identity: the path when known, the name otherwise; case and slashes don't make a second entry. */
export function ruleKey(rule: Pick<AppRule, "name" | "path">): string {
  const path = rule.path.trim().replaceAll("/", "\\").toLowerCase();
  return path ? `path:${path}` : `name:${rule.name.trim().replace(/\.exe$/i, "").toLowerCase()}`;
}

/** A new rule keeps the style everywhere: the usual reason to add an app is that it should leave NotNotch alone. */
export function newRule(name: string, path = ""): AppRule {
  return { name: name.trim().replace(/\.exe$/i, ""), path: path.trim(), maximized: "normal", borderless: "normal", exclusive: "normal" };
}

/** Adds a rule unless one for the same app exists or the list is full. */
export function addRule(apps: AppRule[], rule: AppRule): AppRule[] {
  if (!rule.name && !rule.path) return apps;
  if (apps.length >= MAX_APP_RULES || apps.some((a) => ruleKey(a) === ruleKey(rule))) return apps;
  return [...apps, rule];
}

/**
 * Saved settings repaired. Without a saved group the rules come from the old `display.visibility`:
 * "hide-fullscreen" hid borderless and exclusive full screen and left maximized windows alone.
 */
export function normalizeWindow(saved: unknown, legacyVisibility?: string): WindowSettings {
  const d = WINDOW_DEFAULTS;
  if (!saved || typeof saved !== "object") {
    const hide = legacyVisibility === "hide-fullscreen";
    // The old setting only looked at the window in front; an F11 browser behind another app didn't hide the notch.
    return { ...d, rules: { ...d.rules, borderless: hide ? "hide" : "normal", exclusive: hide ? "hide" : "normal", background: !hide } };
  }
  const s = saved as Partial<Record<keyof WindowSettings, unknown>>;
  const r = (s.rules ?? {}) as Record<string, unknown>;
  const h = (s.hotkeys ?? {}) as Record<string, unknown>;
  let apps: AppRule[] = [];
  for (const a of Array.isArray(s.apps) ? (s.apps as Record<string, unknown>[]) : []) {
    if (!a || typeof a !== "object") continue;
    const rule = { name: text(a.name), path: text(a.path), maximized: follow(a.maximized), borderless: follow(a.borderless), exclusive: follow(a.exclusive) };
    apps = addRule(apps, rule);
  }
  return {
    rules: {
      maximized: behavior(r.maximized, d.rules.maximized),
      borderless: behavior(r.borderless, d.rules.borderless),
      exclusive: behavior(r.exclusive, d.rules.exclusive),
      background: bool(r.background, d.rules.background),
    },
    apps,
    hotkeys: {
      // A saved empty text is "unset" on purpose; only a missing one takes the default.
      open: typeof h.open === "string" ? normalize("open", h.open) : d.hotkeys.open,
      hide: normalize("hide", text(h.hide)),
      resize: normalize("resize", text(h.resize)),
      find: typeof h.find === "string" ? normalize("find", h.find) : d.hotkeys.find,
    },
    sizes: normalizeSizes(s.sizes),
    scale: fitScale(s.scale),
    closeDelay: (Object.keys(closeDelayMs) as CloseDelay[]).includes(s.closeDelay as CloseDelay) ? (s.closeDelay as CloseDelay) : d.closeDelay,
    rightClickSettings: bool(s.rightClickSettings, d.rightClickSettings),
    wheelTools: bool(s.wheelTools, d.wheelTools),
  };
}

/** The tool `step` places away from `current` in the dock, wrapping; null when there is nothing to switch to. */
export function cycle(ids: string[], current: string, step: 1 | -1): string | null {
  if (ids.length < 2) return null;
  const i = ids.indexOf(current);
  if (i < 0) return ids[0];
  return ids[(i + step + ids.length) % ids.length];
}
