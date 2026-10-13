import { useRef, type CSSProperties } from "react";
import type { PositionHistory } from "../lib/positions";
import { parseTime, raidColor, type RaidRecord } from "../lib/raids";
import { mapName } from "../maps";
import { CloseIcon } from "./Icons";

/** When a position was captured, else when it was received. */
function captured(position: PositionHistory[number]) {
  const time = parseTime(position.captured_at ?? position.observed_at);
  return Number.isNaN(time) ? "—" : new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * One dot per position of a past raid, oldest left to newest right, evenly spaced so bursts of shots stay
 * apart. Click, drag, scroll or use the arrow keys to move along it.
 */
export function RaidScrubber({ raid, positions, index, onSelect, onClose }: {
  raid: RaidRecord; positions: PositionHistory; index: number; onSelect: (index: number) => void; onClose: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const last = positions.length - 1;
  const at = (i: number) => `${last > 0 ? (i / last) * 100 : 50}%`;
  const select = (i: number) => onSelect(Math.max(0, Math.min(last, i)));
  const pick = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect?.width) return;
    select(Math.round(((clientX - rect.left) / rect.width) * last));
  };

  return <div className="map-scrubber" style={{ "--raid": raidColor(raid) } as CSSProperties}>
    <span className="scrub-swatch" />
    <span className="scrub-title">{mapName(raid.map) ?? "Unknown map"}</span>
    <div className="scrub-track" role="slider" tabIndex={0} aria-label="Position in raid"
      aria-valuemin={1} aria-valuemax={positions.length} aria-valuenow={index + 1}
      aria-valuetext={`${index + 1} of ${positions.length}, ${captured(positions[index])}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        pick(event.clientX);
      }}
      onPointerMove={(event) => { if (dragging.current) pick(event.clientX); }}
      onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}
      onWheel={(event) => select(index + Math.sign(event.deltaY || event.deltaX))}
      onKeyDown={(event) => {
        const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
        if (step) select(index + step);
        else if (event.key === "Home") select(0);
        else if (event.key === "End") select(last);
        else return;
        event.preventDefault();
      }}>
      <div ref={track} className="scrub-rail">
        <div className="scrub-fill" style={{ width: at(index) }} />
        {positions.map((position, i) => <span key={position.filename}
          className={`scrub-dot ${i < index ? "past" : ""} ${i === index ? "current" : ""}`} style={{ left: at(i) }} />)}
      </div>
    </div>
    <span className="scrub-readout">{captured(positions[index])}<span className="faint">{index + 1}/{positions.length}</span></span>
    <button type="button" className="icon-button" title="Back to live map" onClick={onClose}><CloseIcon /></button>
  </div>;
}
