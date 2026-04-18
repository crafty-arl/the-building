import * as Phaser from "phaser";
import { TILE_SIZE, tileToWorld } from "./tilemap";
import type { Pathfinder } from "./pathfinder";
import type { Waypoint } from "./types";

/**
 * 8-bit layered character sprites. Each NPC is built from a palette
 * triple (skin + cloak + accent) drawn over a dedicated shadow sprite.
 * The public surface (`buildNpcSprite`, `walkSpriteTo`, `showBubble`) is
 * unchanged from v1 so the rest of the scene doesn't need to care how
 * the pixels are produced.
 */

interface CharacterPalette {
  skin: number;
  hair: number;
  cloak: number;
  cloakDark: number;
  accent: number;
  leg: number;
  boot: number;
}

const PALETTES: Record<string, CharacterPalette> = {
  warm: {
    skin: 0xe8d0a8,
    hair: 0x3d2415,
    cloak: 0xc86a3d,
    cloakDark: 0x8a3f22,
    accent: 0xe8b45a,
    leg: 0x3d2415,
    boot: 0x1f130a,
  },
  cool: {
    skin: 0xd8b89a,
    hair: 0x1f2838,
    cloak: 0x4d7aa0,
    cloakDark: 0x2a4a6a,
    accent: 0x8ab0c8,
    leg: 0x2a3858,
    boot: 0x141a28,
  },
  moss: {
    skin: 0xd8c4a4,
    hair: 0x2a1f14,
    cloak: 0x5f8a52,
    cloakDark: 0x3d5a32,
    accent: 0xb8d088,
    leg: 0x2e4228,
    boot: 0x141a10,
  },
  rust: {
    skin: 0xd8b098,
    hair: 0x2a1208,
    cloak: 0x963d1e,
    cloakDark: 0x5a200c,
    accent: 0xe8a868,
    leg: 0x3d1810,
    boot: 0x1a0a08,
  },
  ash: {
    skin: 0xd8c8b8,
    hair: 0x1a1a1a,
    cloak: 0x7a7a7a,
    cloakDark: 0x4a4a4a,
    accent: 0xb8b8b8,
    leg: 0x3a3a3a,
    boot: 0x141414,
  },
  bone: {
    skin: 0xf0e0c0,
    hair: 0x7a6848,
    cloak: 0xd6c9a8,
    cloakDark: 0x8a7858,
    accent: 0xe8dcb4,
    leg: 0x7a6a4a,
    boot: 0x3a2f1f,
  },
  midnight: {
    skin: 0xc8b498,
    hair: 0x0a0a12,
    cloak: 0x2a3858,
    cloakDark: 0x141a2c,
    accent: 0x8ab0c8,
    leg: 0x141a2c,
    boot: 0x08080f,
  },
  red: {
    skin: 0xe8c8a8,
    hair: 0x2a0808,
    cloak: 0xbf3333,
    cloakDark: 0x6a1818,
    accent: 0xf0a060,
    leg: 0x4a0f0f,
    boot: 0x1f0808,
  },
  grey: {
    skin: 0xc8c8c8,
    hair: 0x303030,
    cloak: 0x888888,
    cloakDark: 0x555555,
    accent: 0xc0c0c0,
    leg: 0x383838,
    boot: 0x141414,
  },
};

const DEFAULT_PALETTE = PALETTES.warm;

const NPC_TEXTURE_PREFIX = "npc-v2-";
const SHADOW_TEXTURE_KEY = "npc-shadow-v1";

const MS_PER_TILE = 220;

function textureKey(palette: string): string {
  return `${NPC_TEXTURE_PREFIX}${palette}`;
}

function resolvePalette(palette: string): CharacterPalette {
  return PALETTES[palette] ?? DEFAULT_PALETTE;
}

function drawCharacter(
  g: Phaser.GameObjects.Graphics,
  p: CharacterPalette,
): void {
  // layout fits centered in a 16x16 tile, bottom-anchored so the feet
  // touch y=15. Head 6 wide at cols 5-10, shoulders widen to cols 3-12.
  // outline (1px dark underlay so the figure reads on busy floors)
  g.fillStyle(p.boot, 1);
  g.fillRect(4, 1, 8, 8); // head silhouette
  g.fillRect(2, 8, 12, 6); // torso silhouette
  g.fillRect(3, 13, 10, 3); // legs silhouette

  // hair
  g.fillStyle(p.hair, 1);
  g.fillRect(5, 1, 6, 2);
  g.fillRect(4, 2, 8, 2);
  g.fillRect(4, 4, 1, 3); // left side-locks
  g.fillRect(11, 4, 1, 3); // right side-locks

  // face (skin)
  g.fillStyle(p.skin, 1);
  g.fillRect(5, 4, 6, 4);
  g.fillRect(6, 8, 4, 1); // chin

  // eyes
  g.fillStyle(0x1a1408, 1);
  g.fillRect(6, 6, 1, 1);
  g.fillRect(9, 6, 1, 1);

  // cheek blush (accent, subtle — 1px each side on warm palettes only
  // is fine for all since accent is always warm-leaning)
  g.fillStyle(p.accent, 0.5);
  g.fillRect(5, 7, 1, 1);
  g.fillRect(10, 7, 1, 1);

  // cloak / torso
  g.fillStyle(p.cloak, 1);
  g.fillRect(3, 9, 10, 4);
  // shoulder highlight
  g.fillStyle(p.accent, 1);
  g.fillRect(3, 9, 10, 1);
  // side shadow
  g.fillStyle(p.cloakDark, 1);
  g.fillRect(3, 12, 10, 1);
  g.fillRect(12, 9, 1, 4);

  // belt (accent)
  g.fillStyle(p.accent, 1);
  g.fillRect(4, 11, 8, 1);
  g.fillStyle(p.boot, 1);
  g.fillRect(7, 11, 2, 1); // buckle

  // arms (sleeves at sides)
  g.fillStyle(p.cloakDark, 1);
  g.fillRect(2, 10, 1, 3);
  g.fillRect(13, 10, 1, 3);
  g.fillStyle(p.skin, 1);
  g.fillRect(2, 12, 1, 1);
  g.fillRect(13, 12, 1, 1);

  // legs
  g.fillStyle(p.leg, 1);
  g.fillRect(4, 13, 3, 2);
  g.fillRect(9, 13, 3, 2);
  // leg seam
  g.fillStyle(p.boot, 1);
  g.fillRect(7, 13, 2, 2);

  // boots
  g.fillStyle(p.boot, 1);
  g.fillRect(4, 15, 3, 1);
  g.fillRect(9, 15, 3, 1);
}

export function ensureNpcTexture(scene: Phaser.Scene, palette: string): string {
  const key = textureKey(palette);
  if (scene.textures.exists(key)) return key;
  const p = resolvePalette(palette);
  const g = scene.add.graphics({ x: 0, y: 0 });
  drawCharacter(g, p);
  g.generateTexture(key, TILE_SIZE, TILE_SIZE);
  g.destroy();
  return key;
}

function ensureShadowTexture(scene: Phaser.Scene): string {
  if (scene.textures.exists(SHADOW_TEXTURE_KEY)) return SHADOW_TEXTURE_KEY;
  const g = scene.add.graphics({ x: 0, y: 0 });
  g.fillStyle(0x000000, 0.35);
  g.fillRect(3, 13, 10, 1);
  g.fillRect(2, 14, 12, 1);
  g.fillRect(3, 15, 10, 1);
  g.generateTexture(SHADOW_TEXTURE_KEY, TILE_SIZE, TILE_SIZE);
  g.destroy();
  return SHADOW_TEXTURE_KEY;
}

export interface NpcSprite {
  agentId: string;
  displayName: string;
  sprite: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  bubble: Phaser.GameObjects.Text | null;
  bubbleHideAt: number;
  tileX: number;
  tileY: number;
  busy: boolean;
}

export function buildNpcSprite(
  scene: Phaser.Scene,
  opts: {
    agentId: string;
    displayName: string;
    palette: string;
    tileX: number;
    tileY: number;
  },
): NpcSprite {
  const spriteKey = ensureNpcTexture(scene, opts.palette);
  const shadowKey = ensureShadowTexture(scene);
  const world = tileToWorld(opts.tileX, opts.tileY);
  const shadow = scene.add.image(world.x, world.y + 1, shadowKey).setDepth(9);
  const sprite = scene.add.image(world.x, world.y, spriteKey).setDepth(10);
  const label = scene.add
    .text(world.x, world.y - TILE_SIZE, opts.displayName, {
      fontFamily: "ui-monospace, monospace",
      fontSize: "9px",
      color: "#f5efdd",
      stroke: "#14100c",
      strokeThickness: 3,
      align: "center",
    })
    .setOrigin(0.5, 1)
    .setDepth(11);
  return {
    agentId: opts.agentId,
    displayName: opts.displayName,
    sprite,
    shadow,
    label,
    bubble: null,
    bubbleHideAt: 0,
    tileX: opts.tileX,
    tileY: opts.tileY,
    busy: false,
  };
}

export function destroyNpcSprite(npc: NpcSprite): void {
  npc.sprite.destroy();
  npc.shadow.destroy();
  npc.label.destroy();
  npc.bubble?.destroy();
  npc.bubble = null;
}

const BUBBLE_STYLE_BASE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: "ui-monospace, monospace",
  fontSize: "10px",
  color: "#1a140d",
  backgroundColor: "#f5efdd",
  padding: { left: 4, right: 4, top: 2, bottom: 2 },
  align: "center",
  wordWrap: { width: TILE_SIZE * 6 },
};

const BUBBLE_STYLE_DO: Phaser.Types.GameObjects.Text.TextStyle = {
  ...BUBBLE_STYLE_BASE,
  color: "#d4a574",
  backgroundColor: "#1a140d",
  fontStyle: "italic",
};

const BUBBLE_STYLE_MOVE: Phaser.Types.GameObjects.Text.TextStyle = {
  ...BUBBLE_STYLE_BASE,
  color: "#8ab0c8",
  backgroundColor: "#0e1520",
  fontStyle: "italic",
};

export type BubbleKind = "say" | "do" | "move";

export function showBubble(
  scene: Phaser.Scene,
  npc: NpcSprite,
  kind: BubbleKind,
  text: string,
  ttlMs: number,
): void {
  const display = kind === "say" ? `"${text}"` : text;
  const style =
    kind === "say"
      ? BUBBLE_STYLE_BASE
      : kind === "do"
        ? BUBBLE_STYLE_DO
        : BUBBLE_STYLE_MOVE;
  if (npc.bubble) {
    npc.bubble.setStyle(style);
    npc.bubble.setText(display);
  } else {
    npc.bubble = scene.add
      .text(npc.sprite.x, npc.sprite.y - TILE_SIZE - 8, display, style)
      .setOrigin(0.5, 1)
      .setDepth(12);
  }
  npc.bubble.setPosition(npc.sprite.x, npc.sprite.y - TILE_SIZE - 8);
  npc.bubbleHideAt = scene.time.now + ttlMs;
}

export function tickBubbles(scene: Phaser.Scene, npcs: Iterable<NpcSprite>): void {
  const now = scene.time.now;
  for (const npc of npcs) {
    // keep shadow + label glued to sprite regardless of tween progress
    npc.shadow.setPosition(npc.sprite.x, npc.sprite.y + 1);
    npc.label.setPosition(npc.sprite.x, npc.sprite.y - TILE_SIZE);
    if (!npc.bubble) continue;
    npc.bubble.setPosition(npc.sprite.x, npc.sprite.y - TILE_SIZE - 8);
    if (now >= npc.bubbleHideAt) {
      npc.bubble.destroy();
      npc.bubble = null;
    }
  }
}

/**
 * Walk the sprite from its current tile to (tx, ty) along the pathfinder's
 * shortest path. Resolves when the last tween finishes. Cancels any tween
 * already in flight on this sprite.
 */
export async function walkSpriteTo(
  scene: Phaser.Scene,
  npc: NpcSprite,
  pathfinder: Pathfinder,
  tx: number,
  ty: number,
): Promise<void> {
  if (npc.tileX === tx && npc.tileY === ty) return;
  const path = await pathfinder.findPath(
    { x: npc.tileX, y: npc.tileY },
    { x: tx, y: ty },
  );
  if (!path || path.length <= 1) return;
  scene.tweens.killTweensOf([npc.sprite]);
  npc.busy = true;
  for (let i = 1; i < path.length; i++) {
    const step = path[i];
    const world = tileToWorld(step.x, step.y);
    const flip = step.x < npc.tileX;
    npc.sprite.setFlipX(flip);
    await new Promise<void>((resolve) => {
      scene.tweens.add({
        targets: npc.sprite,
        x: world.x,
        y: world.y,
        duration: MS_PER_TILE,
        ease: "Linear",
        onComplete: () => resolve(),
      });
    });
    npc.tileX = step.x;
    npc.tileY = step.y;
  }
  npc.busy = false;
}

export function placeSpriteAt(npc: NpcSprite, tile: Waypoint): void {
  const world = tileToWorld(tile.x, tile.y);
  npc.sprite.setPosition(world.x, world.y);
  npc.shadow.setPosition(world.x, world.y + 1);
  npc.label.setPosition(world.x, world.y - TILE_SIZE);
  npc.tileX = tile.x;
  npc.tileY = tile.y;
}
