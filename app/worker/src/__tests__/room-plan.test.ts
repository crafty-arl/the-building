import { describe, it, expect } from "vitest";
import { __schema, proceduralRoomPlan } from "../room-plan";

describe("proceduralRoomPlan", () => {
  it("emits a tilemap, anchors, and 2 npcs that all satisfy the Zod schema", () => {
    const plan = proceduralRoomPlan(
      "an attic that was sealed for years",
      "2026-04-17",
      "Friday",
    );
    expect(plan.source).toBe("fallback");
    expect(plan.tilemap.length).toBeGreaterThanOrEqual(8);
    expect(plan.npcs).toHaveLength(2);
    expect(plan.npcs[0].palette).not.toBe(plan.npcs[1].palette);
    // Round-trip the procedural output through the schema we'd validate the
    // LLM against — proves the fallback can never accidentally drift out of
    // spec relative to the LLM contract.
    const reshaped = {
      tilemap: plan.tilemap,
      floorY: plan.floorY,
      anchors: plan.anchors,
      palette: plan.palette,
      playerObjective: plan.playerObjective,
      seed: plan.seed,
      npcs: plan.npcs.map((n) => ({
        name: n.name,
        backstory: n.backstory,
        palette: n.palette,
        objective: n.objective,
        motive: n.motive,
        schedule: n.schedule,
        startAnchor: n.startAnchor,
      })),
    };
    const result = __schema.safeParse(reshaped);
    if (!result.success) {
      // Surface the first issue so the failure is debuggable.
      throw new Error(
        "procedural plan fails schema: " +
          result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    }
  });

  it("yields a stable layout for a stable prompt", () => {
    const a = proceduralRoomPlan("a kitchen at dawn", "2026-04-17", "Friday");
    const b = proceduralRoomPlan("a kitchen at dawn", "2026-04-17", "Friday");
    expect(a.tilemap).toEqual(b.tilemap);
    expect(a.anchors).toEqual(b.anchors);
  });
});

describe("RoomPlanSchema", () => {
  const validBase = {
    tilemap: [
      "####################",
      "#..................#",
      "#........w.........#",
      "#~~~...............#",
      "#~~~...............#",
      "#~~~...............#",
      "#..................#",
      "#............t..c..#",
      "#.b................#",
      "#........|.........#",
      "####################",
    ],
    floorY: 9,
    anchors: {
      door: [9, 9],
      hearth_face: [2, 9],
      bedside: [2, 9],
      window_sill: [9, 2],
    },
    playerObjective: "Find what was hidden under the floorboards.",
    seed: "rain on the eaves, the smell of old paper",
    npcs: [
      {
        name: "Ash",
        backstory: "Has lived above the room since the floors went silent.",
        palette: "warm",
        objective: "Open the box without anyone hearing.",
        motive: "What's in the box was meant for them.",
        schedule: [{ hour: 7, activity: "kneels by the bed" }],
        startAnchor: "bedside",
      },
      {
        name: "Rook",
        backstory: "Came back to the door this morning and has not gone in.",
        palette: "ash",
        objective: "Decide whether to knock.",
        motive: "Owes someone an answer they will not say aloud.",
        schedule: [{ hour: 7, activity: "stands at the door" }],
        startAnchor: "door",
      },
    ],
  };

  it("accepts a clean plan", () => {
    expect(__schema.safeParse(validBase).success).toBe(true);
  });

  it("rejects a tilemap with mismatched row widths", () => {
    const bad = { ...validBase, tilemap: [...validBase.tilemap.slice(0, -1), "###################"] };
    const r = __schema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes("row width"))).toBe(true);
    }
  });

  it("rejects an unknown glyph not declared in palette", () => {
    const bad = {
      ...validBase,
      tilemap: [
        ...validBase.tilemap.slice(0, 4),
        "#~~~...X...........#",
        ...validBase.tilemap.slice(5),
      ],
    };
    const r = __schema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes("unknown glyph"))).toBe(true);
    }
  });

  it("rejects an NPC with startAnchor pointing at a missing anchor", () => {
    const bad = {
      ...validBase,
      npcs: [
        { ...validBase.npcs[0], startAnchor: "nowhere" },
        validBase.npcs[1],
      ],
    };
    const r = __schema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects two NPCs with the same palette", () => {
    const bad = {
      ...validBase,
      npcs: [
        { ...validBase.npcs[0], palette: "warm" },
        { ...validBase.npcs[1], palette: "warm" },
      ],
    };
    const r = __schema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects an anchor outside the grid", () => {
    const bad = { ...validBase, anchors: { ...validBase.anchors, door: [99, 99] } };
    const r = __schema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects a non-hex palette color", () => {
    const bad = {
      ...validBase,
      palette: { X: { name: "moss", color: "green", walkable: true } },
      tilemap: [
        ...validBase.tilemap.slice(0, 4),
        "#~~~...X...........#",
        ...validBase.tilemap.slice(5),
      ],
    };
    const r = __schema.safeParse(bad);
    expect(r.success).toBe(false);
  });
});
