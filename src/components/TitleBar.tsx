import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Scanner } from "../lib/useScanner";
import { lifecycleLabel } from "../lib/format";
import { mapName } from "../maps";
import { PlayIcon, StopIcon, WindowClose, WindowMaximize, WindowMinimize } from "./Icons";

const appWindow = () => getCurrentWindow();

export function TitleBar({ scanner }: { scanner: Scanner }) {
  const { snapshot, running, busy, connected, desktop, perform } = scanner;
  const raid = snapshot?.raid;
  const live = running && raid?.lifecycle === "active";
  const raidText = raid && raid.lifecycle !== "unknown"
    ? [mapName(raid.map), lifecycleLabel[raid.lifecycle] ?? raid.lifecycle].filter(Boolean).join(" · ")
    : null;

  return <div className="titlebar" data-tauri-drag-region>
    <div className="titlebar-brand" data-tauri-drag-region>
      <span className="brand-mark" aria-hidden="true" />
      <span data-tauri-drag-region>Mappinator</span>
    </div>
    <div className="titlebar-center" data-tauri-drag-region>
      {raidText && <span className={`raid-pill ${live ? "live" : ""}`} data-tauri-drag-region>
        <span className="dot" />{raidText}</span>}
    </div>
    <div className="titlebar-actions">
      <button type="button" className={`scan-toggle ${running ? "on" : ""}`} disabled={!connected || !!busy}
        onClick={() => void perform(running ? "stop" : "start")}
        title={running ? "Stop monitoring" : "Start monitoring"}>
        {running ? <StopIcon /> : <PlayIcon />}
        {busy === "start" ? "Starting" : busy === "stop" ? "Stopping" : running ? "Monitoring" : "Start"}
      </button>
      {desktop && <div className="window-controls">
        <button type="button" aria-label="Minimize" onClick={() => void appWindow().minimize()}><WindowMinimize /></button>
        <button type="button" aria-label="Maximize" onClick={() => void appWindow().toggleMaximize()}><WindowMaximize /></button>
        <button type="button" aria-label="Close" className="close" onClick={() => void appWindow().close()}><WindowClose /></button>
      </div>}
    </div>
  </div>;
}
