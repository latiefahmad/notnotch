import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isNative } from "../native";

export type Levels = [number, number, number, number];
type Listener<T> = (levels: T) => void;

/*
 * Real levels from the Rust loopback (src-tauri/src/audio.rs): 4 bands as `audio://levels`, 12 thinner
 * ones as `audio://spectrum`. Capture only runs while at least one visible equalizer asks for either.
 *
 * Subscribers say whether they need fine Resolution (an open tool's big bars) or can live with the
 * coarse rate (the small bars in the closed notch). Rust ticks at 40 fps while any fine subscriber
 * listens and drops to 8 fps when only coarse ones remain, keeping a closed notch nearly idle.
 */
const channels = new Map<string, { listeners: Set<Listener<never>>; unlisten: Promise<() => void> }>();
let fine = 0;
let wanted = 0;

export const audioLevelsAvailable = isNative;

/** The Rust FFT tick: fine while any big, open-tool equalizer listens. */
function syncRate() {
  if (!isNative || wanted === 0) return;
  void invoke("audio_rate", { coarse: fine === 0 });
}

function subscribe<T>(event: string, listener: Listener<T>, coarse: boolean): () => void {
  if (!isNative) return () => {};
  let channel = channels.get(event);
  if (!channel) {
    const listeners = new Set<Listener<T>>();
    channel = { listeners, unlisten: listen<T>(event, (e) => listeners.forEach((l) => l(e.payload))) };
    channels.set(event, channel);
  }
  const own = channel;
  own.listeners.add(listener);
  if (!coarse) fine++;
  wanted++;
  if (wanted === 1) void invoke("audio_levels", { enabled: true });
  syncRate();
  return () => {
    own.listeners.delete(listener);
    if (own.listeners.size === 0 && channels.get(event) === own) {
      channels.delete(event);
      void own.unlisten.then((f) => f());
    }
    if (!coarse) fine--;
    wanted--;
    if (wanted === 0) void invoke("audio_levels", { enabled: false });
    else syncRate();
  };
}

/** `coarse`: the small bars in the closed notch; Rust then animates them at 8 fps instead of 40. */
export const subscribeLevels = (listener: Listener<Levels>, coarse = false) => subscribe("audio://levels", listener, coarse);
export const subscribeSpectrum = (listener: Listener<number[]>, coarse = false) => subscribe("audio://spectrum", listener, coarse);
