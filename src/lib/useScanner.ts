import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceptSnapshot, checkFolders, getSnapshot, isTauri, onSnapshot, startScanner, stopScanner,
  type FolderConfig, type ScannerSnapshot,
} from "./scanner";
import { appendPosition, type PositionHistory } from "./positions";

export type ScannerAction = "check" | "start" | "stop";

export function useScanner() {
  const desktop = isTauri();
  const [snapshot, setSnapshot] = useState<ScannerSnapshot | null>(null);
  const [positions, setPositions] = useState<PositionHistory>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<ScannerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const current = useRef<ScannerSnapshot | null>(null);

  const receive = useCallback((next: ScannerSnapshot) => {
    const accepted = acceptSnapshot(current.current, next);
    current.current = accepted;
    setSnapshot(accepted);
    if (accepted.latest_position) {
      const position = accepted.latest_position;
      setPositions((history) => appendPosition(history, position));
    }
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    setConnected(false);
    setError(null);
    // Subscribe first; revision ordering protects against a slower initial fetch.
    void (async () => {
      try {
        const cleanup = await onSnapshot((next) => { if (!disposed) receive(next); });
        if (disposed) { cleanup(); return; }
        unlisten = cleanup;
        const initial = await getSnapshot();
        if (disposed) return;
        receive(initial);
        setConnected(true);
      } catch (cause) {
        unlisten?.();
        unlisten = undefined;
        if (!disposed) setError(String(cause));
      }
    })();
    return () => { disposed = true; unlisten?.(); };
  }, [desktop, receive, attempt]);

  const perform = useCallback(async (action: ScannerAction, folders?: FolderConfig) => {
    setBusy(action);
    setError(null);
    try {
      const config = folders ?? current.current?.config ?? { screenshots: "", logs: "" };
      const trimmed = { screenshots: config.screenshots.trim(), logs: config.logs.trim() };
      const result = action === "stop" ? await stopScanner()
        : action === "start" ? await startScanner(trimmed) : await checkFolders(trimmed);
      receive(result);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  }, [receive]);

  return {
    desktop, snapshot, positions, connected, busy, error, perform,
    running: snapshot?.monitoring === "running",
    retry: () => setAttempt((value) => value + 1),
  };
}

export type Scanner = ReturnType<typeof useScanner>;
