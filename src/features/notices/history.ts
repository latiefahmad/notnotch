// The notice history: newest first, bounded in count and age; a replace key updates a notice instead of adding one. Pure.

/** One notice as Rust sends it (`notices://in`), plus the id the history gives it. */
export interface Notice {
  id: string;
  source: "windows" | "cli" | "plugin";
  appId: string;
  appName: string;
  title: string;
  body: string;
  /** Data URL of the app's logo, from Windows. */
  icon?: string | null;
  /** Milliseconds since 1970. */
  at: number;
  replace?: string | null;
  /** 0 to 100. */
  progress?: number | null;
  /** notnotch-notify run */
  exitCode?: number | null;
  durationMs?: number | null;
  command?: string | null;
  /** The id Windows gave the toast: deleting the notice here removes it from the notification centre too. */
  windowsId?: number | null;
}

export const HISTORY = { max: 100, maxAgeMs: 24 * 60 * 60 * 1000 } as const;

const sameKey = (a: Notice, b: Notice) => !!a.replace && a.replace === b.replace && a.appId === b.appId;

/** Adds `n` on top. An entry with the same app and replace key goes; entries past the age or count limit go. */
export function addNotice(list: Notice[], n: Notice, now: number): Notice[] {
  const kept = list.filter((old) => !sameKey(old, n) && now - old.at < HISTORY.maxAgeMs);
  return [n, ...kept].slice(0, HISTORY.max);
}

export function removeNotice(list: Notice[], id: string): Notice[] {
  return list.filter((n) => n.id !== id);
}

/** Drops everything from one app (after it was set to hide). */
export function removeApp(list: Notice[], appId: string): Notice[] {
  const key = appId.toLowerCase();
  return list.filter((n) => n.appId.toLowerCase() !== key);
}
