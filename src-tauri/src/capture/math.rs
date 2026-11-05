//! Pure parts of Capture: rectangles across monitors, encoder sizes, frame pacing,
//! the pause clock, the audio mixer timeline and file names. No Windows calls here.
//!
//! Coordinates are physical pixels of the virtual screen (all monitors together).
//! Its origin is the primary monitor's top left, so a monitor to the left or above
//! has negative coordinates. Times are in 100 ns units, like QPC and Media Foundation.

use std::collections::VecDeque;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
}

pub fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let (x, y) = (a.x.max(b.x), a.y.max(b.y));
    let (r, btm) = (a.right().min(b.right()), a.bottom().min(b.bottom()));
    (r > x && btm > y).then_some(Rect { x, y, w: r - x, h: btm - y })
}

/// The rectangle a drag from `a` to `b` spans (any direction), clamped to `bounds`.
/// None when it is thinner than `min` pixels either way (a click, not a drag).
pub fn drag_rect(a: (i32, i32), b: (i32, i32), bounds: Rect, min: i32) -> Option<Rect> {
    let (x0, x1) = (a.0.min(b.0), a.0.max(b.0));
    let (y0, y1) = (a.1.min(b.1), a.1.max(b.1));
    // The pixel under the end point is included, as in every snipping tool.
    let r = intersect(Rect { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, bounds)?;
    (r.w >= min && r.h >= min).then_some(r)
}

/// A rectangle in virtual-screen coordinates as a crop of the virtual-screen bitmap,
/// whose pixel (0, 0) is the virtual screen's top left. None if it lies outside.
pub fn to_bitmap(r: Rect, screen: Rect) -> Option<Rect> {
    let r = intersect(r, screen)?;
    Some(Rect { x: r.x - screen.x, y: r.y - screen.y, ..r })
}

/// Find on screen: one OCR line on screen, from its words' boxes (x, y, w, h in the pixels of `monitor`'s
/// capture), with a margin of 4 px at 100 % scale, kept on the monitor. None for a line without words.
pub fn line_rect(words: &[(f32, f32, f32, f32)], monitor: Rect, scale: f32) -> Option<Rect> {
    let x0 = words.iter().map(|w| w.0).reduce(f32::min)?.floor() as i32;
    let y0 = words.iter().map(|w| w.1).reduce(f32::min)?.floor() as i32;
    let x1 = words.iter().map(|w| w.0 + w.2).reduce(f32::max)?.ceil() as i32;
    let y1 = words.iter().map(|w| w.1 + w.3).reduce(f32::max)?.ceil() as i32;
    let pad = (4.0 * scale).round() as i32;
    let r = Rect { x: monitor.x + x0 - pad, y: monitor.y + y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
    intersect(r, monitor)
}

/// H.264 4:2:0 needs even sizes: rounds down, at least 2.
pub fn even_size(w: u32, h: u32) -> (u32, u32) {
    ((w & !1).max(2), (h & !1).max(2))
}

/// How much of a frame of `content` size fits into the fixed `target` (top left aligned).
/// A window that grows is cropped, one that shrinks leaves black at the right and bottom.
pub fn copy_box(content: (u32, u32), target: (u32, u32)) -> (u32, u32) {
    (content.0.min(target.0), content.1.min(target.1))
}

/// Video bitrate in bit/s: about 0.1 bit per pixel per frame, within 2 to 50 Mbit/s.
pub fn bitrate(w: u32, h: u32, fps: u32) -> u32 {
    ((w as u64 * h as u64 * fps as u64) / 10).clamp(2_000_000, 50_000_000) as u32
}

/// Lets through at most `fps` frames per second from a source that delivers frames
/// whenever the screen changes (often faster, for example on a 144 Hz monitor).
pub struct Pacer {
    interval: i64,
    next: Option<i64>,
}

impl Pacer {
    pub fn new(fps: u32) -> Self {
        Pacer { interval: 10_000_000 / fps.max(1) as i64, next: None }
    }

    pub fn interval(&self) -> i64 {
        self.interval
    }

    /// A frame at `t` was written outside the schedule (the one held over a pause): continue from it.
    pub fn restart(&mut self, t: i64) {
        self.next = Some(t + self.interval);
    }

    /// Keep a frame at media time `t`? A quarter interval early still counts, so a
    /// 60 Hz screen recorded at 30 fps keeps every second frame instead of drifting.
    pub fn admit(&mut self, t: i64) -> bool {
        match self.next {
            Some(next) if t < next - self.interval / 4 => false,
            Some(next) => {
                // After a still screen the schedule restarts from this frame.
                self.next = Some(if t > next + self.interval { t + self.interval } else { next + self.interval });
                true
            }
            None => {
                self.next = Some(t + self.interval);
                true
            }
        }
    }
}

/// Recording time with pauses. `start` and all times are on one clock (QPC in 100 ns).
/// Times inside a pause have no media time; later times are shifted back by the pauses before them.
#[derive(Clone, Debug)]
pub struct Clock {
    start: i64,
    pauses: Vec<(i64, Option<i64>)>,
}

impl Clock {
    pub fn new(start: i64) -> Self {
        Clock { start, pauses: Vec::new() }
    }

    pub fn paused(&self) -> bool {
        self.pauses.last().is_some_and(|p| p.1.is_none())
    }

    pub fn pause(&mut self, now: i64) {
        if !self.paused() {
            self.pauses.push((now, None));
        }
    }

    pub fn resume(&mut self, now: i64) {
        if let Some(p) = self.pauses.last_mut().filter(|p| p.1.is_none()) {
            p.1 = Some(now.max(p.0));
        }
    }

    /// Media time of something captured at `t`, None before the start or inside a pause.
    pub fn media(&self, t: i64) -> Option<i64> {
        if t < self.start {
            return None;
        }
        let mut shift = 0;
        for &(from, to) in &self.pauses {
            if t < from {
                break;
            }
            match to {
                Some(to) if t >= to => shift += to - from,
                _ => return None,
            }
        }
        Some(t - self.start - shift)
    }

    /// Recorded time at `now`; stands still during a pause.
    pub fn elapsed(&self, now: i64) -> i64 {
        let at = match self.pauses.last() {
            Some(&(from, None)) => from,
            _ => now,
        };
        let shift: i64 = self.pauses.iter().filter_map(|&(from, to)| to.map(|to| to - from)).sum();
        (at - self.start - shift).max(0)
    }
}

/// Media time (100 ns) to audio frames and back.
pub fn to_frames(t: i64, rate: i64) -> i64 {
    t * rate / 10_000_000
}
pub fn to_time(frames: i64, rate: i64) -> i64 {
    frames * 10_000_000 / rate
}

/// Mixes stereo 16-bit sources onto one timeline. A packet continues where the previous
/// one ended while its timestamp is within 1 ms of that; beyond, it moves one frame
/// toward the timestamp per packet, so a device clock that drifts from QPC is followed
/// without audible jumps. A real gap (over 20 ms: a silent loopback sends nothing) or a
/// packet Windows marks as discontinuous jumps to its timestamp; the gap stays zero.
pub struct Mixer {
    /// First frame not yet taken; `buf[0]` is that frame.
    emitted: i64,
    buf: VecDeque<[i32; 2]>,
    next: Vec<Option<i64>>,
    band: i64,
    gap: i64,
}

impl Mixer {
    pub fn new(sources: usize, rate: i64) -> Self {
        Mixer { emitted: 0, buf: VecDeque::new(), next: vec![None; sources], band: rate / 1000, gap: rate / 50 }
    }

    /// Adds interleaved stereo `samples` of `source`, stamped at frame `at`; `discontinuity`: the
    /// device says data was lost before it. Returns where they landed.
    pub fn add(&mut self, source: usize, at: i64, samples: &[i16], discontinuity: bool) -> i64 {
        let at = match self.next[source] {
            _ if discontinuity => at,
            Some(n) if (at - n).abs() <= self.band => n,
            Some(n) if (at - n).abs() <= self.gap => n + (at - n).signum(),
            _ => at,
        };
        let frames = (samples.len() / 2) as i64;
        self.next[source] = Some(at + frames);
        for i in 0..frames {
            let pos = at + i - self.emitted;
            if pos < 0 {
                continue; // already written out: too late
            }
            let pos = pos as usize;
            if self.buf.len() <= pos {
                self.buf.resize(pos + 1, [0, 0]);
            }
            let f = &mut self.buf[pos];
            f[0] += samples[2 * i as usize] as i32;
            f[1] += samples[2 * i as usize + 1] as i32;
        }
        at
    }

    /// Frames from the last take up to `upto` (exclusive), interleaved, clipped to 16 bit.
    /// Returns the first frame's position and the samples.
    pub fn take(&mut self, upto: i64) -> (i64, Vec<i16>) {
        let from = self.emitted;
        let n = (upto - from).max(0) as usize;
        let mut out = Vec::with_capacity(n * 2);
        for _ in 0..n {
            let f = self.buf.pop_front().unwrap_or([0, 0]);
            out.push(f[0].clamp(i16::MIN as i32, i16::MAX as i32) as i16);
            out.push(f[1].clamp(i16::MIN as i32, i16::MAX as i32) as i16);
        }
        self.emitted += n as i64;
        (from, out)
    }
}

/// Local time for file names.
#[derive(Clone, Copy)]
pub struct Stamp {
    pub year: u16,
    pub month: u16,
    pub day: u16,
    pub hour: u16,
    pub minute: u16,
    pub second: u16,
}

/// "Screenshot 2026-10-31 214705.png", with " (2)", " (3)" ... while `taken` says the name exists.
pub fn file_name(prefix: &str, ext: &str, s: Stamp, taken: impl Fn(&str) -> bool) -> String {
    let base = format!("{prefix} {:04}-{:02}-{:02} {:02}{:02}{:02}", s.year, s.month, s.day, s.hour, s.minute, s.second);
    let mut name = format!("{base}.{ext}");
    let mut n = 2;
    while taken(&name) {
        name = format!("{base} ({n}).{ext}");
        n += 1;
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: Rect = Rect { x: 0, y: 0, w: 0, h: 0 };

    #[test]
    fn drag_any_direction_and_clamped() {
        // Left monitor at -1920, primary at 0: the virtual screen starts at -1920.
        let screen = Rect { x: -1920, y: -200, w: 1920 + 2560, h: 1440 + 200 };
        assert_eq!(drag_rect((100, 100), (10, 20), screen, 4), Some(Rect { x: 10, y: 20, w: 91, h: 81 }));
        assert_eq!(drag_rect((-100, 50), (300, 60), screen, 4), Some(Rect { x: -100, y: 50, w: 401, h: 11 }));
        // Dragged past the edge: clamped to the virtual screen.
        assert_eq!(drag_rect((-5000, -5000), (-1900, -190), screen, 4), Some(Rect { x: -1920, y: -200, w: 21, h: 11 }));
        // A click is not a region.
        assert_eq!(drag_rect((5, 5), (6, 7), screen, 4), None);
        assert_eq!(drag_rect((9000, 0), (9100, 100), screen, 4), None);
    }

    #[test]
    fn monitor_to_bitmap_with_negative_origin() {
        // A 4K monitor at 150% sits left of a 1080p primary and higher; physical pixels throughout.
        let screen = Rect { x: -3840, y: -400, w: 3840 + 1920, h: 2160 };
        let left = Rect { x: -3840, y: -400, w: 3840, h: 2160 };
        let primary = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        assert_eq!(to_bitmap(left, screen), Some(Rect { x: 0, y: 0, w: 3840, h: 2160 }));
        assert_eq!(to_bitmap(primary, screen), Some(Rect { x: 3840, y: 400, w: 1920, h: 1080 }));
        assert_eq!(to_bitmap(Rect { x: 9000, ..primary }, screen), None);
        assert_eq!(intersect(R, primary), None);
    }

    #[test]
    fn ocr_line_to_screen() {
        // Two words on a 150 % monitor left of the primary: union, rounded outward, 6 px margin, moved to the monitor.
        let left = Rect { x: -1920, y: 0, w: 1920, h: 1080 };
        assert_eq!(line_rect(&[(10.4, 20.6, 30.0, 10.0), (50.0, 18.0, 20.0, 14.0)], left, 1.5), Some(Rect { x: -1916, y: 12, w: 72, h: 26 }));
        // At a corner the margin stays on the monitor; 100 % gives 4 px.
        let primary = Rect { x: 0, y: 0, w: 1920, h: 1080 };
        assert_eq!(line_rect(&[(0.0, 0.0, 5.0, 5.0)], primary, 1.0), Some(Rect { x: 0, y: 0, w: 9, h: 9 }));
        assert_eq!(line_rect(&[], primary, 1.0), None);
    }

    #[test]
    fn encoder_sizes() {
        assert_eq!(even_size(1921, 1081), (1920, 1080));
        assert_eq!(even_size(1, 0), (2, 2));
        assert_eq!(copy_box((800, 600), (1000, 500)), (800, 500));
        assert_eq!(bitrate(1920, 1080, 60), 12_441_600);
        assert_eq!(bitrate(100, 100, 30), 2_000_000);
        assert_eq!(bitrate(7680, 4320, 60), 50_000_000);
    }

    #[test]
    fn pacer_halves_a_60hz_screen_and_caps_144hz() {
        let mut p = Pacer::new(30);
        let kept = (0..60).filter(|i| p.admit(i * 166_667)).count();
        assert_eq!(kept, 30);
        let mut p = Pacer::new(60);
        let kept = (0..144).filter(|i| p.admit(i * 69_444)).count();
        assert!((59..=61).contains(&kept), "{kept}");
        // A still screen, then a frame: kept, and the schedule restarts from it.
        let mut p = Pacer::new(30);
        assert!(p.admit(0));
        assert!(p.admit(50_000_000));
        assert!(!p.admit(50_100_000));
        assert!(p.admit(50_333_334));
        p.restart(90_000_000);
        assert!(!p.admit(90_100_000));
        assert!(p.admit(90_333_334));
    }

    #[test]
    fn clock_with_pauses() {
        let mut c = Clock::new(1_000);
        assert_eq!(c.media(500), None);
        assert_eq!(c.media(1_000), Some(0));
        c.pause(3_000);
        assert!(c.paused());
        assert_eq!(c.elapsed(9_000), 2_000);
        // Audio captured just before the pause but read after it still counts.
        assert_eq!(c.media(2_999), Some(1_999));
        assert_eq!(c.media(4_000), None);
        c.resume(5_000);
        assert_eq!(c.media(5_000), Some(2_000));
        assert_eq!(c.media(4_999), None);
        assert_eq!(c.elapsed(6_000), 3_000);
        c.pause(7_000);
        c.pause(7_500); // a second pause press changes nothing
        c.resume(8_000);
        c.resume(8_500);
        assert_eq!(c.media(9_000), Some(5_000));
        assert_eq!(c.elapsed(9_000), 5_000);
    }

    #[test]
    fn mixer_timeline() {
        let mut m = Mixer::new(2, 48_000);
        m.add(0, 0, &[100, 100, 200, 200], false);
        // Jitter of a few frames snaps to the end of the last packet.
        m.add(0, 3, &[300, 300], false);
        // The second source overlaps and adds up, with clipping.
        m.add(1, 1, &[32_700, -32_700, 1_000, 1_000], false);
        let (from, s) = m.take(4);
        assert_eq!(from, 0);
        assert_eq!(s, vec![100, 100, 32_767, -32_500, 1_300, 1_300, 0, 0]);
        // Too late: frames before the taken point are dropped; a far jump leaves a silent gap.
        m.add(0, 10_000, &[5, 5], false);
        let (from, s) = m.take(10_001);
        assert_eq!(from, 4);
        assert_eq!(s.len(), (10_001 - 4) * 2);
        assert_eq!(&s[s.len() - 2..], &[5, 5]);
        assert!(s[..s.len() - 2].iter().all(|&x| x == 0));
        m.add(1, 0, &[9, 9], false);
        assert_eq!(m.take(10_002).1, vec![0, 0]);
    }

    #[test]
    fn mixer_jumps_only_on_gaps_and_discontinuities() {
        let mut m = Mixer::new(1, 48_000);
        let p = [0i16; 960];
        assert_eq!(m.add(0, 0, &p, false), 0);
        // 15 ms late: under the 20 ms threshold, corrected one frame at a time.
        assert_eq!(m.add(0, 480 + 720, &p, false), 481);
        // 60 ms of nothing (a silent loopback): jumps to the timestamp.
        assert_eq!(m.add(0, 961 + 2_880, &p, false), 3_841);
        // Marked discontinuous: jumps even for 2 ms.
        assert_eq!(m.add(0, 4_321 + 96, &p, true), 4_417);
    }

    #[test]
    fn mixer_follows_clock_drift_without_jumps() {
        // 10 minutes of 10 ms packets from a device whose clock runs 200 ppm fast or slow against QPC.
        for ppm in [200.0, -200.0] {
            let mut m = Mixer::new(1, 48_000);
            let packet = vec![0i16; 480 * 2];
            let mut prev_end: Option<i64> = None;
            for k in 0..60_000i64 {
                let stamp = (k as f64 * 480.0 / (1.0 + ppm / 1e6)).round() as i64;
                let at = m.add(0, stamp, &packet, false);
                if let Some(end) = prev_end {
                    assert!((at - end).abs() <= 1, "jump of {} frames at packet {k} ({ppm} ppm)", at - end);
                }
                // Never more than 1 ms plus a frame away from the device timestamp.
                assert!((at - stamp).abs() <= 49, "{} frames off at packet {k} ({ppm} ppm)", at - stamp);
                prev_end = Some(at + 480);
                m.take(at);
            }
        }
    }

    #[test]
    fn names_with_collisions() {
        let s = Stamp { year: 2026, month: 10, day: 31, hour: 9, minute: 7, second: 5 };
        assert_eq!(file_name("Screenshot", "png", s, |_| false), "Screenshot 2026-10-31 090705.png");
        let taken = ["Recording 2026-10-31 090705.mp4", "Recording 2026-10-31 090705 (2).mp4"];
        assert_eq!(file_name("Recording", "mp4", s, |n| taken.contains(&n)), "Recording 2026-10-31 090705 (3).mp4");
    }

    #[test]
    fn time_conversions() {
        assert_eq!(to_frames(10_000_000, 48_000), 48_000);
        assert_eq!(to_time(480, 48_000), 100_000);
    }
}
