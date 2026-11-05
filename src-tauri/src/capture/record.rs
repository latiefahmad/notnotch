//! Screen recording: Windows.Graphics.Capture delivers frames of a monitor or a window
//! as D3D11 textures; the Media Foundation Sink Writer encodes them to H.264 in an MP4,
//! with the audio track from `audio.rs` as AAC. No ffmpeg. The MP4 is fragmented, so a
//! file cut off by a crash still plays.
//!
//! The GPU path hands the textures to the encoder through a DXGI device manager. If the
//! writer cannot start that way (old driver, no hardware encoder), it starts again with
//! frames read back to memory, which Media Foundation converts and encodes in software.
//!
//! Timestamps come from the frames themselves (QPC), shifted by the pause clock, so
//! pauses leave no gap and audio and video share one timeline.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use windows::core::{factory, Interface, Result, HSTRING};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureAccess, GraphicsCaptureAccessKind, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
use windows::Win32::Foundation::{E_FAIL, E_POINTER, HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use super::math::{bitrate, copy_box, even_size, Clock, Pacer};

pub const AUDIO_RATE: u32 = 48_000;
pub const AUDIO_CHANNELS: u32 = 2;

pub enum Source {
    Monitor(HMONITOR),
    Window(HWND),
}

/// State the frame handler and the audio thread share.
pub struct Shared {
    pub clock: Mutex<Clock>,
    writer: Mutex<Writer>,
}

struct Writer {
    /// Taken (and released) when the recording stops, so the file is closed right after.
    sink: Option<IMFSinkWriter>,
    video: u32,
    audio: Option<u32>,
    gpu: bool,
    done: bool,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    staging: Option<ID3D11Texture2D>,
    size: (u32, u32),
    pacer: Pacer,
    /// The last frame seen while paused (a copy), written when recording resumes.
    held: Option<(ID3D11Texture2D, (u32, u32))>,
    /// Media time of the last frame written, and of the last stream tick sent.
    last_video: Option<i64>,
    last_tick: i64,
}

// Media Foundation and D3D11 (with multithread protection on) are free-threaded; every use goes through the mutex.
unsafe impl Send for Writer {}

pub struct Recorder {
    session: GraphicsCaptureSession,
    pool: Direct3D11CaptureFramePool,
    item: GraphicsCaptureItem,
    pub shared: Arc<Shared>,
    pub has_audio: bool,
    /// Frames go to the encoder as GPU textures (false: read back to memory). Read by the live test.
    #[cfg_attr(not(test), allow(dead_code))]
    pub gpu: bool,
}

// WinRT capture objects are agile.
unsafe impl Send for Recorder {}

/// Called once when the recording has to end on its own: None when the window or monitor
/// went away, Some("video") when capturing or encoding failed. Runs on a system thread.
pub type OnEnd = Arc<dyn Fn(Option<&'static str>) + Send + Sync>;

/// A COM out-parameter that came back empty although the call succeeded.
fn out<T>(v: Option<T>) -> Result<T> {
    v.ok_or_else(|| windows::core::Error::from(E_POINTER))
}

/// The GPU, or WARP (software rendering) on machines without a usable one.
unsafe fn d3d_device() -> Result<(ID3D11Device, ID3D11DeviceContext)> {
    let mut last = None;
    for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
        let (mut device, mut context) = (None, None);
        let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | if driver == D3D_DRIVER_TYPE_HARDWARE { D3D11_CREATE_DEVICE_VIDEO_SUPPORT } else { D3D11_CREATE_DEVICE_FLAG(0) };
        match unsafe { D3D11CreateDevice(None, driver, HMODULE::default(), flags, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context)) } {
            Ok(()) => return Ok((out(device)?, out(context)?)),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| E_FAIL.into()))
}

/// Starts capturing `source` into `path` (an .mp4). Media Foundation must be started on this thread's apartment.
/// `border`: keep Windows' yellow capture frame (turned off only when Windows allows it).
pub fn start(source: Source, path: &Path, fps: u32, audio: bool, border: bool, now: fn() -> i64, on_end: OnEnd) -> Result<Recorder> {
    unsafe {
        let (device, context) = d3d_device()?;
        // The encoder uses the device from its own threads.
        let _ = device.cast::<ID3D11Multithread>()?.SetMultithreadProtected(true);
        let winrt: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>()?)?.cast()?;

        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = match source {
            Source::Monitor(m) => interop.CreateForMonitor(m)?,
            Source::Window(w) => interop.CreateForWindow(w)?,
        };
        let item_size = item.Size()?;
        let size = even_size(item_size.Width.max(2) as u32, item_size.Height.max(2) as u32);

        let mut token = 0;
        let mut manager = None;
        MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
        let manager = out(manager)?;
        manager.ResetDevice(&device, token)?;
        let (sink, video, audio_stream, gpu) = match open_sink(path, size, fps, audio, Some(&manager)) {
            Ok((s, v, a)) => (s, v, a, true),
            Err(_) => {
                let (s, v, a) = open_sink(path, size, fps, audio, None)?;
                (s, v, a, false)
            }
        };

        let shared = Arc::new(Shared {
            clock: Mutex::new(Clock::new(now())),
            writer: Mutex::new(Writer {
                sink: Some(sink),
                video,
                audio: audio_stream,
                gpu,
                done: false,
                device,
                context,
                staging: None,
                size,
                pacer: Pacer::new(fps),
                held: None,
                last_video: None,
                last_tick: -1,
            }),
        });

        // Ends the recording once, whichever comes first: the source closing or a failure.
        let ended = Arc::new(AtomicBool::new(false));
        let end = {
            let ended = ended.clone();
            move |why: Option<&'static str>| {
                if !ended.swap(true, Ordering::SeqCst) {
                    on_end(why);
                }
            }
        };
        let end_closed = end.clone();

        // Two buffers: one being copied, one being filled.
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, item_size)?;
        let frames = shared.clone();
        pool.FrameArrived(&TypedEventHandler::new(move |pool: windows::core::Ref<Direct3D11CaptureFramePool>, _| {
            if let Some(pool) = pool.as_ref() {
                let result = pool.TryGetNextFrame().and_then(|frame| {
                    let r = frames.on_frame(&frame);
                    let _ = frame.Close();
                    r
                });
                // Device lost, encoder error: stop and say why, instead of recording nothing.
                // No frame waiting comes back as an error with a success code: not a failure.
                if result.is_err_and(|e| e.code().is_err()) {
                    end(Some("video"));
                }
            }
            Ok(())
        }))?;
        item.Closed(&TypedEventHandler::new(move |_, _| {
            end_closed(None);
            Ok(())
        }))?;

        let session = pool.CreateCaptureSession(&item)?;
        let _ = session.SetIsCursorCaptureEnabled(true);
        // The yellow frame Windows 11 draws around a capture shows honestly what is recorded; it goes only on request and with Windows' permission.
        if !border {
            let allowed = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless).and_then(|op| op.join());
            if allowed == Ok(AppCapabilityAccessStatus::Allowed) {
                let _ = session.SetIsBorderRequired(false);
            }
        }
        // The clock starts with the capture, not before the slow setup above (device, encoder).
        *shared.clock.lock().unwrap() = Clock::new(now());
        session.StartCapture()?;
        Ok(Recorder { session, pool, item, shared, has_audio: audio_stream.is_some(), gpu })
    }
}

impl Recorder {
    /// Stops the capture and writes the file's index. Call after the audio thread has finished.
    pub fn stop(self) -> Result<()> {
        let _ = self.session.Close();
        let _ = self.pool.Close();
        drop(self.item);
        let sink = {
            let mut w = self.shared.writer.lock().unwrap();
            w.done = true;
            w.held = None;
            w.sink.take()
        };
        // The writer is released here, not when the last frame handler lets go of `shared`.
        sink.map_or(Ok(()), |s| unsafe { s.Finalize() })
    }
}

impl Shared {
    fn on_frame(&self, frame: &windows::Graphics::Capture::Direct3D11CaptureFrame) -> Result<()> {
        let t = frame.SystemRelativeTime()?.Duration;
        // Writer first, then the clock (as in `resume`): a pause cannot end between reading it and holding the frame.
        let mut w = self.writer.lock().unwrap();
        if w.done {
            return Ok(());
        }
        let (media, paused) = {
            let clock = self.clock.lock().unwrap();
            (clock.media(t), clock.paused())
        };
        let content = frame.ContentSize()?;
        let content = (content.Width.max(0) as u32, content.Height.max(0) as u32);
        let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
        let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };
        match media {
            Some(media) if w.pacer.admit(media) => w.write_frame(&texture, content, media),
            // The screen may not change again after resuming, so the frame from the pause is kept.
            None if paused => w.hold(&texture, content),
            _ => Ok(()),
        }
    }

    /// Resumes the clock and writes the frame held during the pause at the resume point.
    pub fn resume(&self, now: i64) {
        let mut w = self.writer.lock().unwrap();
        let media = {
            let mut clock = self.clock.lock().unwrap();
            clock.resume(now);
            clock.elapsed(now)
        };
        if let (Some((texture, content)), false) = (w.held.take(), w.done) {
            // Written whatever the pacer says, and the schedule restarts from it.
            w.pacer.restart(media);
            let _ = w.write_frame(&texture, content, media);
        }
    }

    /// Called every audio tick: on a still screen no frames come, and the writer is told
    /// about the gap twice a second, so the audio is not held back waiting for video.
    pub fn tick(&self, media: i64) {
        let mut w = self.writer.lock().unwrap();
        let Some(last) = w.last_video else { return };
        if w.done || media - last.max(w.last_tick) < 5_000_000 {
            return;
        }
        w.last_tick = media;
        if let Some(sink) = &w.sink {
            let _ = unsafe { sink.SendStreamTick(w.video, media) };
        }
    }

    /// Writes interleaved 16-bit stereo PCM at media time `time`.
    pub fn write_audio(&self, time: i64, samples: &[i16]) -> Result<()> {
        let w = self.writer.lock().unwrap();
        let (Some(stream), Some(sink), false) = (w.audio, w.sink.as_ref(), w.done) else { return Ok(()) };
        unsafe { write_pcm(sink, stream, time, samples) }
    }
}

impl super::audio::AudioSink for Shared {
    fn clock(&self) -> &Mutex<Clock> {
        &self.clock
    }
    fn write_audio(&self, time: i64, samples: &[i16]) -> Result<()> {
        Shared::write_audio(self, time, samples)
    }
    fn tick(&self, media: i64) {
        Shared::tick(self, media)
    }
}

/// Interleaved 16-bit stereo PCM at media time `time` into the writer's audio `stream` (screen recordings and voice.rs).
pub(super) unsafe fn write_pcm(sink: &IMFSinkWriter, stream: u32, time: i64, samples: &[i16]) -> Result<()> {
    if samples.is_empty() {
        return Ok(());
    }
    unsafe {
        let bytes = std::mem::size_of_val(samples) as u32;
        let buffer = MFCreateMemoryBuffer(bytes)?;
        let mut ptr = std::ptr::null_mut();
        buffer.Lock(&mut ptr, None, None)?;
        std::ptr::copy_nonoverlapping(samples.as_ptr() as *const u8, ptr, bytes as usize);
        buffer.Unlock()?;
        buffer.SetCurrentLength(bytes)?;
        let sample = MFCreateSample()?;
        sample.AddBuffer(&buffer)?;
        sample.SetSampleTime(time)?;
        sample.SetSampleDuration(super::math::to_time((samples.len() / AUDIO_CHANNELS as usize) as i64, AUDIO_RATE as i64))?;
        sink.WriteSample(stream, &sample)
    }
}

/// An AAC stream (192 kbit/s, 48 kHz stereo) fed with 16-bit PCM, added to `sink` before it begins writing.
pub(super) unsafe fn add_audio_stream(sink: &IMFSinkWriter) -> Result<u32> {
    unsafe {
        let block = AUDIO_CHANNELS * 2;
        let out = MFCreateMediaType()?;
        out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        out.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
        out.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        out.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, AUDIO_RATE)?;
        out.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, AUDIO_CHANNELS)?;
        // 192 kbit/s, one of the four rates the AAC encoder accepts.
        out.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)?;
        let stream = sink.AddStream(&out)?;
        let input = MFCreateMediaType()?;
        input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        input.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
        input.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        input.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, AUDIO_RATE)?;
        input.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, AUDIO_CHANNELS)?;
        input.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, block)?;
        input.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AUDIO_RATE * block)?;
        sink.SetInputMediaType(stream, &input, None)?;
        Ok(stream)
    }
}

impl Writer {
    /// Copies `src` into the held texture (made once, the size of the capture buffers).
    fn hold(&mut self, src: &ID3D11Texture2D, content: (u32, u32)) -> Result<()> {
        unsafe {
            if self.held.is_none() {
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                src.GetDesc(&mut desc);
                desc.Usage = D3D11_USAGE_DEFAULT;
                desc.BindFlags = 0;
                desc.CPUAccessFlags = 0;
                desc.MiscFlags = 0;
                let mut t = None;
                self.device.CreateTexture2D(&desc, None, Some(&mut t))?;
                self.held = Some((out(t)?, content));
            }
            if let Some((held, size)) = self.held.as_mut() {
                self.context.CopyResource(&*held, src);
                *size = content;
            }
        }
        Ok(())
    }

    fn write_frame(&mut self, src: &ID3D11Texture2D, content: (u32, u32), time: i64) -> Result<()> {
        // Never behind a stream tick or the last frame: the writer needs rising timestamps.
        if time <= self.last_tick || self.last_video.is_some_and(|last| time <= last) {
            return Ok(());
        }
        let (tw, th) = self.size;
        let (cw, ch) = copy_box(content, self.size);
        unsafe {
            // A new texture per frame: the encoder may still hold the last one.
            let desc = D3D11_TEXTURE2D_DESC {
                Width: tw,
                Height: th,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut texture = None;
            self.device.CreateTexture2D(&desc, None, Some(&mut texture))?;
            let texture = out(texture)?;
            if cw < tw || ch < th {
                // A window got smaller than at the start: black around it instead of old pixels.
                let mut rtv = None;
                self.device.CreateRenderTargetView(&texture, None, Some(&mut rtv))?;
                self.context.ClearRenderTargetView(&out(rtv)?, &[0.0, 0.0, 0.0, 1.0]);
            }
            let area = D3D11_BOX { left: 0, top: 0, front: 0, right: cw, bottom: ch, back: 1 };
            self.context.CopySubresourceRegion(&texture, 0, 0, 0, 0, src, 0, Some(&area));

            let buffer = if self.gpu {
                let b = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &texture, 0, false)?;
                b.SetCurrentLength(b.cast::<IMF2DBuffer>()?.GetContiguousLength()?)?;
                b
            } else {
                self.read_back(&texture)?
            };
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(time)?;
            sample.SetSampleDuration(self.pacer.interval())?;
            let Some(sink) = &self.sink else { return Ok(()) };
            sink.WriteSample(self.video, &sample)?;
            self.last_video = Some(time);
            Ok(())
        }
    }

    /// CPU path: copies the frame into a memory buffer, rows top to bottom.
    unsafe fn read_back(&mut self, texture: &ID3D11Texture2D) -> Result<IMFMediaBuffer> {
        let (w, h) = self.size;
        unsafe {
            if self.staging.is_none() {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: w,
                    Height: h,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut t = None;
                self.device.CreateTexture2D(&desc, None, Some(&mut t))?;
                self.staging = Some(out(t)?);
            }
            let Some(staging) = self.staging.as_ref() else { return Err(E_POINTER.into()) };
            self.context.CopyResource(staging, texture);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let row = (w * 4) as usize;
            let buffer = MFCreateMemoryBuffer(row as u32 * h)?;
            let mut ptr = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None)?;
            for y in 0..h as usize {
                std::ptr::copy_nonoverlapping((mapped.pData as *const u8).add(y * mapped.RowPitch as usize), ptr.add(y * row), row);
            }
            buffer.Unlock()?;
            self.context.Unmap(staging, 0);
            buffer.SetCurrentLength(row as u32 * h)?;
            Ok(buffer)
        }
    }
}

fn pack(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

/// The MP4 writer: H.264 from BGRA frames, and AAC from 48 kHz stereo PCM when `audio`.
unsafe fn open_sink(path: &Path, (w, h): (u32, u32), fps: u32, audio: bool, manager: Option<&IMFDXGIDeviceManager>) -> Result<(IMFSinkWriter, u32, Option<u32>)> {
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 4)?;
        let attrs = out(attrs)?;
        attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
        // WriteSample must never block the audio thread while a still screen sends no video.
        attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
        // Fragmented MP4: a file cut off by a crash or power loss still plays; a finished one shows duration and thumbnail in Explorer.
        attrs.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_FMPEG4)?;
        if let Some(m) = manager {
            attrs.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, m)?;
        }
        let sink = MFCreateSinkWriterFromURL(&HSTRING::from(path), None, &attrs)?;

        let out = MFCreateMediaType()?;
        out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
        out.SetUINT32(&MF_MT_AVG_BITRATE, bitrate(w, h, fps))?;
        out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        out.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h))?;
        out.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
        out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        let video = sink.AddStream(&out)?;

        let input = MFCreateMediaType()?;
        input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
        input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        input.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h))?;
        input.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
        input.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        // Positive stride = rows top to bottom (RGB defaults to bottom-up).
        input.SetUINT32(&MF_MT_DEFAULT_STRIDE, w * 4)?;
        sink.SetInputMediaType(video, &input, None)?;

        let audio = if audio { Some(add_audio_stream(&sink)?) } else { None };
        sink.BeginWriting()?;
        Ok((sink, video, audio))
    }
}
