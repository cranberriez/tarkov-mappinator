mod scanner;

use scanner::{FolderConfig, ScannerService, ScannerSnapshot};
use std::sync::Mutex;
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

pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(ScannerService::new()))
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
            stop_scanner
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
