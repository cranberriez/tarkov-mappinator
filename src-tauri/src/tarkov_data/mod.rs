//! Local mirror of tarkov.dev map data, synced in the background and independent of the scanner.
//!
//! Layout under the store directory:
//! - `manifest.json`: sync metadata and the map index
//! - `common.json`: loot container, stationary weapon and goon report lookups
//! - `mobs.json`: boss and follower definitions
//! - `maps/<normalizedName>.json`: one document per map, names translated to English

pub mod split;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use ts_rs::TS;

/// PvE and PvP map data are the same; PvE is the documented source.
pub const SOURCE: &str = "https://json.tarkov.dev/pve";
/// Bump when the stored layout or transform changes, forcing a full refetch.
const FORMAT: u32 = 1;
/// How old a successful check may get before the background loop checks again.
pub const MAX_AGE: Duration = Duration::from_secs(6 * 60 * 60);
const RESPONSE_LIMIT: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct MapEntry {
    pub id: String,
    pub normalized_name: String,
    pub name_id: String,
    pub name: String,
    /// Scene bundle without `maps/` and `.bundle`, as named in game logs.
    pub scene: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct DataManifest {
    pub format: u32,
    pub source: String,
    pub etag: Option<String>,
    /// When the stored data was downloaded.
    pub fetched_at: String,
    /// When the source was last confirmed unchanged or downloaded.
    pub checked_at: String,
    pub maps: Vec<MapEntry>,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    Idle,
    Syncing,
    Failed,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct DataStatus {
    pub state: SyncState,
    /// None until the first successful sync.
    pub manifest: Option<DataManifest>,
    pub error: Option<String>,
    pub last_attempt: Option<String>,
}

pub struct TarkovData {
    root: PathBuf,
    status: Mutex<DataStatus>,
    syncing: AtomicBool,
}

impl TarkovData {
    /// `root` is the store directory; it need not exist yet.
    pub fn open(root: PathBuf) -> Self {
        let manifest = read_manifest(&root).filter(|manifest| manifest.format == FORMAT);
        Self {
            root,
            status: Mutex::new(DataStatus {
                state: SyncState::Idle,
                manifest,
                error: None,
                last_attempt: None,
            }),
            syncing: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> DataStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    fn update(&self, change: impl FnOnce(&mut DataStatus)) -> DataStatus {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        change(&mut status);
        status.clone()
    }

    /// True when there is no data, or the last successful check is older than `MAX_AGE`.
    pub fn is_stale(&self, now: DateTime<Utc>) -> bool {
        let Some(manifest) = self.status().manifest else {
            return true;
        };
        DateTime::parse_from_rfc3339(&manifest.checked_at)
            .map(|checked| {
                (now - checked.with_timezone(&Utc))
                    .to_std()
                    .map_or(false, |age| age >= MAX_AGE)
            })
            .unwrap_or(true)
    }

    /// Checks the source and replaces the store when it changed. `publish` receives each status change.
    /// Returns false without doing anything when a sync is already running.
    pub fn sync(&self, publish: impl Fn(&DataStatus)) -> bool {
        if self.syncing.swap(true, Ordering::SeqCst) {
            return false;
        }
        publish(&self.update(|status| {
            status.state = SyncState::Syncing;
            status.last_attempt = Some(Utc::now().to_rfc3339());
        }));
        let previous = self.status().manifest;
        let result = fetch_and_store(&self.root, previous.as_ref());
        publish(&self.update(|status| match result {
            Ok(manifest) => {
                status.state = SyncState::Idle;
                status.manifest = Some(manifest);
                status.error = None;
            }
            Err(error) => {
                status.state = SyncState::Failed;
                status.error = Some(error);
            }
        }));
        self.syncing.store(false, Ordering::SeqCst);
        true
    }

    /// Raw JSON of one map document, by `normalized_name`.
    pub fn map_json(&self, name: &str) -> Result<String, String> {
        let known = self
            .status()
            .manifest
            .is_some_and(|manifest| manifest.maps.iter().any(|map| map.normalized_name == name));
        if !known {
            return Err(format!("No tarkov.dev data for map \"{name}\"."));
        }
        read_text(&self.root.join("maps").join(format!("{name}.json")))
    }

    pub fn common_json(&self) -> Result<String, String> {
        read_text(&self.root.join("common.json"))
    }

    pub fn mobs_json(&self) -> Result<String, String> {
        read_text(&self.root.join("mobs.json"))
    }
}

fn read_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| format!("Unable to read {}: {error}", path.display()))
}

fn read_manifest(root: &Path) -> Option<DataManifest> {
    serde_json::from_str(&fs::read_to_string(root.join("manifest.json")).ok()?).ok()
}

enum Fetched {
    Unchanged,
    Changed { body: String, etag: Option<String> },
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(120)))
        .user_agent(concat!("tarkov-mappinator/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

fn get(agent: &ureq::Agent, url: &str, etag: Option<&str>) -> Result<Fetched, String> {
    let mut request = agent.get(url);
    if let Some(etag) = etag {
        request = request.header("If-None-Match", etag);
    }
    let mut response = request.call().map_err(|error| format!("{url}: {error}"))?;
    if response.status() == 304 {
        return Ok(Fetched::Unchanged);
    }
    let etag = response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response
        .body_mut()
        .with_config()
        .limit(RESPONSE_LIMIT)
        .read_to_string()
        .map_err(|error| format!("{url}: {error}"))?;
    Ok(Fetched::Changed { body, etag })
}

fn fetch_and_store(root: &Path, previous: Option<&DataManifest>) -> Result<DataManifest, String> {
    let agent = agent();
    let now = Utc::now().to_rfc3339();
    let etag = previous
        .filter(|manifest| manifest.format == FORMAT)
        .and_then(|manifest| manifest.etag.as_deref());
    let (body, etag) = match get(&agent, &format!("{SOURCE}/maps"), etag)? {
        Fetched::Unchanged => {
            let mut manifest = previous
                .cloned()
                .ok_or("Source unchanged but no local data.")?;
            manifest.checked_at = now;
            write_json(&root.join("manifest.json"), &manifest)?;
            return Ok(manifest);
        }
        Fetched::Changed { body, etag } => (body, etag),
    };
    let Fetched::Changed { body: names, .. } = get(&agent, &format!("{SOURCE}/maps_en"), None)?
    else {
        return Err("Translations unexpectedly unchanged.".into());
    };
    let mut response: Value =
        serde_json::from_str(&body).map_err(|error| format!("Invalid maps JSON: {error}"))?;
    let names: Value = serde_json::from_str(&names)
        .map_err(|error| format!("Invalid translations JSON: {error}"))?;
    if let Some(names) = names.get("data").and_then(Value::as_object) {
        split::translate(&mut response, names);
    }
    let split = split::split(response)?;
    let manifest = DataManifest {
        format: FORMAT,
        source: SOURCE.into(),
        etag,
        fetched_at: now.clone(),
        checked_at: now,
        maps: split
            .maps
            .iter()
            .map(|(name, map)| entry(name, map))
            .collect(),
    };
    store(root, &split, &manifest)?;
    Ok(manifest)
}

fn entry(name: &str, map: &Value) -> MapEntry {
    let text = |key: &str| {
        map.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    MapEntry {
        id: text("id"),
        normalized_name: name.into(),
        name_id: text("nameId"),
        name: text("name"),
        scene: text("scenePath")
            .trim_start_matches("maps/")
            .trim_end_matches(".bundle")
            .to_owned(),
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| format!("Unable to write {}: {error}", path.display()))
}

/// Writes a complete store beside `root`, then swaps it in so readers never see a partial store.
fn store(root: &Path, split: &split::Split, manifest: &DataManifest) -> Result<(), String> {
    let sibling = |suffix: &str| {
        let mut name = root.file_name().unwrap_or_default().to_os_string();
        name.push(suffix);
        root.with_file_name(name)
    };
    let (next, old) = (sibling(".next"), sibling(".old"));
    let io = |error: std::io::Error| format!("Unable to update {}: {error}", root.display());
    let _ = fs::remove_dir_all(&next);
    fs::create_dir_all(next.join("maps")).map_err(io)?;
    write_json(&next.join("common.json"), &split.common)?;
    write_json(&next.join("mobs.json"), &split.mobs)?;
    for (name, map) in &split.maps {
        write_json(&next.join("maps").join(format!("{name}.json")), map)?;
    }
    write_json(&next.join("manifest.json"), manifest)?;
    let _ = fs::remove_dir_all(&old);
    if root.exists() {
        fs::rename(root, &old).map_err(io)?;
    }
    if let Err(error) = fs::rename(&next, root) {
        let _ = fs::rename(&old, root);
        return Err(io(error));
    }
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest(checked_at: &str) -> DataManifest {
        DataManifest {
            format: FORMAT,
            source: SOURCE.into(),
            etag: Some("\"e\"".into()),
            fetched_at: checked_at.into(),
            checked_at: checked_at.into(),
            maps: vec![],
        }
    }

    #[test]
    fn store_swaps_in_complete_documents_and_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("tarkov-data");
        let response = json!({ "data": { "maps": { "a": { "id": "a", "name": "Customs", "normalizedName": "customs",
            "nameId": "bigmap", "scenePath": "maps/customs_preset.bundle" } }, "mobs": {} } });
        let split = split::split(response).unwrap();
        let mut stored = manifest("2026-10-11T00:00:00Z");
        stored.maps = split
            .maps
            .iter()
            .map(|(name, map)| entry(name, map))
            .collect();
        assert_eq!(stored.maps[0].scene, "customs_preset");
        store(&root, &split, &stored).unwrap();
        // A second store replaces the first in place.
        store(&root, &split, &stored).unwrap();
        assert!(!dir.path().join("tarkov-data.next").exists());
        assert!(!dir.path().join("tarkov-data.old").exists());

        let data = TarkovData::open(root);
        assert_eq!(data.status().manifest, Some(stored));
        assert!(data.map_json("customs").unwrap().contains("bigmap"));
        assert!(data.map_json("../manifest").is_err());
        assert!(data.common_json().unwrap().contains("lootContainers"));
    }

    #[test]
    fn staleness_follows_last_check() {
        let dir = tempfile::tempdir().unwrap();
        let data = TarkovData::open(dir.path().to_path_buf());
        let now = DateTime::parse_from_rfc3339("2026-10-11T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(data.is_stale(now), "no data yet");
        data.update(|status| status.manifest = Some(manifest("2026-10-11T08:00:00Z")));
        assert!(!data.is_stale(now));
        data.update(|status| status.manifest = Some(manifest("2026-10-11T05:00:00Z")));
        assert!(data.is_stale(now));
    }

    #[test]
    fn other_formats_are_ignored_on_open() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = manifest("2026-10-11T00:00:00Z");
        old.format = FORMAT + 1;
        write_json(&dir.path().join("manifest.json"), &old).unwrap();
        assert_eq!(
            TarkovData::open(dir.path().to_path_buf()).status().manifest,
            None
        );
    }

    /// Network: `cargo test live_sync -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_sync() {
        let dir = tempfile::tempdir().unwrap();
        let data = TarkovData::open(dir.path().join("tarkov-data"));
        assert!(data.sync(|status| println!("{:?}", status.state)));
        let status = data.status();
        assert_eq!(status.error, None);
        let manifest = status.manifest.unwrap();
        assert!(manifest.etag.is_some());
        let customs: Value = serde_json::from_str(&data.map_json("customs").unwrap()).unwrap();
        assert_eq!(customs["name"], "Customs");
        // Unchanged source: conditional request only refreshes checked_at.
        assert!(data.sync(|_| {}));
        assert_eq!(data.status().manifest.unwrap().fetched_at, manifest.fetched_at);
        for entry in fs::read_dir(dir.path().join("tarkov-data/maps")).unwrap() {
            let entry = entry.unwrap();
            println!("{:>8} {}", entry.metadata().unwrap().len() / 1024, entry.file_name().to_string_lossy());
        }
    }

    #[test]
    fn export_frontend_contract() {
        DataStatus::export_all_to(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings")).unwrap();
    }
}
