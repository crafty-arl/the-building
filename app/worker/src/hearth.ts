/**
 * Hearth Durable Object — one per user.
 *
 * Owns the SessionTree, the daily plan + run clock, the footsteps counter,
 * and the live WebSocket. Persists to DO storage on every mutation. Uses
 * Hibernatable WebSockets so an idle session doesn't burn CPU.
 *
 * Runs are time-boxed to a hybrid 15-min soft / 25-min hard ceiling. The
 * daily plan is regenerated once per UTC calendar day; subsequent runs
 * within the same day advance the in-game clock (+2h per run, clamped).
 */

import type {
  ClientMessage,
  DailyPlan,
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
import { generateDailyPlan, slotForHour, todayUtc } from "./daily-plan.ts";
import { parseAiResponse } from "./ai-util.ts";

export interface HearthEnv {
  HEARTH: DurableObjectNamespace;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_KEY: string;
  AI: Ai;
}

const STORAGE_TREE = "tree";
const STORAGE_FOOTSTEPS = "footsteps";
const STORAGE_USERID = "userId";
const STORAGE_DAILY_PLAN = "dailyPlan";
const STORAGE_CLOCK = "clock";
const INITIAL_FOOTSTEPS = 8;
const HOURS_PER_RUN = 2;
const SOFT_WARNING_MS = 15 * 60 * 1000;
const HARD_CUTOFF_MS = 25 * 60 * 1000;

interface SocketAttachment {
  userId: string;
  acceptedAt: number;
}

export class Hearth implements DurableObject {
  private state: DurableObjectState;
  private env: HearthEnv;
  private tree: SessionTree | null = null;
  private footsteps = INITIAL_FOOTSTEPS;
  private userId = "anonymous";
  private dailyPlan: DailyPlan | null = null;
  private clock: RunClock | null = null;
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
    this.dailyPlan =
      (await this.state.storage.get<DailyPlan>(STORAGE_DAILY_PLAN)) ?? null;
    this.clock =
      (await this.state.storage.get<RunClock>(STORAGE_CLOCK)) ?? null;
  }

  private async persist(): Promise<void> {
    if (!this.tree) return;
    const sceneId = this.dailyPlan ? `day-${this.dailyPlan.date}` : TAVERN.id;
    await this.state.storage.put(
      STORAGE_TREE,
      this.tree.toJSON(`${this.userId}:${sceneId}`),
    );
    await this.state.storage.put(STORAGE_FOOTSTEPS, this.footsteps);
    await this.state.storage.put(STORAGE_USERID, this.userId);
    if (this.dailyPlan) await this.state.storage.put(STORAGE_DAILY_PLAN, this.dailyPlan);
    if (this.clock) await this.state.storage.put(STORAGE_CLOCK, this.clock);
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

    await this.ensureRunStartedAndHello(server);

    return new Response(null, { status: 101, webSocket: client });
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
      this.dailyPlan = await generateDailyPlan(this.env, today);
      this.tree = new SessionTree();
      this.footsteps = INITIAL_FOOTSTEPS;
      this.clock = {
        gameHour: this.dailyPlan.openingHour,
        gameMinute: 0,
        runStartedAt: Date.now(),
      };
    } else {
      const prevHour = this.clock?.gameHour ?? this.dailyPlan.openingHour;
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
    await this.persist();

    const ctx = this.makeCtx(() => {});
    const opened = await maybeOpenScene(ctx);
    if (opened) await this.persist();

    this.sendHello(ws);

    // If we're already at or past closing, end the run immediately.
    if (this.dailyPlan && this.clock.gameHour >= this.dailyPlan.closingHour) {
      await this.endRun(ws, "schedule");
    }
  }

  private currentScene() {
    if (!this.dailyPlan || !this.clock) return TAVERN;
    return buildScene(this.dailyPlan, this.clock);
  }

  private sendHello(ws: WebSocket): void {
    if (!this.tree || !this.dailyPlan || !this.clock) return;
    const msg: ServerMessage = {
      type: "hello",
      userId: this.userId,
      scene: sceneToWire(this.currentScene()),
      hand: computeHand(this.tree, this.footsteps),
      tree: treeToWire(this.tree),
      footsteps: this.footsteps,
      dailyPlan: this.dailyPlan,
      clock: this.clock,
    };
    safeSend(ws, msg);
  }

  private makeCtx(onToken: (delta: string, turnId: string) => void): SeamCtx {
    const scene = this.currentScene();
    return {
      accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
      apiKey: this.env.CLOUDFLARE_API_KEY,
      sessionId: `${this.userId}:${scene.id}`,
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
    if (!this.tree || !this.clock || !this.dailyPlan) {
      safeSend(ws, { type: "error", message: "run not initialized" });
      return;
    }

    const elapsed = Date.now() - this.clock.runStartedAt;
    if (elapsed >= HARD_CUTOFF_MS) {
      await this.endRun(ws, "time");
      return;
    }
    if (elapsed >= SOFT_WARNING_MS && !this.clock.softWarnedAt) {
      this.clock.softWarnedAt = Date.now();
      await this.state.storage.put(STORAGE_CLOCK, this.clock);
      safeSend(ws, {
        type: "soft-warning",
        remainingMs: HARD_CUTOFF_MS - elapsed,
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

    if (this.footsteps <= 0) {
      await this.endRun(ws, "footsteps");
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
