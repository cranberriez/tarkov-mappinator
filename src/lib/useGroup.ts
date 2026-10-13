import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Apinator, type Channel, type PresenceChannel } from "@apinator/client";
import type { Scanner } from "./useScanner";
import { positionsForRaid } from "./positions";
import { keys, usePersisted } from "./persist";
import {
  applyPosition, applyRaid, assignColors, authUrlOf, channelOf, createPacer, defaultName, newCode, newUserId, parsePosition, parseRaid,
  normalizeSite, POSITION_EVENT, RAID_EVENT, waiting, type GroupMember, type MemberState, type PositionMessage, type RaidMessage,
} from "./group";

/**
 * The site that signs group channels and hands out the Apinator app key (the secret stays there).
 * Settings can point elsewhere (a local or dev site); `VITE_GROUP_SITE` changes the default for a build.
 */
export const DEFAULT_GROUP_SITE = normalizeSite(import.meta.env.VITE_GROUP_SITE ?? "") ?? "https://www.tarkovhideout.com";
/** The SDK stops retrying after six attempts; after that, try again on this interval. */
const RETRY_MS = 30_000;
/** Members joining together get one re-send of everyone's state. */
const RESEND_DEBOUNCE_MS = 1000;

export type GroupConnection = "off" | "checking" | "needs-key" | "connecting" | "reconnecting" | "online" | "error";
export type GroupMembership = "none" | "joining" | "joined" | "error";

type Credentials = { appKey: string; cluster: string };

/**
 * Group sync. Rides an Apinator presence channel: presence gives the members and their names, and members
 * send each other only two client events, raid status and their newest position. App-level so the group
 * stays joined on every page and in mini mode.
 */
export function useGroup(scanner: Scanner) {
  // On/off and the group joined last only last the session: every launch starts with groups off.
  const [enabled, setEnabled] = useState(false);
  const [name, setName] = usePersisted(keys.groupName, defaultName());
  const [userId] = usePersisted(keys.groupUser, newUserId());
  const [code, setCode] = useState<string | null>(null);
  const [accessKey, setAccessKey] = usePersisted(keys.groupAccessKey, "");
  /** Site override from Settings; empty uses the default. */
  const [siteOverride, setSiteOverride] = usePersisted(keys.groupSite, "");
  const site = normalizeSite(siteOverride) ?? DEFAULT_GROUP_SITE;
  const authUrl = authUrlOf(site);
  const [connection, setConnection] = useState<GroupConnection>("off");
  const [membership, setMembership] = useState<GroupMembership>("none");
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<Apinator | null>(null);
  const [roster, setRoster] = useState<{ id: string; name: string }[]>([]);
  const [states, setStates] = useState<Record<string, MemberState>>({});
  const colors = useRef(new Map<string, string>());
  // Bumping this re-runs the connection effect: a retry after a failed check.
  const [attempt, setAttempt] = useState(0);

  // Connection: check access with the site, then open the socket. Name and key go in the auth headers, so either rebuilds it.
  useEffect(() => {
    if (!enabled) { setConnection("off"); setError(null); return; }
    let disposed = false;
    let socket: Apinator | null = null;
    let retry: number | undefined;
    setConnection("checking");
    setError(null);
    void (async () => {
      let credentials: Credentials;
      try {
        const response = await fetch(authUrl, { headers: accessKey ? { "X-Group-Key": accessKey } : {} });
        if (disposed) return;
        if (response.status === 401) { setConnection("needs-key"); setError(accessKey ? "That access key wasn't accepted." : null); return; }
        if (!response.ok) throw new Error(response.status === 503 ? "Groups aren't available right now." : `Sign-in failed (${response.status}).`);
        credentials = await response.json() as Credentials;
      } catch (cause) {
        if (disposed) return;
        setConnection("error");
        setError(cause instanceof TypeError ? `Couldn't reach ${new URL(site).host}, or it refused this app.` : String(cause instanceof Error ? cause.message : cause));
        retry = window.setTimeout(() => setAttempt((value) => value + 1), RETRY_MS);
        return;
      }
      if (disposed) return;
      socket = new Apinator({
        appKey: credentials.appKey, cluster: credentials.cluster, authEndpoint: authUrl,
        authHeaders: { "X-Group-User": userId, "X-Group-Name": name, ...(accessKey ? { "X-Group-Key": accessKey } : {}) },
      });
      socket.bind("state_change", (data) => {
        const { previous, current } = data as { previous: string; current: string };
        if (current === "connected") { setConnection("online"); setError(null); }
        // A drop from a live connection: the SDK retries on its own, and the group stays shown meanwhile.
        else if (current === "connecting") setConnection(previous === "connected" ? "reconnecting" : "connecting");
        else if (current === "unavailable" || current === "disconnected") {
          setConnection("error");
          setError("Lost connection. Retrying…");
          window.clearTimeout(retry);
          retry = window.setTimeout(() => socket?.connect(), RETRY_MS);
        }
      });
      setClient(socket);
      socket.connect();
    })();
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      if (socket) socket.unbind("state_change").disconnect();
      setClient(null);
    };
  }, [enabled, accessKey, name, userId, authUrl, attempt]);

  // Outgoing: what this player's state is now, and what was last sent of it.
  const live = scanner.snapshot?.raid;
  const inRaid = scanner.running && live?.lifecycle === "active";
  const raidMap = inRaid ? live?.map ?? null : null;
  const newest = inRaid && raidMap ? positionsForRaid(scanner.positions, live?.id).at(-1) : undefined;
  const desired = useRef<{ raid: RaidMessage; position: PositionMessage | null }>({ raid: { from: userId, inRaid: false, map: null }, position: null });
  desired.current = {
    raid: { from: userId, inRaid, map: raidMap },
    position: newest && raidMap ? {
      from: userId, map: raidMap, x: newest.xyz[0], y: newest.xyz[1], z: newest.xyz[2], heading: newest.heading_degrees, at: newest.observed_at,
    } : null,
  };
  const channel = useRef<Channel | null>(null);
  const sent = useRef<{ raid: string | null; position: string | null }>({ raid: null, position: null });
  const pacer = useMemo(() => createPacer(), []);
  const flushTimer = useRef<number | undefined>(undefined);

  /** Sends whatever changed since the last send, raid status first; anything held back by pacing waits for its slot. */
  const flush = useCallback(() => {
    window.clearTimeout(flushTimer.current);
    const target = channel.current;
    if (!target?.subscribed) return;
    const later = (ms: number) => { flushTimer.current = window.setTimeout(flush, ms); };
    const { raid, position } = desired.current;
    const raidKey = `${raid.inRaid}|${raid.map}`;
    if (sent.current.raid !== raidKey) {
      if (!pacer.take(Date.now(), "raid")) return later(1000);
      target.trigger(RAID_EVENT, raid);
      sent.current.raid = raidKey;
    }
    const positionKey = position && `${position.at}|${position.x}|${position.z}`;
    if (position && raid.inRaid && sent.current.position !== positionKey) {
      const wait = pacer.positionWait(Date.now());
      if (wait > 0) return later(wait);
      if (!pacer.take(Date.now(), "position")) return later(1000);
      target.trigger(POSITION_EVENT, position);
      sent.current.position = positionKey;
    }
  }, [pacer]);

  const raidKey = `${inRaid}|${raidMap}`;
  const positionKey = desired.current.position ? `${desired.current.position.at}|${desired.current.position.x}` : null;
  useEffect(() => { flush(); }, [raidKey, positionKey, flush]);

  // Membership: the group channel while there's a code and a connection.
  useEffect(() => {
    if (!client || !code) { setMembership("none"); setRoster([]); setStates({}); return; }
    const name = channelOf(code);
    const presence = client.subscribe(name) as PresenceChannel;
    channel.current = presence;
    setMembership("joining");
    let resend: number | undefined;
    /** Everyone's latest state for someone who just joined (or for us, just joined). */
    const resendSoon = () => {
      window.clearTimeout(resend);
      resend = window.setTimeout(() => { sent.current = { raid: null, position: null }; flush(); }, RESEND_DEBOUNCE_MS);
    };
    const syncRoster = () => setRoster(presence.getMembers()
      .filter((member) => member.user_id !== userId)
      .map((member) => ({ id: member.user_id, name: typeof member.user_info?.name === "string" ? member.user_info.name : "Unknown" })));
    presence.bind("realtime:subscription_succeeded", () => { setMembership("joined"); setError(null); syncRoster(); resendSoon(); });
    presence.bind("realtime:subscription_error", (data) => {
      setMembership("error");
      const detail = (data as { error?: string } | null)?.error;
      setError(detail ? `Couldn't join: ${detail}` : "Couldn't join the group.");
    });
    presence.bind("realtime:member_added", () => { syncRoster(); resendSoon(); });
    presence.bind("realtime:member_removed", (data) => {
      syncRoster();
      const id = (data as { user_id?: string }).user_id;
      if (id) setStates((current) => { const { [id]: _, ...rest } = current; return rest; });
    });
    presence.bind(RAID_EVENT, (data) => {
      const message = parseRaid(data);
      if (message && message.from !== userId) setStates((current) => ({ ...current, [message.from]: applyRaid(current[message.from] ?? waiting, message) }));
    });
    presence.bind(POSITION_EVENT, (data) => {
      const message = parsePosition(data);
      if (message && message.from !== userId) setStates((current) => ({ ...current, [message.from]: applyPosition(current[message.from] ?? waiting, message) }));
    });
    return () => {
      window.clearTimeout(resend);
      window.clearTimeout(flushTimer.current);
      presence.unbindAll();
      client.unsubscribe(name);
      channel.current = null;
      sent.current = { raid: null, position: null };
      setStates({});
    };
  }, [client, code, userId, flush]);

  const members = useMemo((): GroupMember[] => {
    colors.current = assignColors(roster.map((member) => member.id), colors.current);
    return roster.map((member) => ({ ...member, color: colors.current.get(member.id)!, ...(states[member.id] ?? waiting) }));
  }, [roster, states]);

  return {
    /** The site in use, and the Settings override (empty: default). */
    site, siteOverride, setSiteOverride,
    enabled, setEnabled, connection, membership, error, name, setName, accessKey, setAccessKey, code, members, self: { inRaid, map: raidMap },
    /** Starts a new group with a fresh code. */
    create: () => setCode(newCode()),
    join: (next: string) => setCode(next),
    leave: () => setCode(null),
  };
}

export type Group = ReturnType<typeof useGroup>;
