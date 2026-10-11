import type { ScannerSnapshot } from "../bindings/ScannerSnapshot";

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function LogCoveragePanel({ snapshot }: { snapshot: ScannerSnapshot | null }) {
  const coverage = snapshot?.log_coverage ?? [];
  return <section className="log-coverage">
    <div className="coverage-heading"><h3>Log coverage</h3><span className="muted">Safe source, category and level counts</span></div>
    {coverage.length ? <div className="coverage-scroll"><table className="coverage-table">
      <thead><tr><th scope="col">Source</th><th scope="col">Category</th><th scope="col">Level</th><th scope="col">Records</th><th scope="col">Unclassified</th><th scope="col">Last record</th></tr></thead>
      <tbody>{coverage.map((entry, index) => <tr key={`${entry.source}-${entry.category}-${entry.level}-${index}`}>
        <td>{entry.source}</td><td>{entry.category}</td><td>{entry.level}</td><td>{entry.records.toLocaleString()}</td>
        <td>{entry.unclassified.toLocaleString()}</td><td>{timestamp(entry.last_record_at)}</td>
      </tr>)}</tbody>
    </table></div> : <p className="muted">{snapshot ? "No log records counted yet." : "Log coverage unknown until the backend connects."}</p>}
    <p className="muted">Unclassified records count log messages without a supported structured activity event. No raw messages, account tokens or payloads are displayed.</p>
  </section>;
}
