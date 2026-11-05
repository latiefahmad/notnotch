import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isNative } from "../native";

export type Levels = [number, number, number, number];
type Listener<T> = (levels: T) => void;

/*
 * Real levels from the Rust loopback (src-tauri/src/audio.rs): 4 bands as `audio://levels`, 12 thinner
 * ones as `audio://spectrum`. Capture only runs while at least one visible equalizer asks for either.
 */
const channels = new Map<string, { listeners: Set<Listener<never>>; unlisten: Promise<() => void> }>();
let wanted = 0;

export const audioLevelsAvailable = isNative;

function subscribe<T>(event: string, listener: Listener<T>): () => void {
  if (!isNative) return () => {};
  let channel = channels.get(event);
  if (!channel) {
    const listeners = new Set<Listener<T>>();
    channel = { listeners, unlisten: listen<T>(event, (e) => listeners.forEach((l) => l(e.payload))) };
    channels.set(event, channel);
  }
  const own = channel;
  own.listeners.add(listener);
  wanted++;
  if (wanted === 1) void invoke("audio_levels", { enabled: true });
  return () => {
    own.listeners.delete(listener);
    if (own.listeners.size === 0 && channels.get(event) === own) {
      channels.delete(event);
      void own.unlisten.then((f) => f());
    }
    wanted--;
    if (wanted === 0) void invoke("audio_levels", { enabled: false });
  };
}

export const subscribeLevels = (listener: Listener<Levels>) => subscribe("audio://levels", listener);
export const subscribeSpectrum = (listener: Listener<number[]>) => subscribe("audio://spectrum", listener);
