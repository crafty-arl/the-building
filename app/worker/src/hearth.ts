/**
 * Hearth Durable Object — one per (user, room).
 *
 * Owns the SessionTree, the daily plan + run clock, the footsteps counter,
 * and the live WebSocket. Persists to DO storage on every mutation. Uses
 * Hibernatable WebSockets so an idle session doesn't burn CPU.
 *
 * Runs are time-boxed to a hybrid 15-min soft / 25-min hard ceiling. The
 * daily plan is regenerated once per UTC calendar day; subsequent runs
 * within the same day advance the in-game clock (+2h per run, clamped).
 *
 * DO identity is `idFromName(`${userId}:${roomId}`)` — each room in the
 * player's building owns a distinct DO with its own NPCs, plan, and tree.
 */

import type {
  ClientMessage,
  Difficulty,
  HealthSnapshot,
  MissedEvent,
  PeerInfo,
  PeerRole,
  RunClock,
  ServerMessage,
} from "../../shared/protocol.ts";
import { computeHand } from "./hand.ts";
import { buildScene, TAVERN } from "./scene.ts";
import {
  type SeamCtx,
  maybeOpenScene,
  playCard,
} from "./seams.ts";
import {
  AUGUR_SESSION_FORMAT_VERSION,
  type SerializedSession,
  SessionTree,
} from "./tree.ts";
import { entryToWire, sceneToWire, treeToWire } from "./wire.ts";
import { slotForHour, todayUtc } from "./daily-plan.ts";
import { generateRoomPlan, type RoomPlan } from "./room-plan.ts";
import { parseAiResponse } from "./ai-util.ts";
import {
  type SceneAgentState,
  type SceneAction,
  type SceneEvent,
  type SpawnedNpcSeed,
  STORAGE_AGENTS,
  STORAGE_EVENT_BUS,
  dispatchDueAgents,
} from "./scene-agents.ts";
import {
  buildNpcAgentState,
  npcAgentId,
  parseSpawnPayload,
  seedNpcAgents,
} from "./npc-agent.ts";
import {
  DIRECTOR_AGENT_ID,
  seedDirectorAgent,
} from "./director-agent.ts";

export interface HearthEnv {
  HEARTH: DurableObjectNamespace;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_KEY: string;
  AI: Ai;
}

const STORAGE_TREE = "tree";
const STORAGE_FOOTSTEPS = "footsteps";
const STORAGE_USERID = "userId";
const STORAGE_ROOMID = "roomId";
const STORAGE_ROOM_PROMPT = "roomPrompt";
const STORAGE_INHERITED_MEMORY = "inheritedMemory";
const STORAGE_ANCHORS = "anchors";
const STORAGE_DAILY_PLAN = "dailyPlan";
const STORAGE_CLOCK = "clock";
const STORAGE_SPAWN_COUNT = "spawnCount";
const STORAGE_INVITE = "inviteToken";
const STORAGE_DIFFICULTY = "difficulty";
const STORAGE_LAST_INPUT_AT = "lastInputAt";
const STORAGE_LAST_ALARM_AT = "lastAlarmAt";
const STORAGE_PLAN_GENERATED_AT = "planGeneratedAt";
const SPAWN_CAP_PER_DAY = 2;
const INITIAL_FOOTSTEPS = 8;
const HOURS_PER_RUN = 2;
const DEFAULT_DIFFICULTY: Difficulty = "resident";

/**
 * Phase 5 — per-difficulty soft/hard run cutoffs. Tourist pacing is loose
 * enough that a session can stay open all afternoon; native is the old
 * 25-min hard ceiling; resident splits the difference with a long tail.
 */
const CUTOFFS: Record<Difficulty, { softMs: number; hardMs: number }> = {
  tourist: { softMs: 60 * 60 * 1000, hardMs: 8 * 60 * 60 * 1000 },
  resident: { softMs: 15 * 60 * 1000, hardMs: 8 * 60 * 60 * 1000 },
  native: { softMs: 15 * 60 * 1000, hardMs: 25 * 60 * 1000 },
};

interface SocketAttachment {
  userId: string;
  roomId: string;
  role: PeerRole;
  peerId: string;
  displayName: string;
  joinedAt: number;
}

export class Hearth implements DurableObject {
  private state: DurableObjectState;
  private env: HearthEnv;
  private tree: SessionTree | null = null;
  private footsteps = INITIAL_FOOTSTEPS;
  private userId = "anonymous";
  private roomId = "default";
  private roomPrompt = "";
  private inheritedMemory = "";
  private anchors: string[] = [];
  private dailyPlan: RoomPlan | null = null;
  private clock: RunClock | null = null;
  private inviteToken = "";
  private difficulty: Difficulty = DEFAULT_DIFFICULTY;
  private lastInputAt: number | null = null;
  private lastAlarmAt: number | null = null;
  private planGeneratedAt: number | null = null;
  private loaded: Promise<void>;

  constructor(state: DurableObjectState, env: HearthEnv) {
    this.state = state;
    this.env = env;
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    const raw = (await this.state.storage.get<SerializedSession>(STORAGE_TREE)) ?? null;
    if (raw && raw.version === AUGUR_SESSION_FORMAT_VERSION) {
      this.tree = SessionTree.fromJSON(raw);
    } else {
      this.tree = new SessionTree();
    }
    this.footsteps =
      (await this.state.storage.get<number>(STORAGE_FOOTSTEPS)) ?? INITIAL_FOOTSTEPS;
    this.userId =
      (await this.state.storage.get<string>(STORAGE_USERID)) ?? "anonymous";
    this.roomId =
      (await this.state.storage.get<string>(STORAGE_ROOMID)) ?? "default";
    this.roomPrompt =
      (await this.state.storage.get<string>(STORAGE_ROOM_PROMPT)) ?? "";
    this.inheritedMemory =
      (await this.state.storage.get<string>(STORAGE_INHERITED_MEMORY)) ?? "";
    this.anchors =
      (await this.state.storage.get<string[]>(STORAGE_ANCHORS)) ?? [];
    this.dailyPlan =
      (await this.state.storage.get<RoomPlan>(STORAGE_DAILY_PLAN)) ?? null;
    this.clock =
      (await this.state.storage.get<RunClock>(STORAGE_CLOCK)) ?? null;
    this.inviteToken =
      (await this.state.storage.get<string>(STORAGE_INVITE)) ?? "";
    this.difficulty =
      (await this.state.storage.get<Difficulty>(STORAGE_DIFFICULTY)) ??
      DEFAULT_DIFFICULTY;
    this.lastInputAt =
      (await this.state.storage.get<number>(STORAGE_LAST_INPUT_AT)) ?? null;
    this.lastAlarmAt =
      (await this.state.storage.get<number>(STORAGE_LAST_ALARM_AT)) ?? null;
    this.planGeneratedAt =
      (await this.state.storage.get<number>(STORAGE_PLAN_GENERATED_AT)) ??
      null;
  }

  private async persist(): Promise<void> {
    if (!this.tree) return;
    const sceneId = this.dailyPlan ? `day-${this.dailyPlan.date}` : TAVERN.id;
    await this.state.storage.put(
      STORAGE_TREE,
      this.tree.toJSON(`${this.userId}:${this.roomId}:${sceneId}`),
    );
    await this.state.storage.put(STORAGE_FOOTSTEPS, this.footsteps);
    await this.state.storage.put(STORAGE_USERID, this.userId);
    await this.state.storage.put(STORAGE_ROOMID, this.roomId);
    await this.state.storage.put(STORAGE_ROOM_PROMPT, this.roomPrompt);
    await this.state.storage.put(STORAGE_INHERITED_MEMORY, this.inheritedMemory);
    await this.state.storage.put(STORAGE_ANCHORS, this.anchors);
    if (this.dailyPlan) await this.state.storage.put(STORAGE_DAILY_PLAN, this.dailyPlan);
    if (this.clock) await this.state.storage.put(STORAGE_CLOCK, this.clock);
    if (this.inviteToken) {
      await this.state.storage.put(STORAGE_INVITE, this.inviteToken);
    }
    await this.state.storage.put(STORAGE_DIFFICULTY, this.difficulty);
    if (this.lastInputAt !== null) {
      await this.state.storage.put(STORAGE_LAST_INPUT_AT, this.lastInputAt);
    }
    if (this.lastAlarmAt !== null) {
      await this.state.storage.put(STORAGE_LAST_ALARM_AT, this.lastAlarmAt);
    }
    if (this.planGeneratedAt !== null) {
      await this.state.storage.put(
        STORAGE_PLAN_GENERATED_AT,
        this.planGeneratedAt,
      );
    }
  }

  async fetch(req: Request): Promise<Response> {
    await this.loaded;
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId") ?? "anonymous";
    const roomId = url.searchParams.get("roomId") ?? this.roomId;
    this.userId = userId;
    this.roomId = roomId;

    // Optional room context: a one-shot handoff so the DO knows what the
    // room IS (premise) and which named positions agents can occupy.
    // Last write wins — re-sending after a room edit updates the DO.
    const promptParam = url.searchParams.get("prompt");
    if (promptParam !== null) this.roomPrompt = promptParam;
    // Building-wide memory (previous floors' story + surviving roster +
    // ghosts). Last write wins so the client can refresh continuity when
    // the building evolves.
    const memoryParam = url.searchParams.get("memory");
    if (memoryParam !== null) this.inheritedMemory = memoryParam;
    const anchorsParam = url.searchParams.get("anchors");
    if (anchorsParam !== null) {
      this.anchors = anchorsParam
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
    }

    // Cron-triggered daily wake-up. No WebSocket; just ensure today's plan
    // exists so the scene is alive when (and whether) the player connects.
    // Phase 1 will hook the alarm dispatcher in here.
    if (url.pathname === "/wake") {
      await this.ensureDailyPlan();
      return new Response(null, { status: 204 });
    }

    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    await this.ensureInviteToken();

    // Determine role from the invite query param. No ?inv → owner; valid
    // ?inv=<token> → observer; wrong token → 403 (don't leak which rooms
    // even exist by giving a friendlier message).
    const inv = url.searchParams.get("inv");
    let role: PeerRole = "owner";
    if (inv) {
      if (inv !== this.inviteToken) {
        return new Response("invalid invite", { status: 403 });
      }
      role = "observer";
    }

    // Single-owner enforcement: relaxed from "one socket total" to "one
    // owner + N observers." A new owner kicks the prior owner; observers
    // stack freely. This lets a player share a link without self-kicking.
    if (role === "owner") {
      for (const old of this.state.getWebSockets()) {
        const a = old.deserializeAttachment() as SocketAttachment | undefined;
        if (!a || a.role !== "owner") continue;
        try {
          old.send(
            JSON.stringify({
              type: "kicked",
              reason: "another-connection",
            } satisfies ServerMessage),
          );
        } catch {
          // ignore
        }
        try {
          old.close(1000, "another-connection");
        } catch {
          // ignore
        }
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const peerId = crypto.randomUUID();
    const attachment: SocketAttachment = {
      userId,
      roomId,
      role,
      peerId,
      displayName: mintDisplayName(peerId),
      joinedAt: Date.now(),
    };
    this.state.acceptWebSocket(server);
    server.serializeAttachment(attachment);

    // Fire-and-forget the plan/narration work so the 101 response returns
    // immediately. If we await this, the WebSocket stays in CONNECTING on
    // the client for the full 5–30s it takes to generate the room plan
    // and opening narration — which looks exactly like "UPLINK stuck."
    // The hello frame is sent over `server` once the async work finishes;
    // the client already has an OPEN socket by then and just receives it.
    this.ensureRunStartedAndHello(server)
      .then(() => {
        this.broadcast({ type: "presence-changed", peers: this.peers() });
      })
      .catch((err) => {
        console.error("[hearth] ensureRunStartedAndHello failed:", err);
        // Close with a non-1000 code so useHearth triggers its reconnect
        // backoff — a transient LLM failure shouldn't leave the client
        // stranded without any signal.
        try {
          server.close(1011, "boot-failed");
        } catch {
          // socket already gone
        }
      });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async ensureInviteToken(): Promise<void> {
    if (this.inviteToken) return;
    this.inviteToken = crypto.randomUUID();
    await this.state.storage.put(STORAGE_INVITE, this.inviteToken);
  }

  private peers(): PeerInfo[] {
    const out: PeerInfo[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as SocketAttachment | undefined;
      if (!a) continue;
      out.push({
        peerId: a.peerId,
        role: a.role,
        displayName: a.displayName,
        joinedAt: a.joinedAt,
      });
    }
    return out;
  }

  private healthSnapshot(): HealthSnapshot {
    return {
      planSource: this.dailyPlan?.source ?? "procedural",
      planGeneratedAt: this.planGeneratedAt,
      lastAlarmAt: this.lastAlarmAt,
      nextAlarmAt: null,
    };
  }

  /**
   * Prepare the daily plan + run clock for this connection, then send `hello`.
   * New UTC day → regenerate plan + reset tree + footsteps. Same day → advance
   * the in-game clock for a new run. Always stamps a fresh runStartedAt.
   */
  private async ensureRunStartedAndHello(ws: WebSocket): Promise<void> {
    if (!this.tree) this.tree = new SessionTree();
    const today = todayUtc();

    if (!this.dailyPlan || this.dailyPlan.date !== today) {
      this.dailyPlan = await generateRoomPlan(
        this.env,
        today,
        this.roomPrompt,
        this.inheritedMemory,
      );
      this.planGeneratedAt = Date.now();
      // The plan now owns the anchor list — keep STORAGE_ANCHORS in sync so
      // re-connects with the same room don't blow it away with a stale param.
      this.anchors = Object.keys(this.dailyPlan.anchors);
      this.tree = new SessionTree();
      this.footsteps = INITIAL_FOOTSTEPS;
      this.clock = {
        gameHour: this.dailyPlan.openingHour,
        gameMinute: 0,
        runStartedAt: Date.now(),
      };
      // New day → fresh agent registry + empty event bus + spawn count +
      // missed-events cursor. Difficulty and invite token survive the day.
      await this.state.storage.delete(STORAGE_AGENTS);
      await this.state.storage.delete(STORAGE_EVENT_BUS);
      await this.state.storage.delete(STORAGE_SPAWN_COUNT);
      this.lastInputAt = null;
      await this.state.storage.delete(STORAGE_LAST_INPUT_AT);
    } else {
      const prevHour = this.clock?.gameHour ?? this.dailyPlan.openingHour;
      if (prevHour >= this.dailyPlan.closingHour) {
        // Day already complete on this DO. Don't advance, don't reset, don't
        // re-fire run-ended (that would close the socket and the client would
        // reconnect, looping forever). Just refresh runStartedAt so any
        // elapsed-time math against this clock is sane.
        this.clock = { ...this.clock!, runStartedAt: Date.now() };
      } else {
        const nextHour = Math.min(
          this.dailyPlan.closingHour,
          prevHour + HOURS_PER_RUN,
        );
        this.clock = {
          gameHour: nextHour,
          gameMinute: 0,
          runStartedAt: Date.now(),
        };
        this.footsteps = INITIAL_FOOTSTEPS;
      }
    }
    await this.persist();

    if (!this.isDayComplete()) {
      const ctx = this.makeCtx(() => {});
      const opened = await maybeOpenScene(ctx);
      if (opened) await this.persist();
    }

    await this.sendHello(ws);
    await this.ensureAlarmArmed();
  }

  private isDayComplete(): boolean {
    return (
      !!this.dailyPlan &&
      !!this.clock &&
      this.clock.gameHour >= this.dailyPlan.closingHour
    );
  }

  /**
   * Player-less daily wake. Called by the cron-triggered /wake fetch.
   * Ensures today's plan exists and the dispatcher alarm is armed so the
   * scene runs autonomously even with no player connected. Does NOT send
   * hello (no socket), does NOT open the scene narration.
   */
  private async ensureDailyPlan(): Promise<void> {
    if (!this.tree) this.tree = new SessionTree();
    const today = todayUtc();
    if (!this.dailyPlan || this.dailyPlan.date !== today) {
      this.dailyPlan = await generateRoomPlan(
        this.env,
        today,
        this.roomPrompt,
        this.inheritedMemory,
      );
      this.planGeneratedAt = Date.now();
      // The plan now owns the anchor list — keep STORAGE_ANCHORS in sync so
      // re-connects with the same room don't blow it away with a stale param.
      this.anchors = Object.keys(this.dailyPlan.anchors);
      this.tree = new SessionTree();
      this.footsteps = INITIAL_FOOTSTEPS;
      this.clock = {
        gameHour: this.dailyPlan.openingHour,
        gameMinute: 0,
        runStartedAt: Date.now(),
      };
      // New day → fresh agent registry + empty event bus + spawn count.
      await this.state.storage.delete(STORAGE_AGENTS);
      await this.state.storage.delete(STORAGE_EVENT_BUS);
      await this.state.storage.delete(STORAGE_SPAWN_COUNT);
      this.lastInputAt = null;
      await this.state.storage.delete(STORAGE_LAST_INPUT_AT);
      await this.persist();
    }
    await this.ensureAlarmArmed();
  }

  /**
   * Seed the agent registry if empty and arm the DO alarm to whichever
   * agent is due soonest. Idempotent — safe to call from /wake, from
   * player connect, and on every alarm re-arm.
   *
   * Skips arming if there's no daily plan yet (nothing to seed against);
   * the next call after the plan is generated will arm.
   */
  private async ensureAlarmArmed(): Promise<void> {
    if (!this.dailyPlan) return;
    const agents =
      (await this.state.storage.get<Record<string, SceneAgentState>>(
        STORAGE_AGENTS,
      )) ?? {};
    const before = Object.keys(agents).length;
    seedNpcAgents(agents, this.dailyPlan, Date.now());
    seedDirectorAgent(agents, Date.now());
    if (Object.keys(agents).length !== before) {
      await this.state.storage.put(STORAGE_AGENTS, agents);
    }
    if (Object.keys(agents).length === 0) return;
    const minWake = Math.min(
      ...Object.values(agents).map((a) => a.nextWakeAt),
    );
    await this.state.storage.setAlarm(minWake);
  }

  /**
   * DO alarm handler — fires when the next due agent's self-chosen wake
   * time arrives. Calls the bare-minimum dispatcher and re-arms to the
   * new minimum. The dispatcher itself never broadcasts a "tick" — the
   * only thing observers see is what agents themselves stream.
   */
  async alarm(): Promise<void> {
    await this.loaded;
    const now = Date.now();
    console.log(`[hearth] alarm fired at ${new Date(now).toISOString()}`);
    this.lastAlarmAt = now;
    await this.state.storage.put(STORAGE_LAST_ALARM_AT, now);
    this.broadcast({ type: "health-snapshot", health: this.healthSnapshot() });
    // Forward-migration: DOs seeded before the director existed have NPCs but
    // no director entry. Seeding is idempotent, so calling on every alarm is
    // safe and ensures the director shows up on the next wake.
    if (this.dailyPlan) {
      const agents =
        (await this.state.storage.get<Record<string, SceneAgentState>>(
          STORAGE_AGENTS,
        )) ?? {};
      const before = Object.keys(agents).length;
      seedDirectorAgent(agents, now);
      if (Object.keys(agents).length !== before) {
        await this.state.storage.put(STORAGE_AGENTS, agents);
      }
    }
    const next = await dispatchDueAgents({
      now,
      storage: this.state.storage,
      env: this.env,
      broadcast: (msg) => this.broadcast(msg),
      dailyPlan: this.dailyPlan,
      clock: this.clock,
      anchors: this.anchors,
      roomPrompt: this.roomPrompt,
      difficulty: this.difficulty,
      onSpawn: (spawnerId, action, spawnNow) =>
        this.handleSpawn(spawnerId, action, spawnNow),
    });
    if (next === null) {
      console.log("[hearth] no agents registered; alarm not re-armed");
      return;
    }
    await this.state.storage.setAlarm(next);
    const deltaSec = Math.max(0, Math.round((next - now) / 1000));
    console.log(`[scene-agents] re-armed for +${deltaSec}s`);
  }

  /**
   * Handle a `spawn` action emitted by an existing agent. Enforces the
   * per-day cap, parses the persona, mutates `dailyPlan.npcs` so future
   * `hello` messages include the new arrival, and returns the seed for
   * the dispatcher to register. Returns null when rejected.
   */
  private async handleSpawn(
    spawnerId: string,
    action: SceneAction,
    now: number,
  ): Promise<SpawnedNpcSeed | null> {
    if (!this.dailyPlan) return null;
    const count =
      (await this.state.storage.get<number>(STORAGE_SPAWN_COUNT)) ?? 0;
    if (count >= SPAWN_CAP_PER_DAY) {
      console.log(
        `[hearth] spawn rejected from ${spawnerId}: cap ${SPAWN_CAP_PER_DAY} reached`,
      );
      return null;
    }
    const validAnchors = Object.keys(this.dailyPlan.anchors ?? {});
    const npc = parseSpawnPayload(action.text, validAnchors);
    if (!npc) {
      console.log(
        `[hearth] spawn rejected from ${spawnerId}: malformed payload`,
      );
      return null;
    }
    if (this.dailyPlan.npcs.some((n) => n.name === npc.name)) {
      console.log(
        `[hearth] spawn rejected from ${spawnerId}: name collision "${npc.name}"`,
      );
      return null;
    }
    this.dailyPlan = {
      ...this.dailyPlan,
      npcs: [...this.dailyPlan.npcs, npc],
    };
    await this.state.storage.put(STORAGE_DAILY_PLAN, this.dailyPlan);
    await this.state.storage.put(STORAGE_SPAWN_COUNT, count + 1);
    return {
      agentId: npcAgentId(npc.name),
      npc,
      state: buildNpcAgentState(npc, now),
    };
  }

  /**
   * Fan a message out to every connected socket in the room. Phase 1 only
   * carries `agent-decided` messages; Phase 2 adds streaming `agent-thinking`
   * deltas. The room is multi-observer — the same message reaches every
   * peer (Phase 4 makes this user-visible).
   */
  private broadcast(msg: Record<string, unknown>): void {
    const json = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(json);
      } catch {
        // ignore — peer probably gone
      }
    }
  }

  private currentScene() {
    if (!this.dailyPlan || !this.clock) {
      return this.anchors.length > 0
        ? { ...TAVERN, anchors: this.anchors }
        : TAVERN;
    }
    return buildScene(this.dailyPlan, this.clock, {
      anchors: this.anchors.length > 0 ? this.anchors : undefined,
    });
  }

  private async sendHello(ws: WebSocket): Promise<void> {
    if (!this.tree || !this.dailyPlan || !this.clock) return;
    const attachment = ws.deserializeAttachment() as
      | SocketAttachment
      | undefined;
    const missedEvents = await this.computeMissedEvents();
    const msg: ServerMessage = {
      type: "hello",
      userId: this.userId,
      roomId: this.roomId,
      scene: sceneToWire(this.currentScene()),
      hand: computeHand(this.tree, this.footsteps),
      tree: treeToWire(this.tree),
      footsteps: this.footsteps,
      dailyPlan: this.dailyPlan,
      clock: this.clock,
      dayComplete: this.isDayComplete(),
      role: attachment?.role ?? "owner",
      peerId: attachment?.peerId ?? "",
      displayName: attachment?.displayName ?? "",
      inviteToken: this.inviteToken,
      peers: this.peers(),
      health: this.healthSnapshot(),
      difficulty: this.difficulty,
      missedEvents,
    };
    safeSend(ws, msg);
  }

  /**
   * Phase 5 — compute the slice of bus events that landed since the owner's
   * last card play. Only the owner sees these (observers get an empty list
   * since they don't own the "you missed these while away" arc). Actions
   * are summarized so the client doesn't have to understand SceneEvent.
   */
  private async computeMissedEvents(): Promise<MissedEvent[]> {
    const since = this.lastInputAt;
    if (since === null) return [];
    const bus =
      (await this.state.storage.get<SceneEvent[]>(STORAGE_EVENT_BUS)) ?? [];
    return bus
      .filter((e) => e.at > since && !e.agentId.startsWith("player:"))
      .map((e) => ({
        at: e.at,
        agentId: e.agentId,
        reason: e.reason,
        actionType: e.action?.type,
        actionText: e.action?.text,
      }));
  }

  private makeCtx(onToken: (delta: string, turnId: string) => void): SeamCtx {
    const scene = this.currentScene();
    return {
      accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
      apiKey: this.env.CLOUDFLARE_API_KEY,
      sessionId: `${this.userId}:${this.roomId}:${scene.id}`,
      scene,
      tree: this.tree!,
      onToken: (delta) => onToken(delta, "pending"),
      dailyPlan: this.dailyPlan ?? undefined,
      clock: this.clock ?? undefined,
    };
  }

  // ── Hibernatable WebSocket lifecycle ─────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.loaded;
    if (typeof message !== "string") return;
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message);
    } catch {
      safeSend(ws, { type: "error", message: "invalid json" });
      return;
    }

    if (parsed.type === "ping") return;

    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    const role: PeerRole = attachment?.role ?? "owner";

    if (parsed.type === "play") {
      if (role !== "owner") {
        safeSend(ws, {
          type: "error",
          message: "observers cannot play cards",
          code: "observer-readonly",
        });
        return;
      }
      await this.handlePlay(ws, parsed.cardId);
      return;
    }

    if (parsed.type === "set-difficulty") {
      if (role !== "owner") {
        safeSend(ws, {
          type: "error",
          message: "only the owner can change difficulty",
          code: "observer-readonly",
        });
        return;
      }
      await this.handleSetDifficulty(parsed.difficulty);
      return;
    }

    if (parsed.type === "rotate-invite") {
      if (role !== "owner") {
        safeSend(ws, {
          type: "error",
          message: "only the owner can rotate the invite",
          code: "observer-readonly",
        });
        return;
      }
      await this.handleRotateInvite();
      return;
    }

    safeSend(ws, { type: "error", message: `unknown message type: ${(parsed as any).type}` });
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try {
      ws.close();
    } catch {
      // ignore
    }
    this.broadcast({ type: "presence-changed", peers: this.peers() });
  }

  async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    try {
      ws.close();
    } catch {
      // ignore
    }
    this.broadcast({ type: "presence-changed", peers: this.peers() });
  }

  private async handleSetDifficulty(next: Difficulty): Promise<void> {
    if (next !== "tourist" && next !== "resident" && next !== "native") return;
    if (next === this.difficulty) return;
    this.difficulty = next;
    await this.state.storage.put(STORAGE_DIFFICULTY, next);
    // Refresh every socket's hello so the client sees the new difficulty +
    // (because cutoffs may have changed) any new soft-warning timing.
    for (const ws of this.state.getWebSockets()) {
      await this.sendHello(ws);
    }
  }

  private async handleRotateInvite(): Promise<void> {
    this.inviteToken = crypto.randomUUID();
    await this.state.storage.put(STORAGE_INVITE, this.inviteToken);
    this.broadcast({ type: "invite-rotated", inviteToken: this.inviteToken });
  }

  private async handlePlay(ws: WebSocket, cardId: string): Promise<void> {
    if (!this.tree || !this.clock || !this.dailyPlan) {
      safeSend(ws, { type: "error", message: "run not initialized" });
      return;
    }
    if (this.isDayComplete()) {
      safeSend(ws, {
        type: "error",
        message: "today's run is complete; come back tomorrow",
      });
      return;
    }

    const { softMs, hardMs } = CUTOFFS[this.difficulty];
    const elapsed = Date.now() - this.clock.runStartedAt;
    if (elapsed >= hardMs) {
      await this.endRun(ws, "time");
      return;
    }
    if (elapsed >= softMs && !this.clock.softWarnedAt) {
      this.clock.softWarnedAt = Date.now();
      await this.state.storage.put(STORAGE_CLOCK, this.clock);
      safeSend(ws, {
        type: "soft-warning",
        remainingMs: hardMs - elapsed,
      });
    }

    const hand = computeHand(this.tree, this.footsteps);
    const card = hand.find((c) => c.id === cardId);
    if (!card) {
      safeSend(ws, { type: "error", message: `unknown card: ${cardId}` });
      return;
    }
    if (!card.playable) {
      safeSend(ws, { type: "error", message: `card not playable: ${cardId}` });
      return;
    }

    const turnId = `t${Date.now()}`;
    const ctx: SeamCtx = {
      ...this.makeCtx(() => {}),
      onToken: (delta) => safeSend(ws, { type: "token", delta, turnId }),
    };

    let entry;
    try {
      entry = await playCard(ctx, cardId);
    } catch (err) {
      safeSend(ws, {
        type: "error",
        message: err instanceof Error ? err.message : "seam failed",
      });
      return;
    }

    this.footsteps = Math.max(0, this.footsteps - card.footsteps);
    await this.persist();

    safeSend(ws, { type: "entry", entry: entryToWire(entry), turnId });
    safeSend(ws, {
      type: "tree",
      tree: treeToWire(this.tree),
      footsteps: this.footsteps,
      hand: computeHand(this.tree, this.footsteps),
    });

    await this.recordPlayerInputAndPokeDirector(card);

    if (this.footsteps <= 0) {
      await this.endRun(ws, "footsteps");
    }
  }

  /**
   * Post a `player:<userId>` event onto the room's event bus and set the
   * director's next-wake to now so it wakes within the next alarm tick.
   * The director is still free to return `action: null` — this is purely
   * "wake the director soon so it can decide," not a puppet command.
   */
  private async recordPlayerInputAndPokeDirector(card: {
    fiction?: string;
    mechanic?: string;
  }): Promise<void> {
    const now = Date.now();
    const fiction = card.fiction?.trim() || "(no fiction)";
    const mechanic = card.mechanic?.trim() || "";
    const reason = mechanic
      ? `played "${fiction}" (${mechanic})`
      : `played "${fiction}"`;
    const event: SceneEvent = {
      at: now,
      agentId: `player:${this.userId}`,
      reason,
      action: null,
    };
    const bus =
      (await this.state.storage.get<SceneEvent[]>(STORAGE_EVENT_BUS)) ?? [];
    bus.push(event);
    while (bus.length > 30) bus.shift();
    await this.state.storage.put(STORAGE_EVENT_BUS, bus);

    this.lastInputAt = now;
    await this.state.storage.put(STORAGE_LAST_INPUT_AT, now);

    const agents =
      (await this.state.storage.get<Record<string, SceneAgentState>>(
        STORAGE_AGENTS,
      )) ?? {};
    const director = agents[DIRECTOR_AGENT_ID];
    if (director) {
      director.nextWakeAt = now;
      await this.state.storage.put(STORAGE_AGENTS, agents);
      await this.state.storage.setAlarm(now);
    }
  }

  /**
   * Compose a one-line epitaph and close the socket. Reuses env.AI directly
   * (same llama model as /api/rpg/epitaph) with a short prompt.
   */
  private async endRun(
    ws: WebSocket,
    reason: "time" | "footsteps" | "schedule",
  ): Promise<void> {
    const epitaph = await this.runEpitaph(reason);
    safeSend(ws, { type: "run-ended", reason, epitaph });
    try {
      ws.close(1000, `run-ended:${reason}`);
    } catch {
      // ignore
    }
  }

  private async runEpitaph(
    reason: "time" | "footsteps" | "schedule",
  ): Promise<string> {
    if (!this.dailyPlan || !this.clock) return "The room is quiet now.";
    const residentLines = this.dailyPlan.npcs
      .map((n) => {
        const slot = slotForHour(n, this.clock!.gameHour);
        return `${n.name} (${slot?.activity ?? "present"})`;
      })
      .join("; ");
    const reasonLine =
      reason === "time"
        ? "The Claw's visit ran long."
        : reason === "footsteps"
          ? "The Claw ran out of footsteps."
          : "The room closed for the day.";
    const userPrompt = [
      `Room: ${TAVERN.location}. It is ${this.clock.gameHour}:00 on ${this.dailyPlan.dayOfWeek}.`,
      `Today's objective: ${this.dailyPlan.playerObjective}`,
      `Residents: ${residentLines}`,
      reasonLine,
      `Compose one line, under 100 characters, carved-in-stone plain. Past tense. Return STRICT JSON {"epitaph":"..."}.`,
    ].join("\n");
    try {
      const ai = (await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [
          {
            role: "system",
            content:
              "You compose one-line epitaphs for a quiet tabletop RPG. No adjectives. Past tense. Return STRICT JSON {\"epitaph\":\"...\"}.",
          },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 120,
        temperature: 0.7,
      } as never)) as unknown;
      const parsed = parseAiResponse(ai);
      const epi = parsed && typeof parsed === "object"
        ? (parsed as { epitaph?: unknown }).epitaph
        : null;
      if (typeof epi === "string" && epi.trim()) {
        return epi.trim().slice(0, 120);
      }
    } catch {
      // fall through to fallback
    }
    return reason === "time"
      ? "The candle guttered. They stayed anyway."
      : reason === "footsteps"
        ? "The Claw sat down. There was nothing else to give."
        : "The lantern went out. The day was done.";
  }
}

function safeSend(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // ignore — client probably gone
  }
}

/**
 * Deterministic two-word handle from a peerId. Same peerId → same handle
 * for the life of that socket, so "jade-otter joined" / "jade-otter left"
 * line up without the server tracking a separate name-map.
 */
const DISPLAY_ADJECTIVES = [
  "jade",
  "slate",
  "amber",
  "rust",
  "moss",
  "ash",
  "cinder",
  "pewter",
  "ochre",
  "copper",
  "ivory",
  "loam",
  "frost",
  "ember",
  "smoke",
  "sable",
];
const DISPLAY_NOUNS = [
  "otter",
  "fox",
  "heron",
  "thrush",
  "marten",
  "hare",
  "kite",
  "lynx",
  "owl",
  "jay",
  "stoat",
  "vole",
  "wren",
  "crane",
  "shrike",
  "badger",
];

function mintDisplayName(peerId: string): string {
  let h = 2166136261;
  for (let i = 0; i < peerId.length; i++) {
    h ^= peerId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = Math.abs(h) % DISPLAY_ADJECTIVES.length;
  const n = Math.abs(h >>> 8) % DISPLAY_NOUNS.length;
  return `${DISPLAY_ADJECTIVES[a]}-${DISPLAY_NOUNS[n]}`;
}
