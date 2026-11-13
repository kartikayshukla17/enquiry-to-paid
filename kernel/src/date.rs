//! Minimal proleptic-Gregorian date helpers (UTC, integer only). No clock access.

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn num(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Parses `YYYY-MM-DD` into (days since epoch, month).
pub fn parse_date(s: &str) -> Option<(i64, i64)> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, m, d) = (num(&s[0..4])?, num(&s[5..7])?, num(&s[8..10])?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let days = days_from_civil(y, m, d);
    if civil_from_days(days) != (y, m, d) {
        return None; // e.g. Feb 30
    }
    Some((days, m))
}

/// 0 = sun .. 6 = sat. 1970-01-01 was a Thursday.
pub fn weekday_index(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

pub const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// Parses `YYYY-MM-DDTHH:MM:SSZ` into epoch seconds.
pub fn parse_instant(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    // `YYYY-MM-DDTHH:MM:SS` followed by either `Z` or a fractional part `.<digits>Z`. The fraction is
    // truncated, never rounded, so both spellings of the same wall-clock second are one instant. The
    // fractional form is accepted because the chain functions already stamp JavaScript's own
    // `new Date().toISOString()` (which always carries milliseconds) into ledger `at` values; rejecting
    // it here made `evaluate` disagree with the rest of the kernel about what a valid instant is.
    if b.len() < 20 || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    if b[19] == b'.' {
        if b.len() < 22 || *b.last()? != b'Z' || !b[20..b.len() - 1].iter().all(u8::is_ascii_digit) {
            return None;
        }
    } else if b.len() != 20 || b[19] != b'Z' {
        return None;
    }
    let (days, _) = parse_date(&s[0..10])?;
    let (h, mi, se) = (num(&s[11..13])?, num(&s[14..16])?, num(&s[17..19])?);
    if h > 23 || mi > 59 || se > 59 {
        return None;
    }
    Some(days * 86_400 + h * 3600 + mi * 60 + se)
}

pub fn format_instant(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}
