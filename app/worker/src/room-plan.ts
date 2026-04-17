/**
 * Room-plan generator — Hearth's full authoritative scene.
 *
 * Replaces `daily-plan.ts` as Hearth's source of truth. The DO calls
 * `generateRoomPlan(env, dateIso, roomPrompt)`; the LLM is asked to author
 * the entire room (tilemap + anchors + palette overrides + 2 NPCs); a strict
 * Zod schema validates the output; any failure (parse, validation, exception)
 * falls through to a deterministic seeded procedural generator that is a
 * direct port of `prototype-ui/src/rpg/engine.ts:generateRoomLocally`.
 *
 * The shape returned is `RoomPlan` — a superset of `DailyPlan` carrying the
 * tilemap and anchors. Phase 6E.2 wires it into `SceneWire` so the client
 * can stop authoring rooms locally.
 */

import { z } from "zod";
import type { DailyPlan, NpcDay, ScheduleSlot } from "../../shared/protocol.ts";
import { parseAiResponse } from "./ai-util.ts";
import { dayOfWeekName } from "./daily-plan.ts";

// ─── Constants ─────────────────────────────────────────────────────────────

const OPENING_HOUR = 7;
const CLOSING_HOUR = 22;

const PALETTES = ["warm", "cool", "moss", "rust", "ash", "bone"] as const;
type PaletteKey = typeof PALETTES[number];

// Glyphs the engine's renderer already knows about (drawTile in
// prototype-ui/src/rpg/engine.ts). Anything outside this set must be declared
// in the optional `palette` map so the renderer knows how to draw it.
const NATIVE_GLYPHS = new Set("#R|~wbtcl.= ");

// Tilemap shape constraints — keep the LLM honest about plausible room sizes.
const MIN_ROWS = 8;
const MAX_ROWS = 14;
const MIN_COLS = 16;
const MAX_COLS = 30;

// Hard cap on NPCs the LLM may seed at room creation. Dynamic spawns (Phase
// 6E.4) layer on top of this; the engine enforces a +2 cap on top.
const BASE_NPC_COUNT = 2;

// ─── Zod schema ────────────────────────────────────────────────────────────

const PaletteEntrySchema = z
  .object({
    name: z.string().min(1).max(40),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be #rrggbb hex"),
    walkable: z.boolean(),
    glow: z.boolean().optional(),
  })
  .strict();

const ScheduleSlotSchema = z
  .object({
    hour: z.number().int().min(0).max(23),
    activity: z.string().min(1).max(120),
    mood: z.string().min(1).max(40).optional(),
  })
  .strict();

const NpcPlanSchema = z
  .object({
    name: z.string().min(1).max(24),
    backstory: z.string().min(1).max(240),
    palette: z.enum(PALETTES),
    objective: z.string().min(1).max(160),
    motive: z.string().min(1).max(160),
    schedule: z.array(ScheduleSlotSchema).min(1).max(20),
    startAnchor: z.string().min(1).max(40),
  })
  .strict();

const CoordSchema = z.tuple([
  z.number().int().min(0),
  z.number().int().min(0),
]);

const RoomPlanSchema = z
  .object({
    tilemap: z
      .array(z.string().min(MIN_COLS).max(MAX_COLS))
      .min(MIN_ROWS)
      .max(MAX_ROWS),
    floorY: z.number().int().min(2).max(MAX_ROWS - 2),
    anchors: z.record(
      z.string().min(1).max(40),
      CoordSchema,
    ),
    palette: z
      .record(z.string().length(1), PaletteEntrySchema)
      .optional(),
    npcs: z.array(NpcPlanSchema).length(BASE_NPC_COUNT),
    playerObjective: z.string().min(1).max(200),
    seed: z.string().min(1).max(160),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const rows = plan.tilemap.length;
    const cols = plan.tilemap[0]?.length ?? 0;

    // All rows same width.
    for (let r = 0; r < rows; r++) {
      if (plan.tilemap[r].length !== cols) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tilemap", r],
          message: `row width ${plan.tilemap[r].length} != row 0 width ${cols}`,
        });
      }
    }

    // Floor row must be inside the grid.
    if (plan.floorY >= rows) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["floorY"],
        message: `floorY ${plan.floorY} >= rows ${rows}`,
      });
    }

    // Every glyph must be native or declared in palette.
    const declared = new Set(Object.keys(plan.palette ?? {}));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < plan.tilemap[r].length; c++) {
        const ch = plan.tilemap[r][c];
        if (!NATIVE_GLYPHS.has(ch) && !declared.has(ch)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tilemap", r],
            message: `unknown glyph "${ch}" at col ${c} (declare it in palette)`,
          });
          return; // one is enough; don't spam
        }
      }
    }

    // Anchors must be inside grid bounds.
    for (const [name, [x, y]] of Object.entries(plan.anchors)) {
      if (x >= cols || y >= rows) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["anchors", name],
          message: `anchor ${name}=[${x},${y}] outside grid ${cols}x${rows}`,
        });
      }
    }

    // NPC startAnchor must reference a real anchor.
    plan.npcs.forEach((npc, i) => {
      if (!(npc.startAnchor in plan.anchors)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["npcs", i, "startAnchor"],
          message: `startAnchor "${npc.startAnchor}" is not in anchors`,
        });
      }
    });

    // NPC palettes must differ — keeps cast visually distinct.
    if (plan.npcs.length === 2 && plan.npcs[0].palette === plan.npcs[1].palette) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["npcs", 1, "palette"],
        message: "NPC palettes must differ",
      });
    }
  });

export type RoomPlanNpc = z.infer<typeof NpcPlanSchema>;
export type RoomPlanPaletteEntry = z.infer<typeof PaletteEntrySchema>;
export type RoomPlanValidated = z.infer<typeof RoomPlanSchema>;

/** Carried across the worker as the canonical scene + plan bundle. */
export interface RoomPlan extends DailyPlan {
  tilemap: string[];
  floorY: number;
  /** name → [x, y] in tile coords. */
  anchors: Record<string, [number, number]>;
  /** Optional renderer overrides for non-native glyphs. */
  palette?: Record<string, RoomPlanPaletteEntry>;
  /** "ai" when LLM emitted a valid plan, "fallback" when procedural. */
  source: "ai" | "fallback";
}

// ─── LLM prompt ────────────────────────────────────────────────────────────

const ROOM_PLAN_SYSTEM = `You author a single small fictional room. The room must honor the premise the user gives you: residents, objectives, props, and the room's physical shape all sit inside that premise.

Output is a tilemap (the room you can see), anchors (named positions inside it), and exactly 2 residents who live the day there.

VOICE RULE: Plain words a 5th-grader can read. Concrete images. Short sentences. Activities are things you can SEE happen ("sweeps ash from the hearth", not "contemplates existence").

TILEMAP RULES:
- 11 rows tall, 20 columns wide (you may go 8-14 rows, 16-30 cols if the premise truly needs it).
- Every row MUST be the exact same width.
- Use these glyphs only:
    #  wall (perimeter + interior walls)
    .  floor (open standable space)
    |  doorframe (one tile, on the floor row, in a perimeter wall)
    ~  hearth / fireplace (3-tile-wide block typical, against a side wall)
    w  window (one tile, on a perimeter wall, away from the hearth)
    b  bed (one tile, ON the floor row)
    t  table (one tile, ON the floor row)
    c  chair (one tile, ON the floor row, next to a table)
    l  lantern (one tile, on a wall above the floor)
    R  ceiling beam (one tile, on the top interior row, decorative)
    =  bar / counter (one tile, ON the floor row)
- Wrap the room in a perimeter of #. Put a single | door punched into it on the floor row.
- The floor row is the row where characters stand. Pick floorY (e.g. 9 for an 11-row map). Below that row is foundation.

ANCHORS:
- Named positions characters walk to. Names should reflect props in the room (e.g. "door", "hearth_face", "window_sill", "bedside", "table_a", "letter_table", "lantern_under").
- Coordinates are [x, y] tile indices. Visual anchors (hearth, window, lantern, altar) may use the prop's own y; standing anchors should use floorY so walks land on walkable floor.
- Provide at least 4 anchors. Always include one for the door.

PALETTE (optional):
- If you use any glyph NOT in the native set above, declare it in palette: { "X": {"name": "...", "color": "#rrggbb", "walkable": true|false, "glow": true|false} }. Otherwise omit the field.

NPCs:
- Exactly 2.
- Distinct palette enums chosen from: warm, cool, moss, rust, ash, bone (must differ between the two).
- startAnchor MUST be one of the anchor names you defined above.
- schedule covers integer hours from 7 to 22 inclusive (16 entries), each entry one observable activity tied to the room/premise.

Return STRICT JSON only, no preamble, no markdown:
{
  "tilemap": ["####################", "#..................#", ...],
  "floorY": 9,
  "anchors": { "door": [10, 9], "hearth_face": [3, 6], ... },
  "palette": { },
  "npcs": [
    { "name": "...", "backstory": "...", "palette": "warm", "objective": "...", "motive": "...", "schedule": [{"hour":7,"activity":"...","mood":"..."}, ...16 total...], "startAnchor": "hearth_face" },
    { "name": "...", "backstory": "...", "palette": "ash", "objective": "...", "motive": "...", "schedule": [{"hour":7,"activity":"..."}, ...], "startAnchor": "bedside" }
  ],
  "playerObjective": "one sentence — what the player is working toward across several short visits",
  "seed": "one-line flavor (weather, smell, mood)"
}`;

interface AiBinding {
  run(model: string, options: unknown): Promise<unknown>;
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function generateRoomPlan(
  env: { AI: AiBinding },
  dateIso: string,
  roomPrompt?: string,
  inheritedMemory?: string,
): Promise<RoomPlan> {
  const dayOfWeek = dayOfWeekName(dateIso);
  const premise = roomPrompt && roomPrompt.trim()
    ? roomPrompt.trim()
    : "a quiet inn / tavern at the edge of a kingdom";
  const memoryLine = inheritedMemory && inheritedMemory.trim()
    ? `Continuity from earlier floors in this building (treat this floor as the next chapter — let these events shape mood, objects, and NPCs, but don't restate them):\n${inheritedMemory.trim()}`
    : "";
  const userPrompt = [
    `Room premise: ${premise}.`,
    memoryLine,
    `Date: ${dateIso} (${dayOfWeek}).`,
    `Open hours: ${OPENING_HOUR}:00 — ${CLOSING_HOUR}:00.`,
    `Generate the room. Return STRICT JSON only.`,
  ].filter(Boolean).join("\n");

  try {
    const ai = (await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: ROOM_PLAN_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 3500,
      temperature: 0.7,
    } as never)) as unknown;
    const parsed = parseAiResponse(ai);
    const result = RoomPlanSchema.safeParse(parsed);
    if (result.success) {
      return assembleRoomPlan(result.data, dateIso, dayOfWeek, "ai");
    }
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        ev: "ai",
        stage: "room-plan:invalid",
        issues: result.error.issues.slice(0, 5).map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
        sample: JSON.stringify(parsed ?? null).slice(0, 600),
      }),
    );
  } catch (e) {
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        ev: "ai",
        stage: "room-plan:exception",
        error: String(e),
      }),
    );
  }

  return proceduralRoomPlan(premise, dateIso, dayOfWeek);
}

function assembleRoomPlan(
  v: RoomPlanValidated,
  dateIso: string,
  dayOfWeek: string,
  source: "ai" | "fallback",
): RoomPlan {
  const npcs: NpcDay[] = v.npcs.map((n) => ({
    name: n.name,
    backstory: n.backstory,
    palette: n.palette,
    objective: n.objective,
    motive: n.motive,
    schedule: normalizeSchedule(n.schedule),
    startAnchor: n.startAnchor,
  }));
  return {
    date: dateIso,
    dayOfWeek,
    playerObjective: v.playerObjective,
    npcs,
    openingHour: OPENING_HOUR,
    closingHour: CLOSING_HOUR,
    seed: v.seed,
    tilemap: v.tilemap,
    floorY: v.floorY,
    anchors: v.anchors,
    palette: v.palette,
    source,
  };
}

/**
 * Pad/clip the LLM-emitted schedule to cover hours OPENING_HOUR..CLOSING_HOUR
 * inclusive, in order — same shape `daily-plan.ts:coerceSchedule` produces.
 */
function normalizeSchedule(slots: ScheduleSlot[]): ScheduleSlot[] {
  const byHour = new Map<number, ScheduleSlot>();
  for (const s of slots) byHour.set(s.hour, s);
  const out: ScheduleSlot[] = [];
  let last: ScheduleSlot | null = null;
  for (let h = OPENING_HOUR; h <= CLOSING_HOUR; h++) {
    const slot = byHour.get(h);
    if (slot) {
      out.push(slot);
      last = slot;
    } else if (last) {
      out.push({ ...last, hour: h });
    } else {
      out.push({ hour: h, activity: "waits in the room" });
    }
  }
  return out;
}

// ─── Procedural fallback ───────────────────────────────────────────────────
// Direct port of prototype-ui/src/rpg/engine.ts:generateRoomLocally — same
// seed → same layout, so a given room's fallback shape is stable across
// sessions. Plus a canned 2-NPC pair so the scene is always populated.

export function proceduralRoomPlan(
  premise: string,
  dateIso: string,
  dayOfWeek: string,
): RoomPlan {
  let seed = 0;
  for (let i = 0; i < premise.length; i++) {
    seed = (seed * 31 + premise.charCodeAt(i)) >>> 0;
  }
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const cols = 18 + Math.floor(rand() * 5); // 18-22
  const rows = 11;
  const floorY = 9;

  const grid: string[] = [];
  for (let r = 0; r < rows; r++) {
    let row = "";
    for (let c = 0; c < cols; c++) {
      if (c === 0 || c === cols - 1) row += "#";
      else if (r === 0 || r === rows - 1) row += "#";
      else row += ".";
    }
    grid.push(row);
  }
  const setCell = (r: number, c: number, ch: string) => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    grid[r] = grid[r].slice(0, c) + ch + grid[r].slice(c + 1);
  };

  // Door punched into the floor row.
  const doorX = Math.max(2, Math.min(cols - 3, Math.floor(cols / 2) + (Math.floor(rand() * 5) - 2)));
  setCell(floorY, doorX, "|");

  // Hearth — 3x3 against left or right wall, base floor-y - 4.
  const hearthOnLeft = rand() < 0.5;
  const hearthX = hearthOnLeft ? 2 : cols - 5;
  const hearthY = floorY - 4;
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      setCell(hearthY + dy, hearthX + dx, "~");
    }
  }

  // Window opposite hearth, on the back wall.
  const windowX = hearthOnLeft ? cols - 4 : 3;
  const windowY = 2;
  setCell(windowY, windowX, "w");

  // Bed in the corner farthest from the door.
  const bedXBase = hearthOnLeft ? cols - 3 : 2;
  const bedX = Math.abs(bedXBase - doorX) < 2
    ? (hearthOnLeft ? cols - 2 : 1)
    : bedXBase;
  setCell(floorY - 1, bedX, "b");

  // 1-2 tables + a chair.
  const tableXs: number[] = [];
  const tableCount = 1 + Math.floor(rand() * 2);
  for (let i = 0; i < tableCount; i++) {
    let tx = 4 + Math.floor(rand() * (cols - 8));
    for (let tries = 0; tries < 8; tries++) {
      const conflict =
        Math.abs(tx - doorX) < 2 ||
        (hearthOnLeft && tx < hearthX + 4) ||
        (!hearthOnLeft && tx > hearthX - 1) ||
        tableXs.some((x) => Math.abs(x - tx) < 2);
      if (!conflict) break;
      tx = (tx + 3) % (cols - 4) + 2;
    }
    tableXs.push(tx);
    setCell(floorY - 1, tx, "t");
  }
  if (tableXs.length > 0) {
    const chairX = Math.max(2, Math.min(cols - 3, tableXs[0] + 1));
    setCell(floorY - 1, chairX, "c");
  }

  // Lantern wall-mount opposite the hearth.
  const lanternX = hearthOnLeft ? cols - 2 : 1;
  setCell(floorY - 2, lanternX, "l");

  const anchors: Record<string, [number, number]> = {
    door: [doorX, floorY],
    hearth_face: [hearthX + 1, floorY],
    window_sill: [windowX, windowY],
    bedside: [bedX, floorY],
    lantern: [lanternX, floorY - 2],
    center: [Math.floor(cols / 2), floorY],
  };
  tableXs.forEach((x, i) => {
    anchors[`table_${i}`] = [x, floorY];
  });

  // Canned 2-NPC seed — always something to populate the scene with even
  // when the LLM is offline. Names + descriptions are intentionally generic;
  // the LLM path is what gives a room its character.
  const npcs: NpcDay[] = [
    {
      name: "Marek",
      backstory: "Has swept this floor since his father did. Something under it has begun to tap back.",
      palette: "warm",
      objective: "Keep the room standing one more night without telling anyone why.",
      motive: "A debt he cannot name out loud without giving it shape.",
      schedule: cannedSchedule([
        "opens the shutters and lets the cold in",
        "sweeps ash from the hearth",
        "counts the coins in the till slowly",
        "stares at the door as if expecting someone",
      ]),
      startAnchor: "hearth_face",
    },
    {
      name: "Idris",
      backstory: "Arrived three nights ago with a lantern that will not light.",
      palette: "ash",
      objective: "Wait for a reply that may not come.",
      motive: "Afraid to leave and afraid to stay.",
      schedule: cannedSchedule([
        "sits by the window writing nothing",
        "rubs at the lantern's glass as if warming it",
        "drinks water and waits",
        "watches the door without moving",
      ]),
      startAnchor: "window_sill",
    },
  ];

  return {
    date: dateIso,
    dayOfWeek,
    playerObjective: "Find out why the lantern keeps swinging when the wind is down.",
    npcs,
    openingHour: OPENING_HOUR,
    closingHour: CLOSING_HOUR,
    seed: `${dayOfWeek} — the fire keeps its slow count, the rain does not.`,
    tilemap: grid,
    floorY,
    anchors,
    source: "fallback",
  };
}

function cannedSchedule(activities: string[]): ScheduleSlot[] {
  const slots: ScheduleSlot[] = [];
  for (let h = OPENING_HOUR; h <= CLOSING_HOUR; h++) {
    slots.push({ hour: h, activity: activities[(h - OPENING_HOUR) % activities.length] });
  }
  return slots;
}

/** Exposed for tests — same Zod schema generateRoomPlan uses internally. */
export const __schema = RoomPlanSchema;

/** Avoid linter warning about unused PaletteKey — kept exported in case
 *  callers want to discriminate on it. */
export type { PaletteKey };
