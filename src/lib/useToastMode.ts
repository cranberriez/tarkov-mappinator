import { useEffect, useState } from "react";
import { keys, load, save } from "./persist";

export type ToastMode = "all" | "raid" | "off";

export const toastModes: { value: ToastMode; label: string }[] = [
  { value: "all", label: "All" }, { value: "raid", label: "Raid only" }, { value: "off", label: "Off" },
];

/** Which live activity shows as a toast. App-level so a change in Settings applies at once. */
export function useToastMode() {
  const [mode, setMode] = useState<ToastMode>(() => {
    const stored = load<string>(keys.toasts, "raid");
    return toastModes.some((option) => option.value === stored) ? stored as ToastMode : "raid";
  });
  useEffect(() => save(keys.toasts, mode), [mode]);
  return { mode, setMode };
}

export type ToastModeState = ReturnType<typeof useToastMode>;
