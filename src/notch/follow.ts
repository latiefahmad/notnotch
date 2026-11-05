// Pure rules of the Monitor setting's "Follow the cursor" and "All monitors" (no DOM, no stores); the Rust side is src-tauri/src/mirror.rs.
import { capsuleY, windowYFor } from "./capsule.ts";
import { edgeLine, type Dock } from "./edge.ts";

/** "chosen": the notch stays on the chosen monitor; "follow": it goes where the pointer is; "all": every other monitor shows a closed copy. */
export type MonitorMode = "chosen" | "follow" | "all";
export const normalizeMonitorMode = (v: unknown): MonitorMode => (v === "follow" || v === "all" ? v : "chosen");

/**
 * Where the notch goes now: the monitor Rust last reported for the pointer (follow: where it stayed; all: whose copy it is over), once the notch
 * is closed and nothing holds it (`busy`: open, peeking, dragged or recording). null = it stays on `placed`.
 */
export function followTarget(mode: MonitorMode, cursor: string | null, placed: string | null, busy: boolean, present: readonly string[]): string | null {
  if (mode === "chosen" || busy || !cursor || cursor === placed || !present.includes(cursor)) return null;
  return cursor;
}

/** A monitor's size and work area in CSS px (display.rs MonitorInfo). */
export interface Metrics { width: number; height: number; workTop: number; workHeight: number; workLeft: number; workWidth: number }
export type Style = "notch" | "capsule" | "line";

/**
 * The edge's frame line and the window top on one monitor, as display.rs places the window by (`line`, `y`): the same edge, anchor and offset
 * everywhere, but each monitor's own size and taskbar. `capsuleTop`: the capsule's saved top in CSS px; `stale` as in drag.ts applyDisplay.
 */
export function spotFor(m: Metrics, dock: Dock, style: Style, capsuleTop: number, capsuleHeight: number, stale = 1): { line: number; y: number } {
  const work = { x: m.workLeft, y: m.workTop, width: m.workWidth, height: m.workHeight };
  const line = (style === "capsule" ? 0 : edgeLine(dock.edge, dock.anchor, m.width, m.height, work)) / stale;
  const capsule = windowYFor(style, capsuleY(capsuleTop * stale, capsuleHeight, m.height), m.height, m.workTop) / stale;
  // On top the window's top is the capsule's window, or the edge of a taskbar on top the notch hangs from.
  const y = style === "capsule" ? capsule : dock.edge === "top" ? line : 0;
  return { line, y: Number.isFinite(y) ? y : 0 };
}
