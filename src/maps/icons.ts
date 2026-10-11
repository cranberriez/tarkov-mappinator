const files = import.meta.glob<string>("./assets/icons/*.png", { eager: true, query: "?url", import: "default" });

/** Icon URLs by file stem, e.g. `mapIcons["extract_pmc"]`, `mapIcons["container_safe"]`. */
export const mapIcons: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -4), url]),
);

/** Icon for a tarkov.dev loot container `normalizedName`, when one exists. */
export const containerIcon = (normalizedName: string): string | undefined => mapIcons[`container_${normalizedName}`];
