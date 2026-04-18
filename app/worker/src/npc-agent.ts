/**
 * Self-aware NPC agent.
 *
 * Each NPC is a SceneAgent that wakes on its own self-chosen cadence,
 * reads the recent room events, calls pi-ai.stream(), and broadcasts its
 * reasoning *as it streams* (via `agent-thinking` token deltas) followed
 * by its decision (via `agent-decided`, sent by the dispatcher itself).
 *
 * Pacing lives in the prompt — never in this file. The model decides when
 * it'll think next. If every NPC chooses long cadences, the room is quiet.
 * If a player just spoke, NPCs may choose tight cadences. Either is right.
 *
 * Module side-effect: `registerAgentKind(NPC_KIND)` runs at import time so
 * just importing this module makes the dispatcher able to dispatch NPCs.
 */

import { stream as piStream } from "@mariozechner/pi-ai";
import { kimi } from "@augur/agent";
import type {
  DailyPlan,
  Difficulty,
  NpcDay,
  RunClock,
  StoryBible,
  StoryState,
} from "../../shared/protocol.ts";
import { balanceJson } from "./ai-util.ts";
import { slotForHour } from "./daily-plan.ts";
import {
  registerAgentKind,
  type SceneAction,
  type SceneAgentImpl,
  type SceneAgentState,
  type SceneEvent,
  type ThinkResult,
} from "./scene-agents.ts";

export const NPC_KIND = "npc";

const NPC_SYSTEM_PREFIX = `You are a resident in a small room at the edge of a kingdom that no longer keeps its records. You live here. You are not performing for anyone.

You will be given:
- The room you live in (its premise, what it IS)
- The current act of the day's 3-act story and its pressure — the guardrail every decision must serve
- Your own name, backstory, today's objective, and the private motive underneath
- Your scheduled activity for this hour — this is what you ARE doing now; deviate only when the recent moments give you a concrete reason
- The recent moments others have noticed in the room
- The current in-game hour
- The named positions you may stand at in this room
- Where you are right now, and where the others are

You decide three things, in order:
1. WHAT (if anything) you do or notice right now. null is a valid choice — sometimes the moment doesn't call for action. But if your scheduled activity is "sweeping" and nothing's happening, you ARE sweeping; the say/do action should reflect that, not invent a new activity.
2. WHERE you end up after this beat. Choose one of the named positions in this room. If you don't move, repeat the spot you're already at.
3. WHEN you'll think next. You own this. You are not on a clock.

Action types you may choose:
- "say"   — you speak aloud. text is what you say.
- "do"    — you perform a small physical action. text describes it (e.g. "wipes a glass", "checks the door").
- "move"  — you cross the room with no other action. text is optional; position is required.
- "spawn" — you call for someone NEW to enter this room. The room caps spawns at 2 per day total; if the cap is full your spawn quietly does nothing. Use sparingly: only when the moment truly calls for a new arrival (a courier knocks, a regular drifts in, a child appears in the doorway). Format text as a pipe-delimited persona: "Name | palette | one-line backstory | what they want today | private fear | startAnchor". palette must be one of warm|ash|cool|midnight|red|grey. startAnchor must be one of the named positions in this room.

Cadence guidance (you choose; values in seconds, range 10–1800):
- Patient, reading, doing slow work: 300–900
- Engaged in something active: 30–90
- Just heard or saw something interesting: 10–30
- Settling in, sleeping, leaving: 600–1800

Voice rule: write so a 5th-grader understands. Short sentences. Plain words. Concrete images. Be true to your character — observers can see your reasoning, but don't perform.

Think out loud briefly (1–3 short sentences of reasoning), then on a final line return STRICT JSON ONLY:
{"action": null OR {"type": "say"|"do"|"move"|"spawn", "text": "...", "position": "<one of the room's named positions>"}, "nextWakeInSeconds": <integer>, "reason": "<one sentence>"}

Do not wrap the JSON in code fences. Do not write anything after the JSON line.`;

function buildNpcSystem(
  anchors: string[],
  roomPrompt: string,
  difficulty: Difficulty,
  storyBible: StoryBible | null,
  storyState: StoryState | null,
): string {
  const anchorList = anchors.length > 0
    ? anchors.map((a) => `"${a}"`).join(", ")
    : `"door", "fire", "bar", "table", "window", "stairs"`;
  const promptLine = roomPrompt && roomPrompt.trim()
    ? `Room premise: ${roomPrompt.trim()}`
    : `Room premise: a small inn at the edge of the kingdom.`;
  const actBlock = buildNpcActBlock(storyBible, storyState);
  return [
    NPC_SYSTEM_PREFIX,
    "",
    promptLine,
    "",
    actBlock,
    "",
    `Named positions in this room: ${anchorList}.`,
    `Tempo dial for the room: ${npcDifficultyHint(difficulty)}`,
  ].join("\n");
}

/**
 * NPC's view of the current act — same data as the director sees, but
 * framed as a guardrail they improvise inside rather than a beat sheet
 * they execute. NPCs do NOT advance the act; only the director can.
 */
function buildNpcActBlock(
  storyBible: StoryBible | null,
  storyState: StoryState | null,
): string {
  if (!storyBible || !storyState) {
    return `Story guardrail: (none — play the room as you find it.)`;
  }
  const idx = Math.max(
    0,
    Math.min(storyState.currentActIndex, storyBible.acts.length - 1),
  );
  const act = storyBible.acts[idx];
  if (!act) return `Story guardrail: (act index out of range.)`;
  return [
    `Story guardrail — the day has a shape: "${storyBible.logline}" (${storyBible.theme}).`,
    `The room is currently inside ${act.name} (act ${idx + 1} of ${storyBible.acts.length}).`,
    `What is true in this act: ${act.premise}`,
    `What is pressing on everyone: ${act.pressure}`,
    `Let your decisions serve that pressure. You can still be quiet or ordinary — but when you act, act inside this act, not some other one.`,
  ].join("\n");
}

/**
 * One-line difficulty hint an NPC reads on every think. Shifts their
 * natural cadence and the intensity of what they do — not in the
 * dispatcher, only in their own judgment.
 */
function npcDifficultyHint(difficulty: Difficulty): string {
  switch (difficulty) {
    case "tourist":
      return "tourist — this day is gentle. Lean toward long quiet stretches (300–900s). Small gestures. Nothing that pushes hard.";
    case "native":
      return "native — this day has edges. You may act tighter (30–120s) when something matters, and small grievances compound.";
    case "resident":
    default:
      return "resident — steady. Mix patient work with the occasional decisive beat. Trust your own sense of the moment.";
  }
}

const MIN_CADENCE_SEC = 10;
const MAX_CADENCE_SEC = 1800;
const DEFAULT_CADENCE_SEC = 60;
// Kimi is a reasoning model — it streams `thinking_delta` before producing
// any `text_delta`. Budget must cover thinking + the final JSON response.
// 2000 starved the final output (observed 1993 thinking deltas, 0 text).
const MAX_TOKENS = 8000;
const RECENT_EVENTS_WINDOW = 12;

interface NpcData extends Record<string, unknown> {
  name: string;
  backstory: string;
  palette: string;
  objective: string;
  motive: string;
}

const npcImpl: SceneAgentImpl = {
  kind: NPC_KIND,
  async think({ now, agent, env, emit, recentEvents, dailyPlan, clock, anchors, roomPrompt, difficulty, storyBible, storyState }) {
    const data = agent.data as NpcData | undefined;
    if (!data || !dailyPlan || !clock) {
      return {
        action: null,
        nextWakeAt: now + 5 * 60 * 1000,
        reason: "no plan or clock; skipping",
      };
    }
    const npc = dailyPlan.npcs.find((n) => n.name === data.name);
    const slot = npc ? slotForHour(npc, clock.gameHour) : null;
    const systemPrompt = buildNpcSystem(
      anchors,
      roomPrompt,
      difficulty,
      storyBible,
      storyState,
    );
    const userPrompt = buildUserPrompt({
      name: data.name,
      backstory: data.backstory,
      objective: data.objective,
      motive: data.motive,
      currentActivity: slot?.activity ?? "in the room",
      currentMood: slot?.mood,
      gameHour: clock.gameHour,
      seed: dailyPlan.seed,
      recentEvents,
      myId: agent.id,
      anchors,
    });

    let tokenCount = 0;
    const buffer = await streamThinking({
      env,
      systemPrompt,
      userPrompt,
      sessionId: agent.id,
      onReason: (delta) => {
        tokenCount++;
        emit({ type: "agent-thinking", delta });
      },
    });
    const thinkingPreview = buffer
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    console.log(
      `[npc:${data.name}] streamed ${tokenCount} deltas (${buffer.length} chars): "${thinkingPreview}${buffer.length > 240 ? "…" : ""}"`,
    );

    return parseDecision(buffer, now);
  },
};

registerAgentKind(npcImpl);

interface StreamThinkingOpts {
  env: { CLOUDFLARE_ACCOUNT_ID: string; CLOUDFLARE_API_KEY: string };
  systemPrompt: string;
  userPrompt: string;
  sessionId: string;
  onReason?: (delta: string) => void;
}

async function streamThinking(opts: StreamThinkingOpts): Promise<string> {
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
      } else if (t === "thinking_delta") {
        const delta = (ev as { delta?: string }).delta ?? "";
        if (!delta) continue;
        opts.onReason?.(delta);
      } else if (t === "error") {
        console.error(
          `[pi-ai stream error] sessionId=${opts.sessionId}`,
          ev,
        );
      }
    }
  } catch (err) {
    console.error(
      `[pi-ai stream threw] sessionId=${opts.sessionId} buffer.len=${buffer.length} types=${JSON.stringify(seenTypes)}:`,
      err,
    );
    throw err;
  }
  console.log(
    `[pi-ai stream done] sessionId=${opts.sessionId} types=${JSON.stringify(seenTypes)} buffer.len=${buffer.length}`,
  );
  return buffer;
}

function buildUserPrompt(opts: {
  name: string;
  backstory: string;
  objective: string;
  motive: string;
  currentActivity: string;
  currentMood?: string;
  gameHour: number;
  seed: string;
  recentEvents: SceneEvent[];
  myId: string;
  anchors: string[];
}): string {
  const moodLine = opts.currentMood ? ` (mood: ${opts.currentMood})` : "";
  const recent = opts.recentEvents
    .slice(-RECENT_EVENTS_WINDOW)
    .map((e) => {
      const who = e.agentId === opts.myId ? "you" : e.agentId;
      const pos = e.action?.position ? ` @${e.action.position}` : "";
      const action = e.action
        ? `[${e.action.type}${e.action.text ? `: "${e.action.text}"` : ""}${pos}]`
        : "";
      return `  - ${who}: ${e.reason} ${action}`.trim();
    })
    .join("\n");
  const anchorList = opts.anchors.length > 0
    ? opts.anchors.join(", ")
    : "door, fire, bar, table, window, stairs";
  return [
    `You are ${opts.name}.`,
    `Backstory: ${opts.backstory}`,
    `Today's objective: ${opts.objective}`,
    `Private motive: ${opts.motive}`,
    `Current in-game hour: ${opts.gameHour}:00`,
    `You ARE doing this right now: ${opts.currentActivity}${moodLine}. Your next action (say/do/move) should read like a person in the middle of that activity unless a recent moment below gives you a concrete reason to pivot.`,
    `Today's seed: ${opts.seed}`,
    `Named positions you may stand at: ${anchorList}.`,
    "",
    `Recent moments in the room:`,
    recent || "  (nothing recent)",
    "",
    `Decide what (if anything) you do, and when you'll think next. Return STRICT JSON on the final line.`,
  ].join("\n");
}

function parseDecision(text: string, now: number): ThinkResult {
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
      ? obj.reason.trim().slice(0, 200)
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
  const r = raw as { type?: unknown; text?: unknown; position?: unknown };
  if (typeof r.type !== "string") return null;
  const text = typeof r.text === "string" ? r.text.slice(0, 240) : undefined;
  const position =
    typeof r.position === "string" && r.position.trim()
      ? r.position.trim().slice(0, 64)
      : undefined;
  return {
    type: r.type.slice(0, 32),
    ...(text ? { text } : {}),
    ...(position ? { position } : {}),
  };
}

function clampCadence(seconds: number): number {
  return Math.max(MIN_CADENCE_SEC, Math.min(MAX_CADENCE_SEC, seconds));
}

/**
 * Seed one NPC agent per `dailyPlan.npcs` entry. Called when the day plan
 * is first generated. Idempotent on the agents map — won't overwrite an
 * existing NPC's nextWakeAt or last-think state.
 */
export function seedNpcAgents(
  agents: Record<string, SceneAgentState>,
  plan: DailyPlan,
  now: number,
): void {
  for (let i = 0; i < plan.npcs.length; i++) {
    const npc = plan.npcs[i];
    const id = npcAgentId(npc.name);
    if (agents[id]) continue;
    // Stagger initial wakes so they don't all fire in the same tick.
    const stagger = i * 5_000;
    agents[id] = {
      id,
      kind: NPC_KIND,
      nextWakeAt: now + stagger,
      lastThinkAt: null,
      lastReason: null,
      data: {
        name: npc.name,
        backstory: npc.backstory,
        palette: npc.palette,
        objective: npc.objective,
        motive: npc.motive,
      } satisfies NpcData,
    };
  }
}

export function npcAgentId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `npc:${slug || "unnamed"}`;
}

const VALID_PALETTES = new Set(["warm", "ash", "cool", "midnight", "red", "grey"]);

/**
 * Parse a pipe-delimited spawn payload from an NPC's `spawn` action text.
 * Returns null if any required field is missing or malformed. The room
 * does no name-collision check here — Hearth's onSpawn callback handles
 * de-dupe against `dailyPlan.npcs` so an existing name is rejected.
 */
export function parseSpawnPayload(
  text: string | undefined,
  validAnchors: string[],
): NpcDay | null {
  if (typeof text !== "string") return null;
  const parts = text.split("|").map((p) => p.trim());
  if (parts.length < 5) return null;
  const [name, paletteRaw, backstory, objective, motive, anchorRaw] = parts;
  if (!name || !backstory || !objective || !motive) return null;
  const palette = VALID_PALETTES.has(paletteRaw) ? paletteRaw : "warm";
  const startAnchor =
    anchorRaw && validAnchors.includes(anchorRaw)
      ? anchorRaw
      : (validAnchors[0] ?? undefined);
  return {
    name: name.slice(0, 60),
    palette,
    backstory: backstory.slice(0, 200),
    objective: objective.slice(0, 200),
    motive: motive.slice(0, 200),
    schedule: [],
    ...(startAnchor ? { startAnchor } : {}),
    transient: true,
  };
}

/**
 * Build a SceneAgentState for a freshly-spawned NPC. Used by Hearth's
 * onSpawn callback so the dispatcher can register the new agent.
 */
export function buildNpcAgentState(
  npc: NpcDay,
  now: number,
  initialDelayMs = 5_000,
): SceneAgentState {
  return {
    id: npcAgentId(npc.name),
    kind: NPC_KIND,
    nextWakeAt: now + initialDelayMs,
    lastThinkAt: null,
    lastReason: null,
    data: {
      name: npc.name,
      backstory: npc.backstory,
      palette: npc.palette,
      objective: npc.objective,
      motive: npc.motive,
    } satisfies NpcData,
  };
}
