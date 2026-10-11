import type { ReactNode } from "react";
import { ActivityIcon, ImportIcon, MapIcon, OverviewIcon, SettingsIcon, SidebarIcon, TimelineIcon } from "./Icons";

export type Page = "overview" | "map" | "timeline" | "activity" | "import" | "settings";

const items: { page: Page; label: string; icon: ReactNode }[] = [
  { page: "overview", label: "Overview", icon: <OverviewIcon /> },
  { page: "map", label: "Map", icon: <MapIcon /> },
  { page: "timeline", label: "Timeline", icon: <TimelineIcon /> },
  { page: "activity", label: "Activity", icon: <ActivityIcon /> },
  { page: "import", label: "Import", icon: <ImportIcon /> },
];

export function Sidebar({ page, onNavigate, collapsed, onToggle }: {
  page: Page; onNavigate: (page: Page) => void; collapsed: boolean; onToggle: () => void;
}) {
  const link = (item: { page: Page; label: string; icon: ReactNode }) =>
    <button key={item.page} type="button" className={`nav-item ${page === item.page ? "active" : ""}`}
      aria-current={page === item.page ? "page" : undefined} title={collapsed ? item.label : undefined}
      onClick={() => onNavigate(item.page)}>
      {item.icon}<span>{item.label}</span>
    </button>;

  return <nav className={`sidebar ${collapsed ? "collapsed" : ""}`} aria-label="Main">
    {items.map(link)}
    <div className="sidebar-spacer" />
    {link({ page: "settings", label: "Settings", icon: <SettingsIcon /> })}
    <button type="button" className="nav-item subtle" onClick={onToggle}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed}>
      <SidebarIcon /><span>Collapse</span>
    </button>
  </nav>;
}
