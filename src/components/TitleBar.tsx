import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Scanner } from "../lib/useScanner";
import type { MiniMode } from "../lib/useMiniMode";
import { lifecycleLabel } from "../lib/format";
import { mapName } from "../maps";
import type { CompanionConnection } from "../lib/useCompanion";
import { connectedClients, connectionLabel, connectionTone, siteName } from "../lib/companion";
import { connectionDetail } from "./ConnectionPanel";
import { age } from "../lib/format";
import { useNow } from "../lib/useNow";
import { gameModes, type GameMode } from "../lib/useGameMode";
import { modeChip } from "./ModeChip";
import { CaretIcon, CheckIcon, ExpandIcon, LinkIcon, PlayIcon, ResetIcon, StopIcon, WindowClose, WindowMaximize, WindowMinimize } from "./Icons";

const appWindow = () => getCurrentWindow();

/** Logical px of the mini strip's connection row: padding plus one line per entry. */
const MINI_INFO_PAD = 10;
const MINI_INFO_LINE = 18;

function raidSummary(scanner: Scanner) {
  const raid = scanner.snapshot?.raid;
  return {
    live: scanner.running && raid?.lifecycle === "active",
    text: raid && raid.lifecycle !== "unknown"
      ? [mapName(raid.map), lifecycleLabel[raid.lifecycle] ?? raid.lifecycle].filter(Boolean).join(" · ")
      : null,
  };
}

export function TitleBar({ scanner, mini, gameMode }: { scanner: Scanner; mini: MiniMode; gameMode: GameMode }) {
  const { running, busy, connected, desktop, perform } = scanner;
  const { live, text: raidText } = raidSummary(scanner);
  const [menu, setMenu] = useState(false);

  return <div className="titlebar" data-tauri-drag-region>
    <div className="titlebar-brand" data-tauri-drag-region>
      <span className="brand-mark" aria-hidden="true" />
      <span data-tauri-drag-region>Mappinator</span>
      <ModePicker gameMode={gameMode} />
    </div>
    <div className="titlebar-center" data-tauri-drag-region>
      {raidText && <span className={`raid-pill ${live ? "live" : ""}`} data-tauri-drag-region>
        <span className="dot" />{raidText}</span>}
    </div>
    <div className="titlebar-actions">
      <div className={`scan-split ${running ? "on" : ""}`}>
        <button type="button" className={`scan-toggle ${running ? "on" : ""}`} disabled={!connected || !!busy}
          onClick={() => void perform(running ? "stop" : "start")}
          title={running ? "Stop monitoring" : "Start monitoring"}>
          {running ? <StopIcon /> : <PlayIcon />}
          {busy === "start" ? "Starting" : busy === "stop" ? "Stopping" : running ? "Monitoring" : "Start"}
        </button>
        {desktop && <button type="button" className="scan-more" aria-label="More start options" aria-haspopup="menu"
          aria-expanded={menu} onClick={() => setMenu((open) => !open)}><CaretIcon /></button>}
        {menu && <StartMenu onClose={() => setMenu(false)}>
          {running
            ? <button type="button" role="menuitem" onClick={() => { setMenu(false); void mini.setMini(true); }}>Switch to mini mode</button>
            : <button type="button" role="menuitem" disabled={!connected || !!busy}
              onClick={() => {
                // Start after the animation so reading recent logs doesn't compete with it.
                setMenu(false); void mini.setMini(true).then(() => perform("start"));
              }}>Start in mini mode</button>}
        </StartMenu>}
      </div>
      {desktop && <div className="window-controls">
        <button type="button" aria-label="Minimize" onClick={() => void appWindow().minimize()}><WindowMinimize /></button>
        <button type="button" aria-label="Maximize" onClick={() => void appWindow().toggleMaximize()}><WindowMaximize /></button>
        <button type="button" aria-label="Close" className="close" onClick={mini.close}><WindowClose /></button>
      </div>}
    </div>
  </div>;
}

/** The map's game mode; picking another shows that mode's data until a raid starts or one is opened. */
function ModePicker({ gameMode }: { gameMode: GameMode }) {
  const { mode, inferred, pick } = gameMode;
  const [open, setOpen] = useState(false);
  const chip = modeChip(mode)!;
  const logLabel = modeChip(inferred)!.label;
  return <div className="mode-picker">
    <button type="button" className={`mode-chip ${chip.tone}`} title={mode === inferred ? "Game mode from logs" : "Game mode picked"}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{chip.label}</button>
    {mode !== inferred && <button type="button" className="mode-reset" aria-label={`Back to ${logLabel} from logs`}
      title={`Back to ${logLabel} from logs`} onClick={() => pick(inferred)}><ResetIcon /></button>}
    {open && <StartMenu className="mode-menu" onClose={() => setOpen(false)}>
      {gameModes.map((option) => <button key={option} type="button" role="menuitemradio" aria-checked={option === mode}
        className={option === mode ? "selected" : ""} onClick={() => { setOpen(false); pick(option); }}>
        {modeChip(option)!.label}{option === inferred && <span className="faint">from logs</span>}
      </button>)}
    </StartMenu>}
  </div>;
}

function StartMenu({ className = "start-menu", onClose, children }: { className?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      // The caret toggles the menu itself.
      if (!ref.current?.parentElement?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);
  return <div ref={ref} className={`context-menu ${className}`} role="menu">{children}</div>;
}

/** The whole window in mini mode: drag anywhere that isn't a button. */
export function MiniBar({ scanner, mini, connection }: { scanner: Scanner; mini: MiniMode; connection: CompanionConnection }) {
  const { running, busy, connected, error, perform } = scanner;
  const { live, text } = raidSummary(scanner);
  const status = error ? "Error" : busy === "start" ? "Starting" : busy === "stop" ? "Stopping"
    : text ?? (running ? "Monitoring" : "Stopped");
  const request = connection.enabled ? connection.status?.pending[0] : undefined;
  const kind = connection.connection;
  const now = useNow();
  const [info, setInfo] = useState(false);
  const sites = connectedClients(connection.status, now);
  const detail = connectionDetail(connection);
  const infoOpen = info && connection.enabled;
  const infoHeight = MINI_INFO_PAD + MINI_INFO_LINE * (1 + sites.length);
  const { setExtraHeight } = mini;
  useEffect(() => setExtraHeight(infoOpen ? infoHeight : 0), [infoOpen, infoHeight, setExtraHeight]);

  return <div className="mini-shell">
    {infoOpen && <div className="mini-info" data-tauri-drag-region>
      <span className={kind === "error" ? "bad-text" : ""}><span className={`dot ${connectionTone[kind]}`} />
        {connectionLabel[kind]}{detail && <span className="faint"> · {detail}</span>}</span>
      {sites.map((client) => <span key={client.id} className="faint" title={client.origin}>
        {siteName(client.origin)} · seen {age(client.last_seen!, now)} ago</span>)}
    </div>}
    <div className="mini" data-tauri-drag-region>
    <span className="brand-mark" aria-hidden="true" data-tauri-drag-region />
    {request
      // A pairing request takes over the status text until answered.
      ? <span className="mini-status attention" role="alert" title={request.origin}>
        <span className="dot warn pulse" />{siteName(request.origin)} wants to connect</span>
      : <span className={`mini-status ${live ? "live" : running ? "running" : ""} ${error ? "bad" : ""}`}
        title={error ?? undefined} data-tauri-drag-region><span className="dot" data-tauri-drag-region />{status}</span>}
    {request && <>
      <button type="button" className="mini-button allow" aria-label="Allow" title={`Allow ${request.origin}`}
        onClick={() => void connection.respond(request.id, true)}><CheckIcon /></button>
      <button type="button" className="mini-button deny" aria-label="Deny" title="Deny"
        onClick={() => void connection.respond(request.id, false)}><WindowClose /></button>
    </>}
    {connection.enabled && !request && <button type="button" className={`mini-connection ${connectionTone[kind]} ${infoOpen ? "active" : ""}`}
      aria-expanded={infoOpen} aria-label={`Site connection: ${connectionLabel[kind]}`}
      title={`Site connection: ${connectionLabel[kind]}`} onClick={() => setInfo((open) => !open)}><LinkIcon /></button>}
    <button type="button" className={`mini-button ${running ? "on" : "start"}`} disabled={!connected || !!busy}
      aria-label={running ? "Stop monitoring" : "Start monitoring"} title={running ? "Stop monitoring" : "Start monitoring"}
      onClick={() => void perform(running ? "stop" : "start")}>{running ? <StopIcon /> : <PlayIcon />}</button>
    <button type="button" className="mini-button" aria-label="Minimize" title="Minimize"
      onClick={() => void appWindow().minimize()}><WindowMinimize /></button>
    <button type="button" className="mini-button" aria-label="Exit mini mode" title="Exit mini mode"
      onClick={() => void mini.setMini(false)}><ExpandIcon /></button>
    <button type="button" className="mini-button close" aria-label="Close" title="Close" onClick={mini.close}><WindowClose /></button>
    </div>
  </div>;
}
