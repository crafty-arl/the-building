/**
 * Mechanic → glyph map for Fiction Reactor. Glyphs are single Unicode codepoints.
 * The player (DM) never sees the mechanic id itself — only the glyph and the
 * card's fiction name.
 *
 * Three-Layer Rule: the mechanic is the engine seam; the glyph is its costume.
 */

export interface Glyph {
  char: string;
  /** Optional override color for dark-theme accents. */
  color?: string;
}

const AMBER = "#D4A857";
const PINK_VOW = "#B4738A";
const GREEN_FACT = "#6BA396";
const CREAM = "#F1E4C9";

const DEFAULT: Glyph = { char: "\u201E" };

const MAP: Record<string, Glyph> = {
  // act.*
  "act.speak": { char: "\u201E" },
  "act.move": { char: "\u201E" },
  "act.offer": { char: "\u201E" },
  "act.strike": { char: "\u201E" },
  "act.search": { char: "\u201E" },
  "act.craft": { char: "\u201E" },

  // time.*
  "time.branch": { char: "\u2020", color: AMBER },

  // mind.*
  "mind.fast": { char: "\u2044" },
  "mind.deep": { char: "\u06DE" },
  "mind.know": { char: "\u2726", color: GREEN_FACT },
  "mind.swarm": { char: "\u06DE" },

  // ward.*
  "ward.vow": { char: "\u25C9", color: PINK_VOW },
  "ward.block": { char: "\u25C9", color: PINK_VOW },
  "ward.break": { char: "\u25C9", color: PINK_VOW },
  "ward.tempt": { char: "\u25C9", color: PINK_VOW },
  "ward.inject": { char: "\u25C9", color: PINK_VOW },

  // memory.*
  "memory.recall": { char: "\u2726", color: GREEN_FACT },
  "memory.forget": { char: "\u2726", color: GREEN_FACT },
  "memory.weigh": { char: "\u2726", color: GREEN_FACT },
  "memory.crystallize": { char: "\u2726", color: AMBER },

  // sight.*
  "sight.scry": { char: "\u25C9", color: CREAM },
  "sight.read": { char: "\u25C9", color: CREAM },
  "sight.portrait": { char: "\u25C9", color: CREAM },

  // momentum.*  (two low dots)
  "momentum.hold": { char: "\u2E31\u2E31" },
  "momentum.interrupt": { char: "\u2E31\u2E31" },
  "momentum.cascade": { char: "\u2E31\u2E31" },

  // act (fallback low double-quote)
  // place.*
  "place.bind": { char: "\u26B7" },
};

export function glyphForMechanic(mechanic: string | undefined | null): Glyph {
  if (!mechanic) return DEFAULT;
  const hit = MAP[mechanic];
  if (hit) return hit;
  const seam = mechanic.split(".")[0];
  for (const [k, v] of Object.entries(MAP)) {
    if (k.startsWith(seam + ".")) return v;
  }
  return DEFAULT;
}
