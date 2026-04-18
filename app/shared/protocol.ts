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
 * A single named position inside a room — the addressable target of an
 * NPC's move action. `kind` distinguishes plain anchors from portal
 * endpoints; portals additionally list their counterpart in `leadsTo`.
 */
export interface ObjectWire {
  kind: "anchor" | "door" | "stair" | "spawn";
  name: string;
  /** Tile coordinates inside the room (0-indexed, integers). */
  x: number;
  y: number;
  /** Only set for portal objects; names the other end of the portal. */
  leadsTo?: { roomId: string; objectName: string };
}

export interface RoomWire {
  id: string;
  name: string;
  cols: number;
  rows: number;
  /**
   * 2D array of semantic tile keys, one per cell. Keys come from
   * `shared/tileset.ts#TILESET_KEYS`. Outer array is rows, inner is cols.
   */
  ground: string[][];
  /**
   * Collision grid — same shape as `ground`. `true` blocks movement.
   * Authored alongside ground so the client can seed pathfinding
   * without re-deriving walkability.
   */
  collision: boolean[][];
  objects: ObjectWire[];
}

export interface RoomPortalWire {
  from: { roomId: string; objectName: string };
  to: { roomId: string; objectName: string };
  bidirectional?: boolean;
}

export interface SceneWire {
  id: string;
  location: string;
  timeOfDay: "dawn" | "day" | "dusk" | "night";
  moods: string[];
  npcs: string[];
  /**
   * Flat list of anchor addresses agents may target. Single-room scenes
   * use bare names ("door", "hearth"); multi-room scenes may use the
   * dotted form "<roomId>.<objectName>".
   */
  anchors: string[];
  /**
   * Tileset pack the client should render with. Client refuses to render
   * unknown refs (falls back to stub tiles); worker-client mismatches are
   * explicit rather than silent corruption.
   */
  tilesetRef?: string;
  /** One or more rooms that make up this scene. Single-room in the v1 slice. */
  rooms?: RoomWire[];
  /**
   * Portal graph edges between rooms. Empty in the v1 slice (single-room).
   * Clients stitch rooms into a super-grid using these edges when present.
   */
  portals?: RoomPortalWire[];
  /** "ai" when the LLM authored this scene; "fallback" when procedural. */
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

/** One act in a 3-act story bible. The agents improvise scenes that serve
 *  this act's pressure; the director is responsible for advancing to the
 *  next act when the exit condition is met. */
export interface StoryAct {
  /** Short label — "Act I", "Act II", "Act III" or a thematic name. */
  name: string;
  /** One-sentence premise that frames every decision inside this act. */
  premise: string;
  /** The dramatic pressure agents lean into during this act. */
  pressure: string;
  /** 3–5 bullet beats the agents should aim to hit inside this act. */
  beats: string[];
  /** The condition that should trigger advance to the next act. */
  exit: string;
}

export interface StoryBible {
  logline: string;
  theme: string;
  acts: StoryAct[];
}

export interface StoryState {
  currentActIndex: number;
  actStartedAtGameHour: number;
  lastAdvanceReason?: string;
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
  /** 3-act story bible. Agents improvise inside the current act's pressure. */
  storyBible: StoryBible;
  /** Where the story is right now (current act + when it started). */
  storyState: StoryState;
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

/** The story advanced from one act to the next. */
export interface ServerStoryAdvanced {
  type: "story-advanced";
  storyState: StoryState;
}

/** Ack that a player directive was accepted and queued for the next
 *  dispatch. Mostly so the client can light up the input and echo back. */
export interface ServerDirectiveAccepted {
  type: "directive-accepted";
  text: string;
  at: number;
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
  | ServerInviteRotated
  | ServerStoryAdvanced
  | ServerDirectiveAccepted;

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

/** Owner typed a "what happens next?" directive. Pushed as a high-salience
 *  SceneEvent for the next dispatch so NPCs + director see and react inside
 *  the current act's pressure. */
export interface ClientDirective {
  type: "player-directive";
  text: string;
}

export type ClientMessage =
  | ClientPlay
  | ClientPing
  | ClientSetDifficulty
  | ClientRotateInvite
  | ClientDirective;
