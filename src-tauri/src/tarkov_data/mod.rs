//! Local mirror of tarkov.dev map data, synced in the background and independent of the scanner.
//!
//! PvE is the baseline; other game modes store only what differs from it.
//!
//! Layout under the store directory:
//! - `manifest.json`: sync metadata, the map index, and what each mode changes
//! - `common.json`: loot container, stationary weapon and goon report lookups
//! - `mobs.json`: boss and follower definitions
//! - `maps/<normalizedName>.json`: one document per map, names translated to English
//! - `modes/<mode>/maps/<normalizedName>.json`: a mode's differing top-level map fields
//! - `modes/<mode>/common.json`: a mode's differing common fields
//! - `modes/<mode>/mobs.json`: a mode's mobs, when they differ

pub mod split;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use ts_rs::TS;

pub const SOURCE: &str = env!("TARKOV_DATA_HOST");
/// The full data set; other modes are stored as differences from it.
pub const BASELINE: &str = "pve";
/// tarkov.dev data sets besides the baseline. PvP is `regular`; `/pvp/` does not exist.
pub const MODES: [&str; 2] = ["regular", "pvp-season"];
/// Bump when the stored layout or transform changes, forcing a full refetch.
const FORMAT: u32 = 2;
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

/// What one non-baseline mode changes.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ModeManifest {
    /// tarkov.dev data set, e.g. `regular`.
    pub mode: String,
    pub etag: Option<String>,
    /// Per map `normalized_name`, the top-level fields that differ from the baseline.
    pub maps: BTreeMap<String, Vec<String>>,
    /// Differing `common.json` fields.
    pub common: Vec<String>,
    /// True when the mode has its own `mobs.json`.
    pub mobs: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct DataManifest {
    pub format: u32,
    pub source: String,
    /// Baseline data set (`pve`).
    pub baseline: String,
    /// Baseline ETag.
    pub etag: Option<String>,
    /// When the stored data was downloaded.
    pub fetched_at: String,
    /// When the source was last confirmed unchanged or downloaded.
    pub checked_at: String,
    /// Baseline maps.
    pub maps: Vec<MapEntry>,
    pub modes: Vec<ModeManifest>,
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

    /// Deletes the stored data; the next sync downloads it again.
    pub fn clear(&self) -> Result<DataStatus, String> {
        // Holding the sync flag keeps a sync from writing while the store is removed.
        if self.syncing.swap(true, Ordering::SeqCst) {
            return Err("Map data is syncing; try again in a moment.".into());
        }
        let removed = match fs::remove_dir_all(&self.root) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("Unable to clear {}: {error}", self.root.display()))
            }
            _ => Ok(()),
        };
        let status = self.update(|status| {
            if removed.is_ok() {
                status.manifest = None;
                status.state = SyncState::Idle;
                status.error = None;
            }
        });
        self.syncing.store(false, Ordering::SeqCst);
        removed.map(|_| status)
    }

    fn mode_manifest(&self, mode: Option<&str>) -> Result<Option<ModeManifest>, String> {
        match mode {
            None | Some(BASELINE) => Ok(None),
            Some(mode) => self
                .status()
                .manifest
                .and_then(|manifest| manifest.modes.into_iter().find(|entry| entry.mode == mode))
                .map(Some)
                .ok_or_else(|| format!("No tarkov.dev data for mode \"{mode}\".")),
        }
    }

    /// One map document, by `normalized_name`, for `mode` (the baseline when None).
    pub fn map_json(&self, name: &str, mode: Option<&str>) -> Result<String, String> {
        let mode = self.mode_manifest(mode)?;
        let in_baseline = self
            .status()
            .manifest
            .is_some_and(|manifest| manifest.maps.iter().any(|map| map.normalized_name == name));
        let changed = mode
            .as_ref()
            .is_some_and(|mode| mode.maps.contains_key(name));
        if !in_baseline && !changed {
            return Err(format!("No tarkov.dev data for map \"{name}\"."));
        }
        let baseline = || read_text(&self.root.join("maps").join(format!("{name}.json")));
        match mode.filter(|_| changed) {
            None => baseline(),
            Some(mode) => {
                let base = if in_baseline {
                    parse(&baseline()?)?
                } else {
                    Value::Null
                };
                let file = self
                    .mode_dir(&mode.mode)
                    .join("maps")
                    .join(format!("{name}.json"));
                let fields = parse(&read_text(&file)?)?;
                Ok(split::overlay(base, into_object(fields)).to_string())
            }
        }
    }

    pub fn common_json(&self, mode: Option<&str>) -> Result<String, String> {
        let base = read_text(&self.root.join("common.json"))?;
        match self
            .mode_manifest(mode)?
            .filter(|mode| !mode.common.is_empty())
        {
            None => Ok(base),
            Some(mode) => {
                let fields = parse(&read_text(&self.mode_dir(&mode.mode).join("common.json"))?)?;
                Ok(split::overlay(parse(&base)?, into_object(fields)).to_string())
            }
        }
    }

    pub fn mobs_json(&self, mode: Option<&str>) -> Result<String, String> {
        match self.mode_manifest(mode)?.filter(|mode| mode.mobs) {
            None => read_text(&self.root.join("mobs.json")),
            Some(mode) => read_text(&self.mode_dir(&mode.mode).join("mobs.json")),
        }
    }

    fn mode_dir(&self, mode: &str) -> PathBuf {
        self.root.join("modes").join(mode)
    }
}

pub(crate) fn parse(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|error| format!("Invalid stored JSON: {error}"))
}

fn into_object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object,
        _ => Map::new(),
    }
}

pub(crate) fn read_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| format!("Unable to read {}: {error}", path.display()))
}

fn read_manifest(root: &Path) -> Option<DataManifest> {
    serde_json::from_str(&fs::read_to_string(root.join("manifest.json")).ok()?).ok()
}

pub(crate) enum Fetched {
    Unchanged,
    Changed { body: String, etag: Option<String> },
}

pub(crate) fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(120)))
        .user_agent(concat!("tarkov-mappinator/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

pub(crate) fn get(agent: &ureq::Agent, url: &str, etag: Option<&str>) -> Result<Fetched, String> {
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

pub(crate) fn url(set: &str, endpoint: &str) -> String {
    format!("{SOURCE}/{set}/{endpoint}")
}

/// Translates and splits one data set; `body` is its already fetched `maps` response.
fn load_set(agent: &ureq::Agent, set: &str, body: String) -> Result<split::Split, String> {
    let Fetched::Changed { body: names, .. } = get(agent, &url(set, "maps_en"), None)? else {
        return Err("Translations unexpectedly unchanged.".into());
    };
    let mut response: Value =
        serde_json::from_str(&body).map_err(|error| format!("Invalid {set} maps JSON: {error}"))?;
    let names: Value = serde_json::from_str(&names)
        .map_err(|error| format!("Invalid {set} translations JSON: {error}"))?;
    if let Some(names) = names.get("data").and_then(Value::as_object) {
        split::translate(&mut response, names);
    }
    split::split(response)
}

/// Checks every data set; when any changed, rebuilds the whole store, since mode differences
/// are relative to the baseline. Unchanged sets are refetched for the rebuild.
fn fetch_and_store(root: &Path, previous: Option<&DataManifest>) -> Result<DataManifest, String> {
    let agent = agent();
    let now = Utc::now().to_rfc3339();
    let previous = previous.filter(|manifest| manifest.format == FORMAT);
    let etag_of = |set: &str| {
        previous.and_then(|manifest| {
            if set == BASELINE {
                manifest.etag.clone()
            } else {
                let mode = manifest.modes.iter().find(|mode| mode.mode == set);
                mode.and_then(|mode| mode.etag.clone())
            }
        })
    };
    let sets: Vec<&str> = std::iter::once(BASELINE).chain(MODES).collect();
    let mut fetched = Vec::new();
    for set in &sets {
        fetched.push(get(&agent, &url(set, "maps"), etag_of(set).as_deref())?);
    }
    let unchanged = fetched.iter().all(|f| matches!(f, Fetched::Unchanged));
    if let Some(previous) = previous.filter(|_| unchanged) {
        let mut manifest = previous.clone();
        manifest.checked_at = now;
        write_json(&root.join("manifest.json"), &manifest)?;
        return Ok(manifest);
    }
    let mut bodies = Vec::new();
    for (set, result) in sets.iter().zip(fetched) {
        bodies.push(match result {
            Fetched::Changed { body, etag } => (body, etag),
            Fetched::Unchanged => match get(&agent, &url(set, "maps"), None)? {
                Fetched::Changed { body, etag } => (body, etag),
                Fetched::Unchanged => {
                    return Err(format!("{set}: unexpected 304 without a validator."))
                }
            },
        });
    }
    let mut bodies = bodies.into_iter();
    let (body, etag) = bodies.next().expect("baseline is first");
    let baseline = load_set(&agent, BASELINE, body)?;
    // One mode at a time, so only the baseline and one parsed mode are in memory.
    let mut modes = Vec::new();
    for (set, (body, etag)) in MODES.iter().zip(bodies) {
        let diff = split::diff(&baseline, load_set(&agent, set, body)?);
        modes.push((set.to_string(), etag, diff));
    }
    let manifest = DataManifest {
        format: FORMAT,
        source: SOURCE.into(),
        baseline: BASELINE.into(),
        etag,
        fetched_at: now.clone(),
        checked_at: now,
        maps: baseline
            .maps
            .iter()
            .map(|(name, map)| entry(name, map))
            .collect(),
        modes: modes
            .iter()
            .map(|(mode, etag, diff)| ModeManifest {
                mode: mode.clone(),
                etag: etag.clone(),
                maps: diff
                    .maps
                    .iter()
                    .map(|(name, fields)| (name.clone(), fields.keys().cloned().collect()))
                    .collect(),
                common: diff.common.keys().cloned().collect(),
                mobs: diff.mobs.is_some(),
            })
            .collect(),
    };
    let diffs: Vec<_> = modes
        .into_iter()
        .map(|(mode, _, diff)| (mode, diff))
        .collect();
    store(root, &baseline, &diffs, &manifest)?;
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

pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| format!("Unable to write {}: {error}", path.display()))
}

/// Writes a complete store beside `root`, then swaps it in so readers never see a partial store.
fn store(
    root: &Path,
    split: &split::Split,
    modes: &[(String, split::ModeDiff)],
    manifest: &DataManifest,
) -> Result<(), String> {
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
    for (mode, diff) in modes {
        let dir = next.join("modes").join(mode);
        fs::create_dir_all(dir.join("maps")).map_err(io)?;
        write_json(&dir.join("common.json"), &diff.common)?;
        if let Some(mobs) = &diff.mobs {
            write_json(&dir.join("mobs.json"), mobs)?;
        }
        for (name, fields) in &diff.maps {
            write_json(&dir.join("maps").join(format!("{name}.json")), fields)?;
        }
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
            baseline: BASELINE.into(),
            etag: Some("\"e\"".into()),
            fetched_at: checked_at.into(),
            checked_at: checked_at.into(),
            maps: vec![],
            modes: vec![],
        }
    }

    #[test]
    fn store_swaps_in_complete_documents_and_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("tarkov-data");
        let response = json!({ "data": { "maps": { "a": { "id": "a", "name": "Customs", "normalizedName": "customs",
            "nameId": "bigmap", "scenePath": "maps/customs_preset.bundle", "bosses": [1], "spawns": [1] } },
            "mobs": { "m": 1 }, "goonReports": [1] } });
        let split = split::split(response).unwrap();
        let pvp = split::split(json!({ "data": { "maps": { "a": { "id": "a", "name": "Customs",
            "normalizedName": "customs", "nameId": "bigmap", "scenePath": "maps/customs_preset.bundle",
            "bosses": [2], "spawns": [1] } }, "mobs": { "m": 2 }, "goonReports": [2] } }))
        .unwrap();
        let diffs = vec![("regular".to_string(), split::diff(&split, pvp))];
        let mut stored = manifest("2026-10-11T00:00:00Z");
        stored.maps = split
            .maps
            .iter()
            .map(|(name, map)| entry(name, map))
            .collect();
        assert_eq!(stored.maps[0].scene, "customs_preset");
        stored.modes = vec![ModeManifest {
            mode: "regular".into(),
            etag: None,
            maps: [("customs".to_string(), vec!["bosses".to_string()])].into(),
            common: vec!["goonReports".into()],
            mobs: true,
        }];
        store(&root, &split, &diffs, &stored).unwrap();
        // A second store replaces the first in place.
        store(&root, &split, &diffs, &stored).unwrap();
        assert!(!dir.path().join("tarkov-data.next").exists());
        assert!(!dir.path().join("tarkov-data.old").exists());

        let data = TarkovData::open(root);
        assert_eq!(data.status().manifest, Some(stored));
        let map = |mode| parse(&data.map_json("customs", mode).unwrap()).unwrap();
        assert_eq!(map(None)["bosses"], json!([1]));
        assert_eq!(map(Some("pve"))["bosses"], json!([1]));
        assert_eq!(map(Some("regular"))["bosses"], json!([2]));
        assert_eq!(
            map(Some("regular"))["nameId"],
            "bigmap",
            "unchanged fields come from the baseline"
        );
        assert!(data.map_json("../manifest", None).is_err());
        assert!(data.map_json("customs", Some("arena")).is_err());
        assert!(data.common_json(None).unwrap().contains("lootContainers"));
        let common = parse(&data.common_json(Some("regular")).unwrap()).unwrap();
        assert_eq!(common["goonReports"], json!([2]));
        assert_eq!(
            parse(&data.mobs_json(Some("regular")).unwrap()).unwrap(),
            json!({ "m": 2 })
        );
        assert_eq!(
            parse(&data.mobs_json(None).unwrap()).unwrap(),
            json!({ "m": 1 })
        );
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
        let customs = parse(&data.map_json("customs", None).unwrap()).unwrap();
        assert_eq!(customs["name"], "Customs");
        for mode in &manifest.modes {
            let common = &mode.common;
            println!(
                "{}: {} maps differ, common {common:?}, mobs {}",
                mode.mode,
                mode.maps.len(),
                mode.mobs
            );
            assert!(mode.etag.is_some());
        }
        // The Woods car extract costs more in PvP; everything else about the extracts matches.
        let fee = |mode| {
            let woods = parse(&data.map_json("woods", mode).unwrap()).unwrap();
            let extracts = woods["extracts"].as_array().unwrap().clone();
            let fees = extracts
                .iter()
                .filter_map(|e| e["transferItem"]["count"].as_u64());
            fees.max().unwrap()
        };
        assert!(fee(Some("regular")) > fee(None));
        let regular = &manifest.modes[0];
        assert!(regular.maps["woods"].contains(&"extracts".to_string()));
        assert!(!regular.maps["woods"].contains(&"lootContainers".to_string()));
    }

    #[test]
    fn export_frontend_contract() {
        ModeManifest::export_all_to(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings"))
            .unwrap();
        DataStatus::export_all_to(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings")).unwrap();
    }
}
