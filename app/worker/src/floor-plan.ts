/**
 * Floor-plan generator — Hearth's authoritative scene, v2.
 *
 * Replaces the glyph-tilemap `room-plan.ts`. The DO calls
 * `generateFloorPlan(env, dateIso, roomPrompt)`; the LLM is asked to author
 * a room using **semantic tile keys** (see `shared/tileset.ts`) instead of
 * single-character glyphs. The client maps those keys to real sprite tiles
 * in its Phaser atlas — so the worker never hallucinates tile indices.
 *
 * v1 slice scope: exactly one room per floor, no portals. The schema
 * already permits multi-room floors connected by portals so the client and
 * protocol can stay stable when multi-room navigation lands.
 */

import { z } from "zod";
import type {
  DailyPlan,
  NpcDay,
  ObjectWire,
  RoomPortalWire,
  RoomWire,
  ScheduleSlot,
} from "../../shared/protocol.ts";
import {
  TILESET_KEYS,
  TILESET_REF,
  WALKABLE,
  type TilesetKey,
  type TilesetRef,
} from "../../shared/tileset.ts";
import { parseAiResponse } from "./ai-util.ts";
import { dayOfWeekName } from "./daily-plan.ts";

// ─── Constants ─────────────────────────────────────────────────────────────

const OPENING_HOUR = 7;
const CLOSING_HOUR = 22;

const PALETTES = ["warm", "cool", "moss", "rust", "ash", "bone"] as const;
type PaletteKey = (typeof PALETTES)[number];

const MIN_COLS = 16;
const MAX_COLS = 22;
const MIN_ROWS = 8;
const MAX_ROWS = 12;

const BASE_NPC_COUNT = 2;

// ─── Zod schema ────────────────────────────────────────────────────────────

const TilesetKeySchema = z.enum(TILESET_KEYS as unknown as readonly [string, ...string[]]);

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

const ObjectSchema = z
  .object({
    kind: z.enum(["anchor", "door", "stair", "spawn"]),
    name: z.string().min(1).max(40),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    leadsTo: z
      .object({
        roomId: z.string().min(1).max(40),
        objectName: z.string().min(1).max(40),
      })
      .optional(),
  })
  .strict();

const RoomSchema = z
  .object({
    id: z.string().min(1).max(40),
    name: z.string().min(1).max(60),
    cols: z.number().int().min(MIN_COLS).max(MAX_COLS),
    rows: z.number().int().min(MIN_ROWS).max(MAX_ROWS),
    ground: z.array(z.array(TilesetKeySchema)),
    collision: z.array(z.array(z.boolean())),
    objects: z.array(ObjectSchema).min(1),
  })
  .strict()
  .superRefine((room, ctx) => {
    if (room.ground.length !== room.rows) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ground"],
        message: `ground row count ${room.ground.length} != rows ${room.rows}`,
      });
      return;
    }
    for (let r = 0; r < room.rows; r++) {
      if (room.ground[r].length !== room.cols) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ground", r],
          message: `ground row ${r} width ${room.ground[r].length} != cols ${room.cols}`,
        });
        return;
      }
    }
    if (room.collision.length !== room.rows) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collision"],
        message: `collision row count ${room.collision.length} != rows ${room.rows}`,
      });
      return;
    }
    for (let r = 0; r < room.rows; r++) {
      if (room.collision[r].length !== room.cols) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["collision", r],
          message: `collision row ${r} width ${room.collision[r].length} != cols ${room.cols}`,
        });
        return;
      }
    }
    for (const obj of room.objects) {
      if (obj.x >= room.cols || obj.y >= room.rows) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["objects", obj.name],
          message: `object "${obj.name}" at [${obj.x},${obj.y}] is outside ${room.cols}x${room.rows}`,
        });
      }
    }
  });

const RoomPortalSchema = z
  .object({
    from: z.object({ roomId: z.string(), objectName: z.string() }).strict(),
    to: z.object({ roomId: z.string(), objectName: z.string() }).strict(),
    bidirectional: z.boolean().default(true),
  })
  .strict();

const FloorPlanSchema = z
  .object({
    version: z.literal(2),
    tilesetRef: z.literal(TILESET_REF),
    rooms: z.array(RoomSchema).min(1).max(6),
    portals: z.array(RoomPortalSchema),
    npcs: z.array(NpcPlanSchema).length(BASE_NPC_COUNT),
    playerObjective: z.string().min(1).max(200),
    seed: z.string().min(1).max(160),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const roomIds = new Set(plan.rooms.map((r) => r.id));
    if (roomIds.size !== plan.rooms.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rooms"],
        message: "room ids must be unique",
      });
    }
    // Portal endpoints must reference real rooms + real objects.
    for (const p of plan.portals) {
      for (const end of [p.from, p.to]) {
        const room = plan.rooms.find((r) => r.id === end.roomId);
        if (!room) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["portals"],
            message: `portal references unknown room "${end.roomId}"`,
          });
          continue;
        }
        const obj = room.objects.find((o) => o.name === end.objectName);
        if (!obj) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["portals"],
            message: `portal references unknown object "${end.objectName}" in room "${end.roomId}"`,
          });
        }
      }
    }
    // NPC startAnchor must name a real object in one of the rooms.
    plan.npcs.forEach((npc, i) => {
      const found = plan.rooms.some((room) =>
        room.objects.some((o) => o.name === npc.startAnchor),
      );
      if (!found) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["npcs", i, "startAnchor"],
          message: `startAnchor "${npc.startAnchor}" is not any room's object`,
        });
      }
    });
    // Distinct palettes so the cast looks different even with bare rectangles.
    if (plan.npcs.length === 2 && plan.npcs[0].palette === plan.npcs[1].palette) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["npcs", 1, "palette"],
        message: "NPC palettes must differ",
      });
    }
  });

export type FloorPlanNpc = z.infer<typeof NpcPlanSchema>;
export type FloorPlanValidated = z.infer<typeof FloorPlanSchema>;
export type { TilesetKey } from "../../shared/tileset.ts";

/** Carried across the worker as the canonical scene + plan bundle. */
export interface FloorPlan extends DailyPlan {
  tilesetRef: TilesetRef;
  rooms: RoomWire[];
  portals: RoomPortalWire[];
  source: "ai" | "fallback";
}

// ─── LLM prompt ────────────────────────────────────────────────────────────

const FLOOR_PLAN_SYSTEM = `You author a single small fictional room as a SIDE-VIEW cross-section (like Terraria). Residents walk along the floor; the camera sees the room from the side — ceiling up top, floor at the bottom, walls left and right, back-wall wallpaper filling the interior.

Output is one room using semantic tile keys (not glyphs), plus named objects (anchors, doors) and exactly 2 residents who live the day there.

VOICE RULE: Plain words a 5th-grader can read. Concrete images. Short sentences. Activities are things you can SEE happen ("stokes the fireplace coals", not "contemplates existence").

ROOM SHAPE (side-view):
- cols 16-22, rows 8-12. Rows run top (0) to bottom (rows-1). Every ground row has exactly \`cols\` entries.
- Row 0 is the ceiling — fill with "ceiling" across all cols.
- Row rows-1 is the floor — fill with "floor" across all cols. This is the ground the residents' feet stand on.
- Columns 0 and cols-1 for rows 1..rows-2 are "wall" (the room's left and right sides).
- Exactly ONE "door" cell — replace a "wall" at column 0 or column cols-1 on the FEET ROW (row rows-2).
- The FEET ROW (row rows-2) is where residents stand and walk. Interior cells there are "air" unless occupied by a floor-standing prop. Props stand IN this row.
- The interior rows 1..rows-3 (between the ceiling and feet row) are "background_wall" for most cells — this is the visible wallpaper behind the characters. Decorate by replacing a few background_wall cells with "window", "torch", or "painting".

TILE KEYS (use only these):
  Structural:   air, floor, wall, ceiling, background_wall
  Openings:     door, ladder
  Back-wall:    window, torch, painting
  Floor-props:  bed, chair, table, stove, fireplace, bookshelf, chest, plant, rug

PROP RULES:
- Place 3-6 floor-standing props on the FEET ROW (row rows-2). Each prop cell is a single tile, except bed which may span 2 adjacent cells.
- Keep at least half of the FEET ROW as walkable "air" between props so residents can move past each other.
- Place 1-3 back-wall decorations (window/torch/painting) on interior rows 1..rows-3.
- Rug is optional; put it on the feet row in an otherwise-empty spot (decorative; walkable).

COLLISION (boolean; true = blocks movement):
- air, background_wall, door, ladder, window, torch, painting, rug → false
- floor, wall, ceiling, bed, chair, table, stove, fireplace, bookshelf, chest, plant → true

OBJECTS (named addressable positions):
- Provide at least 4 objects. Always include one { "kind": "door", "name": "door" } at the door cell.
- Anchor names reflect props: "bedside", "fireplace_face", "table", "chair", "window_gaze", "door_mat", "center".
- Anchor (x, y) must be a WALKABLE cell on the FEET ROW where a resident can actually stand. For "window_gaze", put the anchor on the feet row beneath the window (not on the window itself).

NPCs:
- Exactly 2. Distinct palette enums chosen from: warm, cool, moss, rust, ash, bone.
- startAnchor must match one of your object names.
- schedule covers integer hours from 7 to 22 inclusive (16 entries), each entry one observable activity tied to the room/premise.

Return STRICT JSON only, no preamble, no markdown. Top-level shape:
{
  "version": 2,
  "tilesetRef": "augur-sideview-v1",
  "rooms": [
    {
      "id": "main",
      "name": "The Room",
      "cols": 18,
      "rows": 9,
      "ground": [["ceiling", ... 18 items ...], ... 9 rows ...],
      "collision": [[true, ... 18 items ...], ... 9 rows ...],
      "objects": [
        { "kind": "door", "name": "door", "x": 17, "y": 7 },
        { "kind": "anchor", "name": "fireplace_face", "x": 14, "y": 7 },
        { "kind": "anchor", "name": "bedside", "x": 3, "y": 7 },
        { "kind": "anchor", "name": "table", "x": 8, "y": 7 },
        { "kind": "anchor", "name": "window_gaze", "x": 9, "y": 7 },
        { "kind": "anchor", "name": "center", "x": 10, "y": 7 }
      ]
    }
  ],
  "portals": [],
  "npcs": [
    { "name": "...", "palette": "warm", "backstory": "...", "objective": "...", "motive": "...", "schedule": [{"hour":7,"activity":"..."}, ...16 entries...], "startAnchor": "fireplace_face" },
    { "name": "...", "palette": "ash",  "backstory": "...", "objective": "...", "motive": "...", "schedule": [{"hour":7,"activity":"..."}, ...], "startAnchor": "bedside" }
  ],
  "playerObjective": "one sentence — what the player is working toward across several short visits",
  "seed": "one-line flavor (weather, smell, mood)"
}`;

interface AiBinding {
  run(model: string, options: unknown): Promise<unknown>;
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function generateFloorPlan(
  env: { AI: AiBinding },
  dateIso: string,
  roomPrompt?: string,
  inheritedMemory?: string,
): Promise<FloorPlan> {
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
    `Generate one room. Return STRICT JSON only.`,
  ].filter(Boolean).join("\n");

  try {
    const ai = (await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: FLOOR_PLAN_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4500,
      temperature: 0.7,
    } as never)) as unknown;
    const parsed = parseAiResponse(ai);
    const result = FloorPlanSchema.safeParse(parsed);
    if (result.success) {
      return assembleFloorPlan(result.data, dateIso, dayOfWeek, "ai");
    }
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        ev: "ai",
        stage: "floor-plan:invalid",
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
        stage: "floor-plan:exception",
        error: String(e),
      }),
    );
  }

  return proceduralFloorPlan(premise, dateIso, dayOfWeek);
}

function assembleFloorPlan(
  v: FloorPlanValidated,
  dateIso: string,
  dayOfWeek: string,
  source: "ai" | "fallback",
): FloorPlan {
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
    tilesetRef: TILESET_REF,
    rooms: v.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      cols: r.cols,
      rows: r.rows,
      ground: r.ground as TilesetKey[][],
      collision: r.collision,
      objects: r.objects,
    })),
    portals: v.portals,
    source,
  };
}

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

/**
 * Deterministic single-room floor plan, SIDE-VIEW. The slice ships one
 * template; later rooms can add more templates chosen by `premise`.
 *
 * Layout convention (rows top→bottom):
 *   row 0              : ceiling × cols
 *   rows 1..rows-3     : wall at cols 0 and cols-1, background_wall between,
 *                        with a window + torch + painting decorating the back
 *   row rows-2         : "feet row" — wall at cols 0 and cols-1 (one side
 *                        replaced by a door), air between, floor-standing
 *                        props placed on this row
 *   row rows-1         : floor × cols
 */
export function proceduralFloorPlan(
  premise: string,
  dateIso: string,
  dayOfWeek: string,
): FloorPlan {
  let seed = 0;
  for (let i = 0; i < premise.length; i++) {
    seed = (seed * 31 + premise.charCodeAt(i)) >>> 0;
  }
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const cols = 18 + Math.floor(rand() * 3); // 18-20
  const rows = 9;
  const ceilingRow = 0;
  const floorRow = rows - 1;
  const feetRow = rows - 2;

  // Paint the base shape first.
  const ground: TilesetKey[][] = [];
  for (let r = 0; r < rows; r++) {
    const gRow: TilesetKey[] = [];
    for (let c = 0; c < cols; c++) {
      if (r === ceilingRow) {
        gRow.push("ceiling");
      } else if (r === floorRow) {
        gRow.push("floor");
      } else if (c === 0 || c === cols - 1) {
        gRow.push("wall");
      } else if (r === feetRow) {
        gRow.push("air");
      } else {
        gRow.push("background_wall");
      }
    }
    ground.push(gRow);
  }

  const setCell = (x: number, y: number, key: TilesetKey) => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return;
    ground[y][x] = key;
  };

  // Door: replaces the wall at one side on the feet row. Pick a side.
  const doorOnRight = rand() < 0.5;
  const doorX = doorOnRight ? cols - 1 : 0;
  setCell(doorX, feetRow, "door");

  // Window and decorations on the back wall.
  const windowX = Math.max(3, Math.min(cols - 4, Math.floor(cols / 2) + (Math.floor(rand() * 5) - 2)));
  const windowRow = Math.max(1, Math.min(feetRow - 2, 1 + Math.floor(rand() * 2)));
  setCell(windowX, windowRow, "window");

  const torchRow = Math.max(1, Math.min(feetRow - 1, windowRow + 1));
  const torchX = doorOnRight ? 3 : cols - 4;
  setCell(torchX, torchRow, "torch");

  if (cols >= 18) {
    const paintingX = doorOnRight ? cols - 4 : 3;
    setCell(paintingX, Math.max(1, windowRow), "painting");
  }

  // Fireplace on the feet row, near the side opposite the door.
  const fireplaceX = doorOnRight ? 2 : cols - 3;
  setCell(fireplaceX, feetRow, "fireplace");

  // Bed on the feet row, against the opposite side of the fireplace.
  // Two tiles wide so it reads as a bed, not a crate.
  const bedX = doorOnRight ? cols - 4 : 2;
  const bedDir = doorOnRight ? -1 : 1;
  setCell(bedX, feetRow, "bed");
  setCell(bedX + bedDir, feetRow, "bed");

  // Table + chair near the center.
  const tableX = Math.floor(cols / 2);
  setCell(tableX, feetRow, "table");
  setCell(tableX + 1, feetRow, "chair");

  // Bookshelf standing on the feet row to the door side of the table.
  const bookshelfX = doorOnRight ? tableX + 3 : tableX - 3;
  if (bookshelfX > 1 && bookshelfX < cols - 2 && ground[feetRow][bookshelfX] === "air") {
    setCell(bookshelfX, feetRow, "bookshelf");
  }

  // Optional rug between the table and the fireplace on the feet row.
  const rugX = doorOnRight ? fireplaceX + 2 : fireplaceX - 2;
  if (rugX > 0 && rugX < cols - 1 && ground[feetRow][rugX] === "air") {
    setCell(rugX, feetRow, "rug");
  }

  // Re-derive collision strictly from WALKABLE so tests + client agree.
  const collision: boolean[][] = ground.map((row) =>
    row.map((tile) => WALKABLE[tile] === false),
  );

  // Anchors must land on WALKABLE feet-row cells. Helper picks the closest
  // empty one around a prop so "bedside" etc. always resolve to a standable
  // tile even if the layout shifts with a different cols count.
  const standableAdjacent = (propX: number): number => {
    const candidates = [propX + 1, propX - 1, propX + 2, propX - 2];
    for (const cx of candidates) {
      if (cx <= 0 || cx >= cols - 1) continue;
      if (ground[feetRow][cx] === "air" || ground[feetRow][cx] === "rug") return cx;
    }
    return Math.max(1, Math.min(cols - 2, propX));
  };

  const objects: ObjectWire[] = [
    { kind: "door", name: "door", x: doorX, y: feetRow },
    {
      kind: "anchor",
      name: "fireplace_face",
      x: standableAdjacent(fireplaceX),
      y: feetRow,
    },
    { kind: "anchor", name: "bedside", x: standableAdjacent(bedX), y: feetRow },
    { kind: "anchor", name: "table", x: standableAdjacent(tableX), y: feetRow },
    { kind: "anchor", name: "window_gaze", x: windowX, y: feetRow },
    { kind: "anchor", name: "center", x: Math.floor(cols / 2), y: feetRow },
  ];

  // Ensure every anchor actually lands on a walkable feet-row cell.
  for (const obj of objects) {
    if (obj.y !== feetRow) continue;
    if (ground[feetRow][obj.x] === "air" || ground[feetRow][obj.x] === "rug" || ground[feetRow][obj.x] === "door") continue;
    // Nudge left/right until walkable.
    for (let dx = 1; dx < cols; dx++) {
      for (const sign of [-1, 1]) {
        const nx = obj.x + dx * sign;
        if (nx <= 0 || nx >= cols - 1) continue;
        const tile = ground[feetRow][nx];
        if (tile === "air" || tile === "rug" || tile === "door") {
          obj.x = nx;
          dx = cols;
          break;
        }
      }
    }
  }

  const room: RoomWire = {
    id: "main",
    name: "The Room",
    cols,
    rows,
    ground,
    collision,
    objects,
  };

  const npcs: NpcDay[] = [
    {
      name: "Marek",
      backstory:
        "Has swept this floor since his father did. Something under it has begun to tap back.",
      palette: "warm",
      objective: "Keep the room standing one more night without telling anyone why.",
      motive: "A debt he cannot name out loud without giving it shape.",
      schedule: cannedSchedule([
        "opens the shutters and lets the cold in",
        "stokes the fireplace coals",
        "counts the coins in the till slowly",
        "stares at the door as if expecting someone",
      ]),
      startAnchor: "fireplace_face",
    },
    {
      name: "Idris",
      backstory: "Arrived three nights ago with a candle that will not stay lit.",
      palette: "ash",
      objective: "Wait for a reply that may not come.",
      motive: "Afraid to leave and afraid to stay.",
      schedule: cannedSchedule([
        "sits on the bedside writing nothing",
        "rests near the window watching the street",
        "drinks water and waits",
        "watches the door without moving",
      ]),
      startAnchor: "bedside",
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
    tilesetRef: TILESET_REF,
    rooms: [room],
    portals: [],
    source: "fallback",
  };
}

function cannedSchedule(activities: string[]): ScheduleSlot[] {
  const slots: ScheduleSlot[] = [];
  for (let h = OPENING_HOUR; h <= CLOSING_HOUR; h++) {
    slots.push({
      hour: h,
      activity: activities[(h - OPENING_HOUR) % activities.length],
    });
  }
  return slots;
}

/** Flatten every object across every room to a list of anchor addresses. */
export function floorAnchorList(plan: FloorPlan): string[] {
  const out: string[] = [];
  for (const room of plan.rooms) {
    for (const obj of room.objects) {
      out.push(obj.name);
    }
  }
  return out;
}

/** Exposed for tests — same Zod schema generateFloorPlan uses internally. */
export const __schema = FloorPlanSchema;

export type { PaletteKey };
