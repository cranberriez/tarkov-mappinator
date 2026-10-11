# Tarkov Mappinator

New local desktop application using Tauri 2, React, Vite, TypeScript, and Rust.

## Run

Requires Node.js 22.12+ (Node 24 used locally), Rust, the Windows C++ build tools, and WebView2.

```powershell
npm ci
npm run tauri dev
```

`npm run dev` opens the UI development server only; browser preview has no native file access and does not simulate a connected scanner. Closing the desktop window exits the application. Folder settings currently survive frontend reloads but not application restarts.

## Diagnostic milestone

- Application-owned Rust scanner, start/stop commands, and revisioned snapshots/events.
- Configurable screenshot/log paths, source health, and passive directory polling.
- Screenshot filename parsing for XYZ and raw rotation; provisional quaternion yaw with unverified compass alignment. Image pixels are not read.
- Log-based map loading, session mode, raid start, and the observed client session-stop event.
- Live/recovered raid indicators, capture age, association, and rejection diagnostics.
- TypeScript data types generated from Rust using `ts-rs`.

Start monitoring before taking a new in-game screenshot. Existing files are baselined and excluded. Filename timestamps have minute precision: captures in the minute when monitoring starts are conservatively rejected as uncertain. Take another after the minute changes. A screenshot is the last captured position, not continuous tracking.

Existing logs can recover context when starting mid-raid, explicitly marked recovered rather than a live start. Only evidenced map aliases are normalized; unknown fields remain unknown. See the [evidence matrix](fixtures/log-evidence.md): the current sample establishes PvE and Customs, but not Scav role. Session-stop detection does not establish extraction or death; PvE end behavior still needs a completed PvE sample.

Preferences across app restarts, tray behavior, maps, saved markers, and HTTP remain out of scope.

## Boundaries

- `src-tauri/src/scanner`: authoritative state, pure parsers, raid reducer, and source access, independent of screens and Tauri.
- `src-tauri/src/lib.rs`: thin Tauri commands and event adapter.
- `src/bindings`: generated IPC data types; regenerate after changing Rust models.
- `src/lib`: TypeScript IPC client and reusable presentation logic.
- `src/App.tsx`: diagnostic interface.

Rust owns monitoring, deduplication, log offsets, capture eligibility, parsing, heading conventions, and raid association. TypeScript owns forms and formatting; future map rendering, coordinate-to-screen transforms, and planning UI can also live there. A future website consumes the same scanner contract through a separate adapter.

## Verify

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

The Rust test `export_frontend_contract` regenerates the checked-in TypeScript bindings. Automated ingestion tests use temporary directories and the reviewed fixtures. For a reload smoke test, start monitoring in the desktop window, reload the webview, and confirm the backend revision and configuration are retained.

## Establish real fixtures before parsers

See [fixture collection notes](fixtures/README.md). Keep original logs and machine-specific source inventories in ignored `.local/`. Add only reviewed sanitized fixtures to `fixtures/`.

The implementation follows [Tauri's Vite configuration](https://tauri.app/start/frontend/vite/) and [managed state](https://tauri.app/develop/state-management/) patterns.
