/**
 * Helpers to project server-side state onto the wire format defined in
 * shared/protocol.ts. Server holds full Message arrays per entry; the wire
 * format only carries concatenated assistant text.
 */

import type {
  SceneWire,
  TreeEntryWire,
  TreeSnapshot,
} from "../../shared/protocol.ts";
import { type AssistantMessage, assistantText } from "./messages.ts";
import type { Scene } from "./scene.ts";
import type { Entry, SessionTree } from "./tree.ts";

export function entryToWire(e: Entry): TreeEntryWire {
  const asst = e.messages.find((m) => m.role === "assistant") as
    | AssistantMessage
    | undefined;
  const text = asst ? assistantText(asst) : "";
  const wire: TreeEntryWire = {
    id: e.id,
    parentId: e.parentId,
    timestamp: e.timestamp,
    text,
  };
  if (e.card) wire.card = e.card;
  if (e.label !== undefined) wire.label = e.label;
  if (e.usage)
    wire.usage = {
      input: e.usage.input,
      output: e.usage.output,
      cost: e.usage.cost.total,
      ...(e.usage.cacheRead !== undefined ? { cacheRead: e.usage.cacheRead } : {}),
    };
  return wire;
}

export function treeToWire(tree: SessionTree): TreeSnapshot {
  const facts: Record<string, string> = {};
  for (const [k, v] of tree.getFacts()) facts[k] = v;
  return {
    entries: tree.all().map(entryToWire),
    leafId: tree.getLeafId(),
    facts,
    vows: [...tree.getVows()],
  };
}

export function sceneToWire(scene: Scene): SceneWire {
  const wire: SceneWire = {
    id: scene.id,
    location: scene.location,
    timeOfDay: scene.timeOfDay,
    moods: scene.moods,
    npcs: scene.npcs,
    anchors: scene.anchors,
  };
  if (scene.tilemap) wire.tilemap = scene.tilemap;
  if (typeof scene.floorY === "number") wire.floorY = scene.floorY;
  if (scene.anchorCoords) wire.anchorCoords = scene.anchorCoords;
  if (scene.palette) wire.palette = scene.palette;
  if (scene.source) wire.source = scene.source;
  return wire;
}
