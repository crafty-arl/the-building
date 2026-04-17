/**
 * Tool registry — the narrator's dynamic action surface.
 *
 * Each seam mechanic that mutates scene state is also exposed here as a
 * function-calling tool. The narrator can then *choose* to bind a fact, add
 * a vow, recall a prior moment, or branch time in the middle of a turn —
 * not only when the player plays the matching card.
 *
 * Cards still drive scene pacing: playCard() pre-executes the card's primary
 * mechanic with the card's author-provided arguments, then exposes these
 * tools as AMBIENT during narration so emergent effects can happen too.
 *
 * Tool output is plain text (what the model sees); any "effects" the Worker
 * or client should react to can optionally be surfaced via ctx.onEffect.
 */

import type { ToolDefinition } from "./cf-ai.ts";
import { STRANGER } from "./scene.ts";
import type { SessionTree } from "./tree.ts";
import { assistantText } from "./messages.ts";
import type { AssistantMessage } from "./messages.ts";

export interface ToolEffect {
  kind: "fact" | "vow" | "branch" | "memory" | "name-check";
  payload: Record<string, unknown>;
}

export interface ToolCtx {
  tree: SessionTree;
  /** Side-channel for the seam loop / DO to observe tool effects. */
  onEffect?: (effect: ToolEffect) => void;
}

export interface ToolSpec {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string>;
}

// ── Individual tool specs ────────────────────────────────────────────────────

export const bindFactTool: ToolSpec = {
  definition: {
    type: "function",
    function: {
      name: "bindFact",
      description:
        "Bind a persistent world-state fact to the scene. Use this when your narration establishes a change that should persist into future turns — a door being bolted, a candle lit, an object moved, a character's posture fixed. The fact will be injected as ground truth into every subsequent system prompt. Keep keys short and values terse.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Short stable identifier (e.g., 'door', 'candle', 'lantern', 'strangers-hand').",
          },
          value: {
            type: "string",
            description: "The fact in present tense (e.g., 'bolted from the inside; no one may enter or leave').",
          },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
    },
  },
  execute: async (args, ctx) => {
    const key = typeof args.key === "string" ? args.key.trim() : "";
    const value = typeof args.value === "string" ? args.value.trim() : "";
    if (!key || !value) return "error: bindFact requires non-empty key and value";
    ctx.tree.bindFact(key, value);
    ctx.onEffect?.({ kind: "fact", payload: { key, value } });
    return `ok. fact bound: ${key} = "${value}". it is now injected as scene state for all future turns.`;
  },
};

export const addVowTool: ToolSpec = {
  definition: {
    type: "function",
    function: {
      name: "addVow",
      description:
        "Add an inviolable constraint that must hold for the rest of the scene. Use sparingly — only when the Claw (or a character with weight) has genuinely sworn or committed to something that must not be violated in future narration (e.g., 'will never again speak the Stranger's true name aloud'). The vow is injected as an ACTIVE VOW into every subsequent system prompt.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "The full vow as an inviolable rule, written for the narrator to read before each turn (e.g., 'The Claw has vowed never again to speak the Stranger's true name aloud in this scene...').",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  execute: async (args, ctx) => {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return "error: addVow requires non-empty text";
    ctx.tree.addVow(text);
    ctx.onEffect?.({ kind: "vow", payload: { text } });
    return `ok. vow active for the rest of the scene: "${text}"`;
  },
};

export const recallMemoryTool: ToolSpec = {
  definition: {
    type: "function",
    function: {
      name: "recallMemory",
      description:
        "Surface a prior labeled moment from the session as a resurfaced memory. Returns the exact narrated text of that moment so you can let the narration reflect renewed attention rather than invent new information. Only call this when the current turn genuinely needs memory pressure; otherwise prefer to narrate from present state.",
      parameters: {
        type: "object",
        properties: {
          entryLabel: {
            type: "string",
            description:
              "Label of a prior entry (e.g., 'named-true', 'vow-spoken', 'door-bolted'). If no matching entry exists, an empty result is returned.",
          },
        },
        required: ["entryLabel"],
        additionalProperties: false,
      },
    },
  },
  execute: async (args, ctx) => {
    const label = typeof args.entryLabel === "string" ? args.entryLabel.trim() : "";
    if (!label) return "error: recallMemory requires entryLabel";
    const target = ctx.tree.all().find((e) => e.label === label);
    if (!target) return `no prior entry labeled "${label}" exists yet in this scene.`;
    const asst = target.messages.find((m) => m.role === "assistant") as
      | AssistantMessage
      | undefined;
    const recalled = asst ? assistantText(asst).trim() : "";
    ctx.onEffect?.({ kind: "memory", payload: { entryLabel: label } });
    return recalled
      ? `recalled moment (${label}):\n"${recalled}"\n\nLet your narration reflect renewed attention to this — do not invent new information.`
      : `entry "${label}" exists but has no narrated content.`;
  },
};

export const checkNameTool: ToolSpec = {
  definition: {
    type: "function",
    function: {
      name: "checkName",
      description:
        "Check whether a name the Claw has just spoken aloud matches the Stranger's true name. Returns either 'match' or 'no match'. On a match, the Stranger will answer to the name once and only once; on no match, he does not react to the name. Use before narrating a naming moment so your prose can react correctly.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The exact name spoken aloud by the Claw this turn.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  execute: async (args, ctx) => {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const match = name === STRANGER.trueName;
    ctx.onEffect?.({ kind: "name-check", payload: { name, match } });
    if (match) {
      return `match. The guess "${name}" matches the Stranger's true name. He MUST, for the first time in this scene, turn and answer to it — one line only, then a held breath.`;
    }
    return `no match. The guess "${name}" is not the Stranger's true name. He does not react as if named; he may show the smallest grief for the wrong name, nothing more.`;
  },
};

export const branchTimeTool: ToolSpec = {
  definition: {
    type: "function",
    function: {
      name: "branchTime",
      description:
        "Rewind the session tree by N turns and re-narrate the moment under a different mood. Use rarely — only when a card or vow explicitly invites a re-play of a prior beat. After calling, your NEXT utterance replaces what happened in those turns under the supplied mood bias.",
      parameters: {
        type: "object",
        properties: {
          turns: {
            type: "integer",
            minimum: 1,
            maximum: 4,
            description: "How many turns to rewind from the current leaf.",
          },
          moodBias: {
            type: "string",
            description:
              "How the re-rendered moment should feel (e.g., 'tender, forgiving, soft-lit by candlelight').",
          },
        },
        required: ["turns", "moodBias"],
        additionalProperties: false,
      },
    },
  },
  execute: async (args, ctx) => {
    const turns = typeof args.turns === "number" ? Math.floor(args.turns) : 1;
    const moodBias = typeof args.moodBias === "string" ? args.moodBias : "";
    let cur = ctx.tree.getLeaf();
    for (let i = 0; i < turns && cur && cur.parentId; i++) {
      cur = ctx.tree.getEntry(cur.parentId);
    }
    if (cur && cur.parentId) {
      ctx.tree.branch(cur.parentId);
    } else if (cur) {
      ctx.tree.branch(cur.id);
    }
    ctx.onEffect?.({ kind: "branch", payload: { turns, moodBias } });
    return `ok. rewound ${turns} turn(s). re-narrate the moment now with this mood bias: ${moodBias}`;
  },
};

// ── Registry + card-intent gating ────────────────────────────────────────────

export const ALL_TOOLS: ToolSpec[] = [
  bindFactTool,
  addVowTool,
  recallMemoryTool,
  checkNameTool,
  branchTimeTool,
];

export function findToolSpec(name: string): ToolSpec | undefined {
  return ALL_TOOLS.find((t) => t.definition.function.name === name);
}

export function toolDefinitions(specs: ToolSpec[]): ToolDefinition[] {
  return specs.map((s) => s.definition);
}

/**
 * Ambient tool set for cards that are primarily narrative (act.speak,
 * momentum.hold). The narrator may call any of these organically if the
 * moment warrants; they are never forced.
 */
export const AMBIENT_TOOLS: ToolSpec[] = [bindFactTool, addVowTool, recallMemoryTool];
