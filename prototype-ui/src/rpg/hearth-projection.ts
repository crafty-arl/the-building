/**
 * Project a Hearth WS hello onto the engine's Scene + Character[] shape.
 *
 * Hearth is the source of truth for room geometry, anchors, palette, and
 * the resident NPC roster. The client only renders what arrives over WS —
 * there is no client-side procedural fallback for any of this.
 *
 * Anchor ids must match what the agent dispatcher uses for agentId so that
 * `agent-decided` messages can reconcile back to the right Character.
 */

import type {
  NpcDay,
  ScheduleSlot as WireScheduleSlot,
} from "../../../app/shared/protocol";
import {
  CHARACTER_PALETTES,
  type Character,
  type Scene,
  type ScheduleSlot,
  type Tile,
} from "./engine";
import type { HearthHello } from "./useHearth";

/**
 * Mint a Character from a single NpcDay against an existing engine Scene.
 * Used both when projecting the initial hello roster and when adding a
 * spawned NPC mid-day. Honors `transient` so spawn-arrivals are flagged.
 */
export function characterFromNpc(npc: NpcDay, scene: Scene): Character {
  const id = npcCharId(npc.name);
  const startName = scene.starts[id] ?? npc.startAnchor ?? "";
  const anchor: Tile =
    scene.anchors[startName] ??
    scene.anchors["center"] ??
    { x: 4, y: scene.floor_y };
  const paletteKey = npc.palette as keyof typeof CHARACTER_PALETTES;
  const palette = CHARACTER_PALETTES[paletteKey] ?? CHARACTER_PALETTES.warm;
  return {
    id,
    name: npc.name,
    description: npc.backstory ?? "",
    pos: { x: anchor.x, y: scene.floor_y },
    facing: "right" as const,
    moving: false,
    path: null,
    goal: null,
    palette: { ...palette },
    emote: null,
    speech: null,
    mood: "watchful" as const,
    schedule:
      scene.schedules[id] ?? scheduleFromNpc(npc, Object.keys(scene.anchors)),
    scheduleAnchor: null,
    inventory: [],
    backstory: npc.backstory ?? "",
    objective: npc.objective ?? "",
    motive: npc.motive ?? "",
    hp: 3,
    dead: false,
    transient: !!npc.transient,
  };
}

const VISUAL_ANCHOR = /^(hearth|window|lantern|altar|shelf|ceiling|beam|chimney)/;

function isVisualAnchor(name: string): boolean {
  return VISUAL_ANCHOR.test(name);
}

export function npcCharId(name: string): string {
  return (
    "npc:" +
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

export function sceneFromHello(hello: HearthHello): Scene {
  const wire = hello.scene;
  const map = wire.tilemap ?? [];
  const rows = map.length;
  const floor_y =
    typeof wire.floorY === "number"
      ? wire.floorY
      : Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.8)));

  const anchorSrc = wire.anchorCoords ?? {};
  const anchors: Record<string, Tile> = {};
  for (const [name, coords] of Object.entries(anchorSrc)) {
    const [x, y] = coords;
    anchors[name] = { x, y: isVisualAnchor(name) ? y : floor_y };
  }
  if (!anchors["center"]) {
    const row = map[floor_y] ?? "";
    anchors["center"] = {
      x: row.length > 0 ? Math.floor(row.length / 2) : 4,
      y: floor_y,
    };
  }

  const anchorNames = Object.keys(anchors);
  const npcs = hello.dailyPlan.npcs ?? [];
  const starts: Record<string, string> = {};
  const schedules: Record<string, ScheduleSlot[]> = {};
  npcs.forEach((npc, i) => {
    const id = npcCharId(npc.name);
    const start =
      npc.startAnchor && anchors[npc.startAnchor]
        ? npc.startAnchor
        : (anchorNames[i] ?? "center");
    starts[id] = start;
    schedules[id] = scheduleFromNpc(npc, anchorNames);
  });

  return {
    id: wire.id,
    name: wire.location || "a room",
    map,
    floor_y,
    anchors,
    palette: wire.palette,
    starts,
    schedules,
  };
}

export function charactersFromHello(
  hello: HearthHello,
  scene: Scene,
): Character[] {
  return (hello.dailyPlan.npcs ?? []).map((npc) => characterFromNpc(npc, scene));
}

function scheduleFromNpc(
  npc: NpcDay,
  anchorNames: string[],
): ScheduleSlot[] {
  if (anchorNames.length === 0) return [{ fromHour: 0, anchor: "center" }];
  const start =
    npc.startAnchor && anchorNames.includes(npc.startAnchor)
      ? npc.startAnchor
      : anchorNames[0];
  // Hearth's per-hour schedule entries describe activity, not anchor — we
  // don't have a per-slot anchor to honor. Spread the NPC across `start`
  // and the next few anchors so movement still happens through the day.
  const others = anchorNames.filter((a) => a !== start);
  const ring = [start, ...others.slice(0, 5)];
  const hours = pickScheduleHours(npc.schedule, [0, 5, 9, 13, 17, 21]);
  return hours.map((h, i) => ({ fromHour: h, anchor: ring[i % ring.length] }));
}

function pickScheduleHours(
  wire: WireScheduleSlot[] | undefined,
  fallback: number[],
): number[] {
  if (!wire || wire.length === 0) return fallback;
  const seen = new Set<number>();
  for (const s of wire) {
    if (typeof s.hour === "number") seen.add(s.hour);
    if (seen.size >= 6) break;
  }
  if (seen.size === 0) return fallback;
  return [...seen].sort((a, b) => a - b);
}
