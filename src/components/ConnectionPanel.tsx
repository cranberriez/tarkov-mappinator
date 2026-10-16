import type { CompanionConnection } from "../lib/useCompanion";
import { connectedClients, connectionLabel, connectionTone, siteName, type PairedClient } from "../lib/companion";
import { age } from "../lib/format";
import { useNow } from "../lib/useNow";
import { SettingsIcon } from "./Icons";

const ago = (value: string | null, now: number) => value ? `${age(value, now)} ago` : null;

/** One line under the status: what the state means right now. */
export function connectionDetail(connection: CompanionConnection): string | null {
  const { status } = connection;
  if (!status) return null;
  const state = status.connection;
  switch (state.state) {
    case "off": return null;
    case "error": return state.reason;
    case "waiting": return status.clients.length ? "Open the site to connect." : "No sites paired. Connect from the site.";
    // The status label says Connected / Not polling; "seen X ago" lives on the site row.
    case "connected":
    case "stale": return null;
  }
}

export function PendingPrompts({ connection }: { connection: CompanionConnection }) {
  const pending = connection.status?.pending ?? [];
  if (!connection.enabled || !pending.length) return null;
  return <>{pending.map((request) => <div key={request.id} className="pairing-prompt" role="alert">
    <span><strong title={request.origin}>{siteName(request.origin)}</strong> wants to connect</span>
    <span className="pairing-actions">
      <button type="button" className="primary" onClick={() => void connection.respond(request.id, true)}>Allow</button>
      <button type="button" className="secondary" onClick={() => void connection.respond(request.id, false)}>Deny</button>
    </span>
  </div>)}</>;
}

const ALLOW_AGAIN = "Lets this site ask to pair again. You still approve it.";

/**
 * `all` lists every paired and revoked site (Settings); `attempting` only the currently connected sites, plus
 * revoked ones blocked while trying to connect, as prompts.
 */
export function ClientList({ connection, now, revoked: mode }: { connection: CompanionConnection; now: number; revoked: "all" | "attempting" }) {
  const clients: PairedClient[] = mode === "all" ? connection.status?.clients ?? [] : connectedClients(connection.status, now);
  const allRevoked = connection.status?.revoked ?? [];
  const revoked = mode === "all" ? allRevoked : allRevoked.filter((site) => site.attempted_at);
  // The status line already says when nothing is paired.
  if (!clients.length && !revoked.length) return null;
  return <>
    {!!clients.length && <ul className="client-list">{clients.map((client) => <li key={client.id}>
      <span className="client-name">{siteName(client.origin)}
        <span className="faint">{client.last_seen ? `seen ${ago(client.last_seen, now)}` : "never polled"}</span></span>
      <button type="button" className="link danger" onClick={() => void connection.revoke(client.id)}
        title={`Revoke ${client.origin}; it must pair again`}>Revoke</button>
    </li>)}</ul>}
    {mode === "attempting" && revoked.map((site) => <div key={site.origin} className="pairing-prompt" role="alert">
      <span><strong title={site.origin}>{siteName(site.origin)}</strong> was blocked (access revoked)</span>
      <span className="pairing-actions">
        <button type="button" className="primary" onClick={() => void connection.allowSite(site.origin)}
          title={ALLOW_AGAIN}>Allow</button>
      </span>
    </div>)}
    {mode === "all" && !!revoked.length && <>
      <h3 className="client-subhead">Revoked</h3>
      <ul className="client-list">{revoked.map((site) => <li key={site.origin}>
        <span className="client-name" title={site.origin}>{siteName(site.origin)}
          <span className="faint">revoked {ago(site.revoked_at, now)}</span></span>
        <button type="button" className="link" onClick={() => void connection.allowSite(site.origin)}
          title={ALLOW_AGAIN}>Allow</button>
      </li>)}</ul>
    </>}
  </>;
}

/** Opens upward in the sidebar, above the Connection item: status, pending requests and paired sites. */
export function ConnectionPanel({ connection, open, onOpenSettings }: { connection: CompanionConnection; open: boolean; onOpenSettings: () => void }) {
  const now = useNow();
  const kind = connection.connection;
  const detail = connectionDetail(connection);

  return <div id="connection-panel" className={`connection-panel ${open ? "open" : ""}`} inert={!open}>
    <div className="connection-panel-body">
      <div className="connection-head">
        <span className={`status ${kind === "error" ? "bad" : ""}`}><span className={`dot ${connectionTone[kind]}`} />
          <strong>{connectionLabel[kind]}</strong></span>
        <button type="button" className="icon-button" aria-label="Site connection settings" title="Site connection settings"
          onClick={onOpenSettings}><SettingsIcon /></button>
      </div>
      {detail && <p className={kind === "error" ? "bad-text" : "faint"}>{detail}</p>}
      {kind === "error" && <button type="button" className="link" onClick={() => void connection.retry()}>Retry</button>}
      <PendingPrompts connection={connection} />
      <ClientList connection={connection} now={now} revoked="attempting" />
    </div>
  </div>;
}
