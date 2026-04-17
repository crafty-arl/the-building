/**
 * Replay an Augur session JSON without making any LLM calls.
 *
 * Reads a file saved by `src/index.ts`, reconstructs the SessionTree, then walks
 * entries in order and prints each turn in the same visual format as a live run.
 *
 * Usage: npm run replay -- path/to/session.json
 */

import {
  assistantText,
  type Entry,
  findCard,
  type Message,
  SessionTree,
} from "@augur/agent";
import { loadSessionFromDisk } from "./adapters/disk-session.ts";

const DIVIDER = "\n" + "─".repeat(64) + "\n";

function section(title: string): void {
  console.log(`\n${DIVIDER}${title}${DIVIDER}`);
}

function printMessage(msg: Message): void {
  if (msg.role === "assistant") {
    const text = assistantText(msg);
    const modelTag = `\x1b[35m[${msg.provider ?? "?"}/${msg.model ?? "?"}]\x1b[0m`;
    console.log(`${modelTag}\n\x1b[33m${text}\x1b[0m`);
  } else if (msg.role === "user") {
    const text = msg.content
      .filter((c) => c.type === "text")
      .map((c) => ("text" in c ? c.text : ""))
      .join("");
    const hasImage = msg.content.some((c) => c.type === "image");
    console.log(
      `\x1b[90m> ${text}${hasImage ? " [+image attached]" : ""}\x1b[0m`,
    );
  }
}

function headerFor(cardId: string, mechanic: string, costLabel: string): void {
  let fiction = "";
  let effect = "";
  try {
    const c = findCard(cardId);
    fiction = c.layers.fiction;
    effect = c.layers.effect;
  } catch {
    // unknown card id — nothing to hydrate
  }
  section(`CARD · ${cardId} · ${mechanic} · ${costLabel}`);
  if (fiction) console.log(`\x1b[36m  fiction: ${fiction}\x1b[0m`);
  if (effect) console.log(`\x1b[36m  effect:  ${effect}\x1b[0m\n`);
  else console.log("");
}

function preTurnInfo(
  entry: Entry,
  prevEntry: Entry | null,
  tree: SessionTree,
  sessionId: string,
): void {
  const cardId = entry.card?.id;
  if (!cardId) return;

  switch (cardId) {
    case "keep-the-drum":
      console.log(
        `\x1b[90m  › sessionId pinned for rest of scene: ${sessionId}\x1b[0m\n`,
      );
      break;
    case "trust-your-gut":
      console.log(`\x1b[90m  › mind shifts: kimi → fast (llama 3.3 70b fp8-fast)\x1b[0m\n`);
      break;
    case "light-a-candle": {
      const from = prevEntry?.id ?? "?";
      const to = entry.parentId ?? "?";
      console.log(`\x1b[90m  › leaf moves: ${from} → ${to}\x1b[0m\n`);
      break;
    }
    case "remember-his-eyes": {
      const card = findCard("remember-his-eyes");
      const label = card.recall!.entryLabel;
      const target = tree.all().find((e) => e.label === label);
      let recalledText = "";
      if (target) {
        const asst = target.messages.find((m) => m.role === "assistant");
        if (asst && asst.role === "assistant") {
          recalledText = assistantText(asst);
        }
      }
      const tid = target?.id ?? "?";
      console.log(
        `\x1b[90m  › recalling entry ${tid} (label='${label}'): "${recalledText.slice(0, 80).replace(/\n/g, " ")}..."\x1b[0m\n`,
      );
      break;
    }
    case "vow-of-silence":
      {
        let n = 0;
        for (const e of tree.all()) {
          if (e.card?.mechanic === "ward.vow") {
            n++;
            if (e.id === entry.id) break;
          }
        }
        console.log(`\x1b[90m  › vow added. active vows: ${n}\x1b[0m\n`);
      }
      break;
    case "bolt-the-door": {
      const card = findCard("bolt-the-door");
      console.log(
        `\x1b[90m  › fact bound: ${card.bind!.key} = "${card.bind!.value}"\x1b[0m\n`,
      );
      break;
    }
    case "ask-about-the-rain":
      console.log(
        `\x1b[90m  › this turn is a double-proof: the bolted door should surface unprompted (place.bind), AND the Stranger's true name must NOT appear (ward.vow).\x1b[0m\n`,
      );
      break;
    case "scry-the-lantern": {
      let len = 0;
      const user = entry.messages.find((m) => m.role === "user");
      if (user && user.role === "user") {
        for (const c of user.content) {
          if (c.type === "image" && "data" in c && typeof c.data === "string") {
            len = c.data.length;
            break;
          }
        }
      }
      console.log(
        `\x1b[90m  › rendered 64×64 PNG of scene state (${len} base64 chars)\x1b[0m\n`,
      );
      break;
    }
    default:
      break;
  }
}

const COST_LABELS: Record<string, string> = {
  "keep-the-drum": "0 footsteps",
  "ask-who-they-are": "−1 footstep",
  "trust-your-gut": "−1 footstep",
  "light-a-candle": "−3 footsteps",
  "name-him": "−2 footsteps",
  "remember-his-eyes": "−1 footstep",
  "vow-of-silence": "−4 footsteps",
  "bolt-the-door": "−1 footstep",
  "ask-about-the-rain": "−1 footstep",
  "scry-the-lantern": "−2 footsteps",
};

function replay(path: string): void {
  let tree: SessionTree;
  let sessionId: string;
  try {
    const loaded = loadSessionFromDisk(path);
    tree = loaded.tree;
    sessionId = loaded.data.sessionId;
  } catch (err) {
    console.error(
      `\x1b[31m\nFATAL:\x1b[0m could not load session '${path}': ${(err as Error).message}`,
    );
    process.exit(1);
  }

  const entries = tree.all();

  section("SCENE · The Crooked Lantern · dusk · day 3");
  console.log(`\x1b[90m  scene session id: ${sessionId}\x1b[0m`);

  let prev: Entry | null = null;
  for (const entry of entries) {
    const isOpen = entry.label === "scene-open";
    if (!isOpen && entry.card) {
      const cost = COST_LABELS[entry.card.id] ?? "? footsteps";
      headerFor(entry.card.id, entry.card.mechanic, cost);
      preTurnInfo(entry, prev, tree, sessionId);
    }

    for (const msg of entry.messages) {
      printMessage(msg);
      if (msg.role === "assistant") {
        const u = msg.usage;
        if (u && (u.cacheRead || u.cacheWrite)) {
          console.log(
            `\x1b[90m  [momentum] cacheRead=${u.cacheRead}  cacheWrite=${u.cacheWrite}\x1b[0m`,
          );
        }
      }
    }

    prev = entry;
  }

  section("SESSION TREE");
  console.log(tree.render());

  section("COST");
  const total = tree.totalUsage();
  console.log(`  total in:   ${total.input.toLocaleString()} tokens`);
  console.log(`  total out:  ${total.output.toLocaleString()} tokens`);
  console.log(`  total cost: $${total.cost.toFixed(4)}`);
  const turnCount = tree.all().length;
  console.log(
    `  per scene:  $${total.cost.toFixed(4)}  (${turnCount} turns, 1 branch, ${tree.getFacts().size} facts, ${tree.getVows().length} vows)`,
  );
  console.log(`  replayed from: ${path}`);

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
}

const arg = process.argv[2];
if (!arg) {
  console.error(
    "\x1b[31m\nFATAL:\x1b[0m usage: npm run replay -- path/to/session.json",
  );
  process.exit(1);
}
replay(arg);
