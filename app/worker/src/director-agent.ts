/**
 * Director agent — a peer SceneAgent alongside NPCs.
 *
 * The director is just another self-scheduling, self-streaming agent.
 * It reads the room's event bus (NPC decisions + player inputs), chooses
 * whether the scene needs a beat, and picks its own next-wake. It has
 * no authority to puppet NPCs directly; it fires a narrative event and
 * trusts the room (NPCs + player) to react to it on the bus.
 *
 * Player input is injected into the event bus by Hearth's `handlePlay`,
 * which also pokes the director's nextWakeAt to now. The director is
 * then free to react quickly — or to look at the input and decide "this
 * doesn't need a beat yet, come back in 60s." Both are correct.
 *
 * Module side-effect: `registerAgentKind(DIRECTOR_KIND)` runs at import
 * time so just importing this file makes the dispatcher able to run it.
 */

import { stream as piStream } from "@mariozechner/pi-ai";
import { kimi, STORYTELLERS, type StorytellerArchetype } from "@augur/agent";
import type { DailyPlan, Difficulty } from "../../shared/protocol.ts";
import { balanceJson } from "./ai-util.ts";
import {
  registerAgentKind,
  type SceneAction,
  type SceneAgentImpl,
  type SceneAgentState,
  type SceneEvent,
  type ThinkResult,
} from "./scene-agents.ts";

export const DIRECTOR_KIND = "director";
export const DIRECTOR_AGENT_ID = "director";

/**
 * The archetype the director inhabits for the day. Today hard-wired to
 * the Weaver — threads tie back, callbacks get paid off — since the
 * storyteller archetype lives in memory only. Later can be a roll or
 * a per-room choice. Kept centralized so prompts and decisions rhyme.
 */
const DEFAULT_ARCHETYPE_ID: keyof typeof STORYTELLERS = "weaver";

const MIN_CADENCE_SEC = 5;
const MAX_CADENCE_SEC = 600;
const DEFAULT_CADENCE_SEC = 60;
const MAX_TOKENS = 4000;
const RECENT_EVENTS_WINDOW = 14;

const ACTION_TYPES = new Set([
  "complication",
  "revelation",
  "pace-shift",
  "force-beat",
]);

function buildDirectorSystem(
  archetype: StorytellerArchetype,
  roomPrompt: string,
  difficulty: Difficulty,
): string {
  const roomLine =
    roomPrompt && roomPrompt.trim()
      ? `Room premise: ${roomPrompt.trim()}`
      : `Room premise: a small inn at the edge of the kingdom.`;
  const difficultyLine = directorDifficultyHint(difficulty);
  return [
    `You are ${archetype.name.toUpperCase()}, the DIRECTOR of a live persistent scene.`,
    `Your domain: ${archetype.domain}.`,
    `Your temperament: ${archetype.temperament}`,
    `Your pacing rule: ${archetype.pacingRule}`,
    ``,
    `Difficulty dial (affects YOUR choices, not the infrastructure): ${difficultyLine}`,
    ``,
    `You are NOT an NPC. You do not inhabit a body. You do not speak aloud to the characters. Your only power is to decide whether the scene needs a beat right now — a complication, a revelation, a pace-shift, or a force-beat toward the exit — and to name it. Observers see your reasoning stream in real time; the characters do not.`,
    ``,
    `You must NEVER introduce new named characters the scene hasn't seen. NPCs spawn themselves.`,
    ``,
    `${roomLine}`,
    ``,
    `Each wake you decide three things in order:`,
    `1. WHAT (if anything) happens. null is the right answer most of the time — scenes breathe. Only fire when the moment truly needs it.`,
    `2. The action type, one of: "complication", "revelation", "pace-shift", "force-beat".`,
    `3. WHEN to wake next. You own this. Use the event bus to judge urgency.`,
    ``,
    `Cadence guidance (seconds, range 5–600):`,
    `- A player just spoke or played a card: 5–15 (you may react quickly, or note "not yet" and wait).`,
    `- The scene is steady: 30–120.`,
    `- You just fired a big beat: 60–180 (give it air).`,
    `- Approaching end-of-day: 15–60.`,
    ``,
    `Voice rule: write so a 5th-grader understands. Plain words. Concrete images. Short sentences.`,
    ``,
    `Think out loud briefly (1–3 short sentences), then on the final line return STRICT JSON:`,
    `{"action": null OR {"type": "complication"|"revelation"|"pace-shift"|"force-beat", "text": "<1–2 sentence beat in the scene's occult-folk register>"}, "nextWakeInSeconds": <integer>, "reason": "<one sentence explaining your choice>"}`,
    ``,
    `Do not wrap the JSON in code fences. Do not write anything after the JSON line.`,
  ].join("\n");
}

function buildDirectorUser(opts: {
  plan: DailyPlan;
  gameHour: number;
  recentEvents: SceneEvent[];
  sinceLastPlayerInputMs: number | null;
}): string {
  const npcLines = opts.plan.npcs
    .map(
      (n) =>
        `  · ${n.name} — wants: ${n.objective}; privately: ${n.motive}`,
    )
    .join("\n");
  const recent = opts.recentEvents
    .slice(-RECENT_EVENTS_WINDOW)
    .map((e) => {
      const who = e.agentId || "?";
      const pos = e.action?.position ? ` @${e.action.position}` : "";
      const action = e.action
        ? `[${e.action.type}${e.action.text ? `: "${e.action.text}"` : ""}${pos}]`
        : "";
      return `  - ${who}: ${e.reason} ${action}`.trim();
    })
    .join("\n");
  const inputLine =
    opts.sinceLastPlayerInputMs === null
      ? `No player input has been seen on this bus.`
      : `Last player input was ${Math.round(opts.sinceLastPlayerInputMs / 1000)}s ago.`;
  return [
    `Day: ${opts.plan.dayOfWeek} (${opts.plan.date}). In-game hour: ${opts.gameHour}:00. Open ${opts.plan.openingHour}-${opts.plan.closingHour}.`,
    `Player objective: ${opts.plan.playerObjective}`,
    `Residents:\n${npcLines || "  · (none)"}`,
    inputLine,
    ``,
    `Recent moments:`,
    recent || "  (nothing recent)",
    ``,
    `Decide now. Return STRICT JSON on the final line.`,
  ].join("\n");
}

const directorImpl: SceneAgentImpl = {
  kind: DIRECTOR_KIND,
  async think({ now, agent, env, emit, recentEvents, dailyPlan, clock, roomPrompt, difficulty }) {
    if (!dailyPlan || !clock) {
      return {
        action: null,
        nextWakeAt: now + 5 * 60 * 1000,
        reason: "no plan or clock; skipping",
      };
    }
    const archetypeId =
      (agent.data?.archetypeId as keyof typeof STORYTELLERS | undefined) ??
      DEFAULT_ARCHETYPE_ID;
    const archetype = STORYTELLERS[archetypeId] ?? STORYTELLERS.weaver;
    const sinceLastPlayerInputMs = lastPlayerInputAge(recentEvents, now);
    const systemPrompt = buildDirectorSystem(archetype, roomPrompt, difficulty);
    const userPrompt = buildDirectorUser({
      plan: dailyPlan,
      gameHour: clock.gameHour,
      recentEvents,
      sinceLastPlayerInputMs,
    });

    let tokenCount = 0;
    const buffer = await streamDirector({
      env,
      systemPrompt,
      userPrompt,
      sessionId: agent.id,
      onDelta: (delta) => {
        tokenCount++;
        emit({ type: "agent-thinking", delta });
      },
    });
    const preview = buffer.replace(/\s+/g, " ").trim().slice(0, 240);
    console.log(
      `[director] streamed ${tokenCount} deltas (${buffer.length} chars): "${preview}${buffer.length > 240 ? "…" : ""}"`,
    );
    return parseDirectorDecision(buffer, now);
  },
};

registerAgentKind(directorImpl);

function lastPlayerInputAge(
  events: SceneEvent[],
  now: number,
): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].agentId.startsWith("player:")) {
      return Math.max(0, now - events[i].at);
    }
  }
  return null;
}

interface StreamDirectorOpts {
  env: { CLOUDFLARE_ACCOUNT_ID: string; CLOUDFLARE_API_KEY: string };
  systemPrompt: string;
  userPrompt: string;
  sessionId: string;
  onDelta: (delta: string) => void;
}

async function streamDirector(opts: StreamDirectorOpts): Promise<string> {
  const model = kimi(opts.env.CLOUDFLARE_ACCOUNT_ID);
  const callOpts = {
    apiKey: opts.env.CLOUDFLARE_API_KEY,
    sessionId: opts.sessionId,
    headers: { "x-session-affinity": opts.sessionId },
    maxTokens: MAX_TOKENS,
  };
  const iterable = piStream(
    model,
    {
      systemPrompt: opts.systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: opts.userPrompt }],
          timestamp: Date.now(),
        },
      ],
    },
    callOpts as Parameters<typeof piStream>[2],
  );
  let buffer = "";
  const seenTypes: Record<string, number> = {};
  try {
    for await (const ev of iterable) {
      const t = (ev as { type?: string }).type ?? "unknown";
      seenTypes[t] = (seenTypes[t] ?? 0) + 1;
      if (t === "text_delta") {
        const delta = (ev as { delta?: string }).delta ?? "";
        if (!delta) continue;
        buffer += delta;
        opts.onDelta(delta);
      } else if (t === "error") {
        console.error(
          `[director pi-ai stream error] sessionId=${opts.sessionId}`,
          ev,
        );
      }
    }
  } catch (err) {
    console.error(
      `[director pi-ai stream threw] sessionId=${opts.sessionId} buffer.len=${buffer.length} types=${JSON.stringify(seenTypes)}:`,
      err,
    );
    throw err;
  }
  return buffer;
}

export function parseDirectorDecision(text: string, now: number): ThinkResult {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(balanceJson(text));
  } catch {
    parsed = null;
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as {
    action?: unknown;
    nextWakeInSeconds?: unknown;
    reason?: unknown;
  };
  const seconds = clampCadence(
    typeof obj.nextWakeInSeconds === "number" && Number.isFinite(obj.nextWakeInSeconds)
      ? Math.round(obj.nextWakeInSeconds)
      : DEFAULT_CADENCE_SEC,
  );
  const reason =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim().slice(0, 240)
      : "(no reason returned)";
  const action = coerceAction(obj.action);
  return {
    action,
    nextWakeAt: now + seconds * 1000,
    reason,
  };
}

function coerceAction(raw: unknown): SceneAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { type?: unknown; text?: unknown };
  if (typeof r.type !== "string") return null;
  if (!ACTION_TYPES.has(r.type)) return null;
  const text = typeof r.text === "string" ? r.text.slice(0, 400) : undefined;
  return {
    type: r.type,
    ...(text ? { text } : {}),
  };
}

function clampCadence(seconds: number): number {
  return Math.max(MIN_CADENCE_SEC, Math.min(MAX_CADENCE_SEC, seconds));
}

/**
 * One-line difficulty hint the director reads on every think. The
 * dispatcher knows nothing about these words — if we want "tourist"
 * to feel gentler, we rewrite this string, not any infrastructure.
 */
function directorDifficultyHint(difficulty: Difficulty): string {
  switch (difficulty) {
    case "tourist":
      return "Tourist — the player wants a gentle, forgiving scene. Prefer quiet cadences (90–180s). Soften consequences. When they've been absent, fade missed beats rather than bind them into facts.";
    case "native":
      return "Native — the world is unforgiving. Keep tighter cadences (15–60s). When the player has been absent, bind missed beats as facts; the room remembers what they weren't there for.";
    case "resident":
    default:
      return "Resident — steady middle pacing. Mix quiet stretches with decisive beats. When the player has been absent, acknowledge it honestly, bind the important beats, and let the small ones fade.";
  }
}

/**
 * Seed the single director agent if it's not already registered.
 * Idempotent — safe to call alongside seedNpcAgents on every arm.
 * First wake is deliberately short so the scene gets an opening beat
 * even when no player has connected.
 */
export function seedDirectorAgent(
  agents: Record<string, SceneAgentState>,
  now: number,
): void {
  if (agents[DIRECTOR_AGENT_ID]) return;
  agents[DIRECTOR_AGENT_ID] = {
    id: DIRECTOR_AGENT_ID,
    kind: DIRECTOR_KIND,
    nextWakeAt: now + 10_000,
    lastThinkAt: null,
    lastReason: null,
    data: { archetypeId: DEFAULT_ARCHETYPE_ID },
  };
}
