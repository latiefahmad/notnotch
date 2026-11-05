//! Audio-only recording (the Recorder tool): the mixed track from `audio.rs` (microphone, system audio or both) as AAC in an
//! M4A, through the same encoder settings as a screen recording's audio. The file is fragmented MP4, so one cut off by a
//! crash or power loss still plays.

use std::path::Path;
use std::sync::{Arc, Mutex};

use windows::core::{Result, HSTRING};
use windows::Win32::Media::MediaFoundation::*;

use super::math::Clock;
use super::record::{add_audio_stream, write_pcm};

/// The writer, behind a mutex: Media Foundation's Sink Writer is free-threaded, so it may be used from the audio thread.
struct Sink(IMFSinkWriter);
unsafe impl Send for Sink {}

pub struct Shared {
    pub clock: Mutex<Clock>,
    sink: Mutex<Option<Sink>>,
    stream: u32,
}

/// Opens the writer for `path`; the clock starts at `start`. Media Foundation must be started (MFStartup) on this apartment.
pub fn start(path: &Path, start: i64) -> Result<Arc<Shared>> {
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 2)?;
        let attrs = attrs.ok_or_else(windows::core::Error::empty)?;
        // WriteSample must never block the audio thread.
        attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
        attrs.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_FMPEG4)?;
        let sink = MFCreateSinkWriterFromURL(&HSTRING::from(path), None, &attrs)?;
        let stream = add_audio_stream(&sink)?;
        sink.BeginWriting()?;
        Ok(Arc::new(Shared { clock: Mutex::new(Clock::new(start)), sink: Mutex::new(Some(Sink(sink))), stream }))
    }
}

impl Shared {
    /// Writes the file's index and lets the writer go. Call after the audio thread has finished.
    pub fn stop(&self) -> Result<()> {
        let sink = self.sink.lock().unwrap().take();
        sink.map_or(Ok(()), |s| unsafe { s.0.Finalize() })
    }
}

impl super::audio::AudioSink for Shared {
    fn clock(&self) -> &Mutex<Clock> {
        &self.clock
    }
    fn write_audio(&self, time: i64, samples: &[i16]) -> Result<()> {
        match self.sink.lock().unwrap().as_ref() {
            Some(s) => unsafe { write_pcm(&s.0, self.stream, time, samples) },
            None => Ok(()),
        }
    }
}
