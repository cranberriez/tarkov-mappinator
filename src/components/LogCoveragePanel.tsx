import type { ScannerSnapshot } from "../bindings/ScannerSnapshot";
import { timestamp } from "../lib/format";

export function LogCoveragePanel({ snapshot }: { snapshot: ScannerSnapshot | null }) {
  const coverage = snapshot?.log_coverage ?? [];
  if (!coverage.length) return <p className="faint">{snapshot ? "No log records counted yet." : "Backend not connected."}</p>;
  return <div className="table-scroll"><table className="table">
    <thead><tr><th>Source</th><th>Category</th><th>Level</th><th className="num">Records</th><th className="num">Unclassified</th><th>Last record</th></tr></thead>
    <tbody>{coverage.map((entry, index) => <tr key={`${entry.source}-${entry.category}-${entry.level}-${index}`}>
      <td>{entry.source}</td><td>{entry.category}</td><td>{entry.level}</td><td className="num">{entry.records.toLocaleString()}</td>
      <td className="num">{entry.unclassified.toLocaleString()}</td><td className="faint">{timestamp(entry.last_record_at)}</td>
    </tr>)}</tbody>
  </table></div>;
}
