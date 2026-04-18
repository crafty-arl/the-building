import EasyStar from "easystarjs";
import {
  SURFACE_TOP,
  WALKABLE,
  type TilesetKey,
} from "../../../app/shared/tileset";
import type { Waypoint } from "./types";

/**
 * Side-view "surface graph" pathfinder. A cell (x, y) is standable iff:
 *  - the cell itself is WALKABLE (sprite body can occupy it), AND
 *  - the cell BELOW it is SURFACE_TOP (a floor the sprite stands on),
 *    OR the cell itself is a ladder/door (vertical or through-wall
 *    traversal tile that implies its own standable surface).
 *
 * This collapses the 2D grid into a 1D walkway per floor without needing
 * a separate surface graph data structure — EasyStar still runs over the
 * full grid, just with 99 % of cells marked unreachable.
 */
export function buildPathfinder(ground: string[][]): Pathfinder {
  const rows = ground.length;
  const cols = ground[0]?.length ?? 0;

  const grid: number[][] = [];
  for (let y = 0; y < rows; y++) {
    const row: number[] = [];
    for (let x = 0; x < cols; x++) {
      const tile = ground[y][x] as TilesetKey;
      const here = WALKABLE[tile] ?? false;
      if (!here) {
        row.push(1);
        continue;
      }
      // Ladders + doors are standable on their own terms.
      if (tile === "ladder" || tile === "door") {
        row.push(0);
        continue;
      }
      const below = y + 1 < rows ? (ground[y + 1][x] as TilesetKey) : null;
      const supported = below ? (SURFACE_TOP[below] ?? false) : false;
      row.push(supported ? 0 : 1);
    }
    grid.push(row);
  }

  const es = new EasyStar.js();
  es.setGrid(grid);
  es.setAcceptableTiles([0]);
  // Side-view single-floor: no diagonals; sprites walk along a horizontal
  // row. Once ladders/stairs land, we can allow diagonals on those tiles.
  es.disableDiagonals();
  es.disableCornerCutting();

  return {
    cols,
    rows,
    isStandable(x: number, y: number): boolean {
      if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
      return grid[y][x] === 0;
    },
    findPath(from: Waypoint, to: Waypoint): Promise<Waypoint[] | null> {
      return new Promise((resolve) => {
        if (
          from.x < 0 ||
          from.y < 0 ||
          from.x >= cols ||
          from.y >= rows ||
          to.x < 0 ||
          to.y < 0 ||
          to.x >= cols ||
          to.y >= rows
        ) {
          resolve(null);
          return;
        }
        es.findPath(from.x, from.y, to.x, to.y, (path) => {
          if (!path || path.length === 0) {
            resolve(null);
            return;
          }
          resolve(path.map((p) => ({ x: p.x, y: p.y })));
        });
        es.calculate();
      });
    },
  };
}

export interface Pathfinder {
  cols: number;
  rows: number;
  /** True if a sprite can stand at (x, y) in this grid. */
  isStandable(x: number, y: number): boolean;
  findPath(from: Waypoint, to: Waypoint): Promise<Waypoint[] | null>;
}
