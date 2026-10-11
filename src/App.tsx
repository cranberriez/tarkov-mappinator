import { useEffect, useState } from "react";
import { useScanner } from "./lib/useScanner";
import { TitleBar } from "./components/TitleBar";
import { Sidebar, type Page } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { OverviewPage } from "./pages/OverviewPage";
import { MapPage } from "./pages/MapPage";
import { ActivityPage } from "./pages/ActivityPage";
import { SettingsPage } from "./pages/SettingsPage";

const COLLAPSED_KEY = "sidebar-collapsed";

export function App() {
  const scanner = useScanner();
  const [page, setPage] = useState<Page>("map");
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  useEffect(() => { localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"); }, [collapsed]);

  return <div className="shell">
    <TitleBar scanner={scanner} />
    <div className="body">
      <Sidebar page={page} onNavigate={setPage} collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />
      <main className="content">
        {page === "overview" && <OverviewPage scanner={scanner} onNavigate={setPage} />}
        {page === "map" && <MapPage scanner={scanner} />}
        {page === "activity" && <ActivityPage scanner={scanner} />}
        {page === "settings" && <SettingsPage scanner={scanner} />}
      </main>
    </div>
    <Toasts events={scanner.snapshot?.activity} />
  </div>;
}
