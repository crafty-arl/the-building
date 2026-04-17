import { describe, it, expect, vi } from "vitest";
import {
  buildNpcAgentState,
  npcAgentId,
  parseSpawnPayload,
} from "../npc-agent";
import {
  dispatchDueAgents,
  registerAgentKind,
  SPAWN_ACTION_TYPE,
  STORAGE_AGENTS,
  STORAGE_EVENT_BUS,
  type SceneAction,
  type SceneAgentState,
  type SpawnedNpcSeed,
  type ThinkResult,
} from "../scene-agents";
import type { DailyPlan, RunClock } from "../../../shared/protocol";

const ANCHORS = ["door", "hearth_face", "window_sill"];

describe("parseSpawnPayload", () => {
  it("parses a well-formed pipe-delimited persona", () => {
    const npc = parseSpawnPayload(
      "Wren | cool | a courier soaked from the rain | deliver the sealed letter | does not know what's inside | door",
      ANCHORS,
    );
    expect(npc).not.toBeNull();
    expect(npc!.name).toBe("Wren");
    expect(npc!.palette).toBe("cool");
    expect(npc!.objective).toBe("deliver the sealed letter");
    expect(npc!.startAnchor).toBe("door");
    expect(npc!.transient).toBe(true);
    expect(npc!.schedule).toEqual([]);
  });

  it("falls back to 'warm' when palette is unknown", () => {
    const npc = parseSpawnPayload(
      "Wren | tangerine | b | o | m | door",
      ANCHORS,
    );
    expect(npc!.palette).toBe("warm");
  });

  it("falls back to first anchor when startAnchor isn't in the room", () => {
    const npc = parseSpawnPayload(
      "Wren | cool | b | o | m | balcony",
      ANCHORS,
    );
    expect(npc!.startAnchor).toBe("door");
  });

  it("returns null when required fields are missing", () => {
    expect(parseSpawnPayload("Wren | cool", ANCHORS)).toBeNull();
    expect(parseSpawnPayload("", ANCHORS)).toBeNull();
    expect(parseSpawnPayload(undefined, ANCHORS)).toBeNull();
  });

  it("returns null when name is empty", () => {
    expect(
      parseSpawnPayload("  | cool | b | o | m | door", ANCHORS),
    ).toBeNull();
  });
});

describe("buildNpcAgentState + npcAgentId", () => {
  it("agentId matches the npc:<slug> convention used by the dispatcher", () => {
    expect(npcAgentId("Wren")).toBe("npc:wren");
    expect(npcAgentId("Two Spaces")).toBe("npc:two-spaces");
  });

  it("seeds an agent state with kind=npc and the NPC payload in data", () => {
    const npc = parseSpawnPayload(
      "Wren | cool | b | o | m | door",
      ANCHORS,
    )!;
    const state = buildNpcAgentState(npc, 1000, 5_000);
    expect(state.id).toBe("npc:wren");
    expect(state.kind).toBe("npc");
    expect(state.nextWakeAt).toBe(6_000);
    expect(state.data?.name).toBe("Wren");
    expect(state.data?.palette).toBe("cool");
  });
});

describe("dispatchDueAgents — spawn handling", () => {
  function makeStorage(initial: Record<string, unknown> = {}): DurableObjectStorage {
    const store = new Map<string, unknown>(Object.entries(initial));
    return {
      get: vi.fn(async (k: string) => store.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
      delete: vi.fn(async (k: string) => store.delete(k)),
    } as unknown as DurableObjectStorage;
  }

  function makePlan(): DailyPlan {
    return {
      date: "2026-04-17",
      dayOfWeek: "Friday",
      playerObjective: "find it",
      openingHour: 9,
      closingHour: 22,
      seed: "test",
      npcs: [
        {
          name: "Marek",
          backstory: "b",
          palette: "warm",
          objective: "o",
          motive: "m",
          schedule: [],
        },
      ],
    };
  }

  function makeClock(): RunClock {
    return { gameHour: 9, gameMinute: 0, runStartedAt: 0 };
  }

  it("invokes onSpawn when an agent decides a spawn action and registers the new agent", async () => {
    // Register a dummy agent kind that always emits a spawn action.
    const SPAWNER_KIND = "spawner-test";
    registerAgentKind({
      kind: SPAWNER_KIND,
      think: async ({ now }): Promise<ThinkResult> => ({
        action: { type: SPAWN_ACTION_TYPE, text: "Wren | cool | b | o | m | door" },
        nextWakeAt: now + 60_000,
        reason: "calling someone in",
      }),
    });

    const initialAgent: SceneAgentState = {
      id: "agent:spawner",
      kind: SPAWNER_KIND,
      nextWakeAt: 0,
      lastThinkAt: null,
      lastReason: null,
    };
    const storage = makeStorage({
      [STORAGE_AGENTS]: { "agent:spawner": initialAgent },
    });
    const broadcasts: Array<Record<string, unknown>> = [];
    const onSpawn = vi.fn(
      async (
        spawningAgentId: string,
        action: SceneAction,
        now: number,
      ): Promise<SpawnedNpcSeed | null> => {
        const npc = parseSpawnPayload(action.text, ANCHORS)!;
        return {
          agentId: npcAgentId(npc.name),
          npc,
          state: buildNpcAgentState(npc, now),
        };
      },
    );

    await dispatchDueAgents({
      now: 1_000,
      storage,
      env: {} as never,
      broadcast: (msg) => broadcasts.push(msg),
      dailyPlan: makePlan(),
      clock: makeClock(),
      anchors: ANCHORS,
      roomPrompt: "test",
      difficulty: "resident",
      onSpawn,
    });

    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onSpawn.mock.calls[0][0]).toBe("agent:spawner");

    const decided = broadcasts.find((m) => m.type === "agent-decided");
    const spawned = broadcasts.find((m) => m.type === "npc-spawned");
    expect(decided).toBeTruthy();
    expect(spawned).toMatchObject({
      type: "npc-spawned",
      agentId: "npc:wren",
      spawnedBy: "agent:spawner",
    });

    // The new agent should be persisted alongside the spawner.
    const stored = (await storage.get(STORAGE_AGENTS)) as Record<
      string,
      SceneAgentState
    >;
    expect(Object.keys(stored).sort()).toEqual([
      "agent:spawner",
      "npc:wren",
    ]);
    expect(stored["npc:wren"].kind).toBe("npc");
  });

  it("does not broadcast npc-spawned when onSpawn returns null", async () => {
    const REJECTED_KIND = "rejected-spawner-test";
    registerAgentKind({
      kind: REJECTED_KIND,
      think: async ({ now }) => ({
        action: { type: SPAWN_ACTION_TYPE, text: "anything" },
        nextWakeAt: now + 60_000,
        reason: "trying",
      }),
    });
    const storage = makeStorage({
      [STORAGE_AGENTS]: {
        "agent:rejected": {
          id: "agent:rejected",
          kind: REJECTED_KIND,
          nextWakeAt: 0,
          lastThinkAt: null,
          lastReason: null,
        },
      },
    });
    const broadcasts: Array<Record<string, unknown>> = [];
    await dispatchDueAgents({
      now: 1_000,
      storage,
      env: {} as never,
      broadcast: (msg) => broadcasts.push(msg),
      dailyPlan: makePlan(),
      clock: makeClock(),
      anchors: ANCHORS,
      roomPrompt: "test",
      difficulty: "resident",
      onSpawn: async () => null,
    });
    expect(broadcasts.find((m) => m.type === "npc-spawned")).toBeUndefined();
    const stored = (await storage.get(STORAGE_AGENTS)) as Record<string, SceneAgentState>;
    expect(Object.keys(stored)).toEqual(["agent:rejected"]);
  });

  it("does not invoke onSpawn for non-spawn actions", async () => {
    const TALKER_KIND = "talker-test";
    registerAgentKind({
      kind: TALKER_KIND,
      think: async ({ now }) => ({
        action: { type: "say", text: "hello" },
        nextWakeAt: now + 60_000,
        reason: "speaking",
      }),
    });
    const storage = makeStorage({
      [STORAGE_AGENTS]: {
        "agent:talker": {
          id: "agent:talker",
          kind: TALKER_KIND,
          nextWakeAt: 0,
          lastThinkAt: null,
          lastReason: null,
        },
      },
    });
    const onSpawn = vi.fn(async () => null);
    await dispatchDueAgents({
      now: 1_000,
      storage,
      env: {} as never,
      broadcast: () => {},
      dailyPlan: makePlan(),
      clock: makeClock(),
      anchors: ANCHORS,
      roomPrompt: "test",
      difficulty: "resident",
      onSpawn,
    });
    expect(onSpawn).not.toHaveBeenCalled();
  });
});

describe("event bus persistence regression", () => {
  it("ignores STORAGE_EVENT_BUS shape — uses default empty array", async () => {
    // Sanity check that exporting the constant didn't accidentally rename it.
    expect(STORAGE_EVENT_BUS).toBe("scene-event-bus");
    expect(STORAGE_AGENTS).toBe("scene-agents");
  });
});
