/**
 * Scene-agent dispatcher.
 *
 * The Hearth DO's alarm() handler calls dispatchDueAgents() and that is the
 * whole dispatcher — there is no central tick loop, no per-kind cadence
 * config, no metronome. Each agent owns its own nextWakeAt.
 *
 * Behavior lives in agent prompts, never here. The dispatcher knows nothing
 * about what NPCs or directors actually do — it just runs whoever says
 * they're due, persists their new self-chosen nextWakeAt, and re-arms the
 * alarm. If every registered agent says "wake me in 10 minutes," the room
 * goes quiet for 10 minutes. That is correct.
 */

import type {
  DailyPlan,
  Difficulty,
  NpcDay,
  RunClock,
} from "../../shared/protocol.ts";
import type { HearthEnv } from "./hearth.ts";

export const STORAGE_AGENTS = "scene-agents";
export const STORAGE_EVENT_BUS = "scene-event-bus";
const EVENT_BUS_LIMIT = 30;
export const SPAWN_ACTION_TYPE = "spawn";

export interface SceneAction {
  type: string;
  text?: string;
  /** Free-form anchor name; canonical anchors come from the room. */
  position?: string;
  payload?: unknown;
}

export interface ThinkResult {
  action: SceneAction | null;
  nextWakeAt: number;
  reason: string;
}

export interface SceneAgentState {
  id: string;
  kind: string;
  nextWakeAt: number;
  lastThinkAt: number | null;
  lastReason: string | null;
  data?: Record<string, unknown>;
}

/**
 * Rolling tail of agent decisions, kept in DO storage. Each agent reads
 * the recent slice on think() so it can react to what others just did.
 * Bounded; the dispatcher trims after each append.
 */
export interface SceneEvent {
  at: number;
  agentId: string;
  reason: string;
  action: SceneAction | null;
}

export interface ThinkContext {
  now: number;
  agent: SceneAgentState;
  env: HearthEnv;
  /** Broadcast a message to every socket in the room, auto-tagged with this agent's id. */
  emit: (msg: Record<string, unknown>) => void;
  recentEvents: SceneEvent[];
  dailyPlan: DailyPlan | null;
  clock: RunClock | null;
  /** Free-form anchor names available in this room (passed from the DO). */
  anchors: string[];
  /** The room's authored prompt — what the room IS. */
  roomPrompt: string;
  /** Phase 5 — tourist/resident/native. Agents soften or tighten on this. */
  difficulty: Difficulty;
}

export interface SceneAgentImpl {
  kind: string;
  think(ctx: ThinkContext): Promise<ThinkResult>;
}

const IMPLS = new Map<string, SceneAgentImpl>();

export function registerAgentKind(impl: SceneAgentImpl): void {
  IMPLS.set(impl.kind, impl);
}

/**
 * Hearth supplies this so the dispatcher can ask "the spawning agent
 * decided to invite a new NPC — is the room willing to admit one?"
 * The implementation owns parsing the persona, enforcing the per-day
 * cap, mutating the daily plan, and persisting. It returns the seed
 * the dispatcher should add to the agent registry, or null if the
 * spawn was rejected (cap hit, malformed payload, etc).
 */
export interface SpawnedNpcSeed {
  agentId: string;
  npc: NpcDay;
  /** Agent state to insert into the registry; nextWakeAt picks when it first thinks. */
  state: SceneAgentState;
}

export interface DispatcherCtx {
  now: number;
  storage: DurableObjectStorage;
  env: HearthEnv;
  broadcast: (msg: Record<string, unknown>) => void;
  dailyPlan: DailyPlan | null;
  clock: RunClock | null;
  anchors: string[];
  roomPrompt: string;
  difficulty: Difficulty;
  /**
   * Invoked when an agent's decided action is `{type: "spawn"}`. Returns
   * the new agent seed when admitted, or null when rejected. The
   * dispatcher then persists the new agent and broadcasts `npc-spawned`.
   */
  onSpawn?: (
    spawningAgentId: string,
    action: SceneAction,
    now: number,
  ) => Promise<SpawnedNpcSeed | null>;
}

/**
 * Run any agents whose nextWakeAt <= now, persist their new self-chosen
 * nextWakeAt, and return the new minimum nextWakeAt across all agents
 * so the caller can re-arm the DO alarm. Returns null if no agents are
 * registered (alarm should not be re-armed in that case).
 */
export async function dispatchDueAgents(
  ctx: DispatcherCtx,
): Promise<number | null> {
  const agents =
    (await ctx.storage.get<Record<string, SceneAgentState>>(STORAGE_AGENTS)) ??
    {};
  const eventBus =
    (await ctx.storage.get<SceneEvent[]>(STORAGE_EVENT_BUS)) ?? [];
  const due = Object.values(agents).filter((a) => a.nextWakeAt <= ctx.now);

  if (due.length > 0) {
    console.log(
      `[scene-agents] dispatching: ${JSON.stringify(due.map((a) => a.id))}`,
    );
  }

  for (const agent of due) {
    const impl = IMPLS.get(agent.kind);
    if (!impl) {
      console.warn(
        `[scene-agents] no impl for kind '${agent.kind}' (agent ${agent.id}); backing off 60s`,
      );
      agent.nextWakeAt = ctx.now + 60_000;
      continue;
    }
    const emit = (msg: Record<string, unknown>) =>
      ctx.broadcast({ ...msg, agentId: agent.id });
    try {
      const result = await impl.think({
        now: ctx.now,
        agent,
        env: ctx.env,
        emit,
        recentEvents: eventBus,
        dailyPlan: ctx.dailyPlan,
        clock: ctx.clock,
        anchors: ctx.anchors,
        roomPrompt: ctx.roomPrompt,
        difficulty: ctx.difficulty,
      });
      agent.nextWakeAt = result.nextWakeAt;
      agent.lastThinkAt = ctx.now;
      agent.lastReason = result.reason;
      eventBus.push({
        at: ctx.now,
        agentId: agent.id,
        reason: result.reason,
        action: result.action,
      });
      while (eventBus.length > EVENT_BUS_LIMIT) eventBus.shift();
      ctx.broadcast({
        type: "agent-decided",
        agentId: agent.id,
        action: result.action,
        nextWakeAt: result.nextWakeAt,
        reason: result.reason,
      });
      const cadenceSec = Math.max(0, Math.round((result.nextWakeAt - ctx.now) / 1000));
      const actionStr = result.action
        ? `${result.action.type}${result.action.text ? `: "${result.action.text}"` : ""}`
        : "null";
      console.log(
        `[scene-agents] decided ${agent.id} | action=${actionStr} | next=+${cadenceSec}s | reason="${result.reason}"`,
      );

      if (
        result.action &&
        result.action.type === SPAWN_ACTION_TYPE &&
        ctx.onSpawn
      ) {
        try {
          const seed = await ctx.onSpawn(agent.id, result.action, ctx.now);
          if (seed) {
            agents[seed.agentId] = seed.state;
            ctx.broadcast({
              type: "npc-spawned",
              agentId: seed.agentId,
              spawnedBy: agent.id,
              npc: seed.npc,
            });
            console.log(
              `[scene-agents] spawned ${seed.agentId} via ${agent.id}`,
            );
          } else {
            console.log(
              `[scene-agents] spawn from ${agent.id} rejected (cap or malformed)`,
            );
          }
        } catch (spawnErr) {
          console.error(
            `[scene-agents] onSpawn for ${agent.id} threw:`,
            spawnErr,
          );
        }
      }
    } catch (err) {
      console.error(`[scene-agents] agent '${agent.id}' think failed:`, err);
      agent.nextWakeAt = ctx.now + 60_000;
    }
  }

  await ctx.storage.put(STORAGE_AGENTS, agents);
  await ctx.storage.put(STORAGE_EVENT_BUS, eventBus);

  const all = Object.values(agents);
  if (all.length === 0) return null;
  return Math.min(...all.map((a) => a.nextWakeAt));
}
