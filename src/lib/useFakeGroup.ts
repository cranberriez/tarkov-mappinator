import { useEffect, useMemo, useRef, useState } from "react";
import { games, maps, resolveGame } from "../maps";
import { waiting, type MemberState } from "./group";

/**
 * Dev builds only: simulated group members, so the group page, the map's member markers and the mapmates list can
 * be tried without friends. They mostly follow you onto your raid's map, wander it, and now and then extract or
 * load into another raid.
 */
const NAMES = ["Fake_Birdeye", "Fake_Knight", "Fake_BigPipe", "Fake_Partisan", "Fake_Kaban"];
const TICK_MS = 1500;
/** Per tick: chance an in-raid member extracts, and an out-of-raid one loads in. */
const EXTRACT_CHANCE = 0.01;
const LOAD_IN_CHANCE = 0.08;
/** Chance a member loading in picks your map (or the group's usual map when you're out of raid). */
const SAME_MAP_CHANCE = 0.75;
/** How many members (after the stash and elsewhere ones) are pinned to your map whenever you're in a raid. */
const PINNED = 2;

type Fake = { id: string; name: string; state: MemberState; heading: number };
type Roster = { id: string; name: string }[];

const playable = games.filter((game) => game.art && maps[game.art]);
const randomMap = () => playable[Math.floor(Math.random() * playable.length)].nameId;

/** The middle 60% of a map's world bounds, as [minX, maxX, minZ, maxZ]. */
function area(map: string): [number, number, number, number] | null {
  const art = resolveGame(map)?.art;
  const calibration = art ? maps[art] : null;
  if (!calibration) return null;
  const [[x1, z1], [x2, z2]] = calibration.bounds;
  const [minX, maxX, minZ, maxZ] = [Math.min(x1, x2), Math.max(x1, x2), Math.min(z1, z2), Math.max(z1, z2)];
  const [padX, padZ] = [(maxX - minX) * 0.2, (maxZ - minZ) * 0.2];
  return [minX + padX, maxX - padX, minZ + padZ, maxZ - padZ];
}

const between = (min: number, max: number) => min + Math.random() * (max - min);

function loadIn(fake: Fake, map: string): Fake {
  const bounds = area(map);
  if (!bounds) return fake;
  const at = new Date().toISOString();
  const [x, z] = [between(bounds[0], bounds[1]), between(bounds[2], bounds[3])];
  const heading = Math.random() * 360;
  return { ...fake, heading, state: { status: "in-raid", map, position: { x, z, heading, at, key: `${fake.id}|${at}` } } };
}

/** A few metres along a drifting heading, turning back at the edge of the map's middle. */
function walk(fake: Fake): Fake {
  const { map, position } = fake.state;
  const bounds = map ? area(map) : null;
  if (!position || !bounds || !map) return fake;
  let heading = (fake.heading + between(-35, 35) + 360) % 360;
  const step = between(1, 5);
  let x = position.x + Math.sin(heading * Math.PI / 180) * step;
  let z = position.z + Math.cos(heading * Math.PI / 180) * step;
  if (x < bounds[0] || x > bounds[1] || z < bounds[2] || z > bounds[3]) {
    heading = (heading + 180) % 360;
    x = Math.min(bounds[1], Math.max(bounds[0], x));
    z = Math.min(bounds[3], Math.max(bounds[2], z));
  }
  const at = new Date().toISOString();
  return { ...fake, heading, state: { status: "in-raid", map, position: { x, z, heading, at, key: `${fake.id}|${at}` } } };
}

/** `on`: fake members are in the group. `selfMap`: your raid's map (raw id), which they prefer. */
export function useFakeGroup(on: boolean, selfMap: string | null): { roster: Roster; states: Record<string, MemberState> } {
  const [fakes, setFakes] = useState<Fake[]>([]);
  const preferred = useRef(selfMap);
  preferred.current = selfMap;

  useEffect(() => {
    if (!on) { setFakes([]); return; }
    // The map they gather on when you're out of raid, picked once per session of fakes.
    const usual = randomMap();
    const home = () => preferred.current ?? usual;
    // One stays in the stash and one is elsewhere, so every status shows from the start.
    setFakes(NAMES.map((name, index) => {
      const fake: Fake = { id: `fake-${index + 1}`, name, state: { ...waiting, status: "out-of-raid" }, heading: 0 };
      return index === 0 ? fake : loadIn(fake, index === 1 ? randomMap() : home());
    }));
    const timer = window.setInterval(() => setFakes((current) => current.map((fake, index) => {
      // While you're in a raid, the pinned members are always on your map, never extracting.
      if (preferred.current && index >= 2 && index < 2 + PINNED) {
        return fake.state.status === "in-raid" && fake.state.map === preferred.current ? walk(fake) : loadIn(fake, preferred.current);
      }
      if (fake.state.status !== "in-raid") return Math.random() < LOAD_IN_CHANCE ? loadIn(fake, Math.random() < SAME_MAP_CHANCE ? home() : randomMap()) : fake;
      if (Math.random() < EXTRACT_CHANCE) return { ...fake, state: { status: "out-of-raid", map: null, position: null } };
      return walk(fake);
    })), TICK_MS);
    return () => window.clearInterval(timer);
  }, [on]);

  return useMemo(() => ({
    roster: fakes.map(({ id, name }) => ({ id, name })),
    states: Object.fromEntries(fakes.map((fake) => [fake.id, fake.state])),
  }), [fakes]);
}
