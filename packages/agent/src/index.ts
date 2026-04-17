/**
 * @augur/agent — shared agent engine for the prototype CLI and the Worker DO.
 *
 * Pure-TS. No Node-only APIs, no DOM globals. Consumed directly as source
 * via package.json#exports (wrangler, vite, and tsx all read `.ts` fine).
 */

export { DECK, findCard, type Card, type MechanicId } from "./cards.ts";

export {
  type AssistantMessage,
  type ContentPart,
  type ImagePart,
  type Message,
  type SystemMessage,
  type TextPart,
  type Usage,
  type UserMessage,
  assistantText,
} from "./messages.ts";

export {
  AUGUR_SESSION_FORMAT_VERSION,
  type SerializedEntry,
  type SerializedSession,
} from "./session-format.ts";

export { type Entry, SessionTree } from "./tree.ts";

export {
  type DailyPlan,
  type NpcDay,
  type RunClock,
  type ScheduleSlot,
} from "./schedule-types.ts";

export {
  dayOfWeekName,
  slotForHour,
  timeOfDayForHour,
  todayUtc,
} from "./daily-plan.ts";

export {
  type Scene,
  STRANGER,
  TAVERN,
  buildScene,
  sceneSystemPrompt,
} from "./scene.ts";

export { fastMind, kimi } from "./models.ts";

export { type CardWireShape, computeHand } from "./hand.ts";

export {
  AddVowSchema,
  BindFactSchema,
  BranchTimeSchema,
  CheckNameSchema,
  RecallMemorySchema,
  type AddVowParams,
  type BindFactParams,
  type BranchTimeParams,
  type CheckNameParams,
  type RecallMemoryParams,
} from "./tool-schemas.ts";

export {
  type ToolCtx,
  type ToolEffect,
  type ToolName,
  type ToolParams,
  addVowTool,
  bindFactTool,
  branchTimeTool,
  checkNameTool,
  createAllTools,
  createAmbientTools,
  recallMemoryTool,
} from "./tools.ts";

export {
  MAX_AGENT_STEPS,
  type NarrateCtx,
  type NarrateOpts,
  maybeOpenScene,
  narrate,
  playCard,
} from "./narrate.ts";

export {
  type ConsultOpts,
  STORYTELLERS,
  type StorytellerArchetype,
  type StorytellerDecision,
  type StorytellerEvent,
  type StorytellerEventType,
  applyStorytellerEvent,
  consultStoryteller,
} from "./storyteller.ts";
