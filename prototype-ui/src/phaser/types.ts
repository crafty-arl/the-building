import type { SceneAgentAction } from "../../../app/shared/protocol";

export interface AgentDecidedEvt {
  agentId: string;
  action: SceneAgentAction | null;
  nextWakeAt: number;
}

export interface AgentThinkingEvt {
  agentId: string;
  delta: string;
}

export interface NpcSpawnedEvt {
  agentId: string;
  displayName: string;
  palette: string;
  startAnchor?: string;
}

export type RoomId = string;
export type AnchorId = string;

export interface Waypoint {
  x: number;
  y: number;
}
