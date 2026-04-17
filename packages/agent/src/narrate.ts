/**
 * narrate() — the single agent engine Augur uses everywhere.
 *
 * Wraps pi-agent-core's Agent class, adds three Augur-specific things:
 *  1. A hard step cap (MAX_AGENT_STEPS) enforced in `beforeToolCall`, because
 *     pi-agent-core doesn't expose a tool-step ceiling.
 *  2. Optional forced-first-tool mode (for mind.know → must call checkName
 *     before narrating).
 *  3. Card-aware dispatch in `playCard()` that preserves every pre-execution
 *     semantic the hand-rolled worker loop had (place.bind writes the fact
 *     before the LLM runs, ward.vow writes the vow, time.branch moves the
 *     leaf, memory.recall injects prior text into extraSystem, mind.know
 *     forces checkName first, sight.scry attaches a PNG).
 *
 * Streams text deltas via `ctx.onToken`. Commits a single Entry to the tree
 * on success and returns it. parentId is recomputed from the tree AFTER the
 * agent finishes so branchTime mid-turn takes effect on the committed entry.
 */

import {
  complete,
  type AssistantMessage as PiAssistantMessage,
  type Context,
  type ImageContent,
  type Message as PiMessage,
  type Model,
  type TextContent,
  type UserMessage as PiUserMessage,
  type Usage as PiUsage,
} from "@mariozechner/pi-ai";
import { Agent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Card } from "./cards.ts";
import {
  type AssistantMessage,
  type ContentPart,
  type Message,
  type UserMessage,
  type Usage,
  assistantText,
} from "./messages.ts";
import type { DailyPlan, RunClock } from "./schedule-types.ts";
import { type Scene, sceneSystemPrompt, STRANGER } from "./scene.ts";
import type { Entry, SessionTree } from "./tree.ts";
import {
  type ToolCtx,
  type ToolEffect,
  checkNameTool,
  createAmbientTools,
} from "./tools.ts";

export const MAX_AGENT_STEPS = 4;

export interface NarrateCtx {
  accountId: string;
  apiKey: string;
  /** Stable per-scene session id (userId:sceneId). Forwarded as x-session-affinity. */
  sessionId: string;
  scene: Scene;
  tree: SessionTree;
  /** Streaming callback — each assistant text delta is forwarded as a token. */
  onToken: (delta: string, turnId: string) => void;
  /** Optional observer for tool-effect side-channel events. */
  onEffect?: (effect: ToolEffect) => void;
  signal?: AbortSignal;
  /** Today's plan — injects residents + schedule into the system prompt. */
  dailyPlan?: DailyPlan;
  /** Current in-game clock for schedule-aware narration. */
  clock?: RunClock;
  /** Model factory for Kimi (the deep mind). */
  kimiModel: Model<"openai-completions">;
  /** Model factory for Llama 3.3 70B (the fast mind). */
  fastModel: Model<"openai-completions">;
  /** PNG provider for sight.scry. Worker gives a 1×1 placeholder; CLI renders. */
  getScryImage?: () => { data: string; mimeType: string };
}

export interface NarrateOpts {
  card: Card;
  /** Stable turn id so the client can demux streaming deltas. */
  turnId: string;
  userMessage?: string;
  userImagePng?: { data: string; mimeType: string };
  label?: string;
  extraSystem?: string;
  model?: Model<"openai-completions">;
  minimalSystem?: boolean;
  maxTokens?: number;
  /** Tools the narrator may call. Empty/undefined → single-shot no-tools path. */
  tools?: AgentTool<any>[];
  /** Force the first tool call to this name (e.g., "checkName" for mind.know). */
  forceFirstTool?: string;
}

/**
 * Run a narrative turn. Returns the committed entry.
 */
export async function narrate(ctx: NarrateCtx, opts: NarrateOpts): Promise<Entry> {
  // 1. Build the new user message (if any).
  const userMessages: UserMessage[] = [];
  const content: ContentPart[] = [];
  if (opts.userMessage) content.push({ type: "text", text: opts.userMessage });
  if (opts.userImagePng) {
    content.push({
      type: "image",
      data: opts.userImagePng.data,
      mimeType: opts.userImagePng.mimeType,
    });
  }
  if (content.length > 0) {
    userMessages.push({ role: "user", content, timestamp: Date.now() });
  }

  // 2. Build the system prompt.
  const sys = sceneSystemPrompt(ctx.scene, ctx.dailyPlan, ctx.clock);
  const factsBlock = ctx.tree.renderFacts();
  const systemParts: string[] = [];
  if (!opts.minimalSystem) systemParts.push(sys);
  if (factsBlock && !opts.minimalSystem) systemParts.push(factsBlock);
  if (opts.extraSystem) systemParts.push(opts.extraSystem);
  const systemPrompt = systemParts.join("\n\n");

  // 3. Build the message history.
  const priorMessages: Message[] = opts.minimalSystem
    ? userMessages
    : [...ctx.tree.getBranchMessages(), ...userMessages];

  const piHistory: PiMessage[] = priorMessages.map(toPiMessage);
  const model = opts.model ?? ctx.kimiModel;
  const useTools = !!opts.tools && opts.tools.length > 0;

  let aggregateText = "";
  const aggregateUsage: Usage = {
    input: 0,
    output: 0,
    cost: { input: 0, output: 0, total: 0 },
  };
  let lastProvider: string = model.provider;
  let lastModelId: string = model.id;

  if (!useTools) {
    // Single-shot no-tools path. Uses pi-ai.complete() directly so we skip the
    // Agent loop's per-step overhead.
    const context: Context = { systemPrompt, messages: piHistory };
    const assistant = await complete(model, context, {
      apiKey: ctx.apiKey,
      sessionId: ctx.sessionId,
      headers: { "x-session-affinity": ctx.sessionId },
      signal: ctx.signal,
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    });
    const text = assistantText(fromPiAssistant(assistant));
    aggregateText = text;
    aggregateUsage.input += assistant.usage.input;
    aggregateUsage.output += assistant.usage.output;
    aggregateUsage.cost.input += assistant.usage.cost.input;
    aggregateUsage.cost.output += assistant.usage.cost.output;
    aggregateUsage.cost.total += assistant.usage.cost.total;
    lastProvider = assistant.provider;
    lastModelId = assistant.model;
    // Non-streaming mode emits one synthetic token at the end. If the DO
    // wants true streaming for the no-tools path later, swap this for
    // pi-ai.stream() and iterate the event stream.
    if (text) ctx.onToken(text, opts.turnId);
  } else {
    // Agent path. Multi-step tool calling, with step cap + optional forced first tool.
    let stepCount = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: "off",
        tools: opts.tools!,
        messages: piHistory as AgentMessage[],
      },
      sessionId: ctx.sessionId,
      beforeToolCall: async ({ toolCall }) => {
        stepCount++;
        if (stepCount > MAX_AGENT_STEPS - 1) {
          return { block: true, reason: "max tool steps reached; narrate now" };
        }
        if (
          opts.forceFirstTool &&
          stepCount === 1 &&
          toolCall.type === "toolCall" &&
          toolCall.name !== opts.forceFirstTool
        ) {
          return {
            block: true,
            reason: `call ${opts.forceFirstTool} first before calling any other tool`,
          };
        }
        return undefined;
      },
    });

    const unsubscribe = agent.subscribe((ev) => {
      if (
        ev.type === "message_update" &&
        ev.assistantMessageEvent.type === "text_delta"
      ) {
        aggregateText += ev.assistantMessageEvent.delta;
        ctx.onToken(ev.assistantMessageEvent.delta, opts.turnId);
      } else if (ev.type === "turn_end") {
        const msg = ev.message as AgentMessage;
        if (msg && "role" in msg && msg.role === "assistant" && msg.usage) {
          accumulateUsage(aggregateUsage, msg.usage as PiUsage);
          lastProvider = msg.provider ?? lastProvider;
          lastModelId = msg.model ?? lastModelId;
        }
      }
    });

    const abortHandler = () => agent.abort();
    ctx.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      // Nothing new to append — the new user message is already in the initial
      // state. Use `continue()` to run the existing transcript.
      await agent.continue();
      await agent.waitForIdle();
    } finally {
      unsubscribe();
      ctx.signal?.removeEventListener("abort", abortHandler);
    }
  }

  const text = opts.minimalSystem ? cleanPreamble(aggregateText) : aggregateText;

  const assistantMsg: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    provider: lastProvider,
    model: lastModelId,
    usage: aggregateUsage,
  };

  // Recompute parentId AFTER the run so branchTime mid-turn hits the new leaf.
  const parentId = ctx.tree.getLeaf()?.id ?? null;
  return ctx.tree.add({
    parentId,
    card: { id: opts.card.id, mechanic: opts.card.layers.mechanic },
    messages: [...userMessages, assistantMsg],
    usage: aggregateUsage,
    label: opts.label,
  });
}

/**
 * Open the scene with an authored opening beat — idempotent.
 */
export async function maybeOpenScene(
  ctx: NarrateCtx,
  turnId: string,
): Promise<Entry | null> {
  if (ctx.tree.all().length > 0) return null;
  return narrate(ctx, {
    card: {
      id: "__scene-open",
      rarity: "common",
      layers: { fiction: "", effect: "", mechanic: "act.speak" },
      cost: { footsteps: 0 },
    },
    turnId,
    userMessage: "Open the scene. Render the opening beat described in the scene hooks.",
    label: "scene-open",
  });
}

/**
 * Dispatch a card by id. Preserves every pre-execution semantic from the
 * hand-rolled worker loop, per the migration plan's card dispatcher table.
 */
export async function playCard(
  ctx: NarrateCtx,
  cardId: string,
  turnId: string,
): Promise<Entry> {
  // Late-import cards to keep this file side-effect-free.
  const { findCard } = await import("./cards.ts");
  const card = findCard(cardId);
  const toolCtx: ToolCtx = {
    tree: ctx.tree,
    strangerTrueName: STRANGER.trueName,
    onEffect: ctx.onEffect,
  };
  const ambient = () => createAmbientTools(toolCtx);

  switch (card.layers.mechanic) {
    case "momentum.hold":
      return narrate(ctx, {
        card,
        turnId,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Render the room settling into rhythm: one short paragraph, interior only. No dialogue. Keep under 40 words.`,
        label: "drum-held",
      });

    case "act.speak":
      return narrate(ctx, {
        card,
        turnId,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Render ${STRANGER.name}'s terse reply and the room's reaction. Remember: he answers to his name once, and only if correctly guessed. Keep under 60 words.`,
        label: card.id,
        tools: ambient(),
      });

    case "mind.fast":
      return narrate(ctx, {
        card,
        turnId,
        model: ctx.fastModel,
        minimalSystem: true,
        maxTokens: 120,
        extraSystem: [
          "You are the Claw's fast, wordless instinct about a stranger in a tavern.",
          "Write ONE or TWO short sentences of first-person past-tense prose. Nothing else.",
          "Forbidden: the words 'Draft', 'Refining', 'Word count', 'Constraints', 'Check', numbered lists, bullet points, quotation marks, meta-commentary of any kind.",
          "Example of valid output (use this shape, not this content): 'The room did not trust him. My shoulders already knew.'",
          "Write the instinct now. Two sentences max. No preamble. No labels.",
        ].join("\n"),
        userMessage: "What does my body already know about him?",
        label: "instinct",
      });

    case "time.branch": {
      const turns = card.rewind?.turns ?? 1;
      let cur = ctx.tree.getLeaf();
      for (let i = 0; i < turns && cur && cur.parentId; i++) {
        cur = ctx.tree.getEntry(cur.parentId);
      }
      if (cur && cur.parentId) ctx.tree.branch(cur.parentId);
      else if (cur) ctx.tree.branch(cur.id);
      return narrate(ctx, {
        card,
        turnId,
        extraSystem: `MOOD BIAS FOR THIS RENDERING: ${card.rewind!.newMood}.\nThe Claw has lit a candle. The moment plays again, softer. Describe the Stranger differently this time — less guarded, more tired. He may almost answer. Keep under 60 words.`,
        userMessage: `[${card.id} · time.branch] ${card.utterance ?? ""}`.trim(),
        label: "candle-lit-asking",
        tools: ambient(),
      });
    }

    case "mind.know": {
      const guess = card.knowledge!.target;
      return narrate(ctx, {
        card,
        turnId,
        extraSystem: [
          `The Claw has just spoken the name "${guess}" aloud, once.`,
          `FIRST, call the \`checkName\` tool with name="${guess}". Its result will tell you whether the name matches and exactly how the Stranger must (or must not) react.`,
          `THEN, narrate the beat in under 60 words. Do not reveal the Stranger's true name yourself; let the tool's rule govern his reaction.`,
        ].join("\n"),
        userMessage: `The Claw plays [${card.id}]. ${card.utterance}`,
        label: guess === STRANGER.trueName ? "named-true" : "named-wrong",
        tools: [checkNameTool(toolCtx), ...ambient()],
        forceFirstTool: "checkName",
      });
    }

    case "memory.recall": {
      const target = ctx.tree
        .all()
        .find((e) => e.label === card.recall!.entryLabel);
      let recalledText = "";
      if (target) {
        const asst = target.messages.find((m) => m.role === "assistant") as
          | AssistantMessage
          | undefined;
        if (asst) recalledText = assistantText(asst);
      }
      const recallBlock = [
        "MEMORY (memory.recall — a prior moment is resurfaced for the Claw, as if held again in the mind):",
        `  — framing: ${card.recall!.framing}`,
        `  — recalled text: "${recalledText.trim()}"`,
        "",
        "The Claw is NOT asking a new question. He is sitting with what he already knows. The narration should reflect renewed attention, not new information. Keep under 50 words.",
      ].join("\n");
      return narrate(ctx, {
        card,
        turnId,
        extraSystem: recallBlock,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance}`,
        label: "recalled",
        tools: ambient(),
      });
    }

    case "ward.vow":
      ctx.tree.addVow(card.vow!);
      ctx.onEffect?.({ kind: "vow", payload: { text: card.vow! } });
      return narrate(ctx, {
        card,
        turnId,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Render the act of vowing: internal, silent, weighted. No dialogue from the Claw. Keep under 50 words.`,
        label: "vow-spoken",
        tools: ambient(),
      });

    case "place.bind":
      ctx.tree.bindFact(card.bind!.key, card.bind!.value);
      ctx.onEffect?.({
        kind: "fact",
        payload: { key: card.bind!.key, value: card.bind!.value },
      });
      return narrate(ctx, {
        card,
        turnId,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Render the act and the room's response. Keep under 60 words.`,
        label: "door-bolted",
        tools: ambient(),
      });

    case "sight.scry": {
      const png = ctx.getScryImage?.() ?? {
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        mimeType: "image/png",
      };
      return narrate(ctx, {
        card,
        turnId,
        extraSystem: [
          "SIGHT (sight.scry — you are reading an actual rendered image of the room, attached to this turn):",
          "- The image is small, abstract, and schematic — a symbolic rendering of the scene, not a photograph.",
          "- Describe ONLY what you actually see in the image (colors, shapes, position). Then give the Claw's one-line reading of it as a sign.",
          "- Do not invent details not present in the image.",
          "- Keep under 60 words.",
        ].join("\n"),
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Read what you see and speak it back.`,
        userImagePng: png,
        label: "scried",
        tools: ambient(),
      });
    }
  }
}

// ── internals ────────────────────────────────────────────────────────────────

/** Convert our narrower Message into pi-ai's Message shape for LLM consumption. */
function toPiMessage(m: Message): PiMessage {
  if (m.role === "user") {
    const content: (TextContent | ImageContent)[] = m.content.map((c) =>
      c.type === "text"
        ? { type: "text", text: c.text }
        : { type: "image", data: c.data, mimeType: c.mimeType },
    );
    const out: PiUserMessage = {
      role: "user",
      content,
      timestamp: m.timestamp,
    };
    return out;
  }
  if (m.role === "assistant") {
    const content: TextContent[] = m.content
      .filter((c) => c.type === "text")
      .map((c) => ({ type: "text", text: c.text }));
    const usage: PiUsage = {
      input: m.usage.input,
      output: m.usage.output,
      cacheRead: m.usage.cacheRead ?? 0,
      cacheWrite: m.usage.cacheWrite ?? 0,
      totalTokens: m.usage.input + m.usage.output,
      cost: {
        input: m.usage.cost.input,
        output: m.usage.cost.output,
        cacheRead: 0,
        cacheWrite: 0,
        total: m.usage.cost.total,
      },
    };
    const out: PiAssistantMessage = {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: (m.provider ?? "cloudflare") as PiAssistantMessage["provider"],
      model: m.model ?? "",
      usage,
      stopReason: "stop",
      timestamp: m.timestamp,
    };
    return out;
  }
  // System messages aren't part of pi-ai's Message union at the history level;
  // they're passed via `systemPrompt` instead. Collapse to a user turn if one
  // somehow made it into a tree (defensive — shouldn't happen).
  const out: PiUserMessage = {
    role: "user",
    content: m.content,
    timestamp: m.timestamp,
  };
  return out;
}

/**
 * Shrink pi-ai's assistant message back into our narrower shape, so
 * assistantText() can read it via the shared helper.
 */
function fromPiAssistant(m: PiAssistantMessage): AssistantMessage {
  return {
    role: "assistant",
    content: m.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => ({ type: "text", text: c.text })),
    timestamp: m.timestamp,
    provider: m.provider,
    model: m.model,
    usage: {
      input: m.usage.input,
      output: m.usage.output,
      cost: {
        input: m.usage.cost.input,
        output: m.usage.cost.output,
        total: m.usage.cost.total,
      },
    },
  };
}

function accumulateUsage(target: Usage, src: PiUsage): void {
  target.input += src.input;
  target.output += src.output;
  target.cost.input += src.cost.input;
  target.cost.output += src.cost.output;
  target.cost.total += src.cost.total;
}

/**
 * Strip CoT preambles from weak-model output. Lifted from the prototype;
 * only used on the minimalSystem (mind.fast) path.
 */
function cleanPreamble(t: string): string {
  const draftMatch = t.match(
    /(?:Refining|Final|Draft|Output):\s*\n+([\s\S]+?)(?:\n\s*\n(?:Word count|Check constraints?|Check:|Refining|Meta|Note|Verify|Analysis)\b[\s\S]*)?$/i,
  );
  if (draftMatch) return draftMatch[1].trim();
  return t
    .replace(/^(?:The user (?:plays|instructs|has instructed)[^\n]*\n+)/i, "")
    .replace(/^(?:Key constraints?:|Constraints?:)[\s\S]*?(?=\n\n|\n[A-Z])/i, "")
    .replace(/\n+(?:Word count|Check constraints?|Check:|Meta|Note|Verify|Analysis)\b[\s\S]*$/i, "")
    .trim();
}
