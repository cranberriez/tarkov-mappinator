mod model;
mod parsers;
mod sources;

use chrono::{Local, NaiveDateTime};
pub use model::{FolderConfig, ScannerSnapshot};
use model::{MonitoringStatus, PositionObservation};
use parsers::LogEvent;
use std::{
    collections::{HashMap, HashSet},
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
}
pub struct ScannerService {
    snapshot: ScannerSnapshot,
    seen: HashSet<PathBuf>,
    tails: HashMap<PathBuf, Tail>,
    boundary: NaiveDateTime,
    session: Option<PathBuf>,
    last_event: String,
    pending_screenshots: HashMap<PathBuf, (u64, SystemTime)>,
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
        self.session = None;
        self.pending_screenshots.clear();
        self.snapshot.monitoring = MonitoringStatus::Running;
        self.snapshot.latest_position = None;
        self.poll_logs(true);
        self.diagnostic("Monitoring started. Existing screenshots excluded; minute-resolution captures from the start minute are uncertain and rejected.".into());
        self.snapshot.revision += 1;
        self.snapshot()
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
                        .snapshot
                        .raid
                        .started_at
                        .as_ref()
                        .and_then(|v| NaiveDateTime::parse_from_str(v, "%Y-%m-%d %H:%M:%S%.f").ok())
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
        for path in paths {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if !name.contains("application") && !name.contains("output") {
                continue;
            }
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
            });
            if len < tail.offset
                || created != tail.created
                || !prefix.starts_with(&tail.prefix)
                || (len == tail.offset && modified != tail.modified)
            {
                tail.offset = 0;
                tail.pending.clear();
                self.snapshot.latest_position = None;
                self.snapshot.raid = ScannerSnapshot::initial(String::new()).raid;
                self.last_event.clear();
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
                self.snapshot.raid.map = Some(match scene.as_str() {
                    "customs_preset" => "Customs".into(),
                    "shopping_mall" => "Interchange".into(),
                    _ => scene,
                });
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
        }
    }
}
fn files(path: &Path) -> Vec<PathBuf> {
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
    fn export_frontend_contract() {
        use ts_rs::TS;
        ScannerSnapshot::export_all_to(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings"))
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
        assert_eq!(service.snapshot.raid.map.as_deref(), Some("Customs"));
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
}

fn session_key(path: &Path) -> (Option<NaiveDateTime>, SystemTime) {
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
