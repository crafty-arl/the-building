import { describe, it, expect } from "vitest";
import { RoomSchema, postProcessRoom } from "../index";

type RoomInput = Parameters<typeof RoomSchema.parse>[0];

// Build a box-shaped side-view room at arbitrary size. Exercises the full
// schema + postProcess pipeline without needing a live LLM. Each fixture
// contains a ceiling cap, side walls, foundation rows, door on the floor,
// a hearth above the floor, and bed/table/chair/window fixtures.
function buildFixture(cols: number, rows: number, floorY: number): RoomInput {
  const map: string[] = [];
  for (let y = 0; y < rows; y++) {
    const row: string[] = [];
    for (let x = 0; x < cols; x++) {
      if (y === 0 || y === rows - 1) row.push("#");
      else if (y > floorY) row.push("#");
      else if (x === 0 || x === cols - 1) row.push("#");
      else row.push(".");
    }
    map.push(row.join(""));
  }
  const setAt = (y: number, x: number, ch: string) => {
    const arr = map[y].split("");
    arr[x] = ch;
    map[y] = arr.join("");
  };
  setAt(floorY, cols - 1, "|");
  setAt(floorY, 3, "b");
  setAt(floorY, Math.floor(cols / 2) + 2, "t");
  setAt(floorY, Math.floor(cols / 2) + 4, "c");
  setAt(floorY - 1, 1, "~");
  const winY = Math.max(1, Math.floor(floorY / 2));
  setAt(winY, Math.floor(cols / 4), "w");
  setAt(winY, Math.floor((cols * 3) / 4), "w");
  return {
    name: `test-${cols}x${rows}`,
    map,
    floor_y: floorY,
    anchors: {
      center: [Math.floor(cols / 2), floorY],
      bed_side: [3, floorY],
      door_in: [cols - 1, floorY],
      hearth_face: [1, floorY - 1],
    },
    lines: ["the room settles around them.", "somewhere outside, wind."],
  };
}

const SIZES: Array<[cols: number, rows: number, floorY: number]> = [
  [20, 8, 5],
  [24, 10, 7],
  [32, 11, 8],
  [40, 12, 9],
  [48, 14, 11],
];

describe("room pipeline smoke (5 fixtures across dim range)", () => {
  for (const [cols, rows, floorY] of SIZES) {
    it(`passes schema + postProcess at ${cols}x${rows} floor_y=${floorY}`, () => {
      const fixture = buildFixture(cols, rows, floorY);
      const parsed = RoomSchema.safeParse(fixture);
      if (!parsed.success) {
        throw new Error(
          `schema rejected ${cols}x${rows}: ${JSON.stringify(parsed.error.issues)}`,
        );
      }
      const room = postProcessRoom(parsed.data);
      expect(room.floor_y).toBe(floorY);
      expect(room.projection).toBe("side");
      expect(room.map.length).toBe(rows);
      expect(room.map[0].length).toBe(cols);
      expect(room.map[floorY].includes("|")).toBe(true);
      const VISUAL = /^(hearth|window|lantern|altar|shelf|ceiling|beam|chimney)/;
      for (const [name, coord] of Object.entries(room.anchors)) {
        if (VISUAL.test(name)) continue;
        expect(coord[1]).toBe(floorY);
      }
      const center = room.anchors.center;
      expect(center).toBeDefined();
      const floorRow = room.map[floorY];
      const ch = floorRow[center[0]];
      expect([".", "|", "b", "t", "c"]).toContain(ch);
    });
  }
});
