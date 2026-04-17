/**
 * Seam handlers — card mechanics routed through an agent loop.
 *
 * Each card dispatches to narrate(), which can now run a multi-step agent
 * turn: the model may call tools (bindFact / addVow / recallMemory /
 * checkName) that mutate SessionTree mid-turn, then emit final prose.
 *
 * Card-driven determinism is preserved by pre-executing the card's primary
 * mechanic with author-provided args before narration starts (for place.bind,
 * ward.vow, memory.recall, time.branch). Narrative-only cards (act.speak,
 * momentum.hold) get ambient tools the narrator may invoke organically,
 * which is where new emergent dynamism comes from.
 *
 * The prototype used pi-ai's agent loop; in the Worker we run the loop
 * directly against cf-ai.ts's extended complete() (tool-call streaming).
 */

import type { DailyPlan, RunClock } from "../../shared/protocol.ts";
import { type Card, findCard } from "./cards.ts";
import { STRANGER, type Scene, sceneSystemPrompt } from "./scene.ts";
import { type Entry, SessionTree } from "./tree.ts";
import {
  type AssistantMessage,
  type ContentPart,
  type Message,
  type UserMessage,
  type Usage,
  assistantText,
} from "./messages.ts";
import {
  type ChatMessage,
  type ModelDescriptor,
  type ToolChoice,
  FAST,
  KIMI,
  toOpenAiContent,
} from "./cf-ai.ts";
import { complete } from "./pi-complete.ts";
import {
  AMBIENT_TOOLS,
  type ToolEffect,
  type ToolSpec,
  checkNameTool,
  findToolSpec,
  toolDefinitions,
} from "./tools.ts";

export interface SeamCtx {
  accountId: string;
  apiKey: string;
  /** Stable per-scene session id (userId:sceneId). */
  sessionId: string;
  scene: Scene;
  tree: SessionTree;
  /** Streaming callback: each narrative content delta is forwarded as `token`. */
  onToken: (delta: string) => void;
  /** Optional observer for tool-effect side-channel events. */
  onEffect?: (effect: ToolEffect) => void;
  /** Optional abort. */
  signal?: AbortSignal;
  /** Today's plan — injects residents + schedule into the system prompt. */
  dailyPlan?: DailyPlan;
  /** Current in-game clock for schedule-aware narration. */
  clock?: RunClock;
}

interface NarrateOpts {
  card: Card;
  userMessage?: string;
  userImagePng?: { data: string; mimeType: string };
  label?: string;
  extraSystem?: string;
  model?: ModelDescriptor;
  minimalSystem?: boolean;
  maxTokens?: number;
  /** Tools the narrator may call this turn. Empty/undefined disables the agent loop. */
  tools?: ToolSpec[];
  /** Force a specific tool (usually on the first step). Defaults to "auto". */
  toolChoice?: ToolChoice;
}

const MAX_AGENT_STEPS = 4;

/**
 * Run a narrative turn. If `tools` are present, runs an agent loop: the model
 * may call tools, their outputs are fed back, and the final narrative text is
 * streamed to the client and committed to the tree.
 */
async function narrate(ctx: SeamCtx, opts: NarrateOpts): Promise<Entry> {
  const userMessages: Message[] = [];
  if (opts.userMessage || opts.userImagePng) {
    const content: ContentPart[] = [];
    if (opts.userMessage) content.push({ type: "text", text: opts.userMessage });
    if (opts.userImagePng) {
      content.push({
        type: "image",
        data: opts.userImagePng.data,
        mimeType: opts.userImagePng.mimeType,
      });
    }
    userMessages.push({ role: "user", content, timestamp: Date.now() } as UserMessage);
  }

  const sys = sceneSystemPrompt(ctx.scene, ctx.dailyPlan, ctx.clock);
  const factsBlock = ctx.tree.renderFacts();
  const systemParts: string[] = [];
  if (!opts.minimalSystem) systemParts.push(sys);
  if (factsBlock && !opts.minimalSystem) systemParts.push(factsBlock);
  if (opts.extraSystem) systemParts.push(opts.extraSystem);
  const systemPrompt = systemParts.join("\n\n");

  const priorMessages = opts.minimalSystem
    ? userMessages
    : [...ctx.tree.getBranchMessages(), ...userMessages];

  const thread: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...priorMessages.map<ChatMessage>((m) => {
      if (m.role === "system") return { role: "system", content: m.content };
      if (m.role === "user")
        return { role: "user", content: toOpenAiContent(m.content) };
      return { role: "assistant", content: assistantText(m) };
    }),
  ];

  const model = opts.model ?? KIMI;
  const useTools = !!opts.tools && opts.tools.length > 0;
  const toolDefs = useTools ? toolDefinitions(opts.tools!) : undefined;

  let aggregateText = "";
  const aggregateUsage: Usage = {
    input: 0,
    output: 0,
    cost: { input: 0, output: 0, total: 0 },
  };
  let lastProvider = "cloudflare";
  let lastModelId = model.id;

  const maxSteps = useTools ? MAX_AGENT_STEPS : 1;
  let toolChoice: ToolChoice | undefined = opts.toolChoice;

  for (let step = 0; step < maxSteps; step++) {
    const isLastStep = step === maxSteps - 1;
    // On the final step, force the model to stop calling tools and narrate.
    const stepToolChoice: ToolChoice | undefined = useTools
      ? isLastStep
        ? "none"
        : toolChoice ?? "auto"
      : undefined;

    const result = await complete({
      accountId: ctx.accountId,
      apiKey: ctx.apiKey,
      model,
      messages: thread,
      sessionId: ctx.sessionId,
      maxTokens: opts.maxTokens,
      tools: toolDefs,
      toolChoice: stepToolChoice,
      onToken: ctx.onToken,
      signal: ctx.signal,
    });

    if (result.text) {
      aggregateText += aggregateText ? "\n" : "";
      aggregateText += result.text;
    }
    aggregateUsage.input += result.usage.input;
    aggregateUsage.output += result.usage.output;
    aggregateUsage.cost.input += result.usage.cost.input;
    aggregateUsage.cost.output += result.usage.cost.output;
    aggregateUsage.cost.total += result.usage.cost.total;
    lastProvider = result.provider;
    lastModelId = result.modelId;

    if (result.toolCalls.length === 0) break;

    // Assistant step called tools — append the assistant message (possibly
    // with partial content) plus tool-result messages for each call.
    thread.push({
      role: "assistant",
      content: result.text || null,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.argumentsJson || "{}" },
      })),
    });

    for (const tc of result.toolCalls) {
      const spec = findToolSpec(tc.name);
      if (!spec) {
        thread.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `unknown tool: ${tc.name}`,
        });
        continue;
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = tc.argumentsJson ? JSON.parse(tc.argumentsJson) : {};
      } catch {
        parsed = {};
      }
      const output = await spec.execute(parsed, {
        tree: ctx.tree,
        onEffect: ctx.onEffect,
      });
      thread.push({ role: "tool", tool_call_id: tc.id, content: output });
    }

    // After the first round, don't keep forcing tool calls.
    toolChoice = "auto";
  }

  let text = aggregateText;
  if (opts.minimalSystem) text = cleanPreamble(text);

  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    provider: lastProvider,
    model: lastModelId,
    usage: aggregateUsage,
  };

  // parentId is recomputed here (not at function entry) so tools like
  // branchTime that move the leaf take effect on the committed entry.
  const parentId = ctx.tree.getLeaf()?.id ?? null;
  const entry = ctx.tree.add({
    parentId,
    card: { id: opts.card.id, mechanic: opts.card.layers.mechanic },
    messages: [...userMessages, assistant],
    usage: aggregateUsage,
    label: opts.label,
  });
  return entry;
}

/** Strip CoT preambles from weak-model output. Lifted from prototype. */
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

/**
 * Open the scene if no entries yet. Idempotent: returns null if already open.
 */
export async function maybeOpenScene(ctx: SeamCtx): Promise<Entry | null> {
  if (ctx.tree.all().length > 0) return null;
  return narrate(ctx, {
    card: {
      id: "__scene-open",
      rarity: "common",
      layers: { fiction: "", effect: "", mechanic: "act.speak" },
      cost: { footsteps: 0 },
    },
    userMessage: "Open the scene. Render the opening beat described in the scene hooks.",
    label: "scene-open",
  });
}

/** Dispatch a card by id. Returns the new committed entry. */
export async function playCard(ctx: SeamCtx, cardId: string): Promise<Entry> {
  const card = findCard(cardId);
  switch (card.layers.mechanic) {
    case "momentum.hold":
      // Short, pure-narration passthrough — no tools.
      return narrate(ctx, {
        card,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Render the room settling into rhythm: one short paragraph, interior only. No dialogue. Keep under 40 words.`,
        label: "drum-held",
      });

    case "act.speak":
      // Ambient tools exposed — the narrator may organically bind a fact,
      // add a vow, or surface a memory if the moment demands.
      return narrate(ctx, {
        card,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Render ${STRANGER.name}'s terse reply and the room's reaction. Remember: he answers to his name once, and only if correctly guessed. Keep under 60 words.`,
        label: card.id,
        tools: AMBIENT_TOOLS,
      });

    case "mind.fast":
      // Instinct — no tools, no scene system prompt, fast model.
      return narrate(ctx, {
        card,
        model: FAST,
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
      // Rewind deterministically here, then let the narrator re-render the
      // moment with a mood bias. Ambient tools stay available.
      const turns = card.rewind?.turns ?? 1;
      let cur = ctx.tree.getLeaf();
      for (let i = 0; i < turns && cur && cur.parentId; i++) {
        cur = ctx.tree.getEntry(cur.parentId);
      }
      if (cur && cur.parentId) {
        ctx.tree.branch(cur.parentId);
      } else if (cur) {
        ctx.tree.branch(cur.id);
      }
      return narrate(ctx, {
        card,
        extraSystem: `MOOD BIAS FOR THIS RENDERING: ${card.rewind!.newMood}.\nThe Claw has lit a candle. The moment plays again, softer. Describe the Stranger differently this time — less guarded, more tired. He may almost answer. Keep under 60 words.`,
        userMessage: `[${card.id} · time.branch] ${card.utterance ?? ""}`.trim(),
        label: "candle-lit-asking",
        tools: AMBIENT_TOOLS,
      });
    }

    case "mind.know": {
      // Force the narrator to call checkName with the card's guessed name,
      // then narrate the result. Ambient tools also available.
      const guess = card.knowledge!.target;
      return narrate(ctx, {
        card,
        extraSystem: [
          `The Claw has just spoken the name "${guess}" aloud, once.`,
          `FIRST, call the \`checkName\` tool with name="${guess}". Its result will tell you whether the name matches and exactly how the Stranger must (or must not) react.`,
          `THEN, narrate the beat in under 60 words. Do not reveal the Stranger's true name yourself; let the tool's rule govern his reaction.`,
        ].join("\n"),
        userMessage: `The Claw plays [${card.id}]. ${card.utterance}`,
        // We don't know ahead of time whether the guess matches; label with
        // a neutral sentinel and let downstream look at the tool effect.
        label: guess === STRANGER.trueName ? "named-true" : "named-wrong",
        tools: [checkNameTool, ...AMBIENT_TOOLS],
        toolChoice: { type: "function", function: { name: "checkName" } },
      });
    }

    case "memory.recall": {
      // Pre-surface the memory deterministically (card specifies which entry),
      // inject into system prompt, then narrate under ambient tools.
      const target = ctx.tree.all().find((e) => e.label === card.recall!.entryLabel);
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
        extraSystem: recallBlock,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance}`,
        label: "recalled",
        tools: AMBIENT_TOOLS,
      });
    }

    case "ward.vow":
      // Pre-execute the vow (deterministic, card-authored), then narrate.
      ctx.tree.addVow(card.vow!);
      ctx.onEffect?.({ kind: "vow", payload: { text: card.vow! } });
      return narrate(ctx, {
        card,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Render the act of vowing: internal, silent, weighted. No dialogue from the Claw. Keep under 50 words.`,
        label: "vow-spoken",
        tools: AMBIENT_TOOLS,
      });

    case "place.bind":
      // Pre-execute the fact binding (deterministic), then narrate.
      ctx.tree.bindFact(card.bind!.key, card.bind!.value);
      ctx.onEffect?.({
        kind: "fact",
        payload: { key: card.bind!.key, value: card.bind!.value },
      });
      return narrate(ctx, {
        card,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Render the act and the room's response. Keep under 60 words.`,
        label: "door-bolted",
        tools: AMBIENT_TOOLS,
      });

    case "sight.scry": {
      // Placeholder PNG (1x1 transparent). The prototype renders a real PNG
      // via node-canvas; that doesn't run in Workers. Until we ship a Worker-
      // compatible renderer, exercise the seam with a minimal image so the
      // vision code path stays warm.
      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
      return narrate(ctx, {
        card,
        extraSystem: [
          "SIGHT (sight.scry — you are reading an actual rendered image of the room, attached to this turn):",
          "- The image is small, abstract, and schematic — a symbolic rendering of the scene, not a photograph.",
          "- Describe ONLY what you actually see in the image (colors, shapes, position). Then give the Claw's one-line reading of it as a sign.",
          "- Do not invent details not present in the image.",
          "- Keep under 60 words.",
        ].join("\n"),
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Read what you see and speak it back.`,
        userImagePng: { data: pngB64, mimeType: "image/png" },
        label: "scried",
        tools: AMBIENT_TOOLS,
      });
    }
  }
}
