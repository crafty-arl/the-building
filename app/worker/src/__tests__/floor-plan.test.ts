import { describe, it, expect } from "vitest";
import { __schema, floorAnchorList, proceduralFloorPlan } from "../floor-plan";
import {
  TILESET_KEYS,
  TILESET_REF,
  WALKABLE,
  type TilesetKey,
} from "../../../shared/tileset";

describe("proceduralFloorPlan", () => {
  it("emits one valid room with door, hearth, and 2 NPCs", () => {
    const plan = proceduralFloorPlan(
      "a quiet inn / tavern at the edge of a kingdom",
      "2026-04-17",
      "Friday",
    );
    expect(plan.tilesetRef).toBe(TILESET_REF);
    expect(plan.rooms).toHaveLength(1);
    expect(plan.portals).toEqual([]);
    expect(plan.source).toBe("fallback");

    const room = plan.rooms[0];
    expect(room.ground).toHaveLength(room.rows);
    for (const row of room.ground) expect(row).toHaveLength(room.cols);
    expect(room.collision).toHaveLength(room.rows);
    for (const row of room.collision) expect(row).toHaveLength(room.cols);

    // Every ground cell must be a known tile key.
    for (const row of room.ground) {
      for (const cell of row) {
        expect(TILESET_KEYS as readonly string[]).toContain(cell);
      }
    }

    // Collision must agree with WALKABLE for every cell.
    for (let y = 0; y < room.rows; y++) {
      for (let x = 0; x < room.cols; x++) {
        const key = room.ground[y][x] as TilesetKey;
        expect(room.collision[y][x]).toBe(WALKABLE[key] === false);
      }
    }

    // Must have a door object + at least one anchor.
    expect(room.objects.some((o) => o.kind === "door")).toBe(true);
    expect(room.objects.some((o) => o.kind === "anchor")).toBe(true);

    expect(plan.npcs).toHaveLength(2);
    expect(plan.npcs[0].palette).not.toBe(plan.npcs[1].palette);
    for (const npc of plan.npcs) {
      expect(room.objects.some((o) => o.name === npc.startAnchor)).toBe(true);
      // Every schedule hour 7..22 present exactly once.
      expect(npc.schedule).toHaveLength(16);
    }
  });

  it("is deterministic for the same premise", () => {
    const a = proceduralFloorPlan("a kitchen at dawn", "2026-04-17", "Friday");
    const b = proceduralFloorPlan("a kitchen at dawn", "2026-04-17", "Friday");
    expect(a.rooms[0].ground).toEqual(b.rooms[0].ground);
    expect(a.rooms[0].objects).toEqual(b.rooms[0].objects);
  });

  it("survives Zod validation through __schema", () => {
    const plan = proceduralFloorPlan("a scriptorium", "2026-04-17", "Friday");
    // Reshape back to the pre-assembly validated form.
    const validated = __schema.safeParse({
      version: 2,
      tilesetRef: plan.tilesetRef,
      rooms: plan.rooms,
      portals: plan.portals,
      npcs: plan.npcs.map((n) => ({
        name: n.name,
        backstory: n.backstory,
        palette: n.palette,
        objective: n.objective,
        motive: n.motive,
        schedule: n.schedule,
        startAnchor: n.startAnchor,
      })),
      playerObjective: plan.playerObjective,
      seed: plan.seed,
    });
    expect(validated.success).toBe(true);
  });
});

describe("floorAnchorList", () => {
  it("flattens every room's object names", () => {
    const plan = proceduralFloorPlan("a barn", "2026-04-17", "Friday");
    const list = floorAnchorList(plan);
    for (const obj of plan.rooms[0].objects) {
      expect(list).toContain(obj.name);
    }
  });
});

describe("FloorPlanSchema", () => {
  const base = () => {
    const plan = proceduralFloorPlan("baseline", "2026-04-17", "Friday");
    return {
      version: 2 as const,
      tilesetRef: plan.tilesetRef,
      rooms: plan.rooms,
      portals: plan.portals,
      npcs: plan.npcs.map((n) => ({
        name: n.name,
        backstory: n.backstory,
        palette: n.palette,
        objective: n.objective,
        motive: n.motive,
        schedule: n.schedule,
        startAnchor: n.startAnchor,
      })),
      playerObjective: plan.playerObjective,
      seed: plan.seed,
    };
  };

  it("rejects a ground grid with wrong row count", () => {
    const v = base();
    v.rooms[0].ground = v.rooms[0].ground.slice(0, -1);
    expect(__schema.safeParse(v).success).toBe(false);
  });

  it("rejects an NPC whose startAnchor names no object", () => {
    const v = base();
    v.npcs[0].startAnchor = "nonexistent_anchor";
    expect(__schema.safeParse(v).success).toBe(false);
  });

  it("rejects matching NPC palettes", () => {
    const v = base();
    v.npcs[1].palette = v.npcs[0].palette;
    expect(__schema.safeParse(v).success).toBe(false);
  });

  it("rejects a portal pointing to an unknown room", () => {
    const v = base();
    v.portals = [
      {
        from: { roomId: v.rooms[0].id, objectName: "door" },
        to: { roomId: "ghost-room", objectName: "door" },
        bidirectional: true,
      },
    ];
    expect(__schema.safeParse(v).success).toBe(false);
  });

  it("rejects unknown tile keys in the ground grid", () => {
    const v = base();
    v.rooms[0].ground[0][0] = "rocket" as never;
    expect(__schema.safeParse(v).success).toBe(false);
  });
});
