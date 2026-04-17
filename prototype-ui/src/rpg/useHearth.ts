import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DailyPlan,
  Difficulty,
  HealthSnapshot,
  MissedEvent,
  PeerInfo,
  PeerRole,
  NpcDay,
  RunClock,
  SceneAgentAction,
  SceneWire,
} from "../../../app/shared/protocol";
import { getUserId } from "./auth";
import { currentRoomId, loadRoomById } from "./engine";

export type HearthStatus = "idle" | "connecting" | "open" | "closed" | "error";

export interface HearthAgentLive {
  agentId: string;
  thinking: string;
  thinkingCount: number;
  lastAction: SceneAgentAction | null;
  lastReason: string | null;
  nextWakeAt: number | null;
  position: string | null;
  lastDecidedAt: number | null;
}

export interface HearthMoment {
  ts: number;
  agentId: string;
  npcName: string | null;
  action: SceneAgentAction | null;
  reason: string;
}

export interface HearthHello {
  userId: string;
  roomId: string;
  scene: SceneWire;
  dailyPlan: DailyPlan;
  clock: RunClock;
  dayComplete?: boolean;
  role: PeerRole;
  peerId: string;
  displayName: string;
  inviteToken: string;
  peers: PeerInfo[];
  health: HealthSnapshot;
  difficulty: Difficulty;
  missedEvents: MissedEvent[];
}

export interface HearthTerminal {
  kind: "kicked" | "day-done" | "run-ended";
  reason: string;
}

export interface SpawnedNpcEvent {
  ts: number;
  agentId: string;
  spawnedBy: string | null;
  npc: NpcDay;
}

export interface UseHearthResult {
  status: HearthStatus;
  hello: HearthHello | null;
  terminal: HearthTerminal | null;
  agents: Record<string, HearthAgentLive>;
  moments: HearthMoment[];
  npcsByAgentId: Record<string, NpcDay>;
  /**
   * NPCs introduced mid-day via another agent's `spawn` action, in order
   * received. Resets when a fresh hello arrives (new day or new room).
   */
  spawnedNpcs: SpawnedNpcEvent[];
  /** Phase 4 — live roster of connected peers in this room. */
  peers: PeerInfo[];
  /** Phase 4 — most recent health snapshot (plan provenance, alarm timing). */
  health: HealthSnapshot | null;
  /** Phase 4 — current invite token for share-room links. */
  inviteToken: string;
  /** Phase 5 — current difficulty (tourist/resident/native). */
  difficulty: Difficulty;
  /** Phase 5 — while-you-were-away slice delivered on (re)connect. */
  missedEvents: MissedEvent[];
  /** Dismiss the missed-events overlay locally. */
  clearMissedEvents: () => void;
  /** Call to send a card-play frame; returns false if the socket isn't open. */
  playCard: (cardId: string) => boolean;
  /** Owner-only: set room difficulty. Returns false if socket isn't open. */
  setDifficulty: (difficulty: Difficulty) => boolean;
  /** Owner-only: rotate the invite token. Returns false if socket isn't open. */
  rotateInvite: () => boolean;
}

const WS_BASE =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "ws://localhost:8788"
    : "wss://augur.carl-lewis.workers.dev";

const MAX_MOMENTS = 30;

export function useHearth(opts: { enabled: boolean; roomId: string | null; inviteToken?: string | null }): UseHearthResult {
  const [status, setStatus] = useState<HearthStatus>("idle");
  const [hello, setHello] = useState<HearthHello | null>(null);
  const [terminal, setTerminal] = useState<HearthTerminal | null>(null);
  const [agents, setAgents] = useState<Record<string, HearthAgentLive>>({});
  const [moments, setMoments] = useState<HearthMoment[]>([]);
  const [spawnedNpcs, setSpawnedNpcs] = useState<SpawnedNpcEvent[]>([]);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [inviteToken, setInviteToken] = useState<string>("");
  const [difficulty, setDifficultyState] = useState<Difficulty>("resident");
  const [missedEvents, setMissedEvents] = useState<MissedEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!opts.enabled) return;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 500;

    // Reset hello/agents/moments when roomId switches so the prior floor's
    // cast and narrative don't bleed into the next one's UI during the
    // window between WS close and the new hello landing.
    setHello(null);
    setAgents({});
    setMoments([]);
    setSpawnedNpcs([]);

    const connect = () => {
      if (cancelled) return;
      const userId = getUserId() ?? "dev-user";
      const roomId = opts.roomId ?? currentRoomId();
      if (!roomId) {
        setStatus("idle");
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 1000);
        return;
      }

      // One-shot handoff of the room's prompt so the DO can weave it into
      // the daily plan and per-NPC prompts. Anchors are NOT sent — Hearth
      // authors the room's geometry itself (Phase 6E.2+) and broadcasts the
      // anchor names back in `hello`. The client's job is to render, not
      // to ship a stale local anchor list upstream.
      // `memory` carries building-wide continuity (previous floors' summaries,
      // ghosts, surviving roster) so Hearth can author the new floor as the
      // next chapter rather than a standalone scene.
      const room = loadRoomById(roomId, Date.now());
      const prompt = (room?.roomPrompt ?? "").trim();
      const memory = (room?.inheritedMemory ?? "").trim();

      const inv = opts.inviteToken?.trim() || "";
      const url =
        `${WS_BASE}/api/session?userId=${encodeURIComponent(userId)}` +
        `&roomId=${encodeURIComponent(roomId)}` +
        (prompt ? `&prompt=${encodeURIComponent(prompt)}` : "") +
        (memory ? `&memory=${encodeURIComponent(memory)}` : "") +
        (inv ? `&inv=${encodeURIComponent(inv)}` : "");

      setStatus("connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        backoffMs = 500;
        setStatus("open");
        setTerminal(null);
      });

      const scheduleReconnect = () => {
        if (cancelled) return;
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 8000);
      };

      ws.addEventListener("close", (ev) => {
        setStatus("closed");
        if (ev.code === 1000) {
          if (ev.reason === "another-connection") {
            setTerminal({ kind: "kicked", reason: "another tab took over" });
            return;
          }
          if (ev.reason.startsWith("run-ended:")) {
            setTerminal({
              kind: "run-ended",
              reason: ev.reason.slice("run-ended:".length),
            });
            return;
          }
        }
        scheduleReconnect();
      });

      ws.addEventListener("error", () => setStatus("error"));

      ws.addEventListener("message", (ev) => {
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "hello") {
          const h = msg as unknown as HearthHello & { type: "hello" };
          setHello(h);
          setPeers(Array.isArray(h.peers) ? h.peers : []);
          setHealth(h.health ?? null);
          setInviteToken(typeof h.inviteToken === "string" ? h.inviteToken : "");
          if (
            h.difficulty === "tourist" ||
            h.difficulty === "resident" ||
            h.difficulty === "native"
          ) {
            setDifficultyState(h.difficulty);
          }
          setMissedEvents(
            Array.isArray(h.missedEvents) ? h.missedEvents : [],
          );
          // Hello carries the full current roster (residents + any prior
          // spawns persisted into dailyPlan.npcs), so the live spawn
          // queue resets — anything since the last hello is replayed
          // implicitly via the roster itself.
          setSpawnedNpcs([]);
          if (h.dayComplete) {
            setTerminal({
              kind: "day-done",
              reason: "today's run is complete",
            });
          }
          return;
        }
        if (msg.type === "presence-changed") {
          const list = (msg as { peers?: PeerInfo[] }).peers;
          if (Array.isArray(list)) setPeers(list);
          return;
        }
        if (msg.type === "health-snapshot") {
          const h = (msg as { health?: HealthSnapshot }).health;
          if (h) setHealth(h);
          return;
        }
        if (msg.type === "invite-rotated") {
          const t = (msg as { inviteToken?: string }).inviteToken;
          if (typeof t === "string") setInviteToken(t);
          return;
        }
        if (msg.type === "npc-spawned") {
          const agentId = String(msg.agentId ?? "");
          const npc = (msg as { npc?: NpcDay }).npc;
          if (!agentId || !npc) return;
          const spawnedBy =
            typeof msg.spawnedBy === "string" ? msg.spawnedBy : null;
          setSpawnedNpcs((prev) =>
            prev.some((p) => p.agentId === agentId)
              ? prev
              : [...prev, { ts: Date.now(), agentId, spawnedBy, npc }],
          );
          setHello((prev) => {
            if (!prev) return prev;
            if (prev.dailyPlan.npcs.some((n) => n.name === npc.name)) {
              return prev;
            }
            return {
              ...prev,
              dailyPlan: {
                ...prev.dailyPlan,
                npcs: [...prev.dailyPlan.npcs, npc],
              },
            };
          });
          return;
        }
        if (msg.type === "run-ended") {
          const why = typeof msg.reason === "string" ? msg.reason : "schedule";
          setTerminal({ kind: "run-ended", reason: why });
          return;
        }
        if (msg.type === "kicked") {
          setTerminal({ kind: "kicked", reason: "another tab took over" });
          return;
        }
        if (msg.type === "agent-thinking") {
          const agentId = String(msg.agentId ?? "");
          const delta = String(msg.delta ?? "");
          if (!agentId) return;
          setAgents((prev) => {
            const cur = prev[agentId] ?? newAgent(agentId);
            return {
              ...prev,
              [agentId]: {
                ...cur,
                thinking: (cur.thinking + delta).slice(-1200),
                thinkingCount: cur.thinkingCount + 1,
              },
            };
          });
          return;
        }
        if (msg.type === "agent-decided") {
          const agentId = String(msg.agentId ?? "");
          if (!agentId) return;
          const action = (msg.action as SceneAgentAction | null) ?? null;
          const reason = typeof msg.reason === "string" ? msg.reason : "";
          const nextWakeAt =
            typeof msg.nextWakeAt === "number" ? msg.nextWakeAt : null;
          setAgents((prev) => {
            const cur = prev[agentId] ?? newAgent(agentId);
            return {
              ...prev,
              [agentId]: {
                ...cur,
                lastAction: action,
                lastReason: reason || null,
                nextWakeAt,
                thinking: "",
                position: action?.position ?? cur.position,
                lastDecidedAt: Date.now(),
              },
            };
          });
          setMoments((prev) => {
            const npcName = stripNpcPrefix(agentId);
            const entry: HearthMoment = {
              ts: Date.now(),
              agentId,
              npcName,
              action,
              reason,
            };
            const next = [...prev, entry];
            return next.length > MAX_MOMENTS ? next.slice(-MAX_MOMENTS) : next;
          });
        }
      });
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { wsRef.current?.close(); } catch { /* ignore */ }
      wsRef.current = null;
    };
  }, [opts.enabled, opts.roomId, opts.inviteToken]);

  const npcsByAgentId = useMemo(() => {
    const map: Record<string, NpcDay> = {};
    for (const npc of hello?.dailyPlan?.npcs ?? []) {
      map[`npc:${slugify(npc.name)}`] = npc;
    }
    return map;
  }, [hello?.dailyPlan?.npcs]);

  const playCard = (cardId: string): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ type: "play", cardId }));
      return true;
    } catch {
      return false;
    }
  };

  const setDifficulty = (next: Difficulty): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ type: "set-difficulty", difficulty: next }));
      setDifficultyState(next);
      return true;
    } catch {
      return false;
    }
  };

  const rotateInvite = (): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ type: "rotate-invite" }));
      return true;
    } catch {
      return false;
    }
  };

  const clearMissedEvents = () => setMissedEvents([]);

  return {
    status,
    hello,
    terminal,
    agents,
    moments,
    npcsByAgentId,
    spawnedNpcs,
    peers,
    health,
    inviteToken,
    difficulty,
    missedEvents,
    clearMissedEvents,
    playCard,
    setDifficulty,
    rotateInvite,
  };
}

function newAgent(agentId: string): HearthAgentLive {
  return {
    agentId,
    thinking: "",
    thinkingCount: 0,
    lastAction: null,
    lastReason: null,
    nextWakeAt: null,
    position: null,
    lastDecidedAt: null,
  };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function stripNpcPrefix(agentId: string): string | null {
  if (!agentId.startsWith("npc:")) return null;
  return agentId.slice(4).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
