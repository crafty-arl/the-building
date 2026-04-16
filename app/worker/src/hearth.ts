/**
 * Hearth Durable Object — one per user.
 *
 * Owns the SessionTree, the current scene (hardcoded TAVERN for now), the
 * footsteps counter, and the live WebSocket. Persists the tree to DO storage
 * on every mutation. Uses Hibernatable WebSockets so an idle session doesn't
 * burn CPU.
 */

import type {
  ClientMessage,
  ServerMessage,
} from "../../shared/protocol.ts";
import { computeHand } from "./hand.ts";
import { TAVERN } from "./scene.ts";
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

export interface HearthEnv {
  HEARTH: DurableObjectNamespace;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_KEY: string;
}

const STORAGE_TREE = "tree";
const STORAGE_FOOTSTEPS = "footsteps";
const STORAGE_USERID = "userId";
const INITIAL_FOOTSTEPS = 8;

interface SocketAttachment {
  userId: string;
  /** Wallclock when this socket was accepted, used to identify "the" active one. */
  acceptedAt: number;
}

export class Hearth implements DurableObject {
  private state: DurableObjectState;
  private env: HearthEnv;
  private tree: SessionTree | null = null;
  private footsteps = INITIAL_FOOTSTEPS;
  private userId = "anonymous";
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
  }

  private async persist(): Promise<void> {
    if (!this.tree) return;
    await this.state.storage.put(
      STORAGE_TREE,
      this.tree.toJSON(`${this.userId}:${TAVERN.id}`),
    );
    await this.state.storage.put(STORAGE_FOOTSTEPS, this.footsteps);
    await this.state.storage.put(STORAGE_USERID, this.userId);
  }

  async fetch(req: Request): Promise<Response> {
    await this.loaded;
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId") ?? "anonymous";
    this.userId = userId;

    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    // Single-connection enforcement: kick any existing socket FIRST.
    for (const old of this.state.getWebSockets()) {
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

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const attachment: SocketAttachment = { userId, acceptedAt: Date.now() };
    this.state.acceptWebSocket(server);
    server.serializeAttachment(attachment);

    // Open the scene if needed, then send hello.
    await this.ensureSceneOpenAndHello(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async ensureSceneOpenAndHello(ws: WebSocket): Promise<void> {
    if (!this.tree) this.tree = new SessionTree();
    const ctx = this.makeCtx((delta, turnId) => this.sendToken(ws, delta, turnId));
    // For scene-open we don't have a turnId yet, so swallow tokens.
    const tokenCollectorCtx: SeamCtx = { ...ctx, onToken: () => {} };
    const opened = await maybeOpenScene(tokenCollectorCtx);
    if (opened) await this.persist();
    this.sendHello(ws);
  }

  private sendHello(ws: WebSocket): void {
    if (!this.tree) return;
    const msg: ServerMessage = {
      type: "hello",
      userId: this.userId,
      scene: sceneToWire(TAVERN),
      hand: computeHand(this.tree, this.footsteps),
      tree: treeToWire(this.tree),
      footsteps: this.footsteps,
    };
    safeSend(ws, msg);
  }

  private sendToken(ws: WebSocket, delta: string, turnId: string): void {
    safeSend(ws, { type: "token", delta, turnId });
  }

  private makeCtx(onToken: (delta: string, turnId: string) => void): SeamCtx {
    return {
      accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
      apiKey: this.env.CLOUDFLARE_API_KEY,
      sessionId: `${this.userId}:${TAVERN.id}`,
      scene: TAVERN,
      tree: this.tree!,
      onToken: (delta) => onToken(delta, "pending"),
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

    if (parsed.type === "play") {
      await this.handlePlay(ws, parsed.cardId);
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
  }

  async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  private async handlePlay(ws: WebSocket, cardId: string): Promise<void> {
    if (!this.tree) {
      safeSend(ws, { type: "error", message: "tree not initialized" });
      return;
    }

    // Find the card to validate cost up front. Hand computation gives the
    // authoritative playability check.
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
      accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
      apiKey: this.env.CLOUDFLARE_API_KEY,
      sessionId: `${this.userId}:${TAVERN.id}`,
      scene: TAVERN,
      tree: this.tree,
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
  }
}

function safeSend(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // ignore — client probably gone
  }
}
