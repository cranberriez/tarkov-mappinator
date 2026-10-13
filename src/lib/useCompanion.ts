import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { isTauri } from "./scanner";
import { keys, load, save } from "./persist";
import {
  getCompanionStatus, onCompanionStatus, respondToPairing, revokeClient, startCompanion, stopCompanion,
  type CompanionStatus,
} from "./companion";

/**
 * Site connection: the loopback server the Tarkov Hideout site polls. Rust owns the status and pushes
 * every change; this hook owns only the enabled preference and starts the server on launch.
 */
export function useCompanion() {
  const desktop = isTauri();
  const [enabled, setEnabledState] = useState(() => load(keys.companionEnabled, false));
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seenPending = useRef(new Set<string>());

  useEffect(() => save(keys.companionEnabled, enabled), [enabled]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const unlisten = onCompanionStatus((next) => { if (!disposed) setStatus(next); });
    void getCompanionStatus().then((next) => { if (!disposed) setStatus(next); }, (cause) => setError(String(cause)));
    // Launch: the server isn't running by default.
    if (load(keys.companionEnabled, false)) void startCompanion().catch((cause) => setError(String(cause)));
    return () => { disposed = true; void unlisten.then((stop) => stop()); };
  }, [desktop]);

  // A new pairing request flashes the taskbar button, so it's noticed in mini mode or behind the game.
  useEffect(() => {
    const ids = status?.pending.map((pending) => pending.id) ?? [];
    if (ids.some((id) => !seenPending.current.has(id))) {
      void getCurrentWindow().requestUserAttention(UserAttentionType.Critical).catch(() => {});
    }
    seenPending.current = new Set(ids);
  }, [status?.pending]);

  const act = useCallback(async (action: () => Promise<CompanionStatus>) => {
    setError(null);
    try { setStatus(await action()); } catch (cause) { setError(String(cause)); }
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    void act(next ? startCompanion : stopCompanion);
  }, [act]);

  return {
    desktop, enabled, status, error, setEnabled,
    connection: enabled ? status?.connection.state ?? "waiting" : "off",
    respond: (pairingId: string, allow: boolean) => act(() => respondToPairing(pairingId, allow)),
    revoke: (clientId: string) => act(() => revokeClient(clientId)),
    retry: () => act(startCompanion),
  };
}

export type CompanionConnection = ReturnType<typeof useCompanion>;
