# 02 — Cards

The card authoring contract. Read `00-principles.md` (three-layer rule) and `01-seams.md` (the seven seams) first — this document assumes them.

---

## Card schema

```ts
type Card = {
  id: string;                  // stable: "light-a-candle" — lowercase kebab, pack-unique
  pack: string;                // content pack that owns it: "occult-v1"
  rarity: Rarity;              // "common" | "uncommon" | "rare" | "keepsake" | "legendary"

  layers: {
    fiction: string;           // what the player does, one sentence, in-world
    effect: string;            // what they see change, one sentence, observable
    mechanic: MechanicId;      // exactly one seam verb from 01-seams.md
  };

  art?: string;                // relative path to card art (R2 key, eventually)
  mood?: Mood;                 // "somber" | "wry" | "tense" | "warm" | "ritual" | ...

  cost: {
    footsteps: number;         // player-visible cost (1-5 typical, 10 extreme)
    context?: number;          // approximate extra tokens the card pulls in
  };

  tags: string[];              // freeform author tags: ["candle", "grandmother", "night"]

  restrictions?: {
    requiresMood?: Mood[];                // scene mood must match
    requiresTimeOfDay?: ("dawn"|"day"|"dusk"|"night")[];
    requiresNPC?: string[];               // scene must contain one of these NPCs
    requiresTag?: string[];               // scene must be tagged with all
    forbidsTag?: string[];                // scene tagged with any = unplayable
    requiresCardInLedger?: string[];      // only playable once specific card has been played before
    oncePerScene?: boolean;
    oncePerSession?: boolean;
  };

  onPlay?: {                   // optional authored side-effects beyond the mechanic
    grantCard?: string[];      // add this card to the player's deck
    revealCard?: string[];     // reveal in Ledger (not added yet)
    glowKeepsake?: string;     // highlight a Keepsake card in hand
  };
};
```

All fields validated on pack load. A card with a typo in `mechanic` fails loud.

---

## Authoring checklist

Every new card must pass this checklist before it enters a pack:

1. **Three layers aligned?** Read the fiction. Imagine the effect. Check the mechanic. Someone who doesn't know this is a card game should be able to guess the effect from the fiction alone.
2. **Mechanic is a single seam verb?** Cards firing two seams are rare; see 01-seams.md rule.
3. **Has a receipt?** The effect must produce a visible, pointable artifact on screen.
4. **Cost matches seam?** Reference the seam cost model.
5. **Flavor matches setting voice?** See `03-settings.md` for per-pack tone.
6. **Does it do what no other card in the pack does?** Duplicate mechanics are fine; duplicate *feels* are not.
7. **Will the player remember this card a week later?** If forgettable, rework or cut.

---

## Rarity tiers

Rarity drives discovery cadence and emotional weight.

| Rarity | Who has it | Acquired by |
|---|---|---|
| **common** | Everyone in starter deck | Ships with pack |
| **uncommon** | Most players by day 3 | Scene drops, NPC rewards |
| **rare** | Requires specific path | Story beats, quests, faction |
| **keepsake** | One-of-one per player | Minted via `memory.crystallize` |
| **legendary** | Rare drops + late-game | Major story moments, endings |

Keepsakes are special: they are **player-authored** (their fiction comes from a real scene the player was in), **non-duplicatable**, and **exportable**. They are the emotional core of the ownership promise.

---

## Mood

Moods are author-declared atmospheres that scenes emit and cards consume.

Default mood set:
- `somber` — grief, dusk, rain
- `wry` — dry comedy, side-eye, small defiance
- `tense` — danger near, pulse up, choices narrow
- `warm` — safety, cozy, familiar
- `ritual` — formal, structured, sacred
- `eerie` — uncanny, wrong, the air is different
- `giddy` — high-energy, dopamine, small wins
- `resigned` — the long view, acceptance

A scene can have 1–2 active moods. A card with `requiresMood: ["somber", "resigned"]` is playable only if the scene has at least one of those moods.

Moods come from: scene authoring + NPC states + recent story beats + time of day. The engine computes; authors can force.

---

## Card cost

Footsteps are the player-visible currency. Defaults (restate from 01-seams.md):

- **1 footstep** — cheap action (fast mind, basic act, simple memory)
- **2 footsteps** — standard (medium mind, sight, ward)
- **3 footsteps** — expensive (deep mind, time rewind, memory crystallize)
- **5 footsteps** — major (swarm, fork, legendary)
- **0 footsteps + spends meter** — momentum cascades

A session grants ~8 footsteps, refilling daily. Pacing: ~3–5 cards per session.

---

## Card voice per setting

Each pack declares a voice. Card flavor must match it. Examples:

### Occult / folk-magic
- Terse, prayerful, named for old things
- "Light a candle at the icon your grandmother kept."
- "Speak his name where only the river can hear."
- Avoid: neon, slang, hyperbole

### Cyber / neural
- Technical but weary. Lowercase. Terminals.
- "fork.self --inherit-last"
- "upload the moment. re-enter it."
- Avoid: capitalized fantasy prose, incantation

### Cozy / small-town
- Warm, specific, domestic
- "Put the kettle on and think it through."
- "Bring the casserole. She likes the dish."
- Avoid: dread, grandeur, mystery-for-mystery's-sake

### Noir
- Clipped. First person. Smoke.
- "I looked at her again, different this time."
- "I let him answer. Then I un-let him."
- Avoid: cheer, direct sincerity, heroism

### Courtly / mythic
- Formal, referential, declarative
- "Swear the Oath of Stillness."
- "Summon the Council of Nine."
- Avoid: contractions, casual, jokes

A single pack chooses ONE voice and holds it across every card.

---

## Mechanic ID reference

For authoring, this is the complete valid set. Engine will reject unknown IDs.

From Seam 1 — Time:
- `time.branch`
- `time.fork`
- `time.chapter`
- `time.return`

From Seam 2 — Mind:
- `mind.deep`
- `mind.fast`
- `mind.medium`
- `mind.swarm`
- `mind.shift`

From Seam 3 — Ward:
- `ward.block`
- `ward.inject`
- `ward.vow`
- `ward.tempt`
- `ward.break`

From Seam 4 — Memory:
- `memory.recall`
- `memory.forget`
- `memory.weigh`
- `memory.crystallize`

From Seam 5 — Sight:
- `sight.scry`
- `sight.read`
- `sight.portrait`

From Seam 6 — Momentum:
- `momentum.hold`
- `momentum.interrupt`
- `momentum.cascade`

From Seam 7 — Act:
- `act.speak`
- `act.move`
- `act.offer`
- `act.strike`
- `act.search`
- `act.craft`

---

## Example: a complete card

```json
{
  "id": "light-a-candle",
  "pack": "occult-v1",
  "rarity": "common",
  "layers": {
    "fiction": "You light a candle at your grandmother's icon. The flame steadies.",
    "effect": "The last moment plays again. Softer. The stranger's answer is different this time.",
    "mechanic": "time.branch"
  },
  "art": "occult-v1/cards/light-a-candle.webp",
  "mood": "ritual",
  "cost": {
    "footsteps": 3
  },
  "tags": ["candle", "grandmother", "ritual", "forgiveness"],
  "restrictions": {
    "oncePerScene": true
  }
}
```

Read the fiction → imagine the effect → the mechanic is obvious. That's the rule.

---

## Keepsake authoring (player-generated)

At scene-end, the player can mint a Keepsake from the current moment. The authoring flow:

1. Player picks a short description ("the coin from Tuesday").
2. Pi drafts the fiction in the pack's voice.
3. Engine assigns:
   - `rarity: "keepsake"`
   - `mechanic: "memory.recall"` (default — points to the entry where it was minted)
   - `cost: { footsteps: 2 }`
   - `oncePerScene: true`
   - `restrictions.requiresCardInLedger: ["light-a-candle"]` (optional: tie to triggering card)
4. Player can edit fiction, cost is locked.
5. Card is saved to the player's deck file + R2 session, with a provenance blob.

Keepsakes are the only player-authored cards in v1. They're non-tradeable in v1; the Agora UGC layer is later.

---

## Validation, quick

At pack load, the engine:

- Parses cards via TypeBox schema
- Checks all `mechanic` IDs are known
- Checks `cost.footsteps` in [0, 20]
- Checks `restrictions.requiresCardInLedger` references exist in the pack
- Checks rarity + cost sanity (`legendary` with `footsteps: 1` fails)
- Lints for duplicate IDs

Any failure = pack fails to load, listing all offending cards. No silent drops.
