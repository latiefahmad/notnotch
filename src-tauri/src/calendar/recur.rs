//! RRULE expansion (RFC 5545, 3.3.10) on wall-clock times in the event's own zone, so a weekly 9:00 stays 9:00 across DST.
//! Supported: FREQ DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (with ordinals), BYMONTHDAY, BYMONTH,
//! BYSETPOS and WKST. A rule with BYYEARDAY, BYWEEKNO or a finer FREQ is not expanded (`parse` returns None, the event shows once).

use jiff::civil::{Date, DateTime, Weekday};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub freq: Freq,
    pub interval: i64,
    pub count: Option<u32>,
    /// Inclusive, as a wall-clock time in the zone of DTSTART (the caller converts a UTC UNTIL).
    pub until: Option<DateTime>,
    /// (ordinal, weekday); 0 = every such weekday in the period.
    pub by_day: Vec<(i8, Weekday)>,
    pub by_month_day: Vec<i8>,
    pub by_month: Vec<i8>,
    pub by_set_pos: Vec<i32>,
    pub wkst: Weekday,
}

/// Periods walked at most, so a broken rule cannot spin.
const MAX_PERIODS: i64 = 60_000;

pub fn weekday(code: &str) -> Option<Weekday> {
    Some(match code {
        "MO" => Weekday::Monday,
        "TU" => Weekday::Tuesday,
        "WE" => Weekday::Wednesday,
        "TH" => Weekday::Thursday,
        "FR" => Weekday::Friday,
        "SA" => Weekday::Saturday,
        "SU" => Weekday::Sunday,
        _ => return None,
    })
}

/// `until` turns the raw UNTIL value into a wall-clock time in DTSTART's zone.
pub fn parse(value: &str, until: impl Fn(&str) -> Option<DateTime>) -> Option<Rule> {
    let mut rule = Rule { freq: Freq::Daily, interval: 1, count: None, until: None, by_day: vec![], by_month_day: vec![], by_month: vec![], by_set_pos: vec![], wkst: Weekday::Monday };
    let mut freq = None;
    let list = |v: &str| -> Option<Vec<i32>> { v.split(',').map(|n| n.trim().trim_start_matches('+').parse::<i32>().ok()).collect() };
    for part in value.split(';') {
        let (key, v) = part.split_once('=')?;
        let v = v.trim();
        match key.trim().to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match v.to_ascii_uppercase().as_str() {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return None,
                })
            }
            "INTERVAL" => rule.interval = v.parse::<i64>().ok().filter(|n| *n >= 1)?,
            "COUNT" => rule.count = Some(v.parse().ok()?),
            "UNTIL" => rule.until = Some(until(v)?),
            "BYDAY" => {
                for d in v.split(',') {
                    let d = d.trim().to_ascii_uppercase();
                    if d.len() < 2 {
                        return None;
                    }
                    let (n, code) = d.split_at(d.len() - 2);
                    let n = if n.is_empty() { 0 } else { n.trim_start_matches('+').parse::<i8>().ok()? };
                    rule.by_day.push((n, weekday(code)?));
                }
            }
            "BYMONTHDAY" => rule.by_month_day = list(v)?.into_iter().filter(|d| (1..=31).contains(&d.abs())).map(|d| d as i8).collect(),
            "BYMONTH" => rule.by_month = list(v)?.into_iter().filter(|m| (1..=12).contains(m)).map(|m| m as i8).collect(),
            "BYSETPOS" => rule.by_set_pos = list(v)?.into_iter().filter(|p| *p != 0).collect(),
            "WKST" => rule.wkst = weekday(&v.to_ascii_uppercase())?,
            "BYYEARDAY" | "BYWEEKNO" => return None,
            // BYHOUR, BYMINUTE, BYSECOND: the time of DTSTART is kept.
            _ => {}
        }
    }
    rule.freq = freq?;
    Some(rule)
}

/// Days since 1970-01-01 (proleptic Gregorian).
fn day_number(d: Date) -> i64 {
    let (y, m, dd) = (d.year() as i64, d.month() as i64, d.day() as i64);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + dd - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn from_day_number(z: i64) -> Option<Date> {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    Date::new(i16::try_from(y).ok()?, m as i8, d as i8).ok()
}

pub fn add_days(d: Date, n: i64) -> Option<Date> {
    from_day_number(day_number(d) + n)
}

pub fn days_between(a: Date, b: Date) -> i64 {
    day_number(b) - day_number(a)
}

/// Monday 0 … Sunday 6.
fn wd_index(w: Weekday) -> i64 {
    w.to_monday_zero_offset() as i64
}

/// The dates of `wd` in [first, last], in order.
fn weekdays_in(first: Date, last: Date, wd: Weekday) -> Vec<Date> {
    let offset = (wd_index(wd) - wd_index(first.weekday())).rem_euclid(7);
    let (start, end) = (day_number(first) + offset, day_number(last));
    (0..).map(|k| start + 7 * k).take_while(|n| *n <= end).filter_map(from_day_number).collect()
}

fn pick<T: Copy>(list: &[T], n: i8) -> Option<T> {
    match n {
        0 => None,
        n if n > 0 => list.get(n as usize - 1).copied(),
        n => list.len().checked_sub((-n) as usize).and_then(|i| list.get(i).copied()),
    }
}

/// BYDAY over [first, last]: every matching weekday, or the nth one counted in that span.
fn by_day_in(rule: &Rule, first: Date, last: Date) -> Vec<Date> {
    let mut out = vec![];
    for &(n, wd) in &rule.by_day {
        let all = weekdays_in(first, last, wd);
        if n == 0 {
            out.extend(all);
        } else if let Some(d) = pick(&all, n) {
            out.push(d);
        }
    }
    out
}

fn month_days(rule: &Rule, year: i16, month: i8, default_day: i8) -> Vec<Date> {
    let Ok(first) = Date::new(year, month, 1) else { return vec![] };
    let dim = first.days_in_month();
    let last = first.last_of_month();
    if !rule.by_month_day.is_empty() {
        rule.by_month_day
            .iter()
            .map(|&md| if md > 0 { md } else { dim + 1 + md })
            .filter(|&d| d >= 1 && d <= dim)
            .filter_map(|d| Date::new(year, month, d).ok())
            .filter(|d| rule.by_day.is_empty() || rule.by_day.iter().any(|&(_, wd)| wd == d.weekday()))
            .collect()
    } else if !rule.by_day.is_empty() {
        by_day_in(rule, first, last)
    } else {
        // A start on the 31st skips the shorter months, as the RFC asks.
        Date::new(year, month, default_day).ok().filter(|d| d.month() == month).into_iter().collect()
    }
}

/// The candidate dates of the period `k` (counted from DTSTART's period), before BYSETPOS.
fn period(rule: &Rule, start: Date, k: i64) -> Option<(Date, Vec<Date>)> {
    let step = k * rule.interval;
    let months_ok = |d: &Date| rule.by_month.is_empty() || rule.by_month.contains(&d.month());
    Some(match rule.freq {
        Freq::Daily => {
            let d = add_days(start, step)?;
            let keep = months_ok(&d)
                && (rule.by_month_day.is_empty() || rule.by_month_day.iter().any(|&md| md == d.day() || d.days_in_month() + 1 + md == d.day()))
                && (rule.by_day.is_empty() || rule.by_day.iter().any(|&(_, wd)| wd == d.weekday()));
            (d, if keep { vec![d] } else { vec![] })
        }
        Freq::Weekly => {
            let week0 = add_days(start, -(wd_index(start.weekday()) - wd_index(rule.wkst)).rem_euclid(7))?;
            let ws = add_days(week0, 7 * step)?;
            let days: Vec<Weekday> = if rule.by_day.is_empty() { vec![start.weekday()] } else { rule.by_day.iter().map(|&(_, wd)| wd).collect() };
            let dates = days.into_iter().filter_map(|wd| add_days(ws, (wd_index(wd) - wd_index(rule.wkst)).rem_euclid(7))).filter(months_ok).collect();
            (ws, dates)
        }
        Freq::Monthly => {
            let idx = start.year() as i64 * 12 + start.month() as i64 - 1 + step;
            let (y, m) = (i16::try_from(idx.div_euclid(12)).ok()?, (idx.rem_euclid(12) + 1) as i8);
            let first = Date::new(y, m, 1).ok()?;
            (first, if months_ok(&first) { month_days(rule, y, m, start.day()) } else { vec![] })
        }
        Freq::Yearly => {
            let y = i16::try_from(start.year() as i64 + step).ok()?;
            let first = Date::new(y, 1, 1).ok()?;
            let dates = if rule.by_month.is_empty() && rule.by_month_day.is_empty() && !rule.by_day.is_empty() {
                // BYDAY alone in a yearly rule counts within the year ("20MO").
                by_day_in(rule, first, Date::new(y, 12, 31).ok()?)
            } else {
                let months = if rule.by_month.is_empty() { vec![start.month()] } else { rule.by_month.clone() };
                months.into_iter().flat_map(|m| month_days(rule, y, m, start.day())).collect()
            };
            (first, dates)
        }
    })
}

/// Occurrences of `rule` starting at `start` that begin in [from, to), DTSTART included (it always counts as the first one).
pub fn expand(rule: &Rule, start: DateTime, from: DateTime, to: DateTime, max: usize) -> Vec<DateTime> {
    let mut out = vec![];
    let mut emitted = 0u32;
    let in_window = |dt: DateTime| dt >= from && dt < to;
    if in_window(start) {
        out.push(start);
    }
    emitted += 1;
    if rule.count == Some(1) {
        return out;
    }
    for k in 0..MAX_PERIODS {
        let Some((period_start, mut dates)) = period(rule, start.date(), k) else { break };
        if period_start > to.date() {
            break;
        }
        dates.sort();
        dates.dedup();
        if !rule.by_set_pos.is_empty() {
            let all = dates;
            dates = rule.by_set_pos.iter().filter_map(|&p| pick(&all, p.clamp(-128, 127) as i8)).collect();
            dates.sort();
            dates.dedup();
        }
        for d in dates {
            let dt = d.to_datetime(start.time());
            if dt <= start {
                continue;
            }
            if rule.until.is_some_and(|u| dt > u) || dt >= to {
                return out;
            }
            emitted += 1;
            if in_window(dt) {
                out.push(dt);
                if out.len() >= max {
                    return out;
                }
            }
            if rule.count.is_some_and(|c| emitted >= c) {
                return out;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use jiff::civil::{date, datetime};

    fn rule(s: &str) -> Rule {
        parse(s, |u| {
            let d = date(u[0..4].parse().unwrap(), u[4..6].parse().unwrap(), u[6..8].parse().unwrap());
            Some(if u.len() > 8 { d.to_datetime(jiff::civil::time(u[9..11].parse().unwrap(), u[11..13].parse().unwrap(), 0, 0)) } else { d.to_datetime(jiff::civil::time(23, 59, 59, 0)) })
        })
        .unwrap()
    }

    fn run(r: &str, start: DateTime, from: DateTime, to: DateTime) -> Vec<String> {
        expand(&rule(r), start, from, to, 1000).into_iter().map(|d| d.to_string()).collect()
    }

    fn days(v: &[String]) -> Vec<&str> {
        v.iter().map(|s| &s[..10]).collect()
    }

    #[test]
    fn day_numbers_round_trip() {
        for d in [date(1970, 1, 1), date(2000, 2, 29), date(2026, 11, 1), date(1899, 12, 31)] {
            assert_eq!(from_day_number(day_number(d)), Some(d));
        }
        assert_eq!(day_number(date(1970, 1, 2)), 1);
        assert_eq!(days_between(date(2026, 2, 27), date(2026, 3, 2)), 3);
    }

    #[test]
    fn daily_with_interval_and_count() {
        let s = datetime(2026, 11, 1, 9, 0, 0, 0);
        let out = run("FREQ=DAILY;INTERVAL=2;COUNT=4", s, datetime(2026, 1, 1, 0, 0, 0, 0), datetime(2027, 1, 1, 0, 0, 0, 0));
        assert_eq!(out, ["2026-11-01T09:00:00", "2026-11-03T09:00:00", "2026-11-05T09:00:00", "2026-11-07T09:00:00"]);
    }

    #[test]
    fn weekly_byday_until() {
        // Monday 2 Nov 2026, Mondays and Wednesdays until the 11th inclusive.
        let s = datetime(2026, 11, 2, 18, 30, 0, 0);
        let out = run("FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261111T235959", s, datetime(2026, 1, 1, 0, 0, 0, 0), datetime(2027, 1, 1, 0, 0, 0, 0));
        assert_eq!(days(&out), ["2026-11-02", "2026-11-04", "2026-11-09", "2026-11-11"]);
    }

    #[test]
    fn biweekly_counts_from_the_start_week() {
        let s = datetime(2026, 11, 3, 10, 0, 0, 0); // Tuesday
        let out = run("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH", s, datetime(2026, 11, 1, 0, 0, 0, 0), datetime(2026, 12, 1, 0, 0, 0, 0));
        assert_eq!(days(&out), ["2026-11-03", "2026-11-05", "2026-11-17", "2026-11-19"]);
    }

    #[test]
    fn window_only_but_count_from_start() {
        // Ten daily occurrences from 1 Nov; the window sees the 8th to the 10th only.
        let s = datetime(2026, 11, 1, 8, 0, 0, 0);
        let out = run("FREQ=DAILY;COUNT=10", s, datetime(2026, 11, 8, 0, 0, 0, 0), datetime(2026, 12, 1, 0, 0, 0, 0));
        assert_eq!(days(&out), ["2026-11-08", "2026-11-09", "2026-11-10"]);
    }

    #[test]
    fn monthly_by_month_day_skips_short_months() {
        let s = datetime(2026, 1, 31, 12, 0, 0, 0);
        let out = run("FREQ=MONTHLY;COUNT=4", s, datetime(2026, 1, 1, 0, 0, 0, 0), datetime(2027, 1, 1, 0, 0, 0, 0));
        assert_eq!(days(&out), ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]);
        let out = run("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3", datetime(2026, 1, 31, 12, 0, 0, 0), datetime(2026, 1, 1, 0, 0, 0, 0), datetime(2027, 1, 1, 0, 0, 0, 0));
        assert_eq!(days(&out), ["2026-01-31", "2026-02-28", "2026-03-31"]);
    }

    #[test]
    fn monthly_nth_weekday_and_setpos() {
        // Second Tuesday and last Friday.
        let out = run("FREQ=MONTHLY;BYDAY=2TU;COUNT=3", datetime(2026, 11, 10, 9, 0, 0, 0), datetime(2026, 1, 1, 0, 0, 0, 0), datetime(2028, 1, 1, 0, 0, 0, 0));
        assert_eq!(days(&out), ["2026-11-10", "2026-12-08", "2027-01-12"]);
        let out = run("FREQ=MONTHLY;BYDAY=-1FR;COUNT=2", datetime(2026, 11, 27, 9, 0, 0, 0), datetime(2026, 1, 1, 0, 0, 0, 0), datetime(2028, 1, 1, 0, 0, 0, 0));
        assert_eq!(days(&out), ["2026-11-27", "2026-12-25"]);
        // Last working day of the month (what Outlook writes).
        let out = run("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3", datetime(2026, 10, 30, 9, 0, 0, 0), datetime(2026, 1, 1, 0, 0, 0, 0), datetime(2028, 1, 1, 0, 0, 0, 0));
        assert_eq!(days(&out), ["2026-10-30", "2026-11-30", "2026-12-31"]);
    }

    #[test]
    fn yearly_birthday_and_leap_day() {
        let out = run("FREQ=YEARLY", datetime(2020, 2, 29, 0, 0, 0, 0), datetime(2020, 1, 1, 0, 0, 0, 0), datetime(2029, 1, 1, 0, 0, 0, 0));
        assert_eq!(days(&out), ["2020-02-29", "2024-02-29", "2028-02-29"]);
        // Thanksgiving: fourth Thursday of November.
        let out = run("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", datetime(2025, 11, 27, 0, 0, 0, 0), datetime(2026, 1, 1, 0, 0, 0, 0), datetime(2028, 1, 1, 0, 0, 0, 0));
        assert_eq!(days(&out), ["2026-11-26", "2027-11-25"]);
    }

    #[test]
    fn interval_years() {
        let out = run("FREQ=YEARLY;INTERVAL=2;COUNT=3", datetime(2026, 6, 1, 0, 0, 0, 0), datetime(2026, 1, 1, 0, 0, 0, 0), datetime(2040, 1, 1, 0, 0, 0, 0));
        assert_eq!(days(&out), ["2026-06-01", "2028-06-01", "2030-06-01"]);
    }

    #[test]
    fn unsupported_rules_are_refused() {
        assert!(parse("FREQ=HOURLY", |_| None).is_none());
        assert!(parse("FREQ=YEARLY;BYWEEKNO=20", |_| None).is_none());
        assert!(parse("INTERVAL=2", |_| None).is_none());
        assert!(parse("FREQ=DAILY;INTERVAL=0", |_| None).is_none());
    }

    #[test]
    fn a_daily_rule_from_years_ago_still_reaches_today() {
        let out = run("FREQ=DAILY", datetime(2012, 3, 1, 7, 0, 0, 0), datetime(2026, 11, 1, 0, 0, 0, 0), datetime(2026, 11, 3, 0, 0, 0, 0));
        assert_eq!(days(&out), ["2026-11-01", "2026-11-02"]);
    }
}
