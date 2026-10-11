import { useEffect, useRef, useState } from "react";
import type { Scanner } from "../lib/useScanner";
import type { FolderConfig } from "../bindings/FolderConfig";
import type { SourceHealth } from "../bindings/SourceHealth";
import { LogCoveragePanel } from "../components/LogCoveragePanel";

const statusLabel: Record<SourceHealth["status"], string> = {
  not_configured: "Not set", available: "Accessible", missing: "Missing", not_directory: "Not a folder", unreadable: "No access",
};

function FolderField({ id, label, value, health, disabled, placeholder, onChange }: {
  id: string; label: string; value: string; health?: SourceHealth; disabled: boolean; placeholder: string;
  onChange: (value: string) => void;
}) {
  const ok = health?.status === "available";
  return <div className="field">
    <div className="field-label">
      <label htmlFor={id}>{label}</label>
      <span className={`status ${ok ? "ok" : health && health.status !== "not_configured" ? "bad" : ""}`}>
        <span className="dot" />{health ? statusLabel[health.status] : "Unknown"}</span>
    </div>
    <input id={id} value={value} placeholder={placeholder} spellCheck={false} disabled={disabled}
      onChange={(event) => onChange(event.target.value)} />
    {health && !ok && <p className="faint">{health.detail}</p>}
  </div>;
}

export function SettingsPage({ scanner }: { scanner: Scanner }) {
  const { snapshot, running, connected, busy, error, perform, retry } = scanner;
  const [folders, setFolders] = useState<FolderConfig>({ screenshots: "", logs: "" });
  const edited = useRef(false);
  useEffect(() => { if (snapshot && !edited.current) setFolders(snapshot.config); }, [snapshot]);
  const locked = !connected || !!busy || running;
  const update = (patch: Partial<FolderConfig>) => { edited.current = true; setFolders((current) => ({ ...current, ...patch })); };

  return <div className="page">
    <header className="page-header"><h1>Settings</h1></header>
    {error && <div className="error" role="alert">{error}
      {!connected && <button type="button" className="link" onClick={retry}>Retry</button>}</div>}

    <section className="settings-section">
      <h2>Sources</h2>
      <form onSubmit={(event) => { event.preventDefault(); edited.current = false; void perform("check", folders); }}>
        <FolderField id="screenshots" label="Screenshots" value={folders.screenshots} health={snapshot?.screenshots}
          disabled={locked} placeholder="Absolute path to the screenshot folder" onChange={(screenshots) => update({ screenshots })} />
        <FolderField id="logs" label="Game logs" value={folders.logs} health={snapshot?.logs}
          disabled={locked} placeholder="Tarkov installation Logs folder" onChange={(logs) => update({ logs })} />
        <div className="form-actions">
          <button type="submit" className="secondary" disabled={locked}>{busy === "check" ? "Checking…" : "Check folders"}</button>
          {running && <span className="faint">Stop monitoring to edit.</span>}
        </div>
      </form>
    </section>

    <section className="settings-section">
      <h2>Scanner health</h2>
      <div className="stats compact">
        <div className="stat"><span>Screenshots seen</span><strong>{snapshot?.screenshots_seen ?? "—"}</strong></div>
        <div className="stat"><span>Rejected</span><strong>{snapshot?.screenshots_rejected ?? "—"}</strong></div>
        <div className="stat"><span>Revision</span><strong>{snapshot?.revision ?? "—"}</strong></div>
      </div>
      {snapshot?.diagnostics.length
        ? <ul className="diagnostics">{snapshot.diagnostics.map((detail, index) => <li key={index}>{detail}</li>)}</ul>
        : <p className="faint">{snapshot ? "No issues reported." : "Backend not connected."}</p>}
    </section>

    <section className="settings-section">
      <h2>Log coverage</h2>
      <LogCoveragePanel snapshot={snapshot} />
    </section>
  </div>;
}
