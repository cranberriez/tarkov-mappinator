# EFT log evidence

These small excerpts come from the local game's `application_000.log` and `output_000.log` files for build `1.2.0.0.47965`. They preserve original event names, ordering, and local timestamps. The timestamp timezone is not established by the log excerpt.

## Evidence matrix

| Observation | Evidence | What it supports | What remains unknown |
| --- | --- | --- | --- |
| Loading/map | `scene preset path:maps/customs_preset.bundle ...`, followed by `LocationLoaded` in [the current PvE fixture](logs/pve-customs-started.log) | Customs scene selection and location load completion | `LocationLoaded` alone does not prove that the player has started the raid |
| Started | `GameStarted` after `PlayerSpawnEvent`, in [the current PvE fixture](logs/pve-customs-started.log) | An explicit started lifecycle event | This event is later than scene loading and spawn preparation |
| Mode | `Session mode: PvpSeason` then `Session mode: Pve` in the current fixture | Explicit session-mode change to PvE before loading Customs | `RaidMode: Online` and `GameMode: deathmatch` in the earlier fixture are different raw fields; neither establishes PvP/PvE. Do not infer player role from mode |
| Role | The user identified the current Customs raid as Scav | User-provided context for the current example | No Scav/player-role field was found in the bounded application excerpt; role is not directly evidenced by this log |
| Ended/disconnected | `EFT.Player:OnGameSessionEnd(...)`, `EFT.ClientPlayer:OnGameSessionEnd(...)`, and `Connection.Disconnect() ... Reason:Stop game` in the earlier fixture | The earlier Online Interchange session reached its end/disconnect path | No completed PvE session with an explicit `Session mode: Pve` marker was found; PvE end behavior is unvalidated. The log does not include an `ExitStatus` value or prove extraction specifically |
| Exited/extraction | No explicit exit status/reason in these excerpts | Nothing conclusive | Keep extraction/exit outcome unknown |

The current PvE Customs fixture captures the raid through `GameStarted`. A bounded follow-up inspection of the latest available tail found no PvE end or exit marker, and no other available application log contained an explicit `Session mode: Pve` marker. The earlier Interchange excerpt is a separate completed Online session and is included only to show the end/disconnect grammar; it does not establish PvE end behavior or the current raid's role.

## Provenance and sanitization

- The current excerpt is from the `<game Logs>/log_2026.10.11_11-03-07_1.2.0.0.47965/` session's `application_000.log`.
- The earlier excerpt combines selected application lifecycle lines and output end-path lines from the `<game Logs>/log_2026.10.11_8-55-46_1.2.0.0.47965/` session.
- Profile ID, account ID, server address, session ID, raid ID, and short server ID are replaced consistently where present with `<PROFILE>`, `<ACCOUNT>`, `<IP>`, `<SESSION>`, `<RAID>`, and `<SHORT>`. The current excerpts do not contain all of these fields. Build version, event text, timestamps, and non-sensitive timing values are retained.
- Backend, network-message, and account/profile payload logs were not copied.
- Parser tests consume these real excerpts directly. Only their observed fields should be treated as supported.
