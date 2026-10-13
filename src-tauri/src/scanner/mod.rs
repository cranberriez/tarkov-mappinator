mod activity;
pub mod import;
mod model;
mod parsers;
mod sources;

use chrono::{Local, NaiveDateTime};
use model::LogCoverage;
pub use model::{
    FolderConfig, MonitoringStatus, PositionObservation, ScannerSnapshot, SourceStatus,
};
use parsers::LogEvent;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

struct Tail {
    offset: u64,
    pending: String,
    created: Option<SystemTime>,
    modified: Option<SystemTime>,
    prefix: Vec<u8>,
    notification: Option<(String, String)>,
}
pub struct ScannerService {
    snapshot: ScannerSnapshot,
    seen: HashSet<PathBuf>,
    tails: HashMap<PathBuf, Tail>,
    boundary: NaiveDateTime,
    session: Option<PathBuf>,
    last_event: String,
    pending_screenshots: HashMap<PathBuf, (u64, SystemTime)>,
    activity_seen: HashSet<u64>,
    activity_order: VecDeque<u64>,
}
impl ScannerService {
    pub fn new() -> Self {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        Self {
            snapshot: {
                let mut snapshot =
                    ScannerSnapshot::initial(format!("{}-{}", std::process::id(), time.as_nanos()));
                snapshot.config = sources::discover_folders();
                snapshot
            },
            seen: HashSet::new(),
            tails: HashMap::new(),
            boundary: Local::now().naive_local(),
            session: None,
            last_event: String::new(),
            pending_screenshots: HashMap::new(),
            activity_seen: HashSet::new(),
            activity_order: VecDeque::new(),
        }
    }
    pub fn snapshot(&self) -> ScannerSnapshot {
        self.snapshot.clone()
    }
    pub fn check_folders(&mut self, config: FolderConfig) -> ScannerSnapshot {
        if self.snapshot.config != config {
            self.stop();
            self.snapshot.raid = ScannerSnapshot::initial(String::new()).raid;
            self.snapshot.latest_position = None;
            self.snapshot.activity.clear();
            self.snapshot.log_coverage.clear();
            self.snapshot.activity_dropped = 0;
            self.activity_seen.clear();
            self.activity_order.clear();
        }
        self.snapshot.screenshots = sources::probe_directory(&config.screenshots);
        self.snapshot.logs = sources::probe_directory(&config.logs);
        self.snapshot.config = config;
        self.snapshot.revision += 1;
        self.snapshot()
    }
    fn diagnostic(&mut self, message: String) {
        if self.snapshot.diagnostics.last() != Some(&message) {
            self.snapshot.diagnostics.push(message);
            if self.snapshot.diagnostics.len() > 30 {
                self.snapshot.diagnostics.remove(0);
            }
        }
    }
    pub fn start(&mut self, config: FolderConfig) -> ScannerSnapshot {
        if self.snapshot.monitoring == MonitoringStatus::Running && self.snapshot.config == config {
            return self.snapshot();
        }
        self.check_folders(config);
        self.boundary = Local::now().naive_local();
        self.seen = files(Path::new(&self.snapshot.config.screenshots))
            .into_iter()
            .collect();
        self.tails.clear();
        self.snapshot.activity.clear();
        self.snapshot.log_coverage.clear();
        self.snapshot.activity_dropped = 0;
        self.activity_seen.clear();
        self.activity_order.clear();
        self.session = None;
        self.pending_screenshots.clear();
        self.snapshot.monitoring = MonitoringStatus::Running;
        self.snapshot.latest_position = None;
        self.poll_logs(true);
        self.snapshot.recovered_positions = self.recover_raid_positions();
        self.snapshot.latest_position = self.snapshot.recovered_positions.last().cloned();
        if !self.snapshot.recovered_positions.is_empty() {
            let count = self.snapshot.recovered_positions.len();
            self.diagnostic(format!("Recovered {count} existing screenshot(s) captured since the active raid started."));
        }
        self.diagnostic("Monitoring started. Other existing screenshots excluded; minute-resolution captures from the start minute are uncertain and rejected.".into());
        self.snapshot.revision += 1;
        self.snapshot()
    }
    fn raid_start(&self) -> Option<NaiveDateTime> {
        self.snapshot
            .raid
            .started_at
            .as_ref()
            .and_then(|v| NaiveDateTime::parse_from_str(v, "%Y-%m-%d %H:%M:%S%.f").ok())
    }

    /// Baselined screenshots captured during the active raid, oldest first, at most `MAX_RECOVERED`.
    /// Same rule as live captures: the capture minute must not precede the raid start.
    fn recover_raid_positions(&self) -> Vec<PositionObservation> {
        const MAX_RECOVERED: usize = 200;
        if self.snapshot.raid.lifecycle != "active" {
            return Vec::new();
        }
        let Some(started) = self.raid_start() else {
            return Vec::new();
        };
        let now = Local::now().naive_local();
        let observed_at = Local::now().to_rfc3339();
        let mut found: Vec<(NaiveDateTime, String, parsers::ParsedPosition)> = self
            .seen
            .iter()
            .filter_map(|path| {
                let name = path.file_name()?.to_string_lossy().into_owned();
                let position = parsers::position_filename(&name).ok()?;
                (position.captured >= started && position.captured <= now)
                    .then(|| (position.captured, name, position))
            })
            .collect();
        found.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
        let skip = found.len().saturating_sub(MAX_RECOVERED);
        found
            .into_iter()
            .skip(skip)
            .map(|(_, name, position)| PositionObservation {
                xyz: position.xyz,
                raw_quaternion: position.quaternion,
                heading_degrees: position.heading_degrees,
                heading_convention: parsers::HEADING_CONVENTION.into(),
                observed_at: observed_at.clone(),
                captured_at: Some(position.captured.to_string()),
                raid_id: self.snapshot.raid.id.clone(),
                filename: name,
            })
            .collect()
    }
    pub fn stop(&mut self) -> ScannerSnapshot {
        self.snapshot.monitoring = MonitoringStatus::Stopped;
        self.snapshot.raid.detail =
            "Monitoring stopped; displayed raid state is frozen at its last observation.".into();
        self.snapshot.revision += 1;
        self.snapshot()
    }
    pub fn poll(&mut self) -> bool {
        if self.snapshot.monitoring != MonitoringStatus::Running {
            return false;
        }
        let before = self.snapshot.clone();
        self.snapshot.logs = sources::probe_directory(&self.snapshot.config.logs);
        self.snapshot.screenshots = sources::probe_directory(&self.snapshot.config.screenshots);
        self.poll_logs(false);
        let candidates = if self.snapshot.screenshots.status == model::SourceStatus::Available {
            files(Path::new(&self.snapshot.config.screenshots))
        } else {
            Vec::new()
        };
        let mut candidates = candidates;
        candidates.retain(|p| !self.seen.contains(p));
        candidates.sort_by_key(|p| {
            (
                parsers::position_filename(&p.file_name().unwrap_or_default().to_string_lossy())
                    .ok()
                    .map(|v| v.captured),
                fs::metadata(p)
                    .and_then(|m| m.modified())
                    .unwrap_or(UNIX_EPOCH),
                p.file_name().unwrap_or_default().to_os_string(),
            )
        });
        for path in candidates {
            if self.seen.contains(&path) {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            let stamp = (meta.len(), meta.modified().unwrap_or(UNIX_EPOCH));
            if self.pending_screenshots.insert(path.clone(), stamp) != Some(stamp) {
                continue;
            }
            self.pending_screenshots.remove(&path);
            self.seen.insert(path.clone());
            self.snapshot.screenshots_seen += 1;
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let result = parsers::position_filename(&name);
            match result {
                Ok(position)
                    if position.captured >= self.boundary
                        && position.captured <= Local::now().naive_local() =>
                {
                    let within_raid = self
                        .raid_start()
                        .map(|v| position.captured >= v)
                        .unwrap_or(false);
                    let raid_id = if within_raid && self.snapshot.raid.lifecycle == "active" {
                        self.snapshot.raid.id.clone()
                    } else {
                        None
                    };
                    let previous = self
                        .snapshot
                        .latest_position
                        .as_ref()
                        .and_then(|p| p.captured_at.as_ref())
                        .and_then(|v| NaiveDateTime::parse_from_str(v, "%Y-%m-%d %H:%M:%S").ok());
                    if previous.is_some_and(|p| p > position.captured) {
                        self.diagnostic(format!("Ignored older capture {name}."));
                        continue;
                    }
                    self.snapshot.latest_position = Some(PositionObservation {
                        xyz: position.xyz,
                        raw_quaternion: position.quaternion,
                        heading_degrees: position.heading_degrees,
                        heading_convention: parsers::HEADING_CONVENTION.into(),
                        observed_at: Local::now().to_rfc3339(),
                        captured_at: Some(position.captured.to_string()),
                        raid_id,
                        filename: name,
                    });
                }
                Ok(_) => {
                    self.snapshot.screenshots_rejected += 1;
                    self.diagnostic(format!(
                        "Rejected {name}: capture predates monitoring, is uncertain within its start minute, or is in the future."
                    ));
                }
                Err(reason) => {
                    self.snapshot.screenshots_rejected += 1;
                    self.diagnostic(format!("Ignored {name}: {reason}"));
                }
            }
        }
        if before != self.snapshot {
            self.snapshot.revision += 1;
            true
        } else {
            false
        }
    }
    fn poll_logs(&mut self, startup: bool) {
        if self.snapshot.logs.status != model::SourceStatus::Available {
            if self.snapshot.raid.lifecycle != "unknown" {
                self.snapshot.raid = ScannerSnapshot::initial(String::new()).raid;
                self.snapshot.latest_position = None;
                self.tails.clear();
                self.session = None;
                self.last_event.clear();
                self.diagnostic(
                    "Log source unavailable; previous raid association cleared.".into(),
                );
            }
            return;
        }
        let root = PathBuf::from(&self.snapshot.config.logs);
        let mut dirs: Vec<_> = fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort_by_key(|p| session_key(p));
        let session = dirs.pop().unwrap_or(root);
        if self.session.as_ref() != Some(&session) {
            self.session = Some(session.clone());
            self.tails.clear();
            self.snapshot.raid = ScannerSnapshot::initial(String::new()).raid;
            self.snapshot.latest_position = None;
            self.last_event.clear();
        }
        let mut paths = files(&session);
        paths.sort();
        let mut records = Vec::new();
        // A fixed upper bound on file count and per-file read size bounds each poll.
        for path in paths
            .into_iter()
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("log")))
            .take(32)
        {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            let source = activity::source_class(&name);
            let lifecycle_source = matches!(source, "application" | "output" | "backend");
            let Ok(mut file) = fs::File::open(&path) else {
                self.diagnostic("Unable to read a session log.".into());
                continue;
            };
            let Ok(metadata) = file.metadata() else {
                continue;
            };
            let len = metadata.len();
            let created = metadata.created().ok();
            let modified = metadata.modified().ok();
            let mut prefix = Vec::new();
            if file.by_ref().take(128).read_to_end(&mut prefix).is_err() {
                continue;
            }
            let tail = self.tails.entry(path.clone()).or_insert_with(|| Tail {
                offset: len.saturating_sub(1024 * 1024),
                pending: String::new(),
                created,
                modified,
                prefix: prefix.clone(),
                notification: None,
            });
            if len < tail.offset
                || created != tail.created
                || !prefix.starts_with(&tail.prefix)
                || (len == tail.offset && modified != tail.modified)
            {
                tail.offset = 0;
                tail.pending.clear();
                tail.notification = None;
                if lifecycle_source {
                    self.snapshot.latest_position = None;
                    self.snapshot.raid = ScannerSnapshot::initial(String::new()).raid;
                    self.last_event.clear();
                }
                self.snapshot
                    .diagnostics
                    .push("Log truncated or replaced; prior raid context invalidated.".into());
                if self.snapshot.diagnostics.len() > 30 {
                    self.snapshot.diagnostics.remove(0);
                }
            }
            tail.created = created;
            tail.modified = modified;
            tail.prefix = prefix;
            let offset = tail.offset;
            if file.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            let mut bytes = Vec::new();
            if file
                .by_ref()
                .take(1024 * 1024)
                .read_to_end(&mut bytes)
                .is_err()
            {
                continue;
            }
            tail.offset += bytes.len() as u64;
            let text = String::from_utf8_lossy(&bytes);
            tail.pending.push_str(&text);
            if tail.pending.len() > 1024 * 1024 {
                tail.pending.clear();
                continue;
            }
            let Some(last) = tail.pending.rfind('\n') else {
                continue;
            };
            let complete = tail.pending[..=last].to_owned();
            tail.pending = tail.pending[last + 1..].to_owned();
            let activity_records = activity::assemble(&complete, &mut tail.notification);
            for record in activity_records {
                self.observe_activity(&record, source, startup);
            }
            for line in complete.lines() {
                if let Some(record) = parsers::log_record(line) {
                    records.push(record);
                } else if line.contains("|application|")
                    && (line.contains("GameStarted")
                        || line.contains("Session mode")
                        || line.contains("NetworkGameCreate")
                        || line.contains("scene preset"))
                {
                    self.diagnostic(
                        "Unrecognized application lifecycle record; raid state was not inferred."
                            .into(),
                    );
                }
            }
        }
        records.sort_by(|a, b| a.0.cmp(&b.0));
        for (timestamp, event) in records {
            let recovered = startup
                || NaiveDateTime::parse_from_str(&timestamp, "%Y-%m-%d %H:%M:%S%.f")
                    .map(|v| v < self.boundary)
                    .unwrap_or(true);
            self.reduce(timestamp, event, recovered);
        }
    }
    fn observe_activity(&mut self, line: &str, source: &str, startup: bool) {
        let Some(record) = activity::record(line) else {
            return;
        };
        use std::hash::{Hash, Hasher};
        let recovered = startup
            || NaiveDateTime::parse_from_str(record.timestamp, "%Y-%m-%d %H:%M:%S%.f")
                .map(|v| v < self.boundary)
                .unwrap_or(true);
        let mut event = activity::event(line, source, String::new(), recovered);
        if let Some(event) = event.as_mut() {
            if let Some(time) = event
                .event_at
                .as_ref()
                .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            {
                event.recovered =
                    startup || time.with_timezone(&Local).naive_local() < self.boundary;
            }
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        // Semantic fingerprint deliberately ignores filename: a replay/rotation copy
        // must not duplicate either feed entries or coverage counts.
        if let Some(event) = event
            .as_ref()
            .filter(|e| e.evidence == "quest_notification")
        {
            event.kind.hash(&mut hasher);
            event.action.hash(&mut hasher);
            event.entity_id.hash(&mut hasher);
            event.event_at.hash(&mut hasher);
        } else {
            self.session.hash(&mut hasher);
            source.hash(&mut hasher);
            line.hash(&mut hasher);
        }
        let fingerprint = hasher.finish();
        if !self.activity_seen.insert(fingerprint) {
            return;
        }
        self.activity_order.push_back(fingerprint);
        if self.activity_order.len() > 20_000 {
            if let Some(old) = self.activity_order.pop_front() {
                self.activity_seen.remove(&old);
            }
        }
        if let Some(event) = event.as_mut() {
            event.id = format!("event:{fingerprint:016x}");
        }
        let category = activity::safe_category(record.category);
        if let Some(counter) = self
            .snapshot
            .log_coverage
            .iter_mut()
            .find(|c| c.source == source && c.category == category && c.level == record.level)
        {
            counter.records = counter.records.saturating_add(1);
            counter.unclassified = counter
                .unclassified
                .saturating_add(u32::from(event.is_none()));
            if record.timestamp > counter.last_record_at.as_str() {
                counter.last_record_at = record.timestamp.into();
            }
        } else {
            self.snapshot.log_coverage.push(LogCoverage {
                source: source.into(),
                category: category.into(),
                level: record.level.into(),
                records: 1,
                unclassified: u32::from(event.is_none()),
                last_record_at: record.timestamp.into(),
            });
        }
        if let Some(event) = event {
            self.snapshot.activity.push(event);
            self.snapshot.activity.sort_by(|a, b| {
                activity::sort_time(b)
                    .cmp(&activity::sort_time(a))
                    .then_with(|| a.id.cmp(&b.id))
            });
            if self.snapshot.activity.len() > 200 {
                self.snapshot.activity.pop();
                self.snapshot.activity_dropped = self.snapshot.activity_dropped.saturating_add(1);
            }
        }
    }
    fn reduce(&mut self, timestamp: String, event: LogEvent, recovered: bool) {
        if timestamp < self.last_event {
            return;
        }
        self.last_event = timestamp.clone();
        match event {
            LogEvent::Mode(mode) => {
                if self.snapshot.raid.game_mode.as_ref() != Some(&mode) {
                    self.snapshot.raid = ScannerSnapshot::initial(String::new()).raid;
                    self.snapshot.latest_position = None;
                }
                self.snapshot.raid.game_mode = Some(mode);
            }
            LogEvent::Scene(scene) => {
                self.snapshot.raid.recovered = recovered;
                self.snapshot.raid.detail = if recovered {
                    "Recovered scene-loading record; current loading progress unconfirmed."
                } else {
                    "Observed live scene-loading record."
                }
                .into();
                self.snapshot.raid.lifecycle = "loading".into();
                self.snapshot.raid.started_at = None;
                self.snapshot.raid.id = None;
                self.snapshot.raid.raw_game_mode = None;
                self.snapshot.raid.raw_raid_mode = None;
                self.snapshot.raid.map = Some(scene);
                self.snapshot.latest_position = None;
            }
            LogEvent::Loading {
                map,
                id: _,
                mode,
                raid_mode,
            } => {
                self.snapshot.raid.recovered = recovered;
                self.snapshot.raid.detail = if recovered {
                    "Recovered network game creation; current loading progress unconfirmed."
                } else {
                    "Observed live network game creation."
                }
                .into();
                self.snapshot.raid.map = Some(map);
                self.snapshot.raid.id = None;
                self.snapshot.raid.raw_game_mode = Some(mode);
                self.snapshot.raid.raw_raid_mode = Some(raid_mode);
                self.snapshot.raid.lifecycle = "loading".into();
                self.snapshot.raid.started_at = None;
                self.snapshot.latest_position = None;
            }
            LogEvent::Started => {
                if self.snapshot.raid.started_at.as_ref() == Some(&timestamp) {
                    return;
                }
                if self.snapshot.raid.lifecycle != "loading" {
                    self.snapshot.raid.map = None;
                    self.snapshot.raid.raw_raid_mode = None;
                    self.snapshot.raid.raw_game_mode = None;
                }
                self.snapshot.raid.id = Some(format!(
                    "local:{}:{timestamp}",
                    self.session
                        .as_ref()
                        .and_then(|p| p.file_name())
                        .unwrap_or_default()
                        .to_string_lossy()
                ));
                self.snapshot.raid.lifecycle = "active".into();
                self.snapshot.raid.started_at = Some(timestamp);
                self.snapshot.raid.recovered = recovered;
                self.snapshot.raid.detail = if recovered {
                    "Recovered current-session start; continued activity is unconfirmed."
                } else {
                    "Observed live GameStarted record."
                }
                .into();
                self.snapshot.latest_position = None;
            }
            LogEvent::Ended => {
                self.snapshot.raid.recovered = recovered;
                self.snapshot.raid.lifecycle = "ended".into();
                self.snapshot.raid.detail = if recovered {
                    "Recovered client Stop game disconnect; extraction outcome unknown."
                } else {
                    "Observed client Stop game disconnect; extraction outcome unknown."
                }
                .into();
                self.snapshot.latest_position = None;
            }
            LogEvent::LocalEndReported => {
                self.snapshot.raid.recovered = recovered;
                self.snapshot.raid.lifecycle = "ended".into();
                self.snapshot.raid.detail = if recovered {
                    "Recovered client report of local raid end; outcome and backend acknowledgment unknown."
                } else {
                    "Client reported local raid end; outcome and backend acknowledgment unknown."
                }
                .into();
                self.snapshot.latest_position = None;
            }
        }
    }
}
pub(crate) fn files(path: &Path) -> Vec<PathBuf> {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_multiline_notifications_wait_for_complete_json_and_redelivery_deduplicates() {
        let (dir, mut service) = setup_logs(include_str!(
            "../../../fixtures/logs/pve-customs-started.log"
        ));
        let push = include_str!("../../../fixtures/activity/push-notifications.log");
        let path = dir.path().join("log_2026.10.11_8-55-46_1.2.0.0.47965/2026.10.11_8-55-46_1.2.0.0.47965 push-notifications_000.log");
        let split = push.find("successMessageText").unwrap();
        fs::write(&path, &push[..split]).unwrap();
        service.poll();
        assert_eq!(
            service
                .snapshot
                .activity
                .iter()
                .filter(|e| e.kind == "quest")
                .count(),
            2
        );
        use std::io::Write;
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(push[split..].as_bytes())
            .unwrap();
        service.poll();
        let quests: Vec<_> = service
            .snapshot
            .activity
            .iter()
            .filter(|e| e.kind == "quest")
            .collect();
        assert_eq!(quests.len(), 4);
        assert!(quests.iter().all(|e| e.recovered && e.event_at.is_some()));
        let ids: HashSet<_> = quests.iter().map(|e| e.id.clone()).collect();
        let redelivery = push
            .replace("11:30:17.900", "12:30:17.900")
            .replace("11:30:40.465", "12:30:40.465")
            .replace("11:31:03.561", "12:31:03.561");
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(redelivery.as_bytes())
            .unwrap();
        service.poll();
        assert_eq!(
            service
                .snapshot
                .activity
                .iter()
                .filter(|e| e.kind == "quest")
                .map(|e| e.id.clone())
                .collect::<HashSet<_>>(),
            ids
        );
        assert_eq!(
            service
                .snapshot
                .activity
                .iter()
                .filter(|e| e.kind == "quest")
                .count(),
            4
        );
    }
    #[test]
    fn activity_quest_requests_are_independent_partial_deduplicated_and_private() {
        let quest = include_str!("../../../fixtures/activity/quest-actions.log");
        let started = "2026-10-11 11:30:50.338|1.2.0.0.47965|Info|application|GameStarted:60.69(0) real:76.19(0) diff:15.5\n";
        let (dir, mut service) = setup_logs(started);
        let backend = dir
            .path()
            .join("log_2026.10.11_8-55-46_1.2.0.0.47965/backend_000.log");
        let request = quest.lines().next().unwrap();
        fs::write(&backend, request).unwrap();
        service.poll();
        assert_eq!(service.snapshot.activity.len(), 1);
        use std::io::Write;
        fs::OpenOptions::new()
            .append(true)
            .open(&backend)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        service.poll();
        assert_eq!(service.snapshot.raid.lifecycle, "active");
        let event = service
            .snapshot
            .activity
            .iter()
            .find(|e| e.kind == "quest")
            .unwrap();
        assert_eq!(event.action, "fail_requested");
        assert_eq!(event.evidence, "requested");
        assert!(event.entity_id.is_none());
        assert!(event.recovered);
        let event_id = event.id.clone();
        fs::write(&backend, quest).unwrap();
        service.poll();
        assert_eq!(service.snapshot.activity.len(), 2);
        assert_eq!(
            service
                .snapshot
                .activity
                .iter()
                .filter(|e| e.kind == "quest")
                .count(),
            1
        );
        let sensitive = "2026-10-11 11:31:50.000|1.2.0.0.47965|Error|private-account-token|https://secret.invalid/token?session=SECRET /Users/private/profile\n";
        fs::write(
            dir.path()
                .join("log_2026.10.11_8-55-46_1.2.0.0.47965/errors_000.log"),
            sensitive,
        )
        .unwrap();
        service.poll();
        let safe =
            serde_json::to_string(&(&service.snapshot.activity, &service.snapshot.log_coverage))
                .unwrap();
        for forbidden in [
            "SECRET",
            "secret.invalid",
            "private-account-token",
            "example.invalid",
            "responseText",
            "AcceptQuest",
        ] {
            assert!(!safe.contains(forbidden));
        }
        let config = service.snapshot.config.clone();
        service.stop();
        service.start(config);
        assert_eq!(
            service
                .snapshot
                .activity
                .iter()
                .filter(|e| e.kind == "quest")
                .count(),
            1
        );
        assert_eq!(
            service
                .snapshot
                .activity
                .iter()
                .find(|e| e.kind == "quest")
                .unwrap()
                .id,
            event_id
        );
    }
    #[test]
    fn activity_caps_feed_and_ancillary_rotation_preserves_raid() {
        let (_dir, mut service) = setup_logs(include_str!(
            "../../../fixtures/logs/pve-customs-started.log"
        ));
        let initial = service.snapshot.activity.len();
        for i in 0..250 {
            service.observe_activity(&format!("2026-10-11 12:00:{:02}.{:03}|1.2.0.0.47965|Info|backend|---> Request HTTPS, id [{i}]: URL: https://example.invalid/client/quest/fail. ", i / 1000, i % 1000), "backend", false);
        }
        assert_eq!(service.snapshot.activity.len(), 200);
        assert_eq!(service.snapshot.activity_dropped as usize, initial + 50);
        assert!(service
            .snapshot
            .activity
            .windows(2)
            .all(|e| e[0].logged_at >= e[1].logged_at));
        let auxiliary = service.session.as_ref().unwrap().join("ai_000.log");
        fs::write(
            &auxiliary,
            "2026-10-11 12:01:00.000|1.2.0.0.47965|Debug|ai|private data\n",
        )
        .unwrap();
        service.poll();
        fs::write(&auxiliary, "").unwrap();
        service.poll();
        assert_eq!(service.snapshot.raid.lifecycle, "active");
    }
    #[test]
    fn export_frontend_contract() {
        use ts_rs::TS;
        ScannerSnapshot::export_all_to(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings"))
            .unwrap();
        import::ImportEvent::export_all_to(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings"))
            .unwrap();
    }
    #[test]
    fn baseline_and_stopped_poll() {
        let dir = tempfile::tempdir().unwrap();
        let name = "2026-10-11[11-06]_176.89, 4.38, 164.86_-0.00534, 0.99448, -0.06416, -0.08281_9.79 (0).png";
        fs::write(dir.path().join(name), "").unwrap();
        let mut service = ScannerService::new();
        service.start(FolderConfig {
            screenshots: dir.path().to_string_lossy().into(),
            logs: String::new(),
        });
        service.poll();
        assert_eq!(service.snapshot.screenshots_seen, 0);
        service.stop();
        assert!(!service.poll());
        let position = parsers::position_filename(name).unwrap();
        assert_eq!(position.xyz, [176.89, 4.38, 164.86]);
        assert!(parsers::position_filename("unknown.png").is_err());
    }
    fn setup_logs(fixture: &str) -> (tempfile::TempDir, ScannerService) {
        let dir = tempfile::tempdir().unwrap();
        let session = dir.path().join("log_2026.10.11_8-55-46_1.2.0.0.47965");
        fs::create_dir(&session).unwrap();
        fs::write(session.join("application_000.log"), fixture).unwrap();
        let mut service = ScannerService::new();
        service.start(FolderConfig {
            screenshots: dir.path().to_string_lossy().into(),
            logs: dir.path().to_string_lossy().into(),
        });
        (dir, service)
    }
    #[test]
    fn current_fixture_recovers_explicit_mode_without_role_and_new_empty_session_wins() {
        let fixture = include_str!("../../../fixtures/logs/pve-customs-started.log");
        let (dir, mut service) = setup_logs(fixture);
        assert_eq!(service.snapshot.raid.lifecycle, "active");
        assert_eq!(service.snapshot.raid.map.as_deref(), Some("customs_preset"));
        assert_eq!(service.snapshot.raid.game_mode.as_deref(), Some("Pve"));
        assert!(service.snapshot.raid.player_role.is_none());
        assert!(service.snapshot.raid.recovered);
        assert!(service
            .snapshot
            .raid
            .id
            .as_ref()
            .unwrap()
            .starts_with("local:"));
        let newer = dir.path().join("log_2026.10.11_11-03-07_1.2.0.0.47965");
        fs::create_dir(&newer).unwrap();
        fs::write(newer.join("application_000.log"), "").unwrap();
        service.poll();
        assert_eq!(service.snapshot.raid.lifecycle, "unknown");
    }
    #[test]
    fn ended_fixture_and_late_older_end_do_not_invent_extraction_or_pvp() {
        let fixture = include_str!("../../../fixtures/logs/online-interchange-ended.log");
        let (_dir, mut service) = setup_logs(fixture);
        assert_eq!(service.snapshot.raid.lifecycle, "ended");
        assert!(service.snapshot.raid.game_mode.is_none());
        assert_eq!(
            service.snapshot.raid.raw_game_mode.as_deref(),
            Some("deathmatch")
        );
        service.reduce("2026-10-11 11:05:50.338".into(), LogEvent::Started, false);
        assert!(service.snapshot.raid.map.is_none());
        service.reduce("2026-10-11 09:29:55.917".into(), LogEvent::Ended, false);
        assert_eq!(service.snapshot.raid.lifecycle, "active");
        service.reduce(
            "2026-10-11 11:06:00.000".into(),
            LogEvent::Mode("Pve".into()),
            false,
        );
        assert!(service.snapshot.raid.id.is_none());
        assert_eq!(service.snapshot.raid.lifecycle, "unknown");
    }
    #[test]
    fn local_end_fixture_recovers_latest_raid_and_live_partial_backend_append_ends_it() {
        let fixture = include_str!("../../../fixtures/logs/pve-local-ends.log");
        let (_dir, service) = setup_logs(fixture);
        assert_eq!(service.snapshot.raid.lifecycle, "ended");
        assert!(service.snapshot.raid.recovered);
        assert!(service
            .snapshot
            .raid
            .detail
            .contains("acknowledgment unknown"));
        assert_eq!(
            service.snapshot.raid.started_at.as_deref(),
            Some("2026-10-11 11:18:43.310")
        );

        let request_start = fixture.rfind("2026-10-11 11:25:05.320").unwrap();
        let (before_end, end) = fixture.split_at(request_start);
        let (dir, mut service) = setup_logs(before_end);
        assert_eq!(service.snapshot.raid.lifecycle, "active");
        let raid = service.snapshot.raid.clone();
        service.boundary =
            NaiveDateTime::parse_from_str("2026-10-11 11:18:00", "%Y-%m-%d %H:%M:%S").unwrap();
        service.snapshot.latest_position = Some(PositionObservation {
            xyz: [1., 2., 3.],
            raw_quaternion: [0., 0., 0., 1.],
            heading_degrees: None,
            observed_at: "test observation".into(),
            captured_at: None,
            raid_id: raid.id.clone(),
            filename: "test.png".into(),
            heading_convention: "test".into(),
        });
        let backend = dir
            .path()
            .join("log_2026.10.11_8-55-46_1.2.0.0.47965/backend_000.log");
        let split = end.find('\n').unwrap();
        fs::write(&backend, &end[..split]).unwrap();
        service.poll();
        assert_eq!(service.snapshot.raid.lifecycle, "active");
        assert!(service.snapshot.latest_position.is_some());
        use std::io::Write;
        fs::OpenOptions::new()
            .append(true)
            .open(&backend)
            .unwrap()
            .write_all(end[split..].as_bytes())
            .unwrap();
        service.poll();
        assert_eq!(service.snapshot.raid.lifecycle, "ended");
        assert!(!service.snapshot.raid.recovered);
        assert_eq!(service.snapshot.raid.id, raid.id);
        assert_eq!(service.snapshot.raid.map, raid.map);
        assert_eq!(service.snapshot.raid.started_at, raid.started_at);
        assert!(service.snapshot.latest_position.is_none());
        assert!(service
            .snapshot
            .raid
            .detail
            .contains("outcome and backend acknowledgment unknown"));
        service.reduce("2026-10-11 11:30:00.000".into(), LogEvent::Started, false);
        service.reduce(
            "2026-10-11 11:25:05.320".into(),
            LogEvent::LocalEndReported,
            false,
        );
        assert_eq!(service.snapshot.raid.lifecycle, "active");
    }
    #[test]
    fn partial_record_waits_for_newline_and_truncation_invalidates_context() {
        let (dir, mut service) =
            setup_logs("2026-10-11 11:05:50.338|1.2.0.0.47965|Info|application|GameStarted:60.69(0) real:76.19(0) diff:15.5");
        assert_eq!(service.snapshot.raid.lifecycle, "unknown");
        let file = dir
            .path()
            .join("log_2026.10.11_8-55-46_1.2.0.0.47965/application_000.log");
        use std::io::Write;
        fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        service.poll();
        assert_eq!(service.snapshot.raid.lifecycle, "active");
        fs::write(&file, "").unwrap();
        service.poll();
        assert_eq!(service.snapshot.raid.lifecycle, "unknown");
        let record = "2026-10-11 11:05:50.338|1.2.0.0.47965|Info|application|GameStarted:60.69(0) real:76.19(0) diff:15.5\n";
        fs::write(&file, record).unwrap();
        service.poll();
        assert_eq!(service.snapshot.raid.lifecycle, "active");
        fs::write(&file, vec![b'x'; record.len()]).unwrap();
        service.poll();
        assert_eq!(service.snapshot.raid.lifecycle, "unknown");
    }
    #[test]
    fn start_in_active_raid_recovers_existing_screenshots_since_raid_start() {
        let fixture = include_str!("../../../fixtures/logs/pve-customs-started.log");
        let dir = tempfile::tempdir().unwrap();
        let session = dir.path().join("log_2026.10.11_8-55-46_1.2.0.0.47965");
        fs::create_dir(&session).unwrap();
        fs::write(session.join("application_000.log"), fixture).unwrap();
        let shots = dir.path().join("shots");
        fs::create_dir(&shots).unwrap();
        let name = |time: &str| format!("2026-10-11[{time}]_1.00, 2.00, 3.00_0.00000, 0.00000, 0.00000, 1.00000_9.79 (0).png");
        for time in ["09-50", "11-05", "11-07", "11-06"] {
            fs::write(shots.join(name(time)), b"").unwrap();
        }
        fs::write(shots.join("not a capture.png"), b"").unwrap();
        let mut service = ScannerService::new();
        let snapshot = service.start(FolderConfig {
            screenshots: shots.to_string_lossy().into(),
            logs: dir.path().to_string_lossy().into(),
        });
        assert_eq!(snapshot.raid.lifecycle, "active");
        let recovered: Vec<_> = snapshot.recovered_positions.iter().map(|p| p.filename.clone()).collect();
        // The raid started at 11:05:50; the 11-05 capture is within the uncertain start minute.
        assert_eq!(recovered, vec![name("11-06"), name("11-07")]);
        assert!(snapshot.recovered_positions.iter().all(|p| p.raid_id == snapshot.raid.id));
        assert_eq!(snapshot.latest_position.unwrap().filename, name("11-07"));
        // Recovered files stay baselined: polling does not count them as new.
        service.poll();
        assert_eq!(service.snapshot.screenshots_seen, 0);
    }
    #[test]
    fn new_position_requires_stable_stat_and_strict_capture_boundary_but_not_raid() {
        let dir = tempfile::tempdir().unwrap();
        let mut service = ScannerService::new();
        service.start(FolderConfig {
            screenshots: dir.path().to_string_lossy().into(),
            logs: String::new(),
        });
        service.boundary =
            NaiveDateTime::parse_from_str("2026-10-11 11:05:30", "%Y-%m-%d %H:%M:%S").unwrap();
        let name = "2026-10-11[11-06]_176.89, 4.38, 164.86_-0.00534, 0.99448, -0.06416, -0.08281_9.79 (0).png";
        fs::write(dir.path().join(name), b"metadata only").unwrap();
        service.poll();
        assert!(service.snapshot.latest_position.is_none());
        service.poll();
        assert!(service.snapshot.latest_position.is_some());
        assert!(service
            .snapshot
            .latest_position
            .as_ref()
            .unwrap()
            .raid_id
            .is_none());
        service.poll();
        assert_eq!(service.snapshot.screenshots_seen, 1);
        service.reduce("2026-10-11 11:07:00.000".into(), LogEvent::Started, false);
        assert!(service.snapshot.latest_position.is_none());
        let old = name.replace("[11-06]", "[11-05]");
        fs::write(dir.path().join(old), b"copied late").unwrap();
        service.poll();
        service.poll();
        assert_eq!(service.snapshot.screenshots_rejected, 1);
        let future = name.replace("2026-10-11", "2999-10-11");
        fs::write(dir.path().join(future), b"future capture").unwrap();
        service.poll();
        service.poll();
        assert_eq!(service.snapshot.screenshots_rejected, 2);
        assert!(service.snapshot.latest_position.is_none());
    }
    #[test]
    #[ignore = "Opt-in local smoke; set MAPPINATOR_LOGS and MAPPINATOR_SCREENSHOTS"]
    fn live_read_only_smoke() {
        let logs = std::env::var("MAPPINATOR_LOGS").unwrap();
        let screenshots = std::env::var("MAPPINATOR_SCREENSHOTS").unwrap();
        let mut service = ScannerService::new();
        let snapshot = service.start(FolderConfig { logs, screenshots });
        println!(
            "lifecycle={} map={:?} mode={:?} recovered={} position_present={}",
            snapshot.raid.lifecycle,
            snapshot.raid.map,
            snapshot.raid.game_mode,
            snapshot.raid.recovered,
            snapshot.latest_position.is_some()
        );
        assert_eq!(snapshot.monitoring, MonitoringStatus::Running);
    }
    #[test]
    #[ignore = "Opt-in metadata-only activity smoke; set MAPPINATOR_LOGS and MAPPINATOR_SCREENSHOTS"]
    fn live_activity_smoke() {
        let mut service = ScannerService::new();
        let snapshot = service.start(FolderConfig {
            logs: std::env::var("MAPPINATOR_LOGS").unwrap(),
            screenshots: std::env::var("MAPPINATOR_SCREENSHOTS").unwrap(),
        });
        println!(
            "activity={} dropped={} source_buckets={}",
            snapshot.activity.len(),
            snapshot.activity_dropped,
            snapshot.log_coverage.len()
        );
        for event in snapshot.activity.iter().filter(|e| e.kind == "quest") {
            println!(
                "quest action={} catalog_id={:?} evidence={} recovered={} event_at={:?}",
                event.action, event.entity_id, event.evidence, event.recovered, event.event_at
            );
        }
        assert!(snapshot
            .log_coverage
            .iter()
            .any(|c| c.source == "push-notifications"));
        assert!(snapshot
            .activity
            .iter()
            .any(|e| e.evidence == "quest_notification" && e.entity_id.is_some()));
    }
}

pub(crate) fn session_key(path: &Path) -> (Option<NaiveDateTime>, SystemTime) {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let parts: Vec<_> = name.split('_').collect();
    let date = if parts.len() >= 3 && parts[0] == "log" {
        NaiveDateTime::parse_from_str(&format!("{} {}", parts[1], parts[2]), "%Y.%m.%d %H-%M-%S")
            .ok()
    } else {
        None
    };
    (
        date,
        fs::metadata(path)
            .and_then(|m| m.modified())
            .unwrap_or(UNIX_EPOCH),
    )
}
