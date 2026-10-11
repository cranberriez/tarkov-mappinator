use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, TS)]
pub struct FolderConfig {
    pub screenshots: String,
    pub logs: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum SourceStatus {
    NotConfigured,
    Available,
    Missing,
    NotDirectory,
    Unreadable,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct SourceHealth {
    pub status: SourceStatus,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum MonitoringStatus {
    Stopped,
    Running,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct RaidState {
    pub id: Option<String>,
    pub lifecycle: String,
    /// Raw game map identifier, whichever the logs gave last: the scene bundle
    /// (`customs_preset`, while loading) or the location id (`bigmap`, once matched).
    /// Both are tarkov.dev fields (`scenePath`, `nameId`); resolve with `resolveGame` in `src/maps`.
    pub map: Option<String>,
    pub game_mode: Option<String>,
    pub player_role: Option<String>,
    pub detail: String,
    pub recovered: bool,
    pub started_at: Option<String>,
    pub raw_raid_mode: Option<String>,
    pub raw_game_mode: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct PositionObservation {
    pub xyz: [f64; 3],
    pub raw_quaternion: [f64; 4],
    pub heading_degrees: Option<f64>,
    pub observed_at: String,
    pub captured_at: Option<String>,
    pub raid_id: Option<String>,
    pub filename: String,
    pub heading_convention: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct ActivityEvent {
    pub id: String,
    pub logged_at: String,
    pub event_at: Option<String>,
    pub kind: String,
    pub action: String,
    pub entity_id: Option<String>,
    pub source: String,
    pub evidence: String,
    pub recovered: bool,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct LogCoverage {
    pub source: String,
    pub category: String,
    pub level: String,
    pub records: u32,
    pub unclassified: u32,
    pub last_record_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct ScannerSnapshot {
    pub instance_id: String,
    pub revision: u32,
    pub config: FolderConfig,
    pub monitoring: MonitoringStatus,
    pub screenshots: SourceHealth,
    pub logs: SourceHealth,
    pub raid: RaidState,
    pub latest_position: Option<PositionObservation>,
    /// Screenshots that already existed when monitoring started but were captured after the
    /// start of the raid the logs show as active, oldest first. Set only when monitoring starts.
    pub recovered_positions: Vec<PositionObservation>,
    pub diagnostics: Vec<String>,
    pub screenshots_seen: u32,
    pub screenshots_rejected: u32,
    pub activity: Vec<ActivityEvent>,
    pub activity_dropped: u32,
    pub log_coverage: Vec<LogCoverage>,
}

impl ScannerSnapshot {
    pub fn initial(instance_id: String) -> Self {
        let unconfigured = SourceHealth {
            status: SourceStatus::NotConfigured,
            detail: "Choose a folder, then check access.".into(),
        };
        Self {
            instance_id,
            revision: 0,
            config: FolderConfig::default(),
            monitoring: MonitoringStatus::Stopped,
            screenshots: unconfigured.clone(),
            logs: unconfigured,
            raid: RaidState {
                id: None,
                lifecycle: "unknown".into(),
                map: None,
                game_mode: None,
                player_role: None,
                detail: "Waiting for live application-log evidence.".into(),
                recovered: false,
                started_at: None,
                raw_raid_mode: None,
                raw_game_mode: None,
            },
            latest_position: None,
            recovered_positions: Vec::new(),
            diagnostics: Vec::new(),
            screenshots_seen: 0,
            screenshots_rejected: 0,
            activity: Vec::new(),
            activity_dropped: 0,
            log_coverage: Vec::new(),
        }
    }
}
