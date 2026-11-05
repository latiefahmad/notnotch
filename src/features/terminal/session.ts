import type { ITheme, Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { createStore } from "../../lib/store";
import { terminal as pty, type TerminalMessage } from "../../platform/services";
import { settings } from "../../settings/store";
import { t } from "../../i18n";
import { launchPlan, type ShellInfo } from "./shell";
import { createResizer } from "./resize";

/*
 * One terminal for the app's lifetime: the xterm instance and its scrollback stay
 * while the notch is closed, and its host element moves into the view when it opens.
 * The shell starts on the first open and keeps running until it exits, the user
 * starts a new one, the tool is turned off, or (setting) the notch closes.
 */

export type SessionState = "idle" | "starting" | "running" | "exited";
export const sessionState = createStore<SessionState>("idle");

/** Notch colors: transparent over the panel, the system palette for ANSI colors. */
const theme: ITheme = {
  background: "rgba(0, 0, 0, 0)",
  foreground: "rgba(255, 255, 255, 0.92)",
  cursor: "rgba(255, 255, 255, 0.9)",
  cursorAccent: "#000000",
  selectionBackground: "rgba(255, 255, 255, 0.24)",
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.12)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.2)",
  scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.28)",
  black: "#1c1c1e",
  red: "#ff453a",
  green: "#30d158",
  yellow: "#ffd60a",
  blue: "#419cff",
  magenta: "#bf5af2",
  cyan: "#64d2ff",
  white: "#d1d1d6",
  brightBlack: "#636366",
  brightRed: "#ff6961",
  brightGreen: "#4ae37a",
  brightYellow: "#ffe45c",
  brightBlue: "#70b5ff",
  brightMagenta: "#da8fff",
  brightCyan: "#8ee2ff",
  brightWhite: "#ffffff",
};

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let host: HTMLDivElement | null = null;
let opened = false;
/** Bumped per session, so messages from a replaced one are dropped. */
let generation = 0;
let info: Promise<ShellInfo> | null = null;
let watching = false;

const resizer = createResizer((cols, rows) => pty.resize(cols, rows));

/** xterm loads on first use, so it costs nothing for people who never open the terminal. */
let loading: Promise<void> | null = null;

async function ensureTerminal(): Promise<{ term: Terminal; fit: FitAddon; host: HTMLDivElement }> {
  loading ??= load();
  await loading;
  return { term: term!, fit: fit!, host: host! };
}

async function load() {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);
  host = document.createElement("div");
  host.className = "h-full w-full";
  term = new Terminal({
    allowTransparency: true,
    theme,
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
    fontSize: settings.get().terminal.fontSize,
    scrollback: 5000,
    cursorStyle: "bar",
    // Blinking would keep a timer running while the notch sits open and idle.
    cursorBlink: false,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.onData((data) => {
    if (sessionState.get() === "exited") {
      if (data === "\r") void start();
      return;
    }
    // Typed while the shell starts: held and sent once it runs.
    if (sessionState.get() === "starting") unsent += data;
    else if (sessionState.get() === "running") void send(data);
  });
  term.onResize(({ cols, rows }) => resizer.push(cols, rows));
  term.attachCustomKeyEventHandler(onKey);
  // Right click like Windows Terminal: copy the selection, otherwise paste.
  host.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (term?.hasSelection()) copySelection();
    else void pty.clipboardText().then((text) => text && term?.paste(text));
  });
}

/** One write in flight at a time: keystrokes keep their order, and what piles up meanwhile goes as one write. */
let unsent = "";
let sending = false;
async function send(data: string) {
  unsent += data;
  if (sending) return;
  sending = true;
  while (unsent) {
    const chunk = unsent;
    unsent = "";
    await pty.write(chunk);
  }
  sending = false;
}

/** Ctrl+C copies only while text is selected, otherwise it reaches the shell. */
function onKey(e: KeyboardEvent): boolean {
  if (e.type !== "keydown" || !e.ctrlKey || e.altKey || e.metaKey) return true;
  const k = e.key.toLowerCase();
  if (k === "c" && (e.shiftKey || term?.hasSelection())) {
    e.preventDefault();
    copySelection();
    return false;
  }
  // Not handled by xterm: the browser fires its native paste event, which xterm pastes (bracketed).
  if (k === "v") return false;
  return true;
}

function copySelection() {
  const text = term?.getSelection();
  if (text) void navigator.clipboard.writeText(text);
  term?.clearSelection();
}

/** Puts the terminal into `container` and starts the shell if none runs. Resolves to the detach function. */
export async function attachTerminal(container: HTMLElement): Promise<() => void> {
  const { term, fit, host } = await ensureTerminal();
  container.appendChild(host);
  // xterm measures its font on open, so it opens once it is in the document.
  if (!opened) {
    term.open(host);
    opened = true;
  }
  fit.fit();
  const ro = new ResizeObserver(() => fit.fit());
  ro.observe(container);
  const offFont = settings.subscribe(() => {
    const size = settings.get().terminal.fontSize;
    if (term.options.fontSize !== size) {
      term.options.fontSize = size;
      fit.fit();
    }
  });
  if (sessionState.get() === "idle") void start();
  term.focus();
  return () => {
    ro.disconnect();
    offFont();
    resizer.flush();
    // Blur first: a focused textarea holds the notch open, and removal alone does not always fire focusout.
    term.blur();
    // A newer view may already hold the host (quick close and reopen).
    if (host.parentElement === container) host.remove();
  };
}

export function focusTerminal() {
  term?.focus();
}

/** A command asked for before the shell ran (runInTerminal): sent once it does, even if a start was replaced meanwhile. */
let pending = "";

/** Types `command` and Enter into the shell, starting one if none runs. The caller opens the Terminal tool to show it. */
export function runInTerminal(command: string) {
  // Enter as the shell gets it from a key press (a CR typed into a template literal would turn into LF).
  const line = command + "\r";
  const state = sessionState.get();
  if (state === "running") return void send(line);
  // A second click before the shell runs would type it twice.
  if (!pending.includes(line)) pending += line;
  if (state !== "starting") void start();
}

/** Starts a new shell, replacing a running one. */
export async function start() {
  const { term } = await ensureTerminal();
  const id = ++generation;
  unsent = "";
  sessionState.set("starting");
  watchTool();
  try {
    info ??= pty.info();
    const shells = await info;
    const plan = launchPlan(settings.get().terminal, shells);
    if (id !== generation) return;
    // Lets xterm handle ConPTY's reflow and line wrapping the way this Windows build does it.
    if (shells.buildNumber) term.options.windowsPty = { backend: "conpty", buildNumber: shells.buildNumber };
    term.reset();
    resizer.reset(term.cols, term.rows);
    await pty.start(plan, term.cols, term.rows, (m) => onMessage(id, m));
    if (id === generation) {
      sessionState.set("running");
      const command = pending;
      pending = "";
      void send(command);
    }
    // Ended while it was starting (a newer start replaces it in Rust by itself).
    else if (sessionState.get() === "idle") pty.kill();
  } catch (e) {
    info = null;
    if (id !== generation) return;
    // Not typed into a shell started much later by Enter.
    pending = "";
    sessionState.set("exited");
    term.write(`\r\n\x1b[31m${t("Shell konnte nicht starten: {error}", { error: String(e) })}\x1b[0m\r\n${t("Enter versucht es noch einmal.")}\r\n`);
  }
}

function onMessage(id: number, m: TerminalMessage) {
  if (id !== generation || !term) return;
  if (m instanceof ArrayBuffer) return term.write(new Uint8Array(m));
  sessionState.set("exited");
  term.write(`\r\n\x1b[2m${t("Sitzung beendet (Code {code}). Enter startet eine neue.", { code: m.exit })}\x1b[0m\r\n`);
}

/** Ends the shell and clears the screen; the next open starts a fresh one. */
export function endSession() {
  if (sessionState.get() === "idle") return;
  pending = "";
  generation++;
  pty.kill();
  term?.reset();
  sessionState.set("idle");
}

/** Turning the tool off ends its shell, so nothing keeps running unseen. */
function watchTool() {
  if (watching) return;
  watching = true;
  settings.subscribe(() => {
    if (!settings.get().tools.some((x) => x.id === "terminal" && x.enabled)) endSession();
  });
}
