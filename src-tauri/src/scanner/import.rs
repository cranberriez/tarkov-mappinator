//! On-request import: reads every log session and every screenshot once, rebuilds raid
//! start/end history and associates screenshot positions with raids by capture time.
//! Read-only; results are returned to the frontend, nothing is stored or deleted here.

use super::{activity, files, model::PositionObservation, parsers, parsers::LogEvent, session_key, FolderConfig};
use chrono::{Duration, Local, NaiveDateTime, TimeZone, Timelike};
use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use ts_rs::TS;

/// Without an observed end, a raid claims captures for at most this long.
const OPEN_RAID_LIMIT_HOURS: i64 = 3;
const LOG_TIMESTAMP: &str = "%Y-%m-%d %H:%M:%S%.f";

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum ImportFileKind {
    Screenshot,
    Log,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum ImportFileStatus {
    Pending,
    /// Read, but contributed nothing.
    Read,
    /// Read and contributed raid or position data.
    Used,
    /// Not relevant to the current import (wrong log source, unparseable filename).
    Skipped,
    Failed,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct ImportFile {
    pub id: u32,
    pub kind: ImportFileKind,
    pub name: String,
    pub path: String,
    /// Log session folder name; none for screenshots.
    pub group: Option<String>,
    /// Log source class (application, backend, ...); none for screenshots.
    pub source: Option<String>,
    #[ts(type = "number")]
    pub size: u64,
    pub status: ImportFileStatus,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct ImportFileUpdate {
    pub id: u32,
    pub status: ImportFileStatus,
    pub raid_id: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
pub struct ImportedRaid {
    /// Same scheme as live monitoring, so imported and live raids coincide.
    pub id: String,
    pub session: String,
    pub map: Option<String>,
    pub game_mode: Option<String>,
    pub raw_game_mode: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct ImportResult {
    pub raids: Vec<ImportedRaid>,
    pub positions: Vec<PositionObservation>,
    pub unmatched_screenshots: u32,
    pub cancelled: bool,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ImportEvent {
    Discovered { files: Vec<ImportFile> },
    Updated { files: Vec<ImportFileUpdate> },
    Phase { phase: String },
    Finished { result: ImportResult },
}

/// Rebuilds raids from one session's lifecycle records, mirroring the live reducer.
pub fn raids_from_events(session: &str, mut events: Vec<(String, LogEvent)>) -> Vec<ImportedRaid> {
    events.sort_by(|a, b| a.0.cmp(&b.0));
    let mut raids = Vec::new();
    let mut current: Option<ImportedRaid> = None;
    let (mut map, mut game_mode, mut raw_game_mode) = (None, None, None);
    let mut loading = false;
    for (timestamp, event) in events {
        match event {
            LogEvent::Mode(mode) => game_mode = Some(mode),
            LogEvent::Scene(scene) => {
                raids.extend(current.take());
                map = Some(parsers::scene_map_name(scene));
                raw_game_mode = None;
                loading = true;
            }
            LogEvent::Loading { map: location, mode, .. } => {
                raids.extend(current.take());
                map = Some(location);
                raw_game_mode = Some(mode);
                loading = true;
            }
            LogEvent::Started => {
                if current.as_ref().is_some_and(|raid| raid.started_at == timestamp) {
                    continue;
                }
                raids.extend(current.take());
                current = Some(ImportedRaid {
                    id: format!("local:{session}:{timestamp}"),
                    session: session.into(),
                    map: if loading { map.clone() } else { None },
                    game_mode: game_mode.clone(),
                    raw_game_mode: if loading { raw_game_mode.clone() } else { None },
                    started_at: timestamp,
                    ended_at: None,
                });
                loading = false;
            }
            LogEvent::Ended | LogEvent::LocalEndReported => {
                if let Some(mut raid) = current.take() {
                    raid.ended_at = Some(timestamp);
                    raids.push(raid);
                }
                loading = false;
            }
        }
    }
    raids.extend(current);
    raids
}

fn minute(time: NaiveDateTime) -> NaiveDateTime {
    time.with_second(0).and_then(|t| t.with_nanosecond(0)).unwrap_or(time)
}

/// Index of the raid a capture belongs to. Captures have minute precision, so raid
/// bounds are compared at minute resolution. `raids` must be sorted by start.
pub fn raid_for_capture(captured: NaiveDateTime, raids: &[ImportedRaid]) -> Option<usize> {
    let parse = |value: &str| NaiveDateTime::parse_from_str(value, LOG_TIMESTAMP).ok();
    let index = raids
        .iter()
        .rposition(|raid| parse(&raid.started_at).is_some_and(|start| minute(start) <= captured))?;
    let raid = &raids[index];
    let start = parse(&raid.started_at)?;
    let within = match raid.ended_at.as_deref().and_then(parse) {
        Some(end) => captured <= minute(end),
        None => {
            let next = raids.get(index + 1).and_then(|next| parse(&next.started_at));
            captured <= start + Duration::hours(OPEN_RAID_LIMIT_HOURS) && next.is_none_or(|next| captured < minute(next))
        }
    };
    within.then_some(index)
}

struct Batch<'a, F: FnMut(ImportEvent)> {
    updates: Vec<ImportFileUpdate>,
    flushed: Instant,
    emit: &'a mut F,
}
impl<F: FnMut(ImportEvent)> Batch<'_, F> {
    fn push(&mut self, id: u32, status: ImportFileStatus, raid_id: Option<String>, detail: Option<String>) {
        self.updates.push(ImportFileUpdate { id, status, raid_id, detail });
        if self.updates.len() >= 100 || self.flushed.elapsed().as_millis() >= 60 {
            self.flush();
        }
    }
    fn flush(&mut self) {
        if !self.updates.is_empty() {
            (self.emit)(ImportEvent::Updated { files: std::mem::take(&mut self.updates) });
        }
        self.flushed = Instant::now();
    }
}

fn discovered(id: &mut u32, path: &Path, kind: ImportFileKind, group: Option<String>) -> ImportFile {
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    *id += 1;
    ImportFile {
        id: *id,
        source: matches!(kind, ImportFileKind::Log).then(|| activity::source_class(&name.to_lowercase()).into()),
        kind,
        path: path.to_string_lossy().into_owned(),
        size: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        group,
        name,
        status: ImportFileStatus::Pending,
    }
}

fn has_extension(path: &Path, extension: &str) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case(extension))
}

/// Lifecycle records in one log file; non-UTF-8 bytes are tolerated.
fn read_lifecycle(path: &Path) -> std::io::Result<Vec<(String, LogEvent)>> {
    let mut reader = BufReader::new(fs::File::open(path)?);
    let mut line = Vec::new();
    let mut events = Vec::new();
    while reader.read_until(b'\n', &mut line)? > 0 {
        let text = String::from_utf8_lossy(&line);
        if let Some(record) = parsers::log_record(text.trim_end_matches(['\r', '\n'])) {
            events.push(record);
        }
        line.clear();
    }
    Ok(events)
}

pub fn run(config: &FolderConfig, cancel: &AtomicBool, mut emit: impl FnMut(ImportEvent)) {
    let mut id = 0;
    let logs_root = PathBuf::from(&config.logs);
    let mut sessions: Vec<PathBuf> = fs::read_dir(&logs_root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    sessions.sort_by_key(|p| std::cmp::Reverse(session_key(p)));
    if sessions.is_empty() && logs_root.is_dir() {
        sessions.push(logs_root);
    }

    emit(ImportEvent::Phase { phase: "discovering".into() });
    let mut log_files = Vec::new();
    for session in &sessions {
        let name = session.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let mut paths: Vec<_> = files(session).into_iter().filter(|p| has_extension(p, "log")).collect();
        paths.sort();
        let batch: Vec<_> = paths.iter().map(|p| discovered(&mut id, p, ImportFileKind::Log, Some(name.clone()))).collect();
        log_files.push((name, batch.clone()));
        emit(ImportEvent::Discovered { files: batch });
    }
    let mut shots: Vec<_> = if config.screenshots.is_empty() {
        Vec::new()
    } else {
        files(Path::new(&config.screenshots)).into_iter().filter(|p| has_extension(p, "png")).collect()
    };
    shots.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    let shots: Vec<_> = shots.iter().map(|p| discovered(&mut id, p, ImportFileKind::Screenshot, None)).collect();
    for chunk in shots.chunks(250) {
        emit(ImportEvent::Discovered { files: chunk.to_vec() });
    }

    emit(ImportEvent::Phase { phase: "reading_logs".into() });
    let mut cancelled = false;
    let mut raids = Vec::new();
    let mut batch = Batch { updates: Vec::new(), flushed: Instant::now(), emit: &mut emit };
    'sessions: for (session, files) in &log_files {
        let mut events = Vec::new();
        for file in files {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break 'sessions;
            }
            if !matches!(file.source.as_deref(), Some("application" | "output" | "backend")) {
                batch.push(file.id, ImportFileStatus::Skipped, None, Some("No raid lifecycle records".into()));
                continue;
            }
            match read_lifecycle(Path::new(&file.path)) {
                Ok(found) if found.is_empty() => batch.push(file.id, ImportFileStatus::Read, None, None),
                Ok(found) => {
                    batch.push(file.id, ImportFileStatus::Used, None, Some(format!("{} lifecycle records", found.len())));
                    events.extend(found);
                }
                Err(error) => batch.push(file.id, ImportFileStatus::Failed, None, Some(error.to_string())),
            }
        }
        raids.extend(raids_from_events(session, events));
    }
    raids.sort_by(|a, b| a.started_at.cmp(&b.started_at));

    batch.flush();
    (batch.emit)(ImportEvent::Phase { phase: "reading_screenshots".into() });
    let mut positions = Vec::new();
    let mut unmatched = 0;
    for file in &shots {
        if cancelled || cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        match parsers::position_filename(&file.name) {
            Err(reason) => batch.push(file.id, ImportFileStatus::Skipped, None, Some(reason.into())),
            Ok(position) => match raid_for_capture(position.captured, &raids) {
                None => {
                    unmatched += 1;
                    batch.push(file.id, ImportFileStatus::Read, None, Some("No raid at capture time".into()));
                }
                Some(index) => {
                    let raid_id = raids[index].id.clone();
                    positions.push(PositionObservation {
                        xyz: position.xyz,
                        raw_quaternion: position.quaternion,
                        heading_degrees: position.heading_degrees,
                        heading_convention: parsers::HEADING_CONVENTION.into(),
                        // Imported captures were never received live; receipt time is the capture time.
                        observed_at: Local
                            .from_local_datetime(&position.captured)
                            .earliest()
                            .map(|t| t.to_rfc3339())
                            .unwrap_or_default(),
                        captured_at: Some(position.captured.to_string()),
                        raid_id: Some(raid_id.clone()),
                        filename: file.name.clone(),
                    });
                    batch.push(file.id, ImportFileStatus::Used, Some(raid_id), None);
                }
            },
        }
    }
    batch.flush();
    emit(ImportEvent::Finished {
        result: ImportResult { raids, positions, unmatched_screenshots: unmatched, cancelled },
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    const LOCAL_ENDS: &str = include_str!("../../../fixtures/logs/pve-local-ends.log");
    const SHOT: &str = "2026-10-11[11-06]_176.89, 4.38, 164.86_-0.00534, 0.99448, -0.06416, -0.08281_9.79 (0).png";

    fn time(value: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn fixture_session_rebuilds_two_ended_raids_with_live_ids() {
        let events = LOCAL_ENDS.lines().filter_map(parsers::log_record).collect();
        let raids = raids_from_events("log_s", events);
        assert_eq!(raids.len(), 2);
        assert_eq!(raids[0].map.as_deref(), Some("Customs"));
        assert_eq!(raids[0].game_mode.as_deref(), Some("Pve"));
        assert_eq!(raids[0].id, "local:log_s:2026-10-11 11:05:50.338");
        assert!(raids[0].ended_at.as_deref().is_some_and(|end| end.starts_with("2026-10-11 11:12")));
        assert_eq!(raids[1].map.as_deref(), Some("factory_day_preset"));
        assert!(raids[1].ended_at.is_some());
    }

    #[test]
    fn captures_match_by_minute_and_never_cross_into_the_next_raid() {
        let raid = |start: &str, end: Option<&str>| ImportedRaid {
            id: start.into(), session: "s".into(), map: None, game_mode: None, raw_game_mode: None,
            started_at: start.into(), ended_at: end.map(Into::into),
        };
        let raids = vec![
            raid("2026-10-11 10:00:30.000", Some("2026-10-11 10:30:10.000")),
            raid("2026-10-11 11:00:00.000", None),
            raid("2026-10-11 11:20:00.000", None),
        ];
        assert_eq!(raid_for_capture(time("2026-10-11 10:00"), &raids), Some(0));
        assert_eq!(raid_for_capture(time("2026-10-11 10:30"), &raids), Some(0));
        assert_eq!(raid_for_capture(time("2026-10-11 10:31"), &raids), None);
        assert_eq!(raid_for_capture(time("2026-10-11 11:19"), &raids), Some(1));
        assert_eq!(raid_for_capture(time("2026-10-11 11:20"), &raids), Some(2));
        assert_eq!(raid_for_capture(time("2026-10-11 14:21"), &raids), None);
        assert_eq!(raid_for_capture(time("2026-10-11 09:59"), &raids), None);
    }

    #[test]
    fn run_streams_files_and_associates_screenshots() {
        let logs = tempfile::tempdir().unwrap();
        let session = logs.path().join("log_2026.10.11_11-00-00_1.2.0");
        fs::create_dir(&session).unwrap();
        fs::write(session.join("2026.10.11_11-00-00_1.2.0 application_000.log"), LOCAL_ENDS).unwrap();
        fs::write(session.join("2026.10.11_11-00-00_1.2.0 errors_000.log"), "").unwrap();
        let shots = tempfile::tempdir().unwrap();
        fs::write(shots.path().join(SHOT), b"").unwrap();
        fs::write(shots.path().join("not-a-capture.png"), b"").unwrap();
        let config = FolderConfig {
            logs: logs.path().to_string_lossy().into(),
            screenshots: shots.path().to_string_lossy().into(),
        };
        let mut events = Vec::new();
        run(&config, &AtomicBool::new(false), |event| events.push(event));
        let discovered: usize = events.iter().map(|e| match e { ImportEvent::Discovered { files } => files.len(), _ => 0 }).sum();
        assert_eq!(discovered, 4);
        let updates: Vec<_> = events.iter().flat_map(|e| match e { ImportEvent::Updated { files } => files.clone(), _ => vec![] }).collect();
        assert_eq!(updates.len(), 4);
        let Some(ImportEvent::Finished { result }) = events.last() else { panic!("no result") };
        assert_eq!(result.raids.len(), 2);
        assert_eq!(result.positions.len(), 1);
        assert_eq!(result.positions[0].raid_id.as_deref(), Some("local:log_2026.10.11_11-00-00_1.2.0:2026-10-11 11:05:50.338"));
        assert!(!result.cancelled);
    }

    #[test]
    fn cancellation_stops_before_reading() {
        let logs = tempfile::tempdir().unwrap();
        fs::write(logs.path().join("application_000.log"), LOCAL_ENDS).unwrap();
        let config = FolderConfig { logs: logs.path().to_string_lossy().into(), screenshots: String::new() };
        let mut events = Vec::new();
        run(&config, &AtomicBool::new(true), |event| events.push(event));
        let Some(ImportEvent::Finished { result }) = events.last() else { panic!("no result") };
        assert!(result.cancelled && result.raids.is_empty());
    }
}
