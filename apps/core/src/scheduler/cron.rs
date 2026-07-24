//! A tiny, dependency-free cron expression parser and matcher.
//!
//! Supports the classic 5-field cron format:
//!
//! ```text
//! ┌───────────── minute        (0–59)
//! │ ┌─────────── hour          (0–23)
//! │ │ ┌───────── day of month  (1–31)
//! │ │ │ ┌─────── month         (1–12)
//! │ │ │ │ ┌───── day of week   (0–6, Sunday = 0; 7 also accepted as Sunday)
//! │ │ │ │ │
//! * * * * *
//! ```
//!
//! Each field accepts: `*`, a single value (`5`), a list (`1,15,30`), a range
//! (`9-17`), and a step on `*` or a range (`*/5`, `10-20/2`).
//!
//! In addition to cron, the scheduler accepts an `@every <humantime>` form
//! (e.g. `@every 30s`, `@every 5m`); that interval form is handled by the
//! caller, not this parser.

use chrono::{DateTime, Datelike, Timelike, Utc};

/// A parsed 5-field cron schedule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSchedule {
    minutes: Vec<u8>,
    hours: Vec<u8>,
    days_of_month: Vec<u8>,
    months: Vec<u8>,
    days_of_week: Vec<u8>,
}

impl CronSchedule {
    /// Parse a 5-field cron expression. Returns a human-readable error on any
    /// malformed field.
    pub fn parse(expr: &str) -> Result<Self, String> {
        let fields: Vec<&str> = expr.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(format!(
                "cron expression must have 5 fields, got {}: '{expr}'",
                fields.len()
            ));
        }

        let minutes = parse_field(fields[0], 0, 59)?;
        let hours = parse_field(fields[1], 0, 23)?;
        let days_of_month = parse_field(fields[2], 1, 31)?;
        let months = parse_field(fields[3], 1, 12)?;
        // Day of week: accept 7 as an alias for Sunday (0).
        let mut days_of_week = parse_field(fields[4], 0, 7)?;
        for d in &mut days_of_week {
            if *d == 7 {
                *d = 0;
            }
        }
        days_of_week.sort_unstable();
        days_of_week.dedup();

        Ok(Self {
            minutes,
            hours,
            days_of_month,
            months,
            days_of_week,
        })
    }

    /// True when `time` (UTC, second/nanosecond ignored) matches the schedule.
    ///
    /// Following cron convention: when both day-of-month and day-of-week are
    /// restricted (neither is `*`), a match on *either* fires.
    pub fn matches(&self, time: DateTime<Utc>) -> bool {
        let minute = time.minute() as u8;
        let hour = time.hour() as u8;
        let dom = time.day() as u8;
        let month = time.month() as u8;
        let dow = time.weekday().num_days_from_sunday() as u8;

        let minute_ok = self.minutes.contains(&minute);
        let hour_ok = self.hours.contains(&hour);
        let month_ok = self.months.contains(&month);

        let dom_restricted = self.days_of_month.len() != 31;
        let dow_restricted = self.days_of_week.len() != 7;
        let dom_ok = self.days_of_month.contains(&dom);
        let dow_ok = self.days_of_week.contains(&dow);

        let day_ok = if dom_restricted && dow_restricted {
            dom_ok || dow_ok
        } else {
            dom_ok && dow_ok
        };

        minute_ok && hour_ok && month_ok && day_ok
    }

    /// The next minute boundary, at or after `after`, that matches the
    /// schedule. Scans up to one year ahead; returns `None` if nothing matches
    /// in that window (e.g. an impossible date like Feb 30).
    pub fn next_after(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        // Advance to the start of the next whole minute.
        let mut candidate = (after + chrono::Duration::minutes(1))
            .with_second(0)?
            .with_nanosecond(0)?;
        // 366 days * 24h * 60m minutes of scan budget.
        let max_iterations = 366 * 24 * 60;
        for _ in 0..max_iterations {
            if self.matches(candidate) {
                return Some(candidate);
            }
            candidate += chrono::Duration::minutes(1);
        }
        None
    }
}

/// Parse one cron field into the sorted, de-duplicated set of values it covers.
fn parse_field(field: &str, min: u8, max: u8) -> Result<Vec<u8>, String> {
    let mut values: Vec<u8> = Vec::new();
    for part in field.split(',') {
        let (range_part, step) = match part.split_once('/') {
            Some((r, s)) => {
                let step: u8 = s
                    .parse()
                    .map_err(|_| format!("invalid step '{s}' in field '{field}'"))?;
                if step == 0 {
                    return Err(format!("step cannot be zero in field '{field}'"));
                }
                (r, step)
            }
            None => (part, 1),
        };

        let (start, end) = if range_part == "*" {
            (min, max)
        } else if let Some((a, b)) = range_part.split_once('-') {
            let a: u8 = a
                .parse()
                .map_err(|_| format!("invalid range start '{a}' in field '{field}'"))?;
            let b: u8 = b
                .parse()
                .map_err(|_| format!("invalid range end '{b}' in field '{field}'"))?;
            (a, b)
        } else {
            let v: u8 = range_part
                .parse()
                .map_err(|_| format!("invalid value '{range_part}' in field '{field}'"))?;
            (v, v)
        };

        if start < min || end > max || start > end {
            return Err(format!(
                "value out of range [{min}-{max}] in field '{field}': {start}-{end}"
            ));
        }

        let mut v = start;
        while v <= end {
            values.push(v);
            v += step;
        }
    }

    values.sort_unstable();
    values.dedup();
    if values.is_empty() {
        return Err(format!("field '{field}' matched no values"));
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn every_minute_matches_any() {
        let s = CronSchedule::parse("* * * * *").unwrap();
        assert!(s.matches(at(2026, 6, 3, 12, 34)));
    }

    #[test]
    fn specific_minute_hour() {
        let s = CronSchedule::parse("30 9 * * *").unwrap();
        assert!(s.matches(at(2026, 6, 3, 9, 30)));
        assert!(!s.matches(at(2026, 6, 3, 9, 31)));
        assert!(!s.matches(at(2026, 6, 3, 10, 30)));
    }

    #[test]
    fn step_and_list_and_range() {
        let s = CronSchedule::parse("*/15 9-17 * * 1-5").unwrap();
        // Tuesday 2026-06-02 at 09:15 — weekday in range, minute on step.
        assert!(s.matches(at(2026, 6, 2, 9, 15)));
        // Same time but Sunday — weekday out of range.
        assert!(!s.matches(at(2026, 6, 7, 9, 15)));
        // Minute not on the 15 step.
        assert!(!s.matches(at(2026, 6, 2, 9, 16)));
    }

    #[test]
    fn dow_seven_is_sunday() {
        let s = CronSchedule::parse("0 0 * * 7").unwrap();
        // 2026-06-07 is a Sunday.
        assert!(s.matches(at(2026, 6, 7, 0, 0)));
    }

    #[test]
    fn next_after_finds_following_minute() {
        let s = CronSchedule::parse("0 0 * * *").unwrap();
        let next = s.next_after(at(2026, 6, 3, 12, 0)).unwrap();
        assert_eq!(next, at(2026, 6, 4, 0, 0));
    }

    #[test]
    fn rejects_bad_field_count() {
        assert!(CronSchedule::parse("* * *").is_err());
    }

    #[test]
    fn rejects_out_of_range() {
        assert!(CronSchedule::parse("99 * * * *").is_err());
    }

    // ── extra coverage ───────────────────────────────────────────────────────

    #[test]
    fn parse_field_rejects_malformed_inputs() {
        // Step of zero.
        assert!(CronSchedule::parse("*/0 * * * *").is_err());
        // Non-numeric step.
        assert!(CronSchedule::parse("*/x * * * *").is_err());
        // Range with a non-numeric bound.
        assert!(CronSchedule::parse("a-5 * * * *").is_err());
        assert!(CronSchedule::parse("5-b * * * *").is_err());
        // Inverted range (start > end).
        assert!(CronSchedule::parse("30-10 * * * *").is_err());
        // Value out of the field's own range (day-of-month max is 31).
        assert!(CronSchedule::parse("* * 32 * *").is_err());
        // Month field 0 is below the [1-12] minimum.
        assert!(CronSchedule::parse("* * * 0 *").is_err());
        // A plain non-numeric value.
        assert!(CronSchedule::parse("foo * * * *").is_err());
    }

    #[test]
    fn list_and_stepped_range_expand_and_dedup() {
        // A comma list plus a stepped range; both hours match, minute on the list.
        let s = CronSchedule::parse("0,30 10-14/2 * * *").unwrap();
        assert!(s.matches(at(2026, 6, 3, 10, 0)));
        assert!(s.matches(at(2026, 6, 3, 12, 30)));
        assert!(s.matches(at(2026, 6, 3, 14, 0)));
        // 11 is not on the /2 step from 10.
        assert!(!s.matches(at(2026, 6, 3, 11, 0)));
        // 15 was beyond the 10-14 range.
        assert!(!s.matches(at(2026, 6, 3, 15, 0)));
    }

    #[test]
    fn dom_and_dow_both_restricted_matches_either() {
        // Friday the 13th convention: DOM=13 OR DOW=Fri(5) fires.
        let s = CronSchedule::parse("0 0 13 * 5").unwrap();
        // 2026-06-13 is a Saturday — matches on day-of-month.
        assert!(s.matches(at(2026, 6, 13, 0, 0)));
        // 2026-06-05 is a Friday — matches on day-of-week.
        assert!(s.matches(at(2026, 6, 5, 0, 0)));
        // 2026-06-06 is a Saturday, not the 13th — no match.
        assert!(!s.matches(at(2026, 6, 6, 0, 0)));
    }

    #[test]
    fn dom_restricted_dow_wild_requires_dom_only() {
        // When only day-of-month is restricted, it must match (AND with the wild dow).
        let s = CronSchedule::parse("0 0 15 * *").unwrap();
        assert!(s.matches(at(2026, 6, 15, 0, 0)));
        assert!(!s.matches(at(2026, 6, 16, 0, 0)));
    }

    #[test]
    fn next_after_returns_none_for_impossible_date() {
        // February never has a 30th, so this never fires within the one-year scan.
        let s = CronSchedule::parse("0 0 30 2 *").unwrap();
        assert!(s.next_after(at(2026, 1, 1, 0, 0)).is_none());
    }

    #[test]
    fn next_after_skips_to_matching_weekday() {
        // Every Monday at 09:00. From a Wednesday, the next match is the following Monday.
        let s = CronSchedule::parse("0 9 * * 1").unwrap();
        // 2026-06-03 is a Wednesday.
        let next = s.next_after(at(2026, 6, 3, 12, 0)).unwrap();
        // 2026-06-08 is the next Monday.
        assert_eq!(next, at(2026, 6, 8, 9, 0));
        assert_eq!(next.weekday().num_days_from_sunday(), 1);
    }

    #[test]
    fn seven_and_zero_both_mean_sunday_deduped() {
        // "0,7" collapses to a single Sunday entry (dedup), still matching Sunday.
        let s = CronSchedule::parse("0 0 * * 0,7").unwrap();
        assert!(s.matches(at(2026, 6, 7, 0, 0))); // Sunday
        assert!(!s.matches(at(2026, 6, 8, 0, 0))); // Monday
    }
}
