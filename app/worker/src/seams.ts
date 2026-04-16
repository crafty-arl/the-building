/**
 * Seam handlers — each card mechanic mapped to a tree mutation + LLM call.
 * Ported from prototype/src/index.ts (the per-turn blocks inside main()).
 *
 * Differences vs prototype:
 *  - Streaming: each handler runs through narrate(), which streams tokens
 *    out via the `onToken` callback (the DO forwards them to the WS).
 *  - sight.scry: prototype renders an actual PNG. We don't have node-canvas
 *    in Workers; we emit a tiny placeholder PNG (1x1 transparent) so the
 *    seam still exercises the vision code path. TODO: ship a real renderer.
 *  - Session id: caller passes a stable `userId:sceneId` (not Date.now).
 */

import { type Card, findCard } from "./cards.ts";
import {
  STRANGER,
  type Scene,
  sceneSystemPrompt,
} from "./scene.ts";
import { type Entry, SessionTree } from "./tree.ts";
import {
  type AssistantMessage,
  type ContentPart,
  type Message,
  type UserMessage,
  assistantText,
} from "./messages.ts";
import {
  type ChatMessage,
  type ModelDescriptor,
  FAST,
  KIMI,
  complete,
  toOpenAiContent,
} from "./cf-ai.ts";

export interface SeamCtx {
  accountId: string;
  apiKey: string;
  /** Stable per-scene session id (userId:sceneId). */
  sessionId: string;
  scene: Scene;
  tree: SessionTree;
  /** Streaming callback: each LLM delta is forwarded as a `token` frame. */
  onToken: (delta: string) => void;
  /** Optional abort. */
  signal?: AbortSignal;
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
}

/**
 * The narration primitive. Builds the message context, calls the model with
 * streaming, appends the new turn to the tree, returns the committed entry.
 */
async function narrate(ctx: SeamCtx, opts: NarrateOpts): Promise<Entry> {
  const newMessages: Message[] = [];
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
    newMessages.push({ role: "user", content, timestamp: Date.now() } as UserMessage);
  }

  const sys = sceneSystemPrompt(ctx.scene);
  const factsBlock = ctx.tree.renderFacts();
  const systemParts: string[] = [];
  if (!opts.minimalSystem) systemParts.push(sys);
  if (factsBlock && !opts.minimalSystem) systemParts.push(factsBlock);
  if (opts.extraSystem) systemParts.push(opts.extraSystem);
  const systemPrompt = systemParts.join("\n\n");

  const priorMessages = opts.minimalSystem
    ? newMessages
    : [...ctx.tree.getBranchMessages(), ...newMessages];

  const chatMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...priorMessages.map<ChatMessage>((m) => {
      if (m.role === "system") return { role: "system", content: m.content };
      if (m.role === "user")
        return { role: "user", content: toOpenAiContent(m.content) };
      return { role: "assistant", content: assistantText(m) };
    }),
  ];

  const leaf = ctx.tree.getLeaf();
  const parentId = leaf?.id ?? null;
  const model = opts.model ?? KIMI;

  const result = await complete({
    accountId: ctx.accountId,
    apiKey: ctx.apiKey,
    model,
    messages: chatMessages,
    sessionId: ctx.sessionId,
    maxTokens: opts.maxTokens,
    onToken: ctx.onToken,
    signal: ctx.signal,
  });

  let text = result.text;
  if (opts.minimalSystem) text = cleanPreamble(text);

  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    provider: result.provider,
    model: result.modelId,
    usage: result.usage,
  };
  newMessages.push(assistant);

  const entry = ctx.tree.add({
    parentId,
    card: { id: opts.card.id, mechanic: opts.card.layers.mechanic },
    messages: newMessages,
    usage: result.usage,
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
      return narrate(ctx, {
        card,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Render the room settling into rhythm: one short paragraph, interior only. No dialogue. Keep under 40 words.`,
        label: "drum-held",
      });

    case "act.speak":
      return narrate(ctx, {
        card,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Render ${STRANGER.name}'s terse reply and the room's reaction. Remember: he answers to his name once, and only if correctly guessed. Keep under 60 words.`,
        label: card.id,
      });

    case "mind.fast":
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
      // Rewind N turns from current leaf, then re-render with a mood bias.
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
      });
    }

    case "mind.know": {
      const guess = card.knowledge!.target;
      const truth = STRANGER.trueName;
      const guessCorrect = guess === truth;
      const knowBlock = [
        "KNOWLEDGE FOR THIS TURN (mind.know):",
        `- The Claw has just spoken a name aloud: "${guess}".`,
        `- The Stranger's true name is: "${truth}".`,
        `- Rule: he answers to his name once, and only once, and only if the guess matches his true name exactly.`,
        guessCorrect
          ? "- The guess matches. He MUST, for the first time in this scene, turn and answer to it. One line only. Then a held breath."
          : "- The guess does NOT match. He must not answer, must not react as if named. He may show the smallest grief for the wrong name.",
        "- Keep under 60 words.",
      ].join("\n");
      return narrate(ctx, {
        card,
        extraSystem: knowBlock,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance}`,
        label: guessCorrect ? "named-true" : "named-wrong",
      });
    }

    case "memory.recall": {
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
      });
    }

    case "ward.vow":
      ctx.tree.addVow(card.vow!);
      return narrate(ctx, {
        card,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Render the act of vowing: internal, silent, weighted. No dialogue from the Claw. Keep under 50 words.`,
        label: "vow-spoken",
      });

    case "place.bind":
      ctx.tree.bindFact(card.bind!.key, card.bind!.value);
      return narrate(ctx, {
        card,
        userMessage: `The Claw plays [${card.id}]. ${card.utterance} Render the act and the room's response. Keep under 60 words.`,
        label: "door-bolted",
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
      });
    }
  }
}
