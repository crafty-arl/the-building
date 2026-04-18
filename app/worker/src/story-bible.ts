/**
 * Story-bible generator. For each fresh DailyPlan we author one 3-act
 * bible that the director + NPCs improvise inside. The bible is the only
 * load-bearing "plot" state we keep on the server; agents read it every
 * dispatch so pacing converges on the act's pressure instead of drifting.
 */

import type {
  DailyPlan,
  StoryAct,
  StoryBible,
} from "../../shared/protocol.ts";
import { parseAiResponse } from "./ai-util.ts";

interface AiBinding {
  run(model: string, options: unknown): Promise<unknown>;
}

const STORY_BIBLE_SYSTEM = `You are a story editor laying out a 3-act bible for one day inside a single small room.

You are given today's plan (the NPCs with objectives/motives, the room premise, the player objective, the seed). Write a 3-act arc that sits on top of that plan and gives the director + NPCs a shared target.

Voice rule (IMPORTANT): Plain words. Concrete images. Short sentences. Name the pressures, don't describe them abstractly. Good: "someone outside wants in and won't leave". Bad: "a liminal threshold of yearning".

Return STRICT JSON only, no preamble, no markdown:
{
  "logline": "one sentence — what the whole day is about",
  "theme": "one or two words — the feeling",
  "acts": [
    {
      "name": "Act I — <short thematic label>",
      "premise": "one sentence — what is true at the start of this act",
      "pressure": "one sentence — the force pushing every character in this act",
      "beats": ["3 to 5 short lines, each a concrete beat we want to see land"],
      "exit": "one sentence — what must become true for this act to close"
    },
    { Act II same shape },
    { Act III same shape }
  ]
}

Rules:
- Exactly 3 acts.
- Act I opens with the established normal; Act II introduces disturbance; Act III resolves or fractures.
- Every beat must be something observable in the room (an action, a sound, a gesture) — not an internal feeling.
- Use the NPCs' actual names and the room's actual anchors where possible.
- Do not restate the player objective; frame pressures that make each NPC want to act.`;

interface RawAct {
  name?: unknown;
  premise?: unknown;
  pressure?: unknown;
  beats?: unknown;
  exit?: unknown;
}

interface RawBible {
  logline?: unknown;
  theme?: unknown;
  acts?: unknown;
}

function coerceAct(raw: RawAct | null | undefined): StoryAct | null {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim()
    : null;
  const premise = typeof raw.premise === "string" && raw.premise.trim()
    ? raw.premise.trim()
    : null;
  const pressure = typeof raw.pressure === "string" && raw.pressure.trim()
    ? raw.pressure.trim()
    : null;
  const exit = typeof raw.exit === "string" && raw.exit.trim()
    ? raw.exit.trim()
    : null;
  if (!name || !premise || !pressure || !exit) return null;
  const beats: string[] = Array.isArray(raw.beats)
    ? raw.beats
        .map((b) => (typeof b === "string" ? b.trim() : ""))
        .filter((b) => b.length > 0)
        .slice(0, 5)
    : [];
  if (beats.length < 2) return null;
  return { name, premise, pressure, beats, exit };
}

function coerceBible(raw: unknown): StoryBible | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawBible;
  const logline = typeof r.logline === "string" && r.logline.trim()
    ? r.logline.trim()
    : null;
  const theme = typeof r.theme === "string" && r.theme.trim()
    ? r.theme.trim()
    : null;
  if (!logline || !theme) return null;
  if (!Array.isArray(r.acts) || r.acts.length < 3) return null;
  const acts = r.acts
    .slice(0, 3)
    .map((a) => coerceAct(a as RawAct))
    .filter((a): a is StoryAct => a !== null);
  if (acts.length !== 3) return null;
  return { logline, theme, acts };
}

function fallbackBible(plan: DailyPlan, roomPrompt: string): StoryBible {
  const names = plan.npcs.slice(0, 2).map((n) => n.name).join(" and ") ||
    "the residents";
  const premise = roomPrompt.trim() || "a quiet room";
  return {
    logline: `${names} keep ${premise} turning until the night finds its shape.`,
    theme: "quiet unease",
    acts: [
      {
        name: "Act I — The room holds",
        premise: `${names} move through their small chores in ${premise}.`,
        pressure: "Something ordinary is about to be tested.",
        beats: [
          `${names.split(" and ")[0]} does their first small task of the day.`,
          "A small detail in the room goes wrong.",
          "Someone hears a sound from outside and does not say so.",
        ],
        exit: "The ordinary is broken by an event no one can ignore.",
      },
      {
        name: "Act II — The knock repeats",
        premise: "The disturbance will not leave on its own.",
        pressure:
          "Someone outside the room wants in, or something inside wants out.",
        beats: [
          "A character takes a risk they would not take yesterday.",
          "Two characters argue without raising their voices.",
          "The disturbance escalates once more.",
        ],
        exit:
          "A character makes a choice that cannot be taken back.",
      },
      {
        name: "Act III — The door decides",
        premise: "The choice was made. Now the room rearranges itself.",
        pressure: "The night ends one way and not the other.",
        beats: [
          "The loudest character becomes the quietest.",
          "A small kindness lands between two people.",
          "The room holds a new quiet that is not the same as the old quiet.",
        ],
        exit:
          "The day's last act settles; tomorrow will remember this one.",
      },
    ],
  };
}

export async function generateStoryBible(
  env: { AI: AiBinding },
  plan: DailyPlan,
  roomPrompt: string,
  anchors: string[],
): Promise<StoryBible> {
  const roster = plan.npcs
    .map(
      (n) =>
        `- ${n.name} (${n.palette}): ${n.objective} — motive: ${n.motive}`,
    )
    .join("\n");
  const anchorLine = anchors.length > 0
    ? `Named positions in the room: ${anchors.join(", ")}.`
    : `Named positions in the room: door, fire, bar, table, window, stairs.`;
  const userPrompt = [
    `Room premise: ${roomPrompt.trim() || "a quiet small room"}.`,
    anchorLine,
    `Day: ${plan.dayOfWeek}, ${plan.date}.`,
    `Seed: ${plan.seed}`,
    `Player objective (do not restate — this is the Claw's goal over several visits): ${plan.playerObjective}`,
    `Residents:\n${roster}`,
    `Write the 3-act bible for this day. Return STRICT JSON only.`,
  ].join("\n");

  try {
    const ai = (await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: STORY_BIBLE_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 1800,
      temperature: 0.75,
    } as never)) as unknown;
    const parsed = parseAiResponse(ai);
    const bible = coerceBible(parsed);
    if (bible) return bible;
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        ev: "ai",
        stage: "story-bible:unparseable",
        sample: JSON.stringify(ai ?? null).slice(0, 400),
      }),
    );
  } catch (e) {
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        ev: "ai",
        stage: "story-bible:exception",
        error: String(e),
      }),
    );
  }
  return fallbackBible(plan, roomPrompt);
}
