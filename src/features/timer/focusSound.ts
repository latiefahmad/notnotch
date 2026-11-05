/*
 * Focus sounds: background noise while a focus timer runs, synthesized with Web Audio, no
 * audio files. Each sound is one looping buffer filled in code; a gain node fades it in and out.
 * The timer store drives `setFocusSound`, so the sound keeps playing when the notch closes.
 */
export type FocusSound = "off" | "white" | "pink" | "brown" | "rain" | "waves";

export const focusSounds: { value: FocusSound; label: string }[] = [
  { value: "off", label: "Aus" },
  { value: "white", label: "Weißes Rauschen" },
  { value: "pink", label: "Rosa Rauschen" },
  { value: "brown", label: "Braunes Rauschen" },
  { value: "rain", label: "Regen" },
  { value: "waves", label: "Wellen" },
];

export function normalizeFocusSound(v: unknown): FocusSound {
  return focusSounds.some((o) => o.value === v) ? (v as FocusSound) : "off";
}

/**
 * The sound to play for this timer state: only while a focus timer runs that was started in this
 * app run (`bootEndsAt` is the end the timer had when NotNotch started), and not muted.
 */
export function focusSoundFor(s: { mode: string; endsAt: number | null }, sound: FocusSound, muted: boolean, bootEndsAt: number | null): FocusSound {
  return s.mode === "focus" && s.endsAt !== null && s.endsAt !== bootEndsAt && !muted ? sound : "off";
}

const LOOP_S = 16;
/** Two swells per loop, so the loop point falls on the same spot of a swell. */
export const SWELL_S = 8;
const FADE_IN_S = 2;
const FADE_OUT_S = 3;
/** Loop end blends into its start over this long, so the loop point does not click. */
const BLEND_S = 0.5;
const TARGET_RMS = 0.15;

/** Wave swell gain at `t` seconds: a slow rise and fall between 0.15 and 1. */
export function swell(t: number): number {
  const x = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / SWELL_S);
  return 0.15 + 0.85 * x * x;
}

/** Seeded generator (mulberry32): the same loop every time. Returns values in [-1, 1). */
function noise(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** One loop of `sound` (not "off") as samples in [-1, 1], ready to play with `loop = true`. */
export function fillLoop(sound: Exclude<FocusSound, "off">, rate: number, seconds = LOOP_S): Float32Array<ArrayBuffer> {
  const n = Math.round(rate * seconds);
  const blend = Math.min(Math.round(rate * BLEND_S), n);
  const raw = new Float32Array(n + blend);
  const rand = noise(7);
  // Pink: Paul Kellet's three-pole filter on white noise. Brown: leaky integration.
  let b0 = 0, b1 = 0, b2 = 0, brown = 0;
  // Rain: one-pole low-pass at 2.5 kHz over white noise and short decaying drops.
  const lp = 1 - Math.exp((-2 * Math.PI * 2500) / rate);
  let low = 0, drop = 0;
  const dropDecay = Math.exp(-1 / (rate * 0.008));
  for (let i = 0; i < raw.length; i++) {
    const w = rand();
    if (sound === "white") raw[i] = w;
    else if (sound === "pink") {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      raw[i] = b0 + b1 + b2 + w * 0.1848;
    } else if (sound === "rain") {
      // About 30 drops a second, each with its own loudness.
      if (rand() > 1 - 60 / rate) drop = 0.6 + 0.4 * rand();
      drop *= dropDecay;
      low += lp * (w * (0.35 + drop * 2) - low);
      raw[i] = low;
    } else {
      brown = (brown + 0.02 * w) / 1.02;
      raw[i] = brown;
    }
  }
  const out = raw.slice(0, n);
  for (let i = 0; i < blend; i++) out[i] = raw[i] * (i / blend) + raw[n + i] * (1 - i / blend);
  let sum = 0;
  for (const v of out) sum += v * v;
  const scale = TARGET_RMS / Math.sqrt(sum / n || 1);
  for (let i = 0; i < n; i++) {
    const v = out[i] * scale * (sound === "waves" ? swell(i / rate) : 1);
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

let ctx: AudioContext | null = null;
const buffers = new Map<FocusSound, AudioBuffer>();
let playing: { sound: FocusSound; volume: number; src: AudioBufferSourceNode; gain: GainNode } | null = null;

/** Ramps a gain from where it is now, also in the middle of another ramp. */
function rampTo(gain: GainNode, value: number, seconds: number) {
  const now = gain.context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(value, now + seconds);
}

/** Plays `sound` at `volume` (0 to 1): fades in over 2 s; "off" or another sound fades the current one out over 3 s. */
export function setFocusSound(sound: FocusSound, volume: number) {
  if (playing?.sound === sound) {
    if (playing.volume !== volume) rampTo(playing.gain, volume, 0.2);
    playing.volume = volume;
    return;
  }
  if (playing) {
    const { src, gain } = playing;
    rampTo(gain, 0, FADE_OUT_S);
    src.onended = () => gain.disconnect();
    src.stop(gain.context.currentTime + FADE_OUT_S + 0.05);
    playing = null;
  }
  if (sound === "off") return;
  ctx ??= new AudioContext();
  void ctx.resume();
  let buffer = buffers.get(sound);
  if (!buffer) {
    buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * LOOP_S), ctx.sampleRate);
    buffer.copyToChannel(fillLoop(sound, ctx.sampleRate), 0);
    buffers.set(sound, buffer);
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(ctx.destination);
  src.start();
  rampTo(gain, volume, FADE_IN_S);
  playing = { sound, volume, src, gain };
}
