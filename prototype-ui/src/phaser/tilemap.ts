import * as Phaser from "phaser";
import type { RoomWire } from "../../../app/shared/protocol";
import { ATLAS_COLS, TILES_ATLAS_KEY, TILE_SIZE } from "./assets";
import {
  NON_COLLIDING_INDICES,
  ensureAtlasTexture,
  resolveAtlasIndex,
} from "./procedural-tiles";

export interface BuiltRoom {
  tilemap: Phaser.Tilemaps.Tilemap;
  ground: Phaser.Tilemaps.TilemapLayer;
  collision: boolean[][];
  room: RoomWire;
}

/**
 * Build a Phaser tilemap from a worker-authored RoomWire. The ground layer
 * is driven by semantic tile keys (see `shared/tileset.ts`) and each cell
 * is expanded into a concrete atlas index by `resolveAtlasIndex`, which
 * can pick deterministic floor variants and context-aware wall caps.
 */
export function buildRoom(scene: Phaser.Scene, room: RoomWire): BuiltRoom {
  ensureAtlasTexture(scene);

  const tilemap = scene.make.tilemap({
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    width: room.cols,
    height: room.rows,
  });
  const tileset = tilemap.addTilesetImage(
    TILES_ATLAS_KEY,
    TILES_ATLAS_KEY,
    TILE_SIZE,
    TILE_SIZE,
    0,
    0,
  );
  if (!tileset) throw new Error("failed to bind tileset to tilemap");

  const layer = tilemap.createBlankLayer("ground", tileset, 0, 0);
  if (!layer) throw new Error("failed to create ground layer");
  for (let y = 0; y < room.rows; y++) {
    for (let x = 0; x < room.cols; x++) {
      const key = room.ground[y][x];
      const idx = resolveAtlasIndex(key, x, y, room.ground);
      if (idx >= 0) layer.putTileAt(idx, x, y);
    }
  }
  layer.setCollisionByExclusion(NON_COLLIDING_INDICES);
  // Real pathfinding uses the wire's collision grid; Phaser collision is
  // only there to keep debug arcade physics coherent if it's ever enabled.

  return {
    tilemap,
    ground: layer,
    collision: room.collision,
    room,
  };
}

/** Convert tile coords (col,row) to pixel center coords. */
export function tileToWorld(x: number, y: number): { x: number; y: number } {
  return {
    x: x * TILE_SIZE + TILE_SIZE / 2,
    y: y * TILE_SIZE + TILE_SIZE / 2,
  };
}

export { ATLAS_COLS, TILE_SIZE };
