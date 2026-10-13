import type { CompanionConnection } from "../lib/useCompanion";
import { connectionLabel, connectionTone, siteName, type PairedClient } from "../lib/companion";
import { age } from "../lib/format";
import { useNow } from "../lib/useNow";

const ago = (value: string | null, now: number) => value ? `${age(value, now)} ago` : null;

/** One line under the status: what the state means right now. */
export function connectionDetail(connection: CompanionConnection, now: number): string | null {
  const { status } = connection;
  if (!status) return null;
  const state = status.connection;
  switch (state.state) {
    case "off": return null;
    case "error": return state.reason;
    case "waiting": return status.clients.length ? "Open the site to connect." : "No sites paired. Connect from the site.";
    case "connected": return `Last poll ${ago(status.last_poll, now)}`;
    case "stale": return `Last seen ${ago(status.last_poll, now)}`;
  }
}

export function PendingPrompts({ connection }: { connection: CompanionConnection }) {
  const pending = connection.status?.pending ?? [];
  if (!connection.enabled || !pending.length) return null;
  return <>{pending.map((request) => <div key={request.id} className="pairing-prompt" role="alert">
    <span><strong>{siteName(request.origin)}</strong> wants to connect
      <span className="faint">{request.origin}</span></span>
    <span className="pairing-actions">
      <button type="button" className="primary" onClick={() => void connection.respond(request.id, true)}>Allow</button>
      <button type="button" className="secondary" onClick={() => void connection.respond(request.id, false)}>Deny</button>
    </span>
  </div>)}</>;
}

export function ClientList({ connection, now }: { connection: CompanionConnection; now: number }) {
  const clients: PairedClient[] = connection.status?.clients ?? [];
  // The status line already says when nothing is paired.
  if (!clients.length) return null;
  return <ul className="client-list">{clients.map((client) => <li key={client.id}>
    <span className="client-name">{siteName(client.origin)}
      <span className="faint">{client.last_seen ? `seen ${ago(client.last_seen, now)}` : "never polled"}</span></span>
    <button type="button" className="link danger" onClick={() => void connection.revoke(client.id)}
      title={`Revoke ${client.origin}; it must pair again`}>Revoke</button>
  </li>)}</ul>;
}

/** Opens upward in the sidebar, above the Connection item: status, pending requests and paired sites. */
export function ConnectionPanel({ connection, open }: { connection: CompanionConnection; open: boolean }) {
  const now = useNow();
  const kind = connection.connection;
  const detail = connectionDetail(connection, now);

  return <div id="connection-panel" className={`connection-panel ${open ? "open" : ""}`} inert={!open}>
    <div className="connection-panel-body">
      <div className="connection-head">
        <span className={`status ${kind === "error" ? "bad" : ""}`}><span className={`dot ${connectionTone[kind]}`} />
          <strong>{connectionLabel[kind]}</strong></span>
        {connection.status?.port && <span className="faint">:{connection.status.port}</span>}
      </div>
      {detail && <p className={kind === "error" ? "bad-text" : "faint"}>{detail}</p>}
      {kind === "error" && <button type="button" className="link" onClick={() => void connection.retry()}>Retry</button>}
      <PendingPrompts connection={connection} />
      <ClientList connection={connection} now={now} />
    </div>
  </div>;
}
