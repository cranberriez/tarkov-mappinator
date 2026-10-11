import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { isUnderground, UNDERGROUND_OPACITY } from "./projection.ts";
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
  svg > g.floor-underground { opacity: ${UNDERGROUND_OPACITY}; }
`;

/**
 * Vector artwork for a map that has an `svg`, filling its box (place it over `artRect`).
 * `floor` is an SVG layer id; null or the base layer shows the base floor alone,
 * any other floor is drawn over a dimmed base floor. With `all`, the base floor is drawn first, then the
 * underground floors faintly over it, then the upper floors in order on top.
 */
export function MapArt({ map, floor = null, all = false, className, style }: {
  map: MapCalibration & { svg: string }; floor?: string | null; all?: boolean; className?: string; style?: CSSProperties;
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
    const active = !all && floor && floor !== map.svgLayer ? floor : null;
    const floors = map.layers.filter((layer) => layer.svgLayer);
    const underground = new Set(floors.filter(isUnderground).map((layer) => layer.svgLayer));
    // Stacking: base, underground, then upper floors bottom to top (the order tarkov.dev lists them).
    const rank = (owner: string) => owner === map.svgLayer ? 0 : underground.has(owner) ? 1 : 2 + floors.findIndex((layer) => layer.svgLayer === owner);
    const groups = [...svg.children].filter((group): group is SVGGElement => group instanceof SVGGElement && !!group.id);
    for (const group of groups) {
      const owner = group.dataset.keepWithGroup ?? group.id;
      const shown = owner === map.svgLayer || (all ? floors.some((layer) => layer.svgLayer === owner) : owner === active);
      group.classList.toggle("floor-hidden", !shown);
      group.classList.toggle("floor-dimmed", !all && owner === map.svgLayer && active !== null);
      group.classList.toggle("floor-underground", all && underground.has(owner));
    }
    // Array.sort is stable, so groups keep their file order within a floor.
    const ordered = groups.map((group) => ({ group, rank: rank(group.dataset.keepWithGroup ?? group.id) }));
    if (all) for (const { group } of ordered.sort((a, b) => a.rank - b.rank)) svg.append(group);
  }, [svg, floor, all, map.svgLayer, map.layers]);

  return <div ref={host} className={className} style={style} />;
}
