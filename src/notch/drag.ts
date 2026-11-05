import { useRef, useState } from "react";
import { isNative } from "../platform/native";
import { display } from "../platform/services";
import { settings, updateSettings } from "../settings/store";
import { effectiveIdleStyle } from "../features/window/store";
import { toPageCss, toSaved } from "../features/window/panelSize";
import { capsuleY, snapCapsule, windowYFor } from "./capsule";
import { across, alongOf, anchorAt, edgeLine, frameFor, nearestEdge, pointToScreen, pointerIn, span, type Dock, type Edge, type Work } from "./edge";
import { windowAlong } from "./collapsed";
import { focusMode } from "./focus";
import { spotFor } from "./follow";
import { monitorMetrics, monitors, placedMonitor, reloadMonitor } from "./monitor";
import { holdOpen, type NotchStatus } from "./useNotchState";

/** Below this distance it's a click, not a drag. */
const THRESHOLD = 6;
/** The notch snaps to the center when close to it. */
const SNAP = 24;

/** display.offset and display.y are saved at 100 % scale; the page works in CSS px of the current scale. */
const pageCss = (saved: number) => toPageCss(saved, settings.get().behavior.scale);

type Style = "notch" | "capsule" | "line";

/** The closed look on screen: the focus line overrides the idle style, a window rule may turn it into the line. */
export function shownStyle(s = settings.get()): Style {
  return focusMode.get() && s.display.focusStyle === "line" ? "line" : effectiveIdleStyle(s.display.idleStyle);
}

/** The edge in use: the notch and the line hang from the chosen one, the capsule always floats on the top frame. */
export const edgeOf = (style: Style, dock: Dock): Edge => (style === "capsule" ? "top" : dock.edge);

type Metrics = ReturnType<typeof monitorMetrics>;
const workOf = (m: Metrics): Work => ({ x: m.workLeft, y: m.workTop, width: m.workWidth, height: m.workHeight });

/** Where the frame of the notch's edge starts on its monitor (CSS px from its top or left); 0 for the capsule. */
export function dockLine(dock = settings.get().dock, style = shownStyle(), m: Metrics = monitorMetrics()): number {
  return style === "capsule" ? 0 : edgeLine(dock.edge, dock.anchor, m.width, m.height, workOf(m));
}

/** The window's top for the capsule top `y` (display.y unless given, kept on the monitor) on the notch's monitor; always finite, since Rust rejects NaN. */
export function windowY(y = pageCss(settings.get().display.y)): number {
  const s = settings.get(), m = monitorMetrics();
  const top = windowYFor(shownStyle(s), capsuleY(y, s.closedSize.capsuleHeight, m.height), m.height, m.workTop);
  return Number.isFinite(top) ? top : 0;
}

/** The window's length along its edge for the closed sizes (collapsed.ts) on the notch's monitor, in CSS px; `stale` as in applyDisplay. */
export function windowLength(dock = settings.get().dock, stale = 1): number {
  const s = settings.get(), m = monitorMetrics(), style = shownStyle(s), side = across(edgeOf(style, dock));
  return windowAlong(s.closedSize, style, side, (side ? m.height : m.width) / stale);
}

/** What Rust places the window by, beyond the saved display settings; for noticing changes. With "all" every monitor counts. */
export const placementKey = () => {
  const all = settings.get().display.monitorMode === "all" ? JSON.stringify(monitors.get()) : "";
  return `${windowY()}|${edgeOf(shownStyle(), settings.get().dock)}|${dockLine()}|${windowLength()}|${placedMonitor()}|${all}`;
};

/**
 * Sends display settings to Rust, optionally with an offset, a capsule top `y` and a dock that aren't saved yet (Rust gets the window's top from `windowY`).
 * `stale`: right after a scale change the monitor metrics are still in CSS px of the old scale; this is new scale / old scale, and the line and
 * the window top worked out from them are converted to the new one.
 */
export function applyDisplay(offset = pageCss(settings.get().display.offset), y?: number, dock = settings.get().dock, stale = 1) {
  const s = settings.get(), b = s.behavior, style = shownStyle(s), edge = edgeOf(style, dock), mode = s.display.monitorMode;
  const capsuleTop = y ?? pageCss(s.display.y), spot = (m: Metrics) => spotFor(m, dock, style, capsuleTop, s.closedSize.capsuleHeight, stale);
  const here = spot(monitorMetrics());
  // With "all" each monitor's copy hangs from that monitor's own edge and taskbar.
  const spots = mode === "all" ? monitors.get().map((m) => ({ monitor: m.name, ...spot(m) })) : [];
  display.apply({
    monitor: placedMonitor(),
    mode: mode === "chosen" ? "" : mode,
    spots,
    offset,
    y: here.y,
    gaming: s.gaming.mode !== "off",
    rules: { ...b.rules, apps: b.apps },
    zoom: b.scale / 100,
    edge,
    line: here.line,
    along: windowLength(dock, stale),
  });
}

/** The area the notch is dragged in: the monitor, in the browser the viewport with DesktopMock's 48 px taskbar. */
export function dragArea(): Metrics {
  if (isNative) return monitorMetrics();
  return { width: window.innerWidth, height: window.innerHeight, workTop: 0, workHeight: window.innerHeight - 48, workLeft: 0, workWidth: window.innerWidth };
}

/** The dock's frame line in the browser view, where the viewport stands in for the monitor. */
export const viewLine = (dock: Dock) => {
  const m = dragArea();
  return edgeLine(dock.edge, dock.anchor, m.width, m.height, workOf(m));
};

/*
 * Move the notch along its edge, the capsule anywhere: grab it anywhere when closed, by the
 * header when open. Closed, the notch and the line move to the edge nearest the pointer (with
 * hysteresis), hanging from the screen's edge over a taskbar and from the taskbar's edge elsewhere.
 * Natively the window itself moves (display.rs, clamped to the monitor), in the browser only
 * the notch inside the window. Saved on release. `shape` gives the closed shape, which the capsule snaps with.
 */
export function useDragToMove(status: NotchStatus, shape: () => { w: number; h: number }) {
  const s = settings.use(), saved = s.display, scale = s.behavior.scale;
  const [live, setLive] = useState<{ offset: number; y: number; dock: Dock } | null>(null);
  const moved = useRef(false);
  const offset = live?.offset ?? toPageCss(saved.offset, scale);
  const y = live?.y ?? toPageCss(saved.y, scale);
  const dock = live?.dock ?? s.dock;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest("button, input, textarea, a, [role=slider], [data-no-drag]")) return;
    // When open only via the header, otherwise lists and sliders would drag too.
    if (status === "open" && !target.closest("[data-drag-handle]")) return;

    const capsule = effectiveIdleStyle(saved.idleStyle) === "capsule";
    reloadMonitor();
    const { pointerId: id, screenX: x, screenY: sy } = e;
    const from = { offset, y, dock };
    let current = from;
    let frame = 0;
    moved.current = false;

    // Where the pointer is on the monitor: the notch's place on its edge plus the pointer's place in the hit zone, which hangs from the edge.
    const m0 = dragArea(), work0 = workOf(m0), edge0 = from.dock.edge;
    const hit = document.querySelector("[data-notch-hit]")?.getBoundingClientRect();
    const rel = hit ? pointerIn(edge0, hit, e.clientX, e.clientY) : { depth: 0, along: 0 };
    const grab = pointToScreen(frameFor(edge0, from.dock.anchor, m0.width, m0.height, work0), span(edge0, m0.width, m0.height) / 2 + from.offset + rel.along, rel.depth);

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      // Open, the notch only slides along its edge (by the header), so moving across neither starts a drag nor changes the edge.
      // Across is screen y on the top and bottom edges and screen x on the sides.
      const pinned = !capsule && status === "open";
      const dx = pinned && across(edge0) ? 0 : ev.screenX - x, dy = pinned && !across(edge0) ? 0 : ev.screenY - sy;
      if (!moved.current && Math.max(Math.abs(dx), Math.abs(dy)) < THRESHOLD) return;
      if (!moved.current) {
        moved.current = true;
        holdOpen(true);
      }
      const m = dragArea();
      if (capsule) {
        const size = shape(), left = m.width / 2 - size.w / 2;
        const c = snapCapsule(left + from.offset + dx, from.y + dy, size.w, size.h, m.width, m.height, { top: m.workTop, height: m.workHeight });
        current = { offset: Math.round(c.x - left), y: Math.round(c.y), dock: from.dock };
      } else {
        const p = { x: grab.x + dx, y: grab.y + dy }, work = workOf(m), open = status === "open";
        // Open, it keeps its edge and anchor: the panel would jump around the screen.
        const edge = open ? edge0 : nearestEdge(p.x, p.y, m.width, m.height, current.dock.edge);
        const anchor = anchorAt(edge, p.x, p.y, m.width, m.height, work) ?? (edge === edge0 ? from.dock.anchor : "auto");
        // On the edge it started on, the grabbed point stays under the pointer; on another, the notch's centre comes under it.
        const along = alongOf(edge, p.x, p.y) - span(edge, m.width, m.height) / 2 - (edge === edge0 ? rel.along : 0);
        current = { offset: Math.abs(along) < SNAP ? 0 : Math.round(along), y: from.y, dock: open ? from.dock : { edge, anchor } };
      }
      setLive(current);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => applyDisplay(current.offset, current.y, current.dock));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!moved.current) return;
      holdOpen(false);
      // Back to 100 % units; the notch only moves along its edge, so its y is left as saved.
      updateSettings((cur) => ({
        display: { ...cur.display, offset: toSaved(current.offset, scale), y: capsule ? toSaved(current.y, scale) : cur.display.y },
        dock: current.dock,
      }));
      setLive(null);
      // The click right after releasing shouldn't open anything.
      setTimeout(() => (moved.current = false), 0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return { offset, y, dock, dragging: live !== null, onPointerDown, moved: () => moved.current };
}
