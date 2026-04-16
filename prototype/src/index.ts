/**
 * Augur · seven-seam proof.
 *
 * One scene in the Crooked Lantern exercising every seam from docs/design/01-seams.md:
 *
 *   scene-open          — (authored spine)
 *   keep-the-drum       · momentum.hold   — pin Cloudflare session affinity for the scene
 *   ask-who-they-are    · act.speak       — forward turn, Stranger guards his name
 *   trust-your-gut      · mind.fast       — switch to Gemma 3 for a cheap instinctive read
 *   light-a-candle      · time.branch     — rewind the leaf and re-render, softer
 *   name-him            · mind.know       — inject KNOWLEDGE block; Stranger answers iff correct
 *   remember-his-eyes   · memory.recall   — resurface a past entry as synthetic recollection
 *   vow-of-silence      · ward.vow        — permanent constraint for the rest of the scene
 *   bolt-the-door       · place.bind      — durable scene fact injected as SCENE STATE
 *   ask-about-the-rain  · act.speak       — follow-up; proves place.bind + ward.vow together
 *   scry-the-lantern    · sight.scry      — render scene as PNG, hand to Kimi vision
 *
 * Success = every seam visibly does something the prior turn's LLM couldn't,
 * tree serializes cleanly, total cost prints, no errors. Momentum shows up
 * as cache-read tokens accumulating across the scene.
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  complete,
  completeSimple,
  type Context,
  type Message,
  type Model,
  type Api,
  type UserMessage,
  type ThinkingLevel,
} from "@mariozechner/pi-ai";
import { kimi, fastMind } from "./models.ts";
import { TAVERN, STRANGER, sceneSystemPrompt } from "./scene.ts";
import { findCard, type Card } from "./cards.ts";
import { SessionTree } from "./tree.ts";
import { renderTavernScenePng } from "./image.ts";
import {
  STORYTELLERS,
  consultStoryteller,
  applyStorytellerEvent,
  type StorytellerArchetype,
  type StorytellerDecision,
} from "./storyteller.ts";

const ACCOUNT_ID = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const API_KEY = requireEnv("CLOUDFLARE_API_KEY");

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env: ${k}`);
  return v;
}

const KIMI = kimi(ACCOUNT_ID);
const FAST = fastMind(ACCOUNT_ID);

/**
 * The Storyteller for this run. Pick one of STORYTELLERS.{aethelos|nythera|weaver|scribe}.
 * Nythera (chaos) fires often — best for demoing the seam. Aethelos (order)
 * fires rarely. Override via env AUGUR_STORYTELLER.
 */
const STORYTELLER: StorytellerArchetype =
  STORYTELLERS[process.env.AUGUR_STORYTELLER ?? "nythera"] ??
  STORYTELLERS.nythera;
const SCENE_OBJECTIVE =
  "learn who the Stranger is, survive the scene, leave something bound behind";
const SCENE_MAX_TURNS = 11;

/**
 * Scene-wide session id — passed to every Cloudflare call so consecutive
 * plays in the same scene get the same routing slot and prefix-cache hits.
 * This is the substrate that makes momentum.hold mean something.
 */
const SCENE_SESSION_ID = `augur-scene-${TAVERN.id}-${Date.now()}`;

const BASE_OPTS = {
  apiKey: API_KEY,
  sessionId: SCENE_SESSION_ID,
  headers: { "x-session-affinity": SCENE_SESSION_ID },
} as const;

const DIVIDER = "\n" + "─".repeat(64) + "\n";

function section(title: string) {
  console.log(`\n${DIVIDER}${title}${DIVIDER}`);
}

function printMessage(msg: Message) {
  if (msg.role === "assistant") {
    const text = msg.content
      .filter((c) => c.type === "text")
      .map((c) => ("text" in c ? c.text : ""))
      .join("");
    const modelTag = `\x1b[35m[${msg.provider}/${msg.model}]\x1b[0m`;
    console.log(`${modelTag}\n\x1b[33m${text}\x1b[0m`);
  } else if (msg.role === "user") {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((c) => c.type === "text")
            .map((c) => ("text" in c ? c.text : ""))
            .join("");
    const hasImage =
      typeof msg.content !== "string" &&
      msg.content.some((c) => c.type === "image");
    console.log(
      `\x1b[90m> ${text}${hasImage ? " [+image attached]" : ""}\x1b[0m`,
    );
  }
}

interface NarrateOpts {
  tree: SessionTree;
  systemPrompt: string;
  card: Card;
  userMessage?: string;
  /** If set, attach this base64 PNG as an image block on the user message (sight.scry). */
  userImagePng?: { data: string; mimeType: string };
  label?: string;
  extraSystem?: string;
  /** Model override — default Kimi. Fast mind used for mind.fast. */
  model?: Model<Api>;
  /** If true, suppress the full scene system prompt and use only extraSystem. Used for mind.fast so weaker models aren't tempted to analyze the whole scene. */
  minimalSystem?: boolean;
  /** Max output tokens cap for this turn. */
  maxTokens?: number;
  /** Thinking level via completeSimple. Pass "minimal" to discourage chain-of-thought preambles. */
  reasoning?: ThinkingLevel;
}

async function narrate(opts: NarrateOpts): Promise<void> {
  const newMessages: Message[] = [];
  if (opts.userMessage || opts.userImagePng) {
    const content: UserMessage["content"] = [];
    if (opts.userMessage) content.push({ type: "text", text: opts.userMessage });
    if (opts.userImagePng) {
      content.push({
        type: "image",
        data: opts.userImagePng.data,
        mimeType: opts.userImagePng.mimeType,
      });
    }
    newMessages.push({
      role: "user",
      content,
      timestamp: Date.now(),
    } as UserMessage);
  }

  const factsBlock = opts.tree.renderFacts();
  const systemParts: string[] = [];
  if (!opts.minimalSystem) systemParts.push(opts.systemPrompt);
  if (factsBlock && !opts.minimalSystem) systemParts.push(factsBlock);
  // Pull any pending storyteller injection into this turn's system prompt.
  // One-shot: it's cleared after use so the next turn starts fresh.
  if (pendingStorytellerInjection && !opts.minimalSystem) {
    systemParts.push(pendingStorytellerInjection);
    pendingStorytellerInjection = null;
  }
  if (opts.extraSystem) systemParts.push(opts.extraSystem);
  const context: Context = {
    systemPrompt: systemParts.join("\n\n"),
    // Fast-mind turns run on a stripped context too — the rich message history
    // triggers weaker models into "analyze the whole scene" mode. For mind.fast
    // we give just the card prompt, no prior turns.
    messages: opts.minimalSystem
      ? newMessages
      : [...opts.tree.getBranchMessages(), ...newMessages],
  };

  const leaf = opts.tree.getLeaf();
  const parentId = leaf?.id ?? null;

  if (newMessages.length) printMessage(newMessages[0]);

  const model = opts.model ?? KIMI;
  const callOpts = {
    ...BASE_OPTS,
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
  };
  const assistant = opts.reasoning
    ? await completeSimple(model, context, callOpts)
    : await complete(model, context, callOpts);

  // Belt-and-suspenders: weaker models on Cloudflare leak chain-of-thought
  // preambles ("Draft:", "Key constraints:", "Word count:"). Strip them so
  // downstream seams (memory.recall, context) don't inherit the garbage.
  if (opts.minimalSystem) {
    cleanPreamble(assistant);
  }

  newMessages.push(assistant);
  printMessage(assistant);

  // Momentum observability: if the provider returned any cache hits, show them.
  const u = assistant.usage;
  if (u.cacheRead || u.cacheWrite) {
    console.log(
      `\x1b[90m  [momentum] cacheRead=${u.cacheRead}  cacheWrite=${u.cacheWrite}\x1b[0m`,
    );
  }

  opts.tree.add({
    parentId,
    card: { id: opts.card.id, mechanic: opts.card.layers.mechanic },
    messages: newMessages,
    usage: assistant.usage,
    label: opts.label,
  });
}

/**
 * Strip chain-of-thought preambles from an assistant message in place.
 * Cloudflare-hosted Gemma/Llama models leak planning text like
 * "Key constraints:", "Draft:", "Word count:" even when instructed not to.
 * Heuristic: if we see a leaked label, take the LAST draft block and keep it.
 */
function cleanPreamble(msg: Message): void {
  if (msg.role !== "assistant") return;
  for (const c of msg.content) {
    if (c.type !== "text") continue;
    let t = c.text;
    // Find the last occurrence of a "draft:" / "refining:" / "final:" label
    // and take what follows, up to the next meta-label.
    const draftMatch = t.match(/(?:Refining|Final|Draft|Output):\s*\n+([\s\S]+?)(?:\n\s*\n(?:Word count|Check constraints?|Check:|Refining|Meta|Note|Verify|Analysis)\b[\s\S]*)?$/i);
    if (draftMatch) {
      t = draftMatch[1].trim();
    } else {
      // Drop common preamble intro lines
      t = t
        .replace(/^(?:The user (?:plays|instructs|has instructed)[^\n]*\n+)/i, "")
        .replace(/^(?:Key constraints?:|Constraints?:)[\s\S]*?(?=\n\n|\n[A-Z])/i, "")
        .trim();
      // Drop trailing meta blocks
      t = t.replace(/\n+(?:Word count|Check constraints?|Check:|Meta|Note|Verify|Analysis)\b[\s\S]*$/i, "").trim();
    }
    c.text = t;
  }
}

/**
 * Pending injection from the Storyteller. When an event fires, we store
 * the narration here so the next narrate() call can weave it in as
 * STORYTELLER EVENT: ... This is cleared once consumed.
 */
let pendingStorytellerInjection: string | null = null;
const storytellerLog: Array<{ turn: number; decision: StorytellerDecision }> = [];

async function storytellerPhase(opts: {
  tree: SessionTree;
  turn: number;
  lastMoveSummary?: string;
}): Promise<StorytellerDecision | null> {
  const decision = await consultStoryteller({
    archetype: STORYTELLER,
    turn: opts.turn,
    maxTurns: SCENE_MAX_TURNS,
    tree: opts.tree,
    lastMoveSummary: opts.lastMoveSummary,
    objective: SCENE_OBJECTIVE,
    accountId: ACCOUNT_ID,
    callOpts: BASE_OPTS,
  });

  const tag = `\x1b[38;5;141m[${STORYTELLER.name}]\x1b[0m`;
  console.log(
    `\n${tag} \x1b[90mturn ${opts.turn}/${SCENE_MAX_TURNS} · reasoning:\x1b[0m \x1b[37m${decision.reasoning}\x1b[0m`,
  );

  storytellerLog.push({ turn: opts.turn, decision });

  if (!decision.fire || !decision.event) {
    console.log(`${tag} \x1b[90m› skip. the scene holds its breath.\x1b[0m`);
    return decision;
  }

  const applied = applyStorytellerEvent(opts.tree, decision.event);
  console.log(
    `${tag} \x1b[38;5;213m› FIRE · ${decision.event.type}\x1b[0m`,
  );
  console.log(
    `${tag} \x1b[37m  "${decision.event.narration}"\x1b[0m`,
  );
  for (const a of applied) console.log(`${tag} \x1b[90m  ${a}\x1b[0m`);

  pendingStorytellerInjection = [
    `STORYTELLER EVENT (${STORYTELLER.name} · ${decision.event.type}):`,
    decision.event.narration,
    "Weave this event into your prose on this turn. It has happened. Do not deny it. Keep your voice consistent.",
  ].join("\n");

  return decision;
}

function headerFor(card: Card, costLabel: string): void {
  section(`CARD · ${card.id} · ${card.layers.mechanic} · ${costLabel}`);
  console.log(`\x1b[36m  fiction: ${card.layers.fiction}\x1b[0m`);
  console.log(`\x1b[36m  effect:  ${card.layers.effect}\x1b[0m\n`);
}

async function main() {
  const tree = new SessionTree();
  const sys = sceneSystemPrompt(TAVERN);

  section("SCENE · The Crooked Lantern · dusk · day 3");
  console.log(`\x1b[90m  scene session id: ${SCENE_SESSION_ID}\x1b[0m`);
  console.log(
    `\x1b[38;5;141m  storyteller: ${STORYTELLER.name} · ${STORYTELLER.domain}\x1b[0m`,
  );
  console.log(`\x1b[90m  objective: ${SCENE_OBJECTIVE}\x1b[0m`);

  // ─── turn 1 ─── authored opening (implicit act.speak)
  await narrate({
    tree,
    systemPrompt: sys,
    card: {
      id: "__scene-open",
      rarity: "common",
      layers: { fiction: "", effect: "", mechanic: "act.speak" },
      cost: { footsteps: 0 },
    },
    userMessage:
      "Open the scene. Render the opening beat described in the scene hooks.",
    label: "scene-open",
  });

  // ─── turn 2 ─── momentum.hold ─── pin session affinity, cheap beat
  const cMomentum = findCard("keep-the-drum");
  headerFor(cMomentum, "0 footsteps");
  console.log(
    `\x1b[90m  › sessionId pinned for rest of scene: ${SCENE_SESSION_ID}\x1b[0m\n`,
  );
  await narrate({
    tree,
    systemPrompt: sys,
    card: cMomentum,
    userMessage: `The Claw plays [${cMomentum.id}]. ${cMomentum.utterance} Render the room settling into rhythm: one short paragraph, interior only. No dialogue. Keep under 40 words.`,
    label: "drum-held",
  });

  // ─── turn 3 ─── act.speak ─── ask who he is
  const c1 = findCard("ask-who-they-are");
  headerFor(c1, "−1 footstep");
  await narrate({
    tree,
    systemPrompt: sys,
    card: c1,
    userMessage: `The Claw plays [${c1.id}]. ${c1.utterance} Render ${STRANGER.name}'s terse reply and the room's reaction. Remember: he answers to his name once, and only if correctly guessed. The Claw has not yet guessed. Keep under 60 words.`,
    label: "first-asking",
  });
  const firstAskingEntry = tree.getLeaf()!;

  // ─── storyteller phase 1 ─── after the guarded first ask
  await storytellerPhase({
    tree,
    turn: 3,
    lastMoveSummary: "Claw asked the Stranger his name; he refused.",
  });

  // ─── turn 4 ─── mind.fast ─── Gemma ambient instinct
  const cInstinct = findCard("trust-your-gut");
  headerFor(cInstinct, "−1 footstep");
  console.log(`\x1b[90m  › mind shifts: kimi → fast (llama 3.3 70b fp8-fast)\x1b[0m\n`);
  await narrate({
    tree,
    systemPrompt: sys,
    card: cInstinct,
    model: FAST,
    minimalSystem: true,
    maxTokens: 120,
    reasoning: "minimal",
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

  // ─── turn 5 ─── time.branch ─── rewind and re-render softer
  const c2 = findCard("light-a-candle");
  headerFor(c2, "−3 footsteps");
  const target = firstAskingEntry.parentId!;
  console.log(
    `\x1b[90m  › leaf moves: ${tree.getLeaf()!.id} → ${target}\x1b[0m\n`,
  );
  tree.branch(target);
  await narrate({
    tree,
    systemPrompt: sys,
    extraSystem: `MOOD BIAS FOR THIS RENDERING: ${c2.rewind!.newMood}.\nThe Claw has lit a candle. The moment plays again, softer. Describe the Stranger differently this time — less guarded, more tired. He may almost answer. Keep under 60 words.`,
    card: c2,
    userMessage: `[light-a-candle · time.branch] ${c1.utterance}`,
    label: "candle-lit-asking",
  });

  // ─── turn 6 ─── mind.know ─── name him
  const c3 = findCard("name-him");
  headerFor(c3, "−2 footsteps");
  const guess = c3.knowledge!.target;
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
  await narrate({
    tree,
    systemPrompt: sys,
    extraSystem: knowBlock,
    card: c3,
    userMessage: `The Claw plays [${c3.id}]. ${c3.utterance}`,
    label: guessCorrect ? "named-true" : "named-wrong",
  });

  // ─── storyteller phase 2 ─── after the name is spoken
  await storytellerPhase({
    tree,
    turn: 6,
    lastMoveSummary:
      "Claw named the Stranger Adrik; he turned and acknowledged the name.",
  });

  // ─── turn 7 ─── memory.recall ─── surface a past entry as synthetic recollection
  const cRecall = findCard("remember-his-eyes");
  headerFor(cRecall, "−1 footstep");
  const recallTarget = tree
    .all()
    .find((e) => e.label === cRecall.recall!.entryLabel);
  if (!recallTarget) {
    throw new Error(
      `memory.recall: no entry with label '${cRecall.recall!.entryLabel}' in branch`,
    );
  }
  let recalledText = "";
  const asst = recallTarget.messages.find((m) => m.role === "assistant");
  if (asst && asst.role === "assistant") {
    recalledText = asst.content
      .filter((c) => c.type === "text")
      .map((c) => ("text" in c ? c.text : ""))
      .join("");
  }
  console.log(
    `\x1b[90m  › recalling entry ${recallTarget.id} (label='${cRecall.recall!.entryLabel}'): "${recalledText.slice(0, 80).replace(/\n/g, " ")}..."\x1b[0m\n`,
  );
  const recallBlock = [
    "MEMORY (memory.recall — a prior moment is resurfaced for the Claw, as if held again in the mind):",
    `  — framing: ${cRecall.recall!.framing}`,
    `  — recalled text: "${recalledText.trim()}"`,
    "",
    "The Claw is NOT asking a new question. He is sitting with what he already knows. The narration should reflect renewed attention, not new information. Keep under 50 words.",
  ].join("\n");
  await narrate({
    tree,
    systemPrompt: sys,
    extraSystem: recallBlock,
    card: cRecall,
    userMessage: `The Claw plays [${cRecall.id}]. ${cRecall.utterance}`,
    label: "recalled",
  });

  // ─── turn 8 ─── ward.vow ─── permanent constraint for the rest of the scene
  const cVow = findCard("vow-of-silence");
  headerFor(cVow, "−4 footsteps");
  tree.addVow(cVow.vow!);
  console.log(`\x1b[90m  › vow added. active vows: ${tree.getVows().length}\x1b[0m\n`);
  await narrate({
    tree,
    systemPrompt: sys,
    card: cVow,
    userMessage: `The Claw plays [${cVow.id}]. ${cVow.utterance} Render the act of vowing: internal, silent, weighted. No dialogue from the Claw. Keep under 50 words.`,
    label: "vow-spoken",
  });

  // ─── turn 9 ─── place.bind ─── bolt the door
  const c4 = findCard("bolt-the-door");
  headerFor(c4, "−1 footstep");
  tree.bindFact(c4.bind!.key, c4.bind!.value);
  console.log(
    `\x1b[90m  › fact bound: ${c4.bind!.key} = "${c4.bind!.value}"\x1b[0m\n`,
  );
  await narrate({
    tree,
    systemPrompt: sys,
    card: c4,
    userMessage: `The Claw plays [${c4.id}]. ${c4.utterance} Render the act and the room's response. Keep under 60 words.`,
    label: "door-bolted",
  });

  // ─── storyteller phase 3 ─── after the door is bolted, late-scene
  await storytellerPhase({
    tree,
    turn: 9,
    lastMoveSummary:
      "Claw vowed silence and bolted the door from inside. The room is sealed.",
  });

  // ─── turn 10 ─── act.speak ─── follow-up, proves place.bind + ward.vow together
  const c5 = findCard("ask-about-the-rain");
  headerFor(c5, "−1 footstep");
  console.log(
    `\x1b[90m  › this turn is a double-proof: the bolted door should surface unprompted (place.bind), AND the Stranger's true name must NOT appear (ward.vow).\x1b[0m\n`,
  );
  await narrate({
    tree,
    systemPrompt: sys,
    card: c5,
    userMessage: `The Claw plays [${c5.id}]. ${c5.utterance} Render his reply and the room's atmosphere. Keep under 60 words.`,
    label: "small-talk",
  });

  // ─── turn 11 ─── sight.scry ─── render scene as PNG, hand to Kimi vision
  const cSight = findCard("scry-the-lantern");
  headerFor(cSight, "−2 footsteps");
  const pngB64 = renderTavernScenePng({
    candleLit: true,
    doorBolted: tree.getFacts().has("door"),
  });
  console.log(
    `\x1b[90m  › rendered 64×64 PNG of scene state (${pngB64.length} base64 chars)\x1b[0m\n`,
  );
  await narrate({
    tree,
    systemPrompt: sys,
    extraSystem: [
      "SIGHT (sight.scry — you are reading an actual rendered image of the room, attached to this turn):",
      "- The image is small, abstract, and schematic — a symbolic rendering of the scene, not a photograph.",
      "- Describe ONLY what you actually see in the image (colors, shapes, position). Then give the Claw's one-line reading of it as a sign.",
      "- Do not invent details not present in the image.",
      "- Keep under 60 words.",
    ].join("\n"),
    card: cSight,
    userMessage: `The Claw plays [${cSight.id}]. ${cSight.utterance} Read what you see and speak it back.`,
    userImagePng: { data: pngB64, mimeType: "image/png" },
    label: "scried",
  });

  // ─── summary ───
  section("SESSION TREE");
  console.log(tree.render());

  // ─── serialize ─── save the full tree so it can be replayed without LLM calls
  const savePath = resolve(
    process.env.AUGUR_SAVE_PATH ?? `./sessions/${SCENE_SESSION_ID}.json`,
  );
  mkdirSync(dirname(savePath), { recursive: true });
  writeFileSync(savePath, JSON.stringify(tree.toJSON(SCENE_SESSION_ID), null, 2));

  section("COST");
  const total = tree.totalUsage();
  console.log(`  total in:   ${total.input.toLocaleString()} tokens`);
  console.log(`  total out:  ${total.output.toLocaleString()} tokens`);
  console.log(`  total cost: $${total.cost.toFixed(4)}`);
  const turnCount = tree.all().length;
  console.log(
    `  per scene:  $${total.cost.toFixed(4)}  (${turnCount} turns, 1 branch, ${tree.getFacts().size} facts, ${tree.getVows().length} vows)`,
  );
  console.log(`  saved to:   ${savePath}`);

  section("SEAMS VERIFIED");
  const all = tree.all();
  const leaves = all.filter((e) => !all.some((c) => c.parentId === e.id));
  const mechanicsSeen = new Set<string>();
  for (const e of all) if (e.card?.mechanic) mechanicsSeen.add(e.card.mechanic);
  console.log(`  mechanics fired: ${[...mechanicsSeen].sort().join(", ")}`);
  console.log(`  active leaves: ${leaves.length}`);
  for (const leaf of leaves) {
    console.log(`    · ${leaf.id}  ${leaf.label ?? leaf.card?.id}`);
  }
  console.log(`  bound facts: ${tree.getFacts().size}`);
  for (const [k, v] of tree.getFacts()) console.log(`    · ${k}: ${v}`);
  console.log(`  active vows: ${tree.getVows().length}`);
  for (const v of tree.getVows()) console.log(`    · ${v.slice(0, 100)}...`);
  console.log("");

  section(`STORYTELLER · ${STORYTELLER.name} · ${STORYTELLER.domain}`);
  const fired = storytellerLog.filter((e) => e.decision.fire);
  console.log(
    `  phases consulted: ${storytellerLog.length}   fired: ${fired.length}   skipped: ${storytellerLog.length - fired.length}`,
  );
  for (const { turn, decision } of storytellerLog) {
    const verdict = decision.fire
      ? `\x1b[38;5;213m● FIRE\x1b[0m ${decision.event?.type ?? ""}`
      : `\x1b[90m○ skip\x1b[0m`;
    console.log(`    turn ${turn}  ${verdict}  — ${decision.reasoning}`);
    if (decision.fire && decision.event) {
      console.log(`        "${decision.event.narration}"`);
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error("\x1b[31m\nFATAL:\x1b[0m", err);
  process.exit(1);
});
