import { describe, it, expect } from "vitest";
import { RoomSchema, MapSchema } from "../index";

// A baseline valid side-view room: 24 cols × 10 rows, floor_y=7, ceiling
// cap, foundation below the floor, door on the floor row, two windows,
// hearth attached to the left wall.
const validRoom = {
  name: "woodcutter's cabin",
  map: [
    "########################",
    "#......................#",
    "#......................#",
    "#...w..........w.......#",
    "#......................#",
    "#......................#",
    "#......................#",
    "#....b.....t...c.......|",
    "########################",
    "########################",
  ],
  floor_y: 7,
  anchors: {
    center: [12, 7] as [number, number],
    bed_side: [5, 7] as [number, number],
    table_side: [11, 7] as [number, number],
    hearth_face: [1, 5] as [number, number],
    door_in: [22, 7] as [number, number],
  },
  lines: [
    "the door clicks shut behind them.",
    "rain starts tapping the shutters.",
  ],
};

describe("RoomSchema", () => {
  it("accepts a valid side-view room", () => {
    const r = RoomSchema.safeParse(validRoom);
    expect(r.success).toBe(true);
  });

  it("rejects a room missing floor_y", () => {
    const r = RoomSchema.safeParse({ ...validRoom, floor_y: undefined });
    expect(r.success).toBe(false);
  });

  it("rejects floor_y = rows - 1 (no foundation row)", () => {
    const room = {
      ...validRoom,
      floor_y: validRoom.map.length - 1,
    };
    const r = RoomSchema.safeParse(room);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toMatch(/floor_y/);
    }
  });

  it("rejects a floor row with fewer than 8 walkable chars", () => {
    const thinFloor = validRoom.map.slice();
    thinFloor[7] = "#######....############|";
    const r = RoomSchema.safeParse({ ...validRoom, map: thinFloor });
    expect(r.success).toBe(false);
  });

  it("rejects rooms narrower than 20 cols", () => {
    const narrow = {
      ...validRoom,
      map: validRoom.map.map((row) => row.slice(0, 15)),
    };
    const r = RoomSchema.safeParse(narrow);
    expect(r.success).toBe(false);
  });

  it("rejects rooms with mismatched row widths", () => {
    const jagged = validRoom.map.slice();
    jagged[2] = jagged[2] + ".";
    const r = RoomSchema.safeParse({ ...validRoom, map: jagged });
    expect(r.success).toBe(false);
  });
});

describe("MapSchema", () => {
  const validMap = {
    name: "woodcutter's cabin",
    map: validRoom.map,
    floor_y: 7,
    anchors: validRoom.anchors,
  };

  it("accepts a valid side-view map payload", () => {
    const r = MapSchema.safeParse(validMap);
    expect(r.success).toBe(true);
  });

  it("rejects when the door is not on the floor row", () => {
    const noDoorFloor = validMap.map.slice();
    // Replace the door on floor_y with a wall, put a door in row 1 instead.
    noDoorFloor[7] = noDoorFloor[7].replace("|", "#");
    noDoorFloor[1] = "#" + ".".repeat(21) + "#|";
    noDoorFloor[1] = noDoorFloor[1].slice(0, 24);
    const r = MapSchema.safeParse({ ...validMap, map: noDoorFloor });
    expect(r.success).toBe(false);
  });

  it("rejects anchors pointing out of bounds", () => {
    const r = MapSchema.safeParse({
      ...validMap,
      anchors: { ...validMap.anchors, moon: [999, 999] as [number, number] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown tile chars not declared in palette", () => {
    const weird = validMap.map.slice();
    weird[3] = "#...X".padEnd(24, ".") + "#";
    weird[3] = weird[3].slice(0, 24);
    const r = MapSchema.safeParse({ ...validMap, map: weird });
    expect(r.success).toBe(false);
  });

  it("accepts custom tiles when declared in palette", () => {
    const custom = validMap.map.slice();
    custom[3] = "#...X" + ".".repeat(18) + "#";
    const r = MapSchema.safeParse({
      ...validMap,
      map: custom,
      palette: {
        X: { name: "cairn", color: "#aabbcc", walkable: false },
      },
    });
    expect(r.success).toBe(true);
  });
});
