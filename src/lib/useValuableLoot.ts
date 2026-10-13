import { useEffect, useState } from "react";
import { keys, load, save } from "./persist";

/** Experimental: loose loot shows its most valuable possible item. App-level so a change in Settings applies at once. */
export function useValuableLoot() {
  const [on, setOn] = useState(() => load<boolean>(keys.valuableLoot, false) === true);
  useEffect(() => save(keys.valuableLoot, on), [on]);
  return { on, setOn };
}

export type ValuableLootState = ReturnType<typeof useValuableLoot>;
