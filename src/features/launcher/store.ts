import { useEffect } from "react";
import { createStore } from "../../lib/store";
import { launcher } from "../../platform/services";
import { settings, updateSettings } from "../../settings/store";
import { fullscreen } from "../system/gaming";
import { t } from "../../i18n";
import { detectAi, mergeApps, type LauncherApp } from "./apps";
import { hotkeysPaused, shortcutIds } from "./shortcuts";

/** The merged app list; null until it was read once (on first open of the tool). */
export const launcherApps = createStore<{ apps: LauncherApp[] | null; loading: boolean; failed: boolean }>({ apps: null, loading: false, failed: false });

/** Icons by id (PNG data URL, null = none). Rust caches them too. */
export const launcherIcons = createStore<Record<string, string | null>>({});

/** Rust's answer to the last key registration: which slots Windows gave. */
export const shortcutResult = createStore<{ ids: string[]; ok: boolean[] } | null>(null);

/** Alt+N is switched on but rests right now (fullscreen app or gaming mode). */
export const hotkeysResting = createStore(false);

/** A launch that failed, shown under the tiles for a few seconds. */
export const launchError = createStore<string | null>(null);
let errorTimer = 0;

export function showLaunchError(id: string, code: unknown) {
  const name = settings.get().launcher.favorites?.find((f) => f.id === id)?.name ?? id;
  launchError.set(t(code === "not-found" ? "{name} ist nicht mehr installiert" : "{name} startet nicht", { name }));
  window.clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => launchError.set(null), 5000);
}

let loading: Promise<void> | null = null;

export function loadApps(refresh = false): Promise<void> {
  if (loading) return loading;
  if (launcherApps.get().apps && !refresh) return Promise.resolve();
  launcherApps.set((s) => ({ ...s, loading: true }));
  loading = launcher
    .apps(refresh)
    .then((raw) => {
      const apps = mergeApps(raw);
      launcherApps.set({ apps, loading: false, failed: false });
      // First list ever: pin the AI apps found. An empty list is a failed read, not "nothing installed".
      if (settings.get().launcher.favorites === null && raw.length > 0) {
        updateSettings((s) => ({ launcher: { ...s.launcher, favorites: detectAi(apps).map((a) => ({ id: a.id, name: a.name })) } }));
      }
    })
    .catch(() => launcherApps.set((s) => ({ ...s, loading: false, failed: true })))
    .finally(() => (loading = null));
  return loading;
}

/** Fetches the icons of these ids that are not known yet. */
export function useIcons(ids: string[]) {
  const key = ids.join("\n");
  useEffect(() => {
    const known = launcherIcons.get();
    const missing = ids.filter((id) => !(id in known));
    if (!missing.length) return;
    void launcher.icons(missing).then((icons) => launcherIcons.set((s) => ({ ...s, ...icons })), () => {});
  }, [key]);
  return launcherIcons.use();
}

let lastKeys: string | null = null;

/** Keeps Alt+1..6 registered for the first six favourites while opted in, the tool is on, and no fullscreen app or gaming mode needs the keys. */
function syncShortcuts() {
  const s = settings.get();
  const toolOn = s.tools.some((x) => x.id === "launcher" && x.enabled);
  const resting = s.launcher.hotkeys && toolOn && hotkeysPaused(s.gaming.mode, fullscreen.get());
  if (resting !== hotkeysResting.get()) hotkeysResting.set(resting);
  const ids = shortcutIds(s.launcher.favorites ?? [], s.launcher.hotkeys && toolOn && !resting);
  const key = ids.join("\n");
  if (key === lastKeys) return;
  lastKeys = key;
  void launcher.shortcuts(ids).then((ok) => {
    if (lastKeys === key) shortcutResult.set({ ids, ok });
  }, () => {});
}

export function startLauncher() {
  syncShortcuts();
  settings.subscribe(syncShortcuts);
  fullscreen.subscribe(syncShortcuts);
  // A hotkey whose app is gone: Rust opens the notch on this tool, the message says why.
  launcher.onMissing((id) => showLaunchError(id, "not-found"));
}
