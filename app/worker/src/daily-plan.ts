/**
 * Daily-plan generator — authors a DailyPlan (schedule of NPC activity +
 * a player objective) for a given UTC date. Uses the same llama-3.3-70b
 * model as the rest of the worker, with a fallback canned plan when
 * generation fails.
 */

import type { DailyPlan, NpcDay, ScheduleSlot } from "../../shared/protocol.ts";
import { parseAiResponse } from "./ai-util.ts";

const DAY_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function dayOfWeekName(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  return DAY_OF_WEEK[d.getUTCDay()] ?? "Thursday";
}

const OPENING_HOUR = 7;
const CLOSING_HOUR = 22;

const DAILY_PLAN_SYSTEM = `You author one day inside a single small fictional room — a quiet inn / tavern / lodging at the edge of a kingdom that no longer keeps its records.

Output is a plan for that day: a short player objective, 2 or 3 residents with hour-by-hour schedules, and a one-line flavor seed.

Voice rule (IMPORTANT): Plain words a 5th-grader can read. Concrete images. Short sentences. Activities are things you can see happen in a room (not abstractions). Good: "sweeps ash from the hearth", "writes a letter they will not send". Bad: "contemplates their existence".

Return STRICT JSON only, no preamble, no markdown:
{
  "playerObjective": "one sentence, what the Claw is trying to accomplish today across 2-4 visits",
  "npcs": [
    {
      "name": "1-2 words, invented",
      "backstory": "1-2 short sentences of what they carry into today",
      "palette": "warm|cool|moss|rust|ash|bone",
      "objective": "one sentence, what they want today",
      "motive": "one sentence, the private why underneath",
      "schedule": [
        {"hour": 7, "activity": "...", "mood": "..."},
        ...one entry for every integer hour 7..22 inclusive, in order...
      ]
    }
  ],
  "seed": "one-line flavor note for today (weather, mood, a smell)"
}

Rules:
- Exactly 16 schedule entries per npc, hours 7 through 22 inclusive, strictly ordered.
- 2 or 3 npcs.
- Palettes must differ between npcs.
- Activities are concrete, observable. Use the real NPC names in prose elsewhere; schedule entries name the activity only.
- playerObjective must be achievable across several short visits, not a single exchange.`;

interface RawPlan {
  playerObjective?: unknown;
  npcs?: unknown;
  seed?: unknown;
}

interface RawNpc {
  name?: unknown;
  backstory?: unknown;
  palette?: unknown;
  objective?: unknown;
  motive?: unknown;
  schedule?: unknown;
}

interface RawSlot {
  hour?: unknown;
  activity?: unknown;
  mood?: unknown;
}

const PALETTES = ["warm", "cool", "moss", "rust", "ash", "bone"];

function coerceSlot(raw: unknown, expectedHour: number): ScheduleSlot {
  const s = (raw ?? {}) as RawSlot;
  const hour =
    typeof s.hour === "number" && Number.isFinite(s.hour)
      ? Math.round(s.hour)
      : expectedHour;
  const activity =
    typeof s.activity === "string" && s.activity.trim()
      ? s.activity.trim().slice(0, 120)
      : "waits in the room";
  const mood = typeof s.mood === "string" && s.mood.trim() ? s.mood.trim().slice(0, 40) : undefined;
  return { hour, activity, ...(mood ? { mood } : {}) };
}

function coerceSchedule(raw: unknown): ScheduleSlot[] {
  const arr = Array.isArray(raw) ? raw : [];
  const byHour = new Map<number, ScheduleSlot>();
  for (let i = 0; i < arr.length; i++) {
    const slot = coerceSlot(arr[i], OPENING_HOUR + i);
    byHour.set(slot.hour, slot);
  }
  const out: ScheduleSlot[] = [];
  let last: ScheduleSlot | null = null;
  for (let h = OPENING_HOUR; h <= CLOSING_HOUR; h++) {
    const slot = byHour.get(h);
    if (slot) {
      out.push(slot);
      last = slot;
    } else if (last) {
      out.push({ ...last, hour: h });
    } else {
      out.push({ hour: h, activity: "waits in the room" });
    }
  }
  return out;
}

function coerceNpc(raw: unknown, idx: number): NpcDay {
  const n = (raw ?? {}) as RawNpc;
  const name =
    typeof n.name === "string" && n.name.trim()
      ? n.name.trim().slice(0, 24)
      : `Resident ${idx + 1}`;
  const backstory =
    typeof n.backstory === "string" && n.backstory.trim()
      ? n.backstory.trim().slice(0, 240)
      : "Has been here longer than the floorboards remember.";
  const palette =
    typeof n.palette === "string" && PALETTES.includes(n.palette)
      ? n.palette
      : PALETTES[idx % PALETTES.length];
  const objective =
    typeof n.objective === "string" && n.objective.trim()
      ? n.objective.trim().slice(0, 160)
      : "Get through the day without being noticed.";
  const motive =
    typeof n.motive === "string" && n.motive.trim()
      ? n.motive.trim().slice(0, 160)
      : "Something owed that no one remembers clearly.";
  const schedule = coerceSchedule(n.schedule);
  return { name, backstory, palette, objective, motive, schedule };
}

function coercePlan(raw: unknown, dateIso: string, dayOfWeek: string): DailyPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawPlan;
  const playerObjective =
    typeof r.playerObjective === "string" && r.playerObjective.trim()
      ? r.playerObjective.trim().slice(0, 200)
      : null;
  const npcsRaw = Array.isArray(r.npcs) ? r.npcs : [];
  if (!playerObjective || npcsRaw.length < 1) return null;
  const npcs = npcsRaw.slice(0, 4).map(coerceNpc);
  const seed =
    typeof r.seed === "string" && r.seed.trim()
      ? r.seed.trim().slice(0, 160)
      : `${dayOfWeek} morning, rain quiet on the shutters.`;
  return {
    date: dateIso,
    dayOfWeek,
    playerObjective,
    npcs,
    openingHour: OPENING_HOUR,
    closingHour: CLOSING_HOUR,
    seed,
  };
}

function fallbackDailyPlan(dateIso: string, dayOfWeek: string): DailyPlan {
  const mkSchedule = (activities: string[]): ScheduleSlot[] => {
    const slots: ScheduleSlot[] = [];
    for (let h = OPENING_HOUR; h <= CLOSING_HOUR; h++) {
      const a = activities[(h - OPENING_HOUR) % activities.length];
      slots.push({ hour: h, activity: a });
    }
    return slots;
  };
  return {
    date: dateIso,
    dayOfWeek,
    playerObjective: "Find out why the lantern keeps swinging when the wind is down.",
    npcs: [
      {
        name: "Marek",
        backstory: "Has swept this floor since his father did. Something under it has begun to tap back.",
        palette: "warm",
        objective: "Keep the inn open one more night without telling anyone why.",
        motive: "A debt he cannot name out loud without giving it shape.",
        schedule: mkSchedule([
          "opens the shutters and lets the cold in",
          "sweeps ash from the hearth",
          "counts the coins in the till slowly",
          "stares at the door as if expecting someone",
        ]),
      },
      {
        name: "Idris",
        backstory: "Arrived three nights ago with a lantern that will not light.",
        palette: "ash",
        objective: "Wait for a reply that may not come.",
        motive: "Afraid to leave and afraid to stay.",
        schedule: mkSchedule([
          "sits by the window writing nothing",
          "rubs at the lantern's glass as if warming it",
          "drinks water and waits",
          "watches the door without moving",
        ]),
      },
    ],
    openingHour: OPENING_HOUR,
    closingHour: CLOSING_HOUR,
    seed: `${dayOfWeek} — the fire keeps its slow count, the rain does not.`,
  };
}

interface AiBinding {
  run(model: string, options: unknown): Promise<unknown>;
}

export async function generateDailyPlan(
  env: { AI: AiBinding },
  dateIso: string,
): Promise<DailyPlan> {
  const dayOfWeek = dayOfWeekName(dateIso);
  const userPrompt = [
    `Date: ${dateIso} (${dayOfWeek}).`,
    `Open hours: ${OPENING_HOUR}:00 — ${CLOSING_HOUR}:00.`,
    `Generate today's plan. Return STRICT JSON only.`,
  ].join("\n");

  try {
    const ai = (await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        { role: "system", content: DAILY_PLAN_SYSTEM },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.75,
    } as never)) as unknown;
    const parsed = parseAiResponse(ai);
    const plan = coercePlan(parsed, dateIso, dayOfWeek);
    if (plan) return plan;
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        ev: "ai",
        stage: "daily-plan:unparseable",
        sample: JSON.stringify(ai ?? null).slice(0, 400),
      }),
    );
  } catch (e) {
    console.warn(
      JSON.stringify({
        at: new Date().toISOString(),
        ev: "ai",
        stage: "daily-plan:exception",
        error: String(e),
      }),
    );
  }
  return fallbackDailyPlan(dateIso, dayOfWeek);
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function slotForHour(npc: NpcDay, hour: number): ScheduleSlot | null {
  if (npc.schedule.length === 0) return null;
  let pick: ScheduleSlot | null = null;
  for (const s of npc.schedule) {
    if (s.hour <= hour) pick = s;
    else break;
  }
  return pick ?? npc.schedule[0];
}

export function timeOfDayForHour(hour: number): "dawn" | "day" | "dusk" | "night" {
  if (hour < 10) return "dawn";
  if (hour < 17) return "day";
  if (hour < 20) return "dusk";
  return "night";
}
