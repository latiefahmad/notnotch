//! CPU and GPU temperature and power from a monitoring program the user already runs, for PCs where Windows gives
//! NotNotch no CPU temperature: HWiNFO's shared memory ("Shared Memory Support"), else LibreHardwareMonitor's (or
//! OpenHardwareMonitor's) WMI namespace. Both are read on a thread of their own, so a hung WMI never stalls the
//! sampler, which only takes the last reading. Neither is ever written to.

use std::collections::HashMap;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Memory::{MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, VirtualQuery, FILE_MAP_READ, MEMORY_BASIC_INFORMATION};
use windows::Win32::System::Variant::{VariantClear, VariantToDouble, VariantToString, VARIANT};
use windows::Win32::System::Wmi::{IWbemClassObject, IWbemServices};

/// While neither program is found, they are looked for at most this often.
const LOOK_EVERY: Duration = Duration::from_secs(30);
/// A WMI query that takes longer counts as failed.
const WMI_TIMEOUT: Duration = Duration::from_secs(2);
/// A reading older than this (the thread stuck in WMI) is no reading.
const STALE: Duration = Duration::from_secs(10);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    /// The program's name, shown as the source.
    source: &'static str,
    cpu_temp: Option<f64>,
    cpu_watts: Option<f64>,
    gpus: Vec<Gpu>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Gpu {
    name: String,
    temp: Option<f64>,
    watts: Option<f64>,
}

#[derive(Default)]
pub struct External {
    wake: Option<SyncSender<()>>,
    latest: Arc<Mutex<Option<(Instant, Reading)>>>,
}

impl External {
    /// The last reading, and a nudge to the thread for the next one (started on the first call).
    pub fn read(&mut self) -> Option<Reading> {
        let latest = self.latest.clone();
        let wake = self.wake.get_or_insert_with(|| {
            // One pending nudge at most: polls never pile up behind a slow read.
            let (tx, rx) = sync_channel(1);
            thread::spawn(move || run(rx, latest));
            tx
        });
        let _ = wake.try_send(());
        let latest = self.latest.lock().ok()?;
        latest.as_ref().filter(|(at, _)| at.elapsed() < STALE).map(|(_, r)| r.clone())
    }
}

enum Source {
    HwInfo,
    /// The namespace's services and its hardware names by identifier.
    Wmi(&'static str, IWbemServices, HashMap<String, String>),
}

fn run(rx: Receiver<()>, latest: Arc<Mutex<Option<(Instant, Reading)>>>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut source: Option<Source> = None;
    let mut look_at = Instant::now();
    while rx.recv().is_ok() {
        let mut reading = match &source {
            Some(Source::HwInfo) => hwinfo(),
            Some(Source::Wmi(name, services, names)) => unsafe { wmi_read(name, services, names) },
            None => None,
        };
        if reading.is_none() {
            source = None;
            if Instant::now() >= look_at {
                look_at = Instant::now() + LOOK_EVERY;
                if let Some(r) = hwinfo() {
                    (source, reading) = (Some(Source::HwInfo), Some(r));
                } else if let Some((name, services, names)) = unsafe { wmi_connect() } {
                    reading = unsafe { wmi_read(name, &services, &names) };
                    source = reading.is_some().then_some(Source::Wmi(name, services, names));
                }
            }
        }
        if let Ok(mut l) = latest.lock() {
            *l = reading.map(|r| (Instant::now(), r));
        }
    }
}

// ---------- Picking the four values ----------

#[derive(PartialEq, Debug)]
enum Device {
    Cpu,
    Gpu(String),
}

#[derive(PartialEq, Clone, Copy, Debug)]
enum Kind {
    Temp,
    Power,
}

#[derive(Debug)]
struct Entry {
    device: Device,
    kind: Kind,
    label: String,
    value: f64,
}

/// Labels in order of preference, matched whole and without case.
struct Labels {
    cpu_temp: &'static [&'static str],
    cpu_power: &'static [&'static str],
    gpu_temp: &'static [&'static str],
    gpu_power: &'static [&'static str],
}

/// HWiNFO's original labels (a user's renames are ignored): Intel's package, AMD's Tctl/Tdie.
const HWINFO: Labels = Labels {
    cpu_temp: &["CPU Package", "CPU (Tctl/Tdie)", "CPU (Tdie)", "CPU (Tctl)", "CPU Die (average)"],
    cpu_power: &["CPU Package Power", "CPU PPT"],
    gpu_temp: &["GPU Temperature"],
    gpu_power: &["GPU Power", "GPU PPT", "GPU ASIC Power"],
};

const LHM: Labels = Labels {
    cpu_temp: &["CPU Package", "Core (Tctl/Tdie)", "Core (Tdie)", "Core (Tctl)"],
    cpu_power: &["CPU Package", "Package"],
    gpu_temp: &["GPU Core"],
    gpu_power: &["GPU Package", "GPU Power"],
};

fn pick(source: &'static str, entries: &[Entry], labels: &Labels) -> Reading {
    let find = |device: &Device, kind: Kind, wanted: &[&str]| {
        wanted.iter().find_map(|l| entries.iter().find(|e| &e.device == device && e.kind == kind && e.label.eq_ignore_ascii_case(l)).map(|e| e.value))
    };
    let mut gpus: Vec<Gpu> = Vec::new();
    for e in entries {
        if let Device::Gpu(name) = &e.device {
            if !gpus.iter().any(|g| &g.name == name) {
                gpus.push(Gpu { name: name.clone(), temp: find(&e.device, Kind::Temp, labels.gpu_temp), watts: find(&e.device, Kind::Power, labels.gpu_power) });
            }
        }
    }
    Reading {
        source,
        cpu_temp: find(&Device::Cpu, Kind::Temp, labels.cpu_temp),
        cpu_watts: find(&Device::Cpu, Kind::Power, labels.cpu_power),
        gpus,
    }
}

// ---------- HWiNFO ----------

/// "HWiS"; HWiNFO writes "DEAD" when it stops sharing.
const SIGNATURE: u32 = u32::from_le_bytes(*b"HWiS");
/// HWiNFO_SENSORS_SHARED_MEM2 (packed): signature, version, revision, poll time (8 bytes), then offset, element size
/// and count of the sensor section at 20 and of the reading section at 32.
const HEADER: usize = 44;
/// Sensor element: id, instance, original name (128), user name (128).
const SENSOR_MIN: usize = 264;
/// Reading element: type, sensor index, id, original label (128), user label (128), unit (16), then value at 284.
const READING_MIN: usize = 316;
const TYPE_TEMP: u32 = 1;
const TYPE_POWER: u32 = 5;

fn hwinfo() -> Option<Reading> {
    let bytes = hwinfo_bytes()?;
    Some(pick("HWiNFO", &hwinfo_entries(&bytes)?, &HWINFO))
}

/// A copy of the whole mapping, so the checks and the reads see the same bytes while HWiNFO keeps writing.
fn hwinfo_bytes() -> Option<Vec<u8>> {
    unsafe {
        let h = OpenFileMappingW(FILE_MAP_READ.0, false, w!("Global\\HWiNFO_SENS_SM2")).ok()?;
        let view = MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0);
        let _ = CloseHandle(h);
        if view.Value.is_null() {
            return None;
        }
        let mut info = MEMORY_BASIC_INFORMATION::default();
        let ok = VirtualQuery(Some(view.Value), &mut info, size_of::<MEMORY_BASIC_INFORMATION>()) != 0;
        let bytes = ok.then(|| std::slice::from_raw_parts(view.Value as *const u8, info.RegionSize).to_vec());
        let _ = UnmapViewOfFile(view);
        bytes
    }
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

/// A NUL-terminated ANSI string; the labels matched are ASCII.
fn text(b: &[u8]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end]).trim().to_string()
}

/// Every CPU and GPU temperature and power reading, or None when anything in the layout does not add up.
fn hwinfo_entries(buf: &[u8]) -> Option<Vec<Entry>> {
    if buf.len() < HEADER || u32_at(buf, 0) != SIGNATURE {
        return None;
    }
    let field = |at: usize| u32_at(buf, at) as usize;
    let (s_at, s_size, s_count) = (field(20), field(24), field(28));
    let (r_at, r_size, r_count) = (field(32), field(36), field(40));
    if s_size < SENSOR_MIN || r_size < READING_MIN {
        return None;
    }
    let fits = |at: usize, size: usize, count: usize| size.checked_mul(count).and_then(|n| n.checked_add(at)).is_some_and(|end| at >= HEADER && end <= buf.len());
    if !fits(s_at, s_size, s_count) || !fits(r_at, r_size, r_count) {
        return None;
    }
    let mut entries = Vec::new();
    for i in 0..r_count {
        let r = &buf[r_at + i * r_size..][..r_size];
        let sensor = u32_at(r, 4) as usize;
        if sensor >= s_count {
            return None;
        }
        let kind = match u32_at(r, 0) {
            TYPE_TEMP => Kind::Temp,
            TYPE_POWER => Kind::Power,
            _ => continue,
        };
        let name = text(&buf[s_at + sensor * s_size + 8..][..128]);
        // "CPU [#0]: AMD Ryzen 7 5800X: Enhanced", "GPU [#0]: NVIDIA GeForce RTX 3080: "
        let device = if name.starts_with("CPU [") {
            Device::Cpu
        } else if let Some(rest) = name.strip_prefix("GPU [").and_then(|n| n.split_once("]: ")).map(|(_, r)| r) {
            Device::Gpu(rest.split(':').next().unwrap_or(rest).trim().to_string())
        } else {
            continue;
        };
        let unit = text(&r[268..284]);
        let mut value = f64::from_le_bytes(r[284..292].try_into().unwrap());
        match kind {
            // HWiNFO shares values in the unit it shows.
            Kind::Temp if unit.ends_with('F') => value = (value - 32.0) * 5.0 / 9.0,
            Kind::Power if unit != "W" => continue,
            _ => {}
        }
        if value.is_finite() {
            entries.push(Entry { device, kind, label: text(&r[12..140]), value });
        }
    }
    Some(entries)
}

// ---------- LibreHardwareMonitor / OpenHardwareMonitor ----------

const NAMESPACES: [(&str, &str); 2] = [(r"ROOT\LibreHardwareMonitor", "LibreHardwareMonitor"), (r"ROOT\OpenHardwareMonitor", "OpenHardwareMonitor")];

unsafe fn wmi_connect() -> Option<(&'static str, IWbemServices, HashMap<String, String>)> {
    for (namespace, name) in NAMESPACES {
        let Ok(services) = (unsafe { crate::brightness::wmi(namespace) }) else { continue };
        // Hardware names change only with the hardware: asked once, for matching GPUs to the adapters.
        let rows = unsafe { rows(&services, "SELECT Identifier, Name FROM Hardware") }?;
        let names = rows.iter().filter_map(|o| Some((unsafe { prop_text(o, w!("Identifier")) }?, unsafe { prop_text(o, w!("Name")) }?))).collect();
        return Some((name, services, names));
    }
    None
}

/// One query per refresh.
unsafe fn wmi_read(source: &'static str, services: &IWbemServices, names: &HashMap<String, String>) -> Option<Reading> {
    let rows = unsafe { rows(services, "SELECT Parent, Name, SensorType, Value FROM Sensor WHERE SensorType='Temperature' OR SensorType='Power'") }?;
    let entries: Vec<Entry> = rows
        .iter()
        .filter_map(|o| unsafe {
            let kind = if prop_text(o, w!("SensorType"))? == "Temperature" { Kind::Temp } else { Kind::Power };
            wmi_entry(&prop_text(o, w!("Parent"))?, prop_text(o, w!("Name"))?, kind, prop_number(o, w!("Value"))?, names)
        })
        .collect();
    Some(pick(source, &entries, &LHM))
}

/// Parents: "/intelcpu/0", "/amdcpu/0"; "/gpu-nvidia/0", "/gpu-amd/0", "/gpu-intel/0" (OpenHardwareMonitor: "/nvidiagpu/0", "/atigpu/0").
fn wmi_entry(parent: &str, label: String, kind: Kind, value: f64, names: &HashMap<String, String>) -> Option<Entry> {
    let device = if parent.contains("cpu/") {
        Device::Cpu
    } else if parent.contains("gpu") {
        Device::Gpu(names.get(parent).cloned().unwrap_or_else(|| parent.to_string()))
    } else {
        return None;
    };
    value.is_finite().then_some(Entry { device, kind, label, value })
}

/// Every row, or None on an error or when the rows take longer than `WMI_TIMEOUT` altogether.
unsafe fn rows(services: &IWbemServices, wql: &str) -> Option<Vec<IWbemClassObject>> {
    unsafe {
        let list = crate::brightness::query(services, wql, false).ok()?;
        let deadline = Instant::now() + WMI_TIMEOUT;
        let mut out = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            let mut batch: [Option<IWbemClassObject>; 32] = Default::default();
            let mut returned = 0;
            let hr = list.Next(left.as_millis() as i32, &mut batch, &mut returned);
            out.extend(batch.into_iter().take(returned as usize).flatten());
            match hr.0 {
                // WBEM_S_NO_ERROR: a full batch, maybe more.
                0 => continue,
                // WBEM_S_FALSE: the last rows.
                1 => return Some(out),
                // WBEM_S_TIMEDOUT or an error.
                _ => return None,
            }
        }
    }
}

unsafe fn prop_text(object: &IWbemClassObject, name: PCWSTR) -> Option<String> {
    unsafe {
        let mut value = VARIANT::default();
        object.Get(name, 0, &mut value, None, None).ok()?;
        let mut buf = [0u16; 256];
        let ok = VariantToString(&value, &mut buf).is_ok();
        let _ = VariantClear(&mut value);
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        ok.then(|| String::from_utf16_lossy(&buf[..len]))
    }
}

unsafe fn prop_number(object: &IWbemClassObject, name: PCWSTR) -> Option<f64> {
    unsafe {
        let mut value = VARIANT::default();
        object.Get(name, 0, &mut value, None, None).ok()?;
        let n = VariantToDouble(&value).ok();
        let _ = VariantClear(&mut value);
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(buf: &mut [u8], at: usize, bytes: &[u8]) {
        buf[at..at + bytes.len()].copy_from_slice(bytes);
    }

    /// A shared memory image with the given sensors and readings (sensor index, type, label, unit, value).
    fn image(sensors: &[&str], readings: &[(u32, u32, &str, &str, f64)]) -> Vec<u8> {
        let (s_at, s_size, r_size) = (HEADER, SENSOR_MIN + 128, READING_MIN + 144);
        let r_at = s_at + s_size * sensors.len();
        let mut buf = vec![0u8; r_at + r_size * readings.len()];
        put(&mut buf, 0, &SIGNATURE.to_le_bytes());
        for (at, v) in [(20, s_at), (24, s_size), (28, sensors.len()), (32, r_at), (36, r_size), (40, readings.len())] {
            put(&mut buf, at, &(v as u32).to_le_bytes());
        }
        for (i, name) in sensors.iter().enumerate() {
            put(&mut buf, s_at + i * s_size + 8, name.as_bytes());
        }
        for (i, (sensor, kind, label, unit, value)) in readings.iter().enumerate() {
            let at = r_at + i * r_size;
            put(&mut buf, at, &kind.to_le_bytes());
            put(&mut buf, at + 4, &sensor.to_le_bytes());
            put(&mut buf, at + 12, label.as_bytes());
            put(&mut buf, at + 268, unit.as_bytes());
            put(&mut buf, at + 284, &value.to_le_bytes());
        }
        buf
    }

    fn sample() -> Vec<u8> {
        image(
            &["System: ASUS", "CPU [#0]: AMD Ryzen 7 5800X: Enhanced", "GPU [#0]: NVIDIA GeForce RTX 3080: "],
            &[
                (0, TYPE_TEMP, "CPU Package", "\u{b0}C", 30.0),
                (1, TYPE_TEMP, "CPU Die (average)", "\u{b0}C", 60.0),
                (1, TYPE_TEMP, "CPU (Tctl/Tdie)", "\u{b0}C", 64.5),
                (1, TYPE_POWER, "CPU Package Power", "W", 48.2),
                (1, 2, "CPU Core Voltage", "V", 1.2),
                (2, TYPE_TEMP, "GPU Temperature", "\u{b0}F", 140.0),
                (2, TYPE_POWER, "GPU Power", "W", 220.0),
            ],
        )
    }

    #[test]
    fn hwinfo_layout() {
        let r = pick("HWiNFO", &hwinfo_entries(&sample()).unwrap(), &HWINFO);
        // The board's "CPU Package" is not the processor's; Tctl/Tdie beats the die average.
        assert_eq!(r.cpu_temp, Some(64.5));
        assert_eq!(r.cpu_watts, Some(48.2));
        assert_eq!(r.gpus, vec![Gpu { name: "NVIDIA GeForce RTX 3080".into(), temp: Some(60.0), watts: Some(220.0) }]);
    }

    #[test]
    fn hwinfo_rejects_bad_layouts() {
        let good = sample();
        assert!(hwinfo_entries(&good[..good.len() - 1]).is_none(), "truncated");
        assert!(hwinfo_entries(&good[..HEADER - 1]).is_none(), "no header");
        let mut dead = good.clone();
        put(&mut dead, 0, b"DEAD");
        assert!(hwinfo_entries(&dead).is_none(), "wrong signature");
        let mut many = good.clone();
        put(&mut many, 40, &u32::MAX.to_le_bytes());
        assert!(hwinfo_entries(&many).is_none(), "reading count past the end");
        let mut huge = good.clone();
        put(&mut huge, 24, &u32::MAX.to_le_bytes());
        put(&mut huge, 28, &u32::MAX.to_le_bytes());
        assert!(hwinfo_entries(&huge).is_none(), "huge element size and count");
        let mut small = good.clone();
        put(&mut small, 36, &100u32.to_le_bytes());
        assert!(hwinfo_entries(&small).is_none(), "elements smaller than the layout");
        let mut orphan = good;
        let first = u32_at(&orphan, 32) as usize;
        put(&mut orphan, first + 4, &9u32.to_le_bytes());
        assert!(hwinfo_entries(&orphan).is_none(), "reading of a sensor that does not exist");
    }

    #[test]
    fn labels_by_preference() {
        let e = |device: Device, kind, label: &str, value| Entry { device, kind, label: label.into(), value };
        let gpu = || Device::Gpu("Radeon RX 7800 XT".into());
        let r = pick(
            "LibreHardwareMonitor",
            &[e(Device::Cpu, Kind::Power, "Package", 30.0), e(Device::Cpu, Kind::Power, "CPU Package", 35.0), e(Device::Cpu, Kind::Temp, "core (tctl/tdie)", 70.0), e(gpu(), Kind::Temp, "GPU Hot Spot", 90.0), e(gpu(), Kind::Temp, "GPU Core", 62.0)],
            &LHM,
        );
        assert_eq!((r.cpu_temp, r.cpu_watts), (Some(70.0), Some(35.0)));
        assert_eq!(r.gpus, vec![Gpu { name: "Radeon RX 7800 XT".into(), temp: Some(62.0), watts: None }]);
        let names = HashMap::from([("/gpu-nvidia/0".to_string(), "NVIDIA GeForce RTX 4070".to_string())]);
        assert_eq!(wmi_entry("/gpu-nvidia/0", "GPU Core".into(), Kind::Temp, 50.0, &names).unwrap().device, Device::Gpu("NVIDIA GeForce RTX 4070".into()));
        assert_eq!(wmi_entry("/amdcpu/0", "Package".into(), Kind::Power, 20.0, &names).unwrap().device, Device::Cpu);
        assert!(wmi_entry("/lpc/nct6798d", "CPU Core".into(), Kind::Temp, 40.0, &names).is_none(), "board sensors are skipped");
    }
}
