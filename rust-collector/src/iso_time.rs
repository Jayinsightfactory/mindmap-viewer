use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Format Unix epoch milliseconds as valid RFC3339 / ISO8601 UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`).
/// Uses Howard Hinnant's civil-from-days algorithm with zero external dependencies.
pub fn format_epoch_ms_iso(epoch_ms: u64) -> String {
    let total_secs = epoch_ms / 1000;
    let millis = epoch_ms % 1000;
    let days = (total_secs / 86_400) as i64;
    let sec_of_day = total_secs % 86_400;
    let hour = sec_of_day / 3600;
    let minute = (sec_of_day % 3600) / 60;
    let second = sec_of_day % 60;

    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, millis
    )
}

pub fn now_iso() -> String {
    format_epoch_ms_iso(now_ms())
}

/// Parse an RFC3339/ISO8601 UTC string (`YYYY-MM-DDTHH:MM:SS[.sss]Z`) into Unix epoch ms.
/// Used to honor `~/.orbit/personal-pause-until`.
pub fn parse_iso_utc_ms(s: &str) -> Option<u64> {
    let trimmed = s.trim();
    if !trimmed.ends_with('Z') && !trimmed.ends_with('z') {
        return None;
    }
    let core = &trimmed[..trimmed.len() - 1];
    let (date_part, time_part) = core.split_once('T')?;
    let mut d_iter = date_part.split('-');
    let year: i64 = d_iter.next()?.parse().ok()?;
    let month: u32 = d_iter.next()?.parse().ok()?;
    let day: u32 = d_iter.next()?.parse().ok()?;
    if d_iter.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let (hms, frac_ms) = match time_part.split_once('.') {
        Some((h, f)) => {
            let mut digits = f.chars().take(3).collect::<String>();
            while digits.len() < 3 {
                digits.push('0');
            }
            let ms: u64 = digits.parse().ok()?;
            (h, ms)
        }
        None => (time_part, 0),
    };

    let mut t_iter = hms.split(':');
    let hour: u64 = t_iter.next()?.parse().ok()?;
    let minute: u64 = t_iter.next()?.parse().ok()?;
    let second: u64 = t_iter.next()?.parse().ok()?;
    if t_iter.next().is_some() || hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let days = days_from_civil(year, month, day);
    if days < 0 {
        return None;
    }
    let total_secs = (days as u64) * 86_400 + hour * 3600 + minute * 60 + second;
    Some(total_secs * 1000 + frac_ms)
}

pub fn is_valid_rfc3339_utc(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 24 {
        return false;
    }
    b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b'.'
        && b[23] == b'Z'
        && parse_iso_utc_ms(s).is_some()
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m as u32, d as u32)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m_adj = if m > 2 { (m - 3) as u64 } else { (m + 9) as u64 };
    let doy = (153 * m_adj + 2) / 5 + (d as u64) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + (doe as i64) - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_timestamps_as_rfc3339_utc() {
        assert_eq!(format_epoch_ms_iso(0), "1970-01-01T00:00:00.000Z");
        // 2024-02-29T23:59:59.999Z (leap year)
        assert_eq!(
            format_epoch_ms_iso(1_709_251_199_999),
            "2024-02-29T23:59:59.999Z"
        );
        // 2026-11-25T01:40:50.123Z
        assert_eq!(
            format_epoch_ms_iso(1_795_570_850_123),
            "2026-11-25T01:40:50.123Z"
        );
        let cur = now_iso();
        assert!(is_valid_rfc3339_utc(&cur), "invalid now_iso: {cur}");
    }

    #[test]
    fn roundtrips_parse_and_format() {
        let samples = [
            "1970-01-01T00:00:00.000Z",
            "2024-02-29T12:34:56.789Z",
            "2026-11-25T01:40:50.123Z",
        ];
        for s in samples {
            let ms = parse_iso_utc_ms(s).expect("should parse");
            assert_eq!(format_epoch_ms_iso(ms), s);
        }
        assert!(parse_iso_utc_ms("1795570850123").is_none());
        assert!(!is_valid_rfc3339_utc("1795570850123"));
    }
}
