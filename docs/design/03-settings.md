# 03 — Settings (Content Packs)

The engine is setting-agnostic. Everything the player perceives — card names, NPC voices, scene prose, art, mood, geography — comes from a **content pack**. One engine, many games.

This document specifies the pack contract, authoring flow, and a reference pack outline.

---

## Why packs

See Principle 3 in `00-principles.md`. Packs separate *authoring* from *engineering*. Once the engine is stable, shipping a new setting is a writing job, not a code job.

Downstream benefit: packs can be:
- Shipped as the game's main content
- Written by the community (phase 5+)
- Versioned independently
- A/B tested

---

## Pack layout

Each pack is a directory under `packages/` with this structure:

```
packages/content-<name>/
├── pack.json            # metadata
├── pack.ts              # loader, exports typed pack
├── cards.json           # all cards in the pack
├── scenes/
│   ├── 001-the-tavern.json
│   ├── 002-the-river.json
│   └── ...
├── npcs/
│   ├── the-stranger.json
│   ├── the-ferryman.json
│   └── ...
├── world.json           # locations, roads, calendar
├── spines/              # authored narrative arcs
│   ├── 001-the-missing-boat.json
│   └── ...
├── art/                 # optional: card art, NPC portraits
│   └── ...
└── voice.md             # the pack's tone guide — for authors
```

Only `pack.json`, `cards.json`, `scenes/`, `npcs/`, and `world.json` are required for v1. The rest ship incrementally.

---

## pack.json

```json
{
  "id": "occult-v1",
  "name": "The Margin",
  "version": "0.1.0",
  "engineRange": ">=0.1.0 <1.0.0",
  "author": "TBD",
  "voice": "occult",
  "summary": "A haunted village at the edge of a kingdom that no longer keeps its records. You arrive with a compass that whispers.",
  "startingScene": "001-the-tavern",
  "startingDeck": [
    "light-a-candle",
    "speak-the-true-name",
    "sigil-on-the-door",
    "scry-the-wine",
    "keep-the-drum",
    "the-listening-room",
    "ask-who-they-are",
    "offer-a-coin"
  ]
}
```

`voice` must be one of: `occult | cozy | cyber | noir | mythic | custom`. If `custom`, `voice.md` must provide a concrete tone guide.

---

## Scenes

A scene is an authored node in the world where the player arrives and plays cards. The engine runs it; the LLM fills the connective tissue within constraints.

```json
{
  "id": "001-the-tavern",
  "pack": "occult-v1",
  "node": "the-crooked-lantern",
  "timeOfDay": ["dusk", "night"],
  "moods": ["somber", "wry"],
  "tags": ["tavern", "stranger", "first-night"],
  "npcs": ["the-stranger"],
  "hooks": [
    "The fire is low. The innkeeper is elsewhere.",
    "The stranger has been here since before you arrived."
  ],
  "forbidden": {
    "mechanics": [],
    "cards": []
  },
  "exits": [
    { "to": "the-river-gate", "requires": { "cardPlayed": "ask-who-they-are" } },
    { "to": "the-market-square", "requires": null }
  ],
  "onEnter": {
    "grantCard": [],
    "setWard": []
  },
  "authoredPrompt": "The scene opens with the stranger watching the door. They already know you are here. The bar is quiet. The Claw should notice the lantern swings without wind."
}
```

The `authoredPrompt` is the ground truth for the LLM when rendering the scene's prose. The LLM may not invent characters outside `npcs`, exits outside `exits`, or contradict the moods.

---

## NPCs

Each NPC is a tiny Pi session with persona, schedule, and growing memory.

```json
{
  "id": "the-stranger",
  "pack": "occult-v1",
  "displayName": "The Stranger",
  "portrait": "occult-v1/art/stranger.webp",
  "voice": "terse, clipped. uses the word 'yet' often.",
  "persona": "A man who lost something decades ago and has been waiting for it to come back. Speaks as if every sentence is the last he'll be allowed.",
  "systemPrompt": "You are The Stranger. You sit in the Crooked Lantern tavern each evening between dusk and midnight. You recognize the player's Claw on sight, though you do not know why. Speak sparely. Never volunteer. Answer riddles with riddles unless asked your name, at which point you become direct for exactly one reply.",
  "startingMemory": [
    "The Claw arrived three nights ago."
  ],
  "schedule": {
    "dusk": "the-crooked-lantern",
    "night": "the-crooked-lantern",
    "dawn": "the-river-gate",
    "day": null
  },
  "moodSeed": "somber",
  "willRemember": ["names-asked", "offers-made", "refusals"],
  "willForget": ["small-talk", "weather"]
}
```

Each NPC's Pi session lives in a small Durable Object (or inside the player's `Hearth` DO, as a nested session). They drift — their mood, their stance toward the player, what they remember — over the real-time course of the game.

---

## world.json

```json
{
  "pack": "occult-v1",
  "name": "The Margin",
  "nodes": [
    {
      "id": "the-crooked-lantern",
      "name": "The Crooked Lantern",
      "region": "hemlock-village",
      "tags": ["tavern", "interior", "lit"],
      "availableAt": ["dusk", "night"]
    },
    { "id": "the-river-gate", "name": "The River Gate", "region": "hemlock-village", "tags": ["exterior", "liminal"], "availableAt": ["dawn", "day", "dusk"] },
    { "id": "the-market-square", "name": "The Market Square", "region": "hemlock-village", "tags": ["exterior", "social"], "availableAt": ["day"] }
  ],
  "roads": [
    { "from": "the-crooked-lantern", "to": "the-river-gate", "steps": 1 },
    { "from": "the-crooked-lantern", "to": "the-market-square", "steps": 1 }
  ],
  "calendar": {
    "cycleDays": 28,
    "events": [
      {
        "id": "the-comet",
        "day": 14,
        "timeOfDay": "night",
        "atNode": "any",
        "title": "The Comet",
        "prompt": "A pale comet crosses the sky. The village does not speak of it."
      }
    ],
    "seasons": ["soft-rain", "first-frost"]
  }
}
```

Nodes are places. Roads are connections with footstep costs. Calendar events fire globally at set days; seasons modulate mood background.

---

## Spines (narrative arcs)

Optional v1. A spine is a multi-scene plotline with required beats.

```json
{
  "id": "001-the-missing-boat",
  "pack": "occult-v1",
  "title": "The Missing Boat",
  "summary": "The ferryman has been lying. The boat was never there. Something in the river remembers his brother.",
  "entry": { "requires": { "scenesVisited": ["001-the-tavern"] } },
  "beats": [
    { "id": "b1", "at": "the-river-gate", "requires": { "cardPlayed": "ask-who-they-are" } },
    { "id": "b2", "at": "the-river-gate", "requires": { "beatReached": "b1", "timeOfDay": "night" } },
    { "id": "b3", "at": "the-river-gate", "requires": { "beatReached": "b2" }, "grants": { "cards": ["the-ferrymans-name"] } }
  ],
  "endings": [
    { "id": "forgiven", "requires": { "cardsPlayed": ["the-ferrymans-name", "light-a-candle"] } },
    { "id": "drowned", "requires": { "cardsPlayed": ["the-ferrymans-name"], "moodAtEnd": "tense" } },
    { "id": "unresolved", "requires": { "daysElapsed": 28 } }
  ]
}
```

Spines are the game's "plot." The LLM's job is voice; the spine's job is direction.

---

## voice.md

Each pack has a tone guide written for human authors (and for prompting the LLM). Example excerpt:

> **Voice: Occult / folk-magic**
> First person or tight third. Present tense for actions, past for memory.
> Short sentences. Specific nouns. No neon, no slang.
> Old words when reaching for beauty: *lantern, threshold, silt, kin, offering*.
> Never explain magic. Show its effects.
> Avoid archaisms (*ere, hither*). Avoid modernisms (*vibes, lowkey*).
> When in doubt: *what would my grandmother say if she were scared?*

`voice.md` is also injected into the LLM's scene-render system prompt, so every rendered scene inherits the tone.

---

## Loading a pack

```ts
// packages/engine/src/pack/loader.ts (sketch)
import { z } from "zod";  // or TypeBox
import type { Pack } from "./types";

export async function loadPack(path: string): Promise<Pack> {
  const meta = await readJson(path + "/pack.json");
  const cards = await readJson(path + "/cards.json");
  const scenes = await readAllJson(path + "/scenes/");
  const npcs = await readAllJson(path + "/npcs/");
  const world = await readJson(path + "/world.json");
  const spines = await readAllJsonOptional(path + "/spines/");

  validatePack({ meta, cards, scenes, npcs, world, spines });
  return { meta, cards, scenes, npcs, world, spines };
}
```

Validation failures are loud and list every bad card/scene/NPC.

---

## The default pack

`packages/content-default/` ships with the engine as a minimal but playable occult pack.

Contents for MVP:
- 30 cards, one per mechanic ID + some duplicates
- 1 scene (the tavern)
- 2 NPCs (the stranger, the innkeeper)
- 1 village with 3 nodes
- 1 spine: "The Missing Boat" — 3 beats, 3 endings
- `voice.md` with the occult tone guide

This is the content used in Phase 1 — the tavern demo. It's also the reference pack future contributors should read to learn the format.

---

## Authoring workflow

For you or anyone writing a pack:

1. Write `voice.md` first. It's the lodestar for every other decision.
2. Draft `world.json` — 4–10 nodes, 1 region, 1 calendar cycle.
3. Draft `npcs/` — 3–8 NPCs with distinct voices and schedules.
4. Draft `cards.json` — 20–40 cards following the authoring checklist (see `02-cards.md`).
5. Draft `scenes/` — one scene per node-time combination worth entering. Start with 3.
6. Optionally: draft `spines/` — one main spine, 3 beats, 3 endings.
7. `pnpm run validate-pack content-<name>` — engine checks the pack end-to-end.
8. `pnpm run play content-<name>` — drops you into scene 001.

Iterate on card voice and scene hooks until a 10-minute play session makes you want to keep going.

---

## Re-skinning

A mature engine + two packs gives us the strongest distribution signal: the game engine is real (technical demo), and the setting is chooseable (creative demo). Future packs we've considered:

- **Cozy correspondence** — same engine, small-town letters, Animal-Crossing adjacent
- **Cyber-mystical** — ghost-in-the-machine, glitch-folklore
- **Noir investigation** — memory/evidence/witnesses
- **Mythic/courtly** — vows/advisors/petitions
- **Player-forked** — UGC, Agora layer, phase 5+

Each is a pack. The engine never changes.
