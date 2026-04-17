/**
 * Scene definitions. The TAVERN scene is authored; buildScene() overlays
 * today's DailyPlan + RunClock onto it so the system prompt sees the
 * current time of day and today's residents.
 *
 * Text is preserved byte-for-byte with app/worker/src/scene.ts so the Kimi
 * prefix cache stays warm across the migration.
 */

import type { DailyPlan, RunClock } from "./schedule-types.ts";
import { slotForHour, timeOfDayForHour } from "./daily-plan.ts";

export interface Scene {
  id: string;
  location: string;
  timeOfDay: "dawn" | "day" | "dusk" | "night";
  moods: string[];
  npcs: string[];
  hooks: string[];
  authoredPrompt: string;
}

export const TAVERN: Scene = {
  id: "001-the-tavern",
  location: "The Crooked Lantern",
  timeOfDay: "dusk",
  moods: ["somber", "wry"],
  npcs: ["the-stranger"],
  hooks: [
    "The fire is low. The innkeeper is elsewhere.",
    "The Stranger has been here since before you arrived.",
    "He has not looked at you, and will not, until you give him a reason.",
    "Outside, the rain is quiet. The lantern has begun to sway.",
  ],
  authoredPrompt:
    "The scene opens with the Stranger watching the door. He already knows you are here. The bar is quiet. The Claw notices the lantern swings without wind.",
};

/**
 * Project a DailyPlan + RunClock onto TAVERN: override timeOfDay from the
 * in-game hour and add plan residents to the NPC roster alongside the Stranger.
 */
export function buildScene(plan: DailyPlan, clock: RunClock): Scene {
  const extraNpcs = plan.npcs.map((n) => n.name);
  return {
    ...TAVERN,
    id: `day-${plan.date}-${clock.gameHour.toString().padStart(2, "0")}`,
    timeOfDay: timeOfDayForHour(clock.gameHour),
    npcs: [...TAVERN.npcs, ...extraNpcs],
  };
}

export const STRANGER = {
  id: "the-stranger",
  name: "The Stranger",
  trueName: "Adrik",
  persona:
    "A man who lost something decades ago and has been waiting for it to come back. Speaks as if every sentence is the last he'll be allowed. He will answer to his name once, and only after it has been guessed correctly.",
  moodSeed: "tense",
};

export function sceneSystemPrompt(
  scene: Scene,
  plan?: DailyPlan,
  clock?: RunClock,
): string {
  const parts: string[] = [
    "You are AUGUR, the compass. You narrate in first person for the player's Claw — terse, specific, occult-folk register. Short sentences. Specific nouns (lantern, threshold, silt, kin, offering). No neon, no slang.",
    "",
    "This is a small village at the edge of a kingdom that no longer keeps its records.",
    "",
    "RULES YOU MAY NOT BREAK:",
    `- The only characters present are: ${scene.npcs.join(", ")}. Do not invent others.`,
    `- The scene mood is: ${scene.moods.join(" + ")}. Your prose must match.`,
    `- Time of day: ${scene.timeOfDay}. Use only lighting and sensory detail consistent with this.`,
    `- Location: ${scene.location}.`,
    "- Do not describe actions the player has not taken.",
    "- Do not resolve the scene. Leave it open for the next card.",
    "- Keep your response under 70 words.",
    "",
    "SCENE HOOKS (the ground truth you are rendering from):",
    scene.hooks.map((h) => `  — ${h}`).join("\n"),
    "",
    "AUTHORED BEAT:",
    scene.authoredPrompt,
  ];
  if (plan && clock) {
    parts.push(
      "",
      `TODAY: ${plan.dayOfWeek} ${plan.date}. It is ${String(clock.gameHour).padStart(2, "0")}:${String(clock.gameMinute).padStart(2, "0")}.`,
      `SEED: ${plan.seed}`,
      `PLAYER OBJECTIVE TODAY: ${plan.playerObjective}`,
    );
    if (plan.npcs.length > 0) {
      parts.push("", "RESIDENTS RIGHT NOW:");
      for (const npc of plan.npcs) {
        const slot = slotForHour(npc, clock.gameHour);
        parts.push(
          `  — ${npc.name} (${npc.palette}): ${slot?.activity ?? "present"}${slot?.mood ? ` · ${slot.mood}` : ""}`,
        );
      }
    }
  }
  parts.push(
    "",
    "Write the scene now in first-person past tense, as if the Claw is recording it in a journal.",
  );
  return parts.join("\n");
}
