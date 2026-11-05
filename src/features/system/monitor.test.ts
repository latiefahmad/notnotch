import { test } from "node:test";
import assert from "node:assert/strict";
import { compactRate, compactWatts, driveSizes, duration, ghz, processMemory, processShare, rate as formatRate, watts } from "./format.ts";
import { netRates, rate } from "./rates.ts";
import { SteadyRanking } from "./ranking.ts";
import { SteadyZones, diskLevel, fromKelvin, pickZone, plausible, tempLevel } from "./temps.ts";
import { memoryLevel, nextGpu, ofRate, ofShare, pickGpu, schemeColor } from "./levels.ts";
import { fromCounters, resolvePower } from "./power.ts";
import { batteryLevel, buildBattery, discharge, healthLevel, type BatteryRaw } from "./battery.ts";
import { groupDrives } from "./storage.ts";

test("rates from cumulative counters", () => {
  assert.equal(rate(1000, 3000, 2), 1000);
  assert.equal(rate(3000, 1000, 2), null, "a counter that went backwards gives no rate");
  assert.equal(rate(0, 10, 0), null);
  assert.deepEqual(netRates({ at: 0, net: [0, 0] }, { at: 500, net: [1000, 500] }), { down: 2000, up: 1000 });
  assert.equal(netRates(null, { at: 1, net: [1, 1] }), null);
  assert.equal(netRates({ at: 0, net: [5, 5] }, { at: 1000, net: [1, 9] }), null);
  assert.equal(netRates({ at: 0, net: null }, { at: 1000, net: [1, 9] }), null);
});

test("formatting", () => {
  assert.deepEqual(formatRate(840), { n: "1", unit: "KB/s" });
  assert.deepEqual(formatRate(999_499), { n: "999", unit: "KB/s" });
  assert.deepEqual(formatRate(12_340_000), { n: "12.3", unit: "MB/s" });
  assert.deepEqual(formatRate(2.5e9), { n: "2.5", unit: "GB/s" });
  assert.equal(compactRate(84_000), "84K");
  assert.equal(compactRate(1_200_000), "1.2M");
  assert.equal(compactRate(120_000_000), "120M");
  assert.equal(compactRate(Number.NaN), "0K");
  assert.equal(watts(38.24), "38.2");
  assert.equal(watts(112.4), "112");
  assert.equal(compactWatts(8.44), "8.4");
  assert.equal(compactWatts(5000), "999");
  assert.equal(ghz(4210), "4.21");
  assert.equal(processMemory(512 * 1_048_576), "512M");
  assert.equal(processMemory(4.1 * 1024 ** 3), "4.1G");
  assert.equal(processShare(250, 16), "16", "250 % of one core on 16 threads");
  assert.equal(processShare(20, 16), "1.3");
  assert.equal(processShare(5000, 4), "100");
  assert.equal(duration(0.4), "< 1 min");
  assert.equal(duration(12), "12 min");
  assert.equal(duration(192), "3 h 12 min");
  assert.equal(duration(120), "2 h");
  assert.deepEqual(driveSizes(212 * 1024 ** 3, 477 * 1024 ** 3), { used: "212", total: "477", unit: "GB" });
  assert.deepEqual(driveSizes(400 * 1024 ** 3, 1800 * 1024 ** 3), { used: "0.4", total: "1.8", unit: "TB" });
});

test("ranking stays put for small differences and lets a spike climb", () => {
  const r = SteadyRanking.cpu();
  assert.deepEqual(r.step([{ id: "a", value: 30 }, { id: "b", value: 29 }], 1), ["a", "b"]);
  // b is now a little higher: within the margin, no swap.
  assert.deepEqual(r.step([{ id: "a", value: 29 }, { id: "b", value: 31 }], 1), ["a", "b"]);
  // b spikes: it passes at once.
  assert.deepEqual(r.step([{ id: "a", value: 29 }, { id: "b", value: 80 }], 1), ["b", "a"]);
  // b falls back to zero: its level decays, so it stays one more reading, then a passes it.
  assert.deepEqual(r.step([{ id: "a", value: 29 }, { id: "b", value: 0 }], 1), ["b", "a"]);
  let order: string[] = [];
  for (let i = 0; i < 10; i++) order = r.step([{ id: "a", value: 29 }, { id: "b", value: 0 }], 1);
  assert.deepEqual(order, ["a", "b"]);
});

test("ranking hold keeps ranks, drops leavers, appends arrivals", () => {
  const r = SteadyRanking.memory();
  r.step([{ id: "a", value: 100e6 }, { id: "b", value: 50e6 }, { id: "c", value: 10e6 }], 1);
  assert.deepEqual(r.step([{ id: "c", value: 900e6 }, { id: "a", value: 100e6 }, { id: "d", value: 999e6 }], 1, true), ["a", "c", "d"]);
  const items = [{ id: "x", v: 1 }, { id: "y", v: 5 }];
  assert.deepEqual(SteadyRanking.cpu().arrange(items, (i) => i.v, 1).map((i) => i.id), ["y", "x"]);
});

test("temperature plausibility and thresholds", () => {
  assert.equal(plausible(0), null);
  assert.equal(plausible(-273), null);
  assert.equal(plausible(130), null);
  assert.equal(plausible(45), 45);
  assert.ok(Math.abs(fromKelvin(320.15)! - 47) < 1e-9);
  assert.equal(fromKelvin(0), null);
  assert.equal(tempLevel("cpu", 84), 0);
  assert.equal(tempLevel("cpu", 85), 1);
  assert.equal(tempLevel("cpu", 95), 2);
  assert.equal(tempLevel("gpu", 80), 1);
  assert.equal(diskLevel(55, null, null), 0);
  assert.equal(diskLevel(65, null, null), 1);
  assert.equal(diskLevel(72, 70, 80), 1, "the drive's own thresholds");
  assert.equal(diskLevel(76, null, 80), 1, "warning five below critical");
  assert.equal(diskLevel(66, 70, 60), 1, "thresholds out of order are dropped");
});

test("zone pick prefers a CPU zone, then the hottest", () => {
  assert.deepEqual(pickZone(new Map([["\\_TZ.TZ00", 60], ["\\_TZ.CPUZ", 50]])), { celsius: 50, zone: "\\_TZ.CPUZ" });
  assert.deepEqual(pickZone(new Map([["\\_TZ.TZ00", 40], ["\\_TZ.TZ01", 55]])), { celsius: 55, zone: "\\_TZ.TZ01" });
  assert.equal(pickZone(new Map()), null);
});

test("frozen-sensor guard", () => {
  const z = new SteadyZones();
  const frozen: [string, number] = ["\\_TZ.FROZ", 300.95];
  assert.equal(z.choose([frozen, ["\\_TZ.REAL", 320]], 0), null, "nothing shows before it has moved");
  assert.equal(z.choose([frozen, ["\\_TZ.REAL", 320.1]], 5)?.zone, "\\_TZ.REAL");
  assert.equal(z.choose([frozen, ["\\_TZ.REAL", 320.1]], 5 + SteadyZones.STEADY_S - 1)?.zone, "\\_TZ.REAL");
  assert.equal(z.choose([frozen, ["\\_TZ.REAL", 320.1]], 5 + SteadyZones.STEADY_S), null, "steady for ten minutes: out again");
  assert.equal(z.choose([frozen, ["\\_TZ.REAL", 321]], 700)?.zone, "\\_TZ.REAL", "back once it moves");
  assert.equal(z.choose([["\\_TZ.REAL", 0]], 701), null, "0 K is no reading");
});

test("levels and schemes", () => {
  assert.equal(ofShare(69), 0);
  assert.equal(ofShare(70), 1);
  assert.equal(ofShare(90), 2);
  assert.equal(ofRate(9e6), 0);
  assert.equal(ofRate(10e6), 1);
  assert.equal(ofRate(60e6), 2);
  assert.equal(memoryLevel(50, 100, 50, 100), 0);
  assert.equal(memoryLevel(50, 100, 85, 100), 1, "commit charge alone raises it");
  assert.equal(memoryLevel(92, 100, 10, 100), 2);
  assert.equal(schemeColor("calm", 0), "var(--color-label)");
  assert.equal(schemeColor("traffic", 0), "var(--color-green)");
  assert.equal(schemeColor("accent", 2), "var(--color-red)");
});

test("GPU choice", () => {
  const auto = { name: "", index: 0 };
  const idle = [{ key: "a", name: "UHD 770", memTotal: 128, usage: null }, { key: "b", name: "GeForce RTX 4070", memTotal: 12e9, usage: null }];
  assert.equal(pickGpu(idle, auto)?.key, "b", "no load known: most VRAM");
  assert.equal(pickGpu(idle, { name: "UHD 770", index: 0 })?.key, "a");
  assert.equal(pickGpu(idle, { name: "Gone", index: 0 })?.key, "b", "a saved adapter that went away falls back");
  assert.equal(pickGpu([], auto), null);
  const busy = [{ ...idle[0], usage: 40 }, { ...idle[1], usage: 5 }];
  assert.equal(pickGpu(busy, auto)?.key, "a", "automatic: the busiest");
  assert.equal(pickGpu([{ ...busy[0], usage: 12 }, busy[1]], auto, "b")?.key, "b", "stays unless clearly busier");
  assert.equal(pickGpu([{ ...busy[0], usage: 16 }, busy[1]], auto, "b")?.key, "a");
  assert.equal(pickGpu(busy, { name: "GeForce RTX 4070", index: 0 }, "a")?.key, "b", "a picked name is kept whatever the load");
  assert.deepEqual(nextGpu(idle, idle[1]), { name: "UHD 770", index: 0 });
  assert.equal(nextGpu([idle[0]], idle[0]), null);
  const twins = [{ key: "x", name: "RTX A4000", memTotal: 16e9, usage: 0 }, { key: "y", name: "RTX A4000", memTotal: 16e9, usage: 0 }];
  assert.deepEqual(nextGpu(twins, twins[0]), { name: "RTX A4000", index: 1 }, "two identical cards cycle by index");
  assert.equal(pickGpu(twins, { name: "RTX A4000", index: 1 })?.key, "y");
  assert.deepEqual(nextGpu(twins, twins[1]), { name: "RTX A4000", index: 0 });
});

test("power source order", () => {
  assert.deepEqual(fromCounters([["RAPL_Package0_PKG", 15000], ["RAPL_Package0_PP0", 9000], ["RAPL_Package0_DRAM", 2000], ["_Total", 1]], []), { system: null, cpu: 15, memory: 2 });
  assert.equal(fromCounters([["RAPL_Package0_PSYS", 30000]], []).system, 30);
  assert.equal(fromCounters([["BATT", 5000]], [["ACPI", 42000]]).system, 42, "the ACPI meter stands for the system meter");
  const parts = { energy: [["RAPL_Package0_PKG", 20000]] as [string, number][], meter: [], battery: null, gpus: [120] };
  assert.deepEqual(resolvePower(parts), { watts: 140, source: "parts", estimate: true, cpu: 20, gpu: 120, via: null });
  assert.deepEqual(resolvePower({ ...parts, external: { source: "HWiNFO", cpu: 45, gpu: null } }), { watts: 165, source: "parts", estimate: true, cpu: 45, gpu: 120, via: "HWiNFO" }, "HWiNFO's CPU figure beats RAPL");
  assert.equal(resolvePower({ ...parts, external: { source: "HWiNFO", cpu: null, gpu: null } })?.via, null, "no figure, no credit");
  assert.equal(resolvePower({ ...parts, battery: 18 })?.source, "battery");
  assert.equal(resolvePower({ ...parts, battery: 18, meter: [["ACPI", 50000]] })?.source, "meter");
  assert.equal(resolvePower({ energy: [], meter: [], battery: 0.2, gpus: [null] }), null);
  assert.equal(resolvePower({ energy: [["RAPL_Package0_PKG", 9e9]], meter: [], battery: null, gpus: [] }), null, "a broken counter is no reading");
});

const raw = (p: Partial<BatteryRaw>): BatteryRaw => ({ status: 1, rateMw: -10000, remainingMwh: 30000, fullMwh: 60000, designMwh: 75000, ac: false, percent: 50, lifeSecs: null, saver: false, ...p });

test("battery model", () => {
  const b = buildBattery(raw({}))!;
  assert.equal(b.state, "discharging");
  assert.equal(b.percent, 50);
  assert.equal(b.left, 180);
  assert.equal(b.watts, 10);
  assert.equal(b.health, 0.8);
  assert.equal(discharge(b, false), 10);
  assert.equal(buildBattery(raw({ lifeSecs: 3600 }))!.left, 60, "Windows' own estimate first");
  const c = buildBattery(raw({ status: 3, rateMw: 30000, ac: true }))!;
  assert.equal(c.state, "charging");
  assert.equal(c.toFull, 60);
  assert.equal(discharge(c, true), null);
  assert.equal(buildBattery(raw({ status: 2, rateMw: 0, ac: true, remainingMwh: 59000 }))!.state, "full");
  assert.equal(buildBattery(raw({ status: 1, rateMw: -100, ac: true, remainingMwh: 48000 }))!.state, "plugged", "held at a charge limit");
  assert.equal(buildBattery(raw({ status: 0, percent: null })), null);
  assert.equal(buildBattery(null), null);
  assert.equal(buildBattery(raw({ rateMw: -1 }))!.left, null, "no time from an idle rate");
  assert.equal(batteryLevel(buildBattery(raw({ remainingMwh: 9000 }))), 2);
  assert.equal(batteryLevel(buildBattery(raw({ remainingMwh: 15000 }))), 1);
  assert.equal(batteryLevel(buildBattery(raw({ remainingMwh: 9000, status: 3, rateMw: 20000, ac: true }))), 0, "never low on mains");
  assert.equal(healthLevel(0.7), 1);
  assert.equal(healthLevel(null), 0);
});

test("drives: internal only, grouped by physical drive", () => {
  const gb = 1024 ** 3;
  const drives = groupDrives({
    volumes: [
      { letter: "D:", total: 500 * gb, free: 100 * gb, disk: 0 },
      { letter: "C:", total: 400 * gb, free: 200 * gb, disk: 0 },
      { letter: "E:", total: 64 * gb, free: 1 * gb, disk: 1 },
      { letter: "R:", total: 0.5 * gb, free: 0, disk: 0 },
      { letter: "S:", total: 2000 * gb, free: 0, disk: null },
    ],
    disks: [
      { number: 0, model: "Samsung 990 PRO", bus: 17, removable: false, ssd: true, temp: [45, 82, 85] },
      { number: 1, model: "USB stick", bus: 7, removable: true, ssd: true, temp: null },
    ],
  });
  assert.equal(drives.length, 2);
  assert.equal(drives[0].letters, "C: D:");
  assert.equal(drives[0].used, 600 * gb);
  assert.equal(drives[0].temp, 45);
  assert.equal(drives[0].tempLevel, 0);
  assert.equal(drives[1].letters, "S:");
  assert.equal(groupDrives(null).length, 0);
});
