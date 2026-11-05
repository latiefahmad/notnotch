// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/Power.cs (PowerResolver).
// The whole machine's power draw, in this order:
//   1. meter: a platform meter Windows exposes (Energy Meter channels other than RAPL, RAPL's PSYS, or the ACPI Power
//      Meter). Measured. Few machines have one.
//   2. battery: what the battery supplies while the machine runs on it, which is everything the machine draws. Measured.
//   3. parts: the CPU package (RAPL), memory where it has a meter, and NVIDIA boards (NVML). A sum of what can be read,
//      without display, drives, fans and the power supply's losses, so it is always marked as an estimate. CPU and GPU
//      figures from HWiNFO or LibreHardwareMonitor, while one runs, replace NotNotch's own.
//   4. none: no reading, and the tool hides the row.

export type PowerSource = "meter" | "battery" | "parts";
/** `via`: the program that gave the CPU or GPU figure, if one did. */
export interface PowerSample { watts: number; source: PowerSource; estimate: boolean; cpu: number | null; gpu: number | null; via: string | null }

/** A figure under this is a meter at rest or a battery at its threshold; above the ceiling a broken counter. */
export const METER_FLOOR = 1, BATTERY_FLOOR = 0.5, CEILING = 2000;
const ok = (w: number | null | undefined): w is number => w != null && Number.isFinite(w) && w >= 0 && w <= CEILING;

/**
 * Energy Meter channels (milliwatts) to watts. RAPL domains are "RAPL_Package0_PKG" (cores, graphics, uncore) and
 * "_DRAM"; PP0 and PP1 are parts of PKG and not added to it; PSYS is the whole platform. Any other channel is a
 * platform meter. The ACPI Power Meter, where present, stands for the system meter. "_Total" is skipped.
 */
export function fromCounters(energy: [string, number][], meter: [string, number][]) {
  let system: number | null = null, cpu: number | null = null, memory: number | null = null;
  const add = (acc: number | null, mw: number) => (acc ?? 0) + mw / 1000;
  for (const [name, mw] of energy) {
    if (!Number.isFinite(mw) || mw < 0 || /^_total$/i.test(name)) continue;
    if (/_PSYS$/i.test(name)) system = add(system, mw);
    else if (/^RAPL_/i.test(name)) {
      if (/_PKG$/i.test(name)) cpu = add(cpu, mw);
      else if (/_DRAM$/i.test(name)) memory = add(memory, mw);
    } else system = add(system, mw);
  }
  let acpi: number | null = null;
  for (const [name, mw] of meter) if (Number.isFinite(mw) && mw >= 0 && !/^_total$/i.test(name)) acpi = add(acpi, mw);
  return { system: acpi ?? system, cpu, memory };
}

export interface PowerInputs {
  energy: [string, number][];
  meter: [string, number][];
  /** Watts the battery supplies; null unless discharging. */
  battery: number | null;
  /** NVIDIA boards' power in watts. */
  gpus: (number | null)[];
  /** CPU package and shown GPU's watts from HWiNFO or LibreHardwareMonitor. */
  external?: { source: string; cpu: number | null; gpu: number | null } | null;
}

export function resolvePower(inputs: PowerInputs): PowerSample | null {
  const c = fromCounters(inputs.energy, inputs.meter);
  const ext = inputs.external;
  const extCpu = ext && ok(ext.cpu) ? ext.cpu : null, extGpu = ext && ok(ext.gpu) ? ext.gpu : null;
  const gpuParts = inputs.gpus.filter(ok);
  const cpu = extCpu ?? (ok(c.cpu) ? c.cpu : null);
  const gpu = extGpu ?? (gpuParts.length ? gpuParts.reduce((a, b) => a + b, 0) : null);
  const parts = { cpu, gpu, via: ext && (extCpu !== null || extGpu !== null) ? ext.source : null };
  if (ok(c.system) && c.system >= METER_FLOOR) return { watts: c.system, source: "meter", estimate: false, ...parts };
  if (ok(inputs.battery) && inputs.battery >= BATTERY_FLOOR) return { watts: inputs.battery, source: "battery", estimate: false, ...parts };
  const memory = ok(c.memory) && c.memory > 0 ? c.memory : null;
  if (cpu === null && gpu === null) return null;
  return { watts: (cpu ?? 0) + (memory ?? 0) + (gpu ?? 0), source: "parts", estimate: true, ...parts };
}
