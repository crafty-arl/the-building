import { describe, it, expect } from "vitest";
import { isArchivedRoom, type SavedRoom } from "../engine";

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
