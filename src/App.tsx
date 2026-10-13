import { useEffect, useState } from "react";
import { useScanner } from "./lib/useScanner";
import { useImport } from "./lib/useImport";
import { MiniBar, TitleBar } from "./components/TitleBar";
import { useMiniMode } from "./lib/useMiniMode";
import { useAutoShot } from "./lib/useAutoShot";
import { useCompanion } from "./lib/useCompanion";
import { useShotCleanup } from "./lib/useShotCleanup";
import { useToastMode } from "./lib/useToastMode";
import { useValuableLoot } from "./lib/useValuableLoot";
import { useGameMode } from "./lib/useGameMode";
import { Sidebar, type Page } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { OverviewPage } from "./pages/OverviewPage";
import { MapPage } from "./pages/MapPage";
import { ActivityPage } from "./pages/ActivityPage";
import { TimelinePage } from "./pages/TimelinePage";
import { ImportPage } from "./pages/ImportPage";
import { SettingsPage } from "./pages/SettingsPage";

const COLLAPSED_KEY = "sidebar-collapsed";

export function App() {
  const scanner = useScanner();
  const mini = useMiniMode();
  const connection = useCompanion();
  const autoShot = useAutoShot();
  const shotCleanup = useShotCleanup();
  const toastMode = useToastMode();
  const valuableLoot = useValuableLoot();
  // App-level so an import keeps streaming while other pages are open.
  const importer = useImport();
  const [page, setPage] = useState<Page>("map");
  // A past raid opened from the timeline; the map shows it instead of the live raid until closed.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const viewing = scanner.raids.find((raid) => raid.id === viewingId) ?? null;
  const navigate = (next: Page) => { setViewingId(null); setPage(next); };
  // The mode comes from the raid on the map; a mode picked in the title bar lasts until a raid starts or another is opened.
  const live = scanner.snapshot?.raid;
  const gameMode = useGameMode(viewing ? viewing.game_mode : live?.game_mode, `${viewingId}|${live?.id}|${live?.started_at}`);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  useEffect(() => { localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"); }, [collapsed]);

  // State above this point survives mini mode, so leaving it returns to the same page.
  if (mini.view) return <MiniBar scanner={scanner} mini={mini} connection={connection} />;

  return <div className="shell">
    <TitleBar scanner={scanner} mini={mini} gameMode={gameMode} />
    <div className="body">
      <Sidebar page={page} onNavigate={navigate} collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} connection={connection} />
      <main className="content">
        {page === "overview" && <OverviewPage scanner={scanner} onNavigate={navigate} />}
        {page === "map" && <MapPage key={viewing?.id ?? "live"} scanner={scanner} viewing={viewing} onCloseViewing={() => setViewingId(null)} mode={gameMode.mode} valuableLoot={valuableLoot.on} />}
        {page === "timeline" && <TimelinePage scanner={scanner} onOpenRaid={(id) => { setViewingId(id); setPage("map"); }} />}
        {page === "activity" && <ActivityPage scanner={scanner} />}
        {page === "import" && <ImportPage scanner={scanner} importer={importer} onNavigate={navigate} />}
        {page === "settings" && <SettingsPage scanner={scanner} mini={mini} connection={connection} autoShot={autoShot} shotCleanup={shotCleanup} toastMode={toastMode} valuableLoot={valuableLoot} />}
      </main>
    </div>
    <Toasts events={scanner.snapshot?.activity} mode={toastMode.mode} />
  </div>;
}
