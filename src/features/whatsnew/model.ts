/** What the closed notch announces: a version the updater found, or the changes of the version just installed. */
export type WhatsNew = { kind: "available" | "updated"; version: string } | null;

/**
 * An update on offer wins (it asks for a click), unless its version was waved away; otherwise the newest version
 * not seen since the last update. A fresh install has nothing unseen (src/lib/changelog.ts), and the Store build
 * never finds an update itself.
 */
export function whatsNew(p: { available: string | null; dismissed: string | null; unseen: string | null }): WhatsNew {
  if (p.available && p.available !== p.dismissed) return { kind: "available", version: p.available };
  if (p.unseen) return { kind: "updated", version: p.unseen };
  return null;
}
