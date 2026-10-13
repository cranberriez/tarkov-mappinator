// tarkov.dev item data, mirrored locally by the backend (`src-tauri/src/item_data.rs`). Every item read goes through here.
// Enrichment is opt-in: while it is off or not yet downloaded, lookups report why instead of returning items.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { ItemConfig } from "../bindings/ItemConfig";
import type { ItemStatus } from "../bindings/ItemStatus";
import type { DataMode } from "../tarkov-data/mode";
import type { MapMarker } from "../maps";

export type { ItemConfig, ItemStatus };

type Price = { trader: string; priceRUB: number; [key: string]: unknown };
/** Prices are in roubles. Only the core fields are always present; the rest depend on which pieces are downloaded. */
export type Item = {
  id: string; name: string; shortName: string; normalizedName: string; description?: string | null; types: string[];
  width: number; height: number; weight: number; basePrice: number; backgroundColor: string;
  avg24hPrice?: number | null; lastLowPrice?: number | null; low24hPrice?: number | null; high24hPrice?: number | null;
  changeLast48h?: number | null; changeLast48hPercent?: number | null; lastOfferCount?: number | null;
  sellToTrader?: Price[] | null; buyFromTrader?: Price[] | null;
  properties?: Record<string, unknown> | null; categories?: unknown[] | null; containsItems?: unknown[] | null;
  wikiLink?: string | null; link?: string | null;
  [key: string]: unknown;
};

export type ItemGet = (id: string) => Item | undefined;
export type ItemLookup =
  | { ok: true; get: ItemGet; tables: Record<string, unknown> }
  | { ok: false; reason: "disabled" | "unavailable" | "loading" | "error"; message: string };

export const getItemStatus = () => invoke<ItemStatus>("item_data_status");
export const configureItemData = (config: ItemConfig) => invoke<ItemStatus>("item_data_configure", { config });
/** Starts a check now when enabled; progress arrives through `onItemStatus`. */
export const syncItemData = () => invoke<void>("item_data_sync");
/** Deletes the stored items and keeps the configuration. */
export const clearItemData = () => invoke<ItemStatus>("item_data_clear");
export const onItemStatus = (receive: (status: ItemStatus) => void) =>
  listen<ItemStatus>("item-data:updated", (event) => receive(event.payload));

/** Live item data status; null outside the desktop app or before the first reply. */
export function useItemStatus(): ItemStatus | null {
  const [status, setStatus] = useState<ItemStatus | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const stop = onItemStatus((next) => { if (live) setStatus(next); });
    getItemStatus().then((next) => { if (live) setStatus(next); }, () => {});
    return () => { live = false; void stop.then((unlisten) => unlisten()); };
  }, []);
  return status;
}

type Shared = { items: Record<string, Item>; tables: Record<string, unknown> };
type Diff = Record<string, Record<string, unknown>>;

const sharedCache = new Map<string, Promise<Shared>>();
const lookupCache = new Map<string, Promise<ItemLookup>>();

const loading: ItemLookup = { ok: false, reason: "loading", message: "Loading item data" };
const unavailable: ItemLookup = { ok: false, reason: "unavailable", message: "Item data is only available in the desktop app" };
const disabled: ItemLookup = { ok: false, reason: "disabled", message: "Item enrichment is off" };

const failure = (cause: unknown): ItemLookup => {
  const message = String(cause);
  return { ok: false, reason: message.startsWith("disabled:") ? "disabled" : message.startsWith("unavailable:") ? "unavailable" : "error", message };
};

/** The shared item with the mode's differences applied; a null difference removes the field. */
function merge(shared: Item | undefined, diff: Record<string, unknown> | undefined): Item | undefined {
  if (!diff) return shared;
  const merged: Record<string, unknown> = { ...shared, ...diff };
  for (const key in diff) if (diff[key] === null) delete merged[key];
  return merged as Item;
}

function load(fetchedAt: string, mode: DataMode): Promise<ItemLookup> {
  const key = `${fetchedAt}|${mode}`;
  let pending = lookupCache.get(key);
  if (pending) return pending;
  let shared = sharedCache.get(fetchedAt);
  if (!shared) {
    // Only the newest download is kept.
    sharedCache.clear();
    lookupCache.clear();
    shared = invoke<Shared>("item_data_shared");
    shared.catch(() => sharedCache.delete(fetchedAt));
    sharedCache.set(fetchedAt, shared);
  }
  pending = Promise.all([shared, invoke<Diff>("item_data_mode", { mode })]).then(([{ items, tables }, diff]): ItemLookup => {
    const merged = new Map<string, Item | undefined>();
    const get: ItemGet = (id) => {
      if (!merged.has(id)) merged.set(id, merge(items[id], diff[id]));
      return merged.get(id);
    };
    return { ok: true, get, tables };
  });
  pending.catch(() => lookupCache.delete(key));
  lookupCache.set(key, pending);
  return pending;
}

/**
 * Item lookup for a mode. Reloads when a new download lands or enrichment is switched on or off; the result is
 * referentially stable in between, so it is safe in dependency lists.
 */
export function useItemData(mode: DataMode): ItemLookup {
  const status = useItemStatus();
  const enabled = status?.config.enabled, fetchedAt = status?.fetched_at;
  const desktop = isTauri(), ready = !!status;
  const [lookup, setLookup] = useState<ItemLookup>(loading);
  useEffect(() => {
    if (!desktop || !ready || !enabled || !fetchedAt) return;
    setLookup(loading);
    let live = true;
    load(fetchedAt, mode).then((next) => { if (live) setLookup(next); }, (cause) => { if (live) setLookup(failure(cause)); });
    return () => { live = false; };
  }, [desktop, ready, enabled, fetchedAt, mode]);
  if (!desktop) return unavailable;
  if (!status) return loading;
  if (!enabled) return disabled;
  if (!fetchedAt) return { ok: false, reason: "unavailable", message: "Item data is not downloaded yet" };
  return lookup;
}

/** What an item is worth in roubles: the first positive of its 24h average, last low, best trader and base price. */
export const itemValue = (item: Item | undefined): number => {
  const trader = Math.max(0, ...item?.sellToTrader?.map((offer) => offer.priceRUB) ?? []);
  return [item?.avg24hPrice, item?.lastLowPrice, trader, item?.basePrice].find((price) => typeof price === "number" && price > 0) ?? 0;
};

export const formatRoubles = (roubles: number) => `${roubles.toLocaleString("en-US")} ₽`;

/** The most valuable possible item of each loose loot marker, by marker id; markers with no priced item are left out. */
export function bestLooseItems(markers: MapMarker[], get: ItemGet): Map<string, string> {
  const best = new Map<string, string>();
  for (const marker of markers) {
    if (marker.layer !== "loose") continue;
    let top = 0, topId: string | undefined;
    for (const { id } of marker.details?.find((row) => row.label === "Possible items")?.items ?? []) {
      const value = itemValue(get(id));
      if (value > top) { top = value; topId = id; }
    }
    if (topId) best.set(marker.id, topId);
  }
  return best;
}
