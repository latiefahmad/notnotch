// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/RateLimitBackoff.cs.
//! The pause after rate-limited (429) answers from one provider. Without a Retry-After the
//! pause grows 2, 4, 8, 16, then 30 minutes with each further 429 and ends with the first
//! answer that is not one. A Retry-After is kept as sent (raised to at least 30 s); a repeated
//! one shorter than the growth does not hold the pause down. One longer than a week is taken
//! for a mistake and ignored, so a wrong value cannot stop a provider for good. Up to 10 % is
//! added, never taken, so several copies behind one address do not retry on the same minute.
//! The end time is kept, not a countdown; if the clock is set back, the wait left is cut to
//! the length the pause was given.

const MIN_DELAY: u64 = 30_000;
const FIRST_DELAY: u64 = 2 * 60_000;
const MAX_GROWTH: u64 = 30 * 60_000;
const MAX_PLAUSIBLE_RETRY_AFTER: u64 = 7 * 86_400_000;
const JITTER_SHARE: f64 = 0.1;
const MAX_FAILURES: u32 = 16;

/// All times in Unix ms.
#[derive(Default, Clone)]
pub struct Backoff {
    failures: u32,
    until: Option<u64>,
    wait: u64,
}

/// Pause length for the `failures`-th 429 in a row (counting this one). `jitter` is 0..1.
pub fn delay(failures: u32, retry_after: Option<u64>, jitter: f64) -> u64 {
    let grown = if failures <= 1 { FIRST_DELAY } else { (FIRST_DELAY.saturating_mul(1 << (failures.min(MAX_FAILURES) - 1))).min(MAX_GROWTH) };
    let mut delay = grown;
    if let Some(told) = retry_after.filter(|t| *t <= MAX_PLAUSIBLE_RETRY_AFTER) {
        delay = told.max(MIN_DELAY);
        if failures > 1 && grown > delay {
            delay = grown;
        }
    }
    let jitter = if jitter.is_nan() { 0.0 } else { jitter.clamp(0.0, 1.0) };
    delay + (delay as f64 * JITTER_SHARE * jitter) as u64
}

impl Backoff {
    /// When requests may go out again; None when they may now.
    pub fn retry_at(&mut self, now: u64) -> Option<u64> {
        let mut until = self.until?;
        if until.saturating_sub(now) > self.wait {
            until = now + self.wait;
            self.until = Some(until);
        }
        (until > now).then_some(until)
    }

    /// A 429 arrived at `now`; returns when to ask again.
    pub fn fail(&mut self, now: u64, retry_after: Option<u64>, jitter: f64) -> u64 {
        self.failures = (self.failures + 1).min(MAX_FAILURES);
        self.wait = delay(self.failures, retry_after, jitter);
        let until = now + self.wait;
        self.until = Some(until);
        until
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;

    #[test]
    fn grows_without_retry_after() {
        let got: Vec<u64> = (1..=7).map(|n| delay(n, None, 0.0) / MIN).collect();
        assert_eq!(got, [2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn retry_after_is_kept_and_raised_to_min() {
        assert_eq!(delay(1, Some(90 * MIN), 0.0), 90 * MIN);
        assert_eq!(delay(1, Some(5_000), 0.0), MIN_DELAY);
        // A repeated short Retry-After does not hold the growth down.
        assert_eq!(delay(3, Some(MIN), 0.0), 8 * MIN);
        // Longer than a week: a mistake, treated as missing.
        assert_eq!(delay(1, Some(8 * 86_400_000), 0.0), 2 * MIN);
    }

    #[test]
    fn jitter_only_adds() {
        assert_eq!(delay(1, None, 1.0), 2 * MIN + 12_000);
        assert_eq!(delay(1, None, f64::NAN), 2 * MIN);
        assert_eq!(delay(1, None, -3.0), 2 * MIN);
    }

    #[test]
    fn fail_reset_and_clock_set_back() {
        let mut b = Backoff::default();
        let now = 1_000_000_000;
        assert_eq!(b.retry_at(now), None);
        assert_eq!(b.fail(now, None, 0.0), now + 2 * MIN);
        assert_eq!(b.retry_at(now + MIN), Some(now + 2 * MIN));
        assert_eq!(b.retry_at(now + 2 * MIN), None);
        assert_eq!(b.fail(now, None, 0.0), now + 4 * MIN);
        // Clock went back an hour: the wait is cut to its own length from the new time.
        let back = now - 60 * MIN;
        assert_eq!(b.retry_at(back), Some(back + 4 * MIN));
        b.reset();
        assert_eq!(b.retry_at(now), None);
        assert_eq!(b.fail(now, None, 0.0), now + 2 * MIN);
    }
}
