/**
 * Daily-plan / clock shapes used by scene prompts.
 *
 * Temporarily duplicates the definitions in app/shared/protocol.ts so the
 * agent package compiles without a cross-package import. Step 6 of the
 * migration collapses the duplication by having protocol.ts re-export
 * these types from here.
 */

export interface ScheduleSlot {
  hour: number;
  activity: string;
  mood?: string;
}

export interface NpcDay {
  name: string;
  backstory: string;
  palette: string;
  objective: string;
  motive: string;
  schedule: ScheduleSlot[];
}

export interface DailyPlan {
  date: string;
  dayOfWeek: string;
  playerObjective: string;
  npcs: NpcDay[];
  openingHour: number;
  closingHour: number;
  seed: string;
}

export interface RunClock {
  gameHour: number;
  gameMinute: number;
  runStartedAt: number;
  softWarnedAt?: number;
}
