import type { PlayerPosition } from "../maps/players.ts";

/**
 * Group sync model: codes, names and the two messages members exchange over an Apinator presence channel.
 * Only raid status and positions are ever sent; names and membership come from presence.
 */

/** Unambiguous code characters (no 0/O, 1/I/L); the site accepts the same set. */
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;
export const NAME_MAX = 15;
/** Tarkov's own rule: letters, digits, `_` and `-`. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,15}$/;

/** Colours for other members, in join order; the player's own marker keeps the theme accent. */
export const MEMBER_COLORS = ["#5fb3f5", "#e57373", "#b39ddb", "#4dd0c4"] as const;

const pick = (chars: string, count: number, random: () => number) =>
  Array.from({ length: count }, () => chars[Math.floor(random() * chars.length)]).join("");

export const newCode = (random = Math.random) => pick(CODE_CHARS, CODE_LENGTH, random);
export const newUserId = (random = Math.random) => pick("abcdefghijklmnopqrstuvwxyz0123456789", 16, random);
export const defaultName = (random = Math.random) => `PMC_${pick("0123456789", 4, random)}`;

/** A typed code, upper-cased with separators dropped; null unless it's a whole valid code. */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  return code.length === CODE_LENGTH && [...code].every((char) => CODE_CHARS.includes(char)) ? code : null;
}

/** Typed name with characters Tarkov wouldn't allow removed, cut to 15. */
export const cleanName = (input: string) => input.replace(/[^A-Za-z0-9_-]/g, "").slice(0, NAME_MAX);
export const validName = (name: string) => NAME_PATTERN.test(name);

export const channelOf = (code: string) => `presence-group-${code}`;

/** The site that signs group channels, as typed: its origin (http or https), or null if it isn't one. */
export function normalizeSite(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    // Without a scheme: http for this machine (local dev servers), https anywhere else.
    const local = /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(text);
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `${local ? "http" : "https"}://${text}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export const authUrlOf = (site: string) => `${site}/api/group/auth`;

export const RAID_EVENT = "client-raid";
export const POSITION_EVENT = "client-pos";

/** Whether the sender is in a raid, and on which map (raw game id, as the scanner reports it). */
export type RaidMessage = { from: string; inRaid: boolean; map: string | null };
/** The sender's newest position on `map`, world coordinates. */
export type PositionMessage = { from: string; map: string; x: number; y: number; z: number; heading: number | null; at: string };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const shortText = (value: unknown, max = 64): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

export function parseRaid(data: unknown): RaidMessage | null {
  if (!data || typeof data !== "object") return null;
  const { from, inRaid, map } = data as Record<string, unknown>;
  if (!shortText(from) || typeof inRaid !== "boolean" || !(map === null || shortText(map))) return null;
  return { from, inRaid, map };
}

export function parsePosition(data: unknown): PositionMessage | null {
  if (!data || typeof data !== "object") return null;
  const { from, map, x, y, z, heading, at } = data as Record<string, unknown>;
  if (!shortText(from) || !shortText(map) || !finite(x) || !finite(y) || !finite(z) || !shortText(at, 40)) return null;
  if (!(heading === null || finite(heading)) || Number.isNaN(Date.parse(at))) return null;
  return { from, map, x, y, z, heading, at };
}

/** What a member's group panel row says. */
export type MemberStatus = "waiting" | "in-raid" | "out-of-raid";

export type GroupMember = {
  id: string;
  name: string;
  color: string;
  status: MemberStatus;
  /** Raid map while in raid (raw game id). */
  map: string | null;
  /** Newest position this raid, on `map`. */
  position: PlayerPosition | null;
};

export type MemberState = Pick<GroupMember, "status" | "map" | "position">;
export const waiting: MemberState = { status: "waiting", map: null, position: null };

/** A member's state after a raid message: leaving a raid drops their marker; a new map drops a stale one. */
export function applyRaid(state: MemberState, message: RaidMessage): MemberState {
  if (!message.inRaid) return { status: "out-of-raid", map: null, position: null };
  const sameMap = state.map === message.map;
  return { status: "in-raid", map: message.map, position: sameMap ? state.position : null };
}

/** A position also says the sender is in a raid on that map. */
export function applyPosition(_state: MemberState, message: PositionMessage): MemberState {
  return {
    status: "in-raid", map: message.map,
    position: { x: message.x, y: message.y, z: message.z, heading: message.heading, at: message.at, key: `${message.from}|${message.at}|${message.x}|${message.z}` },
  };
}

/** Colour per member id, stable while they stay: kept colours stay, newcomers take the first free one. */
export function assignColors(ids: string[], previous: Map<string, string>): Map<string, string> {
  const next = new Map<string, string>();
  for (const id of ids) { const kept = previous.get(id); if (kept) next.set(id, kept); }
  for (const id of ids) {
    if (next.has(id)) continue;
    const used = [...next.values()];
    const free = MEMBER_COLORS.find((color) => !used.includes(color)) ?? MEMBER_COLORS[next.size % MEMBER_COLORS.length];
    next.set(id, free);
  }
  return next;
}

/**
 * Outgoing message pacing: positions at most one per `positionMs` (the newest waits for the slot,
 * replacing any that was waiting), and no more than `burst` messages of any kind per `windowMs`.
 */
export function createPacer({ positionMs = 1000, burst = 20, windowMs = 10_000 } = {}) {
  let lastPosition = -Infinity;
  const sent: number[] = [];
  return {
    /** Ms until a position may go (0: now). */
    positionWait(now: number) { return Math.max(0, lastPosition + positionMs - now); },
    /** Records a send if the burst budget allows it. */
    take(now: number, kind: "raid" | "position"): boolean {
      while (sent.length && now - sent[0] >= windowMs) sent.shift();
      if (sent.length >= burst) return false;
      if (kind === "position") {
        if (now < lastPosition + positionMs) return false;
        lastPosition = now;
      }
      sent.push(now);
      return true;
    },
  };
}
