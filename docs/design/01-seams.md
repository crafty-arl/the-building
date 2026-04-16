# 01 — The Seven Seams

The game's mechanics are drawn from seven unique capabilities in the Pi / Kimi K2.5 / Gemma 4 / Cloudflare stack. Every card's mechanic ID resolves to exactly one seam. This document is the engineering spec for what each seam *is* and how it shows up in the UI.

---

## Seam 1 — **Time** (Pi session tree)

### What the tech does
Pi's `SessionManager` exposes the session as a **branching tree**, not a linear log:
- `getBranch(id?)` — walk from an entry to the root
- `getTree()` — full tree
- `branch(entryId)` — move current leaf back in time (other entries still exist)
- `ctx.fork(entryId)` — spawn a new session branching from that entry
- `branchWithSummary(entryId, summary)` — labeled checkpoint

Extensions that persist state into session entries (see Principle 3 in `00-principles.md`) **automatically rewind/fork with the tree**. This is Pi-unique — no other agent framework offers this as a primitive.

### What's gamifiable
- Time travel as a first-class verb
- Parallel timelines as visitable places
- Named chapters as bookmarks / totems
- Regret / forgiveness / do-over as design motif

### Mechanic IDs
| ID | Call | Constraint |
|---|---|---|
| `time.branch` | `sessionManager.branch(leaf - N)` | Costs increase with N |
| `time.fork` | `ctx.fork(entryId)` | Rare; forks create persistent timelines |
| `time.chapter` | `branchWithSummary(entryId, title)` | Free; just labels |
| `time.return` | `sessionManager.branch(forkRoot)` | Re-enter a prior fork |

### Visibility requirements
- **Timeline panel** always visible: nodes, branches, forks, current leaf highlighted
- When a time mechanic fires: the leaf visibly *moves* on the tree, old entries grey-out, scene text replays
- Forks render as secondary branches with their own subtree

### Card examples
| Setting | Card | Mechanic |
|---|---|---|
| Occult | The Quiet Candle | `time.branch` |
| Cozy | The Same Tuesday Twice | `time.branch` |
| Noir | Retrace Your Steps | `time.branch` |
| Occult | Shadow-Self | `time.fork` |
| Mythic | The Regent's Reprieve | `time.branch` |

### Risks
- Cheap `time.branch` breaks stakes. Gate hard with cost + cooldown + narrative resistance.
- Forks explode storage. Cap forks per player; garbage-collect unvisited forks after 30 days.

---

## Seam 2 — **Mind** (Kimi ↔ Gemma switching + thinking modes)

### What the tech does
Pi's `Agent` class supports `setModel()` mid-session. Our stack has two models registered with distinct personalities:
- **Kimi K2.5** — 1T-param MoE (384 experts, 8 active), 256k context, vision-native, Thinking Mode emits `reasoning_content`
- **Gemma 4 26B-A4B** — MoE with only 4B active parameters, near-4B latency, configurable thinking modes

Both expose reasoning traces when thinking mode is on. Gemma is near-free on Cloudflare; Kimi is paid.

### What's gamifiable
- Two visibly different *moods* for the same character
- Spending real resource (Kimi tokens) = weight/stakes
- Reasoning traces become readable in-game artifacts ("glimpses of thought")
- Swarm mode (Kimi's self-directed decomposition) = consulting parallel selves

### Mechanic IDs
| ID | Call | Cost |
|---|---|---|
| `mind.deep` | `setModel(kimi); thinkingLevel: "high"` | Expensive; shows reasoning |
| `mind.fast` | `setModel(gemma); thinkingLevel: "off"` | Cheap; no trace |
| `mind.medium` | `setModel(gemma); thinkingLevel: "medium"` | Middle cost |
| `mind.swarm` | Kimi multi-agent prompt (domain sub-agents) | Very expensive |
| `mind.shift` | `setModel(...)` with narrative framing | Mechanical + flavor |

### Visibility requirements
- **Mind panel**: current model + thinking mode as a stance/posture icon, not text
- When `mind.deep` fires: reasoning trace streams into a collapsible "inner voice" pane
- When `mind.swarm` fires: multiple concurrent sub-voices render side by side briefly

### Card examples
| Setting | Card | Mechanic |
|---|---|---|
| Occult | The Listening Room | `mind.deep` |
| Cyber | Uplink | `mind.deep` |
| Occult | Instinct | `mind.fast` |
| Occult | Council of Shades | `mind.swarm` |

### Risks
- Reasoning traces may leak system-prompt details; redact before display
- Swarm mode is expensive; cap invocations per session

---

## Seam 3 — **Ward** (Pi permission gates)

### What the tech does
Pi exposes:
- `tool_call` hook: can **block** a tool invocation with a reason
- `before_agent_start`: can **inject systemPrompt additions** for the next turn
- UI-confirmable blocks (prompts user to allow/deny)
- Hooks stack; multiple extensions compose

### What's gamifiable
- Binding / vowing / warding / sealing as design motifs
- Permanent constraints ("he cannot lie to you") as playable objects
- Temptation mechanics — offer a forbidden action, force a choice

### Mechanic IDs
| ID | Effect |
|---|---|
| `ward.block` | Register a block on a tool or tool+argument pattern for N turns |
| `ward.inject` | Add to next turn's systemPrompt |
| `ward.vow` | Permanent systemPrompt injection for the session |
| `ward.tempt` | Present an option that bypasses an active ward |
| `ward.break` | Remove an active ward (narrative cost) |

### Visibility requirements
- **Wards panel** always visible: list of active wards with source card + remaining duration
- When a ward blocks an action: visible "struck-through" event in the scene log with the ward's name
- When a ward is broken: audible/visible snap; the ward leaves the list

### Card examples
| Setting | Card | Mechanic |
|---|---|---|
| Occult | Sigil on the Door | `ward.block` |
| Mythic | A Vow Spoken | `ward.vow` |
| Noir | The Fifth Amendment | `ward.block` |
| Occult | A Whisper on the Threshold | `ward.tempt` |

### Risks
- Wards accumulate and paralyze. Cap active wards per session (e.g. 5).
- Injected systemPrompt can bloat context; measure token cost and bound it.

---

## Seam 4 — **Memory** (context manipulation)

### What the tech does
Pi's session entries *are* the context. An extension can:
- Inject a synthetic entry (`ctx.sessionManager.appendEntry(...)`) to re-surface a past moment
- Strip entries from the branch (via selective `branch()`)
- Compress entries into a summary (via `branchWithSummary`)

Kimi's 256k context makes this especially powerful — you can keep or replay enormous history without pruning.

### What's gamifiable
- Memory as a resource (limited, precious, weigh-able)
- Forgetting as a move (strategic or tragic)
- Keepsakes — specific memories crystallized into objects
- True-names — specific prior facts played as cards

### Mechanic IDs
| ID | Effect |
|---|---|
| `memory.recall` | Inject a synthetic "the Claw remembers..." entry referencing past entry N |
| `memory.forget` | Branch to an earlier leaf that omits specific entries |
| `memory.weigh` | Replace N raw entries with one authored summary |
| `memory.crystallize` | Mint a Keepsake card from a current-scene entry |

### Visibility requirements
- **Memory panel** always visible: last ~5 highlighted entries
- When `memory.recall` fires: the recalled entry surfaces in memory pane with a glow
- When `memory.crystallize` fires: pack-opening animation on the new Keepsake card

### Card examples
| Setting | Card | Mechanic |
|---|---|---|
| Occult | Speak the True Name | `memory.recall` |
| Occult | Salt on the Tongue | `memory.forget` |
| Cozy | I Remember You Said | `memory.recall` |
| Occult | A Coin from Tuesday | `memory.crystallize` |

### Risks
- Context bloat. Aggressive summary-then-drop policy.
- False memories if `memory.recall` fabricates content; only inject references to real prior entries.

---

## Seam 5 — **Sight** (Kimi vision input)

### What the tech does
Kimi K2.5 was trained on images + text as a unified stream (not a bolted-on captioner). Pi's content types support image blocks natively. We can:
- Render a scene to an SVG/PNG and feed it to Kimi
- Feed user-provided images (with care)
- Use it for "reading" visual artifacts (maps, portraits, tarot-like card faces)

### What's gamifiable
- Scrying / divination / reading signs as design motifs
- Visual puzzles — the model actually *sees* the scene, can solve what the player can
- Cards with art that affects outcome when "looked at"

### Mechanic IDs
| ID | Effect |
|---|---|
| `sight.scry` | Render scene → Kimi vision → prose insight |
| `sight.read` | Pass a specific card's art to Kimi for interpretation |
| `sight.portrait` | Read an NPC's portrait for mood/intent detection |

### Visibility requirements
- When a sight mechanic fires: a visible "gaze" animation on the art being read
- The Claw's "insight" returns as a special scene-log entry tagged *seen*
- The image actually used (scene render / card art) is briefly highlighted

### Card examples
| Setting | Card | Mechanic |
|---|---|---|
| Occult | Scry the Wine | `sight.scry` |
| Cyber | Ocular Feed | `sight.scry` |
| Noir | Look at the Photograph | `sight.read` |
| Cozy | Check the Window | `sight.portrait` |

### Risks
- Vision is expensive. Gate with cost.
- Model may hallucinate details not in the render. Use deterministic rendering + strict prompts.

---

## Seam 6 — **Momentum** (session affinity + caching)

### What the tech does
Cloudflare Workers AI honors an `x-session-affinity` header for **prompt caching**: consecutive calls in the same session get a sticky model instance with prefix-cache hits. Sequential plays in one scene are cheaper and faster. Breaking the scene resets affinity.

### What's gamifiable
- Rhythm / groove / song mechanic — reward for staying in a scene
- Break / interrupt as a narrative move with cost
- Visible momentum meter

### Mechanic IDs
| ID | Effect |
|---|---|
| `momentum.hold` | Pin affinity for the current scene; consecutive plays get +1 strength |
| `momentum.interrupt` | Reset affinity, but reveal a hidden card |
| `momentum.cascade` | Spend accumulated momentum for a single big play |

### Visibility requirements
- **Momentum meter**: visible stack/chain icon. Each consecutive play adds to it.
- When meter fills: a visible glow; next card can be played as cascade
- When interrupted: visible snap; meter drops

### Card examples
| Setting | Card | Mechanic |
|---|---|---|
| Occult | Keep the Drum | `momentum.hold` |
| Cozy | Stay a While | `momentum.hold` |
| Mythic | Hold the Hall | `momentum.hold` |
| Occult | Break the Circle | `momentum.interrupt` |

### Risks
- Momentum cooldown not visible → feels unfair. Always show why next play is cheaper.

---

## Seam 7 — **Act** (world-tool extensions)

### What the tech does
Pi's extension system lets us register custom tools with TypeBox schemas. Each world verb (speak, move, offer, strike, search, buy, hide) is a Pi tool that:
- Validates input
- Calls into world-state mutators (D1 for persistent, DO memory for session)
- Writes a tool result into the session (persisted forever)
- Returns `details` that UI renders as the receipt

### What's gamifiable
- The game's surface: these are the direct actions in the world
- Each `act.*` card is a scripted tool call with narrative framing

### Mechanic IDs
| ID | Effect |
|---|---|
| `act.speak` | Emit dialogue to a target NPC; NPC replies via their Pi session |
| `act.move` | Change location node |
| `act.offer` | Give an inventory item to an NPC |
| `act.strike` | Resolve a conflict with cost to both sides |
| `act.search` | Reveal hidden content at current node |
| `act.craft` | Combine inventory items into a new item |

### Visibility requirements
- **Scene panel** updates immediately with the act's result
- Inventory updates animate
- Map updates animate on move

### Card examples
| Setting | Card | Mechanic |
|---|---|---|
| Occult | Ask Who They Are | `act.speak` |
| Cozy | Go to the Market | `act.move` |
| Occult | Offer a Coin | `act.offer` |
| Noir | Press Them | `act.strike` |

### Risks
- These cards must feel meaningful, not generic. Flavor aggressively per setting.

---

## Seam combinations

Cards should typically fire ONE seam. Multi-seam cards exist but are rare and powerful:

- A Keepsake that also Wards: `[A GRANDMOTHER'S RECIPE]` — recall + vow
- A Fork that names itself: `[THE PATH NOT TAKEN]` — fork + chapter
- A Sight that feeds Memory: `[DREAM OF HER FACE]` — scry + crystallize

Rule: a card may fire at most 2 seams, and its cost must scale linearly with seam count.

---

## Seam cost model (draft)

| Seam | Base Footstep cost | Token cost (approx.) |
|---|---|---|
| `act.*` | 1 | 1–3k tokens per call |
| `mind.fast` | 1 | Gemma, free tier |
| `mind.medium` | 2 | Gemma with thinking |
| `mind.deep` | 3 | Kimi, ~5–10k tokens |
| `mind.swarm` | 5 | Kimi, ~20–50k tokens |
| `sight.*` | 2 | Kimi vision, +image cost |
| `memory.recall` | 1 | Minimal |
| `memory.forget` | 2 | Minimal but irreversible |
| `memory.crystallize` | 3 | Mint real card |
| `ward.block` | 2 | Free (server-side) |
| `ward.vow` | 4 | Persistent cost |
| `time.branch` | 3 | Free mechanically, heavy narratively |
| `time.fork` | 5 | Storage cost per fork |
| `momentum.hold` | 0 (passive) | Saves tokens |
| `momentum.cascade` | spends meter | Big token cost on fire |

Costs are balanced in testing; Footsteps are the player-facing currency.
