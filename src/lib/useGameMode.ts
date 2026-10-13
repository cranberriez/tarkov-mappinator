import { useEffect, useState } from "react";
import { dataMode, type DataMode } from "../tarkov-data";

export const gameModes: DataMode[] = ["pve", "regular", "pvp-season"];

/**
 * The data mode the map shows: the one inferred from logs, unless the player picked another to look
 * around in. A pick lasts until `resetKey` changes (a raid starts or a past raid is opened).
 */
export function useGameMode(logMode: string | null | undefined, resetKey: string) {
  const inferred = dataMode(logMode);
  const [picked, setPicked] = useState<DataMode | null>(null);
  useEffect(() => setPicked(null), [resetKey]);
  return {
    mode: picked ?? inferred,
    inferred,
    pick: (next: DataMode) => setPicked(next === inferred ? null : next),
  };
}

export type GameMode = ReturnType<typeof useGameMode>;
