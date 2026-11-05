// Custom parts of the closed row, set by `notnotch-notify part` (Rust checks the values first). In memory only. Pure.

/** What Rust sends on `notices://part`. */
export interface PartMessage {
  id: string;
  source: string;
  text?: string | null;
  icon?: string | null;
  progress?: number | null;
  open?: string | null;
  ttl?: number | null;
  clear: boolean;
}

export interface ScriptPart {
  id: string;
  source: string;
  text: string | null;
  icon: string | null;
  progress: number | null;
  open: string | null;
  /** Milliseconds since 1970 when it goes, null to stay until cleared. */
  expires: number | null;
  /** Last set. */
  at: number;
}

/** At most this many show; a new one beyond it replaces the one set longest ago. */
export const MAX_SCRIPT_PARTS = 4;

export const livePart = (now: number) => (p: ScriptPart) => p.expires === null || p.expires > now;

/** The list after one message: the same id updates in place, a clear removes it, expired parts go. */
export function applyPart(list: ScriptPart[], m: PartMessage, now: number): ScriptPart[] {
  const live = list.filter(livePart(now));
  if (m.clear) return live.filter((p) => p.id !== m.id);
  const part: ScriptPart = {
    id: m.id,
    source: m.source,
    text: m.text ?? null,
    icon: m.icon ?? null,
    progress: m.progress ?? null,
    open: m.open ?? null,
    expires: m.ttl ? now + m.ttl * 1000 : null,
    at: now,
  };
  if (live.some((p) => p.id === m.id)) return live.map((p) => (p.id === m.id ? part : p));
  const out = [...live, part];
  while (out.length > MAX_SCRIPT_PARTS) {
    const oldest = out.reduce((a, b) => (b.at < a.at ? b : a));
    out.splice(out.indexOf(oldest), 1);
  }
  return out;
}

/** When the next part expires, null when none does. */
export const nextExpiry = (list: ScriptPart[]): number | null =>
  list.reduce<number | null>((t, p) => (p.expires !== null && (t === null || p.expires < t) ? p.expires : t), null);
