import { useEffect, useState } from "react";
import { keys, load, save } from "./persist";

/** While following, the map zooms in to fit the room the player is in. App-level so a change in Settings applies at once. */
export function useAutoZoom() {
  const [on, setOn] = useState(() => load<boolean>(keys.autoZoom, true) === true);
  useEffect(() => save(keys.autoZoom, on), [on]);
  return { on, setOn };
}

export type AutoZoomState = ReturnType<typeof useAutoZoom>;
