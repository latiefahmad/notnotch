import { media } from "../../platform/media";
import { settings, updateSettings, type Settings } from "../../settings/store";

/** Sends the pinned player to Rust on start and on every change. */
export function startMusic() {
  let last: string | null | undefined;
  const sync = () => {
    const pinned = settings.get().music.pinned;
    if (pinned === last) return;
    last = pinned;
    media.pin(pinned);
  };
  sync();
  settings.subscribe(sync);
}

export const setMusic = (patch: Partial<Settings["music"]>) => updateSettings((s) => ({ music: { ...s.music, ...patch } }));
