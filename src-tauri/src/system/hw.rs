//! Readings that need no administrator rights and no driver of NotNotch's own: graphics temperatures (D3DKMT, as Task
//! Manager), NVIDIA board power and temperature (NVML from System32, desktops only), the machine's battery (WinRT
//! report + GetSystemPowerStatus), and internal drives with SSD temperatures (storage properties, on a thread of their
//! own). Raw values only; src/features/system/*.ts decides what they mean.
//!
//! Translated in part from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck): src/BrimDeck/Native/TemperatureSensors.cs
//! (D3DKMT perf data layout, retry pauses) and src/BrimDeck/Native/StorageReader.cs (storage property layouts).

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::core::{s, w, HSTRING, PCSTR};
use windows::Devices::Power::Battery;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE, LUID};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDriveStringsW, GetVolumeNameForVolumeMountPointW, QueryDosDeviceW,
    FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::IO::DeviceIoControl;

use super::GpuReading;

pub struct Hardware {
    /// Laptops and tablets: the discrete GPU may sleep, so it is only asked while busy, and NVML stays unloaded.
    /// shortcut: a USB UPS that Windows reports as a system battery makes a desktop count as a laptop here (and shows a
    /// battery row); telling them apart needs the battery's device chemistry or bus, worth it if a user reports it.
    has_battery: bool,
    gpu: HashMap<String, Sensor>,
    nvml: Option<Option<Nvml>>,
    drives: Arc<Mutex<DriveCache>>,
}

impl Hardware {
    pub fn new() -> Self {
        Self { has_battery: power_status().is_some_and(|s| s.BatteryFlag & 128 == 0 && s.BatteryFlag != 255), gpu: HashMap::new(), nvml: None, drives: Arc::default() }
    }

    /// Fills `temp` for the adapters that may be asked: all on a desktop, only busy ones on a battery machine (an idle
    /// discrete GPU in a hybrid laptop stays asleep).
    pub fn gpu_temps(&mut self, gpus: &mut [GpuReading]) {
        let now = Instant::now();
        for g in gpus {
            if self.has_battery && g.usage.is_none_or(|u| u <= 0.0) {
                continue;
            }
            let sensor = self.gpu.entry(g.key.clone()).or_default();
            g.temp = sensor.read(g.luid, now);
            // An open handle could keep a hybrid laptop's discrete GPU from its deepest sleep.
            if self.has_battery {
                sensor.close();
            }
        }
    }

    /// Adapters that went away (a driver restart gives new LUIDs): their handles are closed.
    pub fn forget_gpus(&mut self, keys: &[&str]) {
        self.gpu.retain(|key, sensor| {
            let keep = keys.contains(&key.as_str());
            if !keep {
                sensor.close();
            }
            keep
        });
    }

    pub fn nvml(&mut self) -> Vec<NvmlGpu> {
        if self.has_battery {
            return Vec::new();
        }
        self.nvml.get_or_insert_with(Nvml::load).as_ref().map(Nvml::read).unwrap_or_default()
    }

    pub fn battery(&self) -> Option<BatteryRaw> {
        self.has_battery.then(battery).flatten()
    }

    /// The drives as last read; starts a new read on its own thread when the last is older than 10 s.
    pub fn drives(&self) -> Option<Drives> {
        let mut cache = self.drives.lock().ok()?;
        let stale = cache.read_at.is_none_or(|t| t.elapsed() > DRIVES_EVERY);
        if stale && !cache.running {
            cache.running = true;
            let shared = self.drives.clone();
            let temps_due = cache.temps_at.is_none_or(|t| t.elapsed() > DRIVE_TEMPS_EVERY);
            thread::spawn(move || {
                let fresh = read_drives(temps_due);
                if let Ok(mut c) = shared.lock() {
                    let now = Instant::now();
                    // Temperatures not due this time keep the last ones.
                    let mut fresh = fresh;
                    if !temps_due {
                        if let Some(old) = &c.value {
                            for d in &mut fresh.disks {
                                d.temp = old.disks.iter().find(|o| o.number == d.number).and_then(|o| o.temp);
                            }
                        }
                    } else {
                        c.temps_at = Some(now);
                    }
                    c.value = Some(fresh);
                    c.read_at = Some(now);
                    c.running = false;
                }
            });
        }
        cache.value.clone()
    }
}

fn power_status() -> Option<SYSTEM_POWER_STATUS> {
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s) }.ok().map(|_| s)
}

// ---------- GPU temperature (D3DKMT) ----------

/// KMTQAITYPE_ADAPTERPERFDATA; D3DKMT_ADAPTER_PERFDATA is 64 bytes, Temperature (tenths of °C) at 56.
const ADAPTER_PERF_DATA: i32 = 62;
const PERF_DATA_SIZE: usize = 64;
const TEMPERATURE_OFFSET: usize = 56;
const NOT_SUPPORTED: i32 = 0xC00000BBu32 as i32;
const INVALID_PARAMETER: i32 = 0xC000000Du32 as i32;
const FIRST_PAUSE: Duration = Duration::from_secs(5);
const LONGEST_PAUSE: Duration = Duration::from_secs(300);

#[repr(C)]
struct OpenAdapterFromLuid {
    luid: LUID,
    adapter: u32,
}

#[repr(C)]
struct QueryAdapterInfo {
    adapter: u32,
    kind: i32,
    data: *mut c_void,
    size: u32,
}

#[link(name = "gdi32")]
extern "system" {
    fn D3DKMTOpenAdapterFromLuid(open: *mut OpenAdapterFromLuid) -> i32;
    fn D3DKMTCloseAdapter(close: *mut u32) -> i32;
    fn D3DKMTQueryAdapterInfo(query: *mut QueryAdapterInfo) -> i32;
}

/// One adapter's temperature sensor: never asked again once the driver says it does not report it; after any other
/// failure asked again after a pause growing from 5 s to 5 min.
#[derive(Default)]
struct Sensor {
    handle: u32,
    never: bool,
    retry_at: Option<Instant>,
    pause: Duration,
}

impl Sensor {
    fn read(&mut self, luid: LUID, now: Instant) -> Option<f64> {
        if self.never || self.retry_at.is_some_and(|t| now < t) {
            return None;
        }
        unsafe {
            if self.handle == 0 {
                let mut open = OpenAdapterFromLuid { luid, adapter: 0 };
                if D3DKMTOpenAdapterFromLuid(&mut open) != 0 {
                    return self.wait(now);
                }
                self.handle = open.adapter;
            }
            let mut data = [0u64; PERF_DATA_SIZE / 8];
            let mut query = QueryAdapterInfo { adapter: self.handle, kind: ADAPTER_PERF_DATA, data: data.as_mut_ptr().cast(), size: PERF_DATA_SIZE as u32 };
            let status = D3DKMTQueryAdapterInfo(&mut query);
            if status == 0 {
                let bytes: &[u8] = std::slice::from_raw_parts(data.as_ptr().cast(), PERF_DATA_SIZE);
                let deci = u32::from_le_bytes(bytes[TEMPERATURE_OFFSET..TEMPERATURE_OFFSET + 4].try_into().unwrap());
                self.pause = Duration::ZERO;
                // Zero: no sensor, or an adapter just waking up; asked again shortly.
                if deci == 0 {
                    self.retry_at = Some(now + FIRST_PAUSE);
                    return None;
                }
                return Some(deci as f64 / 10.0);
            }
            let _ = D3DKMTCloseAdapter(&mut self.handle);
            self.handle = 0;
            if status == NOT_SUPPORTED || status == INVALID_PARAMETER {
                self.never = true;
                return None;
            }
        }
        self.wait(now)
    }

    fn close(&mut self) {
        if self.handle != 0 {
            unsafe {
                let _ = D3DKMTCloseAdapter(&mut self.handle);
            }
            self.handle = 0;
        }
    }

    fn wait(&mut self, now: Instant) -> Option<f64> {
        self.pause = (self.pause * 2).clamp(FIRST_PAUSE, LONGEST_PAUSE);
        self.retry_at = Some(now + self.pause);
        None
    }
}

// ---------- NVML ----------

#[derive(Serialize, Clone)]
pub struct NvmlGpu {
    name: String,
    /// Board power in watts.
    watts: Option<f64>,
    temp: Option<f64>,
}

type NvmlInit = unsafe extern "C" fn() -> i32;
type NvmlCount = unsafe extern "C" fn(*mut u32) -> i32;
type NvmlHandle = unsafe extern "C" fn(u32, *mut *mut c_void) -> i32;
type NvmlName = unsafe extern "C" fn(*mut c_void, *mut u8, u32) -> i32;
type NvmlPower = unsafe extern "C" fn(*mut c_void, *mut u32) -> i32;
type NvmlTemp = unsafe extern "C" fn(*mut c_void, u32, *mut u32) -> i32;

/// The NVIDIA driver's management library, only from System32 (where current drivers install it).
struct Nvml {
    count: NvmlCount,
    handle: NvmlHandle,
    name: NvmlName,
    power: NvmlPower,
    temp: NvmlTemp,
}

// Plain function pointers into a library that stays loaded.
unsafe impl Send for Nvml {}

impl Nvml {
    fn load() -> Option<Self> {
        unsafe {
            let lib: HMODULE = LoadLibraryExW(w!("nvml.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
            let f = |name: PCSTR| GetProcAddress(lib, name);
            let init: NvmlInit = std::mem::transmute(f(s!("nvmlInit_v2"))?);
            let nvml = Self {
                count: std::mem::transmute(f(s!("nvmlDeviceGetCount_v2"))?),
                handle: std::mem::transmute(f(s!("nvmlDeviceGetHandleByIndex_v2"))?),
                name: std::mem::transmute(f(s!("nvmlDeviceGetName"))?),
                power: std::mem::transmute(f(s!("nvmlDeviceGetPowerUsage"))?),
                temp: std::mem::transmute(f(s!("nvmlDeviceGetTemperature"))?),
            };
            (init() == 0).then_some(nvml)
        }
    }

    fn read(&self) -> Vec<NvmlGpu> {
        let mut list = Vec::new();
        unsafe {
            let mut n = 0u32;
            if (self.count)(&mut n) != 0 {
                return list;
            }
            for i in 0..n.min(8) {
                let mut dev = std::ptr::null_mut();
                if (self.handle)(i, &mut dev) != 0 {
                    continue;
                }
                let mut buf = [0u8; 96];
                let name = if (self.name)(dev, buf.as_mut_ptr(), buf.len() as u32) == 0 {
                    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                    String::from_utf8_lossy(&buf[..len]).into_owned()
                } else {
                    String::new()
                };
                let (mut mw, mut c) = (0u32, 0u32);
                let watts = ((self.power)(dev, &mut mw) == 0).then(|| mw as f64 / 1000.0);
                // Sensor 0: the GPU die.
                let temp = ((self.temp)(dev, 0, &mut c) == 0 && c > 0).then_some(c as f64);
                list.push(NvmlGpu { name, watts, temp });
            }
        }
        list
    }
}

// ---------- Battery ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatteryRaw {
    /// Windows.System.Power.BatteryStatus: 0 not present, 1 discharging, 2 idle, 3 charging.
    status: i32,
    /// Positive while charging, negative while discharging.
    rate_mw: Option<i32>,
    remaining_mwh: Option<i32>,
    full_mwh: Option<i32>,
    design_mwh: Option<i32>,
    /// None: unknown.
    ac: Option<bool>,
    /// Windows' own figures.
    percent: Option<u8>,
    life_secs: Option<u32>,
    saver: bool,
}

fn battery() -> Option<BatteryRaw> {
    let s = power_status()?;
    let mut raw = BatteryRaw {
        status: 0,
        rate_mw: None,
        remaining_mwh: None,
        full_mwh: None,
        design_mwh: None,
        ac: match s.ACLineStatus {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        },
        percent: (s.BatteryLifePercent <= 100).then_some(s.BatteryLifePercent),
        life_secs: (s.BatteryLifeTime != u32::MAX).then_some(s.BatteryLifeTime),
        saver: s.SystemStatusFlag & 1 != 0,
    };
    if let Ok(report) = Battery::AggregateBattery().and_then(|b| b.GetReport()) {
        raw.status = report.Status().map(|s| s.0).unwrap_or(0);
        raw.rate_mw = report.ChargeRateInMilliwatts().and_then(|v| v.Value()).ok();
        raw.remaining_mwh = report.RemainingCapacityInMilliwattHours().and_then(|v| v.Value()).ok();
        raw.full_mwh = report.FullChargeCapacityInMilliwattHours().and_then(|v| v.Value()).ok();
        raw.design_mwh = report.DesignCapacityInMilliwattHours().and_then(|v| v.Value()).ok();
    }
    Some(raw)
}

// ---------- Drives ----------

const DRIVES_EVERY: Duration = Duration::from_secs(10);
/// Asking a drive for its temperature sends it a command and takes it out of its deepest power state.
const DRIVE_TEMPS_EVERY: Duration = Duration::from_secs(30);
const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x2D1400;
const IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS: u32 = 0x560000;
const DEVICE_PROPERTY: u32 = 0;
const SEEK_PENALTY_PROPERTY: u32 = 7;
const TEMPERATURE_PROPERTY: u32 = 52;
const DRIVE_FIXED: u32 = 3;
/// A drive behind a RAID controller is never asked for its temperature: the controller's driver answers for it and may hang.
const BUS_RAID: u32 = 8;

#[derive(Default)]
struct DriveCache {
    value: Option<Drives>,
    read_at: Option<Instant>,
    temps_at: Option<Instant>,
    running: bool,
}

#[derive(Serialize, Clone, Default)]
pub struct Drives {
    volumes: Vec<Volume>,
    disks: Vec<Disk>,
}

#[derive(Serialize, Clone)]
pub struct Volume {
    /// "C:"
    letter: String,
    total: u64,
    free: u64,
    /// \\.\PhysicalDriveN; None when the volume spans drives.
    disk: Option<u32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    number: u32,
    model: String,
    /// STORAGE_BUS_TYPE.
    bus: u32,
    removable: bool,
    ssd: bool,
    /// °C as the drive reports it, with its own warning and critical thresholds.
    temp: Option<[i16; 3]>,
}

fn read_drives(temps: bool) -> Drives {
    let volumes = volumes();
    let mut numbers: Vec<u32> = volumes.iter().filter_map(|v| v.disk).collect();
    numbers.sort_unstable();
    numbers.dedup();
    let disks = numbers.into_iter().filter_map(|n| disk(n, temps)).collect();
    Drives { volumes, disks }
}

/// Every fixed lettered volume, each once; subst letters and volumes whose extents cannot be read (a VeraCrypt or
/// ImDisk volume lives inside another drive) are left out.
fn volumes() -> Vec<Volume> {
    let mut list = Vec::new();
    let mut seen = Vec::<String>::new();
    unsafe {
        let mut buf = [0u16; 512];
        let n = GetLogicalDriveStringsW(Some(&mut buf)) as usize;
        for root in buf[..n.min(buf.len())].split(|&c| c == 0).filter(|r| !r.is_empty()) {
            let root_s = String::from_utf16_lossy(root);
            let root_h = HSTRING::from(root_s.as_str());
            if GetDriveTypeW(&root_h) != DRIVE_FIXED {
                continue;
            }
            let letter = root_s.trim_end_matches('\\').to_string();
            let mut target = [0u16; 512];
            let len = QueryDosDeviceW(&HSTRING::from(letter.as_str()), Some(&mut target)) as usize;
            if len > 0 && String::from_utf16_lossy(&target[..len.min(4)]).starts_with("\\??\\") {
                continue;
            }
            let mut guid = [0u16; 64];
            if GetVolumeNameForVolumeMountPointW(&root_h, &mut guid).is_ok() {
                let g = String::from_utf16_lossy(&guid);
                if seen.contains(&g) {
                    continue;
                }
                seen.push(g);
            }
            let (mut total, mut free) = (0u64, 0u64);
            if GetDiskFreeSpaceExW(&root_h, None, Some(&mut total), Some(&mut free)).is_err() {
                continue;
            }
            let Some(disk) = extents(&letter) else { continue };
            list.push(Volume { letter, total, free, disk });
        }
    }
    list
}

fn open(path: &str) -> Option<HANDLE> {
    // No read or write access: a normal user may open volumes and drives this way.
    unsafe { CreateFileW(&HSTRING::from(path), 0, FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None).ok() }
}

/// Some(Some(n)): the volume lies on drive n; Some(None): it spans drives; None: unreadable.
fn extents(letter: &str) -> Option<Option<u32>> {
    let h = open(&format!("\\\\.\\{letter}"))?;
    // VOLUME_DISK_EXTENTS: count (u32), padding, then 24-byte DISK_EXTENTs with DiskNumber first.
    let mut out = [0u64; (8 + 24 * 32) / 8];
    let mut len = 0u32;
    let ok = unsafe { DeviceIoControl(h, IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS, None, 0, Some(out.as_mut_ptr().cast()), (out.len() * 8) as u32, Some(&mut len), None) };
    unsafe {
        let _ = CloseHandle(h);
    }
    if ok.is_err() || len < 32 {
        return None;
    }
    let bytes: &[u8] = unsafe { std::slice::from_raw_parts(out.as_ptr().cast(), out.len() * 8) };
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let count = u32_at(0) as usize;
    if count == 0 || 8 + count * 24 > len as usize {
        return None;
    }
    let first = u32_at(8);
    Some((1..count).all(|i| u32_at(8 + i * 24) == first).then_some(first))
}

/// STORAGE_PROPERTY_QUERY (PropertyId, QueryType 0) → the descriptor bytes.
fn property(h: HANDLE, id: u32) -> Option<Vec<u8>> {
    let query = [id, 0, 0];
    let mut out = vec![0u64; 128];
    let mut len = 0u32;
    unsafe {
        DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, Some(query.as_ptr().cast()), 12, Some(out.as_mut_ptr().cast()), (out.len() * 8) as u32, Some(&mut len), None).ok()?;
        Some(std::slice::from_raw_parts(out.as_ptr() as *const u8, len as usize).to_vec())
    }
}

fn disk(number: u32, temps: bool) -> Option<Disk> {
    let h = open(&format!("\\\\.\\PhysicalDrive{number}"))?;
    let result = (|| {
        // STORAGE_DEVICE_DESCRIPTOR: RemovableMedia at 10, ProductIdOffset at 16, BusType at 28.
        let d = property(h, DEVICE_PROPERTY).filter(|d| d.len() >= 32)?;
        let u32_at = |b: &[u8], o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        let at = u32_at(&d, 16) as usize;
        let model = if at > 0 && at < d.len() {
            let end = d[at..].iter().position(|&c| c == 0).map(|e| at + e).unwrap_or(d.len());
            String::from_utf8_lossy(&d[at..end]).trim().to_string()
        } else {
            String::new()
        };
        let bus = u32_at(&d, 28);
        let removable = d[10] != 0;
        // DEVICE_SEEK_PENALTY_DESCRIPTOR: IncursSeekPenalty at 8. A drive that does not say is taken for a spinning disk.
        let ssd = property(h, SEEK_PENALTY_PROPERTY).is_some_and(|p| p.len() >= 9 && p[8] == 0);
        // Hard disks are not asked (it could spin one up), nor drives behind RAID.
        let temp = (temps && ssd && bus != BUS_RAID && !removable)
            .then(|| property(h, TEMPERATURE_PROPERTY))
            .flatten()
            .filter(|t| t.len() >= 40 && u16::from_le_bytes([t[12], t[13]]) >= 1)
            // STORAGE_TEMPERATURE_DATA_DESCRIPTOR: Critical at 8, Warning at 10, then STORAGE_TEMPERATURE_INFO from 24 with
            // Temperature at +2; the first entry is the drive's own.
            .map(|t| [i16::from_le_bytes([t[26], t[27]]), i16::from_le_bytes([t[10], t[11]]), i16::from_le_bytes([t[8], t[9]])]);
        Some(Disk { number, model, bus, removable, ssd, temp })
    })();
    unsafe {
        let _ = CloseHandle(h);
    }
    result
}
