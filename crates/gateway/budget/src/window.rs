//! UTC calendar windows for charged-spend counters.
//!
//! A budget cap is measured over one window: the current UTC day, the current
//! ISO week (Monday 00:00 UTC), the current calendar month, or the lifetime of
//! the counter. Every window is identified by its start instant in Unix
//! seconds, so a counter row is `(scope, id, window, window_start)` and a new
//! window simply starts a new row — nothing has to be "reset" at midnight.

use serde::{Deserialize, Serialize};

const SECS_PER_DAY: i64 = 86_400;

/// The calendar window a spend cap is measured over. All windows are UTC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BudgetWindow {
    /// The current UTC calendar day.
    Daily,
    /// The current ISO week, starting Monday 00:00 UTC.
    Weekly,
    /// The current UTC calendar month.
    Monthly,
    /// Everything the counter has ever recorded. The default, which keeps the
    /// pre-window meaning of a configured `limit`.
    #[default]
    Lifetime,
}

impl BudgetWindow {
    /// Every window, in a stable order. Spend is recorded into all of them so a
    /// rule can switch window without losing the spend already observed.
    pub const ALL: [BudgetWindow; 4] = [
        BudgetWindow::Daily,
        BudgetWindow::Weekly,
        BudgetWindow::Monthly,
        BudgetWindow::Lifetime,
    ];

    /// Stable storage label.
    pub fn as_str(self) -> &'static str {
        match self {
            BudgetWindow::Daily => "daily",
            BudgetWindow::Weekly => "weekly",
            BudgetWindow::Monthly => "monthly",
            BudgetWindow::Lifetime => "lifetime",
        }
    }

    /// Parse a storage label written by [`Self::as_str`].
    pub fn from_storage(label: &str) -> Option<Self> {
        match label {
            "daily" => Some(BudgetWindow::Daily),
            "weekly" => Some(BudgetWindow::Weekly),
            "monthly" => Some(BudgetWindow::Monthly),
            "lifetime" => Some(BudgetWindow::Lifetime),
            _ => None,
        }
    }

    /// Start of the window containing `unix_secs`, in Unix seconds (UTC).
    /// `Lifetime` always starts at 0.
    pub fn start(self, unix_secs: i64) -> i64 {
        let day = unix_secs.div_euclid(SECS_PER_DAY);
        match self {
            BudgetWindow::Daily => day * SECS_PER_DAY,
            BudgetWindow::Weekly => {
                // 1970-01-01 was a Thursday; shift so Monday is weekday 0.
                let weekday = (day + 3).rem_euclid(7);
                (day - weekday) * SECS_PER_DAY
            }
            BudgetWindow::Monthly => {
                let (year, month, _) = civil_from_days(day);
                days_from_civil(year, month, 1) * SECS_PER_DAY
            }
            BudgetWindow::Lifetime => 0,
        }
    }
}

/// Current Unix time in seconds. A clock before the epoch reads as 0.
pub fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Days since 1970-01-01 → proleptic Gregorian `(year, month, day)`.
/// Howard Hinnant's `civil_from_days`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Proleptic Gregorian `(year, month, day)` → days since 1970-01-01.
/// Howard Hinnant's `days_from_civil`.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let month = i64::from(month);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-10-08T15:30:00Z, a Thursday.
    const THU: i64 = 1_791_473_400;

    #[test]
    fn daily_window_starts_at_utc_midnight() {
        // 2026-10-08T00:00:00Z
        assert_eq!(BudgetWindow::Daily.start(THU), 1_791_417_600);
    }

    #[test]
    fn weekly_window_starts_on_monday() {
        // Monday 2026-10-05T00:00:00Z
        assert_eq!(BudgetWindow::Weekly.start(THU), 1_791_158_400);
        // A Monday instant maps to itself at midnight.
        assert_eq!(BudgetWindow::Weekly.start(1_791_158_400), 1_791_158_400);
        // Sunday 2026-10-11T23:59:59Z still belongs to the same week.
        assert_eq!(BudgetWindow::Weekly.start(1_791_763_199), 1_791_158_400);
    }

    #[test]
    fn monthly_window_starts_on_the_first() {
        // 2026-10-01T00:00:00Z
        assert_eq!(BudgetWindow::Monthly.start(THU), 1_790_812_800);
        // Across a year boundary: 2027-01-15 → 2027-01-01.
        assert_eq!(
            BudgetWindow::Monthly.start(1_798_761_600 + 14 * 86_400),
            1_798_761_600
        );
        // A leap-day instant: 2028-02-29T12:00Z → 2028-02-01.
        assert_eq!(BudgetWindow::Monthly.start(1_835_438_400), 1_832_976_000);
    }

    #[test]
    fn lifetime_window_is_fixed() {
        assert_eq!(BudgetWindow::Lifetime.start(THU), 0);
        assert_eq!(BudgetWindow::default(), BudgetWindow::Lifetime);
    }

    #[test]
    fn storage_labels_round_trip() {
        for window in BudgetWindow::ALL {
            assert_eq!(BudgetWindow::from_storage(window.as_str()), Some(window));
        }
        let parsed: BudgetWindow = serde_json::from_str("\"weekly\"").unwrap();
        assert_eq!(parsed, BudgetWindow::Weekly);
    }

    #[test]
    fn civil_conversion_round_trips() {
        for day in [-1_000_000, -1, 0, 1, 19_000, 20_734, 2_000_000] {
            let (y, m, d) = civil_from_days(day);
            assert_eq!(days_from_civil(y, m, d), day);
        }
    }
}
