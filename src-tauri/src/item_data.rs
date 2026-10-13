//! Optional local mirror of tarkov.dev item data ("item enrichment"), off by default.
//!
//! Nothing is downloaded or checked while it is disabled; turning it off keeps what is stored, unused,
//! until removed. Each item keeps a core (names, size, weight, types, base price, colour, description)
//! plus whichever optional pieces are switched on; switching a piece off strips it from disk at once.
//!
//! PvE is the shared baseline; other sets store per item only the fields that differ from it, so a
//! lookup checks the mode first, then the shared table. Layout under the store directory:
//! - `config.json`: enabled flag and kept pieces
//! - `state.json`: sync times, ETags and the pieces the stored data holds
//! - `shared.json`: `{ items, tables }`; every baseline item, plus the small lookup tables
//!   (item and handbook categories, flea market, player levels, …)
//! - `modes/<set>.json`: item id → differing fields (whole items when the baseline lacks them)
//! - `loose-categories.json`: item id → loose loot category (see `loose_loot`), when handbook categories are kept

use crate::loose_loot;
use crate::tarkov_data::{self, split, Fetched, SyncState, BASELINE, MAX_AGE, MODES};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use ts_rs::TS;

const LOOSE: &str = "loose-categories.json";

/// Optional parts of each item; everything not core, flea, trader or extra counts as stats.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ItemPieces {
    /// 24h average, low and high, last low, 48h change, offer count, scan time.
    pub flea: bool,
    /// Sell-to-trader and buy-from-trader offers.
    pub traders: bool,
    /// Properties (armor, ammo, weapons, grids, …) and conflicting items or slots.
    pub stats: bool,
    /// Categories, default contents, wiki and tarkov.dev links, image URLs.
    pub extra: bool,
}

impl Default for ItemPieces {
    fn default() -> Self {
        Self { flea: true, traders: true, stats: true, extra: true }
    }
}

impl ItemPieces {
    fn all_of(&self, other: &ItemPieces) -> bool {
        (!other.flea || self.flea)
            && (!other.traders || self.traders)
            && (!other.stats || self.stats)
            && (!other.extra || self.extra)
    }

    fn both(&self, other: &ItemPieces) -> ItemPieces {
        ItemPieces {
            flea: self.flea && other.flea,
            traders: self.traders && other.traders,
            stats: self.stats && other.stats,
            extra: self.extra && other.extra,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, TS)]
pub struct ItemConfig {
    pub enabled: bool,
    pub pieces: ItemPieces,
}

#[derive(Clone, Debug, Serialize, PartialEq, TS)]
pub struct ItemStatus {
    pub config: ItemConfig,
    pub state: SyncState,
    pub error: Option<String>,
    pub last_attempt: Option<String>,
    /// When the stored items were downloaded; None when there are none.
    pub fetched_at: Option<String>,
    /// When the source was last confirmed unchanged or downloaded.
    pub checked_at: Option<String>,
    /// Items in the shared table.
    pub items: u32,
    /// Bytes on disk.
    #[ts(type = "number")]
    pub bytes: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
struct StoredState {
    fetched_at: Option<String>,
    checked_at: Option<String>,
    etags: BTreeMap<String, String>,
    /// What the stored files hold; a piece switched on since needs a fresh download.
    pieces: ItemPieces,
    items: u32,
}

const CORE: [&str; 11] = [
    "id", "name", "shortName", "normalizedName", "description", "types", "width", "height", "weight",
    "basePrice", "backgroundColor",
];
const FLEA: [&str; 10] = [
    "avg24hPrice", "lastLowPrice", "low24hPrice", "high24hPrice", "changeLast48h", "changeLast48hPercent",
    "lastOfferCount", "lastScan", "updated", "minLevelForFlea",
];
const TRADERS: [&str; 2] = ["sellToTrader", "buyFromTrader"];
const EXTRA: [&str; 11] = [
    "categories", "handbookCategories", "containsItems", "wikiLink", "link", "iconLink", "gridImageLink",
    "baseImageLink", "inspectImageLink", "image512pxLink", "image8xLink",
];

fn kept(pieces: &ItemPieces, field: &str) -> bool {
    CORE.contains(&field)
        || if FLEA.contains(&field) {
            pieces.flea
        } else if TRADERS.contains(&field) {
            pieces.traders
        } else if EXTRA.contains(&field) {
            pieces.extra
        } else {
            pieces.stats
        }
}

fn strip(item: &mut Value, pieces: &ItemPieces) {
    if let Value::Object(fields) = item {
        fields.retain(|field, _| kept(pieces, field));
    }
}

pub struct ItemData {
    root: PathBuf,
    status: Mutex<ItemStatus>,
    syncing: AtomicBool,
    /// The loose loot category table and the download it was read for.
    loose: Mutex<Option<(String, Option<Arc<Value>>)>>,
}

impl ItemData {
    /// `root` is the store directory; it need not exist yet.
    pub fn open(root: PathBuf) -> Self {
        let config = read(&root.join("config.json")).unwrap_or_default();
        let stored: StoredState = read(&root.join("state.json")).unwrap_or_default();
        let bytes = size(&root);
        Self {
            status: Mutex::new(ItemStatus {
                config,
                state: SyncState::Idle,
                error: None,
                last_attempt: None,
                fetched_at: stored.fetched_at,
                checked_at: stored.checked_at,
                items: stored.items,
                bytes,
            }),
            root,
            syncing: AtomicBool::new(false),
            loose: Mutex::new(None),
        }
    }

    pub fn status(&self) -> ItemStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    fn update(&self, change: impl FnOnce(&mut ItemStatus)) -> ItemStatus {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        change(&mut status);
        status.clone()
    }

    /// True when enabled and there is no data, a piece is missing, or the last check is older than `MAX_AGE`.
    pub fn is_stale(&self, now: DateTime<Utc>) -> bool {
        let status = self.status();
        if !status.config.enabled {
            return false;
        }
        let stored: StoredState = read(&self.root.join("state.json")).unwrap_or_default();
        if !stored.pieces.all_of(&status.config.pieces) {
            return true;
        }
        status
            .checked_at
            .and_then(|checked| DateTime::parse_from_rfc3339(&checked).ok())
            .map_or(true, |checked| {
                (now - checked.with_timezone(&Utc))
                    .to_std()
                    .map_or(false, |age| age >= MAX_AGE)
            })
    }

    /// Saves the config. Pieces switched off are stripped from the stored files straight away;
    /// returns true when a download is due (enabled, and data or a piece is missing).
    pub fn configure(&self, config: ItemConfig) -> Result<(ItemStatus, bool), String> {
        if self.syncing.swap(true, Ordering::SeqCst) {
            return Err("Item data is syncing; try again in a moment.".into());
        }
        let result = self.apply_config(&config);
        self.forget_loose();
        self.syncing.store(false, Ordering::SeqCst);
        result?;
        let status = self.update(|status| {
            status.config = config;
            status.bytes = size(&self.root);
        });
        Ok((status, self.is_stale(Utc::now())))
    }

    fn apply_config(&self, config: &ItemConfig) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|error| format!("Unable to create {}: {error}", self.root.display()))?;
        write_atomic(&self.root.join("config.json"), config)?;
        let path = self.root.join("state.json");
        let Some(mut stored) = read::<StoredState>(&path) else {
            return Ok(());
        };
        let pieces = stored.pieces.both(&config.pieces);
        if pieces == stored.pieces {
            return Ok(());
        }
        let shared_path = self.root.join("shared.json");
        if let Some(mut shared) = read::<Value>(&shared_path) {
            if let Some(Value::Object(items)) = shared.get_mut("items") {
                items.values_mut().for_each(|item| strip(item, &pieces));
            }
            write_atomic(&shared_path, &shared)?;
        }
        if !pieces.extra {
            remove(&self.root.join(LOOSE))?;
        }
        for set in MODES {
            let mode_path = self.root.join("modes").join(format!("{set}.json"));
            if let Some(Value::Object(mut items)) = read::<Value>(&mode_path) {
                items.values_mut().for_each(|item| strip(item, &pieces));
                items.retain(|_, item| item.as_object().is_some_and(|fields| !fields.is_empty()));
                write_atomic(&mode_path, &Value::Object(items))?;
            }
        }
        stored.pieces = pieces;
        write_atomic(&path, &stored)
    }

    /// Checks the source and replaces the stored items when they changed. Does nothing when disabled
    /// or already syncing (returns false). `publish` receives each status change.
    pub fn sync(&self, publish: impl Fn(&ItemStatus)) -> bool {
        if !self.status().config.enabled || self.syncing.swap(true, Ordering::SeqCst) {
            return false;
        }
        publish(&self.update(|status| {
            status.state = SyncState::Syncing;
            status.last_attempt = Some(Utc::now().to_rfc3339());
        }));
        let pieces = self.status().config.pieces;
        let result = fetch_and_store(&self.root, pieces);
        self.forget_loose();
        publish(&self.update(|status| {
            match result {
                Ok(stored) => {
                    status.state = SyncState::Idle;
                    status.error = None;
                    status.fetched_at = stored.fetched_at;
                    status.checked_at = stored.checked_at;
                    status.items = stored.items;
                }
                Err(error) => {
                    status.state = SyncState::Failed;
                    status.error = Some(error);
                }
            }
            status.bytes = size(&self.root);
        }));
        self.syncing.store(false, Ordering::SeqCst);
        true
    }

    /// Deletes the stored items, keeping the config.
    pub fn clear(&self) -> Result<ItemStatus, String> {
        if self.syncing.swap(true, Ordering::SeqCst) {
            return Err("Item data is syncing; try again in a moment.".into());
        }
        let io = |error: std::io::Error| format!("Unable to clear {}: {error}", self.root.display());
        self.forget_loose();
        let removed = ["shared.json", "state.json", LOOSE]
            .iter()
            .map(|file| fs::remove_file(self.root.join(file)))
            .chain(std::iter::once(fs::remove_dir_all(self.root.join("modes"))))
            .find_map(|result| result.err().filter(|error| error.kind() != std::io::ErrorKind::NotFound))
            .map_or(Ok(()), |error| Err(io(error)));
        let status = self.update(|status| {
            status.fetched_at = None;
            status.checked_at = None;
            status.items = 0;
            status.error = None;
            status.state = SyncState::Idle;
            status.bytes = size(&self.root);
        });
        self.syncing.store(false, Ordering::SeqCst);
        removed.map(|_| status)
    }

    fn readable(&self) -> Result<(), String> {
        let status = self.status();
        if !status.config.enabled {
            return Err("disabled: item enrichment is turned off".into());
        }
        if status.fetched_at.is_none() {
            return Err("unavailable: item data has not been downloaded yet".into());
        }
        Ok(())
    }

    /// `{ items, tables }` from the baseline. Errors start with `disabled:` or `unavailable:`.
    pub fn shared_json(&self) -> Result<String, String> {
        self.readable()?;
        tarkov_data::read_text(&self.root.join("shared.json"))
    }

    /// The loose loot category table (see `loose_loot::build`); None while items are unreadable or lack
    /// handbook categories. Built from the shared table when a download from before it existed lacks it.
    pub fn loose_categories(&self) -> Option<Arc<Value>> {
        self.readable().ok()?;
        let fetched_at = self.status().fetched_at?;
        let mut cache = self.loose.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((_, table)) = cache.as_ref().filter(|(at, _)| *at == fetched_at) {
            return table.clone();
        }
        let path = self.root.join(LOOSE);
        let table = read::<Value>(&path).or_else(|| {
            let stored: StoredState = read(&self.root.join("state.json"))?;
            if !stored.pieces.extra {
                return None;
            }
            let shared: Value = read(&self.root.join("shared.json"))?;
            let table = loose_loot::build(shared["items"].as_object()?, &shared["tables"])?;
            let _ = write_atomic(&path, &table);
            Some(table)
        });
        let table = table.map(Arc::new);
        *cache = Some((fetched_at, table.clone()));
        table
    }

    fn forget_loose(&self) {
        *self.loose.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// Item id → fields that differ from the shared table for a set; the baseline has none.
    pub fn mode_json(&self, mode: Option<&str>) -> Result<String, String> {
        self.readable()?;
        match mode.unwrap_or(BASELINE) {
            BASELINE => Ok("{}".into()),
            set if MODES.contains(&set) => {
                let path = self.root.join("modes").join(format!("{set}.json"));
                if path.is_file() { tarkov_data::read_text(&path) } else { Ok("{}".into()) }
            }
            set => Err(format!("unavailable: no item data for mode \"{set}\"")),
        }
    }
}

fn read<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Writes through a temporary file so readers never see half a file.
fn write_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    tarkov_data::write_json(&temp, value)?;
    fs::rename(&temp, path).map_err(|error| format!("Unable to write {}: {error}", path.display()))
}

fn remove(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(format!("Unable to remove {}: {error}", path.display())),
        _ => Ok(()),
    }
}

fn size(root: &Path) -> u64 {
    let files = |dir: &Path| -> u64 {
        fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|entry| entry.metadata().ok())
                    .filter(|meta| meta.is_file())
                    .map(|meta| meta.len())
                    .sum()
            })
            .unwrap_or(0)
    };
    files(root) + files(&root.join("modes"))
}

/// One set's items, translated, keyed by id and stripped to `pieces`; the rest of its `data` as tables.
fn load_set(agent: &ureq::Agent, set: &str, body: String, pieces: &ItemPieces) -> Result<(Map<String, Value>, Value), String> {
    let Fetched::Changed { body: names, .. } = tarkov_data::get(agent, &tarkov_data::url(set, "items_en"), None)? else {
        return Err("Item translations unexpectedly unchanged.".into());
    };
    let mut response: Value =
        serde_json::from_str(&body).map_err(|error| format!("Invalid {set} items JSON: {error}"))?;
    let names: Value = serde_json::from_str(&names)
        .map_err(|error| format!("Invalid {set} item translations JSON: {error}"))?;
    if let Some(names) = names.get("data").and_then(Value::as_object) {
        split::translate(&mut response, names);
    }
    let Some(Value::Object(mut data)) = response.get_mut("data").map(Value::take) else {
        return Err(format!("{set} items response has no data"));
    };
    let list = match data.remove("items") {
        Some(Value::Object(items)) => items.into_iter().map(|(_, item)| item).collect(),
        Some(Value::Array(items)) => items,
        _ => return Err(format!("{set} items response has no items")),
    };
    let mut items = Map::new();
    for mut item in list {
        let Some(id) = item.get("id").and_then(Value::as_str).map(str::to_owned) else {
            continue;
        };
        strip(&mut item, pieces);
        items.insert(id, item);
    }
    Ok((items, Value::Object(data)))
}

/// Per item, the fields of `other` that differ from `baseline` (removed fields become null).
fn diff(baseline: &Map<String, Value>, other: Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (id, item) in other {
        let Some(Value::Object(base)) = baseline.get(&id) else {
            out.insert(id, item);
            continue;
        };
        let Value::Object(fields) = item else {
            continue;
        };
        let mut changed: Map<String, Value> = fields
            .iter()
            .filter(|(field, value)| base.get(*field) != Some(*value))
            .map(|(field, value)| (field.clone(), value.clone()))
            .collect();
        for field in base.keys().filter(|field| !fields.contains_key(*field)) {
            changed.insert(field.clone(), Value::Null);
        }
        if !changed.is_empty() {
            out.insert(id, Value::Object(changed));
        }
    }
    out
}

/// Checks every set; when any changed (or the stored pieces lack one now wanted), downloads them all,
/// since mode differences are relative to the baseline.
fn fetch_and_store(root: &Path, pieces: ItemPieces) -> Result<StoredState, String> {
    let agent = tarkov_data::agent();
    let now = Utc::now().to_rfc3339();
    let previous: Option<StoredState> = read(&root.join("state.json"))
        .filter(|stored: &StoredState| stored.pieces.all_of(&pieces) && root.join("shared.json").is_file());
    let sets: Vec<&str> = std::iter::once(BASELINE).chain(MODES).collect();
    let mut fetched = Vec::new();
    for set in &sets {
        let etag = previous.as_ref().and_then(|stored| stored.etags.get(*set)).map(String::as_str);
        fetched.push(tarkov_data::get(&agent, &tarkov_data::url(set, "items"), etag)?);
    }
    if let Some(mut stored) = previous.clone().filter(|_| fetched.iter().all(|f| matches!(f, Fetched::Unchanged))) {
        stored.checked_at = Some(now);
        write_atomic(&root.join("state.json"), &stored)?;
        return Ok(stored);
    }
    let modes_dir = root.join("modes");
    fs::create_dir_all(&modes_dir).map_err(|error| format!("Unable to create {}: {error}", modes_dir.display()))?;
    let mut etags = BTreeMap::new();
    let mut baseline = Map::new();
    for (set, result) in sets.iter().zip(fetched) {
        let (body, etag) = match result {
            Fetched::Changed { body, etag } => (body, etag),
            Fetched::Unchanged => match tarkov_data::get(&agent, &tarkov_data::url(set, "items"), None)? {
                Fetched::Changed { body, etag } => (body, etag),
                Fetched::Unchanged => return Err(format!("{set}: unexpected 304 without a validator.")),
            },
        };
        if let Some(etag) = etag {
            etags.insert(set.to_string(), etag);
        }
        // One set at a time, so only the baseline and one parsed mode are in memory.
        let (items, tables) = load_set(&agent, set, body, &pieces)?;
        if *set == BASELINE {
            match loose_loot::build(&items, &tables) {
                Some(table) => write_atomic(&root.join(LOOSE), &table)?,
                None => remove(&root.join(LOOSE))?,
            }
            let shared = serde_json::json!({ "items": items, "tables": tables });
            write_atomic(&root.join("shared.json"), &shared)?;
            baseline = items;
        } else {
            write_atomic(&modes_dir.join(format!("{set}.json")), &diff(&baseline, items))?;
        }
    }
    let stored = StoredState {
        fetched_at: Some(now.clone()),
        checked_at: Some(now),
        etags,
        pieces,
        items: baseline.len() as u32,
    };
    write_atomic(&root.join("state.json"), &stored)?;
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pieces_sort_fields() {
        let none = ItemPieces { flea: false, traders: false, stats: false, extra: false };
        let mut item = json!({ "id": "a", "name": "Bolts", "avg24hPrice": 1, "sellToTrader": [], "properties": {},
            "categories": [], "someFutureField": 1 });
        strip(&mut item, &ItemPieces { stats: true, ..none });
        assert_eq!(item, json!({ "id": "a", "name": "Bolts", "properties": {}, "someFutureField": 1 }));
    }

    #[test]
    fn modes_keep_only_differences() {
        let base = json!({ "a": { "name": "A", "avg24hPrice": 1, "weight": 2 }, "b": { "name": "B" } });
        let other = json!({ "a": { "name": "A", "avg24hPrice": 5 }, "b": { "name": "B" }, "c": { "name": "C" } });
        let out = diff(base.as_object().unwrap(), other.as_object().unwrap().clone());
        assert_eq!(Value::Object(out), json!({ "a": { "avg24hPrice": 5, "weight": null }, "c": { "name": "C" } }));
    }

    #[test]
    fn disabled_store_never_syncs_or_reads() {
        let dir = tempfile::tempdir().unwrap();
        let data = ItemData::open(dir.path().to_path_buf());
        assert!(!data.status().config.enabled, "off by default");
        assert!(!data.is_stale(Utc::now()));
        assert!(!data.sync(|_| panic!("no sync while disabled")));
        assert!(data.shared_json().unwrap_err().starts_with("disabled:"));
        let (_, due) = data.configure(ItemConfig { enabled: true, pieces: ItemPieces::default() }).unwrap();
        assert!(due, "enabled with no data");
        assert!(data.shared_json().unwrap_err().starts_with("unavailable:"));
    }

    #[test]
    fn switching_a_piece_off_strips_stored_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("modes")).unwrap();
        write_atomic(&root.join("shared.json"), &json!({ "items": { "a": { "id": "a", "avg24hPrice": 1, "sellToTrader": [] } }, "tables": {} })).unwrap();
        write_atomic(&root.join("modes").join("regular.json"), &json!({ "a": { "avg24hPrice": 2 } })).unwrap();
        let stored = StoredState { fetched_at: Some(Utc::now().to_rfc3339()), checked_at: Some(Utc::now().to_rfc3339()), items: 1, ..Default::default() };
        write_atomic(&root.join("state.json"), &stored).unwrap();
        let data = ItemData::open(root.to_path_buf());
        let pieces = ItemPieces { flea: false, ..Default::default() };
        let (_, due) = data.configure(ItemConfig { enabled: true, pieces }).unwrap();
        assert!(!due, "fewer pieces need no download");
        assert_eq!(tarkov_data::parse(&data.shared_json().unwrap()).unwrap()["items"]["a"], json!({ "id": "a", "sellToTrader": [] }));
        assert_eq!(tarkov_data::parse(&data.mode_json(Some("regular")).unwrap()).unwrap(), json!({}));
        let (_, due) = data.configure(ItemConfig { enabled: true, pieces: ItemPieces::default() }).unwrap();
        assert!(due, "a piece switched back on needs a download");
    }

    /// Network: `cargo test live_item_sync -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_item_sync() {
        let dir = tempfile::tempdir().unwrap();
        let data = ItemData::open(dir.path().to_path_buf());
        data.configure(ItemConfig { enabled: true, pieces: ItemPieces::default() }).unwrap();
        assert!(data.sync(|status| println!("{:?}", status.state)));
        let status = data.status();
        assert_eq!(status.error, None);
        let shared = tarkov_data::parse(&data.shared_json().unwrap()).unwrap();
        assert_eq!(shared["items"]["5449016a4bdc2d6f028b456f"]["name"], "Roubles");
        let regular = tarkov_data::parse(&data.mode_json(Some("regular")).unwrap()).unwrap();
        println!("{} items, {} bytes, regular differs on {}", status.items, status.bytes, regular.as_object().unwrap().len());
        let checked = status.checked_at.clone();
        assert!(data.sync(|_| {}));
        assert_eq!(data.status().fetched_at, status.fetched_at, "unchanged ETags skip the download");
        assert_ne!(data.status().checked_at, checked);
    }

    #[test]
    fn export_frontend_contract() {
        ItemStatus::export_all_to(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings")).unwrap();
    }
}
