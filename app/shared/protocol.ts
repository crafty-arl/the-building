/**
 * Augur WebSocket protocol — contract between the React client and the Hearth DO.
 *
 * Client opens WS to /api/session. DO routes by dev user id (header or query for now).
 * Wire format is JSON text frames. No binary, no length prefix.
 *
 * Flow:
 *   1. Client connects → server sends `hello` with current tree, hand, scene, footsteps.
 *   2. Client sends `play {cardId}` → server runs the card's seam against Kimi/Llama.
 *   3. Server streams `token` frames as the assistant replies.
 *   4. Server sends `entry` when the turn is committed to the tree.
 *   5. Server sends `tree` whenever the tree or leaf changes (branches, forks).
 *   6. Server sends `kicked` if another connection takes over for this user.
 *   7. Any unrecoverable condition → `error` with a human message.
 */

export interface TreeEntryWire {
  id: string;
  parentId: string | null;
  card?: { id: string; mechanic: string };
  label?: string;
  timestamp: number;
  /** Concatenated assistant text — client doesn't need the full message array. */
  text: string;
  /** Usage summary for cost display, optional. */
  usage?: { input: number; output: number; cost: number; cacheRead?: number };
}

export interface TreeSnapshot {
  entries: TreeEntryWire[];
  leafId: string | null;
  facts: Record<string, string>;
  vows: string[];
}

export interface CardWire {
  id: string;
  rarity: string;
  fiction: string;
  effect: string;
  mechanic: string;
  footsteps: number;
  /** True if the card is currently playable given scene/restrictions/vows/footsteps. */
  playable: boolean;
}

/**
 * Renderer override for a non-native tilemap glyph. Only needed when the
 * room author introduces a glyph the engine doesn't already know about —
 * the native set (#, R, |, ~, w, b, t, c, l, =, ., space) renders without
 * a palette entry.
 */
export interface ScenePaletteEntry {
  name: string;
  /** #rrggbb hex. */
  color: string;
  walkable: boolean;
  glow?: boolean;
}

export interface SceneWire {
  id: string;
  location: string;
  timeOfDay: "dawn" | "day" | "dusk" | "night";
  moods: string[];
  npcs: string[];
  /** Named anchors — agents move by anchor name. */
  anchors: string[];
  /**
   * Hearth-authored room geometry. Present whenever the DO has built a
   * RoomPlan for this room (always, after Phase 6E.2). Clients use these
   * fields as the source of truth — local map authoring is gone.
   */
  tilemap?: string[];
  floorY?: number;
  /** name → [x, y] tile coords. Same names appear in `anchors`. */
  anchorCoords?: Record<string, [number, number]>;
  /** Glyph → renderer override. Omitted when room uses only native glyphs. */
  palette?: Record<string, ScenePaletteEntry>;
  /** "ai" when the LLM authored this room; "fallback" when procedural. */
  source?: "ai" | "fallback";
}

// ─── Daily plan ────────────────────────────────────────────────────────────

export interface ScheduleSlot {
  hour: number;
  activity: string;
  mood?: string;
}

export interface NpcDay {
  name: string;
  backstory: string;
  palette: string;
  objective: string;
  motive: string;
  schedule: ScheduleSlot[];
  /** Anchor name where this NPC starts the day. References SceneWire.anchors. */
  startAnchor?: string;
  /** True for NPCs that arrived via a `spawn` action mid-day, not the day plan. */
  transient?: boolean;
}

export interface DailyPlan {
  date: string;
  dayOfWeek: string;
  playerObjective: string;
  npcs: NpcDay[];
  openingHour: number;
  closingHour: number;
  seed: string;
}

export interface RunClock {
  gameHour: number;
  gameMinute: number;
  runStartedAt: number;
  softWarnedAt?: number;
}

// ─── Server → Client ───────────────────────────────────────────────────────

export interface ServerHello {
  type: "hello";
  userId: string;
  /** Room key. Each (userId, roomId) pair owns a distinct Hearth DO. */
  roomId: string;
  scene: SceneWire;
  hand: CardWire[];
  tree: TreeSnapshot;
  footsteps: number;
  dailyPlan: DailyPlan;
  clock: RunClock;
  /** True when today's in-game schedule has run out — client should show
   *  "come back tomorrow" rather than letting the player play. */
  dayComplete?: boolean;
  /** Phase 4 additions — peer identity, room invite, liveness snapshot. */
  role: PeerRole;
  peerId: string;
  displayName: string;
  inviteToken: string;
  peers: PeerInfo[];
  health: HealthSnapshot;
  /** Phase 5 — current room difficulty. */
  difficulty: Difficulty;
  /** Phase 5 — event-bus slice since this owner's last card play. */
  missedEvents: MissedEvent[];
}

export type PeerRole = "owner" | "observer";

export interface PeerInfo {
  peerId: string;
  role: PeerRole;
  displayName: string;
  joinedAt: number;
}

export interface HealthSnapshot {
  planSource: "ai" | "fallback" | "procedural";
  planGeneratedAt: number | null;
  lastAlarmAt: number | null;
  nextAlarmAt: number | null;
}

export type Difficulty = "tourist" | "resident" | "native";

export interface MissedEvent {
  at: number;
  agentId: string;
  reason: string;
  actionType?: string;
  actionText?: string;
}

export interface ServerSoftWarning {
  type: "soft-warning";
  remainingMs: number;
}

export interface ServerRunEnded {
  type: "run-ended";
  reason: "time" | "footsteps" | "schedule";
  epitaph: string;
}

export interface ServerToken {
  type: "token";
  /** Incremental assistant text for the turn-in-progress. */
  delta: string;
  /** Stable id so client can tell which pending entry this belongs to. */
  turnId: string;
}

export interface ServerEntry {
  type: "entry";
  entry: TreeEntryWire;
  turnId: string;
}

export interface ServerTree {
  type: "tree";
  tree: TreeSnapshot;
  footsteps: number;
  hand: CardWire[];
}

export interface ServerKicked {
  type: "kicked";
  reason: "another-connection";
}

export interface ServerError {
  type: "error";
  message: string;
  code?: string;
}

// ─── Autonomous-scene messages (Phase 2+) ──────────────────────────────────
// Self-aware agents stream their cognition through the WS room. Every socket
// in the room (player + observers) receives the same messages. The dispatcher
// itself never broadcasts — silence between agents is real silence.

/**
 * Named anchor in the room. Canvas maps each to an x-zone. Free-form so
 * each room can author its own anchor names; the legacy inn names
 * (door, fire, bar, table, window, stairs) are still valid values.
 */
export type ScenePosition = string;

export interface SceneAgentAction {
  type: string;
  text?: string;
  /** Where the character ends up after this beat. Optional. */
  position?: ScenePosition;
  payload?: unknown;
}

/** Per-token text delta from a streaming agent's reasoning. */
export interface ServerAgentThinking {
  type: "agent-thinking";
  agentId: string;
  delta: string;
}

/** An agent has finished thinking; final structured decision. */
export interface ServerAgentDecided {
  type: "agent-decided";
  agentId: string;
  action: SceneAgentAction | null;
  nextWakeAt: number;
  reason: string;
}

/**
 * A new transient NPC has joined the room mid-day via another agent's
 * `spawn` action. Sent immediately after the spawning agent's
 * `agent-decided` so observers can mint the new character without a
 * full re-hello. The new NPC is also persisted into `dailyPlan.npcs`,
 * so observers connecting later see them in the next `hello`.
 */
export interface ServerNpcSpawned {
  type: "npc-spawned";
  /** Agent id of the NEW NPC (npc:<slug>). */
  agentId: string;
  /** Agent id of the NPC who summoned them, if any. */
  spawnedBy?: string;
  npc: NpcDay;
}

/** Roster changed — a peer joined or left the room. */
export interface ServerPresenceChanged {
  type: "presence-changed";
  peers: PeerInfo[];
}

/** Periodic liveness snapshot, also included in hello. */
export interface ServerHealthSnapshot {
  type: "health-snapshot";
  health: HealthSnapshot;
}

/** Invite token rotated — older tokens no longer admit new joins. */
export interface ServerInviteRotated {
  type: "invite-rotated";
  inviteToken: string;
}

export type ServerMessage =
  | ServerHello
  | ServerToken
  | ServerEntry
  | ServerTree
  | ServerKicked
  | ServerError
  | ServerSoftWarning
  | ServerRunEnded
  | ServerAgentThinking
  | ServerAgentDecided
  | ServerNpcSpawned
  | ServerPresenceChanged
  | ServerHealthSnapshot
  | ServerInviteRotated;

// ─── Client → Server ───────────────────────────────────────────────────────

export interface ClientPlay {
  type: "play";
  cardId: string;
}

export interface ClientPing {
  type: "ping";
}

/** Owner-only: change the room's difficulty mode. */
export interface ClientSetDifficulty {
  type: "set-difficulty";
  difficulty: Difficulty;
}

/** Owner-only: rotate the invite token so old links stop admitting new peers. */
export interface ClientRotateInvite {
  type: "rotate-invite";
}

export type ClientMessage =
  | ClientPlay
  | ClientPing
  | ClientSetDifficulty
  | ClientRotateInvite;
