// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck/Native/ProcessLoopbackCapture.cs.
//! What one player renders, for the equalizer: process loopback capture of the process
//! behind the shown media app, its child processes included.
//!
//! Needs Windows build 20348 or later (Windows 11 has it); on older builds audio.rs
//! uses the whole-system loopback and never tries this. Samples stay
//! in memory and are dropped after the FFT. Create, read and drop on one MTA thread.

use std::sync::{mpsc, OnceLock};
use std::time::Duration;

use windows::core::{implement, w, Interface, IUnknown, Ref, HRESULT};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
use windows::Win32::Media::Audio::{
    eRender, ActivateAudioInterfaceAsync, AudioSessionStateActive, IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    DEVICE_STATE_ACTIVE, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{CoCreateInstance, BLOB, CLSCTX_ALL};
use windows::Win32::System::Variant::VT_BLOB;

use crate::mixer::{file_name, matches, process_path};

/// The engine converts whatever the process plays to this.
pub const RATE: u32 = 44_100;
const CHANNELS: u16 = 2;
/// 100 ms: the thread drains every 25 ms, so nothing is lost in between.
const BUFFER: i64 = 1_000_000;

/// First Windows build with process loopback.
const MIN_BUILD: u32 = 20348;

/// Is process loopback available? Read once from the registry; unknown counts as no.
pub fn supported() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| unsafe {
        let mut buf = [0u16; 16];
        let mut size = std::mem::size_of_val(&buf) as u32;
        let ok = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"),
            w!("CurrentBuildNumber"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        )
        .is_ok();
        let text = String::from_utf16_lossy(&buf[..(size as usize / 2).saturating_sub(1)]);
        ok && text.trim().parse::<u32>().is_ok_and(|b| b >= MIN_BUILD)
    })
}

/// A capture of the player behind the media app ID, if this Windows has process loopback and the player has a session.
pub fn capture(app_id: &str) -> Option<ProcessCapture> {
    if !supported() {
        return None;
    }
    process_of(app_id).and_then(ProcessCapture::start)
}

/// Process ID of the audio session that belongs to the media app ID, a playing one first.
/// Looks at every active output device, not only the default one.
pub fn process_of(app_id: &str) -> Option<u32> {
    if app_id.is_empty() {
        return None;
    }
    unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let list = devices.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).ok()?;
        let mut idle = None;
        for d in 0..list.GetCount().unwrap_or(0) {
            let Ok(device) = list.Item(d) else { continue };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
            for i in 0..sessions.GetCount().unwrap_or(0) {
                let Some(control) = sessions.GetSession(i).ok().and_then(|c| c.cast::<IAudioSessionControl2>().ok()) else { continue };
                let Some(pid) = control.GetProcessId().ok().filter(|&p| p != 0) else { continue };
                if !process_path(pid).is_some_and(|path| matches(app_id, &file_name(&path))) {
                    continue;
                }
                if control.GetState().is_ok_and(|s| s == AudioSessionStateActive) {
                    return Some(pid);
                }
                idle.get_or_insert(pid);
            }
        }
        idle
    }
}

/// Signals when the activation is done; the result is read on the calling thread.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Done(mpsc::SyncSender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Done_Impl {
    fn ActivateCompleted(&self, _operation: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        let _ = self.0.try_send(());
        Ok(())
    }
}

pub struct ProcessCapture {
    pub pid: u32,
    client: IAudioClient,
    capture: IAudioCaptureClient,
}

impl ProcessCapture {
    pub fn start(pid: u32) -> Option<Self> {
        unsafe {
            let mut params = Box::new(AUDIOCLIENT_ACTIVATION_PARAMS {
                ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                    ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                        TargetProcessId: pid,
                        ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                    },
                },
            });
            // A PROPVARIANT holding a VT_BLOB that points at the parameters. ManuallyDrop: the windows crate's Drop for
            // PROPVARIANT calls PropVariantClear, which would CoTaskMemFree the Box and corrupt the heap on its own drop.
            let variant = std::mem::ManuallyDrop::new(PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                        vt: VT_BLOB,
                        wReserved1: 0,
                        wReserved2: 0,
                        wReserved3: 0,
                        Anonymous: PROPVARIANT_0_0_0 {
                            blob: BLOB { cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: &mut *params as *mut _ as *mut u8 },
                        },
                    }),
                },
            });
            let (tx, rx) = mpsc::sync_channel(1);
            let handler: IActivateAudioInterfaceCompletionHandler = Done(tx).into();
            let operation =
                ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*variant), &handler).ok()?;
            if rx.recv_timeout(Duration::from_secs(2)).is_err() {
                // Still running: it may read the parameters later, so they must stay valid.
                std::mem::forget(params);
                return None;
            }
            let mut result = HRESULT(0);
            let mut activated: Option<IUnknown> = None;
            operation.GetActivateResult(&mut result, &mut activated).ok()?;
            result.ok().ok()?;
            let client: IAudioClient = activated?.cast().ok()?;

            let block = CHANNELS * 2;
            let format = WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_PCM as u16,
                nChannels: CHANNELS,
                nSamplesPerSec: RATE,
                nAvgBytesPerSec: RATE * block as u32,
                nBlockAlign: block,
                wBitsPerSample: 16,
                cbSize: 0,
            };
            client
                .Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, BUFFER, 0, &format, None)
                .ok()?;
            let capture: IAudioCaptureClient = client.GetService().ok()?;
            client.Start().ok()?;
            Some(Self { pid, client, capture })
        }
    }

    /// Moves every waiting packet, as mono samples, to `push`. False when the stream failed.
    pub fn drain(&self, push: &mut dyn FnMut(&mut dyn Iterator<Item = f32>)) -> bool {
        unsafe {
            loop {
                match self.capture.GetNextPacketSize() {
                    Ok(0) => return true,
                    Ok(_) => {}
                    Err(_) => return false,
                }
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                if self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None).is_err() {
                    return false;
                }
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null();
                if silent {
                    push(&mut std::iter::repeat_n(0.0, frames as usize));
                } else {
                    let pcm = std::slice::from_raw_parts(data as *const i16, frames as usize * CHANNELS as usize);
                    push(&mut pcm.chunks(CHANNELS as usize).map(|f| f.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / CHANNELS as f32));
                }
                if self.capture.ReleaseBuffer(frames).is_err() {
                    return false;
                }
            }
        }
    }
}

impl Drop for ProcessCapture {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}
