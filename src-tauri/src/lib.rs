mod autoshot;
mod companion;
mod history;
mod scanner;
mod tarkov_data;
mod item_data;
mod loose_loot;
mod thumb;
mod tile_cache;
mod window_anim;

use autoshot::{AutoShot, AutoShotConfig, AutoShotStatus};
use companion::{model::CompanionStatus, Companion};
use history::{CleanupKind, CleanupPlan, History, HistoryData, HistoryStats, LegacyRaid};
use scanner::{
    import::{self, FileStamp, ImportEvent, ImportResult},
    FolderConfig, HistoryBatch, PositionObservation, ScannerService, ScannerSnapshot,
};
use serde_json::value::RawValue;
use tarkov_data::{DataStatus, TarkovData};
use item_data::{ItemConfig, ItemData, ItemStatus};
use thumb::ThumbCache;
use tile_cache::{CacheStats, PrefetchStatus, Tile, TileCache, TileJob};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager, State};

/// Scanner commands are async: the poll thread holds the scanner lock while it reads logs, and
/// starting reads recent logs itself, so a sync command would freeze the window meanwhile.
#[tauri::command(async)]
fn scanner_snapshot(service: State<'_, Mutex<ScannerService>>) -> Result<ScannerSnapshot, String> {
    let service = service.lock().map_err(|_| "Scanner state unavailable")?;
    Ok(service.snapshot())
}

/// Sends a scanner snapshot to the UI and the companion journal. Call without the scanner lock held.
fn publish_snapshot(app: &tauri::AppHandle, snapshot: &ScannerSnapshot) {
    // State is authoritative; a disconnected view recovers using scanner_snapshot.
    if let Err(error) = app.emit("scanner:updated", snapshot) {
        eprintln!("Unable to publish scanner update: {error}");
    }
    let (Some(companion), Some(data)) = (app.try_state::<Arc<Companion>>(), app.try_state::<Arc<TarkovData>>()) else {
        return;
    };
    let maps = data.status().manifest.map(|manifest| manifest.maps).unwrap_or_default();
    companion.observe(snapshot, &|raw: &str| {
        maps.iter()
            .find(|map| map.name_id.eq_ignore_ascii_case(raw) || map.scene.eq_ignore_ascii_case(raw))
            .map(|map| map.normalized_name.clone())
    });
}

/// Stores what monitoring observed and sends the stored rows to the UI as `history:updated`.
fn record_history(app: &tauri::AppHandle, batch: HistoryBatch) {
    if batch.is_empty() {
        return;
    }
    match app.state::<Arc<History>>().record(&batch) {
        Ok(delta) => {
            let _ = app.emit("history:updated", delta);
        }
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    }
    if app.state::<ShotCleanup>().0.load(Ordering::SeqCst) {
        delete_ended_raid_screenshots(app, &batch);
    }
}

/// Whether screenshots stored for a raid are deleted once it ends; the UI owns the saved value.
#[derive(Default)]
struct ShotCleanup(AtomicBool);

#[tauri::command]
fn screenshot_cleanup_configure(delete_after_raid: bool, cleanup: State<'_, ShotCleanup>) {
    cleanup.0.store(delete_after_raid, Ordering::SeqCst);
}

/// Runs only after `batch` is stored, so a file is never deleted before its position is saved.
fn delete_ended_raid_screenshots(app: &tauri::AppHandle, batch: &HistoryBatch) {
    let ended: Vec<_> = batch.raids.iter().filter(|raid| raid.ended_at.is_some()).collect();
    if ended.is_empty() {
        return;
    }
    let Ok(folder) = app.state::<Mutex<ScannerService>>().lock().map(|service| service.snapshot().config.screenshots) else {
        return;
    };
    let history = app.state::<Arc<History>>();
    for raid in ended {
        if let Err(error) = history.delete_raid_screenshots(&folder, &raid.id) {
            eprintln!("{error}");
        }
    }
}

/// Tells the UI to reload history after a bulk change (import, clear).
fn history_reset(app: &tauri::AppHandle) {
    let _ = app.emit("history:reset", ());
}

#[tauri::command(async)]
fn check_folders(
    config: FolderConfig,
    app: tauri::AppHandle,
    service: State<'_, Mutex<ScannerService>>,
) -> Result<ScannerSnapshot, String> {
    let snapshot = service.lock().map_err(|_| "Scanner state unavailable")?.check_folders(config);
    publish_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[derive(Default)]
struct ImportControl {
    running: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    /// The last finished scan, stored only once the user commits it.
    pending: Arc<Mutex<Option<(ImportResult, Vec<FileStamp>)>>>,
}

/// Starts a read-only import scan in the background; progress arrives as `import:event`.
/// Files an earlier import read and that have not changed are left out unless `all`.
#[tauri::command]
fn start_import(
    config: FolderConfig,
    all: bool,
    app: tauri::AppHandle,
    control: State<'_, ImportControl>,
    history: State<'_, Arc<History>>,
) -> Result<(), String> {
    let known = history.known(!all)?;
    if control.running.swap(true, Ordering::SeqCst) {
        return Err("An import is already running.".into());
    }
    control.cancel.store(false, Ordering::SeqCst);
    if let Ok(mut pending) = control.pending.lock() {
        *pending = None;
    }
    // Previews are only served for files in this folder (see `serve_thumb`).
    if !config.screenshots.is_empty() {
        if let Err(error) = app.asset_protocol_scope().allow_directory(&config.screenshots, false) {
            eprintln!("Unable to allow screenshot previews: {error}");
        }
    }
    let (running, cancel, pending) = (control.running.clone(), control.cancel.clone(), control.pending.clone());
    std::thread::spawn(move || {
        let mut result = None;
        let files = import::run(&config, &known, &cancel, |event| {
            if let ImportEvent::Finished { result: finished } = &event {
                result = Some(finished.clone());
            }
            let _ = app.emit("import:event", event);
        });
        if let (Some(result), Ok(mut pending)) = (result, pending.lock()) {
            *pending = Some((result, files));
        }
        running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// Stores the last finished scan.
#[tauri::command(async)]
fn commit_import(
    app: tauri::AppHandle,
    control: State<'_, ImportControl>,
    history: State<'_, Arc<History>>,
    thumbs: State<'_, ThumbCache>,
) -> Result<(), String> {
    let pending = control.pending.lock().map_err(|_| "Import state unavailable")?.take();
    let (result, files) = pending.ok_or("Nothing to import; scan again.")?;
    history.import(&result, &files)?;
    // Committed screenshots leave the Import page for good, so their previews are dead weight.
    thumbs.forget(
        files
            .iter()
            .filter(|file| file.kind == import::ImportFileKind::Screenshot)
            .map(|file| std::path::Path::new(&file.path)),
    );
    history_reset(&app);
    Ok(())
}

#[tauri::command(async)]
fn history_load(history: State<'_, Arc<History>>) -> Result<HistoryData, String> {
    history.load()
}

#[tauri::command(async)]
fn history_stats(history: State<'_, Arc<History>>) -> HistoryStats {
    history.stats()
}

/// One-time move of the history the UI used to keep in localStorage.
#[tauri::command(async)]
fn history_migrate(
    raids: Vec<LegacyRaid>,
    positions: Vec<PositionObservation>,
    history: State<'_, Arc<History>>,
) -> Result<(), String> {
    history.migrate_legacy(&raids, &positions)
}

/// Deletes stored raids, positions, activity and the import ledger.
#[tauri::command(async)]
fn history_clear(app: tauri::AppHandle, history: State<'_, Arc<History>>) -> Result<(), String> {
    history.clear()?;
    history_reset(&app);
    Ok(())
}

fn source_folders(service: &State<'_, Mutex<ScannerService>>) -> Result<FolderConfig, String> {
    Ok(service.lock().map_err(|_| "Scanner state unavailable")?.snapshot().config)
}

#[tauri::command(async)]
fn cleanup_plan(
    service: State<'_, Mutex<ScannerService>>,
    history: State<'_, Arc<History>>,
) -> Result<CleanupPlan, String> {
    Ok(history.cleanup_plan(&source_folders(&service)?))
}

/// Moves game files whose data is stored to the Recycle Bin; returns how many were moved.
#[tauri::command(async)]
fn cleanup_run(
    kind: CleanupKind,
    service: State<'_, Mutex<ScannerService>>,
    history: State<'_, Arc<History>>,
) -> Result<u32, String> {
    history.cleanup(&source_folders(&service)?, kind)
}

/// Deletes everything the app stored: history, map tiles, screenshot previews, map data and paired sites.
/// Preferences live in the webview and are reset by the UI. Map data downloads again.
#[tauri::command(async)]
fn clear_all_data(
    app: tauri::AppHandle,
    control: State<'_, ImportControl>,
    history: State<'_, Arc<History>>,
    tiles: State<'_, Arc<TileCache>>,
    thumbs: State<'_, ThumbCache>,
    data: State<'_, Arc<TarkovData>>,
    companion: State<'_, Arc<Companion>>,
) -> Result<(), String> {
    if control.running.load(Ordering::SeqCst) {
        return Err("Cancel the running import first.".into());
    }
    tiles.clear()?;
    thumbs.clear()?;
    let status = data.clear()?;
    let _ = app.emit("tarkov-data:updated", status);
    companion.revoke_all();
    if let Ok(mut pending) = control.pending.lock() {
        *pending = None;
    }
    history.clear()?;
    history_reset(&app);
    tarkov_data_sync(app.clone(), data);
    Ok(())
}

#[tauri::command]
fn cancel_import(control: State<'_, ImportControl>) {
    control.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn tarkov_data_status(data: State<'_, Arc<TarkovData>>) -> DataStatus {
    data.status()
}

/// Starts a sync now, regardless of age; progress arrives as `tarkov-data:updated`.
#[tauri::command]
fn tarkov_data_sync(app: tauri::AppHandle, data: State<'_, Arc<TarkovData>>) {
    let data = data.inner().clone();
    std::thread::spawn(move || {
        data.sync(|status| {
            let _ = app.emit("tarkov-data:updated", status);
        });
    });
}

fn raw(json: String) -> Result<Box<RawValue>, String> {
    RawValue::from_string(json).map_err(|error| error.to_string())
}

/// `mode` is a tarkov.dev data set (`pve`, `regular`, `pvp-season`); omitted means PvE.
/// With item enrichment on, loose loot spawns carry their item categories (see `loose_loot`).
#[tauri::command(async)]
fn tarkov_data_map(
    name: String,
    mode: Option<String>,
    data: State<'_, Arc<TarkovData>>,
    items: State<'_, Arc<ItemData>>,
) -> Result<Box<RawValue>, String> {
    let json = data.map_json(&name, mode.as_deref())?;
    let Some(table) = items.loose_categories() else {
        return raw(json);
    };
    let mut map = tarkov_data::parse(&json)?;
    loose_loot::attach(&mut map, &table);
    raw(map.to_string())
}

#[tauri::command(async)]
fn tarkov_data_common(mode: Option<String>, data: State<'_, Arc<TarkovData>>) -> Result<Box<RawValue>, String> {
    raw(data.common_json(mode.as_deref())?)
}

#[tauri::command(async)]
fn tarkov_data_mobs(mode: Option<String>, data: State<'_, Arc<TarkovData>>) -> Result<Box<RawValue>, String> {
    raw(data.mobs_json(mode.as_deref())?)
}

#[tauri::command]
fn item_data_status(items: State<'_, Arc<ItemData>>) -> ItemStatus {
    items.status()
}

/// Saves the item enrichment config; starts a download when one is due.
#[tauri::command(async)]
fn item_data_configure(app: tauri::AppHandle, config: ItemConfig, items: State<'_, Arc<ItemData>>) -> Result<ItemStatus, String> {
    let (status, due) = items.configure(config)?;
    let _ = app.emit("item-data:updated", &status);
    if due {
        item_data_sync(app, items);
    }
    Ok(status)
}

/// Starts a check now when enabled; progress arrives as `item-data:updated`.
#[tauri::command]
fn item_data_sync(app: tauri::AppHandle, items: State<'_, Arc<ItemData>>) {
    let items = items.inner().clone();
    std::thread::spawn(move || {
        items.sync(|status| {
            let _ = app.emit("item-data:updated", status);
        });
    });
}

#[tauri::command(async)]
fn item_data_clear(app: tauri::AppHandle, items: State<'_, Arc<ItemData>>) -> Result<ItemStatus, String> {
    let status = items.clear()?;
    let _ = app.emit("item-data:updated", &status);
    Ok(status)
}

/// Shared item table; errors start with `disabled:` or `unavailable:`.
#[tauri::command(async)]
fn item_data_shared(items: State<'_, Arc<ItemData>>) -> Result<Box<RawValue>, String> {
    raw(items.shared_json()?)
}

/// A mode's differences from the shared item table.
#[tauri::command(async)]
fn item_data_mode(mode: Option<String>, items: State<'_, Arc<ItemData>>) -> Result<Box<RawValue>, String> {
    raw(items.mode_json(mode.as_deref())?)
}

#[tauri::command(async)]
fn tile_cache_stats(tiles: State<'_, Arc<TileCache>>) -> CacheStats {
    tiles.stats()
}

#[tauri::command(async)]
fn tile_cache_coverage(jobs: Vec<TileJob>, tiles: State<'_, Arc<TileCache>>) -> u64 {
    tiles.coverage(&jobs)
}

#[tauri::command]
fn tile_prefetch_status(tiles: State<'_, Arc<TileCache>>) -> PrefetchStatus {
    tiles.prefetch_status()
}

/// Downloads the given tiles in the background; progress arrives as `tiles:prefetch`.
#[tauri::command]
fn tile_prefetch(
    label: String,
    jobs: Vec<TileJob>,
    app: tauri::AppHandle,
    tiles: State<'_, Arc<TileCache>>,
) -> Result<(), String> {
    if tiles.prefetch_status().running {
        return Err("A tile download is already running.".into());
    }
    let tiles = tiles.inner().clone();
    std::thread::spawn(move || {
        tiles.prefetch(label, jobs, |status| {
            let _ = app.emit("tiles:prefetch", status);
        });
    });
    Ok(())
}

#[tauri::command]
fn tile_prefetch_cancel(tiles: State<'_, Arc<TileCache>>) {
    tiles.cancel_prefetch();
}

#[tauri::command(async)]
fn tile_cache_clear(tiles: State<'_, Arc<TileCache>>) -> Result<(), String> {
    tiles.clear()
}

/// `tiles://localhost/<path>` (`http://tiles.localhost/<path>` on Windows): cached tile, else fetched.
fn serve_tile(tiles: Arc<TileCache>, path: String) -> tauri::http::Response<Vec<u8>> {
    let response = tauri::http::Response::builder().header("Access-Control-Allow-Origin", "*");
    match tiles.get(&path) {
        Ok(Tile::Hit(bytes)) => response
            .status(200)
            .header("Content-Type", tile_cache::content_type(&path))
            .header("Cache-Control", "max-age=604800")
            .body(bytes),
        Ok(Tile::Missing) => response.status(404).header("Cache-Control", "max-age=604800").body(Vec::new()),
        Err(error) => response.status(502).body(error.into_bytes()),
    }
    .expect("static response parts")
}

/// `thumb://localhost/<encoded path>` (`http://thumb.localhost/...` on Windows): JPEG preview of a
/// screenshot, only for files the asset protocol scope allows (the import's screenshots folder).
fn serve_thumb(app: &tauri::AppHandle, thumbs: &ThumbCache, encoded: &str) -> tauri::http::Response<Vec<u8>> {
    let response = tauri::http::Response::builder().header("Access-Control-Allow-Origin", "*");
    let Ok(path) = percent_encoding::percent_decode_str(encoded).decode_utf8().map(|path| PathBuf::from(path.as_ref())) else {
        return response.status(400).body(Vec::new()).expect("static response parts");
    };
    if !app.asset_protocol_scope().is_allowed(&path) {
        return response.status(403).body(Vec::new()).expect("static response parts");
    }
    match thumbs.get(&path) {
        Ok(bytes) => response
            .status(200)
            .header("Content-Type", "image/jpeg")
            .header("Cache-Control", "max-age=604800")
            .body(bytes),
        Err(error) => response.status(502).body(error.into_bytes()),
    }
    .expect("static response parts")
}

/// Checks item data like map data, but only while item enrichment is enabled.
fn spawn_item_sync(app: tauri::AppHandle, items: Arc<ItemData>) {
    std::thread::spawn(move || loop {
        if items.is_stale(chrono::Utc::now()) {
            items.sync(|status| {
                let _ = app.emit("item-data:updated", status);
            });
        }
        std::thread::sleep(std::time::Duration::from_secs(15 * 60));
    });
}

/// Checks tarkov.dev at startup and whenever the last check is older than `tarkov_data::MAX_AGE`.
fn spawn_data_sync(app: tauri::AppHandle, data: Arc<TarkovData>) {
    std::thread::spawn(move || loop {
        if data.is_stale(chrono::Utc::now()) {
            data.sync(|status| {
                let _ = app.emit("tarkov-data:updated", status);
            });
        }
        // Also the retry interval after a failed sync.
        std::thread::sleep(std::time::Duration::from_secs(15 * 60));
    });
}

pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("tiles", |context, request, responder| {
            let path = request.uri().path().trim_start_matches('/').to_owned();
            let Some(tiles) = context.app_handle().try_state::<Arc<TileCache>>().map(|tiles| tiles.inner().clone()) else {
                responder.respond(tauri::http::Response::builder().status(503).body(Vec::new()).unwrap());
                return;
            };
            std::thread::spawn(move || responder.respond(serve_tile(tiles, path)));
        })
        .register_asynchronous_uri_scheme_protocol("thumb", |context, request, responder| {
            let encoded = request.uri().path().trim_start_matches('/').to_owned();
            let app = context.app_handle().clone();
            std::thread::spawn(move || {
                let response = match app.try_state::<ThumbCache>() {
                    Some(thumbs) => serve_thumb(&app, &thumbs, &encoded),
                    None => tauri::http::Response::builder().status(503).body(Vec::new()).unwrap(),
                };
                responder.respond(response);
            });
        })
        .manage(Mutex::new(ScannerService::new()))
        .manage(ImportControl::default())
        .manage(ShotCleanup::default())
        .setup(|app| {
            app.manage(Arc::new(History::open(app.path().app_data_dir()?.join("history.sqlite3"))));
            let store = app.path().app_data_dir()?.join("tarkov-data");
            let data = Arc::new(TarkovData::open(store));
            app.manage(data.clone());
            spawn_data_sync(app.handle().clone(), data);
            // An earlier build kept items inside the map store.
            let _ = std::fs::remove_dir_all(app.path().app_data_dir()?.join("tarkov-data").join("items"));
            let items = Arc::new(ItemData::open(app.path().app_data_dir()?.join("item-data")));
            app.manage(items.clone());
            spawn_item_sync(app.handle().clone(), items);
            let tiles = app.path().app_data_dir()?.join("tile-cache");
            app.manage(Arc::new(TileCache::open(tiles)));
            app.manage(ThumbCache::open(app.path().app_data_dir()?.join("thumb-cache")));

            let handle = app.handle().clone();
            let companion = Companion::new(
                app.path().app_data_dir()?.join("companion").join("clients.json"),
                app.package_info().version.to_string(),
                Box::new(move |status| {
                    let _ = handle.emit("companion:updated", status);
                }),
            );
            app.manage(companion.clone());
            // Ages connected → stale and expires pairing requests.
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                companion.tick();
            });

            let handle = app.handle().clone();
            let autoshot = AutoShot::new(Box::new(move |status| {
                let _ = handle.emit("autoshot:updated", status);
            }));
            app.manage(autoshot.clone());
            let (raid, press) = (app.handle().clone(), app.handle().clone());
            autoshot::spawn(
                autoshot,
                move || raid.state::<Mutex<ScannerService>>().lock().is_ok_and(|service| service.in_live_raid()),
                move |at| {
                    if let Ok(mut service) = press.state::<Mutex<ScannerService>>().lock() {
                        service.note_auto_press(at);
                    }
                },
            );

            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                let state = handle.state::<Mutex<ScannerService>>();
                // Stored and published after the lock is released.
                let Ok((changed, batch)) = state.lock().map(|mut service| {
                    let changed = service.poll().then(|| service.snapshot());
                    (changed, service.take_history())
                }) else {
                    continue;
                };
                record_history(&handle, batch);
                if let Some(snapshot) = changed {
                    publish_snapshot(&handle, &snapshot);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scanner_snapshot,
            check_folders,
            start_scanner,
            stop_scanner,
            companion_status,
            companion_start,
            companion_stop,
            companion_respond,
            companion_revoke,
            companion_allow_site,
            autoshot_status,
            autoshot_configure,
            screenshot_cleanup_configure,
            start_import,
            cancel_import,
            commit_import,
            history_load,
            history_stats,
            history_migrate,
            history_clear,
            cleanup_plan,
            cleanup_run,
            clear_all_data,
            tarkov_data_status,
            tarkov_data_sync,
            tarkov_data_map,
            tarkov_data_common,
            tarkov_data_mobs,
            item_data_status,
            item_data_configure,
            item_data_sync,
            item_data_clear,
            item_data_shared,
            item_data_mode,
            tile_cache_stats,
            tile_cache_coverage,
            tile_prefetch_status,
            tile_prefetch,
            tile_prefetch_cancel,
            tile_cache_clear,
            window_anim::animate_window,
            window_anim::unmaximize_in_place,
            window_anim::maximize_with_restore
        ])
        .run(tauri::generate_context!())
        .expect("Unable to launch Tarkov Mappinator");
}

#[tauri::command(async)]
fn start_scanner(
    config: FolderConfig,
    app: tauri::AppHandle,
    service: State<'_, Mutex<ScannerService>>,
) -> Result<ScannerSnapshot, String> {
    let (snapshot, batch) = {
        let mut service = service.lock().map_err(|_| "Scanner state unavailable")?;
        (service.start(config), service.take_history())
    };
    record_history(&app, batch);
    publish_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command(async)]
fn stop_scanner(
    app: tauri::AppHandle,
    service: State<'_, Mutex<ScannerService>>,
) -> Result<ScannerSnapshot, String> {
    let snapshot = service.lock().map_err(|_| "Scanner state unavailable")?.stop();
    publish_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command(async)]
fn companion_status(companion: State<'_, Arc<Companion>>) -> CompanionStatus {
    companion.status()
}

/// Starts the loopback server; a bind failure is reported in the status, not as an error.
#[tauri::command(async)]
fn companion_start(companion: State<'_, Arc<Companion>>) -> CompanionStatus {
    companion.start()
}

#[tauri::command(async)]
fn companion_stop(companion: State<'_, Arc<Companion>>) -> CompanionStatus {
    companion.stop()
}

#[tauri::command(async)]
fn companion_respond(
    pairing_id: String,
    allow: bool,
    companion: State<'_, Arc<Companion>>,
) -> Result<CompanionStatus, String> {
    companion.respond(&pairing_id, allow)
}

#[tauri::command(async)]
fn companion_revoke(client_id: String, companion: State<'_, Arc<Companion>>) -> CompanionStatus {
    companion.revoke(&client_id)
}

#[tauri::command(async)]
fn companion_allow_site(origin: String, companion: State<'_, Arc<Companion>>) -> CompanionStatus {
    companion.allow_site(&origin)
}

#[tauri::command]
fn autoshot_status(autoshot: State<'_, Arc<AutoShot>>) -> AutoShotStatus {
    autoshot.status()
}

#[tauri::command]
fn autoshot_configure(config: AutoShotConfig, autoshot: State<'_, Arc<AutoShot>>) -> Result<AutoShotStatus, String> {
    autoshot.configure(config)
}
