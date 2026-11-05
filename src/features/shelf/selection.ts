/*
 * Shelf multi-select, pure (selection.test.ts). Like Explorer: Ctrl+click toggles one card,
 * Shift+click picks the range from the anchor (the last card clicked without Shift),
 * Ctrl+Shift+click adds that range. In select mode a plain click toggles too.
 */
export interface Selection {
  keys: string[];
  anchor: string | null;
}

export const NONE: Selection = { keys: [], anchor: null };

/** `order` = keys in display order; the result keeps that order. */
export function clickSelect(sel: Selection, order: string[], key: string, mods: { toggle: boolean; range: boolean }): Selection {
  const inOrder = (set: Set<string>) => order.filter((k) => set.has(k));
  if (mods.range && sel.anchor !== null && order.includes(sel.anchor) && order.includes(key)) {
    const [a, b] = [order.indexOf(sel.anchor), order.indexOf(key)].sort((x, y) => x - y);
    const range = order.slice(a, b + 1);
    const next = new Set(mods.toggle ? [...sel.keys, ...range] : range);
    return { keys: inOrder(next), anchor: sel.anchor };
  }
  if (mods.range) return { keys: [key], anchor: key };
  const next = new Set(sel.keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return { keys: inOrder(next), anchor: key };
}

/** After items left the shelf: forget their keys. */
export function prune(sel: Selection, order: string[]): Selection {
  const keys = sel.keys.filter((k) => order.includes(k));
  const anchor = sel.anchor !== null && order.includes(sel.anchor) ? sel.anchor : null;
  return keys.length === sel.keys.length && anchor === sel.anchor ? sel : { keys, anchor };
}

/** Dragging a picked card takes the whole pick, an unpicked one only itself. */
export function dragKeys(sel: Selection, key: string): string[] {
  return sel.keys.includes(key) ? sel.keys : [key];
}
