import { describe, it, expect } from "vitest";
import {
  characterFromNpc,
  charactersFromHello,
  npcCharId,
  sceneFromHello,
} from "../hearth-projection";
import type { HearthHello } from "../useHearth";

function makeHello(overrides: Partial<HearthHello["scene"]> = {}): HearthHello {
  return {
    userId: "u1",
    roomId: "r1",
    clock: { gameHour: 9, gameMinute: 0, runStartedAt: 0 },
    role: "owner",
    peerId: "peer-test",
    displayName: "test-otter",
    inviteToken: "tok-test",
    peers: [],
    health: {
      planSource: "ai",
      planGeneratedAt: 0,
      lastAlarmAt: null,
      nextAlarmAt: null,
    },
    difficulty: "resident",
    missedEvents: [],
    scene: {
      id: "day-2026-04-17-09",
      location: "The Crooked Lantern",
      timeOfDay: "day",
      moods: ["wry"],
      npcs: ["the-stranger", "Marek", "Idris"],
      anchors: ["door", "hearth_face", "window_sill", "bedside"],
      tilemap: [
        "####################",
        "#..................#",
        "#..w...............#",
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
      anchorCoords: {
        door: [9, 9],
        hearth_face: [2, 4],
        window_sill: [3, 2],
        bedside: [2, 9],
      },
      source: "fallback",
      ...overrides,
    },
    dailyPlan: {
      date: "2026-04-17",
      dayOfWeek: "Friday",
      playerObjective: "Find the letter.",
      openingHour: 9,
      closingHour: 22,
      seed: "test",
      npcs: [
        {
          name: "Marek",
          backstory: "swept this floor for years",
          palette: "warm",
          objective: "keep the room standing",
          motive: "a debt",
          schedule: [
            { hour: 9, activity: "opens shutters" },
            { hour: 13, activity: "sweeps ash" },
            { hour: 17, activity: "counts coins" },
          ],
          startAnchor: "hearth_face",
        },
        {
          name: "Idris",
          backstory: "arrived three nights ago",
          palette: "ash",
          objective: "wait for a reply",
          motive: "afraid",
          schedule: [
            { hour: 9, activity: "sits by the window" },
            { hour: 13, activity: "rubs the lantern" },
          ],
          startAnchor: "window_sill",
        },
      ],
    },
  };
}

describe("sceneFromHello", () => {
  it("carries floor_y verbatim from the wire", () => {
    const scene = sceneFromHello(makeHello());
    expect(scene.floor_y).toBe(9);
  });

  it("snaps non-visual anchors to floor_y", () => {
    const scene = sceneFromHello(makeHello());
    expect(scene.anchors.door.y).toBe(9);
    expect(scene.anchors.bedside.y).toBe(9);
  });

  it("keeps visual anchors (hearth_face, window_sill) at their authored y", () => {
    const scene = sceneFromHello(makeHello());
    expect(scene.anchors.hearth_face.y).toBe(4);
    expect(scene.anchors.window_sill.y).toBe(2);
  });

  it("synthesizes a center anchor on the floor row when the wire omits one", () => {
    const scene = sceneFromHello(makeHello());
    expect(scene.anchors.center).toBeDefined();
    expect(scene.anchors.center.y).toBe(9);
  });

  it("uses each NPC's startAnchor as its scene start", () => {
    const scene = sceneFromHello(makeHello());
    expect(scene.starts[npcCharId("Marek")]).toBe("hearth_face");
    expect(scene.starts[npcCharId("Idris")]).toBe("window_sill");
  });

  it("propagates the wire palette onto the engine scene", () => {
    const palette = {
      X: { name: "moss", color: "#3aa85a", walkable: true },
    };
    const scene = sceneFromHello(makeHello({ palette }));
    expect(scene.palette).toEqual(palette);
  });
});

describe("charactersFromHello", () => {
  it("mints one character per NPC, keyed to npc:<slug>", () => {
    const hello = makeHello();
    const scene = sceneFromHello(hello);
    const chars = charactersFromHello(hello, scene);
    expect(chars).toHaveLength(2);
    expect(chars.map((c) => c.id)).toEqual([
      npcCharId("Marek"),
      npcCharId("Idris"),
    ]);
  });

  it("places each character on the floor row at its startAnchor's x", () => {
    const hello = makeHello();
    const scene = sceneFromHello(hello);
    const chars = charactersFromHello(hello, scene);
    const marek = chars.find((c) => c.name === "Marek")!;
    const idris = chars.find((c) => c.name === "Idris")!;
    expect(marek.pos).toEqual({ x: 2, y: 9 }); // hearth_face.x, snapped to floor_y
    expect(idris.pos).toEqual({ x: 3, y: 9 }); // window_sill.x, snapped to floor_y
  });

  it("maps the NPC palette enum to a CHARACTER_PALETTES entry", () => {
    const hello = makeHello();
    const scene = sceneFromHello(hello);
    const chars = charactersFromHello(hello, scene);
    const marek = chars.find((c) => c.name === "Marek")!;
    // warm palette body color
    expect(marek.palette.body).toBe("#e8d0a8");
  });

  it("carries backstory / objective / motive verbatim", () => {
    const hello = makeHello();
    const scene = sceneFromHello(hello);
    const chars = charactersFromHello(hello, scene);
    const marek = chars.find((c) => c.name === "Marek")!;
    expect(marek.backstory).toBe("swept this floor for years");
    expect(marek.objective).toBe("keep the room standing");
    expect(marek.motive).toBe("a debt");
  });

  it("returns characters with transient: false (resident NPCs, not director-spawned)", () => {
    const hello = makeHello();
    const scene = sceneFromHello(hello);
    const chars = charactersFromHello(hello, scene);
    expect(chars.every((c) => !c.transient)).toBe(true);
  });
});

describe("npcCharId", () => {
  it("matches the agentId the dispatcher uses (npc:<slug>)", () => {
    expect(npcCharId("Marek")).toBe("npc:marek");
    expect(npcCharId("Lila Vex")).toBe("npc:lila-vex");
    expect(npcCharId("  Two   Spaces  ")).toBe("npc:two-spaces");
  });
});

describe("characterFromNpc — spawned NPC", () => {
  it("flags transient: true when NpcDay.transient is set", () => {
    const hello = makeHello();
    const scene = sceneFromHello(hello);
    const spawned = characterFromNpc(
      {
        name: "Wren",
        backstory: "soaked courier",
        palette: "cool",
        objective: "deliver the letter",
        motive: "doesn't know what's inside",
        schedule: [],
        startAnchor: "door",
        transient: true,
      },
      scene,
    );
    expect(spawned.id).toBe("npc:wren");
    expect(spawned.transient).toBe(true);
    expect(spawned.pos.y).toBe(scene.floor_y);
    expect(spawned.pos.x).toBe(scene.anchors.door.x);
  });

  it("falls back to npc.startAnchor when scene.starts has no entry yet", () => {
    const hello = makeHello();
    const scene = sceneFromHello(hello);
    // Scene was projected before this NPC existed, so starts[id] is undefined.
    expect(scene.starts["npc:wren"]).toBeUndefined();
    const spawned = characterFromNpc(
      {
        name: "Wren",
        backstory: "b",
        palette: "warm",
        objective: "o",
        motive: "m",
        schedule: [],
        startAnchor: "window_sill",
        transient: true,
      },
      scene,
    );
    expect(spawned.pos.x).toBe(scene.anchors.window_sill.x);
  });
});
