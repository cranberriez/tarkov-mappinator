import { useEffect, useState, type ReactNode } from "react";
import { ActivityIcon, GroupIcon, ImportIcon, LinkIcon, MapIcon, OverviewIcon, SettingsIcon, SidebarIcon, TimelineIcon } from "./Icons";
import type { CompanionConnection } from "../lib/useCompanion";
import { connectionLabel, connectionTone } from "../lib/companion";
import { ConnectionPanel } from "./ConnectionPanel";

export type Page = "overview" | "map" | "timeline" | "activity" | "import" | "group" | "settings";

const items: { page: Page; label: string; icon: ReactNode }[] = [
  { page: "overview", label: "Overview", icon: <OverviewIcon /> },
  { page: "map", label: "Map", icon: <MapIcon /> },
  { page: "timeline", label: "Timeline", icon: <TimelineIcon /> },
  { page: "activity", label: "Activity", icon: <ActivityIcon /> },
  { page: "import", label: "Import", icon: <ImportIcon /> },
];

export function Sidebar({ page, onNavigate, collapsed, onToggle, connection, group }: {
  page: Page; onNavigate: (page: Page) => void; collapsed: boolean; onToggle: () => void; connection: CompanionConnection;
  /** The Group item's dot while in a group (or trying to be); null otherwise. */
  group: { tone: "ok" | "warn" | "bad"; label: string } | null;
}) {
  const [panel, setPanel] = useState(false);
  const kind = connection.connection;
  const pending = !!connection.status?.pending.length || !!connection.status?.revoked.some((site) => site.attempted_at);
  // A new pairing request opens the panel so Allow/Deny is right there.
  useEffect(() => { if (pending && !collapsed) setPanel(true); }, [pending, collapsed]);
  const link = (item: { page: Page; label: string; icon: ReactNode }) =>
    <button key={item.page} type="button" className={`nav-item ${page === item.page ? "active" : ""}`}
      aria-current={page === item.page ? "page" : undefined} title={collapsed ? item.label : undefined}
      onClick={() => onNavigate(item.page)}>
      {item.icon}<span>{item.label}</span>
    </button>;

  return <nav className={`sidebar ${collapsed ? "collapsed" : ""}`} aria-label="Main">
    {items.map(link)}
    <button type="button" className={`nav-item ${page === "group" ? "active" : ""}`} aria-current={page === "group" ? "page" : undefined}
      title={collapsed ? `Group${group ? `: ${group.label}` : ""}` : undefined} onClick={() => onNavigate("group")}>
      <span className="nav-icon"><GroupIcon />{group && <span className={`dot ${group.tone}`} />}</span><span>Group</span>
    </button>
    <div className="sidebar-spacer" />
    {connection.enabled && <>
      <ConnectionPanel connection={connection} open={panel && !collapsed} />
      <button type="button" className={`nav-item ${panel && !collapsed ? "active" : ""} ${pending ? "attention" : ""}`}
        aria-expanded={panel && !collapsed} aria-controls="connection-panel"
        title={collapsed ? `Connection: ${pending ? "request waiting" : connectionLabel[kind]}` : undefined}
        onClick={() => {
          // Collapsed, there's no room for the panel: expand the sidebar to show it.
          if (collapsed) { onToggle(); setPanel(true); } else setPanel((open) => !open);
        }}>
        <span className="nav-icon"><LinkIcon /><span className={`dot ${pending ? "warn pulse" : connectionTone[kind]}`} /></span>
        <span>Connection</span>
      </button>
    </>}
    {link({ page: "settings", label: "Settings", icon: <SettingsIcon /> })}
    <button type="button" className="nav-item subtle" onClick={onToggle}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed}>
      <SidebarIcon /><span>Collapse</span>
    </button>
  </nav>;
}
