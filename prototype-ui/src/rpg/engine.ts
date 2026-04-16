// Bare-bones TTRPG sim. A cabin. Two characters. The narrator names what
// happens. Cards are GM prompts, not mechanics. Everything the world does is
// a plan of tool calls — same tool-bus pattern as before, scope trimmed.

// Started as a strict literal for Marrow + Soren; broadened to string so
// the director can spawn new characters (strangers, antagonists).
export type CharId = string;
export type Facing = "up" | "down" | "left" | "right";
export type EmoteKind = "startle" | "still" | "warm" | "sad" | "puzzle";

export interface Tile { x: number; y: number }

export type Mood = "watchful" | "tender" | "withdrawn" | "alert" | "weary" | "still";

export interface Character {
  id: CharId;
  name: string;
  description: string;
  pos: { x: number; y: number };
  facing: Facing;
  moving: boolean;
  path: Tile[] | null;
  pathIdx: number;
  segProgress: number;
  goal: string | null;
  palette: { body: string; cloak: string; accent: string };
  emote: { kind: EmoteKind; until: number } | null;
  speech: { text: string; until: number } | null;
  mood: Mood;
  schedule: ScheduleSlot[];
  scheduleAnchor: string | null;
  inventory: string[];
  backstory: string;
  objective: string;
  motive: string;
  hp: number;
  dead: boolean;
  transient: boolean; // true = spawned by director, not part of core party
  struckUntil?: number; // hit-flash timestamp (performance.now()+ms)
}

export interface CardDef {
  id: string;
  title: string;       // base title; overridden by per-room cardSkins
  flavor: string;      // base flavor; overridden by per-room cardSkins
  mechanic: string;    // stable underlying concept the LLM re-skins around
  scores: CardScores;  // stable W/P/L
}

export type Tool =
  | { op: "narrate"; text: string }
  | { op: "speak"; charId: CharId; text: string }
  | { op: "walk"; charId: CharId; toAnchor: string }
  | { op: "emote"; charId: CharId; kind: EmoteKind; ms?: number }
  | { op: "face"; charId: CharId; facing: Facing }
  | { op: "wait"; ms: number }
  | { op: "give_item"; charId: CharId; item: string }
  | { op: "take_item"; charId: CharId; item: string }
  | { op: "set_flag"; key: string; value: string }
  | {
      op: "spawn_character";
      charId: string;
      name: string;
      description?: string;
      atAnchor?: string;
      palette?: "red" | "blue" | "green" | "grey" | "bone";
      hp?: number;
      objective?: string;
    }
  | { op: "attack"; attackerId: string; targetId: string; damage?: number }
  | { op: "die"; charId: string }
  | { op: "release_tension"; amount: number; reason?: string };

export type ToolResult =
  | { kind: "done" }
  | { kind: "await_walk"; charId: CharId }
  | { kind: "delay"; until: number };

export interface Plan {
  id: string;
  title: string;
  steps: Tool[];
  cursor: number;
  blocked: ToolResult | null;
}

export interface LogLine {
  id: string;
  kind: LineKind | "beat";
  text: string;
  at: number;
}

export interface ScheduleSlot { fromHour: number; anchor: string }

export interface PaletteEntry {
  name: string;
  color: string;
  walkable: boolean;
  glow?: boolean;
}

export interface Scene {
  id: string;
  name: string;
  map: string[];
  anchors: Record<string, Tile>;
  starts: Record<CharId, string>;
  schedules: Record<CharId, ScheduleSlot[]>;
  palette?: Record<string, PaletteEntry>;
}

export type LineKind = "narration" | "ambient" | "speech_marrow" | "speech_soren" | "action";

export type Phase = "setup" | "playing";

export type Stat = "wit" | "power" | "luck";

export interface CardScores {
  wit: number;
  power: number;
  luck: number;
}

export interface Moment {
  id: string;
  prompt: string;
  required: CardScores;
}

export interface SeedDef {
  id: string;
  title: string;
  flavor: string;
  sceneId: string;
}

export interface GameState {
  phase: Phase;
  scene: Scene;
  characters: Character[];
  hand: CardDef[];
  activePlan: Plan | null;
  planQueue: Plan[];
  log: LogLine[]; // retained for LLM context, not shown
  pending: {
    full: string;
    shown: number;
    sealedAt: number | null;
    kind: LineKind;
  } | null;
  narrationQueue: { line: string; kind: LineKind }[];
  simStartedAt: number;
  lastAmbient: number;
  nextId: number;
  selectedCardIds: string[];
  activeMoment: Moment | null;
  roomContext: string;
  cardSkins: Record<string, { title: string; flavor: string }>;
  flags: Record<string, string>;
  tension: number;
  beatsPlayed: number;
  roomItems: RoomItem[];
  stakes: string;
  roomId: string;
  lastDirectedAt: number;
  paused: boolean;
  history: HistorySnapshot[];
  blockedAt: Record<string, number>;
  storySummary: string;
  summaryBeatsAt: number; // beatsPlayed value when storySummary was last rewritten
  narrationSpeed: number; // 1 = normal reading pace, 2 = fast
  buildingId: string;
  floorIndex: number;
  inheritedMemory: string;
}

// ─── Building persistence ─────────────────────────────────────────────────

export interface SurvivorRecord {
  id: string;
  name: string;
  description: string;
  palette: { body: string; cloak: string; accent: string };
  backstory: string;
  objective: string;
  motive: string;
  inventory: string[];
  roomsLived: number;
  originRoomId: string;
}

export interface GhostRecord {
  id: string;
  name: string;
  description: string;
  causeOfDeath: string;
  diedInRoomId: string;
  diedInRoomName: string;
  beatsLived: number;
}

export interface SpentFloor {
  id: string;
  name: string;
  epitaph: string;
  stakes: string;
  storySummary: string;
  survivors: SurvivorRecord[];
  ghosts: GhostRecord[];
  tension: number;
  beatsPlayed: number;
  spentAt: number;
  createdAt: number;
  thumbnailScene: Scene;
  thumbnailCharacters: Array<{
    pos: { x: number; y: number };
    palette: { body: string; cloak: string; accent: string };
    dead: boolean;
  }>;
}

export interface StreakState {
  currentStreak: number;
  longestStreak: number;
  lastPlayedDate: string;
  totalRoomsPlayed: number;
  totalRoomsSpent: number;
  rareOutcomes: string[];
}

export interface BuildingState {
  id: string;
  name: string;
  floors: SpentFloor[];
  activeRoomId: string | null;
  roster: SurvivorRecord[];
  ghosts: GhostRecord[];
  globalItems: string[];
  streak: StreakState;
  createdAt: number;
  lastPlayedAt: number;
  /** Progression state — chapters earned + active objectives. */
  progress?: ProgressState;
  /** Lightweight counters that objectives check against. */
  metrics?: BuildingMetrics;
}

export interface BuildingMetrics {
  floorsSealedThisSeason: number;
  floorsSealedTotal: number;
  floorsWithBothSurviving: number;
  spawnsEver: number;
  deathsEver: number;
  categoriesUsed: string[]; // ingredient categories the player has selected at least once
  ingredientsPickedTotal: number;
}

export interface ProgressState {
  chapters: number;
  season: { id: string; name: string; startedAt: number };
  objectives: Objective[];
  completedIds: string[];
  /** ISO date string of when daily objectives were last rolled. */
  dailyRolledOn: string;
  /** ISO year-week of when weekly objectives were last rolled. */
  weeklyRolledOn: string;
}

export interface Objective {
  id: string;
  kind: "daily" | "weekly" | "seasonal";
  label: string;
  desc: string;
  reward: number; // chapters awarded on completion
  condition: string; // key into CONDITION_CHECKS
  target?: number;
  /** Snapshot of the relevant metric at the time the objective was rolled;
   * lets us compute "since roll" deltas instead of absolute counts. */
  snapshot?: number;
}

export function newBuildingId(): string {
  return `bldg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Current season — a simple month-based rotation for now. Seasons bias
// content and reset the chapter ladder.
function currentSeason(): { id: string; name: string; startedAt: number } {
  const d = new Date();
  const id = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const names = [
    "Winter", "Small Hours", "Thaw", "First Rain",
    "Long Days", "Midsummer", "Late Light", "Harvest",
    "Return", "All Souls", "Early Dark", "The Debt",
  ];
  const name = names[d.getMonth()] ?? "The Archive";
  const startedAt = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return { id, name, startedAt };
}

export function emptyMetrics(): BuildingMetrics {
  return {
    floorsSealedThisSeason: 0,
    floorsSealedTotal: 0,
    floorsWithBothSurviving: 0,
    spawnsEver: 0,
    deathsEver: 0,
    categoriesUsed: [],
    ingredientsPickedTotal: 0,
  };
}

export function emptyProgress(): ProgressState {
  return {
    chapters: 0,
    season: currentSeason(),
    objectives: [],
    completedIds: [],
    dailyRolledOn: "",
    weeklyRolledOn: "",
  };
}

export function createBuilding(name = "The Building"): BuildingState {
  const now = Date.now();
  return {
    id: newBuildingId(),
    name,
    floors: [],
    activeRoomId: null,
    roster: [],
    ghosts: [],
    globalItems: [],
    streak: {
      currentStreak: 0,
      longestStreak: 0,
      lastPlayedDate: "",
      totalRoomsPlayed: 0,
      totalRoomsSpent: 0,
      rareOutcomes: [],
    },
    createdAt: now,
    lastPlayedAt: now,
    progress: emptyProgress(),
    metrics: emptyMetrics(),
  };
}

// ─── Objective pool + rollers ──────────────────────────────────────────
// Each template is a pure data definition. The CONDITION_CHECKS map below
// turns a condition key into an evaluator that runs against a building.

interface ObjectiveTemplate {
  tplId: string;
  kind: "daily" | "weekly" | "seasonal";
  label: string;
  desc: string;
  reward: number;
  condition: string;
  target?: number;
  /** Which metric to snapshot when the objective is rolled. */
  snapshotKey?: keyof BuildingMetrics;
}

const OBJECTIVE_POOL: ObjectiveTemplate[] = [
  // ── Daily (easy, session-scale) ──────────────────────────────────────
  { tplId: "d_seal_1",     kind: "daily", label: "Open a room",         desc: "Seal one floor today.",                      reward: 1, condition: "floors_sealed_since", target: 1, snapshotKey: "floorsSealedTotal" },
  { tplId: "d_cat_3",      kind: "daily", label: "Mix your ingredients", desc: "Use cards from 3 different categories.",     reward: 1, condition: "categories_covered", target: 3 },
  { tplId: "d_streak_keep",kind: "daily", label: "Keep the light on",   desc: "Keep your streak alive today.",              reward: 1, condition: "streak_today" },
  { tplId: "d_survive_1",  kind: "daily", label: "Nobody falls",        desc: "Seal a floor today where everyone survives.", reward: 1, condition: "both_survived_since", target: 1, snapshotKey: "floorsWithBothSurviving" },
  { tplId: "d_stranger_1", kind: "daily", label: "A stranger arrives",  desc: "End a floor that had a spawned character.",  reward: 1, condition: "spawns_since", target: 1, snapshotKey: "spawnsEver" },

  // ── Weekly (persistent, a few sessions) ──────────────────────────────
  { tplId: "w_seal_3",     kind: "weekly", label: "Three stories",      desc: "Seal 3 floors this week.",                    reward: 3, condition: "floors_sealed_since", target: 3, snapshotKey: "floorsSealedTotal" },
  { tplId: "w_all_cats",   kind: "weekly", label: "The full table",     desc: "Use a card from every category.",             reward: 3, condition: "categories_covered", target: 6 },
  { tplId: "w_survive_2",  kind: "weekly", label: "Two clean floors",   desc: "Seal 2 floors where everyone survived.",      reward: 3, condition: "both_survived_since", target: 2, snapshotKey: "floorsWithBothSurviving" },
  { tplId: "w_streak_5",   kind: "weekly", label: "Five-day vigil",     desc: "Reach a 5-day streak.",                       reward: 3, condition: "streak_gte", target: 5 },

  // ── Seasonal (long arc) ──────────────────────────────────────────────
  { tplId: "s_roster_4",   kind: "seasonal", label: "A house of four",  desc: "Have 4 or more survivors in the roster.",     reward: 6, condition: "roster_gte", target: 4 },
  { tplId: "s_seal_10",    kind: "seasonal", label: "A full ten",       desc: "Seal 10 floors this season.",                 reward: 8, condition: "floors_sealed_season", target: 10 },
  { tplId: "s_ghost_3",    kind: "seasonal", label: "The ones who left", desc: "Accumulate 3 ghosts in the building.",        reward: 5, condition: "ghosts_gte", target: 3 },
];

// Deterministic seeded pick — given a string seed, sample N unique entries
// from the pool filtered by kind. Same seed = same picks.
function seededPick<T>(seed: string, pool: T[], n: number): T[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const arr = [...pool];
  // Fisher-Yates using the seed as the RNG source.
  const rand = () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 0x100000000;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
}
function weekKey(): string {
  const d = new Date();
  // Year + ISO week number — rough is fine; stable is what matters.
  const start = new Date(d.getFullYear(), 0, 1).getTime();
  const w = Math.floor((d.getTime() - start) / (7 * 86_400_000));
  return `${d.getFullYear()}-W${w}`;
}

function rollKind(
  kind: "daily" | "weekly" | "seasonal",
  seed: string,
  count: number,
  metrics: BuildingMetrics,
): Objective[] {
  const templates = OBJECTIVE_POOL.filter((t) => t.kind === kind);
  const picked = seededPick(seed, templates, count);
  return picked.map((t) => ({
    id: `${t.tplId}:${seed}`,
    kind: t.kind,
    label: t.label,
    desc: t.desc,
    reward: t.reward,
    condition: t.condition,
    target: t.target,
    snapshot: t.snapshotKey ? (metrics[t.snapshotKey] as number) ?? 0 : undefined,
  }));
}

export function rollObjectivesIfNeeded(b: BuildingState): boolean {
  ensureProgressState(b);
  const p = b.progress!;
  const m = b.metrics!;
  const today = todayKey();
  const week = weekKey();
  let changed = false;

  // Purge completed objectives that are no longer in the active list.
  // (We'll rebuild objectives below.)
  const keep: Objective[] = [];

  if (p.dailyRolledOn !== today) {
    // Drop yesterday's dailies entirely.
    keep.push(...p.objectives.filter((o) => o.kind !== "daily"));
    keep.push(...rollKind("daily", today, 3, m));
    p.dailyRolledOn = today;
    changed = true;
  } else {
    keep.push(...p.objectives.filter((o) => o.kind === "daily"));
  }

  if (p.weeklyRolledOn !== week) {
    // Drop last week's weeklies.
    for (let i = keep.length - 1; i >= 0; i--) {
      if (keep[i].kind === "weekly") keep.splice(i, 1);
    }
    keep.push(...rollKind("weekly", week, 2, m));
    p.weeklyRolledOn = week;
    changed = true;
  } else {
    for (const o of p.objectives) {
      if (o.kind === "weekly" && !keep.some((k) => k.id === o.id)) keep.push(o);
    }
  }

  // Seasonal: roll once per season.
  const hasSeasonal = keep.some((o) => o.kind === "seasonal");
  if (!hasSeasonal) {
    const existingSeasonal = p.objectives.filter(
      (o) => o.kind === "seasonal" && o.id.endsWith(`:${p.season.id}`),
    );
    if (existingSeasonal.length > 0) {
      keep.push(...existingSeasonal);
    } else {
      keep.push(...rollKind("seasonal", p.season.id, 1, m));
      changed = true;
    }
  }

  p.objectives = keep;
  return changed;
}

// ─── Condition checks ────────────────────────────────────────────────
// Each checker returns { satisfied: boolean; progress: number }. `progress`
// is 0..target (uncapped) used for UI progress bars.

export interface ConditionResult {
  satisfied: boolean;
  progress: number;
}

type ConditionCheck = (o: Objective, b: BuildingState) => ConditionResult;

const CONDITION_CHECKS: Record<string, ConditionCheck> = {
  floors_sealed_since: (o, b) => {
    const target = o.target ?? 1;
    const now = b.metrics?.floorsSealedTotal ?? 0;
    const snap = o.snapshot ?? 0;
    const progress = Math.max(0, now - snap);
    return { satisfied: progress >= target, progress };
  },
  floors_sealed_season: (o, b) => {
    const target = o.target ?? 1;
    const progress = b.metrics?.floorsSealedThisSeason ?? 0;
    return { satisfied: progress >= target, progress };
  },
  both_survived_since: (o, b) => {
    const target = o.target ?? 1;
    const now = b.metrics?.floorsWithBothSurviving ?? 0;
    const snap = o.snapshot ?? 0;
    const progress = Math.max(0, now - snap);
    return { satisfied: progress >= target, progress };
  },
  spawns_since: (o, b) => {
    const target = o.target ?? 1;
    const now = b.metrics?.spawnsEver ?? 0;
    const snap = o.snapshot ?? 0;
    const progress = Math.max(0, now - snap);
    return { satisfied: progress >= target, progress };
  },
  categories_covered: (o, b) => {
    const target = o.target ?? 3;
    const progress = (b.metrics?.categoriesUsed ?? []).length;
    return { satisfied: progress >= target, progress };
  },
  streak_today: (_o, b) => {
    const today = todayKey();
    const satisfied = b.streak.lastPlayedDate === today && b.streak.currentStreak >= 1;
    return { satisfied, progress: satisfied ? 1 : 0 };
  },
  streak_gte: (o, b) => {
    const target = o.target ?? 3;
    const progress = b.streak.currentStreak;
    return { satisfied: progress >= target, progress };
  },
  roster_gte: (o, b) => {
    const target = o.target ?? 3;
    const progress = b.roster.length;
    return { satisfied: progress >= target, progress };
  },
  ghosts_gte: (o, b) => {
    const target = o.target ?? 1;
    const progress = b.ghosts.length;
    return { satisfied: progress >= target, progress };
  },
};

export function checkObjective(o: Objective, b: BuildingState): ConditionResult {
  const fn = CONDITION_CHECKS[o.condition];
  if (!fn) return { satisfied: false, progress: 0 };
  return fn(o, b);
}

// Evaluate all active objectives. Newly-satisfied ones are added to
// completedIds and their rewards are added to chapters. Returns the list
// of objectives that completed in this pass (for UI toasts).
export function evaluateObjectives(b: BuildingState): Objective[] {
  ensureProgressState(b);
  const p = b.progress!;
  const newlyDone: Objective[] = [];
  for (const o of p.objectives) {
    if (p.completedIds.includes(o.id)) continue;
    const { satisfied } = checkObjective(o, b);
    if (satisfied) {
      p.completedIds.push(o.id);
      p.chapters += o.reward;
      newlyDone.push(o);
    }
  }
  return newlyDone;
}

// Update metrics when a floor seals. Called from spendRoom.
export function recordFloorSealed(b: BuildingState, floor: SpentFloor): void {
  ensureProgressState(b);
  const m = b.metrics!;
  m.floorsSealedTotal += 1;
  m.floorsSealedThisSeason += 1;
  if (floor.ghosts.length === 0 && floor.survivors.length >= 2) {
    m.floorsWithBothSurviving += 1;
  }
  m.deathsEver += floor.ghosts.length;
}

// Update metrics when the player picks ingredients (called before gen).
export function recordIngredientsPicked(
  b: BuildingState,
  categories: string[],
): void {
  ensureProgressState(b);
  const m = b.metrics!;
  m.ingredientsPickedTotal += categories.length;
  const set = new Set(m.categoriesUsed);
  for (const c of categories) set.add(c);
  m.categoriesUsed = Array.from(set);
}

// Update metrics when a spawn occurs (called from the spawn_character tool).
export function recordSpawn(b: BuildingState): void {
  ensureProgressState(b);
  const m = b.metrics!;
  m.spawnsEver += 1;
}

// Ensure older building records gain the progress/metrics blocks.
export function ensureProgressState(b: BuildingState): BuildingState {
  if (!b.metrics) b.metrics = emptyMetrics();
  if (!b.progress) b.progress = emptyProgress();
  // Roll seasons — if the stored season is older than current, reset
  // chapter count and completions (streaks stay).
  const cur = currentSeason();
  if (b.progress.season.id !== cur.id) {
    b.progress.season = cur;
    b.progress.chapters = 0;
    b.progress.completedIds = [];
    b.progress.objectives = [];
    b.progress.dailyRolledOn = "";
    b.progress.weeklyRolledOn = "";
    if (b.metrics) b.metrics.floorsSealedThisSeason = 0;
  }
  return b;
}

// ─── Scenes ────────────────────────────────────────────────────────────────
// Tile glyphs:
//   #  wall          .  floor         |  door
//   ~  hearth        w  window        b  bed
//   t  table         c  chair         =  bar
//   *  stone         T  tree          R  river
//   p  pantry        l  lantern       s  satchel

export const SCENES: Record<string, Scene> = {
  cabin: {
    id: "cabin",
    name: "a cabin, before morning",
    map: [
      "################",
      "#..............#",
      "#..w.........b.#",
      "#..............#",
      "#~~~...........#",
      "#~~~......t....#",
      "#~~~......t....#",
      "#..............#",
      "#..............#",
      "#......|||.....#",
      "################",
    ],
    anchors: {
      window: { x: 4, y: 3 },
      hearth: { x: 4, y: 5 },
      bed: { x: 13, y: 2 },
      table_a: { x: 9, y: 7 },
      table_b: { x: 11, y: 7 },
      door_in: { x: 8, y: 8 },
      center: { x: 7, y: 6 },
    },
    starts: { marrow: "window", soren: "bed" },
    schedules: {
      marrow: [
        { fromHour: 0, anchor: "bed" },
        { fromHour: 5, anchor: "window" },
        { fromHour: 8, anchor: "hearth" },
        { fromHour: 12, anchor: "table_a" },
        { fromHour: 15, anchor: "door_in" },
        { fromHour: 17, anchor: "hearth" },
        { fromHour: 22, anchor: "window" },
        { fromHour: 23, anchor: "bed" },
      ],
      soren: [
        { fromHour: 0, anchor: "bed" },
        { fromHour: 7, anchor: "window" },
        { fromHour: 10, anchor: "table_b" },
        { fromHour: 13, anchor: "window" },
        { fromHour: 17, anchor: "hearth" },
        { fromHour: 20, anchor: "table_b" },
        { fromHour: 22, anchor: "bed" },
      ],
    },
  },
  porch: {
    id: "porch",
    name: "a porch, after the storm",
    map: [
      "RRRRRRRRRRRRRRRR",
      "#..............#",
      "#..c.........c.#",
      "#..............#",
      "#..............#",
      "#......t.......#",
      "#..............#",
      "#..............#",
      "#..............#",
      "#......|||.....#",
      "################",
    ],
    anchors: {
      chair_a: { x: 4, y: 3 },
      chair_b: { x: 13, y: 3 },
      table_a: { x: 8, y: 5 },
      door_in: { x: 8, y: 8 },
      rail_a: { x: 5, y: 7 },
      rail_b: { x: 11, y: 7 },
      center: { x: 8, y: 6 },
    },
    starts: { marrow: "chair_a", soren: "chair_b" },
    schedules: {
      marrow: [
        { fromHour: 0, anchor: "chair_a" },
        { fromHour: 6, anchor: "rail_a" },
        { fromHour: 9, anchor: "chair_a" },
        { fromHour: 14, anchor: "table_a" },
        { fromHour: 18, anchor: "chair_a" },
        { fromHour: 22, anchor: "door_in" },
      ],
      soren: [
        { fromHour: 0, anchor: "chair_b" },
        { fromHour: 7, anchor: "rail_b" },
        { fromHour: 10, anchor: "chair_b" },
        { fromHour: 14, anchor: "table_a" },
        { fromHour: 18, anchor: "rail_b" },
        { fromHour: 22, anchor: "chair_b" },
      ],
    },
  },
  inn: {
    id: "inn",
    name: "an inn, off-season",
    map: [
      "################",
      "#..............#",
      "#..============#",
      "#..............#",
      "#~~~...........#",
      "#~~~....t......#",
      "#~~~....t......#",
      "#..............#",
      "#l.............#",
      "#......|||.....#",
      "################",
    ],
    anchors: {
      bar_a: { x: 4, y: 3 },
      bar_b: { x: 8, y: 3 },
      hearth: { x: 4, y: 5 },
      table_a: { x: 8, y: 7 },
      table_b: { x: 9, y: 7 },
      door_in: { x: 8, y: 8 },
      lantern: { x: 2, y: 8 },
      center: { x: 8, y: 6 },
    },
    starts: { marrow: "bar_a", soren: "table_a" },
    schedules: {
      marrow: [
        { fromHour: 0, anchor: "bar_a" },
        { fromHour: 6, anchor: "hearth" },
        { fromHour: 11, anchor: "bar_a" },
        { fromHour: 17, anchor: "hearth" },
        { fromHour: 22, anchor: "bar_a" },
      ],
      soren: [
        { fromHour: 0, anchor: "table_a" },
        { fromHour: 8, anchor: "bar_b" },
        { fromHour: 12, anchor: "table_a" },
        { fromHour: 19, anchor: "hearth" },
        { fromHour: 22, anchor: "table_a" },
      ],
    },
  },
};

export const MAP_COLS = 16;
export const MAP_ROWS = 11;
export const TILE_PX = 30;

const CORE_WALKABLE = (c: string) => c === "." || c === "|";

export function isWalkable(scene: Scene, x: number, y: number): boolean {
  if (y < 0 || y >= scene.map.length) return false;
  const row = scene.map[y];
  if (x < 0 || x >= row.length) return false;
  const ch = row[x];
  if (CORE_WALKABLE(ch)) return true;
  // Custom palette tile? Respect its walkable flag.
  const entry = scene.palette?.[ch];
  return entry?.walkable ?? false;
}

export function aStar(scene: Scene, start: Tile, goal: Tile): Tile[] | null {
  if (!isWalkable(scene, goal.x, goal.y)) return null;
  if (start.x === goal.x && start.y === goal.y) return [start];
  const key = (x: number, y: number) => `${x},${y}`;
  const h = (x: number, y: number) => Math.abs(x - goal.x) + Math.abs(y - goal.y);
  const open = new Map<string, { t: Tile; g: number; f: number }>();
  const parent = new Map<string, string | null>();
  const closed = new Set<string>();
  const s = key(start.x, start.y);
  open.set(s, { t: start, g: 0, f: h(start.x, start.y) });
  parent.set(s, null);
  while (open.size > 0) {
    let curKey = "";
    let cur: { t: Tile; g: number; f: number } | null = null;
    for (const [k, n] of open) if (!cur || n.f < cur.f) { curKey = k; cur = n; }
    if (!cur) break;
    if (cur.t.x === goal.x && cur.t.y === goal.y) {
      const path: Tile[] = [];
      let k: string | null = curKey;
      while (k) {
        const [xs, ys] = k.split(",");
        path.unshift({ x: +xs, y: +ys });
        k = parent.get(k) ?? null;
      }
      return path;
    }
    open.delete(curKey);
    closed.add(curKey);
    const nbrs: Tile[] = [
      { x: cur.t.x + 1, y: cur.t.y },
      { x: cur.t.x - 1, y: cur.t.y },
      { x: cur.t.x, y: cur.t.y + 1 },
      { x: cur.t.x, y: cur.t.y - 1 },
    ];
    for (const n of nbrs) {
      if (!isWalkable(scene, n.x, n.y)) continue;
      const k = key(n.x, n.y);
      if (closed.has(k)) continue;
      const g = cur.g + 1;
      const ex = open.get(k);
      if (!ex || g < ex.g) {
        open.set(k, { t: n, g, f: g + h(n.x, n.y) });
        parent.set(k, curKey);
      }
    }
  }
  return null;
}

function facingFrom(a: Tile, b: Tile): Facing {
  if (b.x > a.x) return "right";
  if (b.x < a.x) return "left";
  if (b.y > a.y) return "down";
  return "up";
}

// ─── Characters ────────────────────────────────────────────────────────────

export const CHARACTERS: Character[] = [
  {
    id: "marrow",
    name: "Marrow",
    description: "older, careful, steady with words, willing to speak their mind when it matters",
    pos: { x: 4, y: 3 },
    facing: "down",
    moving: false,
    path: null,
    pathIdx: 0,
    segProgress: 0,
    goal: null,
    palette: { body: "#e8d0a8", cloak: "#5a4432", accent: "#c89a3a" },
    emote: null,
    speech: null,
    mood: "watchful",
    inventory: [],
    backstory: "",
    objective: "",
    motive: "",
    hp: 3,
    dead: false,
    transient: false,
    schedule: [
      { fromHour: 0, anchor: "bed" },
      { fromHour: 5, anchor: "window" },
      { fromHour: 8, anchor: "hearth" },
      { fromHour: 12, anchor: "table_a" },
      { fromHour: 15, anchor: "door_in" },
      { fromHour: 17, anchor: "hearth" },
      { fromHour: 22, anchor: "window" },
      { fromHour: 23, anchor: "bed" },
    ],
    scheduleAnchor: null,
  },
  {
    id: "soren",
    name: "Soren",
    description: "younger, listens too hard, asks the wrong questions",
    pos: { x: 13, y: 2 },
    facing: "left",
    moving: false,
    path: null,
    pathIdx: 0,
    segProgress: 0,
    goal: null,
    palette: { body: "#d8b89a", cloak: "#3a4a6a", accent: "#8ab0c8" },
    emote: null,
    speech: null,
    mood: "still",
    inventory: [],
    backstory: "",
    objective: "",
    motive: "",
    hp: 3,
    dead: false,
    transient: false,
    schedule: [
      { fromHour: 0, anchor: "bed" },
      { fromHour: 7, anchor: "window" },
      { fromHour: 10, anchor: "table_b" },
      { fromHour: 13, anchor: "window" },
      { fromHour: 17, anchor: "hearth" },
      { fromHour: 20, anchor: "table_b" },
      { fromHour: 22, anchor: "bed" },
    ],
    scheduleAnchor: null,
  },
];

// ─── Cards ─────────────────────────────────────────────────────────────────

export const SEEDS: SeedDef[] = [
  {
    id: "first_night",
    title: "First night in the cabin",
    flavor: "Marrow has only just arrived. The hearth is still unfamiliar to one of them.",
    sceneId: "cabin",
  },
  {
    id: "after_storm",
    title: "On the porch, after the storm",
    flavor: "Two days of weather. The yard is still reorganizing itself.",
    sceneId: "porch",
  },
  {
    id: "strangers_in_inn",
    title: "Strangers at the inn",
    flavor: "Off-season. Half the candles unlit. They have been polite for hours.",
    sceneId: "inn",
  },
  {
    id: "years_in",
    title: "Years in the cabin",
    flavor: "They no longer count the silences between them.",
    sceneId: "cabin",
  },
  {
    id: "before_leaving",
    title: "The night before leaving the porch",
    flavor: "One of them is going somewhere. They haven't said which.",
    sceneId: "porch",
  },
];

// Cards are specific small actions a character takes — concrete, physical,
// weighted. Mechanic + W/P/L stay stable; the LLM re-skins title/flavor for
// each room. Each card costs something or commits to something.
export const CARDS: CardDef[] = [
  {
    id: "pour",
    title: "Pour them a drink",
    flavor: "Hands move. Glass against wood. The conversation gets a witness.",
    mechanic: "shared_offering",
    scores: { wit: 1, power: 1, luck: 2 },
  },
  {
    id: "candle",
    title: "Light a candle",
    flavor: "Strike, breath, hold. The room agrees to be smaller for a while.",
    mechanic: "small_ritual",
    scores: { wit: 2, power: 0, luck: 2 },
  },
  {
    id: "hand",
    title: "Take their hand",
    flavor: "Cross the small distance. Make the room admit who is in it.",
    mechanic: "tactile_kindness",
    scores: { wit: 2, power: 1, luck: 1 },
  },
  {
    id: "look_away",
    title: "Look away first",
    flavor: "Give the eye back. Let the room hold it. Hear what fills the silence.",
    mechanic: "yield_eye_contact",
    scores: { wit: 3, power: 0, luck: 1 },
  },
  {
    id: "lock_door",
    title: "Bolt the door",
    flavor: "Iron sliding home. Whatever is outside stays outside. Whatever is inside, stays.",
    mechanic: "decisive_closing",
    scores: { wit: 0, power: 3, luck: 0 },
  },
  {
    id: "say_name",
    title: "Say the name",
    flavor: "Speak the one no one has said. The room remembers it. Someone has to.",
    mechanic: "name_the_unspoken",
    scores: { wit: 2, power: 2, luck: 0 },
  },
  {
    id: "bones",
    title: "Throw the bones",
    flavor: "Three small bones across the table. Whatever falls falls. Read it honestly.",
    mechanic: "roll_for_chance",
    scores: { wit: 0, power: 1, luck: 3 },
  },
  {
    id: "burn_page",
    title: "Burn one page",
    flavor: "Corner to the flame. The answer goes up brown. The choice goes with it.",
    mechanic: "ritual_destruction",
    scores: { wit: 1, power: 2, luck: 1 },
  },
];

// Moments are concrete scenes — a specific tension on the table, with
// physical detail and an implicit question. The required key shapes the
// kind of answer the moment is asking for.
export const MOMENTS: Moment[] = [
  {
    id: "knock_once",
    prompt:
      "A knock at the door. Once. Then nothing. Marrow has stopped mid-breath. Soren is already looking. Whoever is out there has not knocked again, and is still out there.",
    required: { wit: 0, power: 0, luck: 3 },
  },
  {
    id: "fire_failing",
    prompt:
      "The hearth has narrowed to coals. The cold has begun the slow pressure it always does at this hour. Whoever moves first owns the next hour of the room.",
    required: { wit: 0, power: 3, luck: 0 },
  },
  {
    id: "name_in_air",
    prompt:
      "Soren has thought of a name and has not said it. Marrow knows which name. It has been in the room for an hour, getting heavier.",
    required: { wit: 4, power: 0, luck: 0 },
  },
  {
    id: "confession_lip",
    prompt:
      "Marrow has the next sentence ready. It will change the shape of the room. They could swallow it. They have, before. The room is leaning either way.",
    required: { wit: 2, power: 2, luck: 0 },
  },
  {
    id: "object_floor",
    prompt:
      "Something has fallen between the chairs. Neither of them remembers when. It lies there asking to be picked up, or asking to be left. They are not sure which.",
    required: { wit: 1, power: 1, luck: 2 },
  },
  {
    id: "last_hour",
    prompt:
      "The light has begun its decision. Soon: choices about lamps. Soon: choices about who stays where. Neither of them wants to be the one who decides yet.",
    required: { wit: 2, power: 0, luck: 2 },
  },
  {
    id: "guest_seated",
    prompt:
      "There is a third chair at the table now. It was not there an hour ago. Neither of them put it there. Neither of them has acknowledged it.",
    required: { wit: 3, power: 0, luck: 1 },
  },
];

export function pickMoment(exclude?: string | null): Moment {
  const pool = MOMENTS.filter((m) => m.id !== exclude);
  return pool[Math.floor(Math.random() * pool.length)] ?? MOMENTS[0];
}

export function totals(s: GameState): CardScores {
  const t = { wit: 0, power: 0, luck: 0 };
  for (const id of s.selectedCardIds) {
    const card = CARDS.find((c) => c.id === id);
    if (!card) continue;
    t.wit += card.scores.wit;
    t.power += card.scores.power;
    t.luck += card.scores.luck;
  }
  return t;
}

export function meetsRequirement(t: CardScores, req: CardScores): boolean {
  return t.wit >= req.wit && t.power >= req.power && t.luck >= req.luck;
}

// ─── Tool runner + plan ticker ─────────────────────────────────────────────

function newId(s: GameState): string { s.nextId += 1; return `i${s.nextId}`; }

// Queue each line independently so they type out one at a time. There is
// no rolling log in the scene — the current line is the scene. When a new
// line arrives, it replaces the previous one.
function enqueue(
  s: GameState,
  lines: string[],
  now: number,
  kind: LineKind = "narration",
) {
  for (const line of lines) {
    if (!s.pending) {
      s.pending = { full: line, shown: 0, sealedAt: now, kind };
    } else {
      s.narrationQueue.push({ line, kind });
    }
  }
}

// Push a silent action entry directly into the log (not the narration
// queue). Shown in the Story Log panel with an [action] prefix so players
// can see world changes — item given/taken, flag set, spawn, attack, die.
function logAction(s: GameState, text: string, now: number): void {
  s.log.push({ id: newId(s), kind: "action", text, at: now });
  if (s.log.length > 80) s.log.splice(0, s.log.length - 80);
}

export const WALK_SPEED = 2.4;

// ~100 real seconds = 1 sim hour → a sim day is ~40 minutes of play.
// Slow enough that the clock feels like a clock instead of a stopwatch.
export const SIM_HOURS_PER_SEC = 0.01;

export function simHour(now: number, startedAt: number): number {
  return (((now - startedAt) / 1000) * SIM_HOURS_PER_SEC) % 24;
}

// Format a float sim hour as "HH:MM" plus a time-of-day label.
export function formatSimTime(hour: number): { clock: string; label: string } {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour - Math.floor(hour)) * 60);
  const clock = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
  let label = "night";
  if (h >= 5 && h < 8) label = "dawn";
  else if (h >= 8 && h < 12) label = "morning";
  else if (h >= 12 && h < 14) label = "midday";
  else if (h >= 14 && h < 18) label = "afternoon";
  else if (h >= 18 && h < 21) label = "dusk";
  else if (h >= 21 || h < 2) label = "night";
  else if (h >= 2 && h < 5) label = "small hours";
  return { clock, label };
}

function currentScheduleAnchor(c: Character, hour: number): string {
  const s = c.schedule;
  if (!s || s.length === 0) return "center";
  let best = s[s.length - 1].anchor;
  for (const slot of s) if (slot.fromHour <= hour) best = slot.anchor;
  return best;
}

// Opening-scene damper: early beats barely move the needle so the player
// can settle into the room before the arc starts pushing.
function addTension(s: GameState, raw: number): void {
  // Opening warmup: pressure builds slowly for the first ~10 beats so the
  // room has room to establish itself before escalating. 20% → 100%.
  const warmup = Math.min(1, s.beatsPlayed / 10);
  const scaled = raw * (0.2 + 0.8 * warmup);
  s.tension = Math.min(100, s.tension + scaled);
}

const EMOTE_TO_MOOD: Record<EmoteKind, Mood> = {
  startle: "alert",
  still: "still",
  warm: "tender",
  sad: "withdrawn",
  puzzle: "watchful",
};

function nearestAnchorTo(scene: Scene, pos: { x: number; y: number }): string {
  let best = "center";
  let bestD = Infinity;
  for (const [name, a] of Object.entries(scene.anchors)) {
    const d = Math.abs(a.x - pos.x) + Math.abs(a.y - pos.y);
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

// Fuzzy character lookup — LLMs may emit any variant of id / name across
// steps: "Zombie", "zombie", "the_zombie", "Kaida", "kaida_black", etc.
// Match in order: exact id, normalized id, normalized name (first token
// or full), or case-insensitive substring on name.
function findChar(s: GameState, id: string): Character | undefined {
  if (!id) return undefined;
  const needle = id.toLowerCase().trim();
  const exact = s.characters.find((c) => c.id === id);
  if (exact) return exact;
  const norm = (t: string) =>
    t.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
  const needleN = norm(id);
  // 1) id-based
  const byId = s.characters.find(
    (c) => c.id === needleN || c.id.toLowerCase() === needle || norm(c.id) === needleN,
  );
  if (byId) return byId;
  // 2) name-based (exact or normalized)
  const byName = s.characters.find(
    (c) => c.name.toLowerCase() === needle || norm(c.name) === needleN,
  );
  if (byName) return byName;
  // 3) first-name or substring match ("Kaida" → "Kaida Black")
  const byFirst = s.characters.find((c) => {
    const parts = c.name.toLowerCase().split(/\s+/);
    return parts[0] === needle || parts.some((p) => norm(p) === needleN);
  });
  if (byFirst) return byFirst;
  return s.characters.find((c) => c.name.toLowerCase().includes(needle));
}

export function runTool(s: GameState, tool: Tool, now: number): ToolResult {
  switch (tool.op) {
    case "narrate": {
      // Belt-and-suspenders: never let raw JSON or empty text reach the
      // canvas dialog, even if the director slipped one through validation.
      const raw = (tool.text ?? "").toString().trim();
      if (
        !raw ||
        raw.startsWith("{") || raw.endsWith("}") ||
        raw.startsWith("[") || raw.endsWith("]") ||
        /^\s*"?lines"?\s*[:=]/i.test(raw)
      ) {
        return { kind: "done" };
      }
      enqueue(s, [raw], now);
      return { kind: "done" };
    }
    case "speak": {
      const c = findChar(s, tool.charId);
      if (!c) return { kind: "done" };
      for (const other of s.characters) {
        if (other.id !== c.id) other.speech = null;
      }
      const readMs = Math.max(2000, Math.min(6000, tool.text.length * 45));
      c.speech = { text: tool.text, until: now + readMs };
      const line = `${c.name}: "${tool.text}"`;
      // Speaker color keyed by position in the cast, not by hardcoded id,
      // so scenes with non-marrow/soren core characters still colorize.
      const idx = s.characters.findIndex((x) => x.id === c.id && !x.transient);
      const kind: LineKind = idx === 1 ? "speech_soren" : "speech_marrow";
      enqueue(s, [line], now, kind);
      addTension(s, 0.7);
      return { kind: "done" };
    }
    case "walk": {
      const c = findChar(s, tool.charId);
      if (!c) return { kind: "done" };
      let anchor = s.scene.anchors[tool.toAnchor];
      let goalName = tool.toAnchor;
      // Fallback: if the target anchor doesn't exist, walk to the nearest
      // valid anchor instead of silently doing nothing.
      if (!anchor) {
        const nearest = nearestAnchorTo(s.scene, c.pos);
        anchor = s.scene.anchors[nearest];
        goalName = nearest;
        if (!anchor) return { kind: "done" };
      }
      const start = { x: Math.round(c.pos.x), y: Math.round(c.pos.y) };
      c.path = aStar(s.scene, start, anchor);
      c.pathIdx = 0;
      c.segProgress = 0;
      c.goal = goalName;
      s.lastDirectedAt = now;
      return { kind: "done" };
    }
    case "emote": {
      const c = findChar(s, tool.charId);
      if (c) {
        c.emote = { kind: tool.kind, until: now + (tool.ms ?? 1400) };
        c.mood = EMOTE_TO_MOOD[tool.kind] ?? c.mood;
      }
      return { kind: "done" };
    }
    case "face": {
      const c = findChar(s, tool.charId);
      if (c) c.facing = tool.facing;
      return { kind: "done" };
    }
    case "wait":
      return { kind: "delay", until: now + tool.ms };
    case "give_item": {
      const c = findChar(s, tool.charId);
      if (c && !c.inventory.includes(tool.item)) {
        c.inventory.push(tool.item);
        if (c.inventory.length > 8) c.inventory.shift();
        addTension(s, 1);
        const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "");
        const target = norm(tool.item);
        s.roomItems = s.roomItems.filter(
          (ri) => !(norm(ri.name) === target || target.includes(norm(ri.name))),
        );
        logAction(s, `${c.name} takes up the ${tool.item}.`, now);
      }
      return { kind: "done" };
    }
    case "take_item": {
      const c = findChar(s, tool.charId);
      if (c) {
        const idx = c.inventory.indexOf(tool.item);
        if (idx >= 0) {
          c.inventory.splice(idx, 1);
          addTension(s, 1.2);
          logAction(s, `${c.name} sets down / spends the ${tool.item}.`, now);
        }
      }
      return { kind: "done" };
    }
    case "set_flag": {
      const key = tool.key.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 40);
      if (!key) return { kind: "done" };
      s.flags[key] = String(tool.value).slice(0, 40);
      addTension(s, 2);
      logAction(s, `Flag: ${key.replace(/_/g, " ")} → ${tool.value}`, now);
      return { kind: "done" };
    }
    case "spawn_character": {
      const id = tool.charId.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 20);
      if (!id || s.characters.some((c) => c.id === id)) return { kind: "done" };
      const palettes: Record<
        NonNullable<typeof tool.palette>,
        Character["palette"]
      > = {
        red: { body: "#6a2a2a", cloak: "#3a1010", accent: "#b8506a" },
        blue: { body: "#4a6a8a", cloak: "#2a4058", accent: "#8ab0c8" },
        green: { body: "#3a5a3a", cloak: "#2a4028", accent: "#7ab858" },
        grey: { body: "#4a4a4a", cloak: "#2a2a2a", accent: "#aaaaaa" },
        bone: { body: "#a8a090", cloak: "#4a4232", accent: "#d8c8a0" },
      };
      const anchorName = tool.atAnchor && s.scene.anchors[tool.atAnchor]
        ? tool.atAnchor
        : "door_in" in s.scene.anchors ? "door_in" : "center";
      const anchor = s.scene.anchors[anchorName] ?? { x: 8, y: 5 };
      s.characters.push({
        id,
        name: tool.name.slice(0, 30) || id,
        description: tool.description ?? "a figure on the floor",
        pos: { x: anchor.x, y: anchor.y },
        facing: "down",
        moving: false,
        path: null,
        pathIdx: 0,
        segProgress: 0,
        goal: null,
        palette: palettes[tool.palette ?? "grey"],
        emote: null,
        speech: null,
        mood: "alert",
        inventory: [],
        backstory: "",
        objective: tool.objective ?? "",
        motive: "",
        hp: Math.max(1, Math.min(5, tool.hp ?? 2)),
        dead: false,
        transient: true,
        schedule: [],
        scheduleAnchor: null,
      });
      addTension(s, 8);
      logAction(s, `${tool.name} arrives on the floor.`, now);
      return { kind: "done" };
    }
    case "attack": {
      const attacker = findChar(s, tool.attackerId);
      const target = findChar(s, tool.targetId);
      if (!attacker || !target || target.dead) return { kind: "done" };
      const dmg = Math.max(1, Math.min(3, tool.damage ?? 1));
      target.hp = Math.max(0, target.hp - dmg);
      target.emote = { kind: "startle", until: now + 1500 };
      target.struckUntil = now + 420;
      // Lunge the attacker a hair, so there's a visible motion line too.
      attacker.emote = { kind: "startle", until: now + 600 };
      // Attacker faces the target.
      const dx = target.pos.x - attacker.pos.x;
      const dy = target.pos.y - attacker.pos.y;
      attacker.facing =
        Math.abs(dx) > Math.abs(dy)
          ? dx > 0 ? "right" : "left"
          : dy > 0 ? "down" : "up";
      if (target.hp === 0) target.dead = true;
      addTension(s, 8);
      logAction(
        s,
        target.hp === 0
          ? `${attacker.name} strikes ${target.name}. ${target.name} falls.`
          : `${attacker.name} strikes ${target.name} (${dmg}).`,
        now,
      );
      return { kind: "done" };
    }
    case "die": {
      const c = findChar(s, tool.charId);
      if (c) {
        c.dead = true;
        c.hp = 0;
        c.speech = null;
        c.path = null;
        addTension(s, 14);
        logAction(s, `${c.name} dies.`, now);
      }
      return { kind: "done" };
    }
    case "release_tension": {
      // The director explicitly relieves pressure — a confession accepted,
      // a shared silence, a meal offered, a door unbolted. Amount is
      // absolute (bypasses the opening-scene warmup on additions). Clamped
      // so a single call can't wipe the whole arc.
      const amount = Math.max(1, Math.min(20, Math.round(tool.amount)));
      s.tension = Math.max(0, s.tension - amount);
      return { kind: "done" };
    }
  }
}

// Passive tension decay: when the scene has been quiet for a while (no
// active plan, no pending narration), tension drifts down slowly so the
// room has room to breathe. We also bleed tension — more slowly — while
// plans are running, so the bar visibly reacts instead of only climbing.
// Rates: ~10/min when idle, ~3/min during active plans.
export function tickTensionDecay(s: GameState, dt: number): void {
  if (s.phase !== "playing") return;
  if (s.tension <= 0) return;
  if (s.tension >= 100) return; // spent; let the coda land before breathing
  const busy = !!s.activePlan || s.planQueue.length > 0;
  const typing =
    !!s.pending && s.pending.sealedAt !== null && s.pending.shown < s.pending.full.length;
  const perMin = busy || typing ? 5 : 14;
  s.tension = Math.max(0, s.tension - (perMin / 60) * dt);
}

function isUnblocked(s: GameState, r: ToolResult, now: number): boolean {
  switch (r.kind) {
    case "done": return true;
    case "await_walk": {
      const c = s.characters.find((x) => x.id === r.charId);
      return !!c && !c.moving && !c.path;
    }
    case "delay": return now >= r.until;
  }
}

export function tickPlans(s: GameState, now: number) {
  while (true) {
    if (!s.activePlan && s.planQueue.length > 0) {
      captureHistory(s); // snapshot pre-plan so rewind can undo it
      s.activePlan = s.planQueue.shift() ?? null;
    }
    if (!s.activePlan) return;
    const p = s.activePlan;
    if (p.blocked) {
      if (!isUnblocked(s, p.blocked, now)) return;
      p.blocked = null;
    }
    if (p.cursor >= p.steps.length) { s.activePlan = null; continue; }
    const step = p.steps[p.cursor];
    p.cursor += 1;
    const r = runTool(s, step, now);
    if (r.kind !== "done") { p.blocked = r; return; }
  }
}

// Schedule tick: only runs in the ambient lull — before the story really
// starts (low tension) AND no director/user activity in the last 2 minutes.
// This prevents schedules from fighting the director mid-scene.
export function tickSchedules(s: GameState, now: number) {
  if (s.activePlan || s.planQueue.length > 0) return;
  // Tension gate: schedules only during the opening / ambient lull.
  if (s.tension >= 10) return;
  // Recency gate: any director-placed movement in the last 2 min wins.
  if (s.lastDirectedAt > 0 && now - s.lastDirectedAt < 120_000) return;
  const hour = simHour(now, s.simStartedAt);
  for (const c of s.characters) {
    if (c.dead || c.transient || c.schedule.length === 0) continue;
    const desired = currentScheduleAnchor(c, hour);
    if (desired === c.scheduleAnchor && !c.path) continue;
    if (c.path && c.scheduleAnchor === desired) continue;
    const anchor = s.scene.anchors[desired];
    if (!anchor) {
      // Anchor may not exist in this scene's variant; skip.
      c.scheduleAnchor = desired;
      continue;
    }
    const dx = Math.abs(c.pos.x - anchor.x);
    const dy = Math.abs(c.pos.y - anchor.y);
    if (dx < 0.6 && dy < 0.6) {
      c.scheduleAnchor = desired;
      continue;
    }
    const start = { x: Math.round(c.pos.x), y: Math.round(c.pos.y) };
    c.path = aStar(s.scene, start, anchor);
    c.pathIdx = 0;
    c.segProgress = 0;
    c.goal = `schedule:${desired}`;
    c.scheduleAnchor = desired;
  }
}

export function tickCharacters(s: GameState, now: number, dt: number) {
  for (const c of s.characters) {
    if (c.emote && now >= c.emote.until) c.emote = null;
    if (c.speech && now >= c.speech.until) c.speech = null;
    if (c.dead) { c.moving = false; c.path = null; continue; }
    if (c.path && c.pathIdx < c.path.length - 1) {
      // Peek at the next tile. If another live character currently occupies
      // it (within half a tile), pause this character's walk this frame —
      // keeps them from stacking on the same tile.
      const nextTile = c.path[c.pathIdx + 1];
      const occupied = s.characters.some((o) => {
        if (o.id === c.id || o.dead) return false;
        const d = Math.abs(o.pos.x - nextTile.x) + Math.abs(o.pos.y - nextTile.y);
        return d < 0.55;
      });
      if (occupied) {
        // Track how long this character has been blocked. After a short
        // wait they give up and stop rather than hover forever.
        const blockedFor = s.blockedAt[c.id] ?? now;
        s.blockedAt[c.id] = blockedFor;
        if (now - blockedFor > 1500) {
          c.path = null;
          c.moving = false;
          delete s.blockedAt[c.id];
        } else {
          c.moving = false;
        }
        continue;
      }
      delete s.blockedAt[c.id];
      c.segProgress += dt * WALK_SPEED;
      while (c.path && c.segProgress >= 1 && c.pathIdx < c.path.length - 1) {
        c.segProgress -= 1;
        c.pathIdx += 1;
      }
      if (c.path && c.pathIdx < c.path.length - 1) {
        const a = c.path[c.pathIdx];
        const b = c.path[c.pathIdx + 1];
        c.pos = {
          x: a.x + (b.x - a.x) * c.segProgress,
          y: a.y + (b.y - a.y) * c.segProgress,
        };
        c.facing = facingFrom(a, b);
        c.moving = true;
      } else if (c.path) {
        const end = c.path[c.path.length - 1];
        c.pos = { x: end.x, y: end.y };
        c.moving = false;
        // Face toward the center of the room after arriving, so characters
        // look "into" the scene rather than at a wall.
        const cx = (s.scene.map[0]?.length ?? 16) / 2;
        const cy = (s.scene.map.length ?? 11) / 2;
        const dx = cx - end.x;
        const dy = cy - end.y;
        if (Math.abs(dx) > Math.abs(dy)) {
          c.facing = dx > 0 ? "right" : "left";
        } else {
          c.facing = dy > 0 ? "down" : "up";
        }
        c.path = null;
      }
    } else {
      c.moving = false;
    }
  }
}

export function advanceNarration(s: GameState, dt: number, now: number) {
  // Reading pace. 28 cps ≈ 170 wpm — comfortable reading speed.
  const BASE_CPS = 28;
  const FAST_CPS = 90;
  const HOLD_MS = 2200;
  const speed = Math.max(0.5, Math.min(4, s.narrationSpeed || 1));
  if (!s.pending) {
    const next = s.narrationQueue.shift();
    if (next) {
      s.pending = { full: next.line, shown: 0, sealedAt: now, kind: next.kind };
    }
    return;
  }
  const p = s.pending;
  const lag = p.full.length - p.shown;
  if (lag > 0) {
    const cps = (lag > 500 ? FAST_CPS : BASE_CPS) * speed;
    p.shown = Math.min(p.full.length, p.shown + cps * dt);
    p.sealedAt = now;
    return;
  }
  if (p.sealedAt && now - p.sealedAt < HOLD_MS / speed) return;
  // Hold is over. Commit to the silent log (for LLM context) once.
  if (p.sealedAt !== null) {
    s.log.push({ id: newId(s), kind: p.kind, text: p.full, at: now });
    if (s.log.length > 80) s.log.splice(0, s.log.length - 80);
    p.sealedAt = null;
  }
  // Swap to the next queued line, or linger here until one arrives.
  if (s.narrationQueue.length > 0) {
    const next = s.narrationQueue.shift()!;
    s.pending = { full: next.line, shown: 0, sealedAt: now, kind: next.kind };
  }
}

// Instantly complete the current narration line (if typing) or advance past
// its hold (if already settled). Used by the "skip" button / click-on-line.
export function skipPending(s: GameState, now: number): void {
  if (!s.pending) return;
  const p = s.pending;
  if (p.shown < p.full.length) {
    p.shown = p.full.length;
    p.sealedAt = now - 10_000; // treat hold as already elapsed
    return;
  }
  // Already typed out; shortcut the hold and swap.
  s.log.push({ id: newId(s), kind: p.kind, text: p.full, at: now });
  if (s.log.length > 80) s.log.splice(0, s.log.length - 80);
  const next = s.narrationQueue.shift();
  s.pending = next
    ? { full: next.line, shown: 0, sealedAt: now, kind: next.kind }
    : null;
}

export function toggleNarrationSpeed(s: GameState): void {
  const cur = s.narrationSpeed || 1;
  s.narrationSpeed = cur >= 2 ? 1 : 2;
}

// ─── Ambient narrator ──────────────────────────────────────────────────────

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

// Fallback if the LLM ambient call fails. Kept short.
const AMBIENT_FALLBACK: string[] = [
  "The fire keeps its slow count.",
  "Wind at the eaves, then nothing.",
  "The room holds its weight, kindly.",
];

let ambientInFlight = false;

// Run an async side-effect with a watchdog. If the body hangs past
// `timeoutMs` (e.g., a wedged fetch), the flag is reset regardless so the
// loop unsticks. Logs a warning so we can diagnose in production.
function withWatchdog(
  label: string,
  reset: () => void,
  timeoutMs: number,
  onError: ((e: unknown) => void) | null,
  body: () => Promise<void>,
): void {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    console.warn(`[augur] ${label} timed out after ${timeoutMs}ms — resetting flag`);
    settled = true;
    reset();
  }, timeoutMs);
  void (async () => {
    try {
      await body();
    } catch (e) {
      if (onError) {
        try { onError(e); } catch { /* swallow */ }
      } else {
        console.warn(`[augur] ${label} failed`, e);
      }
    } finally {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reset();
      }
    }
  })();
}

export function maybeAmbient(s: GameState, now: number) {
  const GAP = 22_000;
  if (s.tension >= 100) return; // story has spent itself; let the silence hold
  if (now - s.lastAmbient < GAP) return;
  if (s.pending && s.pending.sealedAt !== null) return;
  if (s.activePlan || s.planQueue.length > 0) return;
  if (ambientInFlight) return;
  s.lastAmbient = now;
  ambientInFlight = true;
  withWatchdog(
    "maybeAmbient",
    () => { ambientInFlight = false; },
    45_000,
    () => { enqueue(s, [pick(AMBIENT_FALLBACK)], now, "ambient"); },
    async () => {
      const lines = await fetchNarration(
        s,
        { id: "ambient", title: "atmosphere", flavor: "" },
        1,
      );
      for (const line of lines) {
        s.narrationQueue.push({ line, kind: "ambient" });
      }
      if (!s.pending) {
        const next = s.narrationQueue.shift();
        if (next) {
          s.pending = { full: next.line, shown: 0, sealedAt: now, kind: next.kind };
        }
      }
    },
  );
}

// ─── Card plans (7 beats each) ─────────────────────────────────────────────

const LIBRARY_KEY = "rpg-rooms-v1";
const CURRENT_KEY = "rpg-current-v1";

export interface SavedRoom {
  id: string;
  name: string;
  snapshot: GameState;
  lastPlayedAt: number;
  createdAt: number;
  buildingId: string;
}

// Observers get notified on storage errors so the UI can surface them.
type StorageError =
  | { kind: "read"; key: string; error: unknown }
  | { kind: "write"; key: string; error: unknown; quotaLikely: boolean };

const storageErrorListeners = new Set<(e: StorageError) => void>();

export function onStorageError(fn: (e: StorageError) => void): () => void {
  storageErrorListeners.add(fn);
  return () => storageErrorListeners.delete(fn);
}

function reportStorageError(e: StorageError): void {
  console.warn("[augur] storage error", e);
  for (const fn of storageErrorListeners) {
    try { fn(e); } catch { /* swallow */ }
  }
}

function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string })?.name ?? "";
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    /quota/i.test(String((err as { message?: string })?.message ?? ""))
  );
}

// ─── IndexedDB-backed library ─────────────────────────────────────────────
// Rooms live in an in-memory cache that reads and writes mirror. On boot we
// lazily hydrate from IDB (preferred, ~50MB+ quota) or localStorage (legacy,
// ~5MB). Every write persists to IDB async; we also keep localStorage in
// sync for the first few small rooms as a belt-and-braces backup.

const IDB_NAME = "augur";
const IDB_STORE = "rooms";
const IDB_STORE_BUILDINGS = "buildings";
const IDB_VERSION = 2;

let libraryCache: Record<string, SavedRoom> | null = null;
let hydratePromise: Promise<void> | null = null;

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_BUILDINGS)) {
        db.createObjectStore(IDB_STORE_BUILDINGS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb open failed"));
  });
}

async function idbGetAll(): Promise<SavedRoom[]> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => resolve((req.result as SavedRoom[]) ?? []);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

async function idbPut(room: SavedRoom): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(room);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    } catch (e) {
      reject(e);
    }
  });
}

async function idbDelete(id: string): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    } catch (e) {
      reject(e);
    }
  });
}

function readLocalLibrary(): Record<string, SavedRoom> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, SavedRoom>;
  } catch (error) {
    reportStorageError({ kind: "read", key: LIBRARY_KEY, error });
    return {};
  }
}

function writeLocalLibrary(lib: Record<string, SavedRoom>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
  } catch (error) {
    // Quota errors on localStorage aren't fatal anymore — IDB is the truth.
    // Only report non-quota errors so we don't spam toasts on a full LS.
    if (!isQuotaError(error)) {
      reportStorageError({
        kind: "write",
        key: LIBRARY_KEY,
        error,
        quotaLikely: false,
      });
    }
  }
}

// Kick off async hydration from IDB. Safe to call multiple times.
export function hydrateLibrary(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    const local = readLocalLibrary();
    // Seed the cache immediately with local data so sync reads work.
    libraryCache = { ...local };
    if (typeof indexedDB === "undefined") return;
    try {
      const rows = await idbGetAll();
      if (rows.length === 0 && Object.keys(local).length > 0) {
        // Migrate legacy localStorage rooms to IDB.
        for (const r of Object.values(local)) {
          try { await idbPut(r); } catch { /* ignore single failures */ }
        }
        return;
      }
      const merged: Record<string, SavedRoom> = { ...libraryCache };
      for (const r of rows) {
        const existing = merged[r.id];
        if (!existing || (r.lastPlayedAt ?? 0) >= (existing.lastPlayedAt ?? 0)) {
          merged[r.id] = r;
        }
      }
      libraryCache = merged;
      notifyLibraryChanged();
    } catch (error) {
      reportStorageError({ kind: "read", key: IDB_STORE, error });
    }
  })();
  return hydratePromise;
}

const libraryChangeListeners = new Set<() => void>();

export function onLibraryChanged(fn: () => void): () => void {
  libraryChangeListeners.add(fn);
  return () => libraryChangeListeners.delete(fn);
}

function notifyLibraryChanged(): void {
  for (const fn of libraryChangeListeners) {
    try { fn(); } catch { /* swallow */ }
  }
}

function readLibrary(): Record<string, SavedRoom> {
  if (libraryCache) return libraryCache;
  // Not yet hydrated — fall back to localStorage synchronously.
  libraryCache = readLocalLibrary();
  // Fire hydration in the background.
  void hydrateLibrary();
  return libraryCache;
}

function writeLibrary(lib: Record<string, SavedRoom>): void {
  libraryCache = lib;
  writeLocalLibrary(lib);
  // IDB writes happen per-room in saveRoom/deleteRoom for precision.
}

export function listRooms(): SavedRoom[] {
  return Object.values(readLibrary()).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}

export function saveRoom(s: GameState): void {
  if (!s.roomId || s.phase !== "playing") return;
  const lib = { ...readLibrary() };
  const existing = lib[s.roomId];
  const snapshot: GameState = {
    ...s,
    activePlan: null,
    planQueue: [],
    pending: null,
    narrationQueue: [],
    history: [], // don't bloat localStorage with rewind snapshots
    paused: false,
  };
  const entry: SavedRoom = {
    id: s.roomId,
    name: s.scene.name,
    snapshot,
    lastPlayedAt: Date.now(),
    createdAt: existing?.createdAt ?? Date.now(),
    buildingId: s.buildingId || "",
  };
  lib[s.roomId] = entry;
  writeLibrary(lib);
  try { localStorage.setItem(CURRENT_KEY, s.roomId); } catch { /* ignore */ }
  void idbPut(entry).catch((error) => {
    reportStorageError({
      kind: "write",
      key: IDB_STORE,
      error,
      quotaLikely: isQuotaError(error),
    });
  });
  notifySyncNeeded("room", entry);
}

export function loadRoomById(id: string, now: number): GameState | null {
  const lib = readLibrary();
  const entry = lib[id];
  if (!entry) return null;
  const snap = entry.snapshot;
  snap.simStartedAt = now - 1000;
  snap.lastAmbient = now;
  snap.activePlan = null;
  snap.planQueue = [];
  snap.pending = null;
  snap.narrationQueue = [];
  snap.phase = "playing";
  snap.paused = false;
  if (!Array.isArray(snap.history)) snap.history = [];
  if (!snap.blockedAt || typeof snap.blockedAt !== "object") snap.blockedAt = {};
  if (typeof snap.storySummary !== "string") snap.storySummary = "";
  if (typeof snap.summaryBeatsAt !== "number") snap.summaryBeatsAt = 0;
  if (typeof snap.narrationSpeed !== "number") snap.narrationSpeed = 1;
  if (typeof snap.buildingId !== "string") snap.buildingId = "";
  if (typeof snap.floorIndex !== "number") snap.floorIndex = -1;
  if (typeof snap.inheritedMemory !== "string") snap.inheritedMemory = "";
  return snap;
}

export function deleteRoom(id: string): void {
  const lib = { ...readLibrary() };
  delete lib[id];
  writeLibrary(lib);
  void idbDelete(id).catch(() => { /* non-fatal */ });
}

export function currentRoomId(): string | null {
  if (typeof localStorage === "undefined") return null;
  try { return localStorage.getItem(CURRENT_KEY); } catch { return null; }
}

export function clearCurrentRoomId(): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.removeItem(CURRENT_KEY); } catch { /* ignore */ }
}

// Compat shims (in case other code calls them).
export function saveState(s: GameState): void { saveRoom(s); }
export function loadState(now: number): GameState | null {
  const id = currentRoomId();
  return id ? loadRoomById(id, now) : null;
}
export function clearSaved(): void { clearCurrentRoomId(); }

// ─── Building persistence ─────────────────────────────────────────────────

let buildingCache: BuildingState | null = null;
const BUILDING_LS_KEY = "rpg-building-v1";

async function idbGetBuilding(id: string): Promise<BuildingState | null> {
  try {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_BUILDINGS, "readonly");
      const req = tx.objectStore(IDB_STORE_BUILDINGS).get(id);
      req.onsuccess = () => resolve((req.result as BuildingState) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbPutBuilding(b: BuildingState): Promise<void> {
  try {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_BUILDINGS, "readwrite");
      tx.objectStore(IDB_STORE_BUILDINGS).put(b);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* non-fatal */
  }
}

async function idbGetAllBuildings(): Promise<BuildingState[]> {
  try {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_BUILDINGS, "readonly");
      const req = tx.objectStore(IDB_STORE_BUILDINGS).getAll();
      req.onsuccess = () => resolve((req.result as BuildingState[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function loadBuilding(): Promise<BuildingState | null> {
  if (buildingCache) return ensureProgressState(buildingCache);
  try {
    const all = await idbGetAllBuildings();
    if (all.length > 0) {
      all.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0));
      buildingCache = ensureProgressState(all[0]);
      return buildingCache;
    }
  } catch {
    /* fall through */
  }
  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(BUILDING_LS_KEY);
      if (raw) {
        buildingCache = ensureProgressState(JSON.parse(raw) as BuildingState);
        void idbPutBuilding(buildingCache);
        return buildingCache;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

const syncListeners = new Set<(kind: "building" | "room", data: unknown) => void>();

export function onSyncNeeded(fn: (kind: "building" | "room", data: unknown) => void): () => void {
  syncListeners.add(fn);
  return () => syncListeners.delete(fn);
}

function notifySyncNeeded(kind: "building" | "room", data: unknown): void {
  for (const fn of syncListeners) {
    try { fn(kind, data); } catch { /* swallow */ }
  }
}

export async function saveBuilding(b: BuildingState): Promise<void> {
  buildingCache = b;
  void idbPutBuilding(b);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(BUILDING_LS_KEY, JSON.stringify(b));
    } catch { /* quota — non-fatal */ }
  }
  notifyLibraryChanged();
  notifySyncNeeded("building", b);
}

// ─── Building: extraction + spending ──────────────────────────────────────

export function extractSurvivors(s: GameState): SurvivorRecord[] {
  return s.characters
    .filter((c) => !c.dead && !c.transient)
    .map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      palette: { ...c.palette },
      backstory: c.backstory,
      objective: c.objective,
      motive: c.motive,
      inventory: [...c.inventory].slice(0, 5),
      roomsLived: 1,
      originRoomId: s.roomId,
    }));
}

export function extractGhosts(
  s: GameState,
  roomId: string,
  roomName: string,
): GhostRecord[] {
  return s.characters
    .filter((c) => c.dead && !c.transient)
    .map((c) => {
      const deathLine = [...s.log]
        .reverse()
        .find((l) => l.text.includes(c.name) && (l.kind === "action" || l.text.toLowerCase().includes("die") || l.text.toLowerCase().includes("fall")));
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        causeOfDeath: deathLine?.text ?? `${c.name} did not survive.`,
        diedInRoomId: roomId,
        diedInRoomName: roomName,
        beatsLived: s.beatsPlayed,
      };
    });
}

export function spendRoom(
  s: GameState,
  building: BuildingState,
  epitaph: string,
): void {
  const survivors = extractSurvivors(s);
  const ghosts = extractGhosts(s, s.roomId, s.scene.name);

  const floor: SpentFloor = {
    id: s.roomId,
    name: s.scene.name,
    epitaph: epitaph || "The room is quiet now.",
    stakes: s.stakes,
    storySummary: s.storySummary,
    survivors,
    ghosts,
    tension: Math.round(s.tension),
    beatsPlayed: s.beatsPlayed,
    spentAt: Date.now(),
    createdAt: building.floors.length === 0 ? building.createdAt : Date.now(),
    thumbnailScene: s.scene,
    thumbnailCharacters: s.characters.map((c) => ({
      pos: { ...c.pos },
      palette: { ...c.palette },
      dead: c.dead,
    })),
  };

  building.floors.push(floor);
  // Update progress metrics so objectives can evaluate.
  recordFloorSealed(building, floor);
  // Count how many spawned strangers showed up on this floor.
  const spawnedHere = s.characters.filter((c) => c.transient).length;
  if (spawnedHere > 0) {
    ensureProgressState(building);
    building.metrics!.spawnsEver += spawnedHere;
  }

  // Merge survivors into building roster. Characters who already exist
  // (survived a prior room) get updated; new characters are added.
  for (const sv of survivors) {
    const existing = building.roster.find((r) => r.name === sv.name);
    if (existing) {
      existing.backstory = sv.backstory;
      existing.objective = sv.objective;
      existing.motive = sv.motive;
      existing.inventory = sv.inventory;
      existing.palette = sv.palette;
      existing.description = sv.description;
      existing.roomsLived += 1;
    } else {
      building.roster.push(sv);
    }
  }

  // Append new ghosts.
  for (const g of ghosts) {
    building.ghosts.push(g);
    // Remove from roster if they were there.
    building.roster = building.roster.filter((r) => r.name !== g.name);
  }

  // Move unclaimed room items to building globals (capped).
  const heldItems = new Set(building.roster.flatMap((r) => r.inventory));
  for (const ri of s.roomItems) {
    if (!heldItems.has(ri.name) && building.globalItems.length < 20) {
      building.globalItems.push(ri.name);
    }
  }

  building.activeRoomId = null;
  building.lastPlayedAt = Date.now();
  updateStreak(building);
}

export function updateStreak(b: BuildingState): void {
  const today = new Intl.DateTimeFormat("en-CA").format(new Date());
  if (b.streak.lastPlayedDate === today) return;
  const yesterday = new Intl.DateTimeFormat("en-CA").format(
    new Date(Date.now() - 86_400_000),
  );
  if (b.streak.lastPlayedDate === yesterday) {
    b.streak.currentStreak += 1;
  } else if (b.streak.lastPlayedDate !== today) {
    b.streak.currentStreak = 1;
  }
  b.streak.longestStreak = Math.max(
    b.streak.longestStreak,
    b.streak.currentStreak,
  );
  b.streak.lastPlayedDate = today;
  b.streak.totalRoomsPlayed += 1;
}

export function buildInheritedMemory(b: BuildingState): string {
  const parts: string[] = [];
  const lastFloor = b.floors[b.floors.length - 1];
  if (lastFloor?.storySummary) {
    parts.push(`In the previous room ("${lastFloor.name}"): ${lastFloor.storySummary}`);
  }
  if (b.ghosts.length > 0) {
    const ghostLines = b.ghosts.slice(-3).map(
      (g) => `${g.name} died in "${g.diedInRoomName}" (${g.causeOfDeath.slice(0, 80)}).`,
    );
    parts.push(`Dead: ${ghostLines.join(" ")}`);
  }
  if (b.roster.length > 0) {
    const rosterLines = b.roster.slice(0, 3).map(
      (r) =>
        `${r.name}${r.inventory.length > 0 ? ` (carries: ${r.inventory.join(", ")})` : ""}: ${r.objective || r.description}`,
    );
    parts.push(`Survivors: ${rosterLines.join("; ")}`);
  }
  return parts.join("\n").slice(0, 600);
}

export const MAX_PARTY = 3;

export function survivorsToCharacters(
  survivors: SurvivorRecord[],
  scene: Scene,
): Character[] {
  const names = Object.keys(scene.anchors);
  const anchorCount = names.length;
  // Spread across the room — pick three evenly-spaced anchors for up to MAX_PARTY characters.
  const pickAnchor = (i: number, total: number): string => {
    if (anchorCount === 0) return "center";
    const idx = Math.floor((i / Math.max(1, total)) * anchorCount);
    return names[Math.min(idx, anchorCount - 1)] ?? "center";
  };
  const taken = survivors.slice(0, MAX_PARTY);
  return taken.map((sv, i) => {
    const anchorName = pickAnchor(i, taken.length);
    const anchor = scene.anchors[anchorName] ?? { x: 4, y: 4 };
    return {
      id: sv.id,
      name: sv.name,
      description: sv.description,
      pos: { x: anchor.x, y: anchor.y },
      facing: "down" as const,
      moving: false,
      path: null,
      pathIdx: 0,
      segProgress: 0,
      goal: null,
      palette: { ...sv.palette },
      emote: null,
      speech: null,
      mood: "watchful" as const,
      inventory: [...sv.inventory],
      backstory: sv.backstory,
      objective: sv.objective,
      motive: sv.motive,
      hp: 3,
      dead: false,
      transient: false,
      schedule: makeScheduleFrom(names),
      scheduleAnchor: null,
    };
  });
}

export async function fetchEpitaph(s: GameState): Promise<string> {
  const EPITAPH_URL = `${API_BASE}/api/rpg/epitaph`;
  try {
    const resp = await fetch(EPITAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sceneName: s.scene.name,
        stakes: s.stakes,
        storySummary: s.storySummary,
        characters: s.characters.filter((c) => !c.transient).map((c) => ({
          name: c.name,
          alive: !c.dead,
          objective: c.objective,
        })),
        finalLog: s.log.slice(-8).map((l) => l.text),
      }),
    });
    if (!resp.ok) throw new Error(`epitaph ${resp.status}`);
    const data = (await resp.json()) as { epitaph?: string };
    if (typeof data.epitaph === "string" && data.epitaph.trim()) {
      return data.epitaph.trim();
    }
  } catch {
    /* fall through */
  }
  return "The room is quiet now.";
}

// ─── Room packs (shareable v1) ────────────────────────────────────────────
// A RoomPack is the portable subset of a room — scene geometry, palette,
// seed characters (reset to a fresh state), and the narrative setup. It
// travels in a URL hash fragment so recipients can open a friend's room
// without a round-trip to the worker.

export interface RoomPackV1 {
  v: 1;
  name: string;
  scene: Scene;
  characters: Character[];
  roomContext: string;
  stakes: string;
  roomItems: RoomItem[];
  cardSkins: Record<string, { title: string; flavor: string }>;
}

function sanitizeForPack(s: GameState): RoomPackV1 {
  const chars = s.characters
    .filter((c) => !c.transient)
    .map((c) => ({
      ...c,
      pos: { ...c.pos },
      path: null,
      pathIdx: 0,
      segProgress: 0,
      moving: false,
      goal: null,
      emote: null,
      speech: null,
      hp: 3,
      dead: false,
    }));
  return {
    v: 1,
    name: s.scene.name || "Untitled",
    scene: s.scene,
    characters: chars,
    roomContext: s.roomContext,
    stakes: s.stakes,
    roomItems: [...s.roomItems],
    cardSkins: { ...s.cardSkins },
  };
}

function b64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(b64: string): string {
  const pad = b64.length % 4 === 2 ? "==" : b64.length % 4 === 3 ? "=" : "";
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function packRoom(s: GameState): RoomPackV1 {
  return sanitizeForPack(s);
}

export function encodeRoomPack(pack: RoomPackV1): string {
  return b64urlEncode(JSON.stringify(pack));
}

export function decodeRoomPack(encoded: string): RoomPackV1 | null {
  try {
    const obj = JSON.parse(b64urlDecode(encoded));
    if (!obj || obj.v !== 1) return null;
    if (!obj.scene || !Array.isArray(obj.scene.map)) return null;
    if (!Array.isArray(obj.characters)) return null;
    return obj as RoomPackV1;
  } catch {
    return null;
  }
}

// Compressed pack: deflate-raw(JSON) → base64url. ~70% smaller than plain.
// Falls back to uncompressed when CompressionStream isn't available.
async function deflateToB64Url(str: string): Promise<string> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  void writer.write(new TextEncoder().encode(str));
  void writer.close();
  const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function inflateFromB64Url(b64: string): Promise<string> {
  const pad = b64.length % 4 === 2 ? "==" : b64.length % 4 === 3 ? "=" : "";
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return await new Response(ds.readable).text();
}

export async function buildShareUrl(s: GameState): Promise<string> {
  const pack = packRoom(s);
  const json = JSON.stringify(pack);
  const base = typeof location !== "undefined"
    ? `${location.origin}${location.pathname}`
    : "";
  if (typeof CompressionStream !== "undefined") {
    try {
      const z = await deflateToB64Url(json);
      return `${base}#rz=${z}`;
    } catch {
      // fall through to plain
    }
  }
  return `${base}#r=${b64urlEncode(json)}`;
}

export function importPack(pack: RoomPackV1, now: number): SavedRoom {
  const id = newRoomId();
  const snap = initialState(now);
  snap.phase = "playing";
  snap.roomId = id;
  snap.scene = pack.scene;
  snap.characters = pack.characters.map((c) => ({ ...c, pos: { ...c.pos } }));
  snap.roomContext = pack.roomContext;
  snap.stakes = pack.stakes;
  snap.roomItems = [...pack.roomItems];
  snap.cardSkins = { ...pack.cardSkins };
  snap.simStartedAt = now - 1000;
  snap.lastAmbient = now;
  const lib = readLibrary();
  const entry: SavedRoom = {
    id,
    name: pack.name,
    snapshot: snap,
    lastPlayedAt: Date.now(),
    createdAt: Date.now(),
    buildingId: "",
  };
  lib[id] = entry;
  writeLibrary(lib);
  try { localStorage.setItem(CURRENT_KEY, id); } catch { /* ignore */ }
  return entry;
}

export function hasSharedRoomInUrl(): boolean {
  if (typeof location === "undefined") return false;
  return /[#&]r[z]?=[A-Za-z0-9_-]+/.test(location.hash || "");
}

// On boot, read location.hash for a shared room. Handles both the compact
// `#rz=<deflate-raw+b64url>` and legacy `#r=<b64url-json>` forms. Clears
// the hash after reading so reloads don't re-import.
export async function consumeSharedRoomFromUrl(
  now: number,
): Promise<SavedRoom | null> {
  if (typeof location === "undefined") return null;
  const h = location.hash || "";
  const mz = h.match(/[#&]rz=([A-Za-z0-9_-]+)/);
  const m = h.match(/[#&]r=([A-Za-z0-9_-]+)/);
  if (!mz && !m) return null;
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    /* ignore */
  }
  let pack: RoomPackV1 | null = null;
  if (mz) {
    try {
      const json = await inflateFromB64Url(mz[1]);
      const obj = JSON.parse(json);
      if (obj && obj.v === 1 && obj.scene && Array.isArray(obj.scene.map) && Array.isArray(obj.characters)) {
        pack = obj as RoomPackV1;
      }
    } catch {
      /* try legacy */
    }
  }
  if (!pack && m) pack = decodeRoomPack(m[1]);
  if (!pack) return null;
  return importPack(pack, now);
}

export function initialState(now: number): GameState {
  return {
    phase: "setup",
    scene: SCENES.cabin, // placeholder; replaced when seed is picked
    characters: CHARACTERS.map((c) => ({ ...c })),
    hand: [...CARDS],
    activePlan: null,
    planQueue: [],
    log: [],
    pending: null,
    narrationQueue: [],
    simStartedAt: now,
    lastAmbient: now,
    nextId: 0,
    selectedCardIds: [],
    activeMoment: null,
    roomContext: "",
    cardSkins: {},
    flags: {},
    tension: 0,
    beatsPlayed: 0,
    roomItems: [],
    stakes: "",
    roomId: "",
    lastDirectedAt: 0,
    paused: false,
    history: [],
    blockedAt: {},
    storySummary: "",
    summaryBeatsAt: 0,
    narrationSpeed: 1,
    buildingId: "",
    floorIndex: -1,
    inheritedMemory: "",
  };
}

// ─── Pause / rewind ───────────────────────────────────────────────────────
// Rewind snapshots are a ring of "pre-plan" GameStates. We capture one each
// time a plan is about to start; rewind pops the most recent and restores
// the room to that moment (discarding the plan that just ran and anything
// still queued). Bounded to keep memory predictable.

const HISTORY_MAX = 10;

export type HistorySnapshot = Omit<GameState, "history">;

// Snapshots are optionally compressed in-memory to keep rewind cheap. We
// capture synchronously (structured clone) and then, if CompressionStream
// is available, swap the slot for a compressed byte array in the background
// — typically ~10x smaller. Rewind handles either shape.
interface CompressedEntry {
  __compressed: true;
  bytes: Uint8Array;
}
type HistoryEntry = HistorySnapshot | CompressedEntry;

function isCompressedEntry(e: HistoryEntry): e is CompressedEntry {
  return (e as CompressedEntry)?.__compressed === true;
}

async function deflateBytes(str: string): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  void writer.write(new TextEncoder().encode(str));
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function inflateBytes(bytes: Uint8Array): Promise<string> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  // Cast tightens the buffer-backed type so DOM types accept it.
  void writer.write(bytes as unknown as Uint8Array<ArrayBuffer>);
  void writer.close();
  return await new Response(ds.readable).text();
}

export function captureHistory(s: GameState): void {
  const { history: _h, ...rest } = s;
  let snap: HistorySnapshot;
  try {
    snap = structuredClone(rest) as HistorySnapshot;
  } catch {
    snap = JSON.parse(JSON.stringify(rest)) as HistorySnapshot;
  }
  // History is typed as HistorySnapshot[] externally; we store HistoryEntry
  // internally and cast at the boundary.
  const entries = s.history as unknown as HistoryEntry[];
  entries.push(snap);
  if (entries.length > HISTORY_MAX) entries.shift();
  if (typeof CompressionStream !== "undefined") {
    void (async () => {
      try {
        const bytes = await deflateBytes(JSON.stringify(snap));
        const i = entries.indexOf(snap);
        if (i >= 0) entries[i] = { __compressed: true, bytes };
      } catch {
        /* keep uncompressed */
      }
    })();
  }
}

export async function rewindOne(s: GameState): Promise<boolean> {
  const entries = s.history as unknown as HistoryEntry[];
  const prev = entries.pop();
  if (!prev) return false;
  let snap: HistorySnapshot;
  if (isCompressedEntry(prev)) {
    try {
      snap = JSON.parse(await inflateBytes(prev.bytes)) as HistorySnapshot;
    } catch (e) {
      console.warn("[augur] rewind: inflate failed", e);
      return false;
    }
  } else {
    snap = prev;
  }
  for (const k of Object.keys(snap) as (keyof HistorySnapshot)[]) {
    (s as unknown as Record<string, unknown>)[k] =
      (snap as unknown as Record<string, unknown>)[k];
  }
  s.activePlan = null;
  s.planQueue = [];
  s.pending = null;
  s.narrationQueue = [];
  s.blockedAt = {};
  return true;
}

export function newRoomId(): string {
  return `room_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Build a deterministic-feeling 24h schedule from a list of available
// anchors. Used for AI-generated rooms where we don't know the anchor
// names in advance.
export function makeScheduleFrom(anchors: string[]): ScheduleSlot[] {
  if (anchors.length === 0) return [{ fromHour: 0, anchor: "center" }];
  const slots: ScheduleSlot[] = [];
  const hours = [0, 5, 9, 13, 17, 21];
  for (let i = 0; i < hours.length; i++) {
    slots.push({ fromHour: hours[i], anchor: anchors[i % anchors.length] });
  }
  return slots;
}

// Apply a scene to the live state: swap map/anchors, reset character
// positions to the scene's starting anchors, replace their schedules so
// each anchor reference resolves in this scene.
export function applyScene(s: GameState, scene: Scene): void {
  s.scene = scene;
  s.flags = {};
  s.tension = 0;
  s.beatsPlayed = 0;
  s.roomItems = [];
  s.stakes = "";
  s.blockedAt = {};
  s.storySummary = "";
  s.summaryBeatsAt = 0;
  s.characters = s.characters.filter((c) => !c.transient);
  s.characters.forEach((c, i) => {
    const positional = `slot_${i}`;
    const startName =
      scene.starts[c.id] ?? scene.starts[positional] ?? "center";
    const startTile = scene.anchors[startName] ?? { x: 4, y: 4 };
    c.pos = { x: startTile.x, y: startTile.y };
    c.path = null;
    c.pathIdx = 0;
    c.segProgress = 0;
    c.goal = null;
    c.scheduleAnchor = null;
    c.schedule =
      scene.schedules[c.id] ?? scene.schedules[positional] ?? c.schedule;
    c.inventory = [];
    c.backstory = "";
    c.objective = "";
    c.motive = "";
    c.hp = 3;
    c.dead = false;
  });
}

function mkPlan(s: GameState, title: string, steps: Tool[]): Plan {
  return { id: newId(s), title, steps, cursor: 0, blocked: null };
}

// Resolve the first two non-transient characters (the "core cast" for a
// room). Falls back to whichever characters exist. Card plans reference
// characters by this position instead of hardcoded "marrow"/"soren" so
// they still work after the cast has been regenerated per room.
function coreCast(s: GameState): { aId: string; bId: string; aName: string; bName: string } {
  const core = s.characters.filter((c) => !c.transient);
  const a = core[0] ?? s.characters[0];
  const b = core[1] ?? s.characters[1] ?? a;
  return {
    aId: a?.id ?? "a",
    bId: b?.id ?? "b",
    aName: a?.name ?? "they",
    bName: b?.name ?? "they",
  };
}

export function buildPlan(s: GameState, card: CardDef): Plan {
  const { aId, bId, aName, bName } = coreCast(s);
  switch (card.id) {
    case "knock":
      return mkPlan(s, card.title, [
        { op: "narrate", text: "A single knock. Then the room's own silence, uninterrupted." },
        { op: "emote", charId: aId, kind: "startle", ms: 1400 },
        { op: "walk", charId: aId, toAnchor: "door_in" },
        { op: "face", charId: aId, facing: "down" },
        { op: "narrate", text: `${aName} opens the door. Night. No one. A patch of cold where someone might have been.` },
        { op: "wait", ms: 1200 },
        { op: "narrate", text: `${aName} closes the door. The fire resumes its counting.` },
      ]);
    case "rain":
      return mkPlan(s, card.title, [
        { op: "narrate", text: "Rain arrives, the soft kind that pretends to be nothing." },
        { op: "walk", charId: bId, toAnchor: "window" },
        { op: "emote", charId: bId, kind: "still", ms: 1800 },
        { op: "narrate", text: `${bName} watches it until it isn't rain anymore. Snow, then, unhurried.` },
        { op: "emote", charId: aId, kind: "warm", ms: 1500 },
        { op: "wait", ms: 1100 },
        { op: "narrate", text: "The room rearranges itself around the weather, without anyone asking." },
      ]);
    case "memory":
      return mkPlan(s, card.title, [
        { op: "narrate", text: `${bName} goes still over the bowl.` },
        { op: "walk", charId: bId, toAnchor: "window" },
        { op: "emote", charId: bId, kind: "sad", ms: 2000 },
        { op: "narrate", text: "For a moment, not here. Somewhere colder, or warmer, or simply earlier." },
        { op: "wait", ms: 1400 },
        { op: "emote", charId: aId, kind: "still", ms: 1600 },
        { op: "narrate", text: `${aName} does not ask. Has never asked, and is practiced in it.` },
      ]);
    case "question":
      return mkPlan(s, card.title, [
        { op: "narrate", text: `${bName} asks, without preamble: where were you, that year.` },
        { op: "walk", charId: aId, toAnchor: "hearth" },
        { op: "emote", charId: aId, kind: "puzzle", ms: 1600 },
        { op: "wait", ms: 1300 },
        { op: "narrate", text: `${aName} takes the log first. Then the answer. Then, a longer time, nothing.` },
        { op: "emote", charId: bId, kind: "still", ms: 1600 },
        { op: "narrate", text: `${bName} accepts the silence as a kind of answer. It is not an unkind one.` },
      ]);
    case "fire":
      return mkPlan(s, card.title, [
        { op: "narrate", text: "The fire gutters, a slight unseriousness." },
        { op: "walk", charId: aId, toAnchor: "hearth" },
        { op: "emote", charId: aId, kind: "warm", ms: 1400 },
        { op: "narrate", text: `${aName} feeds it a careful piece. The flame remembers what it is for.` },
        { op: "wait", ms: 1100 },
        { op: "emote", charId: bId, kind: "warm", ms: 1200 },
        { op: "narrate", text: "The room comes back, degree by degree." },
      ]);
    case "silence":
      return mkPlan(s, card.title, [
        { op: "narrate", text: `${bName} begins to speak, and then, after reflection, does not.` },
        { op: "emote", charId: bId, kind: "puzzle", ms: 1400 },
        { op: "wait", ms: 1300 },
        { op: "emote", charId: aId, kind: "still", ms: 1500 },
        { op: "narrate", text: `${aName} lets the sentence go where sentences go, when they aren't said.` },
        { op: "wait", ms: 1200 },
        { op: "narrate", text: "The room is fuller for the thing not said. Rooms usually are." },
      ]);
  }
  return mkPlan(s, card.title, [{ op: "narrate", text: `${card.title}.` }]);
}

export function playCard(s: GameState, card: CardDef, now: number) {
  s.planQueue.push(buildPlan(s, card));
  void now;
}

// ─── Real LLM narrator ─────────────────────────────────────────────────────
// Call the worker's /api/rpg/narrate endpoint, splice the returned lines into
// the template plan's narrate steps. Structure (walk/emote/wait/face) stays
// authored so the sim remains legible. If the worker fails, fall back to the
// fully-templated plan.

const API_BASE =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:8788"
    : "https://augur.carl-lewis.workers.dev";
const NARRATE_URL = `${API_BASE}/api/rpg/narrate`;
const ROOM_URL = `${API_BASE}/api/rpg/room`;

export interface RoomItem {
  name: string;
  description: string;
  anchor?: string;
}

export interface CharProfile {
  name?: string;
  description?: string;
  palette?: "warm" | "cool" | "moss" | "rust" | "ash" | "bone";
  backstory?: string;
  objective?: string;
  motive?: string;
}

export const CHARACTER_PALETTES: Record<
  "warm" | "cool" | "moss" | "rust" | "ash" | "bone",
  { body: string; cloak: string; accent: string }
> = {
  warm: { body: "#e8d0a8", cloak: "#5a4432", accent: "#c89a3a" },
  cool: { body: "#d8b89a", cloak: "#3a4a6a", accent: "#8ab0c8" },
  moss: { body: "#d4c4a0", cloak: "#3e5a3a", accent: "#8aa87c" },
  rust: { body: "#e4c0a0", cloak: "#6a3a2e", accent: "#c87a4a" },
  ash:  { body: "#c8bca8", cloak: "#484848", accent: "#a0a0a0" },
  bone: { body: "#f0e4c8", cloak: "#746a5a", accent: "#d8c8a0" },
};

export interface GeneratedRoom {
  name: string;
  map: string[];
  anchors: Record<string, [number, number]>;
  palette?: Record<string, PaletteEntry>;
  lines: string[];
  items?: RoomItem[];
  stakes?: string;
  openingFlags?: Record<string, string>;
  moods?: { marrow?: string; soren?: string };
  profiles?: { marrow?: CharProfile; soren?: CharProfile };
}

export async function fetchRoom(prompt: string): Promise<GeneratedRoom> {
  const resp = await fetch(ROOM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!resp.ok) throw new Error(`room ${resp.status}`);
  const data = (await resp.json()) as GeneratedRoom;
  if (!data.map || !data.anchors || !data.lines) throw new Error("bad room json");
  return data;
}

// Streaming variant: worker emits SSE phase events while specialists run in
// parallel. We merge partial `room` fragments as they arrive and call
// `onPhase` so the UI can drive a real progress bar. Resolves with the final
// merged room (the `done` payload).
export interface BuildingContext {
  survivors: Array<{
    name: string;
    description: string;
    backstory: string;
    inventory: string[];
  }>;
  ghosts: Array<{
    name: string;
    description: string;
    causeOfDeath: string;
    diedInRoomName: string;
  }>;
  previousRoomSummary: string;
  floorNumber: number;
}

export async function streamRoom(
  prompt: string,
  onPhase: (phase: string, partial: Partial<GeneratedRoom>) => void,
  buildingContext?: BuildingContext,
): Promise<GeneratedRoom> {
  const body: Record<string, unknown> = { prompt };
  if (buildingContext) body.buildingContext = buildingContext;
  const resp = await fetch(ROOM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`room ${resp.status}`);
  if (!resp.body) throw new Error("room: no response body");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Accumulate fragments from every phase into one merged room object.
  const merged: Partial<GeneratedRoom> = {};
  let doneSeen = false;
  let errorMsg: string | null = null;

  const handleEvent = (rawData: string) => {
    const text = rawData.trim();
    if (!text) return;
    let payload: {
      phase?: string;
      room?: Partial<GeneratedRoom>;
      error?: string;
    };
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    const phase = payload.phase ?? "";
    if (phase === "error") {
      errorMsg = payload.error ?? "stream error";
      return;
    }
    const partial = payload.room ?? {};
    // Merge into the running room object. Later fragments win for any
    // overlapping key (typically the "done" payload is authoritative).
    Object.assign(merged, partial);
    if (phase === "done") {
      doneSeen = true;
    }
    onPhase(phase, partial);
  };

  // SSE framing: events are separated by blank lines; each line may be a
  // `data:` line. We only care about `data:` lines here.
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines: string[] = [];
      for (const line of event.split("\n")) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (dataLines.length > 0) handleEvent(dataLines.join("\n"));
      sep = buffer.indexOf("\n\n");
    }
  }
  // Flush any trailing event lacking a terminating blank line.
  if (buffer.trim()) {
    const dataLines: string[] = [];
    for (const line of buffer.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length > 0) handleEvent(dataLines.join("\n"));
  }

  if (errorMsg) throw new Error(errorMsg);
  if (!merged.map || !merged.anchors || !merged.lines) {
    throw new Error(
      doneSeen ? "bad room stream payload" : "room stream ended without done",
    );
  }
  return merged as GeneratedRoom;
}

// Adapt a worker-shaped GeneratedRoom into a Scene (with starts + schedules).
export function sceneFromRoom(room: GeneratedRoom): Scene {
  const anchors: Record<string, Tile> = {};
  for (const [name, [x, y]] of Object.entries(room.anchors)) {
    anchors[name] = { x, y };
  }
  if (!anchors["center"]) {
    // Fallback: pick first walkable tile
    for (let r = 0; r < room.map.length; r++) {
      const row = room.map[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c] === ".") {
          anchors["center"] = { x: c, y: r };
          break;
        }
      }
      if (anchors["center"]) break;
    }
  }
  const names = Object.keys(anchors);
  const half = Math.ceil(names.length / 2);
  // We key starts/schedules by both the legacy slot ids ("marrow"/"soren")
  // AND by positional keys ("slot_0"/"slot_1"). applyScene falls back to
  // positional when a character's id doesn't match a slot name directly.
  return {
    id: `gen_${Date.now()}`,
    name: room.name || "a room",
    map: room.map,
    anchors,
    palette: room.palette,
    starts: {
      marrow: names[0] ?? "center",
      soren: names[half] ?? names[1] ?? "center",
      slot_0: names[0] ?? "center",
      slot_1: names[half] ?? names[1] ?? "center",
    },
    schedules: {
      marrow: makeScheduleFrom(names),
      soren: makeScheduleFrom([...names].reverse()),
      slot_0: makeScheduleFrom(names),
      slot_1: makeScheduleFrom([...names].reverse()),
    },
  };
}

function nearestAnchor(scene: Scene, pos: { x: number; y: number }): string {
  let best = "center";
  let bestD = Infinity;
  for (const [name, a] of Object.entries(scene.anchors)) {
    const d = Math.abs(a.x - pos.x) + Math.abs(a.y - pos.y);
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

export async function fetchNarration(
  s: GameState,
  card: CardDef | { id: string; title: string; flavor: string },
  lineCount?: number,
): Promise<string[]> {
  const recent = s.log.slice(-3).map((l) => l.text);
  const body = {
    card,
    context: {
      sceneName: s.scene.name,
      characters: s.characters.map((c) => ({
        id: c.id,
        name: c.name,
        description: `${c.description}. mood: ${c.mood}`,
        nearest: nearestAnchor(s.scene, c.pos),
      })),
      recent,
    },
    lineCount: lineCount ?? 3,
  };
  const resp = await fetch(NARRATE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`narrate ${resp.status}`);
  const data = (await resp.json()) as { lines?: string[] };
  const lines = Array.isArray(data.lines) ? data.lines : [];
  if (lines.length === 0) throw new Error("empty lines");
  return lines;
}

// Replace narrate-step texts with LLM lines, in order. If there are fewer
// lines than narrate slots, remaining slots keep their authored text.
export function spliceLlmLines(plan: Plan, lines: string[]): Plan {
  let idx = 0;
  const steps = plan.steps.map((step) => {
    if (step.op === "narrate" && idx < lines.length) {
      const text = lines[idx++];
      return { ...step, text };
    }
    return step;
  });
  return { ...plan, steps };
}

const PLAY_URL = `${API_BASE}/api/rpg/play`;
const SUMMARIZE_URL = `${API_BASE}/api/rpg/summarize`;

let summarizeInFlight = false;

// Rewrites a short "story-so-far" paragraph every ~5 beats so the director
// has compressed memory of earlier events even when the recent-log window
// has rolled past them. Safe to call every tick; gated on beat count.
export function maybeSummarize(s: GameState, now: number): void {
  if (s.phase !== "playing") return;
  if (summarizeInFlight) return;
  if (s.log.length < 6) return;
  const sinceLast = s.beatsPlayed - s.summaryBeatsAt;
  // First summary after 4 beats, then every 5.
  const threshold = s.summaryBeatsAt === 0 ? 4 : 5;
  if (sinceLast < threshold) return;
  summarizeInFlight = true;
  withWatchdog(
    "maybeSummarize",
    () => { summarizeInFlight = false; },
    45_000,
    null,
    async () => {
      const body = {
        sceneName: s.scene.name,
        stakes: s.stakes,
        previousSummary: s.storySummary,
        log: s.log.slice(-40).map((l) => l.text),
        characters: s.characters.map((c) => ({
          id: c.id,
          name: c.name,
          objective: c.objective,
        })),
      };
      const resp = await fetch(SUMMARIZE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as { summary?: string };
      if (typeof data.summary === "string" && data.summary.trim()) {
        s.storySummary = data.summary.trim().slice(0, 800);
        s.summaryBeatsAt = s.beatsPlayed;
      }
      void now;
    },
  );
}
const RESKIN_URL = `${API_BASE}/api/rpg/reskin`;

// Re-skin card titles + flavor for the current room. Mechanic + scores
// stay stable; only the prose around them changes.
export async function fetchSkins(
  roomContext: string,
): Promise<Record<string, { title: string; flavor: string }>> {
  const body = {
    roomContext,
    cards: CARDS.map((c) => ({
      id: c.id,
      mechanic: c.mechanic,
      baseTitle: c.title,
      baseFlavor: c.flavor,
      scores: c.scores,
    })),
  };
  const resp = await fetch(RESKIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`reskin ${resp.status}`);
  const data = (await resp.json()) as {
    skins?: Record<string, { title: string; flavor: string }>;
  };
  return data.skins ?? {};
}

// Fire a small autonomous beat when the scene has been idle. The director
// LLM gets the current state and picks a gentle next thing — a look, a
// breath, a shift in inventory, a small flag. Same plan runner handles it.
let autoTickInFlight = false;
let lastAutoTickAt = 0;

// Fire once when tension first hits 100: the room's closing beat. After this
// plays, the spent overlay offers the reset.
let codaFired = false;
export function resetCodaFlag(): void { codaFired = false; }
export function maybeCodaBeat(s: GameState): void {
  if (s.phase !== "playing") return;
  if (s.tension < 100) return;
  if (codaFired) return;
  if (autoTickInFlight) return;
  if (s.activePlan || s.planQueue.length > 0) return;
  codaFired = true;
  autoTickInFlight = true;
  withWatchdog(
    "maybeCodaBeat",
    () => { autoTickInFlight = false; },
    45_000,
    null,
    async () => {
      const directive =
        "This is the final beat of the scene. The story has spent itself. Compose a CLOSING moment — a last word, a last action, a last image. One clear resolution or unresolution; then the room is quiet. 4-6 steps, ending with a strong closing narrate line.";
      const plan = await fetchDirective(s, directive);
      if (plan) s.planQueue.push(plan);
    },
  );
}

export function maybeDirectorTick(s: GameState, now: number): void {
  // Faster ticks as tension rises — but scenes should breathe at low
  // tension, so the opening beats are leisurely. Story accelerates
  // toward the end without sprinting there.
  const IDLE_MS =
    s.tension >= 80 ? 10_000
    : s.tension >= 55 ? 18_000
    : s.tension >= 25 ? 28_000
    : 40_000;
  if (s.phase !== "playing") return;
  if (s.tension >= 100) return; // story is spent; wait for player to reset
  if (autoTickInFlight) return;
  if (s.activePlan || s.planQueue.length > 0) return;
  if (s.pending && s.pending.sealedAt !== null) return;
  if (now - lastAutoTickAt < IDLE_MS) return;
  // Wait a beat after the pending narration is fully settled.
  if (s.pending && s.pending.shown < s.pending.full.length) return;
  lastAutoTickAt = now;
  autoTickInFlight = true;
  withWatchdog(
    "maybeDirectorTick",
    () => { autoTickInFlight = false; },
    45_000,
    null,
    async () => {
      const plan = await fetchDirective(s, directiveForTension(s.tension));
      if (plan) s.planQueue.push(plan);
    },
  );
}

// Voice + action cue per tension band. Tone guidance so the director's
// prose stays tonally appropriate for the act we're in.
function directiveForTension(t: number): string {
  if (t < 20) {
    return "The room is still quiet. Tone: intimate, exploratory, small. Advance the plot without forcing it — a question asked, a name mentioned, an item handled, an observation that lands. Something concrete moves, but the voice is close and unhurried. Reference what has already happened. ≤6 steps.";
  }
  if (t < 50) {
    return "The story is building. Tone: warmer, closer, with more weight behind small gestures. Escalate — a piece of backstory surfaces, an item is taken or given, the uncomfortable question is asked, someone moves to confront. Reference what has already happened. ≤6 steps.";
  }
  if (t < 80) {
    return "The story is charged. Tone: urgent but grounded — real people under real pressure, not melodrama. FORCE something to happen: a confession, a decision, an arrival, a refusal that can't be walked back. No circling. A real event this beat. Reference what has already happened. ≤7 steps.";
  }
  return "The story is near its breaking point. Tone: taut, close, spare. Every line carries weight; no filler. A single decisive act or word — spoken or refused — lands this beat. Reference what has already happened. ≤7 steps.";
}

// Send a free-text directive to the director LLM and return a Plan.
// The existing tickPlans loop runs it step-by-step so avatars act it out.
export async function fetchDirective(
  s: GameState,
  directive: string,
): Promise<Plan | null> {
  const recent = s.log.slice(-15).map((l) => l.text);
  // Each directive counts as a story beat; warmup ramps up the pressure.
  s.beatsPlayed += 1;
  addTension(s, 3);
  const body = {
    directive,
    roomContext: s.roomContext,
    characters: s.characters.map((c) => ({
      id: c.id,
      name: c.name,
      description: `${c.description}. mood: ${c.mood}`,
      nearest: nearestAnchor(s.scene, c.pos),
      inventory: c.inventory,
      backstory: c.backstory || undefined,
      objective: c.objective || undefined,
      motive: c.motive || undefined,
    })),
    anchors: Object.keys(s.scene.anchors),
    recent,
    flags: s.flags,
    tension: Math.round(s.tension),
    roomItems: s.roomItems,
    stakes: s.stakes,
    storySummary: s.storySummary || undefined,
    inheritedMemory: s.inheritedMemory || undefined,
  };
  const resp = await fetch(PLAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`direct ${resp.status}`);
  const data = (await resp.json()) as { plan?: Tool[] };
  if (!Array.isArray(data.plan) || data.plan.length === 0) {
    throw new Error("empty plan");
  }
  return {
    id: `dir_${Date.now()}`,
    title: directive.slice(0, 60),
    steps: data.plan,
    cursor: 0,
    blocked: null,
  };
}

export async function playCardWithLlm(
  s: GameState,
  card: CardDef,
  now: number,
  onStart: () => void,
  onDone: () => void,
  onError: (e: unknown) => void,
): Promise<void> {
  const plan = buildPlan(s, card);
  onStart();
  try {
    const lines = await fetchNarration(s, card);
    const spliced = spliceLlmLines(plan, lines);
    s.planQueue.push(spliced);
    onDone();
  } catch (e) {
    // Fallback: template plan
    s.planQueue.push(plan);
    onError(e);
  }
  void now;
}
