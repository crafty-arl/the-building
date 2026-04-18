import type { TilesetKey } from "../../../app/shared/tileset";

/**
 * Atlas key + geometry for the client-side procedurally-painted tileset.
 * The atlas is drawn once at scene boot by `procedural-tiles.ts`; keeping
 * the key stable here lets the tilemap bind to it the same way it would
 * bind to a static PNG.
 *
 * Atlas is 8 cols × 3 rows of 16×16 tiles (48 possible slots). Side-view
 * labels only use ~23 of them — spare cells stay transparent.
 */

export const TILES_ATLAS_KEY = "augur-sideview-v1";
export const TILE_SIZE = 16;
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 3;

/**
 * Fallback semantic→index table. The real resolver
 * (`resolveAtlasIndex` in `procedural-tiles.ts`) can pick context-aware
 * variants (floor A/B, bed left/right), so this table only guarantees a
 * sensible default for every label.
 */
export const TILE_INDEX: Record<TilesetKey, number> = {
  air: 0,
  ceiling: 1,
  wall: 2,
  floor: 3,
  background_wall: 5,
  door: 7,
  window: 8,
  torch: 9,
  painting: 10,
  bed: 11,
  chair: 13,
  table: 14,
  stove: 15,
  fireplace: 16,
  bookshelf: 17,
  chest: 18,
  plant: 19,
  rug: 20,
  ladder: 22,
};

export const FALLBACK_TILE_INDEX = 3; // floor-a — benign default

export function tileIndexFor(key: string): number {
  const mapped = (TILE_INDEX as Record<string, number>)[key];
  return typeof mapped === "number" ? mapped : FALLBACK_TILE_INDEX;
}
