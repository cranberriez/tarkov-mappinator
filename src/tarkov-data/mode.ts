/** tarkov.dev data set. PvE is stored whole; the others as differences from it, merged on read. */
export type DataMode = "pve" | "regular" | "pvp-season";

const modes: Record<string, DataMode> = { pve: "pve", regular: "regular", pvpseason: "pvp-season" };

/**
 * Data set for the game's `Session mode:` log value (`Pve`, `Regular`, `PvpSeason`), as in
 * `RaidState.game_mode`. Unknown or missing modes fall back to PvE.
 */
export const dataMode = (gameMode: string | null | undefined): DataMode =>
  modes[(gameMode ?? "").toLowerCase().replace(/[^a-z]/g, "")] ?? "pve";
