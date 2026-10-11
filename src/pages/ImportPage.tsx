import { memo, type CSSProperties } from "react";
import type { Scanner } from "../lib/useScanner";
import { previewSrc, type Importer, type ImportPhase, type ImportTile } from "../lib/useImport";
import { raidColor, raidStartFromId } from "../lib/raids";
import type { Page } from "../components/Sidebar";

const phaseLabel: Record<ImportPhase, string> = {
  idle: "", discovering: "Discovering files", reading_logs: "Reading logs", reading_screenshots: "Reading screenshots",
  ready: "Ready to import", importing: "Importing", imported: "Imported",
};
const running = (phase: ImportPhase) => phase === "discovering" || phase === "reading_logs" || phase === "reading_screenshots";

const sourceLabel: Record<string, string> = {
  application: "APP", backend: "BACK", output: "OUT", "push-notifications": "PUSH", notifications: "NOTE",
  errors: "ERR", traces: "TRC", hideout: "HIDE", ai: "AI", asserts: "ASRT",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

const tileColor = (tile: ImportTile) => {
  const start = tile.raid_id ? raidStartFromId(tile.raid_id) : null;
  return start ? raidColor({ started_at: start }) : undefined;
};

/** `stage` drives the import animation; "imported" pins the end state so the entrance animation never replays. */
const Tile = memo(function Tile({ tile, order, stage }: { tile: ImportTile; order: number; stage: "importing" | "imported" | null }) {
  const style = {
    "--raid": tileColor(tile),
    "--delay": `${Math.min(order * 8, 1000)}ms`,
  } as CSSProperties;
  const title = [tile.name, tile.group, tile.detail].filter(Boolean).join("\n");
  return <div className={`tile ${tile.kind} ${tile.status} ${stage && tile.status === "used" ? stage : ""}`} style={style} title={title}>
    {tile.kind === "screenshot"
      ? previewSrc(tile.path) && <img src={previewSrc(tile.path)} loading="lazy" decoding="async" alt="" draggable={false} />
      : <><span className="tile-source">{sourceLabel[tile.source ?? ""] ?? "LOG"}</span><span className="tile-size">{size(tile.size)}</span></>}
    {tile.raid_id && <span className="tile-raid" />}
  </div>;
});

function Panel({ title, tiles, stage, empty, found }: {
  title: string; tiles: ImportTile[]; stage: "importing" | "imported" | null; empty: string; found: string | null;
}) {
  const done = tiles.filter((tile) => tile.status !== "pending").length;
  const used = tiles.filter((tile) => tile.status === "used");
  let order = 0;
  return <section className="import-panel">
    <header>
      <h2>{title}</h2>
      {found && <span className="panel-found">{found}</span>}
      <span className="faint">{tiles.length ? `${done < tiles.length ? `${done}/` : ""}${tiles.length} files · ${used.length} used` : ""}</span>
    </header>
    <div className="import-progress"><span style={{ width: tiles.length ? `${done / tiles.length * 100}%` : 0 }} /></div>
    {tiles.length
      ? <div className="tile-grid">{tiles.map((tile) =>
        <Tile key={tile.id} tile={tile} stage={stage} order={tile.status === "used" ? order++ : 0} />)}</div>
      : <p className="faint import-empty">{empty}</p>}
  </section>;
}

export function ImportPage({ scanner, importer, onNavigate }: { scanner: Scanner; importer: Importer; onNavigate: (page: Page) => void }) {
  const { phase, files, result, error, desktop, scan, cancel, commit } = importer;
  const config = scanner.snapshot?.config;
  const configured = !!config && (!!config.logs || !!config.screenshots);
  const shots = files.filter((file) => file.kind === "screenshot");
  const logs = files.filter((file) => file.kind === "log");
  const busy = running(phase);
  const stage = phase === "importing" || phase === "imported" ? phase : null;
  const hasData = !!result && (result.raids.length > 0 || result.positions.length > 0);

  return <div className="import-page">
    <header className="import-header">
      <h1>Import</h1>
      <span className={`import-phase ${phase}`}>{phaseLabel[phase]}</span>
      {result?.cancelled && <span className="faint">Cancelled · partial results</span>}
      <div className="import-actions">
        {phase === "imported" && <button type="button" className="link" onClick={() => onNavigate("timeline")}>Open timeline</button>}
        {busy
          ? <button type="button" className="secondary" onClick={cancel}>Cancel</button>
          : <button type="button" className="secondary" disabled={!desktop || !configured || phase === "importing"}
            onClick={() => config && void scan(config)}>{phase === "idle" ? "Scan" : "Rescan"}</button>}
        {(phase === "ready" || phase === "importing") && <button type="button" className="primary" disabled={!hasData || phase === "importing"} onClick={commit}>
          {phase === "importing" ? "Importing…" : "Import"}</button>}
      </div>
    </header>
    {error && <div className="error" role="alert">{error}</div>}
    {!desktop && <p className="faint">Import reads local files and needs the desktop app.</p>}
    {desktop && !configured && <p className="faint">Set the source folders in <button type="button" className="link" onClick={() => onNavigate("settings")}>Settings</button> first.</p>}

    <div className={`import-panels ${phase === "importing" ? "importing" : ""}`}>
      <Panel title="Screenshots" tiles={shots} stage={stage}
        found={result ? `${plural(result.positions.length, "position")}${result.unmatched_screenshots ? ` · ${result.unmatched_screenshots} outside raids` : ""}` : null} empty={phase === "idle" ? "Scan to discover screenshots." : "No screenshots found."} />
      <Panel title="Logs" tiles={logs} stage={stage}
        found={result ? plural(result.raids.length, "raid") : null} empty={phase === "idle" ? "Scan to discover log files." : "No log files found."} />
    </div>
  </div>;
}
