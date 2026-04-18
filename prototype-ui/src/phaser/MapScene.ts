import * as Phaser from "phaser";
import type {
  NpcDay,
  ObjectWire,
  RoomWire,
  SceneAgentAction,
  SceneWire,
} from "../../../app/shared/protocol";
import { TILES_ATLAS_KEY } from "./assets";
import { BUS_EVENTS, bus } from "./bus";
import { buildPathfinder, type Pathfinder } from "./pathfinder";
import { ensureAtlasTexture } from "./procedural-tiles";
import {
  buildNpcSprite,
  destroyNpcSprite,
  showBubble,
  tickBubbles,
  type BubbleKind,
  type NpcSprite,
  walkSpriteTo,
} from "./sprites";
import { buildRoom, TILE_SIZE } from "./tilemap";
import type { AgentDecidedEvt } from "./types";

interface MapSceneData {
  scene: SceneWire;
  npcs: NpcDay[];
}

/**
 * Single long-lived Phaser scene. Lifecycle:
 *  - `loadScene(sceneWire, npcs)` called from React whenever a `hello` frame
 *    arrives — this rebuilds the tilemap + sprites from scratch.
 *  - Listens on the event bus for `agent-decided` frames and tweens the
 *    matching sprite along the EasyStar path.
 */
export class MapScene extends Phaser.Scene {
  private builtRoom: ReturnType<typeof buildRoom> | null = null;
  private pathfinder: Pathfinder | null = null;
  private npcByAgent = new Map<string, NpcSprite>();
  private anchorIndex = new Map<string, ObjectWire>();
  private roomPixelSize: { width: number; height: number } | null = null;
  private focusedAgentId: string | null = null;
  private focusEndsAt = 0;
  private lastCameraState: "room" | "focus" = "room";
  private decidedHandler = (evt: AgentDecidedEvt) => this.handleDecided(evt);
  private resizeHandler = () => this.fitCameraToRoom();

  constructor() {
    super({ key: "MapScene" });
  }

  preload(): void {
    // Atlas is painted procedurally; calling ensure here primes the
    // texture cache before the first scene applies.
    ensureAtlasTexture(this);
  }

  create(): void {
    this.cameras.main.setBackgroundColor("#141015");
    bus.on(BUS_EVENTS.agentDecided, this.decidedHandler);
    this.scale.on(Phaser.Scale.Events.RESIZE, this.resizeHandler);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      bus.off(BUS_EVENTS.agentDecided, this.decidedHandler);
      this.scale.off(Phaser.Scale.Events.RESIZE, this.resizeHandler);
    });
    bus.emit(BUS_EVENTS.sceneReady);
  }

  loadScene(sceneWire: SceneWire, npcs: NpcDay[]): void {
    if (!this.textures.exists(TILES_ATLAS_KEY)) {
      ensureAtlasTexture(this);
    }
    this.applyScene(sceneWire, npcs);
  }

  private applyScene(sceneWire: SceneWire, npcs: NpcDay[]): void {
    this.clearWorld();
    const rooms = sceneWire.rooms ?? [];
    if (rooms.length === 0) return;
    const room = rooms[0];
    this.builtRoom = buildRoom(this, room);
    this.pathfinder = buildPathfinder(room.ground);
    this.anchorIndex.clear();
    for (const obj of room.objects) this.anchorIndex.set(obj.name, obj);

    this.roomPixelSize = {
      width: room.cols * TILE_SIZE,
      height: room.rows * TILE_SIZE,
    };
    this.cameras.main.setBounds(
      0,
      0,
      this.roomPixelSize.width,
      this.roomPixelSize.height,
    );
    this.fitCameraToRoom();

    for (const npc of npcs) this.spawnNpc(npc, room);
  }

  private fitCameraToRoom(): void {
    if (!this.roomPixelSize) return;
    const zoom = this.computeRoomFitZoom();
    if (zoom <= 0) return;
    this.cameras.main.setZoom(zoom);
    this.cameras.main.centerOn(
      this.roomPixelSize.width / 2,
      this.roomPixelSize.height / 2,
    );
    this.lastCameraState = "room";
  }

  update(): void {
    tickBubbles(this, this.npcByAgent.values());
    this.updateCameraFocus();
  }

  private updateCameraFocus(): void {
    if (!this.roomPixelSize) return;
    const now = this.time.now;
    const hasFocus = this.focusedAgentId !== null && now < this.focusEndsAt;
    if (hasFocus) {
      const npc = this.npcByAgent.get(this.focusedAgentId ?? "");
      if (!npc) {
        this.focusedAgentId = null;
        return;
      }
      if (this.lastCameraState !== "focus") {
        this.lastCameraState = "focus";
        const cam = this.cameras.main;
        const roomFit = this.computeRoomFitZoom();
        const focusZoom = Math.min(4, Math.max(2, roomFit * 2.2));
        cam.pan(npc.sprite.x, npc.sprite.y, 650, "Sine.easeInOut", true);
        cam.zoomTo(focusZoom, 650, "Sine.easeInOut", true);
      } else {
        // Keep the camera following the sprite while focused; skip when
        // Phaser's pan tween is still running (avoid fighting it).
        const cam = this.cameras.main;
        if (!cam.panEffect.isRunning) {
          cam.centerOn(npc.sprite.x, npc.sprite.y);
        }
      }
    } else if (this.lastCameraState === "focus") {
      this.lastCameraState = "room";
      this.focusedAgentId = null;
      const cam = this.cameras.main;
      const roomFit = this.computeRoomFitZoom();
      cam.pan(
        this.roomPixelSize.width / 2,
        this.roomPixelSize.height / 2,
        750,
        "Sine.easeInOut",
        true,
      );
      cam.zoomTo(roomFit, 750, "Sine.easeInOut", true);
    }
  }

  private computeRoomFitZoom(): number {
    if (!this.roomPixelSize) return 1;
    const viewportW = this.scale.width;
    const viewportH = this.scale.height;
    if (viewportW <= 0 || viewportH <= 0) return 1;
    const zoomX = viewportW / this.roomPixelSize.width;
    const zoomY = viewportH / this.roomPixelSize.height;
    return Math.max(1, Math.min(zoomX, zoomY));
  }

  private clearWorld(): void {
    if (this.builtRoom) {
      this.builtRoom.tilemap.destroy();
      this.builtRoom = null;
    }
    for (const npc of this.npcByAgent.values()) {
      destroyNpcSprite(npc);
    }
    this.npcByAgent.clear();
    this.roomPixelSize = null;
  }

  private spawnNpc(npc: NpcDay, room: RoomWire): void {
    const agentId = `npc:${slugify(npc.name)}`;
    const anchorName = npc.startAnchor ?? room.objects[0]?.name;
    const anchor = anchorName ? this.anchorIndex.get(anchorName) : undefined;
    const tx = anchor?.x ?? Math.floor(room.cols / 2);
    const ty = anchor?.y ?? Math.floor(room.rows / 2);
    const sprite = buildNpcSprite(this, {
      agentId,
      displayName: npc.name,
      palette: npc.palette,
      tileX: tx,
      tileY: ty,
    });
    this.npcByAgent.set(agentId, sprite);
  }

  private handleDecided(evt: AgentDecidedEvt): void {
    if (evt.agentId === "director") return;
    const npc = this.npcByAgent.get(evt.agentId);
    if (!npc || !this.pathfinder) return;
    const action = evt.action;
    if (!action) return;
    const kind = normalizeBubbleKind(action.type);
    if (kind && action.text) {
      const ttl = bubbleTtlFor(kind);
      showBubble(this, npc, kind, action.text, ttl);
      this.focusedAgentId = evt.agentId;
      this.focusEndsAt = this.time.now + ttl + 400;
    }
    const target = resolvePosition(action, this.anchorIndex);
    if (!target) return;
    if (npc.busy) return; // in-flight tween owns the sprite until it lands
    void walkSpriteTo(this, npc, this.pathfinder, target.x, target.y);
  }
}

function normalizeBubbleKind(type: string | undefined): BubbleKind | null {
  if (type === "say" || type === "do" || type === "move") return type;
  return null;
}

function bubbleTtlFor(kind: BubbleKind): number {
  if (kind === "say") return 9000;
  if (kind === "do") return 6000;
  return 4000;
}

function resolvePosition(
  action: SceneAgentAction,
  anchors: Map<string, ObjectWire>,
): { x: number; y: number } | null {
  const pos = action.position;
  if (!pos) return null;
  // Multi-room form "<roomId>.<anchor>" — take the tail (single-room slice).
  const bare = pos.includes(".") ? (pos.split(".").at(-1) ?? pos) : pos;
  const obj = anchors.get(bare);
  if (!obj) return null;
  return { x: obj.x, y: obj.y };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type { MapSceneData };
