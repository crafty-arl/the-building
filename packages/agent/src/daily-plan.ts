/**
 * Pure daily-plan helpers — date arithmetic and schedule lookup. No Node
 * deps, no LLM calls. The actual LLM-driven plan authoring lives in the
 * worker (app/worker/src/daily-plan-gen.ts) because it needs env.AI.
 */

import type { NpcDay, ScheduleSlot } from "./schedule-types.ts";

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
