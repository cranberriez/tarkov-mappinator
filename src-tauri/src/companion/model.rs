//! Companion types: the UI status model (Tauri events) and the `/v1` wire contract the site reads.
use serde::Serialize;
use ts_rs::TS;

/// Connection state shown in the app. `Stale` and `Connected` need a paired site that has polled since
/// the server started; revoked or never-polling clients leave it `Waiting`.
#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum ConnectionState {
    Off,
    Waiting,
    Connected,
    Stale,
    Error { reason: String },
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct PairedClient {
    pub id: String,
    pub origin: String,
    pub paired_at: String,
    /// Last authenticated request, from any run.
    pub last_seen: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct PendingPairing {
    pub id: String,
    pub origin: String,
    pub requested_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct CompanionStatus {
    pub connection: ConnectionState,
    /// Bound port while running.
    pub port: Option<u16>,
    /// Last authenticated request since the server started.
    pub last_poll: Option<String>,
    /// A paired site counts as stale after this long without polling.
    pub stale_after_secs: u32,
    pub clients: Vec<PairedClient>,
    pub pending: Vec<PendingPairing>,
}

/// Raid phase from the scanner's lifecycle; `unknown` is not sent.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum RaidPhase {
    Loading,
    InRaid,
    Ended,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum QuestAction {
    Accepted,
    Completed,
    Failed,
}

/// Raw game map ID from the logs (`bigmap`, or the scene bundle `customs_preset` while loading),
/// with tarkov.dev's `normalizedName` when the local map data resolves it.
#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct MapRef {
    pub raw: String,
    pub normalized_name: Option<String>,
}

/// tarkov.dev data set for the session mode: `pve`, `regular` or `pvp-season`; null when unknown.
pub type GameMode = Option<String>;

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventBody {
    Quest {
        action: QuestAction,
        quest_id: String,
    },
    /// The session mode is the event's `mode`.
    Raid {
        phase: RaidPhase,
        map: Option<MapRef>,
    },
    Position(Position),
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct Position {
    pub map: Option<MapRef>,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Degrees; provisional compass alignment (see README).
    pub yaw: Option<f64>,
    pub captured_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct CompanionEvent {
    /// Monotonic within an `epoch`.
    #[ts(type = "number")]
    pub seq: u64,
    /// Stable across replays (the scanner's dedupe key), for idempotent apply.
    pub id: String,
    pub at: String,
    /// Read from history when monitoring started rather than observed live.
    pub recovered: bool,
    /// Session mode when the app observed the event.
    #[ts(type = "string | null")]
    pub mode: GameMode,
    #[serde(flatten)]
    pub body: EventBody,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct CurrentRaid {
    pub phase: RaidPhase,
    pub map: Option<MapRef>,
    #[ts(type = "string | null")]
    pub mode: GameMode,
    pub recovered: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct CurrentState {
    pub scanner_running: bool,
    pub raid: Option<CurrentRaid>,
    pub position: Option<Position>,
}

/// `GET /v1/sync?since=<seq>`.
#[derive(Clone, Debug, Serialize, TS)]
pub struct SyncResponse {
    pub protocol: u32,
    /// Changes when the app restarts: discard the cursor and sync from 0.
    pub epoch: String,
    #[ts(type = "number")]
    pub seq: u64,
    /// Oldest retained seq; events before it were dropped.
    #[ts(type = "number")]
    pub oldest: u64,
    pub state: CurrentState,
    pub events: Vec<CompanionEvent>,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    NotConfigured,
    Available,
    Unavailable,
}

/// `GET /v1/status`. Without a token only `app`, `version`, `protocol` and `paired: false` are set.
#[derive(Clone, Debug, Serialize, TS)]
pub struct StatusResponse {
    pub app: String,
    pub version: String,
    pub protocol: u32,
    pub paired: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scanner_running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub logs: Option<SourceState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub screenshots: Option<SourceState>,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum PairingState {
    Pending,
    /// The token is returned once; later polls report `expired`.
    Allowed {
        token: String,
    },
    Denied,
    Expired,
}

/// `POST /v1/pair`.
#[derive(Clone, Debug, Serialize, TS)]
pub struct PairRequested {
    pub pairing_id: String,
    pub expires_in_secs: u32,
}

/// Every non-2xx response.
#[derive(Clone, Debug, Serialize, TS)]
pub struct ApiError {
    pub error: String,
    pub message: String,
}
