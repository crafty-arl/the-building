// Ingredient cards — the creative building blocks for a new floor.
// Instead of typing a prompt, the player draws 2–6 of these and the
// director composes a room around them. Works like tarot more than search.

export type IngredientCategory =
  | "where"
  | "who"
  | "what"
  | "when"
  | "mood"
  | "trouble";

export interface IngredientCard {
  id: string;
  category: IngredientCategory;
  label: string;   // short display name, used in the composed prompt
  glyph: string;   // single unicode symbol for visual flavor
}

export const INGREDIENTS: IngredientCard[] = [
  // WHERE — the room itself
  { id: "kitchen",    category: "where", label: "a kitchen at the edge of morning",       glyph: "▦" },
  { id: "attic",      category: "where", label: "an attic that was sealed for years",     glyph: "△" },
  { id: "vault",      category: "where", label: "a locked vault, from the inside",        glyph: "▢" },
  { id: "chapel",     category: "where", label: "a small chapel after the funeral",       glyph: "†" },
  { id: "train",      category: "where", label: "a sleeper car on a train that won't stop", glyph: "═" },
  { id: "cellar",     category: "where", label: "a cellar lit by a single lamp",          glyph: "◌" },
  { id: "rooftop",    category: "where", label: "a rooftop under low cloud",              glyph: "⌒" },
  { id: "clinic",     category: "where", label: "a small clinic in the quiet hour",       glyph: "✚" },

  // WHO — the second person in the room
  { id: "stranger",   category: "who", label: "a stranger at the door",               glyph: "?" },
  { id: "rival",      category: "who", label: "someone they used to be",              glyph: "◉" },
  { id: "sibling",    category: "who", label: "a sibling they haven't spoken to",     glyph: "∞" },
  { id: "child",      category: "who", label: "a child too young to know",            glyph: "○" },
  { id: "debt",       category: "who", label: "the one they owe",                     glyph: "$" },
  { id: "ghost",      category: "who", label: "the one who left",                     glyph: "✺" },
  { id: "mentor",     category: "who", label: "a teacher now frail",                  glyph: "✦" },

  // WHAT — a specific object in the room
  { id: "letter",     category: "what", label: "an unopened letter",                  glyph: "✉" },
  { id: "key",        category: "what", label: "a key that fits nothing here",        glyph: "⚷" },
  { id: "photo",      category: "what", label: "a photograph they didn't keep",       glyph: "▣" },
  { id: "blade",      category: "what", label: "a blade kept clean for a reason",     glyph: "ǁ" },
  { id: "coin",       category: "what", label: "a worn coin with the edge rubbed soft", glyph: "◎" },
  { id: "candle",     category: "what", label: "a candle burning too fast",           glyph: "ϊ" },
  { id: "recipe",     category: "what", label: "a recipe in someone else's hand",     glyph: "☖" },

  // WHEN — time of day / season / event
  { id: "dawn",       category: "when", label: "the last hour before dawn",           glyph: "☼" },
  { id: "winter",     category: "when", label: "winter arriving in earnest",          glyph: "❄" },
  { id: "storm",      category: "when", label: "the night of the storm",              glyph: "☁" },
  { id: "feast",      category: "when", label: "the morning after the feast",         glyph: "◐" },
  { id: "funeral",    category: "when", label: "a funeral day",                       glyph: "✟" },
  { id: "birthday",   category: "when", label: "a birthday nobody mentioned",         glyph: "✩" },

  // MOOD — atmosphere
  { id: "held",       category: "mood", label: "a long held breath",                  glyph: "~" },
  { id: "unsaid",     category: "mood", label: "something waiting to be said",        glyph: "…" },
  { id: "silence",    category: "mood", label: "a silence that stopped being polite", glyph: "∅" },
  { id: "rain",       category: "mood", label: "gentle, unhurried rain",              glyph: "╱" },
  { id: "fire",       category: "mood", label: "a slow fire, attentive",              glyph: "▽" },
  { id: "wind",       category: "mood", label: "wind at the eaves",                   glyph: "〜" },

  // TROUBLE — the engine of the story
  { id: "owed",       category: "trouble", label: "money owed, not mentioned",        glyph: "◈" },
  { id: "lie",        category: "trouble", label: "a lie that has outlasted its usefulness", glyph: "✕" },
  { id: "promise",    category: "trouble", label: "a promise neither wants to keep",  glyph: "⊘" },
  { id: "approach",   category: "trouble", label: "a footstep approaching the door",  glyph: "➤" },
  { id: "argument",   category: "trouble", label: "an argument they paused three days ago", glyph: "⟿" },
  { id: "secret",     category: "trouble", label: "a secret that just became visible", glyph: "◆" },
];

export const CATEGORY_LABELS: Record<IngredientCategory, string> = {
  where: "the place",
  who: "the company",
  what: "the object",
  when: "the hour",
  mood: "the weather",
  trouble: "the trouble",
};

// Compose a human-readable prompt from a list of selected card ids.
// Groups by category so the resulting sentence reads cleanly.
export function composeIngredientPrompt(cardIds: string[]): string {
  const byCat: Record<IngredientCategory, IngredientCard[]> = {
    where: [], who: [], what: [], when: [], mood: [], trouble: [],
  };
  for (const id of cardIds) {
    const card = INGREDIENTS.find((c) => c.id === id);
    if (card) byCat[card.category].push(card);
  }
  const parts: string[] = [];
  if (byCat.where.length > 0) {
    parts.push(byCat.where.map((c) => c.label).join(" and "));
  }
  if (byCat.when.length > 0) {
    parts.push(byCat.when.map((c) => c.label).join(", "));
  }
  if (byCat.who.length > 0) {
    parts.push(`with ${byCat.who.map((c) => c.label).join(" and ")}`);
  }
  if (byCat.what.length > 0) {
    parts.push(`there is ${byCat.what.map((c) => c.label).join(" and ")}`);
  }
  if (byCat.mood.length > 0) {
    parts.push(byCat.mood.map((c) => c.label).join(", "));
  }
  if (byCat.trouble.length > 0) {
    parts.push(`the trouble: ${byCat.trouble.map((c) => c.label).join(", and ")}`);
  }
  return parts.join(". ") + (parts.length > 0 ? "." : "");
}
