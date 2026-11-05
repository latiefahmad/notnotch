import { useEffect } from "react";
import { createStore } from "../../lib/store";
import { rowVisible } from "../../notch/row/visibility";
import { fetchSystem, type GpuReading, type ProcReading, type SystemStats, type SystemWant } from "../../platform/services";
import { settings } from "../../settings/store";
import { fullscreen, gamingLive } from "./gaming";
import { buildBattery, discharge, type BatterySample } from "./battery";
import { pickGpu } from "./levels";
import { resolvePower, type PowerSample } from "./power";
import { SteadyRanking } from "./ranking";
import { netRates, type NetSample } from "./rates";
import { groupDrives, type Drive } from "./storage";
import { plausible, SteadyZones } from "./temps";

/** 60 values = one minute of history at one value per second. */
export const HISTORY = 60;

export type SystemKey = "cpu" | "mem" | "gpu" | "ping" | "down" | "up" | "power";

export interface SystemState {
  stats: SystemStats | null;
  history: Record<SystemKey, number[]>;
  /** Counts polls (restarts the history's glide animation). */
  tick: number;
  /** The adapter shown (settings.system.gpu, else the one with most VRAM). */
  gpu: GpuReading | null;
  /** Bytes per second. */
  net: { down: number; up: number } | null;
  /** CPU from a thermal zone that moves (frozen-sensor guard), GPU of the adapter shown; °C. */
  cpuTemp: number | null;
  gpuTemp: number | null;
  /** The program a temperature came from (HWiNFO, LibreHardwareMonitor); null for Windows' own sensors. */
  cpuTempFrom: string | null;
  gpuTempFrom: string | null;
  power: PowerSample | null;
  battery: BatterySample | null;
  drives: Drive[];
  /** Ranked steadily; only while the tool is shown. */
  processes: { cpu: ProcReading[]; mem: ProcReading[] } | null;
}

const emptyHistory = (): Record<SystemKey, number[]> => ({ cpu: [], mem: [], gpu: [], ping: [], down: [], up: [], power: [] });

/**
 * Runs in the background from app start (not only while the tool is open), so the
 * history is a minute long when opened and gaming mode shares the same values.
 * Only pauses when neither the Hardware tool, gaming mode nor readings in the closed row are on.
 *
 * Three rhythms, slow ones filled in linearly so the history keeps one value per second:
 * - shown (Hardware tool open): everything once a second;
 * - GPU reading in the closed row (or gaming there): CPU, RAM and GPU every 2 s, without waking the ping;
 * - background: CPU and RAM every 3 s; GPU and ping stay gaps (their counters are the expensive part).
 * The closed row's opt-in readings (network, power, battery, temperature) ride on the 2 s / 3 s rhythms, and only
 * the ones switched on are read.
 */
export const system = createStore<SystemState>({
  stats: null,
  history: emptyHistory(),
  tick: 0,
  gpu: null,
  net: null,
  cpuTemp: null,
  gpuTemp: null,
  cpuTempFrom: null,
  gpuTempFrom: null,
  power: null,
  battery: null,
  drives: [],
  processes: null,
});

const SHOWN_MS = 1000;
const GPU_MS = 2000;
const BACKGROUND_MS = 3000;

let timer: ReturnType<typeof setInterval> | null = null;
/** Mounted views that show the values (see `useSystemShown`). */
const shown = createStore(0);
/** The pointer is over the process list: rows keep their rank. */
export const holdProcesses = createStore(false);

/** When the last answer came (performance.now()), so the history gains one value per second that really passed. */
let lastAnswer: number | null = null;
let lastNet: NetSample | null = null;
let lastProcesses: number | null = null;
const zones = new SteadyZones();
const byCpu = SteadyRanking.cpu(), byMem = SteadyRanking.memory();

/** What the closed row reads besides CPU, RAM and GPU. */
function rowWant(): SystemWant {
  const s = settings.get(), on = s.closed.parts.readings && rowVisible.get(), r = s.closed.readings;
  return { net: on && r.net, temps: on && r.temp, power: on && r.power, battery: on && (r.battery || r.power) };
}

function poll(ms: number) {
  const full = ms === SHOWN_MS, gpuRhythm = ms === GPU_MS;
  const want = full ? { net: true, temps: true, power: true, battery: true } : rowWant();
  void fetchSystem(full, gpuRhythm, want).then((raw) => {
    // Seconds since the last answer, at most one poll's worth: a rhythm switch right after an answer adds nothing, a long pause no more than one poll.
    const at = performance.now(), steps = lastAnswer === null ? 1 : Math.min(ms / SHOWN_MS, Math.round((at - lastAnswer) / SHOWN_MS));
    lastAnswer = at;
    const { gpu: name, gpuIndex } = settings.get().system;
    const gpu = pickGpu(raw.gpus ?? [], { name, index: gpuIndex }, system.get().gpu?.key ?? null);
    const counted = gpu?.usage != null;
    // The chosen adapter stands in the classic fields, so gaming and the closed row show the same one.
    const next: SystemStats = gpu ? { ...raw, gpu: gpu.usage, gpuName: gpu.name, gpuMemUsed: gpu.memUsed, gpuMemTotal: gpu.memTotal } : raw;

    const netSample: NetSample = { at: raw.at, net: raw.net };
    const net = want.net ? netRates(lastNet, netSample) : null;
    lastNet = want.net ? netSample : null;
    const zone = want.temps ? (zones.choose(raw.zones, raw.at / 1000)?.celsius ?? null) : null;
    const same = (n: { name: string }) => gpu != null && n.name !== "" && (n.name.includes(gpu.name) || gpu.name.includes(n.name));
    const nv = raw.nvml.find(same);
    // HWiNFO or LibreHardwareMonitor, while one runs, before Windows' own sensors.
    const ext = raw.external, extGpu = ext?.gpus.find(same);
    const extCpuTemp = want.temps ? plausible(ext?.cpuTemp) : null, extGpuTemp = want.temps ? plausible(extGpu?.temp) : null;
    const cpuTemp = extCpuTemp ?? zone;
    const gpuTemp = want.temps ? (extGpuTemp ?? plausible(gpu?.temp ?? nv?.temp ?? null)) : null;
    const battery = want.battery ? buildBattery(raw.battery) : null;
    const power = want.power ? resolvePower({ energy: raw.energy, meter: raw.meter, battery: discharge(battery, raw.battery?.ac ?? null), gpus: raw.nvml.map((n) => n.watts), external: ext && { source: ext.source, cpu: ext.cpuWatts, gpu: extGpu?.watts ?? null } }) : null;

    let processes: SystemState["processes"] = null;
    if (raw.processes) {
      const elapsed = lastProcesses === null ? 0 : (at - lastProcesses) / 1000;
      lastProcesses = at;
      const hold = holdProcesses.get();
      processes = { cpu: byCpu.arrange(raw.processes, (p) => p.cpu, elapsed, hold), mem: byMem.arrange(raw.processes, (p) => p.mem, elapsed, hold) };
    } else lastProcesses = null;

    system.set((cur) => {
      const { stats, history: h, tick } = cur;
      const mem = (next.memUsed / next.memTotal) * 100;
      // Linear from the previous value, so a slow poll still adds one value per second.
      const fill = (prev: number[], v: number) => {
        const from = prev.at(-1);
        if (steps === 1 || from === undefined || Number.isNaN(from)) return Array<number>(steps).fill(v);
        return Array.from({ length: steps }, (_, i) => from + ((v - from) * (i + 1)) / steps);
      };
      const push = (prev: number[], values: number[]) => [...prev, ...values].slice(-HISTORY);
      const gaps = Array<number>(steps).fill(Number.NaN);
      const add = (prev: number[], v: number | null | undefined, read: boolean) => push(prev, read ? fill(prev, v ?? Number.NaN) : gaps);
      // Another adapter shown (picked, or automatic moved on): its line starts fresh rather than continuing the other's.
      const gpuHistory = counted && cur.gpu && gpu && cur.gpu.key !== gpu.key ? [] : h.gpu;
      return {
        // Slower rhythms: keep the last numbers they skip for the first frame when opened.
        stats: full || !stats ? next : counted ? { ...next, ping: stats.ping } : { ...next, gpu: stats.gpu, gpuMemUsed: stats.gpuMemUsed, ping: stats.ping },
        tick: steps > 0 ? tick + 1 : tick,
        gpu: counted || !cur.gpu ? gpu : cur.gpu,
        net: want.net ? (net ?? cur.net) : null,
        cpuTemp,
        gpuTemp,
        cpuTempFrom: ext && extCpuTemp !== null ? ext.source : null,
        gpuTempFrom: ext && extGpuTemp !== null ? ext.source : null,
        power,
        battery,
        drives: raw.drives ? groupDrives(raw.drives) : cur.drives,
        processes,
        history: {
          cpu: push(h.cpu, fill(h.cpu, next.cpu)),
          mem: push(h.mem, fill(h.mem, mem)),
          gpu: add(gpuHistory, next.gpu, counted),
          ping: push(h.ping, full ? Array<number>(steps).fill(next.ping ?? Number.NaN) : gaps),
          down: add(h.down, net?.down, want.net),
          up: add(h.up, net?.up, want.net),
          power: add(h.power, power?.watts, want.power),
        },
      };
    });
  }).catch(() => {
    // A failed read (the probe busy or gone for a moment) skips this poll; the next one tries again.
  });
}

function wanted(): boolean {
  const s = settings.get();
  return s.tools.some((x) => x.id === "system" && x.enabled) || s.gaming.mode !== "off" || (s.closed.parts.readings && rowVisible.get());
}

function rhythm(): number {
  if (shown.get() > 0) return SHOWN_MS;
  const s = settings.get();
  // Gaming puts the GPU in the row even with the readings part off.
  const gpu = rowVisible.get() && ((s.closed.parts.readings && s.closed.readings.gpu) || gamingLive(s.gaming.mode, fullscreen.get()));
  return gpu ? GPU_MS : BACKGROUND_MS;
}

/** Rhythm and the closed row's extras: a change of either restarts polling at once. */
let applied = "";

function apply() {
  if (!wanted()) {
    if (timer) clearInterval(timer);
    timer = null;
    applied = "";
    return;
  }
  const ms = rhythm();
  const key = `${ms}|${Object.values(rowWant()).join()}|${settings.get().system.gpu}#${settings.get().system.gpuIndex}`;
  if (timer && applied === key) return;
  if (timer) clearInterval(timer);
  // Switching rhythm: fresh values right away, not after the next tick.
  poll(ms);
  timer = setInterval(() => poll(ms), ms);
  applied = key;
}

export function startSystemPolling() {
  apply();
  settings.subscribe(apply);
  shown.subscribe(apply);
  rowVisible.subscribe(apply);
  fullscreen.subscribe(apply);
}

/** For views that show the values: full polling once a second while mounted. */
export function useSystemShown() {
  useEffect(() => {
    shown.set((n) => n + 1);
    return () => shown.set((n) => n - 1);
  }, []);
}
