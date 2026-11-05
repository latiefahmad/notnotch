//! System stats for the Hardware tool and the closed row's readings. Reads raw values only; every rule that decides what
//! to show (rates, levels, temperature plausibility, power source, battery state, drive grouping) is in
//! src/features/system/*.ts, where it is tested.
//!
//! Rhythms (src/features/system/store.ts): ~1×/s with everything while the Hardware tool is shown (`full`); every 2 s
//! with the GPU counters while the closed row shows a GPU reading (`with_gpu`); otherwise every 3 s with CPU, RAM and
//! only the extras the closed row asks for (`want`).
//!
//! - GPU: performance counters "GPU Engine(*)" per adapter and engine, the same values as Task Manager, vendor-independent;
//!   VRAM from "GPU Adapter Memory(*)\Dedicated Usage", sizes and names from DXGI.
//! - CPU: sysinfo per core, core kinds from the CPU set efficiency class, frequency from "Processor Information".
//! - Network: cumulative byte counters of the hardware interfaces (GetIfTable2); the page computes the rate.
//! - Temperatures, power, battery and drives: see `hw`; from HWiNFO or LibreHardwareMonitor when one runs: see `external`.
//! - Ping: ICMP echo to 1.1.1.1 on its own thread (every 2 s, only while polled).

mod external;
mod hw;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::State;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::LUID;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY, MIB_IF_TABLE2};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION};
use windows::Win32::System::SystemInformation::GetSystemCpuSetInformation;

/// 1.1.1.1 in network byte order.
const PING_TARGET: u32 = u32::from_le_bytes([1, 1, 1, 1]);
const PING_EVERY: Duration = Duration::from_secs(2);
/// The ping thread pauses after this long without a poll.
const PING_IDLE: Duration = Duration::from_secs(5);
/// "No ping" (timeout / offline).
const NO_PING: u64 = u64::MAX;
/// Listing processes is the costliest read: at most this often, and only while the tool is shown.
const PROCESS_EVERY: Duration = Duration::from_millis(1800);
/// Entries kept per ranking (CPU, memory); the page shows fewer, the rest replace rows that leave.
const PROCESS_KEEP: usize = 12;
/// DXGI is asked again for a counter adapter it did not list (LUIDs change when a driver restarts), at most this often.
const ADAPTERS_EVERY: Duration = Duration::from_secs(30);

pub struct SystemState(Arc<Mutex<Probe>>);

/// The process list is dropped this long after the last full poll (tool closed), with sysinfo's process handles.
const PROCESS_LINGER: Duration = Duration::from_secs(10);

struct Probe {
    sys: System,
    /// Processes only: sysinfo keeps a handle per listed process, so this lives only while the tool is shown
    /// (created on the first full poll, dropped on a non-full one or by the sweeper after `PROCESS_LINGER`).
    procs: Option<System>,
    full_at: Instant,
    started: Instant,
    gpu: Option<Pdh>,
    cpu: Option<Pdh>,
    /// Opened the first time temperatures or power are wanted.
    zones: Option<Option<Pdh>>,
    meter: Option<Option<Pdh>>,
    adapters: Vec<Adapter>,
    /// Keys DXGI lists but that are not shown (the software renderer), so they never ask for a new listing.
    skipped: Vec<String>,
    adapters_at: Instant,
    /// Efficiency rank per logical processor (0 = fastest kind).
    kinds: Vec<u8>,
    processes: Vec<Proc>,
    processes_at: Option<Instant>,
    names: HashMap<String, String>,
    hw: hw::Hardware,
    external: external::External,
    ping: Arc<Ping>,
}

struct Ping {
    ms: AtomicU64,
    /// Last poll; decides whether the thread pings.
    wanted_at: Mutex<Instant>,
}

struct Adapter {
    key: String,
    luid: LUID,
    name: String,
    vram: u64,
}

// PDH handles are pointers; only touch them under the mutex.
unsafe impl Send for Probe {}

impl Default for SystemState {
    fn default() -> Self {
        let ping = Arc::new(Ping { ms: AtomicU64::new(NO_PING), wanted_at: Mutex::new(Instant::now() - PING_IDLE) });
        spawn_ping(ping.clone());
        let (adapters, skipped) = adapters();
        let probe = Arc::new(Mutex::new(Probe {
            sys: System::new(),
            procs: None,
            full_at: Instant::now(),
            started: Instant::now(),
            gpu: Pdh::open(&[w!("\\GPU Engine(*)\\Utilization Percentage"), w!("\\GPU Adapter Memory(*)\\Dedicated Usage")]),
            cpu: Pdh::open(&[w!("\\Processor Information(_Total)\\% Processor Performance"), w!("\\Processor Information(_Total)\\Processor Frequency")]),
            zones: None,
            meter: None,
            adapters,
            skipped,
            adapters_at: Instant::now(),
            kinds: core_kinds(),
            processes: Vec::new(),
            processes_at: None,
            names: HashMap::new(),
            hw: hw::Hardware::new(),
            external: external::External::default(),
            ping,
        }));
        spawn_process_sweeper(probe.clone());
        Self(probe)
    }
}

fn lock(m: &Mutex<Probe>) -> std::sync::MutexGuard<'_, Probe> {
    // A panic inside one read must not take the monitor down for good.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Polling stops altogether when nothing shows the values, so a closed tool's process handles are let go here.
fn spawn_process_sweeper(probe: Arc<Mutex<Probe>>) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(5));
        let mut p = lock(&probe);
        if p.procs.is_some() && p.full_at.elapsed() > PROCESS_LINGER {
            p.procs = None;
            p.processes.clear();
            p.processes_at = None;
        }
    });
}

/// Extras the closed row asks for outside the tool (the tool gets everything).
#[derive(Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase", default)]
pub struct Want {
    net: bool,
    temps: bool,
    power: bool,
    battery: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    cpu: f32,
    cpu_name: String,
    mem_used: u64,
    mem_total: u64,
    /// The busiest adapter (most VRAM while none is busy); the page picks the one chosen from `gpus`. None if the GPU counters are missing.
    gpu: Option<f64>,
    gpu_name: Option<String>,
    gpu_mem_used: u64,
    gpu_mem_total: u64,
    /// Milliseconds; None = no reply.
    ping: Option<u64>,
    /// Milliseconds since the probe started (monotonic), for rates.
    at: f64,
    /// Per logical processor, only while shown.
    cores: Vec<Core>,
    cpu_mhz: Option<f64>,
    physical_cores: Option<usize>,
    /// Bytes; 0 when not read.
    mem_cached: u64,
    mem_commit: u64,
    mem_commit_limit: u64,
    gpus: Vec<GpuReading>,
    /// Cumulative bytes received and sent over the hardware interfaces.
    net: Option<[u64; 2]>,
    /// ACPI thermal zones: (zone, kelvin).
    zones: Vec<(String, f64)>,
    /// Energy Meter and Power Meter channels: (instance, milliwatts).
    energy: Vec<(String, f64)>,
    meter: Vec<(String, f64)>,
    nvml: Vec<hw::NvmlGpu>,
    /// CPU and GPU temperature and power from HWiNFO or LibreHardwareMonitor.
    external: Option<external::Reading>,
    battery: Option<hw::BatteryRaw>,
    drives: Option<hw::Drives>,
    processes: Option<Vec<Proc>>,
}

#[derive(Serialize, Clone, Copy)]
pub struct Core {
    usage: f32,
    kind: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuReading {
    key: String,
    name: String,
    mem_total: u64,
    /// Busiest engine kind, as Task Manager; None while the counters were not read.
    usage: Option<f64>,
    engine: Option<String>,
    mem_used: u64,
    temp: Option<f64>,
    #[serde(skip)]
    luid: LUID,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    /// Executable name in lower case: an app's processes fold into one entry.
    id: String,
    name: String,
    path: Option<String>,
    count: u32,
    /// Percent of one core, summed over the app's processes.
    cpu: f32,
    mem: u64,
}

#[tauri::command]
pub async fn system_stats(full: bool, with_gpu: Option<bool>, want: Option<Want>, state: State<'_, SystemState>) -> Result<Stats, String> {
    let mut guard = lock(&state.0);
    let p = &mut *guard;
    let want = if full { Want { net: true, temps: true, power: true, battery: true } } else { want.unwrap_or_default() };
    p.sys.refresh_cpu_usage();
    p.sys.refresh_memory();
    if p.sys.cpus().is_empty() || p.sys.cpus()[0].brand().is_empty() {
        p.sys.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    }
    if full {
        *p.ping.wanted_at.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        p.full_at = Instant::now();
    } else if p.procs.is_some() {
        // The tool closed: let go of every process handle at once.
        p.procs = None;
        p.processes.clear();
        p.processes_at = None;
    }

    // GPU counters walk every process's engines: only while shown, for a GPU reading in the row, or for a GPU temperature.
    let counters = full || with_gpu == Some(true);
    let mut gpus = p.read_gpus(counters);
    if want.temps {
        p.hw.gpu_temps(&mut gpus);
    }
    // The busiest adapter, or the one with most VRAM while none is busy; the page replaces it with the one chosen.
    let busiest = gpus
        .iter()
        .enumerate()
        .filter(|(_, g)| g.usage.is_some_and(|u| u > 0.0))
        .max_by(|a, b| a.1.usage.unwrap_or(0.0).total_cmp(&b.1.usage.unwrap_or(0.0)))
        .map(|(i, _)| i);
    let strongest = busiest.or_else(|| p.adapters.iter().enumerate().max_by_key(|(_, a)| a.vram).map(|(i, _)| i));
    let (gpu, gpu_mem_used) = strongest.and_then(|i| gpus.get(i)).map(|g| (g.usage, g.mem_used)).unwrap_or((None, 0));

    let cores = if full {
        p.sys.cpus().iter().enumerate().map(|(i, c)| Core { usage: c.cpu_usage(), kind: p.kinds.get(i).copied().unwrap_or(0) }).collect()
    } else {
        Vec::new()
    };
    let cpu_mhz = if full { p.cpu.as_ref().and_then(Pdh::frequency) } else { None };
    let (mem_cached, mem_commit, mem_commit_limit) = if full { memory_detail() } else { (0, 0, 0) };

    let zones = if want.temps { p.zones() } else { Vec::new() };
    let (energy, meter) = if want.power { p.meters() } else { (Vec::new(), Vec::new()) };
    let nvml = if want.temps || want.power { p.hw.nvml() } else { Vec::new() };
    let external = if want.temps || want.power { p.external.read() } else { None };
    let battery = if want.battery || want.power { p.hw.battery() } else { None };
    let drives = if full { p.hw.drives() } else { None };
    let processes = if full { Some(p.read_processes()) } else { None };

    let ping = if full { p.ping.ms.load(Ordering::Relaxed) } else { NO_PING };
    let gpu_name = strongest.map(|i| p.adapters[i].name.clone());
    let gpu_mem_total = strongest.map(|i| p.adapters[i].vram).unwrap_or(0);
    Ok(Stats {
        cpu: p.sys.global_cpu_usage(),
        cpu_name: p.sys.cpus().first().map(|c| clean_name(c.brand())).unwrap_or_default(),
        mem_used: p.sys.used_memory(),
        mem_total: p.sys.total_memory(),
        gpu,
        gpu_name,
        gpu_mem_used,
        gpu_mem_total,
        ping: (ping != NO_PING).then_some(ping),
        at: p.started.elapsed().as_secs_f64() * 1000.0,
        cores,
        cpu_mhz,
        physical_cores: if full { System::physical_core_count() } else { None },
        mem_cached,
        mem_commit,
        mem_commit_limit,
        gpus,
        net: if want.net { net_totals() } else { None },
        zones,
        energy,
        meter,
        nvml,
        external,
        battery,
        drives,
        processes,
    })
}

/// The program's icon as a PNG data URL, for the process list (the page caches it per path).
#[tauri::command]
pub async fn system_icon(path: String) -> Result<Option<String>, String> {
    // The shell's icon lookup wants COM on this thread, as in mixer.rs.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    Ok(crate::mixer::icon_png(&path))
}

impl Probe {
    /// Every DXGI adapter, with the counters' figures when `counters`.
    fn read_gpus(&mut self, counters: bool) -> Vec<GpuReading> {
        let mut usage: HashMap<String, (f64, String)> = HashMap::new();
        let mut vram: HashMap<String, f64> = HashMap::new();
        let mut read = false;
        if counters {
            if let Some(pdh) = self.gpu.as_ref().filter(|q| q.collect()) {
                (usage, vram) = gpu_counters(&pdh.read(0), &pdh.read(1));
                read = true;
            }
            let unknown = usage.keys().any(|k| !self.adapters.iter().any(|a| &a.key == k) && !self.skipped.contains(k));
            if unknown && self.adapters_at.elapsed() > ADAPTERS_EVERY {
                (self.adapters, self.skipped) = adapters();
                self.adapters_at = Instant::now();
                let keys: Vec<&str> = self.adapters.iter().map(|a| a.key.as_str()).collect();
                self.hw.forget_gpus(&keys);
            }
        }
        self.adapters
            .iter()
            .map(|a| {
                let busy = usage.get(&a.key);
                GpuReading {
                    key: a.key.clone(),
                    name: a.name.clone(),
                    mem_total: a.vram,
                    // An adapter the counters do not list is idle (asleep on a laptop), not unknown.
                    usage: read.then(|| busy.map(|b| b.0).unwrap_or(0.0)),
                    // Below ~5 % the busiest kind is noise and the label would flicker.
                    engine: busy.filter(|b| b.0 > 5.0).map(|b| b.1.clone()),
                    mem_used: vram.get(&a.key).copied().unwrap_or(0.0) as u64,
                    temp: None,
                    luid: a.luid,
                }
            })
            .collect()
    }

    fn zones(&mut self) -> Vec<(String, f64)> {
        let q = self.zones.get_or_insert_with(|| {
            Pdh::open(&[w!("\\Thermal Zone Information(*)\\High Precision Temperature"), w!("\\Thermal Zone Information(*)\\Temperature")])
        });
        let Some(q) = q.as_ref().filter(|q| q.collect()) else { return Vec::new() };
        let precise: HashMap<String, f64> = q.read(0).into_iter().collect();
        // High precision is in tenths of a kelvin; the plain counter in whole kelvin.
        q.read(1).into_iter().map(|(zone, k)| {
            let kelvin = precise.get(&zone).filter(|v| **v > 0.0).map(|v| v / 10.0).unwrap_or(k);
            (zone, kelvin)
        }).collect()
    }

    fn meters(&mut self) -> (Vec<(String, f64)>, Vec<(String, f64)>) {
        let q = self.meter.get_or_insert_with(|| Pdh::open(&[w!("\\Energy Meter(*)\\Power"), w!("\\Power Meter(*)\\Power")]));
        match q.as_ref().filter(|q| q.collect()) {
            Some(q) => (q.read(0), q.read(1)),
            None => (Vec::new(), Vec::new()),
        }
    }

    fn read_processes(&mut self) -> Vec<Proc> {
        if self.processes_at.is_some_and(|t| t.elapsed() < PROCESS_EVERY) {
            return self.processes.clone();
        }
        self.processes_at = Some(Instant::now());
        let sys = self.procs.get_or_insert_with(System::new);
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory().with_exe(UpdateKind::OnlyIfNotSet),
        );
        let mut apps: HashMap<String, Proc> = HashMap::new();
        for proc in sys.processes().values() {
            let name = proc.name().to_string_lossy();
            if name.is_empty() || proc.pid().as_u32() == 0 {
                continue;
            }
            let id = name.to_lowercase();
            let e = apps.entry(id.clone()).or_insert_with(|| Proc { id, name: name.to_string(), path: None, count: 0, cpu: 0.0, mem: 0 });
            e.count += 1;
            e.cpu += proc.cpu_usage();
            e.mem += proc.memory();
            if e.path.is_none() {
                e.path = proc.exe().map(|p| p.to_string_lossy().into_owned()).filter(|p| !p.is_empty());
            }
        }
        let mut all: Vec<Proc> = apps.into_values().collect();
        let mut keep: Vec<Proc> = Vec::with_capacity(PROCESS_KEEP * 2);
        all.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
        keep.extend(all.iter().take(PROCESS_KEEP).cloned());
        all.sort_by(|a, b| b.mem.cmp(&a.mem));
        let heavy: Vec<Proc> = all.into_iter().take(PROCESS_KEEP).filter(|p| !keep.iter().any(|k| k.id == p.id)).collect();
        keep.extend(heavy);
        for p in &mut keep {
            if let Some(path) = &p.path {
                p.name = self.names.entry(path.clone()).or_insert_with(|| crate::mixer::display_name(path)).clone();
            } else if let Some(stem) = p.name.strip_suffix(".exe").or_else(|| p.name.strip_suffix(".EXE")) {
                p.name = stem.to_string();
            }
        }
        self.processes = keep.clone();
        keep
    }
}

/// Per adapter key: (busiest engine kind's usage capped at 100, that kind), and dedicated VRAM in use.
/// Engine instance names: "pid_1234_luid_0x00000000_0x0000C5E2_phys_0_eng_3_engtype_VideoDecode".
fn gpu_counters(engines: &[(String, f64)], memory: &[(String, f64)]) -> (HashMap<String, (f64, String)>, HashMap<String, f64>) {
    // Summed over processes per engine (Task Manager), then the busiest engine of each kind, then the busiest kind.
    let mut per_engine: HashMap<(String, String, String), f64> = HashMap::new();
    for (name, v) in engines {
        let Some(key) = luid_key(name) else { continue };
        let Some(rest) = name.split_once("_eng_").map(|(_, r)| r) else { continue };
        let Some((eng, kind)) = rest.split_once("_engtype_") else { continue };
        // "Compute_0" and "Compute_1" are one kind.
        let kind = match kind.rsplit_once('_') {
            Some((k, n)) if n.chars().all(|c| c.is_ascii_digit()) && !k.is_empty() => k,
            _ => kind,
        };
        let phys = name.split_once("_phys_").and_then(|(_, r)| r.split('_').next()).unwrap_or("0");
        *per_engine.entry((key, format!("{phys}.{eng}"), kind.to_string())).or_default() += v;
    }
    let mut usage: HashMap<String, (f64, String)> = HashMap::new();
    for ((key, _, kind), v) in per_engine {
        let v = v.clamp(0.0, 100.0);
        let e = usage.entry(key).or_insert((-1.0, String::new()));
        // Ties: the 3D engine first, then by name, so the label does not flicker between idle kinds.
        if v > e.0 || (v == e.0 && (kind == "3D" || (e.1 != "3D" && kind < e.1))) {
            *e = (v, kind);
        }
    }
    let mut vram: HashMap<String, f64> = HashMap::new();
    for (name, v) in memory {
        if let Some(key) = luid_key(name) {
            *vram.entry(key).or_default() += v;
        }
    }
    (usage, vram)
}

/// "luid_0x00000000_0x0000c5e2" in lower case, from any counter instance name.
fn luid_key(instance: &str) -> Option<String> {
    let lower = instance.to_ascii_lowercase();
    let at = lower.find("luid_0x")?;
    lower.get(at..at + 26).map(str::to_string)
}

fn luid_text(l: LUID) -> String {
    format!("luid_0x{:08x}_0x{:08x}", l.HighPart as u32, l.LowPart)
}

/// The real GPUs (no software renderer), in DXGI order, and the keys of the adapters left out.
fn adapters() -> (Vec<Adapter>, Vec<String>) {
    let mut list = Vec::new();
    let mut skipped = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return (list, skipped) };
        for i in 0..16 {
            let Ok(adapter) = factory.EnumAdapters1(i) else { break };
            let Ok(desc) = adapter.GetDesc1() else { continue };
            let key = luid_text(desc.AdapterLuid);
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                skipped.push(key);
                continue;
            }
            if list.iter().any(|a: &Adapter| a.key == key) {
                continue;
            }
            let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
            list.push(Adapter { key, luid: desc.AdapterLuid, name: clean_name(&String::from_utf16_lossy(&desc.Description[..len])), vram: desc.DedicatedVideoMemory as u64 });
        }
    }
    (list, skipped)
}

/// Efficiency rank of each logical processor of group 0 (0 = the fastest kind); all 0 with one kind of core.
fn core_kinds() -> Vec<u8> {
    unsafe {
        let mut len = 0u32;
        let _ = GetSystemCpuSetInformation(None, 0, &mut len, None, None);
        if len == 0 {
            return Vec::new();
        }
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        let base = buf.as_mut_ptr() as *mut u8;
        if !GetSystemCpuSetInformation(Some(base.cast()), len, &mut len, None, None).as_bool() {
            return Vec::new();
        }
        // SYSTEM_CPU_SET_INFORMATION: Size, Type, then CpuSet { Id, Group (u16), LogicalProcessorIndex (u8), CoreIndex,
        // LastLevelCacheIndex, NumaNodeIndex, EfficiencyClass (u8 at 18) }.
        let bytes = std::slice::from_raw_parts(base, len as usize);
        let mut classes: Vec<(usize, u8)> = Vec::new();
        let mut off = 0usize;
        while off + 20 <= bytes.len() {
            let size = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
            if size == 0 {
                break;
            }
            let ty = u32::from_le_bytes(bytes[off + 4..off + 8].try_into().unwrap());
            let group = u16::from_le_bytes(bytes[off + 12..off + 14].try_into().unwrap());
            if ty == 0 && group == 0 {
                classes.push((bytes[off + 14] as usize, bytes[off + 18]));
            }
            off += size;
        }
        let mut ranks: Vec<u8> = classes.iter().map(|c| c.1).collect();
        ranks.sort_unstable_by(|a, b| b.cmp(a));
        ranks.dedup();
        let mut kinds = vec![0u8; classes.iter().map(|c| c.0 + 1).max().unwrap_or(0)];
        for (index, class) in classes {
            kinds[index] = ranks.iter().position(|r| *r == class).unwrap_or(0) as u8;
        }
        kinds
    }
}

/// (file cache, commit charge, commit limit) in bytes.
fn memory_detail() -> (u64, u64, u64) {
    unsafe {
        let mut info = PERFORMANCE_INFORMATION { cb: std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32, ..Default::default() };
        if GetPerformanceInfo(&mut info, info.cb).is_err() {
            return (0, 0, 0);
        }
        let page = info.PageSize as u64;
        (info.SystemCache as u64 * page, info.CommitTotal as u64 * page, info.CommitLimit as u64 * page)
    }
}

/// Bytes in and out over the hardware interfaces. Filter drivers, virtual adapters and loopback are left out: their
/// traffic is already counted on the adapter that carries it.
fn net_totals() -> Option<[u64; 2]> {
    unsafe {
        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        if GetIfTable2(&mut table).is_err() || table.is_null() {
            return None;
        }
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        let mut total = [0u64; 2];
        for row in rows {
            // HardwareInterface is bit 0, FilterInterface bit 1; type 24 is the software loopback.
            let flags = row.InterfaceAndOperStatusFlags._bitfield;
            if flags & 1 != 0 && flags & 2 == 0 && row.Type != 24 {
                total[0] += row.InOctets;
                total[1] += row.OutOctets;
            }
        }
        FreeMibTable(table.cast());
        Some(total)
    }
}

/// One PDH query with a few counters; a counter that does not exist on this machine stays None.
struct Pdh {
    query: PDH_HQUERY,
    counters: Vec<Option<PDH_HCOUNTER>>,
}

impl Pdh {
    fn open(paths: &[PCWSTR]) -> Option<Self> {
        unsafe {
            let mut query = PDH_HQUERY::default();
            if PdhOpenQueryW(None, 0, &mut query) != 0 {
                return None;
            }
            let counters: Vec<_> = paths
                .iter()
                .map(|p| {
                    let mut c = PDH_HCOUNTER::default();
                    (PdhAddEnglishCounterW(query, *p, 0, &mut c) == 0).then_some(c)
                })
                .collect();
            if counters.iter().all(Option::is_none) {
                PdhCloseQuery(query);
                return None;
            }
            // Rates need two samples; this is the first.
            PdhCollectQueryData(query);
            Some(Self { query, counters })
        }
    }

    fn collect(&self) -> bool {
        unsafe { PdhCollectQueryData(self.query) == 0 }
    }

    /// (instance, value) of counter `i`; empty when it has no valid instance.
    fn read(&self, i: usize) -> Vec<(String, f64)> {
        let Some(Some(counter)) = self.counters.get(i).copied() else { return Vec::new() };
        unsafe {
            let (mut size, mut count) = (0u32, 0u32);
            PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
            if size == 0 {
                return Vec::new();
            }
            // Aligned as u64; holds the items followed by the instance names.
            let mut buf = vec![0u64; (size as usize).div_ceil(8)];
            let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) != 0 {
                return Vec::new();
            }
            std::slice::from_raw_parts(items, count as usize)
                .iter()
                .filter(|i| i.FmtValue.CStatus == 0)
                .map(|i| (i.szName.to_string().unwrap_or_default(), i.FmtValue.Anonymous.doubleValue))
                .collect()
        }
    }

    /// Current CPU frequency in MHz: nominal frequency × performance share.
    fn frequency(&self) -> Option<f64> {
        if !self.collect() {
            return None;
        }
        let perf = self.read(0).first()?.1;
        let base = self.read(1).first()?.1;
        (base > 0.0 && perf > 0.0).then_some(base * perf / 100.0)
    }
}

impl Drop for Pdh {
    fn drop(&mut self) {
        unsafe {
            PdhCloseQuery(self.query);
        }
    }
}

/// "NVIDIA GeForce RTX 4070 Ti" → "GeForce RTX 4070 Ti"; strips "(R)", "(TM)", "CPU @ …".
fn clean_name(name: &str) -> String {
    let mut s = name.replace("(R)", "").replace("(TM)", "").replace("(tm)", "");
    if let Some(i) = s.find(" @ ") {
        s.truncate(i);
    }
    for prefix in ["NVIDIA ", "AMD ", "Intel "] {
        if s.starts_with(prefix) && s.len() > prefix.len() + 6 {
            s = s[prefix.len()..].to_string();
        }
    }
    s.replace(" CPU", "").replace("  ", " ").replace(" Processor", "").trim().to_string()
}

fn spawn_ping(ping: Arc<Ping>) {
    thread::spawn(move || {
        let Ok(handle) = (unsafe { IcmpCreateFile() }) else { return };
        let payload = [0u8; 32];
        let mut reply = vec![0u8; std::mem::size_of::<ICMP_ECHO_REPLY>() + payload.len() + 8];
        loop {
            if ping.wanted_at.lock().unwrap().elapsed() > PING_IDLE {
                thread::sleep(Duration::from_millis(500));
                continue;
            }
            let n = unsafe {
                IcmpSendEcho(handle, PING_TARGET, payload.as_ptr().cast(), payload.len() as u16, None, reply.as_mut_ptr().cast(), reply.len() as u32, 1000)
            };
            let ms = if n > 0 {
                let r = unsafe { &*(reply.as_ptr() as *const ICMP_ECHO_REPLY) };
                if r.Status == 0 { r.RoundTripTime as u64 } else { NO_PING }
            } else {
                NO_PING
            };
            ping.ms.store(ms, Ordering::Relaxed);
            thread::sleep(PING_EVERY);
        }
        #[allow(unreachable_code)]
        unsafe {
            let _ = IcmpCloseHandle(handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engines_sum_per_engine_and_take_the_busiest_kind() {
        let l = "luid_0x00000000_0x0000C5E2";
        let engines = vec![
            (format!("pid_1_{l}_phys_0_eng_0_engtype_3D"), 20.0),
            (format!("pid_2_{l}_phys_0_eng_0_engtype_3D"), 15.0),
            (format!("pid_2_{l}_phys_0_eng_4_engtype_VideoDecode"), 50.0),
            (format!("pid_3_{l}_phys_0_eng_7_engtype_Compute_0"), 10.0),
        ];
        let memory = vec![(format!("{l}_phys_0"), 1024.0)];
        let (usage, vram) = gpu_counters(&engines, &memory);
        let key = "luid_0x00000000_0x0000c5e2";
        assert_eq!(usage[key], (50.0, "VideoDecode".to_string()));
        assert_eq!(vram[key], 1024.0);
    }

    #[test]
    fn idle_adapter_names_3d() {
        let l = "luid_0x00000000_0x00001111";
        let engines = vec![(format!("pid_1_{l}_phys_0_eng_1_engtype_Copy"), 0.0), (format!("pid_1_{l}_phys_0_eng_0_engtype_3D"), 0.0)];
        let (usage, _) = gpu_counters(&engines, &[]);
        assert_eq!(usage["luid_0x00000000_0x00001111"].1, "3D");
    }
}
