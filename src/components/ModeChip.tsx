/** Session modes seen in logs: "Pve", "Regular" (PvP), "PvpSeason". */
export function modeChip(mode: string | null | undefined): { label: string; tone: string } | null {
  if (!mode) return null;
  const value = mode.toLowerCase();
  if (value.includes("season")) return { label: "SEASON", tone: "season" };
  if (value === "pve") return { label: "PVE", tone: "pve" };
  if (value === "regular" || value === "pvp") return { label: "PVP", tone: "pvp" };
  return { label: mode.toUpperCase(), tone: "other" };
}

export function ModeChip({ mode }: { mode: string | null | undefined }) {
  const chip = modeChip(mode);
  return chip ? <span className={`mode-chip ${chip.tone}`} title={mode ?? undefined}>{chip.label}</span> : null;
}
