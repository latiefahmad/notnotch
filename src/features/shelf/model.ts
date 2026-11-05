/*
 * Shelf items, pure (tested in model.test.ts). Files are references to where they live;
 * text cards keep the text itself. Newest first, at most MAX_ITEMS.
 */
import type { DroppedFile } from "../../platform/services";

export interface FileItem extends DroppedFile {
  /** Missing in items saved before text cards existed. */
  type?: "file";
  addedAt: number;
}

export interface TextItem {
  type: "text";
  id: string;
  text: string;
  addedAt: number;
}

export type ShelfItem = FileItem | TextItem;

export const MAX_ITEMS = 30;
/** Longer text is cut, the shelf is for snippets (and it lives in localStorage). */
export const MAX_TEXT = 20_000;

export const isText = (i: ShelfItem): i is TextItem => i.type === "text";

/** Stable key: the path for files, the id for text. */
export const keyOf = (i: ShelfItem): string => (isText(i) ? i.id : i.path);

/** Saved list from localStorage: drops broken entries, keeps old file items as they are. */
export function normalizeItems(raw: unknown): ShelfItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((i): i is ShelfItem => {
      if (!i || typeof i !== "object") return false;
      const o = i as Record<string, unknown>;
      if (o.type === "text") return typeof o.id === "string" && typeof o.text === "string";
      return typeof o.path === "string" && typeof o.name === "string";
    })
    .slice(0, MAX_ITEMS);
}

/** New files in front; ones already on the shelf keep their place. */
export function addFiles(list: ShelfItem[], files: DroppedFile[], now: number): ShelfItem[] {
  const known = new Set(list.map(keyOf));
  const fresh = files.filter((f, i) => !known.has(f.path) && files.findIndex((g) => g.path === f.path) === i).map((f) => ({ ...f, addedAt: now }));
  return fresh.length ? [...fresh, ...list].slice(0, MAX_ITEMS) : list;
}

/** A text card in front. Blank text or the same text again changes nothing. */
export function addText(list: ShelfItem[], text: string, now: number, id: string): ShelfItem[] {
  const clean = text.replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT);
  if (!clean || list.some((i) => isText(i) && i.text === clean)) return list;
  return [{ type: "text" as const, id, text: clean, addedAt: now }, ...list].slice(0, MAX_ITEMS);
}

export function removeKeys(list: ShelfItem[], keys: Iterable<string>): ShelfItem[] {
  const drop = new Set(keys);
  return list.filter((i) => !drop.has(keyOf(i)));
}

/**
 * What a drag out carries: the files when any are picked (a text card in the same pick would
 * make drop targets choose between file and text), otherwise the texts, one blank line apart.
 */
export function dragPayload(list: ShelfItem[], keys: string[]): { paths: string[]; text: string | null } {
  const picked = list.filter((i) => keys.includes(keyOf(i)));
  const paths = picked.filter((i) => !isText(i)).map((i) => (i as FileItem).path);
  if (paths.length) return { paths, text: null };
  const texts = picked.filter(isText).map((i) => i.text);
  return { paths: [], text: texts.length ? texts.join("\n\n") : null };
}
