// Building and floor footprints from a map's SVG, in world coordinates, for derive-floors.mjs and apply-floors.mjs. The
// SVG's `Floor-1` group outlines buildings; `Floor-2` ... draw the upper floors. A footprint is an area: rings of [x, z]
// points, a point being inside when an odd number of rings contain it (so courtyards stay out).
import { artRect, projectionFor } from "../src/maps/projection.ts";

/** Upper floor art: SVG group and the layer it draws, bottom to top. */
export const UPPER = [["Floor-2", "2nd Floor"], ["Floor-3", "3rd Floor"], ["Floor-4", "4th Floor"], ["Floor-5", "5th Floor"]];

/** Points sampled along each curve segment, besides its end. */
const CURVE_STEPS = 4;

/** Subpaths of a path's `d` as point rings, curves sampled along their length. */
function rings(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g);
  let at = 0, command, x = 0, y = 0, startX = 0, startY = 0, current = null, control = null;
  const out = [], next = () => parseFloat(tokens[at++]);
  const add = (px, py) => (current ??= [[x, y]]).push([px, py]);
  while (at < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[at])) command = tokens[at++];
    const relative = command === command.toLowerCase(), kind = command.toUpperCase();
    const point = () => { const a = next(), b = next(); return relative ? [x + a, y + b] : [a, b]; };
    if (kind === "Z") { if (current) out.push(current); current = null; x = startX; y = startY; control = null; continue; }
    if (kind === "M") { [x, y] = point(); startX = x; startY = y; if (current) out.push(current); current = [[x, y]]; command = relative ? "l" : "L"; control = null; continue; }
    if (kind === "L") { [x, y] = point(); add(x, y); control = null; }
    else if (kind === "H") { const a = next(); x = relative ? x + a : a; add(x, y); control = null; }
    else if (kind === "V") { const a = next(); y = relative ? y + a : a; add(x, y); control = null; }
    else if (kind === "C" || kind === "S") {
      // S reflects the previous cubic's second control point.
      const c1 = kind === "C" ? point() : control ? [2 * x - control[0], 2 * y - control[1]] : [x, y], c2 = point(), end = point();
      for (let step = 1; step <= CURVE_STEPS; step++) {
        const t = step / CURVE_STEPS, u = 1 - t;
        add(u ** 3 * x + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * end[0], u ** 3 * y + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * end[1]);
      }
      [x, y] = end; control = c2;
    } else if (kind === "Q") {
      const c = point(), end = point();
      for (let step = 1; step <= CURVE_STEPS; step++) { const t = step / CURVE_STEPS, u = 1 - t; add(u * u * x + 2 * u * t * c[0] + t * t * end[0], u * u * y + 2 * u * t * c[1] + t * t * end[1]); }
      [x, y] = end; control = null;
    } else throw new Error(`Unsupported path command ${command}`);
  }
  if (current) out.push(current);
  return out.filter((ring) => ring.length > 2);
}

/** Whether an area (rings of points) contains a point, even-odd. */
export function inside(area, [px, py]) {
  let result = false;
  for (const ring of area) for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [x1, y1] = ring[a], [x2, y2] = ring[b];
    if ((y1 > py) !== (y2 > py) && px < (x2 - x1) * (py - y1) / (y2 - y1) + x1) result = !result;
  }
  return result;
}

/** Some point inside an area (a vertex average can fall outside a concave outline). */
export function anchor(area) {
  const vertices = area.flat(), centre = [vertices.reduce((sum, v) => sum + v[0], 0) / vertices.length, vertices.reduce((sum, v) => sum + v[1], 0) / vertices.length];
  if (inside(area, centre)) return centre;
  // Else the middle of the widest run inside along the row through the centre.
  const [x0, x1] = [Math.min(...vertices.map((v) => v[0])), Math.max(...vertices.map((v) => v[0]))];
  let best = null, run = null;
  for (let step = 0; step <= 200; step++) {
    const x = x0 + (x1 - x0) * step / 200, hit = inside(area, [x, centre[1]]);
    if (hit) run = run ? [run[0], x] : [x, x];
    if ((!hit || step === 200) && run) { if (!best || run[1] - run[0] > best[1] - best[0]) best = run; run = null; }
  }
  return best ? [(best[0] + best[1]) / 2, centre[1]] : vertices[0];
}

/** A map's footprints in world [x, z]: `buildings` from `Floor-1`, `pieces` of the upper floors with their layer and storey. */
export function floorArt(calibration, svg) {
  const projection = projectionFor(calibration), rect = artRect(calibration, projection);
  const [, , width, height] = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const toWorld = ([u, v]) => { const world = projection.toWorld({ x: u * rect.width / width + rect.x, y: v * rect.height / height + rect.y }); return [world.x, world.z]; };
  const group = (id) => {
    const start = svg.indexOf(`<g id="${id}"`);
    if (start < 0) throw new Error(`No group ${id} in ${calibration.svg}`);
    const body = svg.slice(start, svg.indexOf("</g>", start));
    return [...body.matchAll(/ d="([^"]+)"/g)].map((match) => rings(match[1]).map((ring) => ring.map(toWorld)));
  };
  const buildings = group("Floor-1");
  const pieces = UPPER.flatMap(([id, layer], index) => group(id).map((area, at) => ({ id: `${id}#${at}`, group: id, layer, storey: index + 1, area, at: anchor(area) })));
  return { buildings, pieces };
}

/**
 * Sites: the areas whose floors are set together. Each building outline is one, holding the upper-floor pieces anchored in
 * it; pieces outside every outline group under the lowest piece that holds their anchor, which is that site's outline.
 */
export function sitesOf({ buildings, pieces }) {
  const sites = buildings.map((outline, index) => ({ id: `Floor-1#${index}`, outline, pieces: [] }));
  const orphans = [];
  for (const piece of pieces) {
    const site = sites.find((candidate) => inside(candidate.outline, piece.at));
    if (site) site.pieces.push(piece); else orphans.push(piece);
  }
  orphans.sort((a, b) => a.storey - b.storey);
  for (const piece of orphans) {
    const site = sites.slice(buildings.length).find((candidate) => inside(candidate.outline, piece.at));
    if (site) site.pieces.push(piece); else sites.push({ id: piece.id, outline: piece.area, pieces: [piece] });
  }
  return sites;
}

/** The site an anchor point is in: building outlines first, then outlines of pieces outside any building. */
export const siteAt = (sites, at) => sites.find((site) => inside(site.outline, at)) ?? null;
