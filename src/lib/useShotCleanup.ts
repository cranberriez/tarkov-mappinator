import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./scanner";
import { keys, load, save } from "./persist";

/**
 * Delete a raid's stored screenshots when it ends. Rust does the deleting; this hook owns the saved
 * value and pushes it on launch and on change. App-level so a saved "on" applies without opening Settings.
 */
export function useShotCleanup() {
  const desktop = isTauri();
  const [deleteAfterRaid, setDeleteAfterRaid] = useState(() => load<boolean>(keys.shotCleanup, false));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    invoke("screenshot_cleanup_configure", { deleteAfterRaid })
      .then(() => { setError(null); save(keys.shotCleanup, deleteAfterRaid); }, (cause) => setError(String(cause)));
  }, [desktop, deleteAfterRaid]);

  return { desktop, deleteAfterRaid, setDeleteAfterRaid, error };
}

export type ShotCleanup = ReturnType<typeof useShotCleanup>;
