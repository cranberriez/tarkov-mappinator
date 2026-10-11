use chrono::NaiveDateTime;
use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, PartialEq)]
pub enum LogEvent {
    Loading {
        map: String,
        id: String,
        mode: String,
        raid_mode: String,
    },
    Started,
    Ended,
    Mode(String),
    Scene(String),
}

/// Parses standalone records, never continuation/stack-trace lines.
pub fn log_record(line: &str) -> Option<(String, LogEvent)> {
    static HEADER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:[0-5][0-9]\.\d{3})\|\d+\.\d+\.\d+\.\d+\.\d+\|(Info|Debug|Warn|Error)\|(application|output)\|([^\r\n|]+)$"
    ).unwrap()
    });
    static SCENE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^scene preset path:maps/([A-Za-z0-9_-]+)\.bundle rcid:[A-Za-z0-9_.-]+$")
            .unwrap()
    });
    static START: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"^GameStarted:\d+(?:\.\d+)?\(\d+(?:\.\d+)?\) real:\d+(?:\.\d+)?\(\d+(?:\.\d+)?\) diff:-?\d+(?:\.\d+)?$"
    ).unwrap()
    });
    static END: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^Connection\.Disconnect\(\) TransportId:\d+ address:\S+ Reason:Stop game$")
            .unwrap()
    });
    static MODE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^Session mode: ([A-Za-z][A-Za-z0-9_]*)$").unwrap());
    let header = HEADER.captures(line)?;
    NaiveDateTime::parse_from_str(&header[1], "%Y-%m-%d %H:%M:%S%.f").ok()?;
    let level = &header[2];
    let category = &header[3];
    let message = &header[4];
    let event = if category == "output" && level == "Info" && END.is_match(message) {
        LogEvent::Ended
    } else if category != "application" {
        return None;
    } else if level == "Debug" && message.starts_with("TRACE-NetworkGameCreate profileStatus: '") {
        let raw = message.strip_prefix("TRACE-NetworkGameCreate profileStatus: '")?;
        let raw = raw.strip_suffix('\'').unwrap_or(raw);
        let mut fields = std::collections::HashMap::new();
        for part in raw.split(", ") {
            let (key, value) = part.split_once(": ")?;
            if value.is_empty() || value.trim() != value || fields.insert(key, value).is_some() {
                return None;
            }
        }
        LogEvent::Loading {
            map: fields.get("Location")?.to_string(),
            id: fields.get("shortId")?.to_string(),
            mode: fields.get("GameMode")?.to_string(),
            raid_mode: fields.get("RaidMode")?.to_string(),
        }
    } else if level == "Info" {
        match message {
            _ if MODE.is_match(message) => LogEvent::Mode(MODE.captures(message)?[1].into()),
            _ if START.is_match(message) => LogEvent::Started,
            _ => LogEvent::Scene(SCENE.captures(message)?[1].into()),
        }
    } else {
        return None;
    };
    Some((header[1].to_owned(), event))
}

pub const HEADING_CONVENTION: &str = "UNVERIFIED: assumed Unity x,y,z,w quaternion, +Z forward yaw atan2(x,z) in degrees about +Y; game/map compass calibration unknown";

#[derive(Debug)]
pub struct ParsedPosition {
    pub captured: NaiveDateTime,
    pub xyz: [f64; 3],
    pub quaternion: [f64; 4],
    pub heading_degrees: Option<f64>,
}

pub fn position_filename(filename: &str) -> Result<ParsedPosition, &'static str> {
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"^(\d{4}-\d{2}-\d{2}\[\d{2}-\d{2}\])_([^_]+)_([^_]+)_([0-9]+(?:\.[0-9]+)?) \(([0-9]+)\)\.png$"
    ).unwrap()
    });
    let captures = PATTERN
        .captures(filename)
        .ok_or("Filename has no validated Tarkov position metadata.")?;
    // Chrono requires seconds; the filename provides only minute precision.
    let captured =
        NaiveDateTime::parse_from_str(&format!("{}:00", &captures[1]), "%Y-%m-%d[%H-%M]:%S")
            .map_err(|_| "Invalid capture timestamp.")?;
    fn number(raw: &str) -> Result<f64, &'static str> {
        static NUMBER: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$").unwrap()
        });
        if !NUMBER.is_match(raw) {
            return Err("Invalid position/quaternion number.");
        }
        let value = raw
            .parse::<f64>()
            .map_err(|_| "Invalid position/quaternion number.")?;
        if !value.is_finite() {
            return Err("Nonfinite position/quaternion.");
        }
        Ok(value)
    }
    fn vector<const N: usize>(raw: &str) -> Result<[f64; N], &'static str> {
        raw.split(',')
            .map(|value| number(value.trim()))
            .collect::<Result<Vec<_>, _>>()?
            .try_into()
            .map_err(|_| "Unexpected position/quaternion component count.")
    }
    number(&captures[4])?;
    let quaternion = vector(&captures[3])?;
    Ok(ParsedPosition {
        captured,
        xyz: vector(&captures[2])?,
        quaternion,
        heading_degrees: provisional_yaw(quaternion),
    })
}

/// Pure mathematical assumption, not a calibrated game or map heading.
fn provisional_yaw(raw: [f64; 4]) -> Option<f64> {
    if raw.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let scale = raw.iter().map(|value| value.abs()).fold(0.0_f64, f64::max);
    if scale == 0.0 {
        return None;
    }
    let scaled = raw.map(|value| value / scale);
    let norm = scaled.iter().map(|value| value * value).sum::<f64>().sqrt();
    let [x, y, z, w] = scaled.map(|value| value / norm);
    let forward_x = 2.0 * (x * z + w * y);
    let forward_z = 1.0 - 2.0 * (x * x + y * y);
    if forward_x.hypot(forward_z) < 1e-12 {
        return None;
    }
    Some(forward_x.atan2(forward_z).to_degrees().rem_euclid(360.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    const PVE: &str = include_str!("../../../fixtures/logs/pve-customs-started.log");
    const ONLINE: &str = include_str!("../../../fixtures/logs/online-interchange-ended.log");

    #[test]
    fn real_screenshots_preserve_metadata_and_minute() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/screenshots/filenames.json"))
                .unwrap();
        let captures = fixture["captures"].as_array().unwrap();
        let first = position_filename(captures[0]["basename"].as_str().unwrap()).unwrap();
        assert_eq!(first.captured.to_string(), "2026-10-11 11:06:00");
        assert_eq!(first.xyz, [176.89, 4.38, 164.86]);
        assert_eq!(first.quaternion, [-0.00534, 0.99448, -0.06416, -0.08281]);
        let second = position_filename(captures[1]["basename"].as_str().unwrap()).unwrap();
        assert_eq!(second.xyz, [74.02, 28.58, 172.16]);
        assert_eq!(second.quaternion, [-0.08290, 0.18895, -0.01575, -0.97835]);
        assert!(first.heading_degrees.is_some());
        assert!(HEADING_CONVENTION.starts_with("UNVERIFIED"));
        let valid = captures[0]["basename"].as_str().unwrap();
        for malformed in [
            valid.replace("176.89", "NaN"),
            valid.replace("176.89", "1e999"),
            valid.replace("11-06", "25-06"),
            valid.replace("10-11", "02-30"),
            valid.replace("164.86", "164.86, 1"),
            valid.replace(" (0)", " nonsense"),
            format!("prefix{valid}"),
            valid.replace("_9.79", "_NaN"),
        ] {
            assert!(position_filename(&malformed).is_err(), "{malformed}");
        }
        let zero = position_filename(
            &valid.replace("-0.00534, 0.99448, -0.06416, -0.08281", "0, 0, 0, 0"),
        )
        .unwrap();
        assert_eq!(zero.quaternion, [0.; 4]);
        assert_eq!(zero.heading_degrees, None);
    }

    #[test]
    fn synthetic_quaternion_math_is_optional_and_uncalibrated() {
        let s = std::f64::consts::FRAC_1_SQRT_2;
        for (raw, expected) in [
            ([0., 0., 0., 1.], 0.),
            ([0., s, 0., s], 90.),
            ([0., 1., 0., 0.], 180.),
            ([0., -s, 0., s], 270.),
        ] {
            assert!((provisional_yaw(raw).unwrap() - expected).abs() < 1e-10);
            assert!((provisional_yaw(raw.map(|v| -v * 100.)).unwrap() - expected).abs() < 1e-10);
        }
        assert_eq!(provisional_yaw([0.; 4]), None);
        assert_eq!(provisional_yaw([s, 0., 0., s]), None);
        assert_eq!(provisional_yaw([f64::NAN, 0., 0., 1.]), None);
    }

    #[test]
    fn real_pve_fixture_mode_switch_and_only_explicit_start() {
        let events: Vec<_> = PVE
            .lines()
            .filter_map(log_record)
            .map(|(_, event)| event)
            .collect();
        assert_eq!(
            events,
            vec![
                LogEvent::Mode("PvpSeason".into()),
                LogEvent::Mode("Pve".into()),
                LogEvent::Scene("customs_preset".into()),
                LogEvent::Started
            ]
        );
        // No completed PvE raid is evidenced: PvE ending is UNVALIDATED.
        assert!(!events.contains(&LogEvent::Ended));
    }

    #[test]
    fn real_online_fixture_preserves_trace_and_exact_disconnect() {
        let events: Vec<_> = ONLINE
            .lines()
            .filter_map(log_record)
            .map(|(_, event)| event)
            .collect();
        assert_eq!(
            events,
            vec![
                LogEvent::Scene("shopping_mall".into()),
                LogEvent::Loading {
                    map: "Interchange".into(),
                    id: "<SHORT>".into(),
                    mode: "deathmatch".into(),
                    raid_mode: "Online".into()
                },
                LogEvent::Started,
                LogEvent::Ended
            ]
        );
        for line in ONLINE
            .lines()
            .filter(|line| line.contains("OnGameSessionEnd"))
        {
            assert!(log_record(line).is_none());
        }
        let end = ONLINE
            .lines()
            .find(|line| line.contains("Connection.Disconnect"))
            .unwrap();
        for invalid in [
            end.replace("Stop game", "Stop gameplay"),
            end.replace("Stop game", "Stop game session pending"),
            end.replace("|output|", "|application|"),
            end.replace("2026-10-11", "2026-02-30"),
            end.replace("|Info|", "|garbage|"),
            end.replace("1.2.0.0.47965", "bad"),
            format!("{end}|extra"),
        ] {
            assert!(log_record(&invalid).is_none(), "{invalid}");
        }
        let mode = PVE.lines().next().unwrap();
        assert_eq!(
            log_record(&mode.replace("PvpSeason", "Online")).unwrap().1,
            LogEvent::Mode("Online".into())
        );
        assert_eq!(
            log_record(&mode.replace("PvpSeason", "FutureMode"))
                .unwrap()
                .1,
            LogEvent::Mode("FutureMode".into())
        );
        assert!(log_record(&mode.replace("PvpSeason", "Pve trailing")).is_none());
        assert!(
            log_record("EFT.Player:OnGameSessionEnd(ExitStatus, Single, String, String)").is_none()
        );
    }
}
