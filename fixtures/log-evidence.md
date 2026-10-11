# EFT log evidence

These small excerpts come from the local game's `application_000.log` and `output_000.log` files for build `1.2.0.0.47965`. They preserve original event names, ordering, and local timestamps. The timestamp timezone is not established by the log excerpt.

## Evidence matrix

| Observation | Evidence | What it supports | What remains unknown |
| --- | --- | --- | --- |
| Loading/map | `scene preset path:maps/customs_preset.bundle ...`, followed by `LocationLoaded` in [the current PvE fixture](logs/pve-customs-started.log) | Customs scene selection and location load completion | `LocationLoaded` alone does not prove that the player has started the raid |
| Started | `GameStarted` after `PlayerSpawnEvent`, in [the current PvE fixture](logs/pve-customs-started.log) | An explicit started lifecycle event | This event is later than scene loading and spawn preparation |
| Mode | `Session mode: PvpSeason` then `Session mode: Pve` in the current fixture | Explicit session-mode change to PvE before loading Customs | `RaidMode: Online` and `GameMode: deathmatch` in the earlier fixture are different raw fields; neither establishes PvP/PvE. Do not infer player role from mode |
| Role | The user identified the current Customs raid as Scav | User-provided context for the current example | No Scav/player-role field was found in the bounded application excerpt; role is not directly evidenced by this log |
| Ended/local termination | ``BaseLocalGame`1:GameEnd(...)``, `LocalPlayer:OnGameSessionEnd(...)`, and the `/client/match/local/end` request/response sequence in [the PvE end fixture](logs/pve-local-ends.log) | The local PvE game reached its end path and logged a matching backend response record | The response has an empty `responseText`; no semantic success status or `ExitStatus` value is available |
| Disconnected | `Connection.Disconnect() ... Reason:Stop game` in the earlier Online Interchange fixture | That Online session reached a network disconnect path | This is a separate signal from local PvE termination |
| Exited/extraction | No explicit exit status/reason in these excerpts | Nothing conclusive | Keep extraction/exit outcome unknown |

The current PvE Customs fixture captures the raid through `GameStarted`; the new end fixture adds the later local termination path for that Customs run and a subsequent Factory run in the same PvE session. The call stack contains `ManageQuestStatusesForPveOfflineGameEnd`, `OnGameSessionEnd`, and `GameEnd`, followed by a `/client/match/local/end` request and a response log with empty `responseText`. This supports local session termination, not a confirmed server outcome or extraction result. The separate Interchange excerpt shows the Online network disconnect grammar. The Scav role remains user-provided, not a field found in these logs.

## Provenance and sanitization

- The current excerpt is from the `<game Logs>/log_2026.10.11_11-03-07_1.2.0.0.47965/` session's `application_000.log`.
- The earlier excerpt combines selected application lifecycle lines and output end-path lines from the `<game Logs>/log_2026.10.11_8-55-46_1.2.0.0.47965/` session.
- The PvE end excerpt combines selected application, output, and backend endpoint lines from the `<game Logs>/log_2026.10.11_11-03-07_1.2.0.0.47965/` session. Service hostnames are replaced with `example.invalid`; request IDs are consistently replaced with numeric surrogates `1001` and `1002`. Both response bodies were empty and are not supplemented.
- Profile ID, account ID, server address, session ID, raid ID, and short server ID are replaced consistently where present with `<PROFILE>`, `<ACCOUNT>`, `<IP>`, `<SESSION>`, `<RAID>`, and `<SHORT>`. The current excerpts do not contain all of these fields. Build version, event text, timestamps, and non-sensitive timing values are retained.
- Only selected backend endpoint metadata was copied; network-message and account/profile payloads were not copied.
- The local-end request lines retain the original single trailing U+0020 space after the URL's final period. The parser tests cover both this observed suffix and a whitespace-normalized record.
- Parser tests consume these real excerpts directly. Only their observed fields should be treated as supported.
