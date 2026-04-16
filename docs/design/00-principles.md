# 00 — Principles

The design rules that make this game, this game. If a decision breaks one of these, revisit the decision.

---

## 1. The Three-Layer Rule

Every card — and by extension, every game action — has three layers. If any layer leaks in isolation, immersion dies.

| Layer | What it is | Example |
|---|---|---|
| **Fiction** | The in-world act the player performs | *You light a candle at your grandmother's icon.* |
| **Effect** | What the player visibly sees change | *The last moment plays again, softer. The stranger's answer is different this time.* |
| **Mechanic** | The real Pi / Kimi / Gemma operation | `sessionManager.branch(lastEntry - 1)` |

**All three must align.** The fiction must *feel like* the effect. The effect must *be* the mechanic. The mechanic must never be seen by the player as itself.

A player should never think *"I rewound the session."* They should think *"I lit a candle and the night softened."*

### Anti-patterns

- ❌ `[REWIND]` — mechanic name as card name. Tech shows through.
- ❌ `[THE CANDLE OF HOLY GRIEF]` with no visible effect. Fiction floats.
- ❌ Rewinding silently with a status toast. Mechanic fires without the player witnessing it.

### The alignment test

Read the card's fiction aloud. Look at the effect on screen. Ask: *"Could someone who knows nothing about this game explain what just happened using only the fiction?"* If yes, the layers are aligned.

---

## 2. Tech disappears; receipts remain

The player never sees Pi, Kimi, Gemma, Cloudflare, or an API call. They see candles, tavern doors, rivers, letters, wards, and names.

But every action must leave a **receipt** — a visible, pointable, screenshot-worthy artifact in the game. Not a floating number. Not a status bar. A *thing*.

Valid receipts:
- A new map marker appears
- An NPC's portrait changes stance
- A letter arrives in the in-game inbox
- A branch forks on the visible timeline
- A ward appears in the wards list
- A new entry glows in the memory pane

If a card doesn't leave a receipt, it isn't a card. It's a system message.

---

## 3. Engine vs content pack

The **engine** is setting-agnostic. The **content pack** is everything the player perceives.

| Engine owns | Content pack owns |
|---|---|
| Mechanic IDs and what they do | Card fiction + flavor text |
| Session tree structure | Card names |
| Model routing | NPC personas |
| Permission hooks | Scene prose |
| Cost accounting | Art direction |
| Persistence | Voice and tone |
| UI shell | World geography |

A new setting = a new `cards.json` + `scenes/` + `npcs/` + `world.json`. Zero engine changes.

This means: **multiple games can ship on one engine.** It also means: **the engine must never hard-code a card name, a setting assumption, or a tone choice.**

---

## 4. Controlled aliveness

The world runs whether the player is logged in or not. But:
- **The player never feels railroaded.** No forced cutscenes, no "you must respond."
- **The player always controls their actions.** Pi never plays a card on their behalf.
- **Pi suggests, argues, narrates, warns.** Pi never decides.

Aliveness is ambient (weather, NPC schedules, scheduled events, slow-moving conspiracies). Control is immediate (every card in hand is the player's choice, full stop).

---

## 5. Dopamine, not slot machines

Progress is visible, scarce, and earned. Random reward is fine. Loot box psychology is not.

Good loops:
- Footsteps refill slowly → each scene matters
- Ledger fills visibly → completion drive
- Scheduled real-date events → anticipation
- Cards discovered in world → variable reward with narrative justification

Banned:
- Gachas with pay-to-retry
- Timer bypasses sold for money
- Notification spam with no content
- Artificial friction added to sell removal

---

## 6. Storytelling: authored spine, LLM skin

The LLM is the voice. The author is the plot.

- ~5 overarching narrative spines are **authored** — real plots, real twists, real endings
- ~50 scene scaffolds are **authored** with constraints (who, where, mood)
- Everything between — dialogue, description, NPC reactions — is **LLM-generated**, but **strictly bound to world state**

The LLM may not:
- Invent NPCs that don't exist in the world file
- Contradict previously established facts
- "Forget" a scene that already happened

These constraints are enforced through structured tool outputs, not prompt pleading.

---

## 7. Ownership is non-negotiable

Every player's session is exportable as a file. Every card they forge is theirs. If the service shuts down tomorrow, they keep their playthrough.

This directly addresses the Replika/Character.ai trauma pattern (see market research): users lost years of bonded agent state to policy changes. Our promise is the opposite — your Claw, your deck, your Ledger, your forked timelines are yours to export, archive, or run locally if the day comes.

A visible **Export** button must exist on every session page. Always.

---

## 8. The Pi session is sacred

The Pi session is the single source of truth for a player's run. All state derives from it or is strictly attached to it.

- World state = reducer over session entries
- Card effects = session entries + tool results
- Time travel = session tree navigation
- Parallel timelines = session forks

If the session is intact, the game is intact. If the session is lost, nothing else matters.

Implication: **session persistence is the top engineering priority.** Durability beats features.

---

## 9. Two minds, visibly

Kimi K2.5 is the **deep mind**: slow, expensive, soulful, reveals its reasoning when asked.
Gemma 4 (26B A4B) is the **fast mind**: cheap, instant, capable but shallow.

The player chooses when to invoke which — always via card fiction, never via a model dropdown. Which mind fires must be visible in the UI (a stance icon, a breath, a posture — not a string "Kimi K2.5").

The same character embodies both minds. The agent has moods.

---

## 10. Small, specific, finishable

The MVP is one town, one day, one thread, one evening of play. Ship the first letter before the second village. Ship the first card before the second deck.

Complexity accretes in production, not in design. Every feature must survive the question: *"What's the smallest version of this that makes someone say 'oh.'"*

---

## Mantras, short form

- *The tech is the spell.*
- *Receipts or it didn't happen.*
- *Engine is silent. Pack speaks.*
- *The player always draws.*
- *The session is the save.*
- *Ownership over features.*
- *The first letter ships before the second village.*
