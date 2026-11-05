import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AppWindow, ArrowDown, ArrowsDownUp, ArrowUp, BatteryHigh, CaretDown, Cpu, HardDrives, Lightning, WifiHigh, X, type Icon } from "@phosphor-icons/react";
import { GpuIcon, RamIcon } from "../../ui/icons";
import { Segmented, Select } from "../../ui/controls";
import { content, fade } from "../../design/motion";
import { t } from "../../i18n";
import { powerPlans, revealFile, systemIcon, type PowerPlans, type ProcReading } from "../../platform/services";
import { settings, updateSettings } from "../../settings/store";
import { batteryLevel, healthLevel } from "./battery";
import { compactRate, driveSizes, duration, ghz, gigabytes, processMemory, processShare, rate, watts } from "./format";
import { memoryLevel, nextGpu, ofRate, ofShare, schemeColor, type Level } from "./levels";
import { tempLevel, degrees } from "./temps";
import { HISTORY, holdProcesses, system, useSystemShown } from "./store";
import { useHue, type Hue } from "../themes/hues";

/*
 *   ┌───────────────────────────────────────────────┬──────────────────────────┐
 *   │ ▣ CPU   Ryzen 7 · 8C 16T · 4.21 GHz  ╱╲_   23%│ Processes      CPU | Mem │
 *   │   P ▂▅▂▇▂▁▃▂  E ▁▁▂▁                          │ ◧ Chrome            12.4 │
 *   │ ▤ RAM   13.4 / 32 GB                 ‾‾‾   42%│ ◧ Code               3.1 │
 *   │   ███████░░░░ cache 6.2 · commit 21 / 37 GB   │ …                        │
 *   │ ▦ GPU   RTX 4070 Ti · 3D · 54 °C     _╱╲   31%│ Drives                   │
 *   │ ⇅ Net   ↓ 12.3 MB/s ↑ 340 KB/s       ╱‾╲  12M │ C:  Samsung 990  ▓▓░ 41° │
 *   │ ϟ Power Estimate · CPU 20 W [Plan ⌄] ‾╲_  38 W│                          │
 *   │ ▭ Bat.  2 h 40 min left · 88 %             66%│                          │
 *   │ ◠ Ping  1.1.1.1                      ___ 14 ms│                          │
 *   └───────────────────────────────────────────────┴──────────────────────────┘
 * Rows keep one minute of history as a line (store.ts collects from app start). Readings a machine cannot give
 * (battery on a desktop, power without any meter, temperatures without a sensor) are left out rather than shown as 0.
 */
export function SystemView() {
  useSystemShown();
  const st = system.use();
  const { colors, sort } = settings.use().system;
  const [detail, setDetail] = useState<ProcReading | null>(null);
  const [plans, setPlans] = useState<PowerPlans | null>(null);
  useEffect(() => void powerPlans.list().then(setPlans).catch(() => {}), []);
  // Closed with the pointer still over the list: the next opening ranks freely again.
  useEffect(() => () => holdProcesses.set(false), []);
  const driveColor = useHue("orange");
  const s = st.stats;
  if (!s) return null;
  const tone = (l: Level) => schemeColor(colors, l);
  const gb = (b: number) => gigabytes(b);
  const mem = (s.memUsed / s.memTotal) * 100;
  const memLevel = memoryLevel(s.memUsed, s.memTotal, s.memCommit, s.memCommitLimit);
  const cores = s.cores.length;
  const g = st.gpu;
  const gpus = s.gpus ?? [];
  // Name last, so cores, threads and frequency survive truncation; "8-Core" only repeats the count.
  const cpuDetail = [s.physicalCores ? `${s.physicalCores}C ${cores}T` : cores ? `${cores}T` : null, s.cpuMhz ? `${ghz(s.cpuMhz)} GHz` : null, s.cpuName.replace(/\s*\d+-Core\b/i, "")];
  const gpuDetail = g ? [g.name, g.memTotal ? `${gb(g.memUsed)} / ${gb(g.memTotal)} GB` : null, g.engine && g.engine !== "3D" ? g.engine : null] : [t("Nicht verfügbar")];
  const net = st.net, b = st.battery, p = st.power;
  const procs = st.processes ? (sort === "mem" ? st.processes.mem : st.processes.cpu).slice(0, 5) : [];
  const cycleGpu = () => {
    const n = nextGpu(gpus, g);
    if (n) updateSettings((cur) => ({ system: { ...cur.system, gpu: n.name, gpuIndex: n.index } }));
  };

  // Many PCs only have Balanced: then there is nothing to switch.
  const planName = plans?.plans.find((x) => x.id === plans.active)?.name ?? t("Energiesparplan");
  const plan = plans && plans.plans.length > 1 && (
    <Select
      width="shrink-0"
      value={plans.active ?? ""}
      options={plans.plans.map((x) => ({ value: x.id, label: x.name }))}
      onChange={(id) => void powerPlans.set(id).then(setPlans).catch(() => {})}
      trigger={{
        label: `${t("Energiesparplan")} · ${planName}`,
        menuWidth: 180,
        className: "pressable flex max-w-[84px] items-center gap-0.5 rounded-[4px] bg-fill-2 px-1 text-[10px] text-label-2 hover:text-label",
        content: (
          <>
            <span className="truncate">{planName}</span>
            <CaretDown size={8} weight="bold" className="shrink-0" />
          </>
        ),
      }}
    />
  );

  let i = 0;
  return (
    <div className="flex h-full gap-2 px-4 pt-1 pb-2">
      <div className="min-w-0 flex-1 divide-y divide-separator rounded-[14px] bg-fill-1">
        <Row i={i++} tick={st.tick} icon={Cpu} hue="red" label="CPU" detail={join(cpuDetail)} temp={st.cpuTemp !== null ? { c: st.cpuTemp, level: tempLevel("cpu", st.cpuTemp), from: st.cpuTempFrom } : null} tone={tone} values={st.history.cpu} max={100} value={`${Math.round(s.cpu)} %`} level={ofShare(s.cpu)}>
          {cores > 0 && <CoreColumns cores={s.cores} tone={tone} />}
        </Row>
        <Row i={i++} tick={st.tick} icon={RamIcon} hue="violet" label="RAM" detail={`${gb(s.memUsed)} / ${gb(s.memTotal)} GB`} tone={tone} values={st.history.mem} max={100} value={`${Math.round(mem)} %`} level={memLevel}>
          {s.memTotal > 0 && s.memCommitLimit > 0 && <MemoryBar used={s.memUsed} cached={s.memCached} total={s.memTotal} commit={s.memCommit} limit={s.memCommitLimit} level={memLevel} color={tone(memLevel)} />}
        </Row>
        <Row
          i={i++}
          tick={st.tick}
          icon={GpuIcon}
          hue="emerald"
          label="GPU"
          detail={join(gpuDetail)}
          temp={st.gpuTemp !== null ? { c: st.gpuTemp, level: tempLevel("gpu", st.gpuTemp), from: st.gpuTempFrom } : null}
          tone={tone}
          values={st.history.gpu}
          max={100}
          value={g?.usage == null ? "-" : `${Math.round(g.usage)} %`}
          level={ofShare(g?.usage ?? 0)}
          onClick={gpus.length > 1 ? cycleGpu : undefined}
          badge={gpus.length > 1 && g ? `${gpus.findIndex((x) => x.key === g.key) + 1}/${gpus.length}` : undefined}
        />
        {net && (
          <Row
            i={i++}
            tick={st.tick}
            icon={ArrowsDownUp}
            hue="cyan"
            label={t("Netz")}
            detail={<NetDetail down={net.down} up={net.up} />}
            tone={tone}
            values={st.history.down}
            second={st.history.up}
            max={Math.max(1e6, ...st.history.down.filter(Number.isFinite), ...st.history.up.filter(Number.isFinite))}
            value={compactRate(net.down)}
            level={ofRate(Math.max(net.down, net.up))}
          />
        )}
        {(p || plan) && (
          <Row
            i={i++}
            tick={st.tick}
            icon={Lightning}
            hue="amber"
            label={t("Leistung")}
            detail={p ? join([p.source === "parts" && p.via ? p.via : t(p.source === "meter" ? "Gemessen" : p.source === "battery" ? "Akku-Entladung" : "Schätzung"), p.cpu !== null ? `CPU ${watts(p.cpu)} W` : null, p.gpu !== null ? `GPU ${watts(p.gpu)} W` : null]) : ""}
            control={plan}
            tone={tone}
            values={p ? st.history.power : undefined}
            max={Math.max(30, ...st.history.power.filter(Number.isFinite))}
            value={p ? `${p.estimate ? "~" : ""}${watts(p.watts)} W` : "-"}
            level={0}
          />
        )}
        {b && (
          <Row
            i={i++}
            tick={st.tick}
            icon={BatteryHigh}
            hue="green"
            label={t("Akku")}
            detail={join([
              b.state === "charging" ? (b.toFull !== null ? `${t("Voll in")} ${duration(b.toFull)}` : t("Lädt")) : b.state === "discharging" ? (b.left !== null ? `${duration(b.left)} ${t("übrig")}` : t("Entlädt")) : b.state === "full" ? t("Voll") : t("Angeschlossen"),
              b.saver ? t("Energiesparen") : null,
            ])}
            health={b.health !== null ? { text: `${t("Zustand")} ${Math.round(b.health * 100)} %`, color: tone(healthLevel(b.health)) } : null}
            tone={tone}
            value={`${Math.round(b.percent)} %`}
            level={batteryLevel(b)}
          />
        )}
        <Row
          i={i++}
          tick={st.tick}
          icon={WifiHigh}
          hue="sky"
          label="Ping"
          detail="1.1.1.1"
          tone={tone}
          values={st.history.ping}
          max={Math.max(60, ...st.history.ping.filter(Number.isFinite))}
          value={s.ping === null ? t("Offline") : `${s.ping} ms`}
          level={s.ping === null ? 2 : s.ping >= 150 ? 2 : s.ping >= 60 ? 1 : 0}
        />
      </div>

      <div className="relative flex w-[236px] shrink-0 flex-col gap-2">
        <div className="rounded-[14px] bg-fill-1 pb-1" onPointerEnter={() => holdProcesses.set(true)} onPointerLeave={() => holdProcesses.set(false)}>
          <div className="flex h-8 items-center justify-between pe-1.5 ps-3">
            <span className="text-caption font-medium tracking-wide text-label-3 uppercase">{t("Prozesse")}</span>
            <Segmented
              id="system-sort"
              size="sm"
              value={sort}
              onChange={(v) => updateSettings((cur) => ({ system: { ...cur.system, sort: v } }))}
              options={[{ value: "cpu", label: "CPU" }, { value: "mem", label: t("Speicher") }]}
            />
          </div>
          {procs.map((proc) => (
            <ProcessRow key={proc.id} proc={proc} value={sort === "mem" ? processMemory(proc.mem) : `${processShare(proc.cpu, cores || navigator.hardwareConcurrency)} %`} onClick={() => setDetail(proc)} />
          ))}
          {!procs.length && <div className="px-3 py-2 text-caption text-label-3">{t("Wird gelesen …")}</div>}
        </div>
        {st.drives.length > 0 && (
          <div className="rounded-[14px] bg-fill-1 py-1">
            {st.drives.slice(0, 3).map((d) => {
              const sz = driveSizes(d.used, d.total), share = d.total ? (d.used / d.total) * 100 : 0;
              return (
                <div key={d.key} className="flex h-7 items-center gap-2 px-3" title={d.model}>
                  <HardDrives size={13} weight="bold" className={`shrink-0 ${driveColor ? "" : "text-label-3"}`} style={driveColor ? { color: driveColor } : undefined} />
                  <span className="tabular w-[46px] shrink-0 truncate text-footnote font-medium text-label">{d.letters}</span>
                  <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-fill-2">
                    <span className="absolute inset-y-0 start-0 rounded-full" style={{ width: `${share}%`, background: tone(ofShare(share)) }} />
                  </span>
                  <span className="tabular shrink-0 text-caption text-label-3">
                    {sz.used}/{sz.total} {sz.unit}
                  </span>
                  {d.temp !== null && (
                    <span className="tabular w-7 shrink-0 text-end text-caption font-medium" style={{ color: tone(d.tempLevel) }}>
                      {degrees(d.temp)}°
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <AnimatePresence>{detail && <ProcessCard key="card" proc={st.processes?.cpu.find((x) => x.id === detail.id) ?? detail} cores={cores} onClose={() => setDetail(null)} />}</AnimatePresence>
      </div>
    </div>
  );
}

const join = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

function Row(props: {
  i: number;
  tick: number;
  icon: Icon;
  /** The icon's colour while coloured icons are on (Settings, Themes). */
  hue: Hue;
  label: string;
  detail: ReactNode;
  /** `from`: the program that gave it, shown on hover. */
  temp?: { c: number; level: Level; from?: string | null } | null;
  health?: { text: string; color: string } | null;
  tone: (l: Level) => string;
  values?: number[];
  second?: number[];
  max?: number;
  value: string;
  level: Level;
  onClick?: () => void;
  badge?: string;
  /** A small control after the detail, such as the power plan. */
  control?: ReactNode;
  children?: ReactNode;
}) {
  const I = props.icon;
  const color = props.tone(props.level);
  const iconColor = useHue(props.hue);
  const click = props.onClick;
  return (
    <motion.div
      className={`block w-full px-3 text-start ${click ? "pressable cursor-pointer" : ""}`}
      onClick={click}
      role={click ? "button" : undefined}
      tabIndex={click ? 0 : undefined}
      onKeyDown={click ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), click()) : undefined}
      title={props.onClick ? t("Klicken für die nächste GPU") : undefined}
      initial={{ opacity: 0, transform: "translateY(4px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{ ...content.enter, delay: 0.03 * props.i }}
    >
      <div className="flex h-[32px] items-center gap-3">
        <I size={15} weight="bold" className={`shrink-0 ${iconColor ? "" : "text-label-3"}`} style={iconColor ? { color: iconColor } : undefined} />
        <span className="w-16 shrink-0 text-footnote font-medium text-label">{props.label}</span>
        <span className="tabular flex w-[170px] shrink-0 items-center gap-1.5 truncate text-caption text-label-3">
          <span className="truncate" title={typeof props.detail === "string" ? props.detail : undefined}>
            {props.detail}
          </span>
          {props.temp && (
            <span className="shrink-0 font-medium" style={{ color: props.tone(props.temp.level) }} title={props.temp.from ?? undefined}>
              {degrees(props.temp.c)} °C
            </span>
          )}
          {props.health && (
            <span className="shrink-0 font-medium" style={{ color: props.health.color }}>
              {props.health.text}
            </span>
          )}
          {props.badge && <span className="shrink-0 rounded-[4px] bg-fill-2 px-1 text-[10px] text-label-2">{props.badge}</span>}
          {props.control}
        </span>
        {props.values ? <Trend values={props.values} second={props.second} max={props.max ?? 100} color={color} tick={props.tick} /> : <span className="flex-1" />}
        <span className="tabular w-[58px] shrink-0 text-end text-footnote font-semibold transition-colors duration-300" style={{ color }}>
          {props.value}
        </span>
      </div>
      {props.children && <div className="-mt-1 pb-1.5 ps-[87px]">{props.children}</div>}
    </motion.div>
  );
}

/** One column per logical processor, grouped by kind of core (P fastest, E slowest) where the CPU has more than one kind. */
function CoreColumns({ cores, tone }: { cores: { usage: number; kind: number }[]; tone: (l: Level) => string }) {
  const kinds = [...new Set(cores.map((c) => c.kind))].sort();
  const letter = (k: number) => (kinds.length < 2 ? null : k === kinds[0] ? "P" : k === kinds.at(-1) ? "E" : "M");
  return (
    <div className="flex h-[16px] items-end gap-2" aria-hidden>
      {kinds.map((k) => (
        <div key={k} className="flex h-full min-w-0 items-end gap-[2px]">
          {letter(k) && <span className="me-0.5 self-center text-[9px] font-semibold text-label-4">{letter(k)}</span>}
          {cores
            .filter((c) => c.kind === k)
            .map((c, n) => (
              <span key={n} className="relative h-full w-[4px] overflow-hidden rounded-[1.5px] bg-fill-2">
                <span className="absolute inset-x-0 bottom-0 rounded-[1.5px] transition-[height] duration-500" style={{ height: `${Math.max(6, Math.min(100, c.usage))}%`, background: tone(ofShare(c.usage)) }} />
              </span>
            ))}
        </div>
      ))}
    </div>
  );
}

/** In use (solid), file cache (light: given to any app that asks), and the commit charge against its limit. */
function MemoryBar(p: { used: number; cached: number; total: number; commit: number; limit: number; level: Level; color: string }) {
  const used = (p.used / p.total) * 100, cached = Math.min(100 - used, (p.cached / p.total) * 100);
  return (
    <div className="flex h-[16px] items-center gap-2">
      <span className="relative h-1.5 w-[90px] shrink-0 overflow-hidden rounded-full bg-fill-2">
        <span className="absolute inset-y-0 start-0" style={{ width: `${used}%`, background: p.color }} />
        <span className="absolute inset-y-0" style={{ insetInlineStart: `${used}%`, width: `${cached}%`, background: p.color, opacity: 0.35 }} />
      </span>
      <span className="tabular truncate text-[10px] text-label-3">
        {p.level > 0 && (
          <span className="font-semibold" style={{ color: p.color }}>
            {t(p.level === 2 ? "Druck kritisch" : "Druck hoch")} ·{" "}
          </span>
        )}
        {t("Cache")} {gigabytes(p.cached)} · {t("Zugesichert")} {gigabytes(p.commit)} / {gigabytes(p.limit)} GB
      </span>
    </div>
  );
}

function NetDetail({ down, up }: { down: number; up: number }) {
  const d = rate(down), u = rate(up);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center gap-0.5">
        <ArrowDown size={10} weight="bold" />
        {d.n} {d.unit}
      </span>
      <span className="inline-flex items-center gap-0.5">
        <ArrowUp size={10} weight="bold" />
        {u.n} {u.unit}
      </span>
    </span>
  );
}

/** Icons by executable path, asked once each. */
const icons = new Map<string, string | null>();
function useIcon(path: string | null): string | null {
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!path || icons.has(path)) return;
    icons.set(path, null);
    void systemIcon(path).then((url) => {
      icons.set(path, url);
      redraw((n) => n + 1);
    });
  }, [path]);
  return path ? (icons.get(path) ?? null) : null;
}

function AppIcon({ path, size }: { path: string | null; size: number }) {
  const src = useIcon(path);
  return src ? <img src={src} width={size} height={size} className="shrink-0" alt="" /> : <AppWindow size={size} weight="bold" className="shrink-0 text-label-3" />;
}

function ProcessRow({ proc, value, onClick }: { proc: ProcReading; value: string; onClick: () => void }) {
  return (
    <motion.button layout="position" transition={{ duration: 0.25 }} onClick={onClick} className="pressable flex h-[24px] w-full items-center gap-2 px-3 text-start hover:bg-fill-2">
      <AppIcon path={proc.path} size={14} />
      <span className="min-w-0 flex-1 truncate text-caption text-label-2">{proc.name}</span>
      {proc.count > 1 && <span className="tabular shrink-0 text-[10px] text-label-4">{proc.count}</span>}
      <span className="tabular w-[46px] shrink-0 text-end text-caption font-medium text-label">{value}</span>
    </motion.button>
  );
}

function ProcessCard({ proc, cores, onClose }: { proc: ProcReading; cores: number; onClose: () => void }) {
  return (
    <motion.div {...fade} className="absolute inset-x-0 top-0 z-10 rounded-[14px] bg-elevated p-3 shadow-[0_6px_18px_rgb(0_0_0/0.45)]">
      <div className="flex items-center gap-2">
        <AppIcon path={proc.path} size={22} />
        <span className="min-w-0 flex-1 truncate text-body font-medium text-label">{proc.name}</span>
        <button onClick={onClose} aria-label={t("Schließen")} className="pressable text-label-3 hover:text-label">
          <X size={13} weight="bold" />
        </button>
      </div>
      <div className="tabular mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-caption">
        <span className="text-label-3">CPU</span>
        <span className="text-label">{processShare(proc.cpu, cores || navigator.hardwareConcurrency)} %</span>
        <span className="text-label-3">{t("Speicher")}</span>
        <span className="text-label">{processMemory(proc.mem)}B</span>
        <span className="text-label-3">{t("Prozesse")}</span>
        <span className="text-label">{proc.count}</span>
        <span className="text-label-3">{t("Pfad")}</span>
        <span className="truncate text-label-2" title={proc.path ?? undefined}>
          {proc.path ?? proc.id}
        </span>
      </div>
      {proc.path && (
        <button onClick={() => revealFile(proc.path!)} className="pressable mt-2 text-caption font-medium text-link">
          {t("Im Explorer zeigen")}
        </button>
      )}
    </motion.div>
  );
}

/**
 * One minute of history; gaps (no value) stay open. Right = now. `second` is drawn fainter (upload under download).
 * The line is drawn one step to the right and glides left by that step every second, so it scrolls smoothly instead of jumping.
 */
function Trend({ values, second, max, color, tick }: { values: number[]; second?: number[]; max: number; color: string; tick: number }) {
  const w = 160;
  const h = 22;
  const step = w / (HISTORY - 2);
  const path = (vals: number[]) => {
    const offset = HISTORY - vals.length;
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        pen = false;
        return;
      }
      const x = (offset + i) * step;
      const y = h - 2 - (Math.min(v, max) / max) * (h - 4);
      d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const line = (d: string, opacity: number, key: string) => (
    <path
      // New value → new animation (key); before that the line sits one step to the right.
      key={`${key}${tick}`}
      className="trend-scroll"
      d={d}
      fill="none"
      stroke={color}
      strokeOpacity={opacity}
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
      style={{ ["--step" as string]: `${step}px` }}
    />
  );
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-[22px] min-w-0 flex-1 overflow-hidden">
      <line x1="0" x2={w} y1={h - 1} y2={h - 1} stroke="var(--color-separator)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      {second && line(path(second), 0.35, "b")}
      {line(path(values), 0.8, "a")}
    </svg>
  );
}
