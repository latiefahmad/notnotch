import { createStore } from "../../lib/store";
import { probeFiles } from "../../platform/services";
import { addFiles, addText, normalizeItems, type ShelfItem } from "./model";

/*
 * The Shelf's data, split out of ShelfView, so Capture and Downloads can add items while
 * the notch is closed without the tool's view loading into the startup bundle.
 */

export const shelf = createStore<ShelfItem[]>([], { persist: "shelf" });
shelf.set(normalizeItems);

/** Puts files at the front of the Shelf (also used by Capture for new screenshots). */
export function addToShelf(paths: string[]) {
  void probeFiles(paths).then(({ files }) => shelf.set((list) => addFiles(list, files, Date.now())));
}

/** Text cards from the paste button go over the same path as pasted text. */
export function addTextCard(text: string) {
  shelf.set((list) => addText(list, text, Date.now(), newTextId()));
}

export function newTextId() {
  return `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** A drag out of the shelf is running: its own drop overlay and drops back stay quiet. */
export const draggingOut = createStore(false);
