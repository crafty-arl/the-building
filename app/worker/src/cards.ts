/**
 * Card definitions — ported verbatim from prototype/src/cards.ts.
 * Kept identical so the prototype and worker stay in lockstep.
 */

export type MechanicId =
  | "act.speak"
  | "time.branch"
  | "mind.know"
  | "place.bind"
  | "mind.fast"
  | "memory.recall"
  | "ward.vow"
  | "sight.scry"
  | "momentum.hold";

export interface Card {
  id: string;
  rarity: "common" | "keepsake" | "legendary";
  layers: { fiction: string; effect: string; mechanic: MechanicId };
  cost: { footsteps: number };
  utterance?: string;
  rewind?: { turns: number; newMood: string };
  knowledge?: { claim: string; target: string };
  bind?: { key: string; value: string };
  recall?: { entryLabel: string; framing: string };
  vow?: string;
}

export const DECK: Card[] = [
  {
    id: "keep-the-drum",
    rarity: "common",
    layers: {
      fiction: "You set a hand on the bar and do not move. You keep the drum of the place.",
      effect: "The scene settles into you. Consecutive plays come cheaper — the room remembers its own rhythm.",
      mechanic: "momentum.hold",
    },
    cost: { footsteps: 0 },
    utterance: "I settle. I keep the drum.",
  },
  {
    id: "trust-your-gut",
    rarity: "common",
    layers: {
      fiction: "You do not think. You feel for what the room already knows.",
      effect: "A quick, thin flash of instinct. It is not the deep mind — it is the fast one.",
      mechanic: "mind.fast",
    },
    cost: { footsteps: 1 },
    utterance: "I do not think. I listen for what the room already knows about him.",
  },
  {
    id: "remember-his-eyes",
    rarity: "keepsake",
    layers: {
      fiction: "You surface a moment already passed. It sits at the front of your mind like a held coin.",
      effect: "A prior beat returns as memory. The Claw acts on what he knows now.",
      mechanic: "memory.recall",
    },
    cost: { footsteps: 1 },
    recall: {
      entryLabel: "named-true",
      framing:
        "the moment the Stranger turned — when the name found him and he said you had the lantern's patience",
    },
    utterance: "I hold again in my mind the moment the latch turned in his face.",
  },
  {
    id: "vow-of-silence",
    rarity: "keepsake",
    layers: {
      fiction: "You vow, silently, never to say his name aloud again inside these walls.",
      effect: "The name is locked from your mouth. The vow holds until the scene breaks.",
      mechanic: "ward.vow",
    },
    cost: { footsteps: 4 },
    vow: "The Claw has vowed never again to speak the Stranger's true name ('Adrik') aloud in this scene. The narration MUST NOT have the Claw say that name, nor quote it in any speech attributed to the Claw. The Stranger may still be referenced as 'the Stranger' or 'he' or by his posture.",
    utterance: "I make the vow without speaking it. I will not say his name again in this room.",
  },
  {
    id: "scry-the-lantern",
    rarity: "legendary",
    layers: {
      fiction: "You look at the room as if it were a sign laid out for you to read.",
      effect: "What you see becomes what you know. The scene is seen, not told.",
      mechanic: "sight.scry",
    },
    cost: { footsteps: 2 },
    utterance: "I look at the room. I let it be a sign.",
  },
  {
    id: "ask-who-they-are",
    rarity: "common",
    layers: {
      fiction: "You speak first, carefully. You ask who he is.",
      effect: "He answers. The room holds its breath.",
      mechanic: "act.speak",
    },
    cost: { footsteps: 1 },
    utterance: "I ask the Stranger who he is, speaking gently, without pressing.",
  },
  {
    id: "name-him",
    rarity: "keepsake",
    layers: {
      fiction: "You say the name you heard in a dream the night before. You do not know if it is his.",
      effect: "If it is his name, he will answer to it. Once.",
      mechanic: "mind.know",
    },
    cost: { footsteps: 2 },
    knowledge: { claim: "guessed-name", target: "Adrik" },
    utterance: '"Adrik," I said. Just the once.',
  },
  {
    id: "bolt-the-door",
    rarity: "common",
    layers: {
      fiction: "You rise and drop the iron bolt. The door answers with a thud like a struck drum.",
      effect: "The door is closed. Nothing new enters the room until you open it.",
      mechanic: "place.bind",
    },
    cost: { footsteps: 1 },
    bind: { key: "door", value: "bolted from the inside; no one may enter or leave" },
    utterance: "I drop the iron bolt. The drum of the door sounds once.",
  },
  {
    id: "ask-about-the-rain",
    rarity: "common",
    layers: {
      fiction: "You ask about the rain, as if it were small talk.",
      effect: "He answers the weather. The room listens.",
      mechanic: "act.speak",
    },
    cost: { footsteps: 1 },
    utterance: "I ask after the rain, as though it were a courtesy. I do not mention the door.",
  },
  {
    id: "light-a-candle",
    rarity: "common",
    layers: {
      fiction: "You light a candle at your grandmother's icon. The flame steadies.",
      effect: "The last moment plays again. Softer. His answer is different this time.",
      mechanic: "time.branch",
    },
    cost: { footsteps: 3 },
    rewind: { turns: 1, newMood: "tender, forgiving, soft-lit by candlelight" },
  },
];

export function findCard(id: string): Card {
  const c = DECK.find((x) => x.id === id);
  if (!c) throw new Error(`unknown card: ${id}`);
  return c;
}
