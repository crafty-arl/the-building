import { describe, it, expect } from "vitest";
import {
  DIRECTOR_AGENT_ID,
  DIRECTOR_KIND,
  parseDirectorDecision,
  seedDirectorAgent,
} from "../director-agent";
import type { SceneAgentState } from "../scene-agents";

describe("parseDirectorDecision", () => {
  it("accepts a well-formed decision with a whitelisted action type", () => {
    const text = `
      The player just spoke; Marek should glance at the door.
      {"action":{"type":"complication","text":"Wind rattles the shutters."},"nextWakeInSeconds":45,"reason":"answering the player's line"}
    `;
    const now = 1_000_000;
    const out = parseDirectorDecision(text, now);
    expect(out.action).toEqual({
      type: "complication",
      text: "Wind rattles the shutters.",
    });
    expect(out.nextWakeAt).toBe(now + 45_000);
    expect(out.reason).toBe("answering the player's line");
  });

  it("accepts null action", () => {
    const text = `{"action":null,"nextWakeInSeconds":90,"reason":"scene breathes"}`;
    const out = parseDirectorDecision(text, 0);
    expect(out.action).toBeNull();
    expect(out.nextWakeAt).toBe(90_000);
  });

  it("rejects unknown action types (NPC-style 'say' is not a director beat)", () => {
    const text = `{"action":{"type":"say","text":"hello"},"nextWakeInSeconds":30,"reason":"x"}`;
    const out = parseDirectorDecision(text, 0);
    expect(out.action).toBeNull();
  });

  it("accepts all four director beat types", () => {
    for (const type of ["complication", "revelation", "pace-shift", "force-beat"]) {
      const text = `{"action":{"type":"${type}","text":"t"},"nextWakeInSeconds":30,"reason":"r"}`;
      const out = parseDirectorDecision(text, 0);
      expect(out.action?.type).toBe(type);
    }
  });

  it("clamps cadence to [5, 600] seconds", () => {
    const hi = parseDirectorDecision(
      `{"action":null,"nextWakeInSeconds":9999,"reason":"r"}`,
      0,
    );
    expect(hi.nextWakeAt).toBe(600_000);
    const lo = parseDirectorDecision(
      `{"action":null,"nextWakeInSeconds":1,"reason":"r"}`,
      0,
    );
    expect(lo.nextWakeAt).toBe(5_000);
  });

  it("falls back safely on malformed JSON", () => {
    const out = parseDirectorDecision("not json at all", 100);
    expect(out.action).toBeNull();
    expect(out.reason).toBe("(no reason returned)");
    expect(out.nextWakeAt).toBeGreaterThan(100);
  });

  it("strips action.text over 400 chars", () => {
    const long = "x".repeat(600);
    const text = `{"action":{"type":"complication","text":"${long}"},"nextWakeInSeconds":30,"reason":"r"}`;
    const out = parseDirectorDecision(text, 0);
    expect(out.action?.text?.length).toBe(400);
  });
});

describe("seedDirectorAgent", () => {
  it("seeds a director when the registry is empty", () => {
    const agents: Record<string, SceneAgentState> = {};
    seedDirectorAgent(agents, 1_000);
    expect(agents[DIRECTOR_AGENT_ID]).toBeDefined();
    expect(agents[DIRECTOR_AGENT_ID].kind).toBe(DIRECTOR_KIND);
    expect(agents[DIRECTOR_AGENT_ID].nextWakeAt).toBe(11_000);
    expect(agents[DIRECTOR_AGENT_ID].data?.archetypeId).toBe("weaver");
  });

  it("is idempotent — does not overwrite an existing director", () => {
    const agents: Record<string, SceneAgentState> = {
      [DIRECTOR_AGENT_ID]: {
        id: DIRECTOR_AGENT_ID,
        kind: DIRECTOR_KIND,
        nextWakeAt: 42,
        lastThinkAt: 5,
        lastReason: "previous",
        data: { archetypeId: "scribe" },
      },
    };
    seedDirectorAgent(agents, 9_999);
    expect(agents[DIRECTOR_AGENT_ID].nextWakeAt).toBe(42);
    expect(agents[DIRECTOR_AGENT_ID].lastReason).toBe("previous");
    expect(agents[DIRECTOR_AGENT_ID].data?.archetypeId).toBe("scribe");
  });

  it("coexists alongside NPC agents in the same registry", () => {
    const agents: Record<string, SceneAgentState> = {
      "npc:marek": {
        id: "npc:marek",
        kind: "npc",
        nextWakeAt: 0,
        lastThinkAt: null,
        lastReason: null,
      },
    };
    seedDirectorAgent(agents, 0);
    expect(Object.keys(agents).sort()).toEqual([
      DIRECTOR_AGENT_ID,
      "npc:marek",
    ]);
  });
});
