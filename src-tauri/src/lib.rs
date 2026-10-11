mod scanner;

use scanner::{import, FolderConfig, ScannerService, ScannerSnapshot};
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

pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(ScannerService::new()))
        .manage(ImportControl::default())
        .setup(|app| {
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
            cancel_import
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
