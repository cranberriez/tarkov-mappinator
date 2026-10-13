//! On-request import: reads the log sessions and screenshots that earlier imports have not seen
//! (or that changed since), rebuilds raid start/end history and activity, and associates
//! screenshot positions with raids by capture time. Read-only; the result is stored only when
//! the user commits it.

use super::{
    activity, files,
    model::{ActivityEvent, PositionObservation, RaidRecord},
    parsers,
    parsers::LogEvent,
    session_key, stored_activity, FolderConfig,
};
use chrono::{Duration, Local, NaiveDateTime, TimeZone, Timelike};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Instant, UNIX_EPOCH},
};
use ts_rs::TS;

/// Without an observed end, a raid claims captures for at most this long.
const OPEN_RAID_LIMIT_HOURS: i64 = 3;
const LOG_TIMESTAMP: &str = "%Y-%m-%d %H:%M:%S%.f";

#[derive(Clone, Copy, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum ImportFileKind {
    Screenshot,
    Log,
}

impl ImportFileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Screenshot => "screenshot",
            Self::Log => "log",
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum ImportFileStatus {
    Pending,
    /// Read, but contributed nothing.
    Read,
    /// Read and contributed raid, activity or position data.
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

#[derive(Clone, Debug, Serialize, TS)]
pub struct ImportResult {
    pub raids: Vec<RaidRecord>,
    pub positions: Vec<PositionObservation>,
    pub activity: Vec<ActivityEvent>,
    pub unmatched_screenshots: u32,
    /// Files left out because an earlier import read them and they have not changed since.
    pub already_imported: u32,
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

/// A file as it was when read; later imports skip it while it still matches.
#[derive(Clone, Debug, PartialEq)]
pub struct FileStamp {
    pub path: String,
    pub kind: ImportFileKind,
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    pub modified: i64,
}

impl FileStamp {
    pub fn of(path: &Path, kind: ImportFileKind) -> Option<Self> {
        let meta = fs::metadata(path).ok()?;
        Some(Self {
            path: path.to_string_lossy().into_owned(),
            kind,
            size: meta.len(),
            modified: meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64,
        })
    }
}

/// What earlier imports and monitoring left in history.
#[derive(Default)]
pub struct Known {
    /// Imported files: path → (size, modified).
    pub files: HashMap<String, (u64, i64)>,
    /// Stored raids, so new screenshots can match raids from sessions that are not re-read.
    pub raids: Vec<RaidRecord>,
}

impl Known {
    fn unchanged(&self, stamp: &FileStamp) -> bool {
        self.files.get(&stamp.path) == Some(&(stamp.size, stamp.modified))
    }
}

/// Rebuilds raids from one session's lifecycle records, mirroring the live reducer.
pub fn raids_from_events(session: &str, mut events: Vec<(String, LogEvent)>) -> Vec<RaidRecord> {
    events.sort_by(|a, b| a.0.cmp(&b.0));
    let mut raids = Vec::new();
    let mut current: Option<RaidRecord> = None;
    let (mut map, mut game_mode, mut raw_game_mode) = (None, None, None);
    let mut loading = false;
    for (timestamp, event) in events {
        match event {
            LogEvent::Mode(mode) => game_mode = Some(mode),
            LogEvent::Scene(scene) => {
                raids.extend(current.take());
                map = Some(scene);
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
                current = Some(RaidRecord {
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

/// Index of the raid a capture belongs to. Captures are matched at the filename's minute precision,
/// so raid bounds are compared at minute resolution. `raids` must be sorted by start.
pub fn raid_for_capture(captured: NaiveDateTime, raids: &[RaidRecord]) -> Option<usize> {
    let captured = minute(captured);
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

/// Log sources that carry raid lifecycle or stored activity; the rest are not read.
fn relevant_source(source: &str) -> bool {
    matches!(source, "application" | "output" | "backend" | "push-notifications" | "notifications")
}

/// Lifecycle records and stored activity in one log file; non-UTF-8 bytes are tolerated.
/// Activity IDs match the ones live monitoring gives the same records.
fn read_log(path: &Path, source: &str, session: &str) -> std::io::Result<(Vec<(String, LogEvent)>, Vec<ActivityEvent>)> {
    let lifecycle = matches!(source, "application" | "output" | "backend");
    let mut reader = BufReader::new(fs::File::open(path)?);
    let mut line = Vec::new();
    let mut events = Vec::new();
    let mut found = Vec::new();
    let mut pending = None;
    while reader.read_until(b'\n', &mut line)? > 0 {
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\r', '\n']);
        if lifecycle {
            events.extend(parsers::log_record(text));
        }
        for record in activity::assemble(text, &mut pending) {
            let Some(mut event) = activity::event(&record, source, String::new(), true) else {
                continue;
            };
            if stored_activity(&event) {
                event.id = activity::event_id(activity::fingerprint(Some(&event), session, source, &record));
                found.push(event);
            }
        }
        line.clear();
    }
    Ok((events, found))
}

pub fn run(config: &FolderConfig, known: &Known, cancel: &AtomicBool, mut emit: impl FnMut(ImportEvent)) -> Vec<FileStamp> {
    let mut id = 0;
    let mut already_imported = 0;
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
        let stamps: Vec<_> = paths.iter().map(|p| FileStamp::of(p, ImportFileKind::Log)).collect();
        // Sessions are read whole or not at all: rebuilding raids needs every lifecycle file.
        if !paths.is_empty() && stamps.iter().all(|stamp| stamp.as_ref().is_some_and(|s| known.unchanged(s))) {
            already_imported += paths.len() as u32;
            continue;
        }
        let batch: Vec<_> = paths.iter().map(|p| discovered(&mut id, p, ImportFileKind::Log, Some(name.clone()))).collect();
        emit(ImportEvent::Discovered { files: batch.clone() });
        log_files.push((name, batch, stamps));
    }
    let mut shots: Vec<_> = if config.screenshots.is_empty() {
        Vec::new()
    } else {
        files(Path::new(&config.screenshots)).into_iter().filter(|p| has_extension(p, "png")).collect()
    };
    shots.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    let mut shot_files = Vec::new();
    for path in shots {
        let stamp = FileStamp::of(&path, ImportFileKind::Screenshot);
        if stamp.as_ref().is_some_and(|s| known.unchanged(s)) {
            already_imported += 1;
            continue;
        }
        shot_files.push((discovered(&mut id, &path, ImportFileKind::Screenshot, None), stamp));
    }
    for chunk in shot_files.chunks(250) {
        emit(ImportEvent::Discovered { files: chunk.iter().map(|(file, _)| file.clone()).collect() });
    }

    emit(ImportEvent::Phase { phase: "reading_logs".into() });
    let mut cancelled = false;
    let mut raids = Vec::new();
    let mut activity = Vec::new();
    let mut seen_activity = HashSet::new();
    let mut read = Vec::new();
    let mut batch = Batch { updates: Vec::new(), flushed: Instant::now(), emit: &mut emit };
    'sessions: for (session, files, stamps) in &log_files {
        let mut events = Vec::new();
        let mut session_activity = Vec::new();
        let mut session_read = Vec::new();
        for (file, stamp) in files.iter().zip(stamps) {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break 'sessions;
            }
            let source = file.source.as_deref().unwrap_or("other");
            if !relevant_source(source) {
                batch.push(file.id, ImportFileStatus::Skipped, None, Some("No raid or activity records".into()));
                session_read.extend(stamp.clone());
                continue;
            }
            match read_log(Path::new(&file.path), source, session) {
                Ok((lifecycle, found)) => {
                    let found: Vec<_> = found.into_iter().filter(|event| seen_activity.insert(event.id.clone())).collect();
                    if lifecycle.is_empty() && found.is_empty() {
                        batch.push(file.id, ImportFileStatus::Read, None, None);
                    } else {
                        let detail = format!("{} lifecycle records · {} events", lifecycle.len(), found.len());
                        batch.push(file.id, ImportFileStatus::Used, None, Some(detail));
                    }
                    events.extend(lifecycle);
                    session_activity.extend(found);
                    session_read.extend(stamp.clone());
                }
                Err(error) => batch.push(file.id, ImportFileStatus::Failed, None, Some(error.to_string())),
            }
        }
        let mut timeline: Vec<_> = events
            .iter()
            .filter_map(|(at, event)| match event {
                LogEvent::Mode(mode) => Some((at.clone(), mode.clone())),
                _ => None,
            })
            .collect();
        timeline.sort();
        for event in &mut session_activity {
            event.game_mode = activity::mode_at(&timeline, &event.logged_at).map(Into::into);
        }
        activity.extend(session_activity);
        raids.extend(raids_from_events(session, events));
        read.extend(session_read);
    }
    raids.sort_by(|a, b| a.started_at.cmp(&b.started_at));

    // Captures may belong to raids from sessions that were not re-read.
    let mut candidates = raids.clone();
    let scanned: HashSet<_> = raids.iter().map(|raid| raid.id.clone()).collect();
    candidates.extend(known.raids.iter().filter(|raid| !scanned.contains(&raid.id)).cloned());
    candidates.sort_by(|a, b| a.started_at.cmp(&b.started_at));

    batch.flush();
    (batch.emit)(ImportEvent::Phase { phase: "reading_screenshots".into() });
    let mut positions = Vec::new();
    let mut unmatched = 0;
    for (file, stamp) in &shot_files {
        if cancelled || cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let modified = stamp.as_ref().map(|stamp| UNIX_EPOCH + std::time::Duration::from_millis(stamp.modified.max(0) as u64));
        match parsers::position_file(&file.name, modified) {
            Err(reason) => {
                batch.push(file.id, ImportFileStatus::Skipped, None, Some(reason.into()));
                read.extend(stamp.clone());
            }
            Ok(position) => match raid_for_capture(position.captured, &candidates) {
                // Recorded as read too; a full rescan revisits it if older logs turn up later.
                None => {
                    unmatched += 1;
                    batch.push(file.id, ImportFileStatus::Read, None, Some("No raid at capture time".into()));
                    read.extend(stamp.clone());
                }
                Some(index) => {
                    let raid_id = candidates[index].id.clone();
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
                        captured_at: Some(parsers::capture_text(&position.captured)),
                        raid_id: Some(raid_id.clone()),
                        filename: file.name.clone(),
                    });
                    batch.push(file.id, ImportFileStatus::Used, Some(raid_id), None);
                    read.extend(stamp.clone());
                }
            },
        }
    }
    batch.flush();
    emit(ImportEvent::Finished {
        result: ImportResult { raids, positions, activity, unmatched_screenshots: unmatched, already_imported, cancelled },
    });
    read
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
        assert_eq!(raids[0].map.as_deref(), Some("customs_preset"));
        assert_eq!(raids[0].game_mode.as_deref(), Some("Pve"));
        assert_eq!(raids[0].id, "local:log_s:2026-10-11 11:05:50.338");
        assert!(raids[0].ended_at.as_deref().is_some_and(|end| end.starts_with("2026-10-11 11:12")));
        assert_eq!(raids[1].map.as_deref(), Some("factory_day_preset"));
        assert!(raids[1].ended_at.is_some());
    }

    #[test]
    fn captures_match_by_minute_and_never_cross_into_the_next_raid() {
        let raid = |start: &str, end: Option<&str>| RaidRecord {
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
        let read = run(&config, &Known::default(), &AtomicBool::new(false), |event| events.push(event));
        let discovered: usize = events.iter().map(|e| match e { ImportEvent::Discovered { files } => files.len(), _ => 0 }).sum();
        assert_eq!(discovered, 4);
        let updates: Vec<_> = events.iter().flat_map(|e| match e { ImportEvent::Updated { files } => files.clone(), _ => vec![] }).collect();
        assert_eq!(updates.len(), 4);
        let Some(ImportEvent::Finished { result }) = events.last() else { panic!("no result") };
        assert_eq!(result.raids.len(), 2);
        assert_eq!(result.positions.len(), 1);
        assert_eq!(result.positions[0].raid_id.as_deref(), Some("local:log_2026.10.11_11-00-00_1.2.0:2026-10-11 11:05:50.338"));
        assert!(!result.cancelled);
        // Both logs and both screenshots are recorded, so a second import skips all of them.
        assert_eq!(read.len(), 4);
        let known = Known {
            files: read.iter().map(|stamp| (stamp.path.clone(), (stamp.size, stamp.modified))).collect(),
            raids: result.raids.clone(),
        };
        let mut again = Vec::new();
        run(&config, &known, &AtomicBool::new(false), |event| again.push(event));
        let Some(ImportEvent::Finished { result }) = again.last() else { panic!("no result") };
        assert_eq!(result.already_imported, 4);
        assert!(result.raids.is_empty() && result.positions.is_empty());

        // A new capture in an already-imported raid matches the stored raid.
        let later = SHOT.replace("[11-06]", "[11-07]");
        fs::write(shots.path().join(&later), b"").unwrap();
        let mut third = Vec::new();
        run(&config, &known, &AtomicBool::new(false), |event| third.push(event));
        let Some(ImportEvent::Finished { result }) = third.last() else { panic!("no result") };
        assert_eq!(result.positions.len(), 1);
        assert_eq!(result.positions[0].filename, later);
        assert!(result.positions[0].raid_id.as_deref().is_some_and(|id| id.ends_with("11:05:50.338")));
    }

    #[test]
    fn notifications_become_activity_with_live_ids() {
        const PUSH: &str = include_str!("../../../fixtures/activity/push-notifications.log");
        let logs = tempfile::tempdir().unwrap();
        let session = logs.path().join("log_2026.10.11_11-00-00_1.2.0");
        fs::create_dir(&session).unwrap();
        fs::write(session.join("2026.10.11_11-00-00_1.2.0 push-notifications_000.log"), PUSH).unwrap();
        let config = FolderConfig { logs: logs.path().to_string_lossy().into(), screenshots: String::new() };
        let mut events = Vec::new();
        run(&config, &Known::default(), &AtomicBool::new(false), |event| events.push(event));
        let Some(ImportEvent::Finished { result }) = events.last() else { panic!("no result") };
        assert!(result.activity.iter().any(|event| event.kind == "quest"));
        assert!(result.activity.iter().all(|event| event.id.starts_with("event:")));
    }

    #[test]
    fn activity_carries_the_session_mode_in_effect_when_logged() {
        let line = |at: &str, id: &str| {
            let payload = format!(
                r#"{{"type":"new_message","message":{{"type":10,"templateId":"{id} description","dt":1760000000}}}}"#
            );
            format!("{at}|1.2.0.0.47965|Info|push-notifications|Got notification | ChatMessageReceived
{payload}
")
        };
        let mode = |at: &str, mode: &str| format!("{at}|1.2.0.0.47965|Info|application|Session mode: {mode}
");
        let logs = tempfile::tempdir().unwrap();
        let session = logs.path().join("log_2026.10.11_11-00-00_1.2.0");
        fs::create_dir(&session).unwrap();
        let push = [
            line("2026-10-11 11:00:00.000", "5936d90786f7742b1420ba5b"),
            line("2026-10-11 12:00:00.000", "5936d90786f7742b1420ba5c"),
            line("2026-10-11 13:00:00.000", "5936d90786f7742b1420ba5d"),
        ]
        .concat();
        let application = [mode("2026-10-11 11:30:00.000", "PvpSeason"), mode("2026-10-11 12:30:00.000", "Pve")].concat();
        fs::write(session.join("2026.10.11_11-00-00_1.2.0 push-notifications_000.log"), push).unwrap();
        fs::write(session.join("2026.10.11_11-00-00_1.2.0 application_000.log"), application).unwrap();
        let config = FolderConfig { logs: logs.path().to_string_lossy().into(), screenshots: String::new() };
        let mut events = Vec::new();
        run(&config, &Known::default(), &AtomicBool::new(false), |event| events.push(event));
        let Some(ImportEvent::Finished { result }) = events.last() else { panic!("no result") };
        let mut modes: Vec<_> = result.activity.iter().filter(|e| e.kind == "quest").map(|e| (e.logged_at.clone(), e.game_mode.clone())).collect();
        modes.sort();
        assert_eq!(
            modes.into_iter().map(|(_, mode)| mode).collect::<Vec<_>>(),
            [None, Some("PvpSeason".to_string()), Some("Pve".to_string())]
        );
    }

    #[test]
    fn cancellation_stops_before_reading() {
        let logs = tempfile::tempdir().unwrap();
        fs::write(logs.path().join("application_000.log"), LOCAL_ENDS).unwrap();
        let config = FolderConfig { logs: logs.path().to_string_lossy().into(), screenshots: String::new() };
        let mut events = Vec::new();
        run(&config, &Known::default(), &AtomicBool::new(true), |event| events.push(event));
        let Some(ImportEvent::Finished { result }) = events.last() else { panic!("no result") };
        assert!(result.cancelled && result.raids.is_empty());
    }
}
