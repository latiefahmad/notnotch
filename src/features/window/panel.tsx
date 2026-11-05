import { useEffect, useRef } from "react";
import { createStore } from "../../lib/store";
import { holdOpen } from "../../notch/useNotchState";
import { monitor, monitorMetrics } from "../../notch/monitor";
import { settings } from "../../settings/store";
import { t } from "../../i18n";
import { dragSize, limits, sizeFor, stepSize, type Direction, type Edge, type Size } from "./panelSize";
import { updateBehavior } from "./store";

/** The size while an edge is being dragged; saved on release. */
const live = createStore<({ tabId: string } & Size) | null>(null);

/** The open size of a tool: dragging, else saved, else its default, within its limits on this monitor. */
export function useToolSize(id: string, def: Size): Size {
  const saved = settings.use().behavior.sizes[id];
  const dragging = live.use();
  monitor.use();
  if (dragging?.tabId === id) return dragging;
  return sizeFor(def, saved, monitorMetrics().height);
}

function save(id: string, size: Size | null) {
  updateBehavior((b) => {
    const sizes = { ...b.sizes };
    if (size) sizes[id] = size;
    else delete sizes[id];
    return { sizes };
  });
}

/** One press of the resize shortcut on the open tool. */
export function stepToolSize(id: string, def: Size, dir: Direction) {
  const lim = limits(def, monitorMetrics().height);
  save(id, stepSize(sizeFor(def, settings.get().behavior.sizes[id], monitorMetrics().height), dir, lim));
}

const GRIPS: { edge: Edge; className: string; cursor: string }[] = [
  { edge: "left", className: "left-0 top-9 bottom-8 w-1.5", cursor: "ew-resize" },
  { edge: "right", className: "right-0 top-9 bottom-8 w-1.5", cursor: "ew-resize" },
  { edge: "bottom", className: "bottom-0 left-8 right-8 h-1.5", cursor: "ns-resize" },
  { edge: "bottom-left", className: "bottom-0 left-0 size-5", cursor: "nesw-resize" },
  { edge: "bottom-right", className: "bottom-0 right-0 size-5", cursor: "nwse-resize" },
];

/**
 * Grips at the open panel's side and bottom edges and bottom corners: dragging sets this tool's size (both sides
 * move, the panel stays centred), a double click goes back to the default. Held open while dragging.
 */
export function ResizeHandles({ id, def, size }: { id: string; def: Size; size: Size }) {
  // Ends a drag in progress; also on unmount (tab switch, panel closed), so the hold can't stick.
  const end = useRef<(() => void) | null>(null);
  useEffect(() => () => end.current?.(), []);

  const onPointerDown = (edge: Edge) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    end.current?.();
    const el = e.currentTarget, pointer = e.pointerId;
    el.setPointerCapture(pointer);
    holdOpen(true);
    const start = size, x0 = e.clientX, y0 = e.clientY, lim = limits(def, monitorMetrics().height);
    let current = start;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      current = dragSize(start, edge, ev.clientX - x0, ev.clientY - y0, lim);
      live.set({ tabId: id, ...current });
    };
    const onUp = (ev: PointerEvent) => ev.pointerId === pointer && end.current?.();
    end.current = () => {
      end.current = null;
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("lostpointercapture", onUp);
      holdOpen(false);
      if (current !== start) save(id, current);
      live.set(null);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("lostpointercapture", onUp);
  };

  return (
    <>
      {GRIPS.map((g) => (
        <div
          key={g.edge}
          data-no-drag
          aria-hidden
          title={t("Ziehen ändert die Größe, Doppelklick setzt sie zurück")}
          className={`absolute z-10 rounded-full transition-colors duration-150 hover:bg-fill-2 ${g.className}`}
          style={{ cursor: g.cursor }}
          onPointerDown={onPointerDown(g.edge)}
          onDoubleClick={() => save(id, null)}
        />
      ))}
    </>
  );
}

/** Whether something under the pointer uses the wheel itself: a slider, a field, or a box that can scroll that way. */
export function wheelTaken(target: EventTarget | null, root: Element, dx: number, dy: number): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("[role=slider], input, textarea, select, [data-wheel]")) return true;
  const vertical = Math.abs(dy) >= Math.abs(dx);
  for (let el: Element | null = target; el && el !== root; el = el.parentElement) {
    const style = getComputedStyle(el);
    const overflow = vertical ? style.overflowY : style.overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (vertical ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1) return true;
  }
  return false;
}
