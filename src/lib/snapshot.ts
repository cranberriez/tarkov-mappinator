import type { ScannerSnapshot } from "../bindings/ScannerSnapshot";

export function acceptSnapshot(
  current: ScannerSnapshot | null,
  incoming: ScannerSnapshot,
): ScannerSnapshot {
  if (current?.instance_id === incoming.instance_id && current.revision >= incoming.revision) {
    return current;
  }
  return incoming;
}
