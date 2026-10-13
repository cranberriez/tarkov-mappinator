import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { isTauri } from "./scanner";
import { keys, load, save } from "./persist";

const MINI = { width: 320, height: 40 };
const FULL = { width: 1280, height: 820 };
const FULL_MIN = new LogicalSize(820, 560);
const DURATION_MS = 180;

type Point = { x: number; y: number };
/** Physical pixels: outer position, inner size. */
type Rect = Point & { width: number; height: number };
/** Windows' own restore rectangle for a maximized window; opaque to us, handed back to `maximize_with_restore`. */
type Restore = { left: number; top: number; right: number; bottom: number };
/** For a maximized window the rect is its maximized area, so leaving mini mode grows straight back to it. */
type Bounds = Rect & { maximized: boolean; restore?: Restore };

const animate = (to: Rect, durationMs = DURATION_MS) =>
  invoke("animate_window", { to: { x: Math.round(to.x), y: Math.round(to.y), width: Math.round(to.width), height: Math.round(to.height) }, durationMs });

async function currentRect(): Promise<Rect> {
  const win = getCurrentWindow();
  const [position, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

/** Shrinks the window to a fixed strip, remembering the full window's bounds to restore on exit. */
async function enterMini(rememberFull: boolean, animated: boolean) {
  const win = getCurrentWindow();
  if (rememberFull) {
    const restore = await invoke<Restore | null>("unmaximize_in_place");
    save(keys.fullBounds, { ...await currentRect(), maximized: !!restore, restore: restore ?? undefined } satisfies Bounds);
  }
  await win.setMaximizable(false);
  await win.setResizable(false);
  await win.setMinSize(new LogicalSize(MINI.width, MINI.height));
  const scale = await win.scaleFactor();
  const at = load<Point | null>(keys.miniPosition, null) ?? await currentRect();
  await animate({ x: at.x, y: at.y, width: MINI.width * scale, height: MINI.height * scale }, animated ? DURATION_MS : 0);
}

async function exitMini() {
  const win = getCurrentWindow();
  await rememberMiniPosition();
  const bounds = load<Bounds | null>(keys.fullBounds, null);
  await animate(bounds ?? await centered());
  await win.setMinSize(FULL_MIN);
  await win.setResizable(true);
  await win.setMaximizable(true);
  if (bounds?.restore) await invoke("maximize_with_restore", { restore: bounds.restore });
  else if (bounds?.maximized) await win.maximize();
}

/** Default full size in the middle of the current monitor, for a first launch straight into mini mode. */
async function centered(): Promise<Rect> {
  const scale = await getCurrentWindow().scaleFactor();
  const width = FULL.width * scale, height = FULL.height * scale;
  const monitor = await currentMonitor();
  if (!monitor) return { ...await currentRect(), width, height };
  return {
    x: monitor.position.x + (monitor.size.width - width) / 2,
    y: monitor.position.y + (monitor.size.height - height) / 2,
    width, height,
  };
}

async function rememberMiniPosition() {
  const position = await getCurrentWindow().outerPosition();
  save(keys.miniPosition, { x: position.x, y: position.y } satisfies Point);
}

/**
 * Mini mode: the same app in a small always-available strip. The window starts hidden (tauri.conf.json)
 * so launching straight into mini mode doesn't flash the full window first.
 *
 * `mini` is the requested mode, `view` what to render: entering shows the strip first and shrinks the
 * window around it; leaving grows the window first, then swaps the full UI in.
 */
export function useMiniMode() {
  const desktop = isTauri();
  const [startMini, setStartMini] = useState(() => load(keys.miniStartup, false));
  const [mini, setMiniState] = useState(startMini);
  const [view, setView] = useState(startMini);
  // Window calls are serialized so quick toggles can't interleave resizes.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const applied = useRef(startMini);

  useEffect(() => save(keys.miniStartup, startMini), [startMini]);

  // Launch: size the hidden window for the starting mode, then show it.
  useEffect(() => {
    if (!desktop) return;
    queue.current = queue.current
      .then(() => applied.current ? enterMini(false, false) : undefined)
      .catch((cause) => console.error("mini mode", cause))
      .finally(() => void getCurrentWindow().show());
  }, [desktop]);

  /** Resolves once the window has finished animating. */
  const setMini = useCallback((next: boolean): Promise<unknown> => {
    setMiniState(next);
    if (!desktop) { setView(next); return Promise.resolve(); }
    if (applied.current === next) return queue.current;
    applied.current = next;
    if (next) setView(true);
    queue.current = queue.current
      .then(() => next ? enterMini(true, true) : exitMini())
      .catch((cause) => console.error("mini mode", cause))
      .finally(() => { if (!next) setView(false); });
    return queue.current;
  }, [desktop]);

  const close = useCallback(() => {
    queue.current = queue.current
      .then(() => applied.current ? rememberMiniPosition() : undefined)
      .catch(() => {})
      .finally(() => void getCurrentWindow().close());
  }, []);

  return { desktop, mini, view, setMini, startMini, setStartMini, close };
}

export type MiniMode = ReturnType<typeof useMiniMode>;
