# UI rebuild plan — map-forward shell

## Shell
- **Custom title bar** (`decorations: false`): drag region, app mark, current raid summary (map · lifecycle), monitoring toggle, window controls.
- **Left nav**, vertical, collapsible to icons (state persisted in `localStorage`): Overview, Map, Activity, Settings.
- **Toasts** (bottom right, app-wide): new *live* activity events (not recovered history).
- **Data layer** `useScanner` hook: connection, snapshot, start/stop/check actions. Pages are pure views over it.

## Layout principles
- Pages fill the available space; no max-width caps.
- When space shrinks (width **or** height), compact before scrolling: each item has a priority; lower priorities hide or condense first, lists shrink to their latest few, panels collapse into rows. Detail moves behind a click (expand or jump to the owning page). Scroll is a last resort.
- Implemented with CSS container queries on the page host (`container-type: size`).

## Pages
| Page | Content |
|---|---|
| Overview | Raid context (map, mode, role, lifecycle, start time), scanner state, a few stats: screenshots seen/rejected, positions this raid, activity count, last position age. |
| Map | Full-bleed pannable/zoomable grid (world X → right, world Z → up, metres). Status chip top right (connection dot + map). Position markers: newest large and accented, fading toward muted as it goes stale but staying larger; older markers small and grey. Marker = teardrop (one sharp corner) pointing along provisional heading; plain dot when heading unknown. Follow toggle auto-pans to each new position; manual pan turns follow off. |
| Timeline | Raids newest first. Start/end dots and the connecting gutter line take a per-raid pastel colour (30-colour golden-angle palette, keyed on start time). Between them, a wide plot of that raid's positions joined in capture order. Raids and positions are reconstructed client-side (current raid + `raid` activity events) and persisted to `localStorage`. |
| Import | On-request scan (`start_import`, `scanner/import.rs`): every log session + every screenshot, streamed as `import:event`. Two panels (screenshots as thumbnails via the asset protocol, logs as source tiles) fill and light up as files are read. Raids are rebuilt per session with live-compatible IDs; screenshots matched by capture minute. Import merges into in-app history with a short animation. Read-only; no deletion, no backend store. |
| Activity | Latest activity list with kind filter + search. |
| Settings | Source folders + status, scanner health, diagnostics, log coverage. |

## Pieces / order of work
1. Shell: title bar, nav, page switching, theme tokens. ✅ (this iteration)
2. `useScanner` extraction + client-side position history. ✅
3. Map page: grid canvas, markers, freshness, follow. ✅
4. Overview, Activity, Settings pages. ✅
5. Toasts. ✅

## Later
- Backend datastore for imported/observed history (currently frontend `localStorage`).
- Thumbnail generation in Rust if full-size PNG previews prove too heavy.
- Backend position history (currently the frontend accumulates `latest_position` per session; lost on reload).
- Real map images + calibration (world → image transform per map), verified heading.
- Persisted folder config.
- Raid outcome, quest names (IDs only today).

## Assumptions recorded
- Map shows positions for the current raid only (by `raid_id`); positions without a raid ID are shown when no raid is known.
- "Stale" for the newest marker: full emphasis at receipt, fading over ~2 min to a resting "latest" style.
- Toasts only for events received live (`recovered: false`), max 4 visible, auto-dismiss after 6 s.
