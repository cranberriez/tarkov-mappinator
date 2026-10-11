import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FolderConfig } from "../bindings/FolderConfig";
import type { ScannerSnapshot } from "../bindings/ScannerSnapshot";

export { isTauri };
export type { FolderConfig, ScannerSnapshot };
export { acceptSnapshot } from "./snapshot";

export const getSnapshot = () => invoke<ScannerSnapshot>("scanner_snapshot");
export const checkFolders = (config: FolderConfig) =>
  invoke<ScannerSnapshot>("check_folders", { config });
export const startScanner = (config: FolderConfig) =>
  invoke<ScannerSnapshot>("start_scanner", { config });
export const stopScanner = () => invoke<ScannerSnapshot>("stop_scanner");

export const onSnapshot = (receive: (snapshot: ScannerSnapshot) => void) =>
  listen<ScannerSnapshot>("scanner:updated", (event) => receive(event.payload));

