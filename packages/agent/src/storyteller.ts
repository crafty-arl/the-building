/**
 * Storyteller · the third AI in the Augur stack.
 *
 * The Claw plays cards. The Narrator writes prose. The Storyteller
 * decides WHAT HAPPENS — whether the world should react, escalate,
 * reveal, or resolve between the Claw's moves. This is the Rimworld
 * model: Cassandra vs. Phoebe vs. Randy, except the archetypes here
 * are Primal Script's Old Ones (Aethelos, Nythera, Weaver, Scribe).
 *
 * The Storyteller is called between Claw turns. Given the current
 * state (facts, vows, recent move, objective, turn / maxTurns), it
 * returns a JSON decision: fire an event, or skip. If fire, the event
 * can bind a new fact, add a vow, or simply inject a complication line
 * the next Narrator call weaves into its prose.
 */

import { complete, type Context } from "@mariozechner/pi-ai";
import { fastMind } from "./models.ts";
import type { SessionTree } from "./tree.ts";

export interface StorytellerArchetype {
  id: "aethelos" | "nythera" | "weaver" | "scribe";
  name: string;
  domain: string;
  temperament: string;
  pacingRule: string;
}

export const STORYTELLERS: Record<string, StorytellerArchetype> = {
  aethelos: {
    id: "aethelos",
    name: "Aethelos",
    domain: "Order · Boundary · Definition",
    temperament:
      "Patient. Structural. Scenes build in three acts: setup, complication, resolution. Events are rare and meaningful — each clarifies or resolves.",
    pacingRule:
      "Fire sparingly (roughly one turn in three). When you fire, the event should either introduce a structural beat (setup → complication → resolution) or quietly close a thread.",
  },
  nythera: {
    id: "nythera",
    name: "Nythera",
    domain: "Chaos · Void · Potential",
    temperament:
      "Unpredictable. Unstructured. Anything can happen at any time. Events subvert, destabilize, surprise.",
    pacingRule:
      "Fire often (roughly two turns in three). Events should destabilize — sudden arrivals, reversals, wrong turns, the world misbehaving.",
  },
  weaver: {
    id: "weaver",
    name: "The Weaver",
    domain: "Pattern · Connection · Causality",
    temperament:
      "Threads converge. Callbacks. Foreshadowing paid off. Every event echoes something prior.",
    pacingRule:
      "Fire at moderate rate (roughly every other turn). Each event must tie back to something already named in the scene — a fact, a vow, a gesture. Never introduce wholly new characters or objects.",
  },
  scribe: {
    id: "scribe",
    name: "The Scribe",
    domain: "Knowledge · Memory · Revelation",
    temperament:
      "Slow-burn. Revelations land hard. Information arrives late but transforms what came before.",
    pacingRule:
      "Fire rarely (roughly one turn in four). When you fire, the event should be a revelation — new information that recontextualizes earlier beats. Prefer late-scene timing.",
  },
};

export type StorytellerEventType =
  | "complication"
  | "revelation"
  | "pace-shift"
  | "force-beat";

export interface StorytellerEvent {
  type: StorytellerEventType;
  narration: string;
  bindFact?: { key: string; value: string };
  addVow?: string;
}

export interface StorytellerDecision {
  fire: boolean;
  reasoning: string;
  event?: StorytellerEvent;
  /** Raw text returned by the storyteller LLM — useful for debugging. */
  raw?: string;
}

export interface ConsultOpts {
  archetype: StorytellerArchetype;
  turn: number;
  maxTurns: number;
  tree: SessionTree;
  lastMoveSummary?: string;
  objective: string;
  accountId: string;
  callOpts: {
    apiKey: string;
    sessionId?: string;
    headers?: Record<string, string>;
  };
}

export async function consultStoryteller(
  opts: ConsultOpts,
): Promise<StorytellerDecision> {
  const { archetype, turn, maxTurns, tree, lastMoveSummary, objective } = opts;

  const facts =
    [...tree.getFacts().entries()]
      .map(([k, v]) => `  · ${k}: ${v}`)
      .join("\n") || "  · none";
  const vows =
    tree
      .getVows()
      .map((v) => `  · ${v}`)
      .join("\n") || "  · none";

  const systemPrompt = [
    `You are ${archetype.name.toUpperCase()} — a storyteller agent shaping the pacing of a live narrative scene.`,
    `Your domain: ${archetype.domain}.`,
    `Your temperament: ${archetype.temperament}`,
    `Your pacing rule: ${archetype.pacingRule}`,
    ``,
    `Your role: between turns of the scene, decide whether to INJECT an event that changes the state of the world. You do NOT write prose for the Claw. You push the world to react. You NEVER introduce new named characters the scene hasn't seen.`,
    ``,
    `Event types:`,
    `- complication: a new obstacle, friction, or twist.`,
    `- revelation: a fact becomes known that recontextualizes prior beats.`,
    `- pace-shift: the emotional register of the scene changes.`,
    `- force-beat: push the scene toward its exit — the end is near.`,
    ``,
    `OUTPUT CONTRACT: return a single strict JSON object. No prose before or after. No markdown fences. The shape is:`,
    `{`,
    `  "reasoning": "<1-2 sentences on why you are or aren't firing>",`,
    `  "fire": <true or false>,`,
    `  "event": {`,
    `    "type": "<complication|revelation|pace-shift|force-beat>",`,
    `    "narration": "<1-3 sentence description of what happens, in the same occult-folk register as the scene>",`,
    `    "bindFact": { "key": "<short>", "value": "<short>" },   // optional`,
    `    "addVow": "<text>"   // optional`,
    `  }  // REQUIRED when fire is true; OMIT the event field entirely when fire is false`,
    `}`,
  ].join("\n");

  const userMsg = [
    `TURN ${turn} of ${maxTurns}.`,
    `Scene position: ${turn <= Math.floor(maxTurns / 3) ? "early" : turn <= Math.floor((2 * maxTurns) / 3) ? "middle" : "late"}.`,
    `Claw's objective: ${objective}`,
    `Active facts:\n${facts}`,
    `Active vows:\n${vows}`,
    `Most recent move: ${lastMoveSummary || "the scene has just opened"}`,
    ``,
    `Decide now. Return JSON only.`,
  ].join("\n");

  // Llama 3.3 70B fp8-fast: no thinking mode, clean JSON output, cheap.
  // Kimi (reasoning:true) dumps its full chain-of-thought into thinking blocks
  // and often never reaches the JSON answer within a sane token budget.
  const model = fastMind(opts.accountId);
  const context: Context = {
    systemPrompt,
    messages: [
      { role: "user", content: userMsg, timestamp: Date.now() },
    ],
  };

  const assistant = await complete(model, context, {
    ...opts.callOpts,
    maxTokens: 800,
  });

  // Kimi with reasoning:true routes outputs into thinking blocks when the prompt
  // is "think about this and answer." We want the answer regardless of which
  // block it landed in. Text blocks preferred; fall back to thinking content.
  const textBlocks = assistant.content
    .filter((c) => c.type === "text")
    .map((c) => ("text" in c ? c.text : ""))
    .join("")
    .trim();
  const thinkBlocks = assistant.content
    .filter((c) => c.type === "thinking")
    .map((c) => ("thinking" in c ? c.thinking : ""))
    .join("")
    .trim();
  const raw = textBlocks || thinkBlocks;

  // Strip any accidental markdown fence
  let jsonText = raw;
  const fence = jsonText.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) jsonText = fence[1];

  // Some models prepend a line of commentary; try to extract the first {...} block
  const braceStart = jsonText.indexOf("{");
  const braceEnd = jsonText.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    jsonText = jsonText.slice(braceStart, braceEnd + 1);
  }

  try {
    const parsed = JSON.parse(jsonText) as StorytellerDecision;
    return { ...parsed, raw };
  } catch (err) {
    const preview = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
    return {
      fire: false,
      reasoning: `parse failed: ${(err as Error).message}. raw=<${raw.length} chars> ${preview ? `"${preview}"` : "(empty)"}`,
      raw,
    };
  }
}

/**
 * Apply a fired event's side-effects to the tree. Returns a short string
 * describing what was applied (so callers can log it and/or inject into
 * the next Narrator prompt).
 */
export function applyStorytellerEvent(
  tree: SessionTree,
  event: StorytellerEvent,
): string[] {
  const applied: string[] = [];
  if (event.bindFact) {
    tree.bindFact(event.bindFact.key, event.bindFact.value);
    applied.push(`fact bound: ${event.bindFact.key} = "${event.bindFact.value}"`);
  }
  if (event.addVow) {
    tree.addVow(event.addVow);
    applied.push(`vow added: "${event.addVow.slice(0, 60)}..."`);
  }
  return applied;
}
