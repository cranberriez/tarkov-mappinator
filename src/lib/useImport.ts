import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FolderConfig } from "../bindings/FolderConfig";
import type { ImportEvent } from "../bindings/ImportEvent";
import type { ImportFile } from "../bindings/ImportFile";
import type { ImportResult } from "../bindings/ImportResult";

export type ImportPhase = "idle" | "discovering" | "reading_logs" | "reading_screenshots" | "ready" | "importing" | "imported";
export type ImportTile = ImportFile & { raid_id: string | null; detail: string | null };

/** Delay that lets the import animation play before data lands. */
const IMPORT_ANIMATION_MS = 2000;

export const previewSrc = (path: string) => (isTauri() && path ? convertFileSrc(path) : undefined);

export function useImport() {
  const desktop = isTauri();
  const [phase, setPhase] = useState<ImportPhase>("idle");
  const [files, setFiles] = useState<ImportTile[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const index = useRef(new Map<number, number>());

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ImportEvent>("import:event", ({ payload }) => {
      if (payload.type === "discovered") {
        setFiles((current) => {
          const next = [...current];
          for (const file of payload.files) {
            index.current.set(file.id, next.length);
            next.push({ ...file, raid_id: null, detail: null });
          }
          return next;
        });
      } else if (payload.type === "updated") {
        setFiles((current) => {
          const next = [...current];
          for (const update of payload.files) {
            const at = index.current.get(update.id);
            if (at !== undefined) next[at] = { ...next[at], ...update };
          }
          return next;
        });
      } else if (payload.type === "phase") {
        setPhase(payload.phase as ImportPhase);
      } else {
        setResult(payload.result);
        setPhase("ready");
      }
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; });
    return () => { disposed = true; unlisten?.(); };
  }, [desktop]);

  /** `all` re-reads files earlier imports already stored. */
  const scan = useCallback(async (config: FolderConfig, all = false) => {
    index.current.clear();
    setFiles([]);
    setResult(null);
    setError(null);
    setPhase("discovering");
    try {
      await invoke("start_import", { config, all });
    } catch (cause) {
      setError(String(cause));
      setPhase("idle");
    }
  }, []);

  const cancel = useCallback(() => { void invoke("cancel_import"); }, []);

  const commit = useCallback(async () => {
    if (!result) return;
    setError(null);
    setPhase("importing");
    try {
      // Stored right away; the backend's reset signal reloads history once the animation has played.
      await Promise.all([invoke("commit_import"), new Promise((done) => window.setTimeout(done, IMPORT_ANIMATION_MS))]);
      setPhase("imported");
    } catch (cause) {
      setError(String(cause));
      setPhase("ready");
    }
  }, [result]);

  return { desktop, phase, files, result, error, scan, cancel, commit };
}

export type Importer = ReturnType<typeof useImport>;
