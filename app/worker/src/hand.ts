/**
 * Hand computation — derive the player's hand from DECK + game state.
 *
 * MVP rules (deliberately simple):
 *  - The hand IS the deck for now (no draw mechanics yet).
 *  - playable iff cost.footsteps <= footstepsAvailable.
 *  - memory.recall is only playable if a prior entry has the requested label
 *    in the current branch (so the recall has something to surface).
 */

import { DECK } from "./cards.ts";
import type { CardWire } from "../../shared/protocol.ts";
import type { SessionTree } from "./tree.ts";

export function computeHand(tree: SessionTree, footsteps: number): CardWire[] {
  const labelsInBranch = new Set<string>();
  for (const e of tree.all()) if (e.label) labelsInBranch.add(e.label);

  return DECK.map((c) => {
    let playable = c.cost.footsteps <= footsteps;
    if (c.layers.mechanic === "memory.recall") {
      const need = c.recall?.entryLabel;
      if (!need || !labelsInBranch.has(need)) playable = false;
    }
    return {
      id: c.id,
      rarity: c.rarity,
      fiction: c.layers.fiction,
      effect: c.layers.effect,
      mechanic: c.layers.mechanic,
      footsteps: c.cost.footsteps,
      playable,
    };
  });
}
