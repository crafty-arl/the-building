/**
 * Narrator-callable tools, as pi-agent-core AgentTool values.
 *
 * Each tool validates its arguments with TypeBox's `Value.Check` at the
 * boundary (see tool-schemas.ts for the rationale). The narrator can call
 * these mid-turn to mutate scene state or gate its own narration.
 *
 * Side-effects are announced via the optional `ctx.onEffect` channel so the
 * runtime loop (Worker DO or CLI) can react — e.g., updating the client's
 * tree snapshot, relabeling the entry, or logging.
 */

import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  AddVowSchema,
  BindFactSchema,
  BranchTimeSchema,
  CheckNameSchema,
  RecallMemorySchema,
} from "./tool-schemas.ts";
import { assistantText, type AssistantMessage } from "./messages.ts";
import type { SessionTree } from "./tree.ts";

export interface ToolEffect {
  kind: "fact" | "vow" | "branch" | "memory" | "name-check";
  payload: Record<string, unknown>;
}

export interface ToolCtx {
  tree: SessionTree;
  /** The Stranger's (or current key NPC's) true name. checkName compares against this. */
  strangerTrueName: string;
  /** Side-channel for the narrate loop / DO to observe tool effects. */
  onEffect?: (effect: ToolEffect) => void;
}

function textResult(text: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details: {} };
}

function formatValidationErrors(schema: unknown, params: unknown): string {
  try {
    const errors = [...Value.Errors(schema as Parameters<typeof Value.Errors>[0], params)];
    if (errors.length === 0) return "invalid arguments";
    return errors
      .slice(0, 3)
      .map((e) => `${e.path || "/"}: ${e.message}`)
      .join("; ");
  } catch {
    return "invalid arguments";
  }
}

export function bindFactTool(ctx: ToolCtx): AgentTool<typeof BindFactSchema> {
  return {
    name: "bindFact",
    label: "Bind fact",
    description:
      "Bind a persistent world-state fact to the scene. Use this when your narration establishes a change that should persist into future turns — a door being bolted, a candle lit, an object moved, a character's posture fixed. The fact will be injected as ground truth into every subsequent system prompt. Keep keys short and values terse.",
    parameters: BindFactSchema,
    execute: async (_toolCallId, params) => {
      if (!Value.Check(BindFactSchema, params)) {
        throw new Error(
          `bindFact args invalid: ${formatValidationErrors(BindFactSchema, params)}`,
        );
      }
      const key = params.key.trim();
      const value = params.value.trim();
      if (!key || !value) throw new Error("bindFact requires non-empty key and value");
      ctx.tree.bindFact(key, value);
      ctx.onEffect?.({ kind: "fact", payload: { key, value } });
      return textResult(
        `ok. fact bound: ${key} = "${value}". it is now injected as scene state for all future turns.`,
      );
    },
  };
}

export function addVowTool(ctx: ToolCtx): AgentTool<typeof AddVowSchema> {
  return {
    name: "addVow",
    label: "Add vow",
    description:
      "Add an inviolable constraint that must hold for the rest of the scene. Use sparingly — only when the Claw (or a character with weight) has genuinely sworn or committed to something that must not be violated in future narration (e.g., 'will never again speak the Stranger's true name aloud'). The vow is injected as an ACTIVE VOW into every subsequent system prompt.",
    parameters: AddVowSchema,
    execute: async (_toolCallId, params) => {
      if (!Value.Check(AddVowSchema, params)) {
        throw new Error(
          `addVow args invalid: ${formatValidationErrors(AddVowSchema, params)}`,
        );
      }
      const text = params.text.trim();
      if (!text) throw new Error("addVow requires non-empty text");
      ctx.tree.addVow(text);
      ctx.onEffect?.({ kind: "vow", payload: { text } });
      return textResult(`ok. vow active for the rest of the scene: "${text}"`);
    },
  };
}

export function recallMemoryTool(ctx: ToolCtx): AgentTool<typeof RecallMemorySchema> {
  return {
    name: "recallMemory",
    label: "Recall memory",
    description:
      "Surface a prior labeled moment from the session as a resurfaced memory. Returns the exact narrated text of that moment so you can let the narration reflect renewed attention rather than invent new information. Only call this when the current turn genuinely needs memory pressure; otherwise prefer to narrate from present state.",
    parameters: RecallMemorySchema,
    execute: async (_toolCallId, params) => {
      if (!Value.Check(RecallMemorySchema, params)) {
        throw new Error(
          `recallMemory args invalid: ${formatValidationErrors(RecallMemorySchema, params)}`,
        );
      }
      const label = params.entryLabel.trim();
      if (!label) throw new Error("recallMemory requires entryLabel");
      const target = ctx.tree.all().find((e) => e.label === label);
      if (!target) {
        return textResult(`no prior entry labeled "${label}" exists yet in this scene.`);
      }
      const asst = target.messages.find((m) => m.role === "assistant") as
        | AssistantMessage
        | undefined;
      const recalled = asst ? assistantText(asst).trim() : "";
      ctx.onEffect?.({ kind: "memory", payload: { entryLabel: label } });
      return textResult(
        recalled
          ? `recalled moment (${label}):\n"${recalled}"\n\nLet your narration reflect renewed attention to this — do not invent new information.`
          : `entry "${label}" exists but has no narrated content.`,
      );
    },
  };
}

export function checkNameTool(ctx: ToolCtx): AgentTool<typeof CheckNameSchema> {
  return {
    name: "checkName",
    label: "Check name",
    description:
      "Check whether a name the Claw has just spoken aloud matches the Stranger's true name. Returns either 'match' or 'no match'. On a match, the Stranger will answer to the name once and only once; on no match, he does not react to the name. Use before narrating a naming moment so your prose can react correctly.",
    parameters: CheckNameSchema,
    execute: async (_toolCallId, params) => {
      if (!Value.Check(CheckNameSchema, params)) {
        throw new Error(
          `checkName args invalid: ${formatValidationErrors(CheckNameSchema, params)}`,
        );
      }
      const name = params.name.trim();
      const match = name === ctx.strangerTrueName;
      ctx.onEffect?.({ kind: "name-check", payload: { name, match } });
      if (match) {
        return textResult(
          `match. The guess "${name}" matches the Stranger's true name. He MUST, for the first time in this scene, turn and answer to it — one line only, then a held breath.`,
        );
      }
      return textResult(
        `no match. The guess "${name}" is not the Stranger's true name. He does not react as if named; he may show the smallest grief for the wrong name, nothing more.`,
      );
    },
  };
}

export function branchTimeTool(ctx: ToolCtx): AgentTool<typeof BranchTimeSchema> {
  return {
    name: "branchTime",
    label: "Branch time",
    description:
      "Rewind the session tree by N turns and re-narrate the moment under a different mood. Use rarely — only when a card or vow explicitly invites a re-play of a prior beat. After calling, your NEXT utterance replaces what happened in those turns under the supplied mood bias.",
    parameters: BranchTimeSchema,
    execute: async (_toolCallId, params) => {
      if (!Value.Check(BranchTimeSchema, params)) {
        throw new Error(
          `branchTime args invalid: ${formatValidationErrors(BranchTimeSchema, params)}`,
        );
      }
      const { turns, moodBias } = params;
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
      return textResult(
        `ok. rewound ${turns} turn(s). re-narrate the moment now with this mood bias: ${moodBias}`,
      );
    },
  };
}

/**
 * Narrative-first ambient tool set: what the narrator may call during an
 * act.speak / momentum.hold turn without any card pressure.
 */
export function createAmbientTools(ctx: ToolCtx): AgentTool<any>[] {
  return [bindFactTool(ctx), addVowTool(ctx), recallMemoryTool(ctx)];
}

/**
 * Full tool surface — for cards that need the entire registry (mind.know,
 * which forces checkName, or a future general-purpose seam).
 */
export function createAllTools(ctx: ToolCtx): AgentTool<any>[] {
  return [
    bindFactTool(ctx),
    addVowTool(ctx),
    recallMemoryTool(ctx),
    checkNameTool(ctx),
    branchTimeTool(ctx),
  ];
}

/**
 * Tool-name → Static params type. Kept as a helper for callers that want to
 * declare strongly-typed hooks against a specific tool.
 */
export type ToolName =
  | "bindFact"
  | "addVow"
  | "recallMemory"
  | "checkName"
  | "branchTime";

export type ToolParams<N extends ToolName> = N extends "bindFact"
  ? Static<typeof BindFactSchema>
  : N extends "addVow"
    ? Static<typeof AddVowSchema>
    : N extends "recallMemory"
      ? Static<typeof RecallMemorySchema>
      : N extends "checkName"
        ? Static<typeof CheckNameSchema>
        : N extends "branchTime"
          ? Static<typeof BranchTimeSchema>
          : never;
