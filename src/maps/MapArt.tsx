import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { MapCalibration } from "./types.ts";

const sources = import.meta.glob<string>("./assets/svg/*.svg", { query: "?raw", import: "default" });
const cache = new Map<string, Promise<string>>();

/** Raw SVG text for a map, loaded on first use. */
export function loadMapSvg(file: string): Promise<string> {
  let text = cache.get(file);
  if (!text) {
    const load = sources[`./assets/svg/${file}`];
    text = load ? load() : Promise.reject(new Error(`No SVG for ${file}`));
    cache.set(file, text);
  }
  return text;
}

// The SVGs carry global class styles (.floor, .building, …); a shadow root keeps them off the app.
const SHADOW_CSS = `
  :host { display: block; }
  svg { display: block; width: 100%; height: 100%; overflow: visible; }
  svg > g.floor-hidden { display: none; }
  svg > g.floor-dimmed { opacity: .2; }
`;

/**
 * Vector artwork for one map, filling its box (place it over `artRect`).
 * `floor` is an SVG layer id; null or the base layer shows the base floor alone,
 * any other floor is drawn over a dimmed base floor.
 */
export function MapArt({ map, floor = null, className, style }: {
  map: MapCalibration; floor?: string | null; className?: string; style?: CSSProperties;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);

  useEffect(() => {
    let live = true;
    setSvg(null);
    loadMapSvg(map.svg).then((text) => {
      const parsed = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
      if (live && parsed instanceof SVGSVGElement) setSvg(parsed);
    }, (error) => console.error(error));
    return () => { live = false; };
  }, [map.svg]);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const root = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    const css = document.createElement("style");
    css.textContent = SHADOW_CSS;
    root.replaceChildren(css, ...(svg ? [svg] : []));
  }, [svg]);

  useLayoutEffect(() => {
    if (!svg) return;
    const active = floor && floor !== map.svgLayer ? floor : null;
    for (const group of svg.children) {
      if (!(group instanceof SVGGElement) || !group.id) continue;
      const owner = group.dataset.keepWithGroup ?? group.id;
      group.classList.toggle("floor-hidden", owner !== map.svgLayer && owner !== active);
      group.classList.toggle("floor-dimmed", owner === map.svgLayer && active !== null);
    }
  }, [svg, floor, map.svgLayer]);

  return <div ref={host} className={className} style={style} />;
}
