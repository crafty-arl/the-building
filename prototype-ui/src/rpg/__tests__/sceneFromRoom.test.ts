import { describe, it, expect } from "vitest";
import { sceneFromRoom, isArchivedRoom, type GeneratedRoom, type SavedRoom } from "../engine";

function sideRoom(): GeneratedRoom {
  return {
    name: "cabin",
    map: [
      "########################",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "########################",
    ],
    floor_y: 7,
    projection: "side",
    anchors: {
      bed_side: [5, 3],
      hearth_face: [18, 2],
      door_in: [22, 7],
    },
    lines: ["a small cabin"],
  };
}

describe("sceneFromRoom", () => {
  it("carries floor_y into the scene verbatim when provided", () => {
    const scene = sceneFromRoom(sideRoom());
    expect(scene.floor_y).toBe(7);
  });

  it("snaps non-visual anchors to floor_y", () => {
    const scene = sceneFromRoom(sideRoom());
    expect(scene.anchors.bed_side.y).toBe(7);
    expect(scene.anchors.door_in.y).toBe(7);
  });

  it("keeps visual anchors (hearth_face) at their authored y", () => {
    const scene = sceneFromRoom(sideRoom());
    expect(scene.anchors.hearth_face.y).toBe(2);
    expect(scene.anchors.hearth_face.x).toBe(18);
  });

  it("falls back to a sensible floor_y when missing (legacy payload)", () => {
    const r = sideRoom();
    delete (r as { floor_y?: number }).floor_y;
    const scene = sceneFromRoom(r);
    expect(scene.floor_y).toBeGreaterThan(0);
    expect(scene.floor_y).toBeLessThan(r.map.length - 1);
  });

  it("emits a center anchor on the floor row when unspecified", () => {
    const scene = sceneFromRoom(sideRoom());
    expect(scene.anchors.center).toBeDefined();
    expect(scene.anchors.center.y).toBe(7);
  });
});

describe("isArchivedRoom", () => {
  const base = (overrides: Partial<SavedRoom>): SavedRoom => ({
    id: "r1",
    name: "x",
    snapshot: {
      scene: { map: ["####", "....", "####"], floor_y: 1 },
    } as unknown as SavedRoom["snapshot"],
    lastPlayedAt: 0,
    createdAt: 0,
    buildingId: "",
    ...overrides,
  });

  it("treats projection='side' as non-archived", () => {
    expect(isArchivedRoom(base({ projection: "side" }))).toBe(false);
  });

  it("treats projection='top_down' as archived", () => {
    expect(isArchivedRoom(base({ projection: "top_down" }))).toBe(true);
  });

  it("flags unknown projection + missing floor_y as archived", () => {
    const r = base({});
    (r.snapshot.scene as { floor_y?: number }).floor_y = undefined as unknown as number;
    expect(isArchivedRoom(r)).toBe(true);
  });

  it("treats unknown projection + present floor_y as non-archived", () => {
    expect(isArchivedRoom(base({}))).toBe(false);
  });
});
