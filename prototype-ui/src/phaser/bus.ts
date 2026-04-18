import * as Phaser from "phaser";

/**
 * Singleton event bridge between the React WebSocket layer and the long-lived
 * Phaser scene. `useHearth` emits here when it sees an agent-decided frame;
 * MapScene subscribes on boot and starts a tween. Phaser never polls state.
 */
export const bus = new Phaser.Events.EventEmitter();

export const BUS_EVENTS = {
  agentDecided: "agent-decided",
  agentThinking: "agent-thinking",
  npcSpawned: "npc-spawned",
  npcPositions: "npc-positions",
  sceneReady: "scene-ready",
  storyAdvanced: "story-advanced",
  directiveAccepted: "directive-accepted",
} as const;
