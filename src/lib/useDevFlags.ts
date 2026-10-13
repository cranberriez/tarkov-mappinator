import { keys, usePersisted } from "./persist";

/**
 * Developer-only switches. Only dev builds (`vite` / `tauri dev`) show them: `import.meta.env.DEV` is false in a
 * release build, so every `DEV && flags.x` check is constant-false there and its code is dropped.
 */
export const DEV = import.meta.env.DEV;

export type DevFlags = {
  /** Five simulated members join whatever group you're in, wandering maps and dropping in and out of raids. */
  fakePlayers: boolean;
};

const off: DevFlags = { fakePlayers: false };

export function useDevFlags() {
  const [stored, setFlags] = usePersisted<DevFlags>(keys.devFlags, off);
  const flags: DevFlags = DEV ? { ...off, ...stored } : off;
  return { flags, set: (patch: Partial<DevFlags>) => setFlags((current) => ({ ...current, ...patch })) };
}

export type DevFlagsState = ReturnType<typeof useDevFlags>;
