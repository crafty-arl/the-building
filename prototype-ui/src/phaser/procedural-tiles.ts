import * as Phaser from "phaser";
import { ATLAS_COLS, ATLAS_ROWS, TILE_SIZE, TILES_ATLAS_KEY } from "./assets";

/**
 * Procedural side-view tile atlas. All tiles drawn in code with a warm,
 * candle-lit palette. Generated once per game via `ensureAtlasTexture`.
 *
 * Side-view atlas layout (8 cols × 3 rows, 16px):
 *   row 0:  air      ceiling  wall     floor-a  floor-b  bg-a   bg-b    door
 *   row 1:  window   torch    painting bed-L    bed-R    chair  table   stove
 *   row 2:  fire     bookshf  chest    plant    rug-a    rug-b  ladder  spare
 */

export const AI = {
  AIR: 0,
  CEILING: 1,
  WALL: 2,
  FLOOR_A: 3,
  FLOOR_B: 4,
  BG_A: 5,
  BG_B: 6,
  DOOR: 7,
  WINDOW: 8,
  TORCH: 9,
  PAINTING: 10,
  BED_LEFT: 11,
  BED_RIGHT: 12,
  CHAIR: 13,
  TABLE: 14,
  STOVE: 15,
  FIREPLACE: 16,
  BOOKSHELF: 17,
  CHEST: 18,
  PLANT: 19,
  RUG_A: 20,
  RUG_B: 21,
  LADDER: 22,
  SPARE: 23,
} as const;

export type AtlasIndex = (typeof AI)[keyof typeof AI];

const P = {
  // floor / wood
  floorBase: 0x5a4838,
  floorHighlight: 0x8a7a5a,
  floorShadow: 0x3d2f20,
  floorGrain: 0x4a3a2a,
  floorTopEdge: 0xb09878,
  // background wall
  bgBase: 0x2e2218,
  bgHighlight: 0x3f2f22,
  bgWeave: 0x1f1812,
  // stone wall (side)
  wallBase: 0x4a3d32,
  wallHighlight: 0x6a5a4a,
  wallShadow: 0x28201a,
  wallSeam: 0x3a3028,
  // ceiling beam
  ceilingBeam: 0x3d2818,
  ceilingGrain: 0x5a3818,
  ceilingDark: 0x1a0f08,
  // door
  doorBase: 0x6a3f22,
  doorPlank: 0x4a2c16,
  doorTrim: 0x2a1608,
  doorKnob: 0xe8b45a,
  // window
  windowFrame: 0x3a2818,
  windowPane: 0x4a7aa0,
  windowPaneLight: 0x8ac0e0,
  // torch
  torchMount: 0x2a1608,
  torchStem: 0x3d2818,
  torchFlame: 0xffb040,
  torchFlameCore: 0xfff0a0,
  torchHalo: 0xe89030,
  // painting
  paintFrame: 0x7a5838,
  paintFrameDark: 0x3d2818,
  paintCanvas: 0xd4c4a4,
  paintShapeA: 0x4a7aa0,
  paintShapeB: 0x7a2820,
  // bed
  bedFrame: 0x5a3818,
  bedSheet: 0xd4c4a4,
  bedPillow: 0xf0e4c8,
  bedBlanket: 0xa03828,
  // table/chair
  tableTop: 0x7a5838,
  tableLeg: 0x3d2818,
  chairSeat: 0x8a6440,
  chairBack: 0x5a3a20,
  // stove
  stoveBody: 0x2a2a2e,
  stoveBase: 0x1a1a1f,
  stoveGlow: 0xff8020,
  stoveHot: 0xffc060,
  // fireplace
  hearthStone: 0x3d3028,
  hearthStoneLight: 0x5a4838,
  hearthGlow: 0xf08020,
  hearthCoreBright: 0xfff0a0,
  hearthCoal: 0x1a0f08,
  // bookshelf
  shelfFrame: 0x4a2c16,
  shelfBoard: 0x3d1f0c,
  book1: 0xa03828,
  book2: 0x4a7aa0,
  book3: 0x5f8a52,
  book4: 0xc8a050,
  book5: 0x7a2820,
  // chest
  chestBody: 0x6a3f22,
  chestDark: 0x3d2818,
  chestBand: 0x8a6030,
  chestLock: 0xe8b45a,
  // plant
  plantPot: 0x7a3818,
  plantPotDark: 0x4a1f0c,
  plantLeaf: 0x5f8a52,
  plantLeafDark: 0x3d5a32,
  // rug
  rugBase: 0x7a2820,
  rugWeave: 0x4a1810,
  rugTrim: 0xd4a040,
  // ladder
  ladderBase: 0x4a2c16,
  ladderLight: 0x6a3f22,
} as const;

export function ensureAtlasTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(TILES_ATLAS_KEY)) return;

  const width = ATLAS_COLS * TILE_SIZE;
  const height = ATLAS_ROWS * TILE_SIZE;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);

  const cell = (i: number) => ({
    x: (i % ATLAS_COLS) * TILE_SIZE,
    y: Math.floor(i / ATLAS_COLS) * TILE_SIZE,
  });

  // row 0 -----------------------------------------------------------------
  paintAir(g, cell(AI.AIR));
  paintCeiling(g, cell(AI.CEILING));
  paintWall(g, cell(AI.WALL));
  paintFloor(g, cell(AI.FLOOR_A), "a");
  paintFloor(g, cell(AI.FLOOR_B), "b");
  paintBackground(g, cell(AI.BG_A), "a");
  paintBackground(g, cell(AI.BG_B), "b");
  paintDoor(g, cell(AI.DOOR));

  // row 1 -----------------------------------------------------------------
  paintWindow(g, cell(AI.WINDOW));
  paintTorch(g, cell(AI.TORCH));
  paintPainting(g, cell(AI.PAINTING));
  paintBedHalf(g, cell(AI.BED_LEFT), "left");
  paintBedHalf(g, cell(AI.BED_RIGHT), "right");
  paintChair(g, cell(AI.CHAIR));
  paintTable(g, cell(AI.TABLE));
  paintStove(g, cell(AI.STOVE));

  // row 2 -----------------------------------------------------------------
  paintFireplace(g, cell(AI.FIREPLACE));
  paintBookshelf(g, cell(AI.BOOKSHELF));
  paintChest(g, cell(AI.CHEST));
  paintPlant(g, cell(AI.PLANT));
  paintRug(g, cell(AI.RUG_A), "a");
  paintRug(g, cell(AI.RUG_B), "b");
  paintLadder(g, cell(AI.LADDER));
  paintAir(g, cell(AI.SPARE));

  g.generateTexture(TILES_ATLAS_KEY, width, height);
  g.destroy();
}

type Cell = { x: number; y: number };

// ─── tile painters ─────────────────────────────────────────────────────────

function paintAir(g: Phaser.GameObjects.Graphics, c: Cell): void {
  g.fillStyle(0x000000, 0);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
}

function paintCeiling(g: Phaser.GameObjects.Graphics, c: Cell): void {
  g.fillStyle(P.ceilingBeam, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // wood grain lines
  g.fillStyle(P.ceilingGrain, 1);
  g.fillRect(c.x + 2, c.y + 3, 12, 1);
  g.fillRect(c.x + 4, c.y + 9, 10, 1);
  // bottom shadow (where ceiling meets open air)
  g.fillStyle(P.ceilingDark, 1);
  g.fillRect(c.x, c.y + 13, TILE_SIZE, 3);
  g.fillStyle(0x000000, 0.45);
  g.fillRect(c.x, c.y + 15, TILE_SIZE, 1);
}

function paintWall(g: Phaser.GameObjects.Graphics, c: Cell): void {
  // side stone — darker at edges so the wall "rounds" slightly
  g.fillStyle(P.wallBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  g.fillStyle(P.wallShadow, 1);
  g.fillRect(c.x, c.y, 2, TILE_SIZE);
  g.fillRect(c.x + 14, c.y, 2, TILE_SIZE);
  g.fillStyle(P.wallHighlight, 1);
  g.fillRect(c.x + 2, c.y, 12, 1);
  // brick seams
  g.fillStyle(P.wallShadow, 1);
  g.fillRect(c.x + 2, c.y + 5, 12, 1);
  g.fillRect(c.x + 2, c.y + 11, 12, 1);
  g.fillRect(c.x + 7, c.y, 1, 5);
  g.fillRect(c.x + 5, c.y + 6, 1, 5);
  g.fillRect(c.x + 9, c.y + 12, 1, 4);
  g.fillStyle(P.wallSeam, 1);
  g.fillRect(c.x + 4, c.y + 8, 1, 1);
  g.fillRect(c.x + 10, c.y + 3, 1, 1);
}

function paintFloor(
  g: Phaser.GameObjects.Graphics,
  c: Cell,
  variant: "a" | "b",
): void {
  g.fillStyle(P.floorBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // strong top edge highlight so sprites clearly "stand" on this row
  g.fillStyle(P.floorTopEdge, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, 1);
  g.fillStyle(P.floorHighlight, 1);
  g.fillRect(c.x, c.y + 1, TILE_SIZE, 1);
  // plank seams
  g.fillStyle(P.floorGrain, 1);
  g.fillRect(c.x, c.y + 7, TILE_SIZE, 1);
  g.fillRect(c.x, c.y + 15, TILE_SIZE, 1);
  // subtle grain
  g.fillStyle(P.floorShadow, 1);
  g.fillRect(c.x + 2, c.y + 4, 5, 1);
  g.fillRect(c.x + 10, c.y + 11, 4, 1);
  if (variant === "b") {
    g.fillStyle(P.floorShadow, 1);
    g.fillRect(c.x + 5, c.y + 10, 2, 1);
    g.fillStyle(P.floorHighlight, 1);
    g.fillRect(c.x + 11, c.y + 5, 3, 1);
  }
}

function paintBackground(
  g: Phaser.GameObjects.Graphics,
  c: Cell,
  variant: "a" | "b",
): void {
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  g.fillStyle(P.bgHighlight, 1);
  if (variant === "a") {
    // vertical stripes suggesting wallpaper columns
    for (let x = 1; x < TILE_SIZE; x += 4) {
      g.fillRect(c.x + x, c.y, 1, TILE_SIZE);
    }
  } else {
    // dot pattern
    g.fillStyle(P.bgWeave, 1);
    for (let y = 2; y < TILE_SIZE; y += 4) {
      for (let x = 2; x < TILE_SIZE; x += 4) {
        g.fillRect(c.x + x, c.y + y, 1, 1);
      }
    }
    g.fillStyle(P.bgHighlight, 1);
    for (let y = 4; y < TILE_SIZE; y += 4) {
      for (let x = 4; x < TILE_SIZE; x += 4) {
        g.fillRect(c.x + x, c.y + y, 1, 1);
      }
    }
  }
}

function paintDoor(g: Phaser.GameObjects.Graphics, c: Cell): void {
  // doorway — fills the whole cell. Goes at feet-row so no wall cap above.
  g.fillStyle(P.doorTrim, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  g.fillStyle(P.doorBase, 1);
  g.fillRect(c.x + 1, c.y + 1, TILE_SIZE - 2, TILE_SIZE - 1);
  // vertical plank lines
  g.fillStyle(P.doorPlank, 1);
  g.fillRect(c.x + 5, c.y + 1, 1, TILE_SIZE - 1);
  g.fillRect(c.x + 10, c.y + 1, 1, TILE_SIZE - 1);
  // horizontal battens
  g.fillRect(c.x + 1, c.y + 4, TILE_SIZE - 2, 1);
  g.fillRect(c.x + 1, c.y + 12, TILE_SIZE - 2, 1);
  // brass knob
  g.fillStyle(P.doorKnob, 1);
  g.fillRect(c.x + 12, c.y + 8, 2, 2);
  g.fillStyle(P.doorTrim, 1);
  g.fillRect(c.x + 12, c.y + 10, 2, 1);
}

function paintWindow(g: Phaser.GameObjects.Graphics, c: Cell): void {
  // sits on background_wall — paint the bg first
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // frame
  g.fillStyle(P.windowFrame, 1);
  g.fillRect(c.x + 1, c.y + 2, 14, 12);
  // pane
  g.fillStyle(P.windowPane, 1);
  g.fillRect(c.x + 2, c.y + 3, 12, 10);
  // sky highlight
  g.fillStyle(P.windowPaneLight, 1);
  g.fillRect(c.x + 2, c.y + 3, 5, 4);
  g.fillRect(c.x + 2, c.y + 7, 2, 2);
  // muntin cross
  g.fillStyle(P.windowFrame, 1);
  g.fillRect(c.x + 7, c.y + 3, 2, 10);
  g.fillRect(c.x + 2, c.y + 7, 12, 2);
  // sill
  g.fillStyle(P.wallShadow, 1);
  g.fillRect(c.x + 1, c.y + 14, 14, 1);
  g.fillStyle(P.floorHighlight, 1);
  g.fillRect(c.x + 1, c.y + 13, 14, 1);
}

function paintTorch(g: Phaser.GameObjects.Graphics, c: Cell): void {
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // mount bracket
  g.fillStyle(P.torchMount, 1);
  g.fillRect(c.x + 7, c.y + 6, 2, 6);
  g.fillRect(c.x + 6, c.y + 10, 4, 2);
  // stem
  g.fillStyle(P.torchStem, 1);
  g.fillRect(c.x + 7, c.y + 4, 2, 3);
  // flame
  g.fillStyle(P.torchHalo, 0.5);
  g.fillRect(c.x + 5, c.y + 1, 6, 5);
  g.fillStyle(P.torchFlame, 1);
  g.fillRect(c.x + 6, c.y + 2, 4, 3);
  g.fillStyle(P.torchFlameCore, 1);
  g.fillRect(c.x + 7, c.y + 3, 2, 2);
  // halo on wall
  g.fillStyle(P.torchHalo, 0.25);
  g.fillRect(c.x + 3, c.y + 4, 10, 8);
}

function paintPainting(g: Phaser.GameObjects.Graphics, c: Cell): void {
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // frame
  g.fillStyle(P.paintFrame, 1);
  g.fillRect(c.x + 2, c.y + 3, 12, 10);
  g.fillStyle(P.paintFrameDark, 1);
  g.fillRect(c.x + 2, c.y + 12, 12, 1);
  g.fillRect(c.x + 2, c.y + 3, 1, 10);
  // canvas
  g.fillStyle(P.paintCanvas, 1);
  g.fillRect(c.x + 3, c.y + 4, 10, 8);
  // abstract scene
  g.fillStyle(P.paintShapeA, 1);
  g.fillRect(c.x + 3, c.y + 4, 10, 3); // sky
  g.fillStyle(P.paintShapeB, 1);
  g.fillRect(c.x + 5, c.y + 9, 6, 3); // ground
  g.fillStyle(P.paintFrameDark, 1);
  g.fillRect(c.x + 8, c.y + 7, 1, 3); // tree?
}

function paintBedHalf(
  g: Phaser.GameObjects.Graphics,
  c: Cell,
  which: "left" | "right",
): void {
  // background wallpaper behind
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // mattress
  g.fillStyle(P.bedFrame, 1);
  g.fillRect(c.x, c.y + 6, TILE_SIZE, 8);
  g.fillStyle(P.bedSheet, 1);
  g.fillRect(c.x, c.y + 7, TILE_SIZE, 6);
  // end-board (headboard on left half, footboard on right half)
  g.fillStyle(P.bedFrame, 1);
  if (which === "left") {
    g.fillRect(c.x + 1, c.y + 2, 3, 12);
    // pillow
    g.fillStyle(P.bedPillow, 1);
    g.fillRect(c.x + 5, c.y + 8, 6, 4);
    g.fillStyle(P.bedFrame, 1);
    g.fillRect(c.x + 5, c.y + 7, 6, 1);
  } else {
    g.fillRect(c.x + 12, c.y + 4, 3, 10);
    // blanket fold
    g.fillStyle(P.bedBlanket, 1);
    g.fillRect(c.x, c.y + 8, 12, 5);
    g.fillStyle(P.bedFrame, 1);
    g.fillRect(c.x, c.y + 8, 12, 1);
  }
  // underside shadow
  g.fillStyle(P.bedFrame, 1);
  g.fillRect(c.x, c.y + 13, TILE_SIZE, 1);
  g.fillStyle(P.floorShadow, 1);
  g.fillRect(c.x, c.y + 14, TILE_SIZE, 1);
}

function paintChair(g: Phaser.GameObjects.Graphics, c: Cell): void {
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // back
  g.fillStyle(P.chairBack, 1);
  g.fillRect(c.x + 3, c.y + 3, 3, 9);
  g.fillRect(c.x + 3, c.y + 3, 7, 2); // top cap
  // seat
  g.fillStyle(P.chairSeat, 1);
  g.fillRect(c.x + 3, c.y + 9, 9, 3);
  g.fillStyle(P.floorHighlight, 1);
  g.fillRect(c.x + 3, c.y + 9, 9, 1);
  // legs
  g.fillStyle(P.tableLeg, 1);
  g.fillRect(c.x + 3, c.y + 12, 2, 3);
  g.fillRect(c.x + 10, c.y + 12, 2, 3);
  // floor shadow
  g.fillStyle(P.floorShadow, 1);
  g.fillRect(c.x + 3, c.y + 15, 9, 1);
}

function paintTable(g: Phaser.GameObjects.Graphics, c: Cell): void {
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // top
  g.fillStyle(P.tableTop, 1);
  g.fillRect(c.x + 1, c.y + 6, 14, 3);
  g.fillStyle(P.floorHighlight, 1);
  g.fillRect(c.x + 1, c.y + 6, 14, 1);
  g.fillStyle(P.tableLeg, 1);
  g.fillRect(c.x + 1, c.y + 9, 14, 1);
  // legs
  g.fillStyle(P.tableLeg, 1);
  g.fillRect(c.x + 2, c.y + 9, 2, 6);
  g.fillRect(c.x + 12, c.y + 9, 2, 6);
  // floor shadow
  g.fillStyle(P.floorShadow, 1);
  g.fillRect(c.x + 1, c.y + 15, 14, 1);
}

function paintStove(g: Phaser.GameObjects.Graphics, c: Cell): void {
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // chimney
  g.fillStyle(P.stoveBase, 1);
  g.fillRect(c.x + 7, c.y, 3, 4);
  // body
  g.fillStyle(P.stoveBody, 1);
  g.fillRect(c.x + 2, c.y + 4, 12, 11);
  // top plate
  g.fillStyle(P.stoveBase, 1);
  g.fillRect(c.x + 2, c.y + 4, 12, 2);
  // firebox door
  g.fillStyle(P.stoveBase, 1);
  g.fillRect(c.x + 4, c.y + 8, 8, 5);
  // fire glow
  g.fillStyle(P.stoveGlow, 1);
  g.fillRect(c.x + 5, c.y + 9, 6, 3);
  g.fillStyle(P.stoveHot, 1);
  g.fillRect(c.x + 6, c.y + 10, 4, 2);
  // base shadow
  g.fillStyle(P.floorShadow, 1);
  g.fillRect(c.x + 2, c.y + 15, 12, 1);
}

function paintFireplace(g: Phaser.GameObjects.Graphics, c: Cell): void {
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // stone surround
  g.fillStyle(P.hearthStone, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  g.fillStyle(P.hearthStoneLight, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, 2);
  g.fillRect(c.x, c.y + 1, 2, TILE_SIZE - 1);
  g.fillRect(c.x + 14, c.y + 1, 2, TILE_SIZE - 1);
  // fire opening
  g.fillStyle(P.hearthCoal, 1);
  g.fillRect(c.x + 3, c.y + 5, 10, 10);
  // glow
  g.fillStyle(P.hearthGlow, 1);
  g.fillRect(c.x + 4, c.y + 7, 8, 7);
  g.fillStyle(P.hearthCoreBright, 1);
  g.fillRect(c.x + 6, c.y + 9, 4, 4);
  // licks of flame
  g.fillStyle(P.hearthGlow, 1);
  g.fillRect(c.x + 7, c.y + 5, 2, 3);
  g.fillRect(c.x + 8, c.y + 4, 1, 1);
  // mantle highlight
  g.fillStyle(P.floorHighlight, 1);
  g.fillRect(c.x + 2, c.y + 3, 12, 1);
}

function paintBookshelf(g: Phaser.GameObjects.Graphics, c: Cell): void {
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // frame
  g.fillStyle(P.shelfFrame, 1);
  g.fillRect(c.x + 1, c.y, 14, TILE_SIZE);
  g.fillStyle(P.shelfBoard, 1);
  g.fillRect(c.x + 2, c.y + 1, 12, 14);
  // shelves
  g.fillStyle(P.shelfFrame, 1);
  g.fillRect(c.x + 2, c.y + 5, 12, 1);
  g.fillRect(c.x + 2, c.y + 10, 12, 1);
  // books row 1
  g.fillStyle(P.book1, 1);
  g.fillRect(c.x + 2, c.y + 1, 2, 4);
  g.fillStyle(P.book2, 1);
  g.fillRect(c.x + 4, c.y + 2, 2, 3);
  g.fillStyle(P.book3, 1);
  g.fillRect(c.x + 6, c.y + 1, 2, 4);
  g.fillStyle(P.book4, 1);
  g.fillRect(c.x + 8, c.y + 2, 2, 3);
  g.fillStyle(P.book5, 1);
  g.fillRect(c.x + 10, c.y + 1, 3, 4);
  // books row 2
  g.fillStyle(P.book4, 1);
  g.fillRect(c.x + 2, c.y + 6, 3, 4);
  g.fillStyle(P.book2, 1);
  g.fillRect(c.x + 5, c.y + 7, 2, 3);
  g.fillStyle(P.book1, 1);
  g.fillRect(c.x + 7, c.y + 6, 2, 4);
  g.fillStyle(P.book3, 1);
  g.fillRect(c.x + 9, c.y + 7, 4, 3);
  // books row 3
  g.fillStyle(P.book5, 1);
  g.fillRect(c.x + 2, c.y + 11, 2, 4);
  g.fillStyle(P.book2, 1);
  g.fillRect(c.x + 4, c.y + 12, 2, 3);
  g.fillStyle(P.book3, 1);
  g.fillRect(c.x + 6, c.y + 11, 3, 4);
  g.fillStyle(P.book1, 1);
  g.fillRect(c.x + 9, c.y + 12, 4, 3);
  // floor shadow
  g.fillStyle(P.floorShadow, 1);
  g.fillRect(c.x + 1, c.y + 15, 14, 1);
}

function paintChest(g: Phaser.GameObjects.Graphics, c: Cell): void {
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // body
  g.fillStyle(P.chestBody, 1);
  g.fillRect(c.x + 1, c.y + 7, 14, 8);
  g.fillStyle(P.chestDark, 1);
  g.fillRect(c.x + 1, c.y + 7, 14, 1);
  g.fillRect(c.x + 1, c.y + 14, 14, 1);
  // lid
  g.fillStyle(P.chestBody, 1);
  g.fillRect(c.x + 1, c.y + 5, 14, 3);
  g.fillStyle(P.chestDark, 1);
  g.fillRect(c.x + 1, c.y + 5, 14, 1);
  g.fillRect(c.x + 1, c.y + 7, 14, 1);
  // iron bands
  g.fillStyle(P.chestBand, 1);
  g.fillRect(c.x + 3, c.y + 5, 1, 10);
  g.fillRect(c.x + 12, c.y + 5, 1, 10);
  // lock
  g.fillStyle(P.chestLock, 1);
  g.fillRect(c.x + 7, c.y + 8, 2, 3);
  g.fillStyle(P.chestDark, 1);
  g.fillRect(c.x + 7, c.y + 9, 2, 1);
  // shadow
  g.fillStyle(P.floorShadow, 1);
  g.fillRect(c.x + 1, c.y + 15, 14, 1);
}

function paintPlant(g: Phaser.GameObjects.Graphics, c: Cell): void {
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // pot
  g.fillStyle(P.plantPot, 1);
  g.fillRect(c.x + 4, c.y + 10, 8, 5);
  g.fillStyle(P.plantPotDark, 1);
  g.fillRect(c.x + 4, c.y + 10, 8, 1);
  g.fillRect(c.x + 4, c.y + 14, 8, 1);
  // leaves
  g.fillStyle(P.plantLeaf, 1);
  g.fillRect(c.x + 5, c.y + 4, 6, 6);
  g.fillRect(c.x + 3, c.y + 5, 3, 4);
  g.fillRect(c.x + 10, c.y + 5, 3, 4);
  g.fillRect(c.x + 6, c.y + 2, 4, 3);
  g.fillStyle(P.plantLeafDark, 1);
  g.fillRect(c.x + 4, c.y + 6, 1, 3);
  g.fillRect(c.x + 11, c.y + 6, 1, 3);
  g.fillRect(c.x + 7, c.y + 7, 2, 2);
  // shadow
  g.fillStyle(P.floorShadow, 1);
  g.fillRect(c.x + 4, c.y + 15, 8, 1);
}

function paintRug(
  g: Phaser.GameObjects.Graphics,
  c: Cell,
  variant: "a" | "b",
): void {
  // rug sits on the floor, so the tile shows the rug covering most of the
  // cell vertically — a strip at the bottom with the floor top-edge peeking
  g.fillStyle(0x000000, 0);
  g.fillRect(c.x, c.y, TILE_SIZE, 10);
  // rug body (lower half of the tile)
  g.fillStyle(P.rugBase, 1);
  g.fillRect(c.x, c.y + 10, TILE_SIZE, 6);
  g.fillStyle(P.rugWeave, 1);
  if (variant === "a") {
    g.fillRect(c.x + 2, c.y + 11, 1, 4);
    g.fillRect(c.x + 6, c.y + 11, 1, 4);
    g.fillRect(c.x + 10, c.y + 11, 1, 4);
    g.fillRect(c.x + 14, c.y + 11, 1, 4);
  } else {
    g.fillRect(c.x + 2, c.y + 12, 12, 1);
    g.fillRect(c.x + 2, c.y + 14, 12, 1);
  }
  // trim
  g.fillStyle(P.rugTrim, 1);
  g.fillRect(c.x, c.y + 10, TILE_SIZE, 1);
  g.fillRect(c.x, c.y + 15, TILE_SIZE, 1);
}

function paintLadder(g: Phaser.GameObjects.Graphics, c: Cell): void {
  g.fillStyle(P.bgBase, 1);
  g.fillRect(c.x, c.y, TILE_SIZE, TILE_SIZE);
  // rails
  g.fillStyle(P.ladderBase, 1);
  g.fillRect(c.x + 3, c.y, 2, TILE_SIZE);
  g.fillRect(c.x + 11, c.y, 2, TILE_SIZE);
  g.fillStyle(P.ladderLight, 1);
  g.fillRect(c.x + 3, c.y, 1, TILE_SIZE);
  g.fillRect(c.x + 11, c.y, 1, TILE_SIZE);
  // rungs
  g.fillStyle(P.ladderBase, 1);
  for (let y = 2; y < TILE_SIZE; y += 4) {
    g.fillRect(c.x + 5, c.y + y, 6, 1);
    g.fillStyle(P.ladderLight, 1);
    g.fillRect(c.x + 5, c.y + y - 1, 6, 1);
    g.fillStyle(P.ladderBase, 1);
  }
}

// ─── public tile-index resolvers ──────────────────────────────────────────

function hash2(x: number, y: number): number {
  let h = (x * 73856093) ^ (y * 19349663);
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return h >>> 0;
}

export function floorVariant(x: number, y: number): number {
  return hash2(x, y) % 3 === 0 ? AI.FLOOR_B : AI.FLOOR_A;
}

export function backgroundVariant(x: number, y: number): number {
  return (x + y) % 4 === 0 ? AI.BG_B : AI.BG_A;
}

export function rugVariant(x: number, y: number): number {
  return (x + y) % 2 === 0 ? AI.RUG_A : AI.RUG_B;
}

/**
 * Resolve a semantic tile key to an atlas index. For multi-tile props
 * that split across cells (beds), this uses neighbor inspection to pick
 * the correct half.
 */
export function resolveAtlasIndex(
  key: string,
  x: number,
  y: number,
  ground: string[][],
): number {
  switch (key) {
    case "air":
      return -1;
    case "ceiling":
      return AI.CEILING;
    case "wall":
      return AI.WALL;
    case "floor":
      return floorVariant(x, y);
    case "background_wall":
      return backgroundVariant(x, y);
    case "door":
      return AI.DOOR;
    case "window":
      return AI.WINDOW;
    case "torch":
      return AI.TORCH;
    case "painting":
      return AI.PAINTING;
    case "bed": {
      // left half = pillow end; right half = blanket end. Choose based on
      // whether the neighbor to the right is also bed.
      const rightIsBed = ground[y]?.[x + 1] === "bed";
      return rightIsBed ? AI.BED_LEFT : AI.BED_RIGHT;
    }
    case "chair":
      return AI.CHAIR;
    case "table":
      return AI.TABLE;
    case "stove":
      return AI.STOVE;
    case "fireplace":
      return AI.FIREPLACE;
    case "bookshelf":
      return AI.BOOKSHELF;
    case "chest":
      return AI.CHEST;
    case "plant":
      return AI.PLANT;
    case "rug":
      return rugVariant(x, y);
    case "ladder":
      return AI.LADDER;
    default:
      return -1;
  }
}

/**
 * Indices that Phaser's internal tilemap collision should ignore. Real
 * pathfinding runs against the worker's collision grid, so this is only
 * relevant if arcade physics debug is enabled.
 */
export const NON_COLLIDING_INDICES = [
  -1,
  AI.AIR,
  AI.FLOOR_A,
  AI.FLOOR_B,
  AI.BG_A,
  AI.BG_B,
  AI.DOOR,
  AI.WINDOW,
  AI.TORCH,
  AI.PAINTING,
  AI.RUG_A,
  AI.RUG_B,
  AI.LADDER,
  AI.SPARE,
];
