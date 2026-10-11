mod scanner;
mod tarkov_data;
mod tile_cache;

use scanner::{import, FolderConfig, ScannerService, ScannerSnapshot};
use serde_json::value::RawValue;
use tarkov_data::{DataStatus, TarkovData};
use tile_cache::{CacheStats, PrefetchStatus, Tile, TileCache, TileJob};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn scanner_snapshot(service: State<'_, Mutex<ScannerService>>) -> Result<ScannerSnapshot, String> {
    let service = service.lock().map_err(|_| "Scanner state unavailable")?;
    Ok(service.snapshot())
}

#[tauri::command]
fn check_folders(
    config: FolderConfig,
    app: tauri::AppHandle,
    service: State<'_, Mutex<ScannerService>>,
) -> Result<ScannerSnapshot, String> {
    let mut service = service.lock().map_err(|_| "Scanner state unavailable")?;
    let snapshot = service.check_folders(config);
    // State is authoritative; a disconnected view recovers using scanner_snapshot.
    if let Err(error) = app.emit("scanner:updated", &snapshot) {
        eprintln!("Unable to publish scanner update: {error}");
    }
    Ok(snapshot)
}

#[derive(Default)]
struct ImportControl {
    running: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}

/// Starts a one-off, read-only import in the background; progress arrives as `import:event`.
#[tauri::command]
fn start_import(config: FolderConfig, app: tauri::AppHandle, control: State<'_, ImportControl>) -> Result<(), String> {
    if control.running.swap(true, Ordering::SeqCst) {
        return Err("An import is already running.".into());
    }
    control.cancel.store(false, Ordering::SeqCst);
    // Thumbnails load the screenshots themselves through the asset protocol.
    if !config.screenshots.is_empty() {
        if let Err(error) = app.asset_protocol_scope().allow_directory(&config.screenshots, false) {
            eprintln!("Unable to allow screenshot previews: {error}");
        }
    }
    let (running, cancel) = (control.running.clone(), control.cancel.clone());
    std::thread::spawn(move || {
        import::run(&config, &cancel, |event| {
            let _ = app.emit("import:event", event);
        });
        running.store(false, Ordering::SeqCst);
    });
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
#[tauri::command(async)]
fn tarkov_data_map(
    name: String,
    mode: Option<String>,
    data: State<'_, Arc<TarkovData>>,
) -> Result<Box<RawValue>, String> {
    raw(data.map_json(&name, mode.as_deref())?)
}

#[tauri::command(async)]
fn tarkov_data_common(mode: Option<String>, data: State<'_, Arc<TarkovData>>) -> Result<Box<RawValue>, String> {
    raw(data.common_json(mode.as_deref())?)
}

#[tauri::command(async)]
fn tarkov_data_mobs(mode: Option<String>, data: State<'_, Arc<TarkovData>>) -> Result<Box<RawValue>, String> {
    raw(data.mobs_json(mode.as_deref())?)
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
        .manage(Mutex::new(ScannerService::new()))
        .manage(ImportControl::default())
        .setup(|app| {
            let store = app.path().app_data_dir()?.join("tarkov-data");
            let data = Arc::new(TarkovData::open(store));
            app.manage(data.clone());
            spawn_data_sync(app.handle().clone(), data);
            let tiles = app.path().app_data_dir()?.join("tile-cache");
            app.manage(Arc::new(TileCache::open(tiles)));

            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                let state = handle.state::<Mutex<ScannerService>>();
                if let Ok(mut service) = state.lock() {
                    if service.poll() {
                        let _ = handle.emit("scanner:updated", service.snapshot());
                    }
                };
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scanner_snapshot,
            check_folders,
            start_scanner,
            stop_scanner,
            start_import,
            cancel_import,
            tarkov_data_status,
            tarkov_data_sync,
            tarkov_data_map,
            tarkov_data_common,
            tarkov_data_mobs,
            tile_cache_stats,
            tile_cache_coverage,
            tile_prefetch_status,
            tile_prefetch,
            tile_prefetch_cancel,
            tile_cache_clear
        ])
        .run(tauri::generate_context!())
        .expect("Unable to launch Tarkov Mappinator");
}

#[tauri::command]
fn start_scanner(
    config: FolderConfig,
    app: tauri::AppHandle,
    service: State<'_, Mutex<ScannerService>>,
) -> Result<ScannerSnapshot, String> {
    let mut service = service.lock().map_err(|_| "Scanner state unavailable")?;
    let snapshot = service.start(config);
    let _ = app.emit("scanner:updated", &snapshot);
    Ok(snapshot)
}
#[tauri::command]
fn stop_scanner(
    app: tauri::AppHandle,
    service: State<'_, Mutex<ScannerService>>,
) -> Result<ScannerSnapshot, String> {
    let mut service = service.lock().map_err(|_| "Scanner state unavailable")?;
    let snapshot = service.stop();
    let _ = app.emit("scanner:updated", &snapshot);
    Ok(snapshot)
}
