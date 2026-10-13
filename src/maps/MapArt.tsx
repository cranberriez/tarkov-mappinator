import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { isUnderground, UNDERGROUND_OPACITY } from "./projection.ts";
import { splitFloors, type Box, type Piece, type Slot } from "./split.ts";
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

/** One floor of one building when floors are split apart: its original place and how far it moves sideways, as fractions of the art's width and height. */
export type FloorSlot = { layer: string; x: number; y: number; width: number; height: number; dx: number };

/** Gap between columns and the distance within which pieces count as one building, as fractions of the art's width. */
const GAP = 0.006, JOIN = 0.003;
const LEAVES = "path,rect,polygon,polyline,circle,ellipse,line,use,image";

/** Moves every building's floors out beside the ground (see `splitFloors`); returns where they went. */
function splitArt(svg: SVGSVGElement, groups: SVGGElement[], base: string | undefined, floorIds: Set<string>, listed: string[], underground: Set<string | undefined>): FloorSlot[] {
  const root = svg.getScreenCTM();
  const view = svg.viewBox.baseVal;
  if (!root || !base) return [];
  const inverse = root.inverse();
  const pieces: (Piece & { element: SVGGraphicsElement })[] = [];
  let ground: Box | null = null;
  for (const group of groups) {
    const owner = group.dataset.keepWithGroup ?? group.id;
    if (owner !== base && !floorIds.has(owner)) continue;
    for (const element of group.querySelectorAll<SVGGraphicsElement>(LEAVES)) {
      if (element.closest("defs,clipPath,mask,pattern,symbol,marker")) continue;
      const matrix = element.getScreenCTM();
      if (!matrix) continue;
      const to = inverse.multiply(matrix), box = element.getBBox();
      if (!box.width && !box.height) continue;
      const xs = [box.x, box.x + box.width], ys = [box.y, box.y + box.height];
      const corners = xs.flatMap((x) => ys.map((y) => ({ x: to.a * x + to.c * y + to.e, y: to.b * x + to.d * y + to.f })));
      const rect = { x1: Math.min(...corners.map((c) => c.x)), y1: Math.min(...corners.map((c) => c.y)), x2: Math.max(...corners.map((c) => c.x)), y2: Math.max(...corners.map((c) => c.y)) };
      if (owner === base) ground = ground ? { x1: Math.min(ground.x1, rect.x1), y1: Math.min(ground.y1, rect.y1), x2: Math.max(ground.x2, rect.x2), y2: Math.max(ground.y2, rect.y2) } : rect;
      else pieces.push({ ...rect, layer: owner, element });
    }
  }
  if (!ground) return [];
  // Lowest to highest: underground first, then upper floors as listed.
  const order = [...new Set(listed)].filter((id) => id !== base).sort((a, b) => Number(underground.has(b)) - Number(underground.has(a)));
  const slots = splitFloors(ground, pieces, order, { gap: view.width * GAP, join: view.width * JOIN });
  // Each slot's pieces are the ones of its floor inside its box (a floor's pieces in one building never leave it).
  const byLayer = new Map<string, Slot[]>();
  for (const slot of slots) byLayer.set(slot.layer, [...byLayer.get(slot.layer) ?? [], slot]);
  const parents = new Map<Element, DOMMatrix>();
  for (const piece of pieces) {
    const slot = byLayer.get(piece.layer)?.find((other) => piece.x1 >= other.x1 - 1e-6 && piece.x2 <= other.x2 + 1e-6 && piece.y1 >= other.y1 - 1e-6 && piece.y2 <= other.y2 + 1e-6);
    if (!slot) continue;
    const parent = piece.element.parentElement as unknown as SVGGraphicsElement;
    let matrix = parents.get(parent);
    if (!matrix) { matrix = inverse.multiply(parent.getScreenCTM()!); parents.set(parent, matrix); }
    // The shift is along the root's x axis; in the piece's parent space it is the inverse of the parent's linear part.
    const det = matrix.a * matrix.d - matrix.b * matrix.c || 1;
    const x = matrix.d * slot.dx / det, y = -matrix.b * slot.dx / det;
    const element = piece.element;
    element.dataset.baseTransform ??= element.getAttribute("transform") ?? "";
    element.setAttribute("transform", `translate(${x} ${y}) ${element.dataset.baseTransform}`.trim());
  }
  return slots.map((slot) => ({ layer: slot.layer, x: (slot.x1 - view.x) / view.width, y: (slot.y1 - view.y) / view.height,
    width: (slot.x2 - slot.x1) / view.width, height: (slot.y2 - slot.y1) / view.height, dx: slot.dx / view.width }));
}

/**
 * Vector artwork for a map that has an `svg`, filling its box (place it over `artRect`).
 * `floor` is an SVG layer id; null or the base layer shows the base floor alone,
 * any other floor is drawn over a dimmed base floor. With `all`, the base floor is drawn first, then the
 * underground floors faintly over it, then the upper floors in order on top.
 * With `split` (implies `all`), every floor is drawn at full strength and moved sideways clear of the ground:
 * upper floors to its right, underground floors to its left, each in a column of its own; `onSplit` gets the slots.
 */
export function MapArt({ map, floor = null, all = false, split = false, onSplit, className, style }: {
  map: MapCalibration & { svg: string }; floor?: string | null; all?: boolean; split?: boolean;
  onSplit?: (slots: FloorSlot[] | null) => void; className?: string; style?: CSSProperties;
}) {
  all = all || split;
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
      group.classList.toggle("floor-underground", all && !split && underground.has(owner));
    }
    // Pieces move by an attribute transform in front of whatever they already had.
    for (const piece of svg.querySelectorAll<SVGElement>("[data-base-transform]")) {
      const base = piece.dataset.baseTransform!;
      if (base) piece.setAttribute("transform", base); else piece.removeAttribute("transform");
    }
    if (!split) onSplit?.(null);
    else onSplit?.(splitArt(svg, groups, map.svgLayer, new Set(floors.map((layer) => layer.svgLayer!)), floors.map((layer) => layer.svgLayer!), underground));
    // Array.sort is stable, so groups keep their file order within a floor.
    const ordered = groups.map((group) => ({ group, rank: rank(group.dataset.keepWithGroup ?? group.id) }));
    if (all) for (const { group } of ordered.sort((a, b) => a.rank - b.rank)) svg.append(group);
  }, [svg, floor, all, split, map.svgLayer, map.layers]);

  return <div ref={host} className={className} style={style} />;
}
