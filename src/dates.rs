//! Local-calendar date helpers shared by every command that reasons about
//! "days" (report ranges, today's tracked time).

use anyhow::{Context, Result};
use chrono::{Local, NaiveDate, TimeZone};

pub fn parse_local_day_start(day: &str) -> Result<i64> {
    local_day_start_ms(parse_day(day)?)
}

/// `--until 2026-01-31` should include the 31st: use the *next* day's
/// start as the exclusive upper bound.
pub fn parse_local_day_start_after(day: &str) -> Result<i64> {
    let next = parse_day(day)?
        .succ_opt()
        .with_context(|| format!("no day after {day}"))?;
    local_day_start_ms(next)
}

pub fn parse_day(day: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .with_context(|| format!("invalid date {day:?} — expected YYYY-MM-DD"))
}

pub fn local_day_start_ms(day: NaiveDate) -> Result<i64> {
    let midnight = day.and_hms_opt(0, 0, 0).expect("midnight always exists");
    let local = Local
        .from_local_datetime(&midnight)
        .earliest() // DST gap at midnight → first valid instant
        .with_context(|| format!("could not resolve local midnight of {day}"))?;
    Ok(local.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_must_be_iso_days() {
        assert!(parse_day("2026-01-31").is_ok());
        assert!(parse_day("01/31/2026").is_err());
        assert!(parse_day("2026-13-01").is_err());
    }

    #[test]
    fn until_bound_is_the_start_of_the_next_day() {
        let day_start = parse_local_day_start("2026-01-31").unwrap();
        let bound = parse_local_day_start_after("2026-01-31").unwrap();
        assert_eq!(bound - day_start, 24 * 60 * 60 * 1000);
    }
}
