import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CompanionStatus } from "../bindings/CompanionStatus";
import type { ConnectionState } from "../bindings/ConnectionState";
import type { PairedClient } from "../bindings/PairedClient";
import type { PendingPairing } from "../bindings/PendingPairing";

export type { CompanionStatus, ConnectionState, PairedClient, PendingPairing };
export type ConnectionKind = ConnectionState["state"];

export const getCompanionStatus = () => invoke<CompanionStatus>("companion_status");
export const startCompanion = () => invoke<CompanionStatus>("companion_start");
export const stopCompanion = () => invoke<CompanionStatus>("companion_stop");
export const respondToPairing = (pairingId: string, allow: boolean) =>
  invoke<CompanionStatus>("companion_respond", { pairingId, allow });
export const revokeClient = (clientId: string) => invoke<CompanionStatus>("companion_revoke", { clientId });
export const onCompanionStatus = (receive: (status: CompanionStatus) => void) =>
  listen<CompanionStatus>("companion:updated", (event) => receive(event.payload));

export const connectionLabel: Record<ConnectionKind, string> = {
  off: "Off", waiting: "Waiting for site", connected: "Connected", stale: "Not polling", error: "Error",
};

/** Dot colour class, as used by `.dot`. */
export const connectionTone: Record<ConnectionKind, string> = {
  off: "", waiting: "", connected: "ok", stale: "warn", error: "bad",
};

/** "Tarkov Hideout" for the production site, otherwise the origin's host. */
export function siteName(origin: string) {
  try {
    const { host } = new URL(origin);
    if (host === "tarkovhideout.com" || host === "www.tarkovhideout.com") return "Tarkov Hideout";
    if (host === "dev.tarkovhideout.com") return "Tarkov Hideout (dev)";
    if (host === "127.0.0.1:47690") return "Test page";
    return host;
  } catch {
    return origin;
  }
}
