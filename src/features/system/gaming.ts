import { useEffect } from "react";
import { createStore } from "../../lib/store";
import { display, fetchFps } from "../../platform/services";
import { settings, type Settings } from "../../settings/store";

/** Fullscreen app on the notch's monitor (from display.rs). */
export const fullscreen = createStore(false);

export function startGamingWatch() {
  display.onFullscreen((on) => fullscreen.set(on));
}

/** Gaming mode is live: always, or while an app is fullscreen. */
export const gamingLive = (mode: Settings["gaming"]["mode"], full: boolean) => mode === "on" || (mode === "fullscreen" && full);

/** Is the closed notch showing FPS and load right now? */
export function useGamingLive(): boolean {
  return gamingLive(settings.use().gaming.mode, fullscreen.use());
}

export const fps = createStore<{ value: number | null; error: string | null }>({ value: null, error: null });

/** Poll FPS once a second while mounted and `active` (the readings in the closed row during gaming). */
export function useFpsPolling(active = true) {
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () => void fetchFps().then((r) => alive && fps.set({ value: r.fps, error: r.error }));
    load();
    const id = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active]);
}
