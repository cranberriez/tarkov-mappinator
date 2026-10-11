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
pub struct ScannerSnapshot {
    pub instance_id: String,
    pub revision: u32,
    pub config: FolderConfig,
    pub monitoring: MonitoringStatus,
    pub screenshots: SourceHealth,
    pub logs: SourceHealth,
    pub raid: RaidState,
    pub latest_position: Option<PositionObservation>,
    pub diagnostics: Vec<String>,
    pub screenshots_seen: u32,
    pub screenshots_rejected: u32,
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
            diagnostics: Vec::new(),
            screenshots_seen: 0,
            screenshots_rejected: 0,
        }
    }
}
