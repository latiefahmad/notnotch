// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/HotkeyText.cs.
// Global shortcuts as saved text: modifiers in the fixed order Ctrl+Alt+Shift+Win, then the key as KeyboardEvent.code
// ("KeyK", "Digit1", "F9", "Space"), joined by "+". The resize shortcut is its modifiers and "Arrows": the four arrow keys.
// Pure (no DOM): parsing, recording from a key event, labels and conflicts. src-tauri/src/shell.rs registers them.

export type HotkeyKind = "open" | "hide" | "resize" | "find";
export const HOTKEY_KINDS: HotkeyKind[] = ["open", "hide", "resize", "find"];

const MODS = ["Ctrl", "Alt", "Shift", "Win"] as const;
export type Mod = (typeof MODS)[number];

export const ARROWS = "Arrows";
const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/** Keys the shortcut plugin knows by code (global-hotkey's parse_key), apart from letters, digits, F and numpad keys. */
const NAMED = new Set([
  "Space", "Enter", "Tab", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Escape",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backquote", "Backslash", "BracketLeft", "BracketRight",
  "Comma", "Period", "Minus", "Equal", "Quote", "Semicolon", "Slash", "Pause", "PrintScreen", "ScrollLock",
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter",
]);

export interface Parsed {
  mods: Mod[];
  key: string;
}

export function isFunctionKey(code: string): boolean {
  const m = /^F([1-9]|1\d|2[0-4])$/.exec(code);
  return m !== null;
}

export function isKeyCode(code: string): boolean {
  return /^Key[A-Z]$/.test(code) || /^Digit\d$/.test(code) || /^Numpad\d$/.test(code) || isFunctionKey(code) || NAMED.has(code);
}

const modOf = (part: string): Mod | null => {
  const p = part.toLowerCase();
  if (p === "ctrl" || p === "control") return "Ctrl";
  if (p === "alt") return "Alt";
  if (p === "shift") return "Shift";
  if (p === "win" || p === "windows" || p === "super") return "Win";
  return null;
};

/** Modifiers in any order and case, one key last. Rejects repeats, empty parts and keys the plugin can't register. */
export function parse(text: string | null | undefined): Parsed | null {
  if (!text || !text.trim()) return null;
  const parts = text.split("+").map((p) => p.trim());
  const mods = new Set<Mod>();
  for (const [i, part] of parts.entries()) {
    if (!part || /\s/.test(part)) return null;
    const mod = modOf(part);
    if (i < parts.length - 1) {
      if (!mod || mods.has(mod)) return null;
      mods.add(mod);
    } else {
      if (mod || !(isKeyCode(part) || part === ARROWS)) return null;
      return { mods: MODS.filter((m) => mods.has(m)), key: part };
    }
  }
  return null;
}

export function format(p: Parsed): string {
  return [...MODS.filter((m) => p.mods.includes(m)), p.key].join("+");
}

/** A key alone only for F1 to F24; everything else needs a modifier. */
function allowedPlain(p: Parsed): boolean {
  return p.key !== ARROWS && (p.mods.length > 0 || isFunctionKey(p.key));
}

/** Alt plus at least one more: Shift and Ctrl arrows select text everywhere, Win arrows snap windows. */
export function arrowModsAllowed(mods: Mod[]): boolean {
  return mods.includes("Alt") && mods.length > 1;
}

/** The canonical text, or "" when unset or not allowed for this kind. */
export function normalize(kind: HotkeyKind, text: string | null | undefined): string {
  const p = parse(text);
  if (!p) return "";
  if (kind === "resize") return p.key === ARROWS && arrowModsAllowed(p.mods) ? format(p) : "";
  return allowedPlain(p) ? format(p) : "";
}

/** The combinations a saved text stands for: four for the resize shortcut. */
export function combinations(kind: HotkeyKind, text: string): string[] {
  const n = normalize(kind, text);
  if (!n) return [];
  if (kind !== "resize") return [n];
  const mods = parse(n)!.mods;
  return ARROW_KEYS.map((key) => format({ mods, key }));
}

/** The launcher's Alt+1.. keys for `count` favourites (at most six), in the saved spelling. */
export const launcherKeys = (count: number): string[] => Array.from({ length: Math.min(6, Math.max(0, count)) }, (_, i) => `Alt+Digit${i + 1}`);

/**
 * Which earlier shortcut each one collides with (order: open, hide, resize, find), or "launcher" for the launcher's Alt+N keys
 * (`launcher`, while they are switched on); the later one yields and is not registered. Unset or invalid shortcuts collide with nothing.
 */
export function conflicts(h: Record<HotkeyKind, string>, launcher: string[] = []): Record<HotkeyKind, HotkeyKind | "launcher" | null> {
  const out: Record<HotkeyKind, HotkeyKind | "launcher" | null> = { open: null, hide: null, resize: null, find: null };
  const taken: { kind: HotkeyKind | "launcher"; combos: string[] }[] = [{ kind: "launcher", combos: launcher }];
  for (const kind of HOTKEY_KINDS) {
    const combos = combinations(kind, h[kind]);
    const hit = taken.find((t) => t.combos.some((c) => combos.includes(c)));
    if (hit) out[kind] = hit.kind;
    else taken.push({ kind, combos });
  }
  return out;
}

export interface KeyLike {
  code: string;
  /** The character the layout gives the key (KeyboardEvent.key). */
  key?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type RecordError = "need-modifier" | "resize-modifiers" | "resize-arrow" | "unsupported-key";

/**
 * A key press while recording: the saved text, an error to show, or null while only modifiers are held.
 * For the resize shortcut any arrow key stands for all four.
 */
/** `byLayout`: the platform registers a shortcut by the key the layout puts there (Windows RegisterHotKey), so a letter is saved as
 *  the letter typed, not as its US position: Ctrl+Alt+Z on a German keyboard is KeyZ, not KeyY. A Mac registers positions. */
export function record(kind: HotkeyKind, e: KeyLike, byLayout = false): { text: string } | { error: RecordError } | null {
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code)) return null;
  const mods = MODS.filter((m) => (m === "Ctrl" ? e.ctrlKey : m === "Alt" ? e.altKey : m === "Shift" ? e.shiftKey : e.metaKey));
  if (kind === "resize") {
    if (!ARROW_KEYS.includes(e.code)) return { error: "resize-arrow" };
    if (!arrowModsAllowed(mods)) return { error: "resize-modifiers" };
    return { text: format({ mods, key: ARROWS }) };
  }
  if (!isKeyCode(e.code)) return { error: "unsupported-key" };
  const p = { mods, key: byLayout && /^[a-z]$/i.test(e.key ?? "") ? `Key${e.key!.toUpperCase()}` : e.code };
  return allowedPlain(p) ? { text: format(p) } : { error: "need-modifier" };
}

/** Keys that type a character: with AltGr they type another one on many layouts. */
const CHARACTER_KEY = /^(Key[A-Z]|Digit\d|Backquote|Backslash|BracketLeft|BracketRight|Comma|Period|Minus|Equal|Quote|Semicolon|Slash)$/;

/**
 * Ctrl+Alt with a character key and nothing else is AltGr on many layouts (Ctrl+Alt+Q types @ on German keyboards),
 * so the shortcut would swallow that character. Still allowed; the settings warn. Space, F and arrow keys type nothing.
 */
export function altGrRisk(kind: HotkeyKind, text: string): boolean {
  const p = parse(normalize(kind, text));
  if (!p || kind === "resize") return false;
  return p.mods.length === 2 && p.mods.includes("Ctrl") && p.mods.includes("Alt") && CHARACTER_KEY.test(p.key);
}

const KEY_LABELS: Record<string, string> = {
  Space: "Space", Backquote: "`", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".",
  Minus: "-", Equal: "=", Quote: "'", Semicolon: ";", Slash: "/", Escape: "Esc", ArrowLeft: "Left", ArrowRight: "Right",
  ArrowUp: "Up", ArrowDown: "Down", PageUp: "Page Up", PageDown: "Page Down", PrintScreen: "Print Screen",
  ScrollLock: "Scroll Lock", NumpadAdd: "Num +", NumpadSubtract: "Num -", NumpadMultiply: "Num *",
  NumpadDivide: "Num /", NumpadDecimal: "Num .", NumpadEnter: "Num Enter",
};

export function keyLabel(key: string, arrowsLabel = "Arrow keys"): string {
  if (key === ARROWS) return arrowsLabel;
  if (/^Key[A-Z]$/.test(key)) return key.slice(3);
  if (/^Digit\d$/.test(key)) return key.slice(5);
  if (/^Numpad\d$/.test(key)) return `Num ${key.slice(6)}`;
  return KEY_LABELS[key] ?? key;
}

/** The parts to show as keycaps, e.g. ["Ctrl", "Alt", "K"]; [] when unset. */
export function keycaps(text: string, arrowsLabel?: string): string[] {
  const p = parse(text);
  return p ? [...p.mods, keyLabel(p.key, arrowsLabel)] : [];
}

/** One line, as the tray menu shows it ("Ctrl+Alt+K"). */
export function label(text: string): string {
  return keycaps(text).join("+");
}
