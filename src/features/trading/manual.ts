import { createStore } from "../../lib/store";
import type { ManualHolding } from "./portfolio";

/** Holdings entered by hand. Local only (WebView storage), they are not secrets. */
export const manualHoldings = createStore<ManualHolding[]>([], { persist: "portfolio-manual" });

export function saveManual(h: ManualHolding) {
  manualHoldings.set((list) => (list.some((x) => x.id === h.id) ? list.map((x) => (x.id === h.id ? h : x)) : [...list, h]));
}

export function removeManual(id: string) {
  manualHoldings.set((list) => list.filter((x) => x.id !== id));
}
