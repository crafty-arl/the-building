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

export interface SceneWire {
  id: string;
  location: string;
  timeOfDay: "dawn" | "day" | "dusk" | "night";
  moods: string[];
  npcs: string[];
}

// ─── Server → Client ───────────────────────────────────────────────────────

export interface ServerHello {
  type: "hello";
  userId: string;
  scene: SceneWire;
  hand: CardWire[];
  tree: TreeSnapshot;
  footsteps: number;
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

export type ServerMessage =
  | ServerHello
  | ServerToken
  | ServerEntry
  | ServerTree
  | ServerKicked
  | ServerError;

// ─── Client → Server ───────────────────────────────────────────────────────

export interface ClientPlay {
  type: "play";
  cardId: string;
}

export interface ClientPing {
  type: "ping";
}

export type ClientMessage = ClientPlay | ClientPing;
