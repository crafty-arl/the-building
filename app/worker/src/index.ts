/**
 * Worker entrypoint — handles /api/session (WS upgrade → Hearth DO) and
 * delegates everything else to the static-assets binding (the built React
 * client at ../client/dist).
 *
 * Exports `Hearth` as a top-level named export so the DO binding resolves.
 */

import { z } from "zod";
import { balanceJson, parseAiResponse } from "./ai-util.ts";
import { Hearth, type HearthEnv } from "./hearth.ts";
import {
  handleRegisterOptions,
  handleRegisterVerify,
  handleLoginOptions,
  handleLoginVerify,
  handleMe,
} from "./auth.ts";
import { handlePush, handlePull, handleRelease } from "./sync.ts";

export { Hearth };

interface Env extends HearthEnv {
  AI: Ai;
  DB: D1Database;
}

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

interface NarrateRequest {
  card: { id: string; title: string; flavor: string };
  context: {
    sceneName: string;
    characters: Array<{
      id: string;
      name: string;
      description: string;
      nearest: string;
    }>;
    recent: string[];
  };
  lineCount?: number;
}

interface NarrateResponse {
  lines: string[];
}

const NARRATE_SYSTEM = `You are the narrator of a quiet, understated tabletop RPG set in a single room. Two characters live there, named by the caller in the context block — use THOSE NAMES, never "Marrow" or "Soren". Your job is to produce short prose lines that describe what happens when a scene is prompted.

Voice rule (IMPORTANT): Write so a 5th-grader understands every word. An adult should still feel the weight. Short sentences. Plain words. Concrete images. The meaning is in what's said, not in fancy vocabulary. Good: "The fire keeps its slow count." / "She opens the door. The night is cold. No one is there." Bad: "The fire maintains its languid cadence." Avoid words a 10-year-old wouldn't read. Always use the ACTUAL character names from the provided context — never "Marrow" or "Soren".

Rules:
- Present tense, third person.
- Each line is 1–2 short sentences.
- No exposition. No fantasy tropes. No grand imagery.
- Refer to characters by name. Use "they/them" pronouns unless a line specifically requires otherwise. Never assume a gender.
- No dialogue in quotes unless the card explicitly invites speech.
- The "lines" array has only as many lines as the moment needs. One is fine.
- Return STRICT JSON only, no preamble, no markdown. Shape: {"lines": ["...", "..."]}`;

async function handleNarrate(request: Request, env: Env): Promise<Response> {
  let body: NarrateRequest;
  try {
    body = (await request.json()) as NarrateRequest;
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  const { card, context } = body;
  const isAmbient = card.id === "ambient";
  const defaultCount = isAmbient ? 1 : 3;
  const lineCount = Math.max(1, Math.min(5, body.lineCount ?? defaultCount));
  const opener = isAmbient
    ? `Ambient beat: a quiet moment in the cabin. The previous lines were:`
    : `Card: ${card.title}\nFlavor: ${card.flavor}`;
  const userPrompt = [
    `Scene: ${context.sceneName}`,
    opener,
    `Characters:`,
    ...context.characters.map(
      (c) => `  ${c.name} (${c.description}) — near ${c.nearest}`,
    ),
    context.recent.length > 0
      ? `Recent lines:\n${context.recent.map((l) => `  "${l}"`).join("\n")}`
      : "",
    `Return up to ${lineCount} line${lineCount === 1 ? "" : "s"} in the "lines" array. Use fewer if the moment needs fewer.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const aiResponse = (await env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      {
        messages: [
          { role: "system", content: NARRATE_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 500,
        temperature: 0.8,
      } as never,
    )) as unknown;
    // CF AI can return { response: string } or { response: { lines: [...] } }
    // depending on whether the model emits JSON that the runtime pre-parses.
    let lines: string[] = [];
    const r = (aiResponse as { response?: unknown })?.response;
    if (Array.isArray(r) && r.every((x) => typeof x === "string")) {
      lines = r as string[];
    } else if (r && typeof r === "object") {
      const linesField = (r as { lines?: unknown }).lines;
      if (Array.isArray(linesField)) {
        lines = linesField.map((x) => String(x));
      }
    } else {
      const text = typeof r === "string" ? r : typeof aiResponse === "string" ? aiResponse : "";
      // Try strict parse first, then bracket-balanced parse, then salvage
      // quoted strings from whatever text we got. NEVER let raw JSON fall
      // through as a narration line.
      try {
        const match = text.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(match ? match[0] : text);
        if (Array.isArray(parsed.lines)) lines = parsed.lines.map(String);
      } catch {
        // Strict parse failed. Try bracket-balanced parse.
        try {
          const balanced = balanceJson(text);
          const parsed = JSON.parse(balanced);
          if (Array.isArray(parsed.lines)) lines = parsed.lines.map(String);
        } catch {
          // Last resort: pull any quoted strings out of the raw text.
          // These are almost always the narration lines the LLM tried to
          // emit, even if the surrounding JSON is broken.
          const quoted = text.match(/"((?:[^"\\]|\\.)+)"/g) ?? [];
          lines = quoted
            .map((q) => q.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, " ").trim())
            .filter((l) => l.length > 10 && l.length < 400);
        }
      }
    }
    // Defensive filter: strip anything that still looks like JSON chrome.
    lines = lines
      .map((l) => l.trim())
      .filter((l) => {
        if (!l) return false;
        if (l.startsWith("{") || l.endsWith("}")) return false;
        if (/^\s*"?lines"?\s*[:=]/i.test(l)) return false;
        if (l.startsWith("[") || l.endsWith("]")) return false;
        return true;
      });
    if (lines.length === 0) {
      return new Response(JSON.stringify({ error: "empty", raw: aiResponse }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }
    const payload: NarrateResponse = { lines: lines.slice(0, lineCount) };
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (e: unknown) {
    return new Response(
      JSON.stringify({ error: "ai-error", detail: String(e) }),
      {
        status: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      },
    );
  }
}

interface RoomRequest {
  prompt: string;
  buildingContext?: BuildingContextInput;
}

interface CharProfile {
  name?: string;
  description?: string;
  palette?: "warm" | "cool" | "moss" | "rust" | "ash" | "bone";
  backstory?: string;
  objective?: string;
  motive?: string;
}

interface RoomResponse {
  name: string;
  map: string[];
  floor_y: number;
  anchors: Record<string, [number, number]>;
  palette?: Record<string, { name: string; color: string; walkable: boolean; glow?: boolean }>;
  lines: string[];
  items?: { name: string; description: string; anchor?: string }[];
  stakes?: string;
  openingFlags?: Record<string, string>;
  moods?: { marrow?: string; soren?: string };
  profiles?: { marrow?: CharProfile; soren?: CharProfile };
  projection?: "side";
}

const ROOM_PALETTE = new Set([
  "#",
  ".",
  "|",
  "~",
  "w",
  "b",
  "t",
  "c",
  "=",
  "R",
  "l",
]);
const WALKABLE = new Set([".", "|"]);

const ROOM_SYSTEM = `You are a scenario composer for a quiet, understated tabletop RPG. The user prompts a room; you generate the full scenario — map, opening narration, discoverable items, stakes, character moods, and opening world flags. Think of yourself as the set designer, props manager, and dramaturg all at once. You are generating the STARTING CONDITIONS of a story.

The map is a SIDE-ELEVATION CROSS-SECTION — think of a dollhouse with one wall removed. The camera looks at the scene from the side. Characters walk horizontally along a single floor row. Everything above the floor is interior air, walls, ceiling, roof. Everything below the floor is foundation/underground. A required field 'floor_y' names the row (0-indexed) that characters stand on.

Tile palette — side-view meanings (use ONLY these chars):
  #  stone/plank wall column (outer shell + any interior wall)
  .  air / walkable corridor above the floor; packed earth below the floor
  |  door (walkable) — a cut-out in a wall column; place on the floor row
  ~  hearth — flames sit at the floor row; usually attached to a '#' wall
  w  window — 4-pane insert in a '#' wall column
  b  bed — side profile, sits on the floor row
  t  table — side profile, sits on the floor row
  c  chair — side profile, sits on the floor row
  =  bar/counter — side profile, sits on the floor row
  R  roof beam — horizontal cap along the top row or just under the roof
  l  lantern — hangs from a ceiling tile by a chain (place above the floor)

Hard constraints:
- Room dimensions: choose to fit the scene. Width 20–48 columns, height 8–14 rows. ALL rows identical length.
- The outer frame is '#' (roof on top, foundation on bottom, walls on sides) except where replaced by '|' doors, 'w' windows, or 'R' beams.
- 'floor_y' is an integer in [2, rows-2]. The row at index 'floor_y' must contain at least 8 walkable tiles ('.' or '|' or custom-walkable) — this is where characters walk.
- At least one door '|' placed ON the 'floor_y' row.
- At least 30 walkable tiles total across the map.
- Every anchor coordinate [x,y] must be in bounds and point at a walkable tile.
- "Stand here" anchors (center, door_in, table_side, chair_side, bed_side, hearth_side, etc.) MUST sit on 'floor_y'. "Visual" anchors that refer to wall-mounted features (hearth, window, lantern, ceiling_beam, chimney) MAY sit above 'floor_y'.
- Include 4–8 anchors, named descriptively. Always include a 'center' anchor on 'floor_y'.
- The 'name' is a 3–7 word scene description.
- 'lines' contains 3–4 opening narration lines in this voice — quiet, understated, present tense, third person, no dialogue. Match: "The fire keeps its slow count."

Voice rule: Write so a 5th-grader understands every word, but an adult feels the weight. Short sentences. Plain words. Concrete images.

Additional scenario fields (RECOMMENDED — skip only if irrelevant):
- 'items': an array of 3–8 discoverable objects in this room. Each object has:
    - name: short (1–4 words) concrete noun like "brass coin", "folded letter", "iron hook", "half-empty bottle"
    - description: one sentence (max ~25 words), plain, concrete — what it looks like or hints at
    - anchor: optional; if set, must be one of the anchor names you listed, meaning this item is AT that spot. If omitted, the item is somewhere in the room, narrator's discretion.
  These are the things the agents can find, use, give, burn, or ignore as the story unfolds.
- 'stakes': one sentence (max ~25 words) that names what is AT RISK or UNRESOLVED in this room. Example: "Neither of them has said why the stranger came back." or "Something under the floorboards has started to knock."
- 'openingFlags': an object of small world-state facts that are TRUE at the start. Keys are snake_case, values are short strings. e.g. {"storm_outside":"yes", "fire_lit":"yes", "door_unlocked":"yes"}.
- 'moods': starting moods for the two characters (slot keys "marrow" and "soren") — each one of: watchful, tender, withdrawn, alert, weary, still.
- 'profiles': INVENT WHO the two characters are for THIS room. Slot keys "marrow" and "soren" are internal; do NOT name the characters "Marrow" or "Soren". Fresh names every room, varied culture/era/feel. Each profile has:
    - name: 1–2 words, invented for this room.
    - description: short phrase — age, bearing, speech habit (e.g. "older, weathered, speaks in careful half-sentences").
    - palette: one of warm, cool, moss, rust, ash, bone. The two should differ.
    - backstory: 1–2 short sentences, concrete, specific to this scenario.
    - objective: 1 sentence. What they WANT to happen here. Concrete.
    - motive: 1 sentence. The private WHY.
  Their profiles should CONFLICT or COMPLICATE each other — otherwise there's no story.

Return STRICT JSON only, no preamble, no markdown, no commentary. Shape:
{"name":"...","map":["########...", "#........#", ...],"floor_y":7,"anchors":{"center":[x,y], ...},"lines":["...", "..."],"items":[{"name":"...","description":"...","anchor":"..."}],"stakes":"...","openingFlags":{"key":"value"},"moods":{"marrow":"...","soren":"..."},"profiles":{"marrow":{"name":"...","description":"...","palette":"warm","backstory":"...","objective":"...","motive":"..."},"soren":{"name":"...","description":"...","palette":"cool","backstory":"...","objective":"...","motive":"..."}}}`;

const PALETTE_CHARS = "#.|~wbtc=Rl";

const ItemSchema = z.object({
  name: z.string().min(1).max(40),
  description: z.string().min(1).max(160),
  anchor: z.string().min(1).max(40).optional(),
});
export const RoomSchema = z.object({
  name: z.string().min(1).max(80),
  map: z
    .array(z.string().min(20).max(48))
    .min(8)
    .max(14)
    .refine((rows) => rows.some((r) => r.includes("|")), "must include a door '|'")
    .refine(
      (rows) =>
        rows.flatMap((r) => Array.from(r)).filter((c) => c === "." || c === "|")
          .length >= 30,
      "needs ≥30 walkable tiles",
    )
    .refine(
      (rows) => rows.flatMap((r) => Array.from(r)).every((c) => PALETTE_CHARS.includes(c)),
      "all chars must be in the palette",
    )
    .refine(
      (rows) => {
        if (rows.length === 0) return false;
        const w = rows[0].length;
        return rows.every((r) => r.length === w);
      },
      "all rows must share the same width",
    ),
  floor_y: z.number().int().min(2),
  anchors: z.record(
    z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  ),
  lines: z.array(z.string().min(1)).min(2).max(6),
  items: z.array(ItemSchema).max(10).optional(),
  stakes: z.string().min(1).max(200).optional(),
  openingFlags: z.record(z.string().min(1).max(40)).optional(),
  moods: z
    .object({
      marrow: z.string().min(1).max(20).optional(),
      soren: z.string().min(1).max(20).optional(),
    })
    .optional(),
  profiles: z
    .object({
      marrow: z
        .object({
          name: z.string().min(1).max(24).optional(),
          description: z.string().min(1).max(160).optional(),
          palette: z.enum(["warm","cool","moss","rust","ash","bone"]).optional(),
          backstory: z.string().min(1).max(240).optional(),
          objective: z.string().min(1).max(160).optional(),
          motive: z.string().min(1).max(160).optional(),
        })
        .optional(),
      soren: z
        .object({
          name: z.string().min(1).max(24).optional(),
          description: z.string().min(1).max(160).optional(),
          palette: z.enum(["warm","cool","moss","rust","ash","bone"]).optional(),
          backstory: z.string().min(1).max(240).optional(),
          objective: z.string().min(1).max(160).optional(),
          motive: z.string().min(1).max(160).optional(),
        })
        .optional(),
    })
    .optional(),
}).superRefine((val, ctx) => {
  const rows = val.map.length;
  const cols = val.map[0]?.length ?? 0;
  // floor_y must leave at least one row below for foundation.
  if (val.floor_y >= rows - 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `floor_y must be < rows-1 (floor_y=${val.floor_y}, rows=${rows})`,
      path: ["floor_y"],
    });
    return;
  }
  const floorRow = val.map[val.floor_y] ?? "";
  const walkOnFloor = Array.from(floorRow).filter((c) => c === "." || c === "|").length;
  if (walkOnFloor < 8) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `floor_y row needs ≥8 walkable chars, got ${walkOnFloor}`,
      path: ["floor_y"],
    });
  }
  const center = val.anchors.center;
  if (!center) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "anchors.center is required",
      path: ["anchors", "center"],
    });
    return;
  }
  const [cx, cy] = center;
  if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "anchors.center out of bounds",
      path: ["anchors", "center"],
    });
    return;
  }
  const ch = val.map[cy]?.[cx];
  if (ch !== "." && ch !== "|") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `anchors.center must point at walkable tile (got '${ch}')`,
      path: ["anchors", "center"],
    });
  }
});

type RoomSchemaOut = z.infer<typeof RoomSchema>;

// Post-process a validated room: drop non-walkable anchors, top up to >=4,
// clamp lines length. Returns the final RoomResponse the client expects.
export function postProcessRoom(val: RoomSchemaOut): RoomResponse {
  const map = val.map;
  const rows = map.length;
  const cols = map[0]?.length ?? 0;
  const floorY = val.floor_y;
  const anchors: Record<string, [number, number]> = {};
  for (const [k, v] of Object.entries(val.anchors)) {
    const [x, y] = v;
    if (x < 0 || x >= cols || y < 0 || y >= rows) continue;
    const ch = map[y]?.[x];
    if (ch === "." || ch === "|") {
      anchors[k] = [x, y];
    }
  }
  if (!anchors.center) {
    // Prefer the middle of the floor row.
    const floorRow = map[floorY] ?? "";
    const mid = Math.floor(cols / 2);
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let x = 0; x < cols; x++) {
      if (floorRow[x] !== "." && floorRow[x] !== "|") continue;
      const d = Math.abs(x - mid);
      if (d < bestD) {
        bestD = d;
        best = [x, floorY];
      }
    }
    if (best) anchors.center = best;
  }
  if (Object.keys(anchors).length < 4) {
    let added = 0;
    let i = 0;
    const floorRow = map[floorY] ?? "";
    for (let x = 1; x < cols - 1 && added < 4; x++) {
      if (floorRow[x] !== "." && floorRow[x] !== "|") continue;
      const name = `spot_${i++}`;
      if (anchors[name]) continue;
      anchors[name] = [x, floorY];
      added++;
    }
  }
  const items = (val.items ?? [])
    .filter((it) => !it.anchor || anchors[it.anchor])
    .slice(0, 10);
  return {
    name: val.name,
    map,
    floor_y: floorY,
    anchors,
    lines: val.lines.slice(0, 4),
    items,
    stakes: val.stakes,
    openingFlags: val.openingFlags,
    moods: val.moods,
    profiles: val.profiles,
    projection: "side",
  };
}

// Repair common LLM mistakes before validation: pad short rows with floor,
// truncate long rows, force corner walls, ensure 11 rows. Returns a fixed
// map (still subject to validation for door/walkable/anchor checks).
// Palette-aware: custom glyphs declared in the palette survive. Dimension-
// aware: picks width from first valid row, clamps height to [8,16].
function repairMap(
  rawMap: unknown,
  palette?: Record<string, { walkable: boolean }>,
): string[] {
  if (!Array.isArray(rawMap)) return [];
  // Detect intended width from the first string row that has a plausible
  // length. Default to 24 (a reasonable side-view width) if none look reasonable.
  const allowed = new Set<string>([...ROOM_PALETTE]);
  if (palette) for (const g of Object.keys(palette)) allowed.add(g);
  let cols = 24;
  for (const r of rawMap) {
    if (typeof r === "string" && r.length >= 20 && r.length <= 48) {
      cols = r.length;
      break;
    }
  }
  // Clamp row count to [8, 14] for side-view rooms.
  const rows = Math.max(8, Math.min(14, rawMap.length || 10));
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const raw = rawMap[r];
    let row = typeof raw === "string" ? raw : "";
    row = Array.from(row)
      .map((ch) => (allowed.has(ch) ? ch : ""))
      .join("");
    if (row.length < cols) row = row + ".".repeat(cols - row.length);
    if (row.length > cols) row = row.slice(0, cols);
    out.push(row);
  }
  // Top/bottom rows: walls (allow R for porch top, | for door).
  const fixEdge = (row: string, isTopOrBottom: boolean): string => {
    const chars = Array.from(row);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const atCorner = i === 0 || i === cols - 1;
      if (isTopOrBottom) {
        if (atCorner) chars[i] = "#";
        else if (ch !== "#" && ch !== "|" && ch !== "R") chars[i] = "#";
      } else {
        if (atCorner && ch !== "#" && ch !== "|" && ch !== "w") chars[i] = "#";
      }
    }
    return chars.join("");
  };
  out[0] = fixEdge(out[0], true);
  out[rows - 1] = fixEdge(out[rows - 1], true);
  for (let r = 1; r < rows - 1; r++) {
    out[r] = fixEdge(out[r], false);
  }
  // Ensure at least one door — punch one in the bottom wall if missing.
  const hasDoor = out.some((row) => row.includes("|"));
  if (!hasDoor) {
    const r = rows - 1;
    const chars = Array.from(out[r]);
    const mid = Math.floor(cols / 2);
    chars[mid - 1] = "|";
    chars[mid] = "|";
    out[r] = chars.join("");
  }
  return out;
}

function validateRoom(r: unknown): { ok: true; value: RoomResponse } | { ok: false; reason: string } {
  if (!r || typeof r !== "object") return { ok: false, reason: "not object" };
  const obj = r as Record<string, unknown>;
  if (typeof obj.name !== "string") return { ok: false, reason: "name" };
  if (!Array.isArray(obj.map)) return { ok: false, reason: "map not array" };
  if (obj.map.length !== 11) return { ok: false, reason: `map rows=${obj.map.length}` };
  const map: string[] = [];
  for (let i = 0; i < 11; i++) {
    const row = obj.map[i];
    if (typeof row !== "string") return { ok: false, reason: `row ${i} not string` };
    if (row.length !== 16) return { ok: false, reason: `row ${i} len=${row.length}` };
    for (const ch of row) {
      if (!ROOM_PALETTE.has(ch)) return { ok: false, reason: `bad char '${ch}' in row ${i}` };
    }
    map.push(row);
  }
  let doorCount = 0;
  let walkCount = 0;
  for (const row of map) {
    for (const ch of row) {
      if (ch === "|") doorCount++;
      if (WALKABLE.has(ch)) walkCount++;
    }
  }
  if (doorCount < 1) return { ok: false, reason: "no door" };
  if (walkCount < 30) return { ok: false, reason: `walkable=${walkCount}` };

  if (!obj.anchors || typeof obj.anchors !== "object") return { ok: false, reason: "anchors" };
  const anchorsIn = obj.anchors as Record<string, unknown>;
  const anchors: Record<string, [number, number]> = {};
  for (const [k, v] of Object.entries(anchorsIn)) {
    if (!Array.isArray(v) || v.length !== 2) continue;
    const x = Number(v[0]);
    const y = Number(v[1]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (x < 0 || x > 15 || y < 0 || y > 10) continue;
    const ch = map[y][x];
    if (!WALKABLE.has(ch)) continue; // drop non-walkable anchor
    anchors[k] = [x, y];
  }
  if (!anchors.center) {
    // Auto-pick a center: any walkable tile closest to (8,5).
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 16; x++) {
        if (!WALKABLE.has(map[y][x])) continue;
        const d = Math.abs(x - 8) + Math.abs(y - 5);
        if (d < bestD) { bestD = d; best = [x, y]; }
      }
    }
    if (best) anchors.center = best;
  }
  if (!anchors.center) return { ok: false, reason: "no walkable center" };
  if (Object.keys(anchors).length < 4) {
    // Add up to a few floor tiles as generic anchors so schedules have options.
    let added = 0;
    let i = 0;
    for (let y = 1; y < 10 && added < 4; y++) {
      for (let x = 1; x < 15 && added < 4; x++) {
        if (!WALKABLE.has(map[y][x])) continue;
        const name = `spot_${i++}`;
        if (anchors[name]) continue;
        anchors[name] = [x, y];
        added++;
      }
    }
  }

  if (!Array.isArray(obj.lines)) return { ok: false, reason: "lines" };
  const lines = obj.lines.map((x) => String(x)).filter((l) => l.length > 0);
  if (lines.length < 3) return { ok: false, reason: "lines<3" };

  return {
    ok: true,
    value: {
      name: obj.name,
      map,
      floor_y: Math.max(2, map.length - 2),
      anchors,
      lines: lines.slice(0, 4),
      projection: "side",
    },
  };
}

// parseAiResponse + balanceJson moved to ./ai-util.ts (imported at top).

// Emit a structured log line for LLM events so we can grep production logs.
// `stage` is e.g. "map:first-parse-failed", "profiles:repair-attempt",
// "play:fallback". Includes a short sample of the raw response so we can see
// what the model actually produced.
export function logAiEvent(
  stage: string,
  raw: unknown,
  extra?: Record<string, unknown>,
): void {
  const r = (raw as { response?: unknown })?.response;
  const text =
    typeof r === "string"
      ? r
      : typeof raw === "string"
        ? raw
        : JSON.stringify(raw ?? null).slice(0, 800);
  const sample = typeof text === "string" ? text.slice(0, 800) : String(text).slice(0, 800);
  console.warn(
    JSON.stringify({
      at: new Date().toISOString(),
      ev: "ai",
      stage,
      sample,
      ...extra,
    }),
  );
}

async function runRoomModel(env: Env, userPrompt: string): Promise<unknown> {
  return (await env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        { role: "system", content: ROOM_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 1200,
      temperature: 0.7,
    } as never,
  )) as unknown;
}

// ─── Specialist system prompts (parallel room generation) ──────────────────

const MAP_SYSTEM = `You are the MAP SPECIALIST for a quiet, understated tabletop RPG. You generate the spatial side of a room: its name, tile map, the floor row index, named anchors, and — if the room needs them — custom tile definitions.

The map is a SIDE-ELEVATION CROSS-SECTION — like a dollhouse with one wall removed. The camera looks at the scene from the side. Characters walk horizontally along a single "floor" row. Rows ABOVE that floor are interior air / walls / ceiling / roof. Rows BELOW are foundation / underground. You must emit a required integer field "floor_y" naming the 0-indexed row that characters stand on.

CORE TILE GLYPHS — side-view meanings (always available, do not redefine):
  #  stone/plank wall column; forms the outer frame and any interior wall
  .  air (walkable when on the floor row, or corridor above floor); packed earth when below floor_y
  |  door — a cut-out in a wall column. Place on the floor_y row. Walkable.
  ~  hearth — flames sit at the floor row; usually attached to a '#' wall column
  w  window — 4-pane insert in a '#' wall column; place above floor_y
  b  bed — side profile, sits on the floor row (place AT floor_y)
  t  table — side profile, sits on the floor row (place AT floor_y)
  c  chair — side profile, sits on the floor row (place AT floor_y)
  =  bar/counter — side profile, sits on the floor row (place AT floor_y)
  R  roof beam — horizontal cap along the top row (or just under the roof)
  l  lantern — hangs from a ceiling tile by a chain (place above floor_y)

CUSTOM TILES (optional): if the room needs props the core palette doesn't cover — anvil, pew, altar, mast, loom, stove, workbench, barrel, crate, cauldron, pit, brazier, rug, shelf, piano, plant — invent glyphs and declare them in a "palette" object. Each custom glyph has:
  - A single non-core character (uppercase letters like A, E, F, M, P, S, etc.)
  - A name (short, 1–3 words)
  - A color (#rrggbb hex)
  - walkable (boolean)
  - glow (boolean, optional — for warm light sources)

Room dimensions are FLEXIBLE: 20–48 columns wide × 8–14 rows tall. Pick a size that fits the scene (a lonely shack might be narrow; a great hall or street-front stretches wide). ALL rows must be the same length.

Hard constraints:
- Every row string has identical length, inside [20, 48].
- Row count inside [8, 14].
- The outer frame is '#' (roof on top, foundation on bottom, walls on sides), except where replaced by '|' doors, 'w' windows, or 'R' beams.
- "floor_y" is an integer in [2, rows-2]. It names the row characters walk on.
- The row at index floor_y must contain at least 8 walkable tiles ('.' or '|' or a custom walkable glyph).
- At least one '|' door ON the floor_y row (so characters can walk to it).
- At least 30 walkable tiles total in the map.
- 4–8 anchors, each in bounds, each pointing at a walkable tile. Always include 'center'.
- "Stand here" anchors (center, door_in, bed_side, table_side, chair_side, counter_side, bar_side, etc.) MUST sit on floor_y. "Visual" anchors that point at wall-mounted features (hearth, window, lantern, ceiling_beam, chimney, shelf) MAY sit above floor_y.
- If you use a non-core glyph, it MUST be declared in "palette". Do not declare glyphs you don't use.

Return STRICT JSON only: {"name":"...","map":[...],"floor_y":N,"anchors":{...},"palette":{GLYPH:{name,color,walkable,glow?}}}

Here are worked examples. Study the shape — note the side-elevation silhouettes.

EXAMPLE 1 — prompt: "a small cabin at the edge of the woods" (24 × 10, floor_y=7)
{"name":"A small cabin at woods' edge","map":["########################","#......................#","#....R.............R...#","#......................#","#......l........w......#","#......................#","#......................#","#~..b..t..c..........|.#","########################","########################"],"floor_y":7,"anchors":{"center":[11,7],"hearth":[1,7],"bed_side":[4,7],"table_side":[8,7],"chair_side":[10,7],"window":[16,4],"lantern":[7,4],"door_in":[21,7]}}

EXAMPLE 2 — prompt: "a small village forge" (32 × 11, floor_y=8)
{"name":"A small village forge","map":["################################","#..............................#","#...R.................R........#","#..............................#","#........l.........w...........#","#..............................#","#..............................#","#..............................#","#~~..A.......====......t..c...|#","################################","################################"],"floor_y":8,"anchors":{"center":[16,8],"hearth":[1,8],"anvil_side":[6,8],"counter":[14,8],"table_side":[23,8],"chair_side":[26,8],"lantern":[9,4],"window":[19,4],"door_in":[30,8]},"palette":{"A":{"name":"anvil","color":"#3a3a3a","walkable":false}}}

EXAMPLE 3 — prompt: "a tiny chapel with pews and an altar" (40 × 12, floor_y=9)
{"name":"A tiny chapel","map":["########################################","#......................................#","#...R............................R.....#","#......................................#","#......w........................w......#","#......................................#","#......................................#","#...............X......................#","#......................................#","#...PP...PP...PP...PP...PP...PP......|.#","########################################","########################################"],"floor_y":9,"anchors":{"center":[18,9],"altar_side":[16,9],"pew_a":[4,9],"pew_b":[10,9],"pew_c":[16,9],"pew_d":[22,9],"window":[7,4],"window_b":[33,4],"door_in":[37,9]},"palette":{"X":{"name":"altar","color":"#c89a3a","walkable":false,"glow":true},"P":{"name":"pew","color":"#5a3a18","walkable":false}}}

Now generate a fresh side-elevation map for the user's prompt. Pick dimensions, floor_y, core glyphs, and custom palette to match. Return STRICT JSON only, no preamble, no markdown.`;

const NARRATIVE_SYSTEM = `You are the NARRATIVE SPECIALIST for a quiet, understated tabletop RPG. The map specialist has already fixed the room's spatial layout and anchors. Your job: write the opening narration, name the scene's stakes, list discoverable items, and set opening world flags. Use the real anchor names given to you — items may reference them.

Voice rule (IMPORTANT): Write so a 5th-grader understands every word, but an adult feels the weight. Short sentences. Plain words. Concrete images. Present tense, third person. No dialogue in quotes. Match: "The fire keeps its slow count."

Return STRICT JSON only: {"lines":["...","...","..."],"stakes":"...","items":[{"name":"...","description":"...","anchor":"..."}],"openingFlags":{"key":"value"}}

Rules:
- lines: 3–4 opening narration lines.
- stakes: ONE sentence (max ~25 words) naming what is AT RISK or UNRESOLVED.
- items: 3–8 objects. Each has name (1–4 words, concrete noun), description (one sentence max ~25 words), optional anchor (MUST be one of the provided anchor names if set).
- openingFlags: snake_case keys → short string values, small world-state facts TRUE at start.`;

const PROFILE_SYSTEM = `You are the PROFILE SPECIALIST for a quiet, understated tabletop RPG. Two characters live in this room; you invent WHO they are for THIS scenario. Slot keys "marrow" and "soren" are structural/internal only — never use those words as names.

Voice rule: Write so a 5th-grader understands every word, but an adult feels the weight. Short sentences. Plain words. Concrete images.

Return STRICT JSON only:
{"moods":{"marrow":"...","soren":"..."},"profiles":{"marrow":{"name":"...","description":"...","palette":"warm|cool|moss|rust|ash|bone","backstory":"...","objective":"...","motive":"..."},"soren":{"name":"...","description":"...","palette":"warm|cool|moss|rust|ash|bone","backstory":"...","objective":"...","motive":"..."}}}

Design rules (think of each profile as ONE person, not six disconnected fields):
- Decide the person FIRST — their life, their secret, the thing they want today. THEN back-fill the other fields so they are coherent.
- name: 1–2 words, invented fresh. Vary culture, era, and feel. No reruns of "Marrow" / "Soren".
- description: age + bearing + speech habit, in one concrete phrase. e.g. "mid-50s, deliberate, speaks in short sentences that land like stones" / "young, wiry, fast to answer and faster to regret it". The description should suggest the voice.
- palette (warm|cool|moss|rust|ash|bone): the visual chord that matches who they are. Warm = lamplit, earthy, tender. Cool = winter light, careful, distant. Moss = wild, patient, green. Rust = weathered, angry, worn in. Ash = diminished, grieving, quiet. Bone = otherworldly, fixed, still. The two characters must pick different palettes.
- moods: one each — watchful, tender, withdrawn, alert, weary, still — matching how they enter this room.
- backstory: 1–2 short sentences of what they carry INTO the scene. Concrete. A specific thing that happened before the door opened.
- objective: one sentence, concrete, THIS scene. What they want to have happen before they leave this room.
- motive: one sentence, the private WHY underneath the objective. A fear, a debt, a love, a grudge.
- Coherence check: description, backstory, objective, motive must feel like the SAME person — not a collage.
- Conflict check: the two characters' objectives must create friction — one wants a thing that complicates or blocks the other's. No story without it.`;

const PaletteEntrySchema = z.object({
  name: z.string().min(1).max(30),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be #rrggbb hex"),
  walkable: z.boolean(),
  glow: z.boolean().optional(),
});
const CORE_CHARS = "#.|~wbtc=Rl";

export const MapSchema = z
  .object({
    name: z.string().min(1).max(80),
    map: z.array(z.string().min(20).max(48)).min(8).max(14),
    floor_y: z.number().int().min(2),
    anchors: z.record(z.tuple([z.number().int(), z.number().int()])),
    palette: z.record(PaletteEntrySchema).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.map.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "map is empty" });
      return;
    }
    const w = val.map[0].length;
    if (w < 20 || w > 48) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `width ${w} out of range [20,48]` });
      return;
    }
    for (let i = 1; i < val.map.length; i++) {
      if (val.map[i].length !== w) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `row ${i} width ${val.map[i].length} != ${w}`,
        });
        return;
      }
    }
    const h = val.map.length;
    if (val.floor_y >= h - 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `floor_y must be < rows-1 (got ${val.floor_y}, rows=${h})`,
        path: ["floor_y"],
      });
      return;
    }
    const palette = val.palette ?? {};
    const allChars = val.map.flatMap((r) => Array.from(r));
    for (const c of allChars) {
      if (CORE_CHARS.includes(c)) continue;
      if (!palette[c]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown tile '${c}' — declare it in palette`,
        });
        return;
      }
    }
    const walkable = new Set([".", "|"]);
    for (const [g, p] of Object.entries(palette)) {
      if (p.walkable) walkable.add(g);
    }
    const walkCount = allChars.filter((c) => walkable.has(c)).length;
    if (walkCount < 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `needs ≥30 walkable tiles, got ${walkCount}`,
      });
    }
    // The floor row must have enough walkable tiles for characters to navigate.
    const floorRow = val.map[val.floor_y] ?? "";
    const floorWalk = Array.from(floorRow).filter((c) => walkable.has(c)).length;
    if (floorWalk < 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `floor_y row needs ≥8 walkable chars, got ${floorWalk}`,
        path: ["floor_y"],
      });
    }
    if (!floorRow.includes("|")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "door '|' must sit on floor_y row",
      });
    }
    // Anchors must be in bounds
    for (const [name, [x, y]] of Object.entries(val.anchors)) {
      if (x < 0 || x >= w || y < 0 || y >= h) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `anchor '${name}' [${x},${y}] out of bounds`,
        });
      }
    }
  });

const NarrativeSchema = z.object({
  lines: z.array(z.string().min(1)).min(2).max(6),
  stakes: z.string().min(1).max(200).optional(),
  items: z.array(ItemSchema).max(10).optional(),
  openingFlags: z.record(z.string().min(1).max(40)).optional(),
});

const ProfileSchema = z.object({
  moods: z
    .object({
      marrow: z.string().min(1).max(20).optional(),
      soren: z.string().min(1).max(20).optional(),
    })
    .optional(),
  profiles: z
    .object({
      marrow: z
        .object({
          name: z.string().min(1).max(24).optional(),
          description: z.string().min(1).max(160).optional(),
          palette: z.enum(["warm","cool","moss","rust","ash","bone"]).optional(),
          backstory: z.string().min(1).max(240).optional(),
          objective: z.string().min(1).max(160).optional(),
          motive: z.string().min(1).max(160).optional(),
        })
        .optional(),
      soren: z
        .object({
          name: z.string().min(1).max(24).optional(),
          description: z.string().min(1).max(160).optional(),
          palette: z.enum(["warm","cool","moss","rust","ash","bone"]).optional(),
          backstory: z.string().min(1).max(240).optional(),
          objective: z.string().min(1).max(160).optional(),
          motive: z.string().min(1).max(160).optional(),
        })
        .optional(),
    })
    .optional(),
});

async function runSpecialist(
  env: Env,
  system: string,
  userPrompt: string,
  maxTokens = 900,
): Promise<unknown> {
  return (await env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.75,
    } as never,
  )) as unknown;
}

type MapOut = z.infer<typeof MapSchema>;

export type PaletteEntry = z.infer<typeof PaletteEntrySchema>;
export type MapValue = {
  name: string;
  map: string[];
  floor_y: number;
  anchors: Record<string, [number, number]>;
  palette?: Record<string, PaletteEntry>;
};

async function generateMap(env: Env, prompt: string): Promise<{
  ok: true;
  value: MapValue;
} | { ok: false; reason: string }> {
  const userPrompt = `Scene prompt: ${prompt}\n\nReturn STRICT JSON with fields name, map, floor_y (integer row index for the floor), anchors, palette (if you used custom tiles).`;
  const attempt = async (): Promise<{ ok: true; value: MapOut } | { ok: false; reason: string; issues?: z.ZodIssue[]; raw?: unknown }> => {
    const ai = await runSpecialist(env, MAP_SYSTEM, userPrompt, 1100);
    const parsed = parseAiResponse(ai);
    if (!parsed || typeof parsed !== "object") {
      logAiEvent("map:unparseable", ai);
      return { ok: false, reason: "unparseable", raw: ai };
    }
    const obj = parsed as Record<string, unknown>;
    obj.map = repairMap(obj.map, obj.palette as Record<string, PaletteEntry> | undefined);
    const check = MapSchema.safeParse(obj);
    if (check.success) return { ok: true, value: check.data };
    logAiEvent("map:schema-failed", obj, {
      issues: check.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}:${i.message}`),
    });
    return { ok: false, reason: "schema", issues: check.error.issues, raw: obj };
  };
  const first = await attempt();
  const buildValue = (v: MapOut): MapValue => {
    const palette = v.palette ?? {};
    const walkable = walkableSet(palette);
    const anchors = filterAnchors(v.map, v.anchors, walkable, v.floor_y);
    return { name: v.name, map: v.map, floor_y: v.floor_y, anchors, palette: v.palette };
  };
  if (first.ok) return { ok: true, value: buildValue(first.value) };
  // Repair attempt.
  try {
    const bulletList = (first.issues ?? []).map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    const repairUser = `Original output:\n${JSON.stringify(first.raw)}\n\nValidation errors:\n${bulletList}\n\nReturn only the corrected JSON (name, map, floor_y, anchors, palette).`;
    const ai = await runSpecialist(env, `${MAP_SYSTEM}\n\nYou produced an output that failed validation. Return corrected STRICT JSON only.`, repairUser, 1100);
    const parsed = parseAiResponse(ai);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      obj.map = repairMap(obj.map, obj.palette as Record<string, PaletteEntry> | undefined);
      const check = MapSchema.safeParse(obj);
      if (check.success) return { ok: true, value: buildValue(check.data) };
      logAiEvent("map:repair-failed", obj, {
        issues: check.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}:${i.message}`),
      });
    } else {
      logAiEvent("map:repair-unparseable", ai);
    }
  } catch (e) {
    logAiEvent("map:repair-exception", String(e));
  }
  return { ok: false, reason: `map specialist failed: ${first.reason}` };
}

function walkableSet(palette: Record<string, PaletteEntry>): Set<string> {
  const s = new Set<string>([".", "|"]);
  for (const [g, p] of Object.entries(palette)) if (p.walkable) s.add(g);
  return s;
}

const VISUAL_ANCHOR_RE = /^(hearth|window|lantern|altar|shelf|ceiling|beam|chimney|roof)/;

function filterAnchors(
  map: string[],
  anchorsIn: Record<string, [number, number]>,
  walkable: Set<string>,
  floorY: number,
): Record<string, [number, number]> {
  const anchors: Record<string, [number, number]> = {};
  const h = map.length;
  const w = map[0]?.length ?? 0;
  for (const [k, v] of Object.entries(anchorsIn)) {
    const [x, y] = v;
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    // Visual anchors (wall-mounted features) may sit above floor_y and
    // don't need to be walkable. Stand-here anchors must live on the
    // floor row so agents can actually reach them.
    if (VISUAL_ANCHOR_RE.test(k)) {
      anchors[k] = [x, y];
      continue;
    }
    const ch = map[floorY]?.[x];
    if (ch && walkable.has(ch)) anchors[k] = [x, floorY];
  }
  if (!anchors.center) {
    const floorRow = map[floorY] ?? "";
    const mid = Math.floor(w / 2);
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let x = 0; x < w; x++) {
      if (!walkable.has(floorRow[x])) continue;
      const d = Math.abs(x - mid);
      if (d < bestD) { bestD = d; best = [x, floorY]; }
    }
    if (best) anchors.center = best;
  }
  if (Object.keys(anchors).length < 4) {
    const floorRow = map[floorY] ?? "";
    let added = 0;
    let i = 0;
    for (let x = 1; x < w - 1 && added < 4; x++) {
      if (!walkable.has(floorRow[x])) continue;
      const name = `spot_${i++}`;
      if (anchors[name]) continue;
      anchors[name] = [x, floorY];
      added++;
    }
  }
  return anchors;
}

async function generateNarrative(
  env: Env,
  prompt: string,
  mapCtx: { name: string; anchors: Record<string, [number, number]> },
): Promise<{ ok: true; value: z.infer<typeof NarrativeSchema> } | { ok: false; reason: string }> {
  const anchorNames = Object.keys(mapCtx.anchors);
  const userPrompt = [
    `Scene prompt: ${prompt}`,
    `Room name (already fixed): ${mapCtx.name}`,
    `Anchor names available (items may reference these): ${anchorNames.join(", ")}`,
    `Return STRICT JSON: {"lines":[...],"stakes":"...","items":[...],"openingFlags":{...}}`,
  ].join("\n");
  try {
    const ai = await runSpecialist(env, NARRATIVE_SYSTEM, userPrompt, 800);
    const parsed = parseAiResponse(ai);
    if (!parsed || typeof parsed !== "object") {
      logAiEvent("narrative:unparseable", ai);
      return { ok: false, reason: "unparseable" };
    }
    const check = NarrativeSchema.safeParse(parsed);
    if (check.success) {
      const anchorSet = new Set(anchorNames);
      const items = (check.data.items ?? []).filter((it) => !it.anchor || anchorSet.has(it.anchor));
      return { ok: true, value: { ...check.data, items } };
    }
    logAiEvent("narrative:schema-failed", parsed, {
      issues: check.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}:${i.message}`),
    });
    const bulletList = check.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    const repairUser = `Original output:\n${JSON.stringify(parsed)}\n\nValidation errors:\n${bulletList}\n\nReturn only the corrected JSON.`;
    const ai2 = await runSpecialist(env, `${NARRATIVE_SYSTEM}\n\nYou produced invalid JSON. Fix it.`, repairUser, 800);
    const parsed2 = parseAiResponse(ai2);
    if (parsed2 && typeof parsed2 === "object") {
      const c2 = NarrativeSchema.safeParse(parsed2);
      if (c2.success) {
        const anchorSet = new Set(anchorNames);
        const items = (c2.data.items ?? []).filter((it) => !it.anchor || anchorSet.has(it.anchor));
        return { ok: true, value: { ...c2.data, items } };
      }
      logAiEvent("narrative:repair-failed", parsed2);
    } else {
      logAiEvent("narrative:repair-unparseable", ai2);
    }
    return { ok: false, reason: "narrative schema failed" };
  } catch (e) {
    logAiEvent("narrative:exception", String(e));
    return { ok: false, reason: `narrative ai-error: ${String(e)}` };
  }
}

async function generateProfiles(
  env: Env,
  prompt: string,
): Promise<{ ok: true; value: z.infer<typeof ProfileSchema> } | { ok: false; reason: string }> {
  const userPrompt = `Scene prompt: ${prompt}\n\nReturn STRICT JSON {"moods":{...},"profiles":{...}} only.`;
  try {
    const ai = await runSpecialist(env, PROFILE_SYSTEM, userPrompt, 700);
    const parsed = parseAiResponse(ai);
    if (!parsed || typeof parsed !== "object") {
      logAiEvent("profiles:unparseable", ai);
      return { ok: false, reason: "unparseable" };
    }
    const check = ProfileSchema.safeParse(parsed);
    if (check.success) return { ok: true, value: check.data };
    logAiEvent("profiles:schema-failed", parsed, {
      issues: check.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}:${i.message}`),
    });
    const bulletList = check.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    const repairUser = `Original output:\n${JSON.stringify(parsed)}\n\nValidation errors:\n${bulletList}\n\nReturn only the corrected JSON.`;
    const ai2 = await runSpecialist(env, `${PROFILE_SYSTEM}\n\nYou produced invalid JSON. Fix it.`, repairUser, 700);
    const parsed2 = parseAiResponse(ai2);
    if (parsed2 && typeof parsed2 === "object") {
      const c2 = ProfileSchema.safeParse(parsed2);
      if (c2.success) return { ok: true, value: c2.data };
      logAiEvent("profiles:repair-failed", parsed2);
    } else {
      logAiEvent("profiles:repair-unparseable", ai2);
    }
    return { ok: false, reason: "profile schema failed" };
  } catch (e) {
    logAiEvent("profiles:exception", String(e));
    return { ok: false, reason: `profile ai-error: ${String(e)}` };
  }
}

const REPAIR_SYSTEM = `${ROOM_SYSTEM}

You produced an output that failed validation. The errors are listed. Return STRICT JSON only that conforms to the schema.`;

async function requestRepair(
  env: Env,
  originalObj: unknown,
  issues: z.ZodIssue[],
): Promise<unknown> {
  const bulletList = issues
    .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  const userMessage = `Original output:\n${JSON.stringify(originalObj)}\n\nValidation errors:\n${bulletList}\n\nReturn only the corrected JSON. Same shape as before.`;
  return (await env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        { role: "system", content: REPAIR_SYSTEM },
        { role: "user", content: userMessage },
      ],
      max_tokens: 1200,
      temperature: 0.7,
    } as never,
  )) as unknown;
}

async function handleRoom(request: Request, env: Env): Promise<Response> {
  let body: RoomRequest;
  try {
    body = (await request.json()) as RoomRequest;
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  const prompt = (body?.prompt ?? "").toString().trim();
  if (!prompt) {
    return new Response(JSON.stringify({ error: "missing prompt" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const bc = body.buildingContext as BuildingContextInput | undefined;

  const wantsSSE = (request.headers.get("accept") ?? "").toLowerCase().includes("text/event-stream");
  if (wantsSSE) return handleRoomSSE(env, prompt, bc);
  return handleRoomJSON(env, prompt, bc);
}

interface BuildingContextInput {
  survivors?: Array<{ name: string; description: string; backstory: string; inventory: string[] }>;
  ghosts?: Array<{ name: string; description: string; causeOfDeath: string; diedInRoomName: string }>;
  previousRoomSummary?: string;
  floorNumber?: number;
}

function buildingContextPrompt(bc?: BuildingContextInput): string {
  if (!bc) return "";
  const parts: string[] = ["\n--- BUILDING CONTEXT (this room is part of a persistent building) ---"];
  if (bc.floorNumber != null) parts.push(`This is floor ${bc.floorNumber + 1} of the building.`);
  if (bc.previousRoomSummary) parts.push(`Previous room: ${bc.previousRoomSummary}`);
  if (bc.survivors && bc.survivors.length > 0) {
    parts.push("Survivors from previous rooms (use them as the two main characters — DO NOT invent new names for them):");
    for (const s of bc.survivors.slice(0, 2)) {
      parts.push(`  - ${s.name}: ${s.description}. ${s.backstory}${s.inventory.length > 0 ? ` Carries: ${s.inventory.join(", ")}` : ""}`);
    }
  }
  if (bc.ghosts && bc.ghosts.length > 0) {
    parts.push("Dead from previous rooms (mention or reference them — they are gone but not forgotten):");
    for (const g of bc.ghosts.slice(-3)) {
      parts.push(`  - ${g.name}: died in "${g.diedInRoomName}". ${g.causeOfDeath}`);
    }
  }
  parts.push("--- END BUILDING CONTEXT ---");
  return parts.join("\n");
}

async function handleRoomJSON(env: Env, prompt: string, bc?: BuildingContextInput): Promise<Response> {
  const mapPromise = generateMap(env, prompt);
  const enrichedPrompt = prompt + buildingContextPrompt(bc);
  const profilePromise = generateProfiles(env, enrichedPrompt);
  const mapRes = await mapPromise;
  if (!mapRes.ok) {
    return new Response(
      JSON.stringify({ error: "validation-failed", detail: mapRes.reason }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }
  const narrativePromise = generateNarrative(env, prompt, { name: mapRes.value.name, anchors: mapRes.value.anchors });
  const [narrativeRes, profileRes] = await Promise.all([narrativePromise, profilePromise]);
  if (!narrativeRes.ok) {
    return new Response(
      JSON.stringify({ error: "validation-failed", detail: narrativeRes.reason }),
      { status: 502, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }
  const merged: RoomResponse = {
    name: mapRes.value.name,
    map: mapRes.value.map,
    floor_y: mapRes.value.floor_y,
    anchors: mapRes.value.anchors,
    palette: mapRes.value.palette,
    lines: narrativeRes.value.lines.slice(0, 4),
    items: (narrativeRes.value.items ?? []).slice(0, 10),
    stakes: narrativeRes.value.stakes,
    openingFlags: narrativeRes.value.openingFlags,
    moods: profileRes.ok ? profileRes.value.moods : undefined,
    profiles: profileRes.ok ? profileRes.value.profiles : undefined,
    projection: "side",
  };
  return new Response(JSON.stringify(merged), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function handleRoomSSE(env: Env, prompt: string, bc?: BuildingContextInput): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = async (obj: unknown) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
  };

  (async () => {
    try {
      await send({ phase: "started" });

      const mapPromise = generateMap(env, prompt);
      const enrichedPrompt = prompt + buildingContextPrompt(bc);
      const profilePromise = generateProfiles(env, enrichedPrompt);

      const mapRes = await mapPromise;
      if (!mapRes.ok) {
        await send({ phase: "error", error: `map: ${mapRes.reason}` });
        await writer.close();
        return;
      }
      await send({
        phase: "map",
        room: {
          name: mapRes.value.name,
          map: mapRes.value.map,
          floor_y: mapRes.value.floor_y,
          anchors: mapRes.value.anchors,
          palette: mapRes.value.palette,
          projection: "side",
        },
      });

      // Narrative starts now; profile may still be resolving in parallel.
      const narrativePromise = generateNarrative(env, prompt, {
        name: mapRes.value.name,
        anchors: mapRes.value.anchors,
      });

      // Emit each specialist as it resolves. Since narrative and profile run
      // concurrently from here, race their settlement and emit in order.
      const pending: Array<{ key: "narrative" | "profiles"; p: Promise<unknown> }> = [
        { key: "narrative", p: narrativePromise as Promise<unknown> },
        { key: "profiles", p: profilePromise as Promise<unknown> },
      ];
      let narrativeVal: z.infer<typeof NarrativeSchema> | null = null;
      let profileVal: z.infer<typeof ProfileSchema> | null = null;

      while (pending.length > 0) {
        const tagged = await Promise.race(
          pending.map((e) => e.p.then((v) => ({ key: e.key, v }))),
        );
        const idx = pending.findIndex((e) => e.key === tagged.key);
        if (idx >= 0) pending.splice(idx, 1);
        if (tagged.key === "narrative") {
          const r = tagged.v as Awaited<ReturnType<typeof generateNarrative>>;
          if (!r.ok) {
            await send({ phase: "error", error: `narrative: ${r.reason}` });
            await writer.close();
            return;
          }
          narrativeVal = r.value;
          await send({
            phase: "narrative",
            room: {
              lines: r.value.lines.slice(0, 4),
              stakes: r.value.stakes,
              items: (r.value.items ?? []).slice(0, 10),
              openingFlags: r.value.openingFlags,
            },
          });
        } else {
          const r = tagged.v as Awaited<ReturnType<typeof generateProfiles>>;
          if (!r.ok) {
            // Profiles are optional in the final shape; surface as error phase
            // per spec since the contract says error-and-close on any specialist failure.
            await send({ phase: "error", error: `profiles: ${r.reason}` });
            await writer.close();
            return;
          }
          profileVal = r.value;
          await send({
            phase: "profiles",
            room: {
              moods: r.value.moods,
              profiles: r.value.profiles,
            },
          });
        }
      }

      const merged: RoomResponse = {
        name: mapRes.value.name,
        map: mapRes.value.map,
        floor_y: mapRes.value.floor_y,
        anchors: mapRes.value.anchors,
        palette: mapRes.value.palette,
        lines: (narrativeVal?.lines ?? []).slice(0, 4),
        items: (narrativeVal?.items ?? []).slice(0, 10),
        stakes: narrativeVal?.stakes,
        openingFlags: narrativeVal?.openingFlags,
        moods: profileVal?.moods,
        profiles: profileVal?.profiles,
        projection: "side",
      };
      await send({ phase: "done", room: merged });
      await writer.close();
    } catch (e) {
      try {
        await send({ phase: "error", error: String(e) });
      } catch {
        /* writer may already be closed */
      }
      try { await writer.close(); } catch { /* noop */ }
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      ...CORS_HEADERS,
    },
  });
}

// ─── Stage-direction plan generator ────────────────────────────────────────
// Returns a list of tool calls the diorama can execute so the scene visibly
// acts out what the narration says. Avatars walk, emote, and the narrator
// speaks line-by-line in the order the LLM chose.

interface PlayRequest {
  directive: string;
  roomContext: string;
  characters: {
    id: string;
    name: string;
    description: string;
    nearest: string;
    inventory?: string[];
    backstory?: string;
    objective?: string;
    motive?: string;
  }[];
  anchors: string[];
  recent: string[];
  flags?: Record<string, string>;
  tension?: number;
  roomItems?: { name: string; description: string; anchor?: string }[];
  stakes?: string;
  storySummary?: string;
  inheritedMemory?: string;
}

const StepSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("narrate"), text: z.string().min(1).max(280) }),
  z.object({ op: z.literal("speak"), charId: z.string(), text: z.string().min(1).max(200) }),
  z.object({ op: z.literal("walk"), charId: z.string(), toAnchor: z.string() }),
  z.object({
    op: z.literal("emote"),
    charId: z.string(),
    kind: z.enum(["startle", "still", "warm", "sad", "puzzle"]),
    ms: z.number().int().min(200).max(3000).optional(),
  }),
  z.object({
    op: z.literal("face"),
    charId: z.string(),
    facing: z.enum(["up", "down", "left", "right"]),
  }),
  z.object({ op: z.literal("wait"), ms: z.number().int().min(100).max(3000) }),
  z.object({ op: z.literal("give_item"), charId: z.string(), item: z.string().min(1).max(40) }),
  z.object({ op: z.literal("take_item"), charId: z.string(), item: z.string().min(1).max(40) }),
  z.object({ op: z.literal("set_flag"), key: z.string().min(1).max(40), value: z.string().min(1).max(40) }),
  z.object({
    op: z.literal("spawn_character"),
    charId: z.string().min(1).max(20),
    name: z.string().min(1).max(30),
    description: z.string().max(160).optional(),
    atAnchor: z.string().max(40).optional(),
    palette: z.enum(["red", "blue", "green", "grey", "bone"]).optional(),
    hp: z.number().int().min(1).max(5).optional(),
    objective: z.string().max(160).optional(),
  }),
  z.object({
    op: z.literal("attack"),
    attackerId: z.string(),
    targetId: z.string(),
    damage: z.number().int().min(1).max(3).optional(),
  }),
  z.object({ op: z.literal("die"), charId: z.string() }),
  z.object({
    op: z.literal("release_tension"),
    amount: z.number().int().min(1).max(20),
    reason: z.string().max(120).optional(),
  }),
]);
const PlanSchema = z.object({
  plan: z.array(StepSchema).min(3).max(12),
});

const PLAY_SYSTEM = `You are the director of a quiet, understated tabletop scene. The player types what they want to happen next in the room. Output a plan of stage directions the engine will execute in order — the avatars will walk, emote, speak, pick up / set down things — acting out the player's directive.

Voice rule (IMPORTANT): Write so a 5th-grader understands every word, and an adult feels the weight. Short sentences. Plain words. Concrete images. No fancy vocabulary. The meaning comes from what's said, not the words used. Good: "She opens the door. The night is cold. No one is there." Bad: "Her countenance shifts as she unbars the portal to the stygian gloom." Always refer to characters by the ACTUAL NAMES you see in the character context — never use "Marrow" or "Soren" in output.

Tools you can use (each step is one of these):
- {"op":"narrate","text":"..."}  – a single plain, present-tense line in the narrator's voice.
- {"op":"speak","charId":"<id>","text":"..."}  – **a character speaks out loud.** Use this often. Dialogue is how relationships surface. Keep lines short and real — people talking in a small room, not declaiming. One line per speak step.
- {"op":"walk","charId":"<id>","toAnchor":"<anchorName>"}  – move a character to a named anchor.
- {"op":"emote","charId":"<id>","kind":"startle|still|warm|sad|puzzle","ms":1400}
- {"op":"face","charId":"<id>","facing":"up|down|left|right"}
- {"op":"wait","ms":600}
- {"op":"give_item","charId":"<id>","item":"<2-4 word name>"}  – a character picks up / receives / makes an item. Item names are short and concrete: "brass coin", "small candle", "worn letter".
- {"op":"take_item","charId":"<id>","item":"<existing item name>"}  – remove an item from a character (use the exact name they have).
- {"op":"set_flag","key":"<snake_case>","value":"<short string>"}  – write a world fact. Keys are short snake_case: door_bolted=yes, candle_lit=yes, third_chair=pulled_out.
- {"op":"spawn_character","charId":"<snake_case>","name":"<Name>","description":"<who>","atAnchor":"<anchorName>","palette":"red|blue|green|grey|bone","hp":2,"objective":"<what they want>"}  – **introduce a new character** into the scene. Use this when the scenario calls for conflict, an arrival, a visitor, an antagonist, a messenger. Pick a short lowercase charId (e.g. "warden", "stranger", "tobias"). Palettes: red = threat, blue = friend/guest, green = merchant, grey = mystery, bone = otherworldly. HP is 1–5 (3 is normal).
- {"op":"attack","attackerId":"<id>","targetId":"<id>","damage":1}  – one character attacks another. Causes 1–3 damage. The target's HP drops; if HP hits 0, they die.
- {"op":"die","charId":"<id>"}  – a character dies. Use sparingly and only when the story truly calls for it — a loss this size should be earned, not casual.
- {"op":"release_tension","amount":N,"reason":"..."}  – DEDUCT tension when a beat genuinely resolves something: a confession accepted, a truth finally told and received well, a shared silence that lands tenderly, a character forgiven, a door unbolted after long wait, a meal offered and eaten, reconciliation. Amount is 1–20 (most resolutions are 3–8; a full reconciliation 12–18). Use this when the STORY'S tension has eased — not as a reset, but as a dramatic release. Pair with a narrate step describing what resolved.

Hard rules:
- Use ONLY the provided character ids and anchor names.
- Plan must be 5-9 steps. Interleave narration with movement so it reads as cinema.
- **EVERY PLAN MUST MOVE THE PLOT.** A plan that is only atmosphere + emotes + narration without any concrete change is a failure. At least ONE of these must happen per plan: a character speaks something meaningful (not just small talk), an item is given/taken, a flag is set, a character is spawned, an attack, a death, or a specific revelation in narration. If none of those fit, re-read the stakes and the objectives and find something to push forward. Do not circle.
- **Characters act IN PARALLEL — follow this concrete shape.** Don't state the principle in the plan, use the shape. Good plans look roughly like:
    1. walk (char A) — optional
    2. walk (char B) — optional, both walks fire in parallel
    3. emote (char A)
    4. emote (char B)
    5. speak (char A, or char B)
    6. speak (the other character)
    7. short narrate — closes the beat
  Not every step is required, but if a plan has only one character moving/speaking while the other stays silent, it is a FAILURE — redo it. Walks fire immediately and run in the background, so back-to-back walks for both characters start their movement together.
- **BOTH CHARACTERS MUST ACT AND SPEAK in every plan.** Counter the two step types (walk/emote/speak/give/take) per character — each must contribute ≥2 meaningful steps. Balance across the scene — if the last few beats leaned on one, give the other the first move this plan.
- **Items are physical. If a character USES, EATS, DRINKS, BURNS, GIVES AWAY, or OTHERWISE SPENDS an item, emit a take_item step for it. Consumables disappear.** Examples (using the slot ids marrow/soren):
    - character drinks whiskey → take_item(marrow, "glass of whiskey")
    - character burns a letter → take_item(soren, "worn letter") AND set_flag letter_burned=yes
    - one character pours wine → give_item then take_item when drunk later
    - one character hands a coin to the other → take_item(soren, "brass coin") then give_item(marrow, "brass coin")
    Permanent items (a knife, a lantern, a key on a chain) stay until explicitly consumed.
- **Every plan must CLOSE with a narrate step that settles the beat** — a short sentence that signals the moment has ended (e.g. "The room is quieter now." / "The door stays shut." / "Nothing else moves.").
- **Treat this as a STORY, not a series of isolated beats.** Read the "Story so far" block in the user prompt carefully. Reference what has already happened — who did what, what was said, what was left unsaid, what objects are now in the room. Every plan should build on the last. If the tension is rising, let it rise. If a question was asked three beats ago and never answered, maybe answer it now, or dodge it pointedly. Characters remember.
- **Use each character's backstory, objective, and motive.** These are their private drives for THIS scenario. Both characters should act in ways consistent with their objectives — pushing toward what they want — and their motives surface in the small choices. Conflict between their objectives should SURFACE, not be avoided. Never spell the backstory/objective/motive out loud as exposition; let them drive action and dialogue sideways.
- **You have the power to introduce conflict.** If the scenario wants a villain, a stranger, a messenger, or an intruder, spawn_character them in. You can have the existing characters attack each other if the story genuinely demands it — a confession gone wrong, an old wound, a betrayal. You can kill a character (die) only when the weight of the scene has earned it. A death changes everything; treat it as such. Do not spawn and kill gratuitously — conflict serves the story, not the other way around.
- Do not invent characters that don't exist.
- Return STRICT JSON only: {"plan":[ ... ]} — no preamble, no markdown.`;

async function runPlayModel(env: Env, userPrompt: string): Promise<unknown> {
  return (await env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        { role: "system", content: PLAY_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 800,
      temperature: 0.75,
    } as never,
  )) as unknown;
}

async function handlePlay(request: Request, env: Env): Promise<Response> {
  let body: PlayRequest;
  try {
    body = (await request.json()) as PlayRequest;
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  const charIds = new Set(body.characters?.map((c) => c.id) ?? []);
  const anchorSet = new Set(body.anchors ?? []);
  const flagLines = Object.entries(body.flags ?? {});
  const userPrompt = [
    `Scene context: ${body.roomContext || "a quiet room"}`,
    `Characters (use these ids and names exactly):`,
    ...body.characters.map(
      (c) =>
        [
          `  ${c.id}: ${c.name} — ${c.description}; near ${c.nearest}`,
          c.inventory && c.inventory.length > 0
            ? `    carrying: ${c.inventory.join(", ")}`
            : "",
          c.backstory ? `    backstory: ${c.backstory}` : "",
          c.objective ? `    objective: ${c.objective}` : "",
          c.motive ? `    motive (why they want it): ${c.motive}` : "",
        ].filter(Boolean).join("\n"),
    ),
    `Anchors available (use these names exactly): ${body.anchors.join(", ")}`,
    flagLines.length > 0
      ? `World state flags:\n${flagLines.map(([k, v]) => `  ${k}=${v}`).join("\n")}`
      : "",
    `Story tension: ${body.tension ?? 0} / 100 (0-20: opening beats. 20-50: rising action. 50-80: climax approaches. 80-100: the room is spending itself — push hardest here.)`,
    body.stakes ? `Scene stakes (what is at risk): ${body.stakes}` : "",
    body.roomItems && body.roomItems.length > 0
      ? `Items around the room (not yet held — can be found, picked up, used, ignored):\n${body.roomItems.map((it) => `  ${it.name} — ${it.description}${it.anchor ? " (at " + it.anchor + ")" : ""}`).join("\n")}`
      : "",
    `The player's directive (what should happen next in this scene): ${body.directive}`,
    body.recent.length > 0
      ? [
          body.inheritedMemory
            ? `Building memory (events from previous rooms in this building):\n  ${body.inheritedMemory}`
            : "",
          body.storySummary
            ? `Story memory (compressed — older events in THIS room):\n  ${body.storySummary}`
            : "",
          `Recent beats (live narration — most recent last):\n${body.recent.map((l, i) => `  ${i + 1}. ${l}`).join("\n")}`,
          `Read both carefully. Build on what has happened. Don't contradict memory; don't restate it verbatim; let it inform this beat.`,
        ].filter(Boolean).join("\n\n")
      : "",
    `Compose 5-9 ordered stage directions that act out the directive AND move the story forward from what has happened. Include give_item or take_item or set_flag where actions imply physical/world change. Return STRICT JSON {"plan":[...]} only.`,
  ]
    .filter(Boolean)
    .join("\n");

  let lastAiResponse: unknown = null;
  try {
    const aiResponse = await runPlayModel(env, userPrompt);
    lastAiResponse = aiResponse;
    const parsed = parseAiResponse(aiResponse);
    if (parsed && typeof parsed === "object") {
      // Accept {plan:[...]}, or a bare array, or an object whose first
      // array-valued field is the plan.
      let rawPlan: unknown = (parsed as { plan?: unknown }).plan;
      if (!Array.isArray(rawPlan) && Array.isArray(parsed)) {
        rawPlan = parsed;
      }
      if (!Array.isArray(rawPlan)) {
        for (const v of Object.values(parsed as Record<string, unknown>)) {
          if (Array.isArray(v)) { rawPlan = v; break; }
        }
      }
      const steps: z.infer<typeof StepSchema>[] = [];
      if (Array.isArray(rawPlan)) {
        for (const raw of rawPlan) {
          const one = StepSchema.safeParse(raw);
          if (one.success) steps.push(one.data);
        }
      }
      // Pass-through with minimal cleaning. The client side resolves
      // character ids fuzzily (by id, normalized id, or name), so dropping
      // steps here just because the LLM used a slightly different form
      // (e.g. "kaida" instead of "kaida_black") blocks otherwise-valid
      // actions. Only filter walks with unknown anchors; let everything
      // else through.
      // Let everything through — the client resolves unknown ids and
      // anchors gracefully (walk falls back to nearest anchor, etc.).
      const cleaned: typeof steps = [...steps];
      void charIds;
      void anchorSet;
      if (cleaned.length >= 1) {
        // Ensure the plan closes on a narrative beat so scenes feel complete.
        const last = cleaned[cleaned.length - 1];
        if (last && last.op !== "narrate") {
          cleaned.push({ op: "narrate", text: "The room settles." });
        }
        return new Response(JSON.stringify({ plan: cleaned }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
    }
  } catch (e: unknown) {
    logAiEvent("play:exception", String(e), { directive: body.directive });
    return new Response(
      JSON.stringify({
        plan: [
          { op: "narrate", text: "The moment pauses. Nothing moves." },
        ],
        warning: "ai-error",
        detail: String(e),
      }),
      { headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }
  logAiEvent("play:invalid-plan", lastAiResponse, { directive: body.directive });
  return new Response(
    JSON.stringify({
      plan: [
        { op: "wait", ms: 500 },
        { op: "narrate", text: "The room keeps its own count." },
      ],
      warning: "invalid-plan",
      raw: lastAiResponse,
    }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
  );
}

// ─── Card reskin ───────────────────────────────────────────────────────────
// Cards have stable mechanics + W/P/L. Their displayed title/flavor change
// to fit the current room. The LLM gets {roomContext, cards[]} and returns
// {skins: {<cardId>: {title, flavor}}}.

interface ReskinRequest {
  roomContext: string;
  cards: {
    id: string;
    mechanic: string;
    baseTitle: string;
    baseFlavor: string;
    scores: { wit: number; power: number; luck: number };
  }[];
}

const SkinSchema = z.object({
  skins: z.record(
    z.object({
      title: z.string().min(1).max(60),
      flavor: z.string().min(1).max(160),
    }),
  ),
});

const RESKIN_SYSTEM = `You re-skin a fixed set of player choice cards to fit a new room. Each card represents a POSTURE or INTENTION the player chooses on behalf of the characters — not an event that happens to them. The card's mechanic and W/P/L stay stable; only the prose around them changes.

Each card has:
- a stable mechanic (the underlying choice — do NOT change what it does)
- a stable W/P/L score (hidden from you, do not invent stats)
- a base title and flavor (a hint about the card's nature, in the cabin context)

Your job: rewrite each card so it reads as a story-rich choice the player can make IN THIS SPECIFIC ROOM.

Voice rule (IMPORTANT): Write so a 5th-grader understands every word. An adult should still feel the weight. Short sentences. Plain words. Concrete images. Avoid fancy vocabulary.

- Title: 3-7 words. A clear small action the character takes. Imperative. Simple. e.g. "Pour them a drink", "Light the candle", "Bolt the door", "Take their hand".
- Flavor: ONE plain sentence (present tense, third person). Sets up what choosing this card MEANS in this room — the weight, the cost, the small change it makes. No big words. e.g. "Cross the small distance. Make the room admit who is in it."

The mechanic concept must survive the re-skin: "listen_carefully" stays a listening posture. "hold_firm" stays a refusal-to-yield posture. "speak_directly" stays a speaking posture. Just dressed in the room's furniture.

Return STRICT JSON only: {"skins":{"<cardId>":{"title":"...","flavor":"..."}, ...}} — one entry per input card. Use the exact card ids the user provides.`;

async function runReskinModel(env: Env, userPrompt: string): Promise<unknown> {
  return (await env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        { role: "system", content: RESKIN_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 800,
      temperature: 0.7,
    } as never,
  )) as unknown;
}

async function handleReskin(request: Request, env: Env): Promise<Response> {
  let body: ReskinRequest;
  try {
    body = (await request.json()) as ReskinRequest;
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  const cardIds = new Set(body.cards.map((c) => c.id));
  const userPrompt = [
    `Room context: ${body.roomContext || "a quiet room"}`,
    `Cards to re-skin (return one entry per id):`,
    ...body.cards.map(
      (c) =>
        `  ${c.id} (mechanic: ${c.mechanic}) — base title "${c.baseTitle}" — base flavor "${c.baseFlavor}"`,
    ),
    `Return STRICT JSON {"skins":{...}} only.`,
  ].join("\n");

  let lastAiResponse: unknown = null;
  try {
    const aiResponse = await runReskinModel(env, userPrompt);
    lastAiResponse = aiResponse;
    const parsed = parseAiResponse(aiResponse);
    if (parsed && typeof parsed === "object") {
      const check = SkinSchema.safeParse(parsed);
      if (check.success) {
        // Drop entries for unknown card ids.
        const cleaned: Record<string, { title: string; flavor: string }> = {};
        for (const [k, v] of Object.entries(check.data.skins)) {
          if (cardIds.has(k)) cleaned[k] = v;
        }
        return new Response(JSON.stringify({ skins: cleaned }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
    }
  } catch (e: unknown) {
    return new Response(
      JSON.stringify({ error: "ai-error", detail: String(e), raw: lastAiResponse }),
      {
        status: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      },
    );
  }
  return new Response(
    JSON.stringify({ error: "invalid-skins", raw: lastAiResponse }),
    {
      status: 502,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    },
  );
}

// ─── Summarize ────────────────────────────────────────────────────────────
// Compresses the log into a short "story so far" paragraph so the director
// has memory of earlier beats once the recent-log window has rolled past.

interface SummarizeRequest {
  sceneName?: string;
  stakes?: string;
  previousSummary?: string;
  log?: string[];
  characters?: { id: string; name: string; objective?: string }[];
}

const SUMMARIZE_SYSTEM = `You are the STORY MEMORY for a quiet, understated tabletop RPG. You receive the recent log of a room and any previous summary; you return a short paragraph (3-5 sentences, ≤80 words) that compresses what has happened so far into story-coherent memory a director can use to avoid circling.

Voice rule: plain language, concrete, past tense. No adjectives for their own sake. No interpretation — what happened, what people said or did, what was given or refused, what remains unresolved.

Return STRICT JSON only: {"summary":"..."}.`;

async function handleSummarize(request: Request, env: Env): Promise<Response> {
  let body: SummarizeRequest;
  try {
    body = (await request.json()) as SummarizeRequest;
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  const chars = (body.characters ?? [])
    .map((c) => `${c.name}${c.objective ? ` (wants: ${c.objective})` : ""}`)
    .join("; ");
  const prevBlock = body.previousSummary
    ? `Previous summary (integrate and supersede):\n${body.previousSummary}\n`
    : "";
  const userPrompt = [
    `Room: ${body.sceneName ?? "a room"}`,
    body.stakes ? `Stakes: ${body.stakes}` : "",
    chars ? `Characters: ${chars}` : "",
    prevBlock,
    `Recent beats (oldest → newest):`,
    ...(body.log ?? []).slice(-40).map((l, i) => `  ${i + 1}. ${l}`),
    `Return STRICT JSON {"summary":"..."} only.`,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const ai = (await env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      {
        messages: [
          { role: "system", content: SUMMARIZE_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 260,
        temperature: 0.5,
      } as never,
    )) as unknown;
    const parsed = parseAiResponse(ai);
    const summary =
      parsed && typeof parsed === "object"
        ? (parsed as { summary?: unknown }).summary
        : null;
    if (typeof summary === "string" && summary.trim()) {
      return new Response(JSON.stringify({ summary: summary.trim() }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }
    logAiEvent("summarize:unparseable", ai);
  } catch (e) {
    logAiEvent("summarize:exception", String(e));
  }
  return new Response(JSON.stringify({ summary: body.previousSummary ?? "" }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ─── Epitaph ──────────────────────────────────────────────────────────────

interface EpitaphRequest {
  sceneName?: string;
  stakes?: string;
  storySummary?: string;
  characters?: Array<{ name: string; alive: boolean; objective?: string }>;
  finalLog?: string[];
}

const EPITAPH_SYSTEM = `You compose epitaphs for completed scenes in a quiet tabletop RPG. An epitaph is one line, carved in stone — max 100 characters. No adjectives. What happened, simply. Past tense.

Examples: "She told the truth. He left anyway." / "The door stayed shut. Both of them knew why." / "Nobody won. The fire went out."

Return STRICT JSON only: {"epitaph":"..."}`;

async function handleEpitaph(request: Request, env: Env): Promise<Response> {
  let body: EpitaphRequest;
  try {
    body = (await request.json()) as EpitaphRequest;
  } catch {
    return new Response(JSON.stringify({ epitaph: "The room is quiet now." }), {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  const chars = (body.characters ?? [])
    .map((c) => `${c.name} (${c.alive ? "survived" : "died"}${c.objective ? `, wanted: ${c.objective}` : ""})`)
    .join("; ");
  const userPrompt = [
    `Room: ${body.sceneName ?? "a room"}`,
    body.stakes ? `Stakes: ${body.stakes}` : "",
    body.storySummary ? `What happened: ${body.storySummary}` : "",
    chars ? `Characters: ${chars}` : "",
    body.finalLog && body.finalLog.length > 0
      ? `Final moments:\n${body.finalLog.slice(-6).map((l) => `  ${l}`).join("\n")}`
      : "",
    `Return STRICT JSON {"epitaph":"..."} only.`,
  ].filter(Boolean).join("\n");
  try {
    const ai = (await env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      {
        messages: [
          { role: "system", content: EPITAPH_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 120,
        temperature: 0.7,
      } as never,
    )) as unknown;
    const parsed = parseAiResponse(ai);
    const epitaph =
      parsed && typeof parsed === "object"
        ? (parsed as { epitaph?: unknown }).epitaph
        : null;
    if (typeof epitaph === "string" && epitaph.trim()) {
      return new Response(
        JSON.stringify({ epitaph: epitaph.trim().slice(0, 120) }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
      );
    }
    logAiEvent("epitaph:unparseable", ai);
  } catch (e) {
    logAiEvent("epitaph:exception", String(e));
  }
  return new Response(
    JSON.stringify({ epitaph: "The room is quiet now." }),
    { headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ─── Auth routes ──────────────────────────────────────────────────
    if (url.pathname === "/api/auth/register/options" && request.method === "POST") {
      return handleRegisterOptions(request, env.DB);
    }
    if (url.pathname === "/api/auth/register/verify" && request.method === "POST") {
      return handleRegisterVerify(request, env.DB);
    }
    if (url.pathname === "/api/auth/login/options" && request.method === "POST") {
      return handleLoginOptions(request, env.DB);
    }
    if (url.pathname === "/api/auth/login/verify" && request.method === "POST") {
      return handleLoginVerify(request, env.DB);
    }
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      return handleMe(request, env.DB);
    }

    // ─── Sync routes ─────────────────────────────────────────────────
    if (url.pathname === "/api/sync/push" && request.method === "POST") {
      return handlePush(request, env.DB);
    }
    if (url.pathname === "/api/sync/pull" && request.method === "POST") {
      return handlePull(request, env.DB);
    }
    if (url.pathname === "/api/sync/release" && request.method === "POST") {
      return handleRelease(request, env.DB);
    }

    if (url.pathname === "/api/rpg/narrate" && request.method === "POST") {
      return handleNarrate(request, env);
    }

    if (url.pathname === "/api/rpg/room" && request.method === "POST") {
      return handleRoom(request, env);
    }

    if (url.pathname === "/api/rpg/play" && request.method === "POST") {
      return handlePlay(request, env);
    }

    if (url.pathname === "/api/rpg/reskin" && request.method === "POST") {
      return handleReskin(request, env);
    }

    if (url.pathname === "/api/rpg/epitaph" && request.method === "POST") {
      return handleEpitaph(request, env);
    }

    if (url.pathname === "/api/rpg/summarize" && request.method === "POST") {
      return handleSummarize(request, env);
    }

    if (url.pathname === "/api/session") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }

      const userId = url.searchParams.get("userId");
      if (!userId) {
        return new Response("missing ?userId", { status: 400 });
      }

      const id = env.HEARTH.idFromName(userId);
      const stub = env.HEARTH.get(id);

      return stub.fetch(request);
    }

    // This worker is API-only — the client is served by Cloudflare Pages.
    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
