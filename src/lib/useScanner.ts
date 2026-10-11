import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceptSnapshot, checkFolders, getSnapshot, isTauri, onSnapshot, startScanner, stopScanner,
  type FolderConfig, type ScannerSnapshot,
} from "./scanner";
import { appendPosition, mergePositions, type PositionHistory } from "./positions";
import { mergeImportedRaids, observeRaids, type RaidRecord } from "./raids";
import type { ImportResult } from "../bindings/ImportResult";
import { keys, load, save } from "./persist";

export type ScannerAction = "check" | "start" | "stop";

export function useScanner() {
  const desktop = isTauri();
  const [snapshot, setSnapshot] = useState<ScannerSnapshot | null>(null);
  const [positions, setPositions] = useState<PositionHistory>(() => load(keys.positions, []));
  const [raids, setRaids] = useState<RaidRecord[]>(() => load(keys.raids, []));
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<ScannerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const current = useRef<ScannerSnapshot | null>(null);

  const receive = useCallback((next: ScannerSnapshot) => {
    const accepted = acceptSnapshot(current.current, next);
    current.current = accepted;
    setSnapshot(accepted);
    // Screenshots from the active raid that predate monitoring; merging is idempotent across snapshots.
    if (accepted.recovered_positions.length) {
      const recovered = accepted.recovered_positions;
      setPositions((history) => mergePositions(history, recovered));
    }
    if (accepted.latest_position) {
      const position = accepted.latest_position;
      setPositions((history) => appendPosition(history, position));
    }
    setRaids((records) => {
      const next = observeRaids(records, accepted.raid, accepted.activity);
      return JSON.stringify(next) === JSON.stringify(records) ? records : next;
    });
  }, []);

  useEffect(() => save(keys.positions, positions), [positions]);
  useEffect(() => save(keys.raids, raids), [raids]);

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
    desktop, snapshot, positions, raids, connected, busy, error, perform,
    running: snapshot?.monitoring === "running",
    retry: () => setAttempt((value) => value + 1),
    clearHistory: () => { setPositions([]); setRaids([]); },
    importHistory: (result: ImportResult) => {
      setRaids((records) => mergeImportedRaids(records, result.raids));
      setPositions((history) => mergePositions(history, result.positions));
    },
  };
}

export type Scanner = ReturnType<typeof useScanner>;
