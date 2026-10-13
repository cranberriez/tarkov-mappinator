//! Persistent history in SQLite: raids, screenshot positions and activity from monitoring and
//! imports, plus a ledger of imported files so later imports skip what has not changed.
//! Also decides which game files are safe to clean up: only ones whose data is stored here.

use crate::scanner::{
    self,
    import::{FileStamp, ImportFileKind, ImportResult, Known},
    ActivityEvent, HistoryBatch, PositionObservation, RaidRecord,
};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use ts_rs::TS;

const SCHEMA_VERSION: i32 = 2;
const SCHEMA: &str = "
CREATE TABLE raids (
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    map TEXT,
    game_mode TEXT,
    raw_game_mode TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
);
CREATE INDEX raids_started ON raids (started_at);
CREATE TABLE positions (
    filename TEXT PRIMARY KEY,
    raid_id TEXT,
    x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
    qx REAL NOT NULL, qy REAL NOT NULL, qz REAL NOT NULL, qw REAL NOT NULL,
    heading REAL,
    heading_convention TEXT NOT NULL,
    captured_at TEXT,
    observed_at TEXT NOT NULL
);
CREATE INDEX positions_raid ON positions (raid_id);
CREATE TABLE activity (
    id TEXT PRIMARY KEY,
    logged_at TEXT NOT NULL,
    event_at TEXT,
    kind TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_id TEXT,
    source TEXT NOT NULL,
    evidence TEXT NOT NULL,
    summary TEXT NOT NULL,
    game_mode TEXT
);
CREATE INDEX activity_logged ON activity (logged_at);
CREATE TABLE imported_files (
    path TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified INTEGER NOT NULL,
    imported_at TEXT NOT NULL
);
";

/// Raids newest first; positions in capture order.
#[derive(Clone, Debug, Default, Serialize, TS)]
pub struct HistoryData {
    pub raids: Vec<RaidRecord>,
    pub positions: Vec<PositionObservation>,
}

#[derive(Clone, Debug, Serialize, TS)]
pub struct HistoryStats {
    /// Database size on disk.
    #[ts(type = "number")]
    pub bytes: u64,
    pub raids: u32,
    pub positions: u32,
    pub activity: u32,
    pub imported_logs: u32,
    pub imported_screenshots: u32,
    /// RFC 3339; none before the first import.
    pub last_import_at: Option<String>,
    /// Start of the newest stored raid, as logged.
    pub latest_raid_at: Option<String>,
    /// Set when the database could not be opened and history is kept in memory only.
    pub error: Option<String>,
}

/// Game files whose data is already stored, so they can go to the Recycle Bin.
#[derive(Clone, Debug, Default, Serialize, TS)]
pub struct CleanupPlan {
    pub screenshots: u32,
    #[ts(type = "number")]
    pub screenshot_bytes: u64,
    pub log_sessions: u32,
    #[ts(type = "number")]
    pub log_bytes: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CleanupKind {
    Screenshots,
    Logs,
}

/// A raid as the frontend used to keep it in localStorage.
#[derive(Debug, Deserialize)]
pub struct LegacyRaid {
    id: String,
    map: Option<String>,
    game_mode: Option<String>,
    started_at: String,
    ended_at: Option<String>,
}

pub struct History {
    path: PathBuf,
    db: Mutex<Connection>,
    error: Option<String>,
}

fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let db = Connection::open(path)?;
    migrate(&db)?;
    Ok(db)
}

fn migrate(db: &Connection) -> rusqlite::Result<()> {
    db.pragma_update(None, "foreign_keys", false)?;
    let version: i32 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        // A newer build wrote this file; refusing beats silently misreading it.
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "history was written by a newer version (schema {version})"
        )));
    }
    if version < 1 {
        db.execute_batch(SCHEMA)?;
    } else if version < 2 {
        // Activity gains the session mode in effect when logged; re-reading logs fills it in.
        db.execute_batch(
            "ALTER TABLE activity ADD COLUMN game_mode TEXT; DELETE FROM imported_files WHERE kind = 'log';",
        )?;
    }
    if version < SCHEMA_VERSION {
        db.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

fn raid_row(row: &Row) -> rusqlite::Result<RaidRecord> {
    Ok(RaidRecord {
        id: row.get(0)?,
        session: row.get(1)?,
        map: row.get(2)?,
        game_mode: row.get(3)?,
        raw_game_mode: row.get(4)?,
        started_at: row.get(5)?,
        ended_at: row.get(6)?,
    })
}
const RAID_COLUMNS: &str = "id, session, map, game_mode, raw_game_mode, started_at, ended_at";

fn position_row(row: &Row) -> rusqlite::Result<PositionObservation> {
    Ok(PositionObservation {
        filename: row.get(0)?,
        raid_id: row.get(1)?,
        xyz: [row.get(2)?, row.get(3)?, row.get(4)?],
        raw_quaternion: [row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?],
        heading_degrees: row.get(9)?,
        heading_convention: row.get(10)?,
        captured_at: row.get(11)?,
        observed_at: row.get(12)?,
    })
}
const POSITION_COLUMNS: &str =
    "filename, raid_id, x, y, z, qx, qy, qz, qw, heading, heading_convention, captured_at, observed_at";

/// Existing values win and gaps are filled: a raid's first observed end is kept.
fn put_raid(db: &Connection, raid: &RaidRecord) -> rusqlite::Result<()> {
    // A legacy start-time placeholder gives way to the real raid that started then.
    db.execute(
        "DELETE FROM raids WHERE id LIKE 'log:%' AND started_at = ?1 AND id <> ?2",
        params![raid.started_at, raid.id],
    )?;
    db.execute(
        "INSERT INTO raids (id, session, map, game_mode, raw_game_mode, started_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (id) DO UPDATE SET
           map = COALESCE(raids.map, excluded.map),
           game_mode = COALESCE(raids.game_mode, excluded.game_mode),
           raw_game_mode = COALESCE(raids.raw_game_mode, excluded.raw_game_mode),
           ended_at = COALESCE(raids.ended_at, excluded.ended_at)",
        params![raid.id, raid.session, raid.map, raid.game_mode, raid.raw_game_mode, raid.started_at, raid.ended_at],
    )?;
    Ok(())
}

/// A capture keeps its first record; a raid association fills in later if it was missing.
fn put_position(db: &Connection, position: &PositionObservation) -> rusqlite::Result<()> {
    let [x, y, z] = position.xyz;
    let [qx, qy, qz, qw] = position.raw_quaternion;
    db.execute(
        "INSERT INTO positions (filename, raid_id, x, y, z, qx, qy, qz, qw, heading, heading_convention, captured_at, observed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (filename) DO UPDATE SET raid_id = COALESCE(positions.raid_id, excluded.raid_id)",
        params![
            position.filename, position.raid_id, x, y, z, qx, qy, qz, qw, position.heading_degrees,
            position.heading_convention, position.captured_at, position.observed_at
        ],
    )?;
    Ok(())
}

fn put_activity(db: &Connection, event: &ActivityEvent) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO activity (id, logged_at, event_at, kind, action, entity_id, source, evidence, summary, game_mode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (id) DO UPDATE SET game_mode = COALESCE(activity.game_mode, excluded.game_mode)",
        params![
            event.id, event.logged_at, event.event_at, event.kind, event.action, event.entity_id, event.source,
            event.evidence, event.summary, event.game_mode
        ],
    )?;
    Ok(())
}

fn count(db: &Connection, sql: &str) -> u32 {
    db.query_row(sql, [], |row| row.get(0)).unwrap_or(0)
}

fn text(error: rusqlite::Error) -> String {
    format!("History storage failed: {error}")
}

impl History {
    /// Opens or creates the database. A file that cannot be opened is left untouched and
    /// history is kept in memory for this run, reported through `stats().error`.
    pub fn open(path: PathBuf) -> Self {
        match open(&path) {
            Ok(db) => Self { path, db: Mutex::new(db), error: None },
            Err(error) => {
                let db = Connection::open_in_memory().expect("in-memory SQLite");
                migrate(&db).expect("schema on an empty database");
                Self { path, db: Mutex::new(db), error: Some(format!("{error}; history is not being saved.")) }
            }
        }
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Stores what monitoring observed; returns the affected rows as stored.
    pub fn record(&self, batch: &HistoryBatch) -> Result<HistoryData, String> {
        let mut db = self.db();
        let tx = db.transaction().map_err(text)?;
        for raid in &batch.raids {
            put_raid(&tx, raid).map_err(text)?;
        }
        for position in &batch.positions {
            put_position(&tx, position).map_err(text)?;
        }
        for event in &batch.activity {
            put_activity(&tx, event).map_err(text)?;
        }
        tx.commit().map_err(text)?;

        let mut delta = HistoryData::default();
        let ids: HashSet<_> = batch.raids.iter().map(|raid| raid.id.as_str()).collect();
        let mut query = db.prepare(&format!("SELECT {RAID_COLUMNS} FROM raids WHERE id = ?1")).map_err(text)?;
        for id in ids {
            delta.raids.extend(query.query_row([id], raid_row).ok());
        }
        let mut query = db
            .prepare(&format!("SELECT {POSITION_COLUMNS} FROM positions WHERE filename = ?1"))
            .map_err(text)?;
        for position in &batch.positions {
            delta.positions.extend(query.query_row([&position.filename], position_row).ok());
        }
        Ok(delta)
    }

    /// Stores a committed import and marks its files as imported.
    pub fn import(&self, result: &ImportResult, files: &[FileStamp]) -> Result<(), String> {
        let mut db = self.db();
        let tx = db.transaction().map_err(text)?;
        for raid in &result.raids {
            put_raid(&tx, raid).map_err(text)?;
        }
        for position in &result.positions {
            put_position(&tx, position).map_err(text)?;
        }
        for event in &result.activity {
            put_activity(&tx, event).map_err(text)?;
        }
        let now = chrono::Utc::now().to_rfc3339();
        for file in files {
            tx.execute(
                "INSERT INTO imported_files (path, kind, size, modified, imported_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (path) DO UPDATE SET kind = excluded.kind, size = excluded.size,
                   modified = excluded.modified, imported_at = excluded.imported_at",
                params![file.path, file.kind.as_str(), file.size as i64, file.modified, now],
            )
            .map_err(text)?;
        }
        tx.commit().map_err(text)
    }

    /// History the frontend localStorage kept before this store existed. Idempotent.
    pub fn migrate_legacy(&self, raids: &[LegacyRaid], positions: &[PositionObservation]) -> Result<(), String> {
        let batch = HistoryBatch {
            raids: raids
                .iter()
                .map(|raid| RaidRecord {
                    id: raid.id.clone(),
                    // `local:<session>:<start>`; placeholders (`log:<start>`) have none.
                    session: raid.id.strip_prefix("local:").and_then(|rest| rest.split_once(':')).map_or("", |(s, _)| s).into(),
                    map: raid.map.clone(),
                    game_mode: raid.game_mode.clone(),
                    raw_game_mode: None,
                    started_at: raid.started_at.clone(),
                    ended_at: raid.ended_at.clone(),
                })
                .collect(),
            positions: positions.to_vec(),
            activity: Vec::new(),
        };
        self.record(&batch).map(|_| ())
    }

    pub fn load(&self) -> Result<HistoryData, String> {
        let db = self.db();
        let raids = db
            .prepare(&format!("SELECT {RAID_COLUMNS} FROM raids ORDER BY started_at DESC"))
            .and_then(|mut query| query.query_map([], raid_row)?.collect())
            .map_err(text)?;
        let positions = db
            .prepare(&format!("SELECT {POSITION_COLUMNS} FROM positions ORDER BY captured_at, observed_at"))
            .and_then(|mut query| query.query_map([], position_row)?.collect())
            .map_err(text)?;
        Ok(HistoryData { raids, positions })
    }

    /// The import ledger and stored raids; `files` is left empty to re-read everything.
    pub fn known(&self, include_files: bool) -> Result<Known, String> {
        let db = self.db();
        let files = if include_files {
            db.prepare("SELECT path, size, modified FROM imported_files")
                .and_then(|mut query| {
                    query
                        .query_map([], |row| Ok((row.get::<_, String>(0)?, (row.get::<_, i64>(1)? as u64, row.get(2)?))))?
                        .collect()
                })
                .map_err(text)?
        } else {
            Default::default()
        };
        let raids = db
            .prepare(&format!("SELECT {RAID_COLUMNS} FROM raids ORDER BY started_at"))
            .and_then(|mut query| query.query_map([], raid_row)?.collect())
            .map_err(text)?;
        Ok(Known { files, raids })
    }

    pub fn stats(&self) -> HistoryStats {
        let db = self.db();
        let bytes = ["", "-journal", "-wal"]
            .iter()
            .filter_map(|suffix| {
                let mut path = self.path.clone().into_os_string();
                path.push(suffix);
                fs::metadata(path).ok().map(|meta| meta.len())
            })
            .sum();
        let latest = |sql: &str| db.query_row(sql, [], |row| row.get::<_, Option<String>>(0)).ok().flatten();
        HistoryStats {
            bytes: if self.error.is_some() { 0 } else { bytes },
            raids: count(&db, "SELECT COUNT(*) FROM raids"),
            positions: count(&db, "SELECT COUNT(*) FROM positions"),
            activity: count(&db, "SELECT COUNT(*) FROM activity"),
            imported_logs: count(&db, "SELECT COUNT(*) FROM imported_files WHERE kind = 'log'"),
            imported_screenshots: count(&db, "SELECT COUNT(*) FROM imported_files WHERE kind = 'screenshot'"),
            last_import_at: latest("SELECT MAX(imported_at) FROM imported_files"),
            latest_raid_at: latest("SELECT MAX(started_at) FROM raids"),
            error: self.error.clone(),
        }
    }

    /// Deletes every stored row, the import ledger included, and shrinks the file.
    pub fn clear(&self) -> Result<(), String> {
        self.db()
            .execute_batch(
                "DELETE FROM raids; DELETE FROM positions; DELETE FROM activity; DELETE FROM imported_files; VACUUM;",
            )
            .map_err(text)
    }

    /// Position screenshots whose position is stored or that an import already read.
    fn screenshot_candidates(&self, folder: &str) -> Vec<(PathBuf, u64)> {
        if folder.is_empty() {
            return Vec::new();
        }
        let db = self.db();
        let column = |sql: &str| -> HashSet<String> {
            db.prepare(sql)
                .and_then(|mut query| query.query_map([], |row| row.get(0))?.collect())
                .unwrap_or_default()
        };
        let stored = column("SELECT filename FROM positions");
        let imported = column("SELECT path FROM imported_files WHERE kind = 'screenshot'");
        drop(db);
        scanner::files(Path::new(folder))
            .into_iter()
            .filter(|path| path.extension().is_some_and(|e| e.eq_ignore_ascii_case("png")))
            .filter(|path| {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                scanner::is_position_capture(&name)
                    && (stored.contains(name.as_ref()) || imported.contains(path.to_string_lossy().as_ref()))
            })
            .filter_map(|path| fs::metadata(&path).ok().map(|meta| (path, meta.len())))
            .collect()
    }

    /// Log session folders, never the newest one (the game may still be writing it), whose
    /// every file was imported and is unchanged since.
    fn log_candidates(&self, root: &str) -> Vec<(PathBuf, u64)> {
        if root.is_empty() {
            return Vec::new();
        }
        let Ok(known) = self.known(true) else {
            return Vec::new();
        };
        let mut sessions: Vec<_> = fs::read_dir(root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        sessions.sort_by_key(|path| scanner::session_key(path));
        sessions.pop();
        sessions
            .into_iter()
            .filter_map(|session| {
                let entries: Vec<_> = fs::read_dir(&session).ok()?.flatten().map(|entry| entry.path()).collect();
                let mut bytes = 0;
                for path in &entries {
                    let stamp = FileStamp::of(path, ImportFileKind::Log)?;
                    let imported = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("log"))
                        && known.files.get(&stamp.path) == Some(&(stamp.size, stamp.modified));
                    if !imported {
                        return None;
                    }
                    bytes += stamp.size;
                }
                (!entries.is_empty()).then_some((session, bytes))
            })
            .collect()
    }

    pub fn cleanup_plan(&self, config: &scanner::FolderConfig) -> CleanupPlan {
        let shots = self.screenshot_candidates(&config.screenshots);
        let logs = self.log_candidates(&config.logs);
        CleanupPlan {
            screenshots: shots.len() as u32,
            screenshot_bytes: shots.iter().map(|(_, bytes)| bytes).sum(),
            log_sessions: logs.len() as u32,
            log_bytes: logs.iter().map(|(_, bytes)| bytes).sum(),
        }
    }

    /// Permanently deletes the screenshots whose positions are stored for `raid_id`; returns how
    /// many were deleted. Files already gone are skipped.
    pub fn delete_raid_screenshots(&self, folder: &str, raid_id: &str) -> Result<u32, String> {
        if folder.is_empty() {
            return Ok(0);
        }
        let names: Vec<String> = {
            let db = self.db();
            let mut query = db.prepare("SELECT filename FROM positions WHERE raid_id = ?1").map_err(text)?;
            let rows = query.query_map([raid_id], |row| row.get(0)).map_err(text)?;
            rows.collect::<rusqlite::Result<_>>().map_err(text)?
        };
        let (mut deleted, mut failed) = (0, None);
        for name in names {
            // Bare capture names only, so a stored name can never reach outside the folder.
            if Path::new(&name).file_name() != Some(name.as_ref()) || !scanner::is_position_capture(&name) {
                continue;
            }
            match fs::remove_file(Path::new(folder).join(&name)) {
                Ok(()) => deleted += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => failed = failed.or(Some(format!("Unable to delete screenshot {name}: {error}"))),
            }
        }
        failed.map_or(Ok(deleted), Err)
    }

    /// Moves the current candidates of `kind` to the Recycle Bin; returns how many were moved.
    pub fn cleanup(&self, config: &scanner::FolderConfig, kind: CleanupKind) -> Result<u32, String> {
        let candidates = match kind {
            CleanupKind::Screenshots => self.screenshot_candidates(&config.screenshots),
            CleanupKind::Logs => self.log_candidates(&config.logs),
        };
        if candidates.is_empty() {
            return Ok(0);
        }
        trash::delete_all(candidates.iter().map(|(path, _)| path))
            .map_err(|error| format!("Unable to move files to the Recycle Bin: {error}"))?;
        Ok(candidates.len() as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::FolderConfig;

    fn raid(id: &str, start: &str, end: Option<&str>) -> RaidRecord {
        RaidRecord {
            id: id.into(),
            session: "s".into(),
            map: None,
            game_mode: None,
            raw_game_mode: None,
            started_at: start.into(),
            ended_at: end.map(Into::into),
        }
    }

    fn position(filename: &str, raid_id: Option<&str>) -> PositionObservation {
        PositionObservation {
            xyz: [1.0, 2.0, 3.0],
            raw_quaternion: [0.0, 0.0, 0.0, 1.0],
            heading_degrees: Some(90.0),
            observed_at: "2026-10-11T11:06:00+00:00".into(),
            captured_at: Some("2026-10-11 11:06:00".into()),
            raid_id: raid_id.map(Into::into),
            filename: filename.into(),
            heading_convention: "test".into(),
        }
    }

    fn activity(id: &str, mode: Option<&str>) -> ActivityEvent {
        ActivityEvent {
            id: id.into(),
            logged_at: "2026-10-11 12:00:00.000".into(),
            event_at: None,
            kind: "quest".into(),
            action: "accepted".into(),
            entity_id: None,
            source: "push-notifications".into(),
            evidence: "quest_notification".into(),
            recovered: true,
            summary: String::new(),
            game_mode: mode.map(Into::into),
        }
    }

    fn stored_mode(history: &History, id: &str) -> Option<String> {
        history.db().query_row("SELECT game_mode FROM activity WHERE id = ?1", [id], |row| row.get(0)).unwrap()
    }

    #[test]
    fn version_one_database_gains_the_mode_column_and_rereads_logs() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE activity (id TEXT PRIMARY KEY, logged_at TEXT NOT NULL, event_at TEXT, kind TEXT NOT NULL,
                action TEXT NOT NULL, entity_id TEXT, source TEXT NOT NULL, evidence TEXT NOT NULL, summary TEXT NOT NULL);
             CREATE TABLE imported_files (path TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER NOT NULL,
                modified INTEGER NOT NULL, imported_at TEXT NOT NULL);
             INSERT INTO imported_files VALUES ('a.log', 'log', 1, 1, 't'), ('b.png', 'screenshot', 1, 1, 't');
             PRAGMA user_version = 1;",
        )
        .unwrap();
        migrate(&db).unwrap();
        db.prepare("SELECT game_mode FROM activity").unwrap();
        let paths: Vec<String> = db
            .prepare("SELECT path FROM imported_files")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(paths, ["b.png"]);
        let version: i32 = db.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn reputting_activity_fills_a_missing_mode_but_never_overwrites_one() {
        let dir = tempfile::tempdir().unwrap();
        let history = History::open(dir.path().join("history.sqlite3"));
        let record = |event| history.record(&HistoryBatch { raids: vec![], positions: vec![], activity: vec![event] }).unwrap();
        record(activity("a", None));
        assert_eq!(stored_mode(&history, "a"), None);
        record(activity("a", Some("Pve")));
        assert_eq!(stored_mode(&history, "a").as_deref(), Some("Pve"));
        record(activity("a", Some("Regular")));
        assert_eq!(stored_mode(&history, "a").as_deref(), Some("Pve"));
    }

    #[test]
    fn upserts_fill_gaps_and_keep_first_values() {
        let dir = tempfile::tempdir().unwrap();
        let history = History::open(dir.path().join("history.sqlite3"));
        let started = raid("local:s:2026-10-11 11:00:00.000", "2026-10-11 11:00:00.000", None);
        history.record(&HistoryBatch { raids: vec![started.clone()], positions: vec![position("a.png", None)], activity: vec![] }).unwrap();
        let ended = RaidRecord { map: Some("bigmap".into()), ended_at: Some("2026-10-11 11:30:00.000".into()), ..started.clone() };
        let later = RaidRecord { ended_at: Some("2026-10-11 11:45:00.000".into()), ..started.clone() };
        let delta = history
            .record(&HistoryBatch { raids: vec![ended, later], positions: vec![position("a.png", Some(&started.id))], activity: vec![] })
            .unwrap();
        assert_eq!(delta.raids.len(), 1);
        assert_eq!(delta.raids[0].map.as_deref(), Some("bigmap"));
        assert_eq!(delta.raids[0].ended_at.as_deref(), Some("2026-10-11 11:30:00.000"));
        assert_eq!(delta.positions[0].raid_id.as_deref(), Some(started.id.as_str()));

        // Survives reopening; a legacy placeholder at the same start gives way.
        drop(history);
        let history = History::open(dir.path().join("history.sqlite3"));
        history
            .migrate_legacy(
                &[LegacyRaid { id: "log:2026-10-11 12:00:00.000".into(), map: None, game_mode: None, started_at: "2026-10-11 12:00:00.000".into(), ended_at: None }],
                &[position("a.png", None)],
            )
            .unwrap();
        assert_eq!(history.load().unwrap().raids.len(), 2);
        history.record(&HistoryBatch { raids: vec![raid("local:s:2026-10-11 12:00:00.000", "2026-10-11 12:00:00.000", None)], ..Default::default() }).unwrap();
        let data = history.load().unwrap();
        assert_eq!(data.raids.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["local:s:2026-10-11 12:00:00.000", "local:s:2026-10-11 11:00:00.000"]);
        assert_eq!(data.positions.len(), 1);
        assert_eq!(history.stats().raids, 2);

        history.clear().unwrap();
        let stats = history.stats();
        assert_eq!((stats.raids, stats.positions, stats.activity), (0, 0, 0));
    }

    #[test]
    fn newer_schema_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.sqlite3");
        Connection::open(&path).unwrap().pragma_update(None, "user_version", 99).unwrap();
        let history = History::open(path.clone());
        assert!(history.stats().error.is_some());
        history.record(&HistoryBatch { raids: vec![raid("x", "2026-10-11 11:00:00.000", None)], ..Default::default() }).unwrap();
        let version: i32 = Connection::open(&path).unwrap().query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 99);
    }

    #[test]
    fn deletes_only_the_ended_raids_stored_screenshots() {
        let dir = tempfile::tempdir().unwrap();
        let shots = dir.path().join("shots");
        fs::create_dir(&shots).unwrap();
        let name = |minute: u32| {
            format!("2026-10-11[11-{minute:02}]_176.89, 4.38, 164.86_-0.00534, 0.99448, -0.06416, -0.08281_9.79 (0).png")
        };
        let (ours, other, loose, unstored) = (name(1), name(2), name(3), name(4));
        for file in [&ours, &other, &loose, &unstored] {
            fs::write(shots.join(file), b"png").unwrap();
        }
        let history = History::open(dir.path().join("history.sqlite3"));
        let positions = vec![position(&ours, Some("r1")), position(&other, Some("r2")), position(&loose, None)];
        history.record(&HistoryBatch { raids: vec![], positions, activity: vec![] }).unwrap();

        let folder = shots.to_string_lossy();
        assert_eq!(history.delete_raid_screenshots(&folder, "r1"), Ok(1));
        assert!(!shots.join(&ours).exists());
        assert!([&other, &loose, &unstored].iter().all(|file| shots.join(file).exists()));
        // Already gone is not an error.
        assert_eq!(history.delete_raid_screenshots(&folder, "r1"), Ok(0));
    }

    #[test]
    fn cleanup_offers_only_stored_screenshots_and_old_imported_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let history = History::open(dir.path().join("history.sqlite3"));
        let shots = dir.path().join("shots");
        fs::create_dir(&shots).unwrap();
        let stored = "2026-10-11[11-06]_176.89, 4.38, 164.86_-0.00534, 0.99448, -0.06416, -0.08281_9.79 (0).png";
        let unknown = "2026-10-11[11-07]_176.89, 4.38, 164.86_-0.00534, 0.99448, -0.06416, -0.08281_9.79 (0).png";
        for name in [stored, unknown, "holiday.png"] {
            fs::write(shots.join(name), b"png").unwrap();
        }
        history.record(&HistoryBatch { positions: vec![position(stored, None)], ..Default::default() }).unwrap();

        let logs = dir.path().join("logs");
        let old = logs.join("log_2026.10.10_10-00-00_1.0");
        let newest = logs.join("log_2026.10.11_10-00-00_1.0");
        let partial = logs.join("log_2026.10.09_10-00-00_1.0");
        for session in [&old, &newest, &partial] {
            fs::create_dir_all(session).unwrap();
            fs::write(session.join("application_000.log"), b"line\n").unwrap();
        }
        fs::write(partial.join("backend_000.log"), b"line\n").unwrap();
        let stamps: Vec<_> = [&old, &newest, &partial]
            .iter()
            .map(|session| FileStamp::of(&session.join("application_000.log"), ImportFileKind::Log).unwrap())
            .collect();
        let empty = ImportResult { raids: vec![], positions: vec![], activity: vec![], unmatched_screenshots: 0, already_imported: 0, cancelled: false };
        history.import(&empty, &stamps).unwrap();

        let config = FolderConfig { screenshots: shots.to_string_lossy().into(), logs: logs.to_string_lossy().into() };
        let plan = history.cleanup_plan(&config);
        assert_eq!((plan.screenshots, plan.screenshot_bytes), (1, 3));
        assert_eq!((plan.log_sessions, plan.log_bytes), (1, 5));
        assert_eq!(history.log_candidates(&config.logs)[0].0, old);

        // A file that changed after import is no longer safe to remove.
        fs::write(old.join("application_000.log"), b"line\nmore\n").unwrap();
        assert_eq!(history.cleanup_plan(&config).log_sessions, 0);
    }

    #[test]
    fn export_frontend_contract() {
        let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings");
        HistoryData::export_all_to(out).unwrap();
        HistoryStats::export_all_to(out).unwrap();
        CleanupPlan::export_all_to(out).unwrap();
        CleanupKind::export_all_to(out).unwrap();
    }
}
