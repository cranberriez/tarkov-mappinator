# Map data survey and filter taxonomy proposal

Source: `tarkov-data/maps/*.json` (PvE baseline, 17 maps), `common.json`, `mobs.json`, `modes/{regular,pvp-season}`.
Skipped by request: extracts, transits, spawns. Scripts: `C:/Users/jakev/AppData/Local/Temp/tk-survey/`.

## 0. Top-level fields

Every doc has exactly: `accessKeys[]`, `accessKeysMinPlayerLevel`, `artillery?` (10/17 maps), `bosses[]`, `btrStops[]`, `coordinateToCardinalRotation`, `description`, `enemies[]` (string names), `extracts`, `hazards`, `id`, `locks`, `lootContainers`, `lootLoose`, `maxPlayerLevel`, `minPlayerLevel`, `name`, `nameId`, `normalizedName`, `players`, `raidDuration`, `scenePath`, `spawns`, `stationaryWeapons`, `switches`, `transits`, `wiki`.

Not in `types.ts`: `description`, `artillery` is typed as `unknown` (see below), `accessKeys` is `string[]` item ids (not a placeable thing). No hidden placeable field exists beyond the list above. `common.goonReports` is empty (`[]`), so there is no Goons location data.

Item ids (keys, loose loot items, accessKeys) have NO lookup in the local data (no items.json). Names/icons for them need either an items fetch or a static table.

## 1. Per-map counts

| map | containers | loose pts | locks | hazards | switches | stationary | btr | artillery zones | bosses entries |
|---|---|---|---|---|---|---|---|---|---|
| customs | 551 | 310 | 37 | 5 | 1 | 4 | 0 | 2 | 12 |
| factory | 167 | 81 | 4 | 0 | 0 | 0 | 0 | - | 5 |
| night-factory | 167 | 98 | 4 | 0 | 0 | 0 | 0 | - | 6 |
| ground-zero | 523 | 184 | 6 | 9 | 0 | 2 | 0 | 0 | 6 |
| ground-zero-21 | 523 | 262 | 6 | 9 | 0 | 2 | 0 | 0 | 9 |
| ground-zero-tutorial | 0 | 2 | 0 | 0 | 0 | 0 | 0 | - | 0 |
| interchange | 823 | 492 | 15 | 25 | 6 | 2 | 0 | 0 | 12 |
| lighthouse | 533 | 844 | 26 | 116 | 2 | 8 | 0 | 0 | 17 |
| reserve | 991 | 467 | 34 | 4 | 3 | 8 | 0 | 2 | 13 |
| shoreline | 756 | 444 | 34 | 30 | 0 | 4 | 0 | 2 | 16 |
| streets-of-tarkov | 1282 | 948 | 63 | 56 | 0 | 9 | 6 | 0 | 12 |
| woods | 428 | 300 | 4 | 64 | 0 | 2 | 8 | 2 | 12 |
| the-lab | 319 | 362 | 17 | 0 | 15 | 0 | 0 | - | 20 |
| the-lab-dark | 0 | 380 | 0 | 0 | 0 | 0 | 0 | - | 12 |
| the-labyrinth | 35 | 176 | 8 | 19 | 12 | 0 | 0 | - | 4 |
| icebreaker | 0 | 78 | 11 | 0 | 0 | 0 | 0 | - | 40 |
| terminal | 0 | 13 | 2 | 2 | 0 | 0 | 0 | 10 | 28 |
| **total** | 7098 | 5441 | 271 | 339 | 39 | 41 | 14 | 18 | |

Notes: factory/night-factory containers are byte-identical; ground-zero/ground-zero-21 containers identical (loose differs). Icebreaker, terminal, the-lab-dark have zero containers (data gap, not "no loot").

## 2. Categories

### 2.1 lootContainers (point, height = `position.y`)
- Shape: `{ lootContainer: id(string), position: {x,y,z} }`. 100% of rows have both. 43 ids in `common.lootContainers` -> 27 distinct names (several ids map to the same name, e.g. 4 "Weapon box" ids, 4 "Jacket" ids). Zero unresolved ids.
- `common.lootContainers[id]` = `{id, name, normalizedName}`. Group by `name` (or `normalizedName`), not by id.
- Counts by name (all maps): Duffle bag 1421, Drawer 1110, Weapon box 790, Toolbox 773, Wooden crate 605, Jacket 305, PC block 289, Cash register 231, Grenade box 221, Dead Scav 216, Buried barrel cache 209, Medbag 176, PMC body 133, Ground cache 109, Technical supply crate 101, Wooden ammo box 92, Medcase 74, Plastic suitcase 74, Safe 53, Ration supply crate 49, Medical supply crate 29, Civilian body 25, Bank safe 6, Scav body 2, Lab technician body 2, Bank cash register 2, Shturman's Stash 1.
- Density: 167 (factory) to 1282 (streets) per map. Streets 1282, reserve 991, interchange 823 need clustering at low zoom.
- Y range -65..4 up to 77 (woods); multi-floor on interchange, reserve, lab, streets, shoreline (underground -65).

Proposed tiers (UI: top-level toggle, expandable subgroups, leaf toggles):

| Tier 1 | Tier 2 (leaf = container name) | Icon stem | Count |
|---|---|---|---|
| Valuables | Safe, Bank safe, Shturman's Stash | container_safe (Stash: missing) | 53+6+1 |
| Valuables | PC block | container_pc-block | 289 |
| Valuables | Weapon box | container_weapon-box | 790 |
| Valuables | Cash register, Bank cash register | container_cash-register | 233 |
| Valuables | Jacket | container_jacket | 305 |
| Valuables | Plastic suitcase | container_plastic-suitcase | 74 |
| Medical | Medbag, Medcase, Medical supply crate | container_medbag, container_medcase, (supply crate: use container_crate) | 279 |
| Ammo and explosives | Grenade box, Wooden ammo box | container_grenade-box, container_wooden-ammo-box | 313 |
| Tools and general | Toolbox, Duffle bag, Drawer, Wooden crate | container_toolbox, container_duffle-bag, container_drawer, container_wooden-crate | 3909 |
| Supply crates | Technical supply crate, Ration supply crate | container_crate (generic) | 150 |
| Caches | Buried barrel cache, Ground cache | container_buried-barrel-cache, container_ground-cache | 318 |
| Bodies | Dead Scav, PMC body, Scav body, Civilian body, Lab technician body | container_dead-scav (others missing) | 378 |

Missing icons: Shturman's Stash, PMC/civilian/lab-tech body (reuse dead-scav), supply crates (reuse container_crate). `container_festive-airdrop-supply-crate` has no data source (airdrop is not in data).
Default visibility suggestion: Valuables + Caches on; "Tools and general" off (3909 pts, mostly noise).

### 2.2 lootLoose (point, y)
- Shape: `{ items: string[], position }`. All rows both keys. `items` = candidate item ids that can spawn at that point (length 1..95, avg 7.1; 2140 have 1 item, 580 have >20).
- 350 distinct item ids; top: `5d1b36a1...` 763, `5d1b371...` 732, `5734758f...` 693, `66507eab...` 666, `5c126884...` 653 (frequent = junk/barter; can't name them offline). Frequency: 36 ids appear once, 132 in 2-10 points, 58 in 11-100, 124 in 101-1000.
- Density: lighthouse 844, streets 948, reserve 467, interchange 492; total 5441. Needs clustering. Zero duplicate positions.
- Proposed: single top-level "Loose loot" with leaf-less single icon `loose_loot` plus, once an item DB exists, a search/filter ("show points where item X can spawn") rather than a static tree. Static subgroups are not derivable from this data (no category on items). Optional: split "Single-item spawns" (items.length==1, 2140 pts, deterministic) vs "Multi-item".
- Item DB needed: add `items.json` sync (name, shortName, types) to group by category (keys, meds, valuables).

### 2.3 locks (point; 10 rows also have outline/size/top/bottom)
- Shape: `{ id, key(item id), lockType, needsPower: bool, position }`; optional `{outline, size, top, bottom}` on 10 rows (only ground-zero-21 x6, night-factory x4). `needsPower` is false on all 271.
- `lockType`: `door` 237, `trunk` 34. 211 distinct key ids; top: `5448ba0b...` x25, `69bb3ec9...` x8, `61aa5ba8...` x6, `5c1d0f49...` x4. Lab locks use ~12 distinct keycard ids (`5c1d0f49...`, `5c1e2a1e...`...). 7 key ids are shared across maps.
- Keycard vs mechanical key cannot be determined offline (need item DB). `accessKeys` (the-lab `5c94bbff...`, labyrinth `679b9819...`, icebreaker `6a8c4c79...`) are raid-entry keys, not placeable.
- Proposed: Locks > Doors (237) / Trunks (34); then a per-key leaf list generated at runtime (grouped by keycard once item DB lands: Keycards vs Keys). Icons: `lock` for generic, `keycard` / `key` after item lookup. Trunk: no icon (use `lock`).
- Per map: lab 17 (all keycards), lab maps use floor-aware y; streets 63 (13 trunks), customs 37.

### 2.4 hazards (zone: outline 4 pts, 1 map entry has 5)
- Shape: `{ id, hazardType, name, position, outline[], top?, bottom?, size? }`. `top/bottom` only on 202/339 (no height on 137 minefields: lighthouse 91, streets 43, ground-zero 2, terminal 1). `size` on 28.
- `hazardType`: minefield 212 (name "Landmine"), sniper 108 ("Sniper"), hazard 19 ("Hazard", only the-labyrinth). No radiation/gas/etc. types in data.
- Per map: lighthouse minefield 103/sniper 13; woods 25/39; streets 43/13; shoreline 20/10; interchange 7/18; customs 2/3; gz 5/4; reserve 1/3; terminal 1/1; labyrinth 19 hazard.
- Proposed: Hazards > Minefields (`hazard`), Sniper zones (`hazard`), Labyrinth hazards (`hazard`). Draw as filled polygon with type colour, icon at centroid (zones: icon only at zoom threshold). Icons: `hazard`, `hazard_mortar` (use for artillery). Missing: sniper-zone, minefield (distinct) - optional.

### 2.5 switches (zone, small box with outline + size + top/bottom)
- Shape: `{ id, name, switchType, position, outline[], size, top, bottom, door: string|null, activatedBy: false|string(switch id), activates: [{operation:"Unlock", switch:id}] }`. All 39 rows complete.
- `switchType`: Open 36, Close 3. `name` is the useful classifier (32 distinct): Alarm Switch x6 (labyrinth x5, lab x1), Lightkeeper Switch x2, Sealed Door x2, plus one-offs.
- Per map: lab 15, labyrinth 12, interchange 6, reserve 3, lighthouse 2, customs 1.
- Proposed (derive from name keywords): Switches > Power (`*Power*`), Elevators (`*Elevator*`), Doors/Gates (`*Door*`, `*Gate*`, `Sealed Door`), Alarms (`Alarm*`), Extract-related (`*Exfil*`, `*Extract Button*`), Traps (labyrinth `*Trap*`). Icon: `switch` for all. Linking (activatedBy/activates) can render as lines; activates sample is non-empty for only 7 rows.
- Quirk: the-lab Water Level Switch height 0; duplicate named labyrinth switches (distinct ids) are legit.

### 2.6 stationaryWeapons (point)
- Shape: `{ stationaryWeapon: id, position }`. Two ids in `common.stationaryWeapons`: NSV Utyos (29), AGS-30 (12). Fully resolved.
- Per map: streets 9, lighthouse 8, reserve 8, customs/shoreline 4, others 2.
- Proposed: Stationary guns > NSV Utyos / AGS-30; icon `stationarygun`.

### 2.7 btrStops (point, flat shape)
- Shape: `{ name, x, y, z }` (NOT nested `position`; unlike all other categories). 14 rows: streets 6, woods 8. Names unique.
- Proposed: BTR > Stops with label; icon `btr_stop`. Route polyline could be drawn by order (order not verified).

### 2.8 artillery (zone)
- Shape: `artillery: { zones: [{ id, botom (sic), top, position, size, outline[4] }] }`. Field is spelled `botom` (typo upstream), so `bottom` never works. Present on 10 maps, but `zones` is empty on 6 of those (ground-zero, ground-zero-21, interchange, lighthouse, streets). Actual: customs 2, reserve 2, shoreline 2, woods 2, terminal 10 (18 total).
- Proposed: Hazards > Artillery strike zones (`hazard_mortar`), filled polygon at centroid icon.

### 2.9 bosses (no map-point data except spawnLocations positions)
- Shape: `{ mob(key into mobs.json), spawnChance, spawnLocations[], escorts[], supports[], spawnTime, spawnTimeRandom?, spawnTrigger: null|string, switch?, switch_id? }` (`spawnTimeRandom` missing on 6 rows; `switch`/`switch_id` on 14 rows where `spawnTrigger` is a string, e.g. "Switch").
- `spawnLocations[]`: `{ chance, name (zone label), spawnKey, positions: Vec3[] }`. 200 locations, 161 with positions, 39 with empty `positions` (zone known by name only). `escorts[]`: `{ mob, amount:[{chance,count}] }`. `supports` always empty.
- mobs.json: object keyed by mob key (44 entries) -> `{ id, name, normalizedName, health[], imagePortraitLink, imagePosterLink, equipment, items }`. All boss `mob` and escort keys resolve (0 unresolved). Names include bots: pmcBEAR/pmcUSEC (49+48 rows - raider-style PMC spawns), PmcBot=Raider, ExUsec/exUsecFree=Rogue, blackDivision/vsRF=Black Div./AF (terminal), Sentry=AF.
- Named bosses with spawn chance (PvE): customs Reshala .75, Knight/Partisan .25, Priest .3; factory Tagilla .5; interchange Killa .75, Tagilla .5; lighthouse Zryachiy 1, Glukhar 1, Knight .3, Partisan .25; shoreline Sanitar .75, Knight .3, Partisan .25, Priest .25; streets Kaban .75, Kollontay .75; woods Shturman .75, Knight .25, Partisan .25, Priest .3; lab-dark Wedge(Labs) 1; labyrinth Shadow of Tagilla 1; icebreaker Knight 1 (+Black Div. entries); terminal 5 bosses at .2 with no positions; gz-21 Priest .02 (61 pts).
- Proposed: Bosses > Named bosses (leaf per boss: Reshala, Killa, ...) > show spawn zone dots (zone label + chance). Separate "Roaming PMC/Raider/Rogue/Black Div." group (pmc* entries) - hide by default. Icons: `spawn_boss` (all named), `spawn_cultist-priest`, `spawn_rogue`, `spawn_black-div`, `spawn_af`, `spawn_pmc`, `spawn_bloodhound`, `spawn_sniper_scav`. Missing: per-boss portraits (can use `imagePortraitLink` remote URL; offline needs caching).
- Quirks: Partisan has 0 spawn locations everywhere; Zryachiy/Knight on icebreaker/lighthouse have 0 positions; labyrinth boss has 0 locations; entries like pmcUSEC repeat 2-16 times per map (one per group). Mode overrides cut bosses sharply (see 3).

### 2.10 enemies (no coordinates)
- `string[]` of display names per map (e.g. `Scavs`, `BEAR`, `USEC`, `Raider`, boss names + guards). Use as a map info chip / to filter boss list; not placeable.

## 3. Mode differences (`modes/regular`, `modes/pvp-season`)
- Overrides only these fields: `bosses`, `enemies`, `extracts`, `spawns`, `accessKeys` (terminal: 5 keys), `raidDuration` (the-lab-dark 30). NO mode override for lootContainers, lootLoose, locks, hazards, switches, stationaryWeapons, btrStops, artillery -> these are mode-independent (PvE baseline == PvP data).
- Boss counts shrink: e.g. customs 12 -> 4, reserve 13 -> 4, lighthouse 17 -> 9, the-lab-dark 12 -> 9 (regular) vs 0 (pvp-season), night-factory 6 -> 2 (regular) vs 0 (pvp).
- Mode `mobs.json` differ from base (5.68 MB regular, 5.82 MB pvp); `common.json` per-mode is only `{goonReports:[]}`.

## 4. Floor-awareness
- Points: `y` on position. Zones: `top/bottom` (hazards 202/339, switches 39/39, artillery 18/18 with typo, locks 10/271).
- Suggested floor model: derive per-map floor bands from y clusters (tarkov.dev uses per-map `layers`; not in this data). Y spans: interchange -11..39, lighthouse -29..55, reserve -22..33, shoreline -65..8 (underground), terminal -61..-59 (single), lab -28..6, lab-dark -28..28, woods -16..77, streets -8..18.
- Zones without height (137 minefields) should be treated as always visible.

## 5. Data quality
- 829 exact-duplicate lootContainers (same type, same position to 0.1 m): streets 285, reserve 201, ground-zero(+21) 57 each, lighthouse 56, customs 42, lab 36, shoreline 33, interchange 28, woods 24, factory 6. Dedup on load (key = id + rounded position). No same-position different-type collisions.
- Hazard ids are not unique: 28+ duplicate ids within map (woods 41, interchange 20, shoreline 14, lighthouse 11, streets 10, labyrinth 9). Do not key hazards by `id`; use index or hash of outline.
- Artillery `botom` typo; `zones` empty on 6 maps; `btrStops` flat `x,y,z`, not `position`.
- `locks`/`switches` ids unique. Lock `key` ids not resolvable locally. 7 key ids shared across maps.
- Empty datasets for icebreaker/terminal/lab-dark containers (and terminal loose only 13), ground-zero-tutorial has only 2 loose points.
- `ground-zero` vs `ground-zero-21` and `factory` vs `night-factory` share containers: cache once per `normalizedName` group if needed.
- 5 vertices on one hazard outline (all others 4).
- Hazard type set is small (minefield/sniper/hazard); no radiation/gas data exists.

## 6. tarkov.dev-style categories inferred from field names
Containers (by `lootContainer`), Loose loot (`lootLoose`), Locks/keys (`locks` + `lockType`), Hazards (`hazardType`: minefield, sniper), Switches (`switchType`, `activates` graph), Stationary guns, BTR stops, Artillery zones, Bosses (`bosses` -> mobs), Extracts/Transits/Spawns (done).

## 7. Icon coverage summary
Have: container_* (19), hazard, hazard_mortar, key, keycard, lock, loose_loot, stationarygun, switch, btr_stop, spawn_*, quest_*.
Missing (optional): sniper-zone, minefield, trunk, Shturman's Stash, body variants (PMC/civilian/lab tech), supply crate variants, per-boss portraits, power/elevator/alarm switch variants, NSV vs AGS-30.

## Recommended build order
1. lootContainers (7098 pts, 27 names, all resolved, icons ready) - tiered filter, dedupe 829 dups, clustering. Highest user value, data fully usable.
2. Hazards + artillery (zones, small, icons exist) - draw polygons; cheap and safety-relevant. Key by index, not id.
3. Stationary guns + BTR stops (55 pts total, resolved, trivial).
4. Switches (39, lab/labyrinth/interchange) and locks as doors/trunks; defer key vs keycard split.
5. Bosses (needs mobs.json join, per-mode data, spawn zones with chance labels); hide PMC/raider groups by default.
6. Loose loot last: needs items DB + clustering; offer item search rather than static tiers.
7. Lock key names/keycard split once an items lookup is synced.
