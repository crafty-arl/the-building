/**
 * Tileset registry — closed union of semantic tile keys shared between the
 * Hearth worker (which authors rooms with these labels, never tile indices)
 * and the client's Phaser MapScene (which maps each key to a concrete tile
 * index inside its atlas). Swapping sprite packs later is a client-only
 * change as long as every key here is mapped on that side.
 *
 * This is a **side-view** (Terraria-style) tileset. Rooms are vertical
 * cross-sections: the feet row sits one cell above a row of `floor` tiles,
 * the perimeter is walls + ceiling, and the interior is mostly
 * `background_wall` (visible wallpaper behind the action).
 *
 * WALKABLE = can a sprite's body occupy this cell (pass through it).
 * SURFACE_TOP = can a sprite stand on the cell DIRECTLY BELOW this tile's
 * anchor — i.e. is this tile's top a floor you can rest on. The client's
 * surface-graph pathfinder uses both: a position (x, y) is standable iff
 *   WALKABLE[ground[y][x]] && SURFACE_TOP[ground[y+1][x]].
 */

export const TILESET_KEYS = [
  // Structural
  "air",               // empty interior; sprite bodies occupy these
  "floor",             // solid; standable surface on top
  "wall",              // solid perimeter / interior vertical divider
  "ceiling",           // solid top row
  "background_wall",   // decorative back wallpaper; non-solid
  // Traversal
  "door",              // walkable opening in a wall
  "ladder",            // vertical climb (decorative in single-floor slice)
  // Decorative wall-mounted
  "window",            // on background_wall; non-solid
  "torch",             // wall sconce; non-solid
  "painting",          // wall decoration; non-solid
  // Floor-standing props
  "bed",
  "chair",
  "table",
  "stove",
  "fireplace",
  "bookshelf",
  "chest",
  "plant",
  "rug",               // decorative overlay on the floor-top; non-solid
] as const;

export type TilesetKey = (typeof TILESET_KEYS)[number];

/**
 * Does a sprite body pass through this tile without being blocked?
 * Things a sprite can stand NEXT TO (props) are solid; things that sit
 * on the back wall (windows, torches, paintings) are passable.
 */
export const WALKABLE: Record<TilesetKey, boolean> = {
  air: true,
  background_wall: true,
  door: true,
  ladder: true,
  window: true,
  torch: true,
  painting: true,
  rug: true,
  floor: false,
  wall: false,
  ceiling: false,
  bed: false,
  chair: false,
  table: false,
  stove: false,
  fireplace: false,
  bookshelf: false,
  chest: false,
  plant: false,
};

/**
 * Does this tile's top surface support a sprite standing ON it? Only the
 * `floor` tile does in the single-floor slice. `wall` and `ceiling` are
 * solid but you don't stand on them in side-view (no ledges yet).
 */
export const SURFACE_TOP: Record<TilesetKey, boolean> = {
  floor: true,
  air: false,
  background_wall: false,
  door: false,
  ladder: false,
  window: false,
  torch: false,
  painting: false,
  rug: false,
  wall: false,
  ceiling: false,
  bed: false,
  chair: false,
  table: false,
  stove: false,
  fireplace: false,
  bookshelf: false,
  chest: false,
  plant: false,
};

/** Current tileset pack name. Client refuses to render unknown refs. */
export const TILESET_REF = "augur-sideview-v1" as const;
export type TilesetRef = typeof TILESET_REF;

export function isTilesetKey(value: unknown): value is TilesetKey {
  return typeof value === "string" && (TILESET_KEYS as readonly string[]).includes(value);
}
