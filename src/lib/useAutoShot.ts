import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AutoShotConfig } from "../bindings/AutoShotConfig";
import type { AutoShotStatus } from "../bindings/AutoShotStatus";
import { isTauri } from "./scanner";
import { keys, load, save } from "./persist";

export type { AutoShotConfig, AutoShotStatus };

const defaults: AutoShotConfig = { enabled: false, key: "PrintScreen", delete_after: true };

const configure = (config: AutoShotConfig) => invoke<AutoShotStatus>("autoshot_configure", { config });

/**
 * Auto-screenshot: Rust owns the timer and status; this hook owns the saved config and pushes it on
 * launch and on every change. App-level so a saved "on" applies without opening Settings.
 */
export function useAutoShot() {
  const desktop = isTauri();
  const [config, setConfigState] = useState((): AutoShotConfig => {
    const saved = load<Partial<AutoShotConfig>>(keys.autoShot, {});
    return { enabled: saved.enabled ?? defaults.enabled, key: saved.key ?? defaults.key, delete_after: saved.delete_after ?? defaults.delete_after };
  });
  const [status, setStatus] = useState<AutoShotStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const unlisten = listen<AutoShotStatus>("autoshot:updated", (event) => { if (!disposed) setStatus(event.payload); });
    return () => { disposed = true; void unlisten.then((stop) => stop()); };
  }, [desktop]);

  // Invalid values stay in the form with the error shown; the backend keeps its last valid config.
  useEffect(() => {
    if (!desktop) return;
    configure(config).then((next) => { setError(null); setStatus(next); save(keys.autoShot, config); },
      (cause) => setError(String(cause)));
  }, [desktop, config]);

  const setConfig = useCallback((patch: Partial<AutoShotConfig>) => setConfigState((current) => ({ ...current, ...patch })), []);

  return { desktop, config, status, error, setConfig };
}

export type AutoShot = ReturnType<typeof useAutoShot>;
