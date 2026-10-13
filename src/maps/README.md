# Tarkov map library

React map of Escape from Tarkov: vector art or tarkov.dev tiles by floor, tarkov.dev markers (extracts, spawns, bosses, loot, …) with a tiered filter, and player positions. Imports nothing from the rest of this app, and needs no backend. Requires React 19 and a bundler with `import.meta.glob` (Vite) for the vendored SVGs and icons.

## Smallest use

```tsx
import { resolveMap, TarkovMap } from "./maps";

<TarkovMap map={resolveMap("customs")} floor={null} />
```

`resolveMap` takes any name the game or tarkov.dev uses for a map: `"customs"`, `"bigmap"`, `"customs_preset"`, `"Customs"`. The map fills its parent, which needs a size.

## Adding data

| Want | Pass | Shape |
|---|---|---|
| Players | `players` | `PlayerTrack[]`: `{ id, label?, color?, live?, positions: PlayerPosition[] }`, oldest first |
| Keep a player centred | `follow` + `onUserPan` | a track id; dragging calls `onUserPan`, where you set it to null |
| tarkov.dev markers | `markers` + `filters` | from `buildMarkers(useMapData(source, key, mode), useLookups(source, mode))`, filtered with `isVisible` |
| Your own markers | `markers` + `preset` | `MapMarker`s in a layer you add to `tarkovPreset.layers` |
| One floor | `floor` | an id from `floorsOf(map)`, or null for every floor; `floorAt(map, point)` is the floor a point is on |
| Floors side by side | `split` | |
| Pan, zoom, go to a floor | `ref` | `TarkovMapHandle`: `panTo`, `zoomBy`, `focusFloor` |

A `PlayerPosition` is `{ key, x, y?, z, heading?, at? }` in game world coordinates (the screenshot filename's `x, y, z`; `y` is height and picks the floor). `heading` is degrees clockwise from world +Z. For positions that arrive one at a time (a sync feed, other players), `usePlayerTracks()` holds tracks in state with `add(trackId, position, info?)`.

## Where data comes from

- Calibration, floors, SVG art and icons are vendored here (`calibration.json`, `assets/`). Refresh with `node scripts/vendor-maps.mjs`.
- Map documents come through a `MapDataSource`. `httpMapSource()` reads `https://json.tarkov.dev/<mode>/maps` directly (CORS-open, about 600 KB gzipped per mode). The desktop app uses its local mirror instead (`useDesktopMapSource` in `src/tarkov-data`), which adds loose loot item categories.
- Images come through `MapAssetsContext`: `webAssets` loads from `assets.tarkov.dev`; provide your own to cache or proxy.
- tarkov.dev hosts live in `hosts.json`, which the desktop backend also reads at build time.

## Styling

Class names (`map-canvas`, `overlay-marker`, `marker`, `split-label`, …) are styled by the app's `src/styles.css`; a host app needs those rules. Player marker colour comes from `--player`, falling back to `--accent-strong`.

See [ATTRIBUTION.md](ATTRIBUTION.md) for licenses.
