import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type GameState,
  type Character,
  type EmoteKind,
  type SavedRoom,
  TILE_PX,
  stepCamera,
  computeSceneBand,
  formatSimTime,
  initialState,
  tickPlans,
  tickCharacters,
  tickSchedules,
  tickTensionDecay,
  advanceNarration,
  maybeAmbient,
  maybeDirectorTick,
  simHour,
  SCENES,
  streamRoom,
  sceneFromRoom,
  applyScene,
  fetchDirective,
  loadState,
  saveState,
  clearSaved,
  maybeCodaBeat,
  resetCodaFlag,
  listRooms,
  loadRoomById,
  deleteRoom,
  isArchivedRoom,
  newRoomId,
  consumeSharedRoomFromUrl,
  hasSharedRoomInUrl,
  CHARACTER_PALETTES,
  rewindOne,
  extractSurvivors,
  onStorageError,
  maybeSummarize,
  skipPending,
  toggleNarrationSpeed,
  hydrateLibrary,
  onLibraryChanged,
  ensureProgressState,
  rollObjectivesIfNeeded,
  evaluateObjectives,
  recordIngredientsPicked,
  checkObjective,
  type Objective,
  type BuildingState,
  type SpentFloor,
  type SurvivorRecord,
  loadBuilding,
  saveBuilding,
  createBuilding,
  spendRoom,
  buildInheritedMemory,
  survivorsToCharacters,
  fetchEpitaph,
  type BuildingContext,
  onSyncNeeded,
} from "./engine";
import { pushBuilding, pushRoom, pullAll, enqueuePush, getDeviceId, releaseLock } from "./sync";
import { clearSession, getUserId } from "./auth";
import type { PullResult } from "./sync";
import {
  INGREDIENTS,
  CATEGORY_LABELS,
  composeIngredientPrompt,
  type IngredientCategory,
} from "./ingredients";

const PROMPT_TEMPLATES = [
  { label: "cabin", prompt: "a woodcutter's cabin at the edge of the forest, hearth still warm" },
  { label: "market", prompt: "a night market stall selling things that aren't for sale" },
  { label: "tower", prompt: "the top floor of a crumbling watchtower, wind through the gaps" },
  { label: "kitchen", prompt: "a monastery kitchen before dawn, bread rising in the dark" },
  { label: "vault", prompt: "a locked bank vault from the inside, two people and one key" },
  { label: "train", prompt: "a sleeper car on a train that hasn't stopped in days" },
  { label: "garden", prompt: "a walled garden after a funeral, chairs still set out" },
  { label: "workshop", prompt: "a clockmaker's workshop, every clock set to a different time" },
];

function extractSurvivorsCount(s: GameState): number {
  return s.characters.filter((c) => !c.dead && !c.transient).length;
}

export function RPG() {
  const [state, setState] = useState<GameState>(() => {
    const now = performance.now();
    // If a shared-room hash is present, return a placeholder; the async
    // effect below will decode it and swap the real state in.
    if (hasSharedRoomInUrl()) return initialState(now);
    return loadState(now) ?? initialState(now);
  });
  const [showLog, setShowLog] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showObjectives, setShowObjectives] = useState(false);
  const [activeSheet, setActiveSheet] = useState<null | "profile" | "season" | "settings" | "menu">(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const flashToast = (msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400);
  };
  const [libraryTick, setLibraryTick] = useState(0);
  const [building, setBuilding] = useState<BuildingState | null>(null);
  const buildingRef = useRef<BuildingState | null>(null);
  buildingRef.current = building;
  // Map of roomId → remote lock info (who's currently playing it).
  const [roomLocks, setRoomLocks] = useState<Record<string, { lockedBy: string; lockedAt: number }>>({});
  const [lockedAlert, setLockedAlert] = useState<{ roomId: string; lockedAt: number } | null>(null);

  useEffect(() => {
    if (!hasSharedRoomInUrl()) return;
    let cancelled = false;
    void (async () => {
      const room = await consumeSharedRoomFromUrl(performance.now());
      if (cancelled) return;
      if (!room) {
        flashToast("shared link couldn't be read");
        return;
      }
      // Every floor lives inside the building — attach the imported one so it
      // becomes the active floor rather than a standalone.
      let bld = buildingRef.current ?? await loadBuilding();
      if (!bld) {
        bld = createBuilding();
      }
      room.snapshot.buildingId = bld.id;
      room.snapshot.floorIndex = bld.floors.length;
      bld.activeRoomId = room.snapshot.roomId;
      bld.lastPlayedAt = Date.now();
      setBuilding(bld);
      void saveBuilding(bld);
      stateRef.current = room.snapshot;
      saveState(room.snapshot);
      setState({ ...room.snapshot });
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (state.phase !== "playing") return;
    const directiveInput = () =>
      document.getElementById("rp-directive-input") as HTMLInputElement | null;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.key === "?") {
        if (isTyping) return;
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        if (showHelp) { setShowHelp(false); return; }
      }
      if (isTyping) return;
      if (e.code === "Space") {
        e.preventDefault();
        onTogglePause();
      } else if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        onRewind();
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        onSkipLine();
      } else if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        setShowLog((v) => !v);
      } else if (e.key === "/") {
        e.preventDefault();
        directiveInput()?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state.phase, showHelp]);

  useEffect(() => {
    void hydrateLibrary();
    void loadBuilding().then((b) => {
      if (!b) return;
      // Roll today's / this week's / this season's objectives if needed,
      // and give credit for anything that's already satisfied.
      rollObjectivesIfNeeded(b);
      evaluateObjectives(b);
      void saveBuilding(b);
      setBuilding(b);
    });
    const applyPull = (result: PullResult | null) => {
      if (!result) return;
      if (result.buildings.length > 0) {
        const remote = result.buildings[0];
        const local = buildingRef.current;
        if (!local || (remote.lastPlayedAt ?? 0) > (local.lastPlayedAt ?? 0)) {
          setBuilding(remote);
          void saveBuilding(remote);
        }
      }
      // Record lock info per room.
      const now = Date.now();
      const myDevice = getDeviceId();
      const nextLocks: Record<string, { lockedBy: string; lockedAt: number }> = {};
      for (const entry of result.rooms) {
        if (
          entry.lockedBy &&
          entry.lockedAt &&
          entry.lockedBy !== myDevice &&
          now - entry.lockedAt < 60_000
        ) {
          nextLocks[entry.room.id] = { lockedBy: entry.lockedBy, lockedAt: entry.lockedAt };
        }
      }
      setRoomLocks(nextLocks);
      setLibraryTick((t) => t + 1);
    };
    void pullAll().then(applyPull);
    return onLibraryChanged(() => setLibraryTick((t) => t + 1));
  }, []);

  // Sync listener: debounce pushes on every save.
  useEffect(() => {
    return onSyncNeeded((kind, data) => {
      enqueuePush(() => {
        if (kind === "building") void pushBuilding(data as BuildingState);
        else void pushRoom(data as SavedRoom);
      });
    });
  }, []);

  // Pull on tab re-focus for cross-device sync.
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") {
        void pullAll().then((result) => {
          if (!result) return;
          if (result.buildings.length > 0) {
            const remote = result.buildings[0];
            const local = buildingRef.current;
            if (!local || (remote.lastPlayedAt ?? 0) > (local.lastPlayedAt ?? 0)) {
              setBuilding(remote);
              void saveBuilding(remote);
            }
          }
          setLibraryTick((t) => t + 1);
        });
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  useEffect(() => {
    return onStorageError((e) => {
      if (e.kind === "write" && e.quotaLikely) {
        flashToast("save full — clear old floors to make space");
      } else if (e.kind === "write") {
        flashToast("couldn't save — check storage settings");
      } else {
        flashToast("saved floors couldn't be read");
      }
    });
  }, []);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastRef = useRef(performance.now());
  const lastSaveRef = useRef(performance.now());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Side-view camera: world-x offset in pixels and a zoom factor. Owned by
  // the render loop (not GameState) — camera is a view concern.
  const camRef = useRef<{ worldX: number; zoom: number }>({ worldX: 0, zoom: 1 });
  // Canvas CSS size in logical pixels, updated by ResizeObserver.
  const canvasSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  // Most recent character that moved or spoke — used to pick the camera's
  // follow target so the camera prefers whoever is "active" right now.
  const lastActiveRef = useRef<string | null>(null);
  const pausedAtRef = useRef<number | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastRef.current) / 1000);
      lastRef.current = now;
      const s = stateRef.current;
      if (!s.paused) {
        tickPlans(s, now);
        tickSchedules(s, now);
        tickCharacters(s, now, dt);
        tickTensionDecay(s, dt);
        advanceNarration(s, dt, now);
        maybeAmbient(s, now);
        maybeDirectorTick(s, now);
        maybeCodaBeat(s);
        maybeSummarize(s, now);
      }
      if (now - lastSaveRef.current > 3000) {
        saveState(s);
        lastSaveRef.current = now;
      }
      setState({ ...s });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Resize the canvas to fill its frame. Runs once on mount and whenever
  // the frame's size changes (window resize, mobile orientation, safe-area
  // insets appearing/disappearing). We draw in CSS pixels and upscale the
  // backing store by devicePixelRatio for sharpness on retina displays.
  useEffect(() => {
    if (state.phase !== "playing") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const frame = canvas.parentElement;
    if (!frame) return;
    const apply = () => {
      const rect = frame.getBoundingClientRect();
      const cssW = Math.max(1, Math.floor(rect.width));
      const cssH = Math.max(1, Math.floor(rect.height));
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvasSizeRef.current = { w: cssW, h: cssH };
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(frame);
    return () => ro.disconnect();
  }, [state.phase]);

  // Canvas draw loop. Applies a camera transform so world draws happen in
  // world coordinates; screen-space overlays (dialog, vignette, time-of-day)
  // draw after the transform is reset.
  useEffect(() => {
    if (state.phase !== "playing") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = (now: number) => {
      const s = stateRef.current;
      const { w: cssW, h: cssH } = canvasSizeRef.current;
      if (cssW === 0 || cssH === 0) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      // World size in CSS pixels (before camera zoom).
      const cols = s.scene.map[0]?.length ?? 0;
      const worldW = cols * TILE_PX;

      // Pick an active follow target. Preference: whoever has pending
      // speech now, else the last-moving character, else the first.
      const speaker = s.characters.find((c) => c.speech && !c.dead);
      const mover = s.characters.find((c) => c.moving && !c.dead);
      const active = speaker ?? mover ?? s.characters.find((c) => !c.dead) ?? s.characters[0];
      if (active) lastActiveRef.current = active.id;
      const follow =
        s.characters.find((c) => c.id === lastActiveRef.current) ?? active ?? null;

      // Reserve a strip at the bottom for the dialog overlay so characters
      // never sit behind it. The scene is fit to the remaining height.
      const DIALOG_RESERVED = s.pending ? 108 : 8;
      const drawH = Math.max(160, cssH - DIALOG_RESERVED);

      // Fit a ceiling+floor+foundation band to the scene draw area. This
      // crops empty-sky rows above the floor and scales tiles/sprites up
      // to a readable size (Phaser-style setBounds + setZoom semantics).
      const band = computeSceneBand(s.scene, drawH);
      camRef.current.zoom = band.zoom;
      const zoom = band.zoom;
      const camWorldY = band.topRow * TILE_PX;

      // Target x (world px) is the follow character's center.
      const targetX = follow ? (follow.pos.x + 0.5) * TILE_PX : worldW / 2;
      camRef.current.worldX = stepCamera(
        camRef.current,
        targetX,
        cssW,
        worldW,
        zoom,
      ).worldX;

      // Reset to identity, clear.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Clip the world draw to the scene area (everything below is dialog
      // territory). Clip path is defined in device pixels before any
      // world transform is applied.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cssW * dpr, drawH * dpr);
      ctx.clip();

      // Apply camera (dpr × zoom, -camX, -camY).
      ctx.setTransform(
        dpr * zoom,
        0,
        0,
        dpr * zoom,
        -camRef.current.worldX * dpr * zoom,
        -camWorldY * dpr * zoom,
      );

      drawScene(ctx, s.scene, now, band);
      drawFlagOverlays(ctx, s.scene, s.flags, now);
      drawRoomItems(ctx, s.scene, s.roomItems, now);
      for (const c of s.characters) drawCharacter(ctx, c, s.scene, now, s.characters);

      // End world-clip region.
      ctx.restore();

      // Screen-space overlays — reset to identity (dpr only).
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawTimeOfDay(ctx, simHour(now, s.simStartedAt), cssW, cssH);
      drawVignette(ctx, cssW, cssH);
      drawDialog(ctx, s.pending, now, cssW, cssH);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [state.phase]);

  const [narratorThinking, setNarratorThinking] = useState(false);
  const [llmFallbackReason, setLlmFallbackReason] = useState<string | null>(null);
  const [roomPrompt, setRoomPrompt] = useState("");
  const [directive, setDirective] = useState("");
  const [roomProgress, setRoomProgress] = useState<{
    pct: number;
    stage: string;
  } | null>(null);
  const [showNewRoomForm, setShowNewRoomForm] = useState(false);
  const [selectedIngredients, setSelectedIngredients] = useState<string[]>([]);
  const [selectedSurvivors, setSelectedSurvivors] = useState<string[]>([]);

  const onGenerateRoom = async () => {
    const prompt = roomPrompt.trim();
    if (!prompt) return;
    setNarratorThinking(true);
    setLlmFallbackReason(null);
    const now = performance.now();

    // Real progress driven by SSE phase events. Specialists run in parallel
    // on the worker, so phases may arrive in any order — we take the max of
    // the known phase percentages rather than assuming a fixed sequence.
    const PHASE_PROGRESS: Record<string, { pct: number; stage: string }> = {
      started: { pct: 10, stage: "building the floor…" },
      map: { pct: 40, stage: "floor plan ready — placing furniture…" },
      narrative: {
        pct: 70,
        stage: "stakes and items placed — writing characters…",
      },
      profiles: { pct: 90, stage: "characters ready — opening the floor…" },
      done: { pct: 100, stage: "ready." },
    };
    let shownPct = 0;
    setRoomProgress({ pct: 10, stage: "building the floor…" });

    try {
      // Every floor lives inside the building — materialize one if the player
      // somehow reached room generation without a building yet.
      let bld = buildingRef.current;
      if (!bld) {
        bld = createBuilding();
        setBuilding(bld);
        void saveBuilding(bld);
      }
      // Resolve which survivors will actually carry forward. Honor the
      // player's picks from the "WHO COMES UP" widget; fall back to the
      // first up to 3 if nothing is picked.
      const pickedSurvivors: SurvivorRecord[] = selectedSurvivors.length > 0
        ? bld.roster.filter((s) => selectedSurvivors.includes(s.id))
        : bld.roster.slice(0, 3);
      const bc: BuildingContext = {
        survivors: pickedSurvivors.slice(0, 3).map((s) => ({
          name: s.name,
          description: s.description,
          backstory: s.backstory,
          inventory: [...s.inventory],
        })),
        ghosts: bld.ghosts.slice(-3).map((g) => ({
          name: g.name,
          description: g.description,
          causeOfDeath: g.causeOfDeath,
          diedInRoomName: g.diedInRoomName,
        })),
        previousRoomSummary: bld.floors.length > 0
          ? bld.floors[bld.floors.length - 1].storySummary
          : "",
        floorNumber: bld.floors.length,
      };
      const room = await streamRoom(prompt, (phase) => {
        const entry = PHASE_PROGRESS[phase];
        if (!entry) return;
        if (entry.pct >= shownPct) {
          shownPct = entry.pct;
          setRoomProgress({ pct: entry.pct, stage: entry.stage });
        }
      }, bc);
      const scene = sceneFromRoom(room);
      applyScene(stateRef.current, scene); resetCodaFlag();
      const live = stateRef.current;
      live.roomId = newRoomId();
      live.roomPrompt = prompt;
      live.buildingId = bld.id;
      live.floorIndex = bld.floors.length;
      live.inheritedMemory = buildInheritedMemory(bld);
      bld.activeRoomId = live.roomId;
      bld.lastPlayedAt = Date.now();
      // Record the ingredient categories we just picked so progress
      // objectives ("use 3 categories") can count them.
      ensureProgressState(bld);
      const cats = Array.from(new Set(
        selectedIngredients
          .map((id) => INGREDIENTS.find((c) => c.id === id)?.category)
          .filter((c): c is NonNullable<typeof c> => !!c),
      ));
      recordIngredientsPicked(bld, cats);
      rollObjectivesIfNeeded(bld);
      const done = evaluateObjectives(bld);
      for (const o of done) flashToast(`+${o.reward} · ${o.label}`);
      void saveBuilding(bld);
      if (pickedSurvivors.length > 0) {
        live.characters = survivorsToCharacters(pickedSurvivors, scene);
      } else if (bld.roster.length >= 2) {
        live.characters = survivorsToCharacters(bld.roster.slice(0, 3), scene);
      }
      live.simStartedAt = now;
      live.lastAmbient = now;
      live.phase = "playing";
      const lines = room.lines.length > 0 ? room.lines : [`A ${prompt}.`];
      live.pending = {
        full: lines[0],
        shown: 0,
        sealedAt: now,
        kind: "narration",
      };
      for (let i = 1; i < lines.length; i++) {
        live.narrationQueue.push({ line: lines[i], kind: "narration" });
      }
      live.roomContext = `${room.name}. ${lines.join(" ")}${room.stakes ? " Stakes: " + room.stakes : ""}`;
      live.roomItems = room.items ?? [];
      live.stakes = room.stakes ?? "";
      if (room.openingFlags) {
        for (const [k, v] of Object.entries(room.openingFlags)) {
          live.flags[k.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 40)] =
            String(v).slice(0, 40);
        }
      }
      // Apply profiles/moods by cast position — the worker still uses the
      // "marrow"/"soren" keys as structural slot names but we map them onto
      // whichever characters are in positions 0 and 1.
      const slotKeys: ("marrow" | "soren")[] = ["marrow", "soren"];
      const cast = live.characters.filter((c) => !c.transient);
      if (room.moods) {
        const validMoods = new Set([
          "watchful", "tender", "withdrawn", "alert", "weary", "still",
        ]);
        cast.forEach((c, i) => {
          const m = room.moods?.[slotKeys[i]];
          if (m && validMoods.has(m)) c.mood = m as typeof c.mood;
        });
      }
      if (room.profiles) {
        cast.forEach((c, i) => {
          const p = room.profiles?.[slotKeys[i]];
          if (!p) return;
          if (p.name && p.name.trim()) c.name = p.name.trim();
          if (p.description && p.description.trim()) c.description = p.description.trim();
          if (p.palette && CHARACTER_PALETTES[p.palette]) {
            c.palette = { ...CHARACTER_PALETTES[p.palette] };
          }
          c.backstory = p.backstory ?? "";
          c.objective = p.objective ?? "";
          c.motive = p.motive ?? "";
        });
      }
      setRoomProgress({ pct: 100, stage: "ready." });
      window.setTimeout(() => setRoomProgress(null), 500);
      setSelectedIngredients([]);
      setSelectedSurvivors([]);
    } catch (e) {
      setLlmFallbackReason(e instanceof Error ? e.message : String(e));
      setRoomProgress(null);
    } finally {
      setNarratorThinking(false);
      setState({ ...stateRef.current });
    }
  };


  const onSubmitDirective = async () => {
    const text = directive.trim();
    if (!text) return;
    if (stateRef.current.tension >= 100) return;
    setNarratorThinking(true);
    setLlmFallbackReason(null);
    try {
      const plan = await fetchDirective(stateRef.current, text);
      const live = stateRef.current;
      if (plan) live.planQueue.push(plan);
      live.roomContext = `${live.roomContext} → ${text}`;
      setDirective("");
    } catch (e) {
      setLlmFallbackReason(e instanceof Error ? e.message : String(e));
    } finally {
      setNarratorThinking(false);
      setState({ ...stateRef.current });
    }
  };

  const pending = state.pending;
  const shown = pending ? pending.full.slice(0, Math.floor(pending.shown)) : "";
  const narrating = !!pending && shown.length < pending.full.length;
  const busy = !!state.activePlan || narratorThinking;
  const spent = state.phase === "playing" && state.tension >= 100;

  const onTogglePause = () => {
    const live = stateRef.current;
    const nowMs = performance.now();
    if (!live.paused) {
      // pausing — remember when, so we can shift simStartedAt when we resume
      pausedAtRef.current = nowMs;
    } else if (pausedAtRef.current !== null) {
      // resuming — push simStartedAt forward by the paused duration so the
      // in-floor clock picks up from where it stopped.
      const shift = nowMs - pausedAtRef.current;
      live.simStartedAt += shift;
      live.lastAmbient += shift;
      live.lastDirectedAt += shift;
      pausedAtRef.current = null;
    }
    live.paused = !live.paused;
    setState({ ...live });
  };

  const onRewind = () => {
    const live = stateRef.current;
    void (async () => {
      const ok = await rewindOne(live);
      if (!ok) return;
      setState({ ...live });
    })();
  };

  const onSkipLine = () => {
    const live = stateRef.current;
    skipPending(live, performance.now());
    setState({ ...live });
  };

  const onToggleSpeed = () => {
    const live = stateRef.current;
    toggleNarrationSpeed(live);
    setState({ ...live });
  };

  const onBackToMenu = () => {
    const live = stateRef.current;
    const roomId = live.roomId;
    saveState(live); // persist progress before stepping away
    live.phase = "setup";
    live.activePlan = null;
    live.planQueue = [];
    live.pending = null;
    live.narrationQueue = [];
    clearSaved();
    setShowNewRoomForm(false);
    setState({ ...live });
    // Release the remote lock so another device can play this floor.
    if (roomId) void releaseLock(roomId);
  };

  const onEndScene = () => {
    const live = stateRef.current;
    live.phase = "setup";
    live.pending = null;
    live.narrationQueue = [];
    live.activePlan = null;
    live.planQueue = [];
    live.tension = 0;
    live.beatsPlayed = 0;
    live.flags = {};
    live.roomItems = [];
    live.stakes = "";
    for (const c of live.characters) {
      c.inventory = [];
      c.speech = null;
      c.emote = null;
      c.hp = 3;
      c.dead = false;
    }
    live.characters = live.characters.filter((c) => !c.transient);
    resetCodaFlag();
    clearSaved();
    setState({ ...live });
  };

  const viewNode: React.ReactNode = (() => {
  if (state.phase === "setup") {
    const rooms = listRooms().sort((a, b) => {
      const sa = (a.snapshot.tension ?? 0) >= 100 ? 1 : 0;
      const sb = (b.snapshot.tension ?? 0) >= 100 ? 1 : 0;
      if (sa !== sb) return sa - sb;
      return b.lastPlayedAt - a.lastPlayedAt;
    });
    void libraryTick;

    const onEnterRoom = (id: string) => {
      const lock = roomLocks[id];
      if (lock) {
        setLockedAlert({ roomId: id, lockedAt: lock.lockedAt });
        return;
      }
      const saved = listRooms().find((r) => r.id === id);
      if (saved && isArchivedRoom(saved)) {
        flashToast("archived floor — regenerate or delete");
        return;
      }
      const loaded = loadRoomById(id, performance.now());
      if (!loaded) return;
      stateRef.current = loaded;
      resetCodaFlag();
      setState({ ...loaded });
    };

    const onRegenerateRoom = (saved: SavedRoom) => {
      const p = (saved.prompt ?? "").trim();
      if (!p) {
        flashToast("no prompt saved for this floor");
        return;
      }
      // Drop the archived entry first so regeneration overwrites cleanly.
      deleteRoom(saved.id);
      setLibraryTick((t) => t + 1);
      setRoomPrompt(p);
      setShowNewRoomForm(true);
      flashToast("regenerating — edit prompt if you like");
    };

    const showForm = showNewRoomForm || rooms.length === 0;

    if (showForm) {
      const activeCards = selectedIngredients
        .map((id) => INGREDIENTS.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => !!c);
      const groups: { cat: IngredientCategory; label: string }[] = [
        { cat: "where",   label: "the place" },
        { cat: "who",     label: "the company" },
        { cat: "what",    label: "the object" },
        { cat: "when",    label: "the hour" },
        { cat: "mood",    label: "the weather" },
        { cat: "trouble", label: "the trouble" },
      ];
      const toggleIngredient = (id: string) => {
        const next = selectedIngredients.includes(id)
          ? selectedIngredients.filter((x) => x !== id)
          : [...selectedIngredients, id].slice(-6);
        setSelectedIngredients(next);
        setRoomPrompt(composeIngredientPrompt(next));
      };
      const shuffleIngredients = () => {
        const picks: string[] = [];
        const cats: IngredientCategory[] = ["where", "who", "what", "mood", "trouble"];
        for (const cat of cats) {
          const cards = INGREDIENTS.filter((c) => c.category === cat);
          if (cards.length === 0) continue;
          picks.push(cards[Math.floor(Math.random() * cards.length)].id);
        }
        setSelectedIngredients(picks);
        setRoomPrompt(composeIngredientPrompt(picks));
      };
      const clearIngredients = () => {
        setSelectedIngredients([]);
        setRoomPrompt("");
      };

      return (
        <div className="rp-ingr-page">
          <div className="rp-shell-bg" />
          <div className="rp-shell-streaks">
            <div className="rp-streak rp-streak-1" />
            <div className="rp-streak rp-streak-3" />
          </div>

          <div className="rp-ingr-head">
            {rooms.length > 0 ? (
              <button
                type="button"
                className="rp-icon-btn"
                onClick={() => setShowNewRoomForm(false)}
                disabled={narratorThinking}
                aria-label="Back to the building"
                title="Back"
              >
                ‹
              </button>
            ) : <span />}
            <div className="rp-ingr-title-col">
              <h1 className="rp-ingr-title">NEW FLOOR</h1>
              <div className="rp-ingr-sub">
                {activeCards.length === 0 ? "deal 2 to 6 ingredients" : `${activeCards.length} / 6 ingredients`}
              </div>
            </div>
            <div className="rp-ingr-actions-l">
              <button type="button" className="rp-btn-ghost" onClick={shuffleIngredients} disabled={narratorThinking} title="Shuffle">⤨</button>
              {activeCards.length > 0 && (
                <button type="button" className="rp-btn-ghost" onClick={clearIngredients} disabled={narratorThinking} title="Clear">×</button>
              )}
            </div>
          </div>

          <div className="rp-ingr-scroll">
            {building && building.roster.length > 0 && (
              <div className="rp-cast-picker" role="group" aria-label="Who comes up">
                <div className="rp-cat-label" style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>WHO COMES UP</span>
                  <span style={{ color: "var(--ink-dim)" }}>{selectedSurvivors.length} / 3</span>
                </div>
                <div className="rp-cast-picker-row">
                  {building.roster.map((sv) => {
                    const on = selectedSurvivors.includes(sv.id);
                    return (
                      <button
                        key={sv.id}
                        type="button"
                        className={`rp-cast-token ${on ? "on" : ""}`}
                        aria-pressed={on}
                        onClick={() => {
                          if (on) {
                            setSelectedSurvivors(selectedSurvivors.filter((x) => x !== sv.id));
                          } else if (selectedSurvivors.length < 3) {
                            setSelectedSurvivors([...selectedSurvivors, sv.id]);
                          }
                        }}
                        disabled={!on && selectedSurvivors.length >= 3}
                      >
                        <span className="rp-cast-token-dot" style={{ background: sv.palette.cloak }} />
                        <span className="rp-cast-token-name">{sv.name}</span>
                        {sv.inventory.length > 0 && (
                          <span className="rp-cast-token-inv">· {sv.inventory[0]}{sv.inventory.length > 1 ? ` +${sv.inventory.length - 1}` : ""}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {selectedSurvivors.length < 2 && (
                  <div className="rp-cast-picker-hint">
                    {selectedSurvivors.length === 0
                      ? "no survivors selected — this floor starts with fresh characters"
                      : "one more will join them"}
                  </div>
                )}
              </div>
            )}

            {activeCards.length > 0 && (
              <div className="rp-hand">
                {activeCards.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="rp-hand-card"
                    onClick={() => toggleIngredient(c.id)}
                    title="Remove"
                  >
                    <span className="rp-hand-card-glyph">{c.glyph}</span>
                    <span className="rp-hand-card-cat">{CATEGORY_LABELS[c.category]}</span>
                    <span className="rp-hand-card-label">{c.label}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="rp-table">
              {groups.map(({ cat, label }) => {
                const catCards = INGREDIENTS.filter((c) => c.category === cat);
                return (
                  <div key={cat} className="rp-cat-row">
                    <div className="rp-cat-label">{label}</div>
                    <div className="rp-cat-cards">
                      {catCards.map((c) => {
                        const on = selectedIngredients.includes(c.id);
                        return (
                          <button
                            key={c.id}
                            type="button"
                            className={`rp-ingr ${on ? "on" : ""}`}
                            onClick={() => toggleIngredient(c.id)}
                            aria-pressed={on}
                          >
                            <span className="rp-ingr-glyph">{c.glyph}</span>
                            <span className="rp-ingr-label">{c.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rp-ingr-foot">
            {roomProgress ? (
              <div className="rp-progress" role="status" aria-live="polite">
                <div className="rp-progress-label">{roomProgress.stage}</div>
                <div className="rp-progress-bar"><div className="rp-progress-fill" style={{ width: `${roomProgress.pct}%` }} /></div>
                <div className="rp-progress-pct">{roomProgress.pct}%</div>
              </div>
            ) : (
              <>
                <div className="rp-prompt-mini">
                  <textarea
                    className="rp-prompt-text"
                    placeholder="your prompt appears here — or write your own"
                    value={roomPrompt}
                    onChange={(e) => setRoomPrompt(e.target.value)}
                    disabled={narratorThinking}
                    spellCheck={false}
                    rows={1}
                  />
                </div>
                <button
                  type="button"
                  className="rp-ignite"
                  onClick={() => void onGenerateRoom()}
                  disabled={narratorThinking || !roomPrompt.trim()}
                >
                  <span className="rp-ignite-label">
                    <span className="rp-ignite-title">IGNITE</span>
                    <span className="rp-ignite-sub">
                      {narratorThinking ? "composing…" : building ? `open floor ${building.floors.length + 1}` : "open floor"}
                    </span>
                  </span>
                  <span className="rp-ignite-badge">⟶</span>
                </button>
              </>
            )}
            {llmFallbackReason && (
              <p className="rp-fallback-banner" style={{ margin: 0 }}>narrator offline — using notes ({llmFallbackReason})</p>
            )}
          </div>

          {toast && <div className="rp-toast" role="status">{toast}</div>}
        </div>
      );
    }

    // Building home / tower view
    const activeRoom = building?.activeRoomId
      ? rooms.find((r) => r.id === building.activeRoomId) ?? null
      : null;

    return (
      <div className="rp-building">
        <div className="rp-shell-bg" />
        <div className="rp-shell-streaks">
          <div className="rp-streak rp-streak-1" />
          <div className="rp-streak rp-streak-2" />
        </div>

        <div className="rp-building-head">
          <div>
            <h1 className="rp-building-title">{(building?.name ?? "YOUR BUILDING").toUpperCase()}</h1>
            <div className="rp-building-stats">
              {building ? (() => {
                const sealed = building.floors.length;
                const hasActive = !!building.activeRoomId;
                const totalFloors = sealed + (hasActive ? 1 : 0);
                const survivorCount = building.roster.length;
                const chapters = building.progress?.chapters ?? 0;
                const seasonName = building.progress?.season.name ?? "";
                return (
                  <>
                    <span>{totalFloors} {totalFloors === 1 ? "FLOOR" : "FLOORS"}</span>
                    {hasActive && (<>
                      <span className="sep" />
                      <span className="streak">FLOOR {sealed + 1} LIVE</span>
                    </>)}
                    <span className="sep" />
                    <span>{survivorCount} {survivorCount === 1 ? "SURVIVOR" : "SURVIVORS"}</span>
                    {building.ghosts.length > 0 && (<>
                      <span className="sep" />
                      <span className="lost">{building.ghosts.length} LOST</span>
                    </>)}
                    {building.streak.currentStreak > 1 && (<>
                      <span className="sep" />
                      <span className="streak">{building.streak.currentStreak}d STREAK</span>
                    </>)}
                    <span className="sep" />
                    <span className="streak">{chapters} CH · {seasonName.toUpperCase()}</span>
                  </>
                );
              })() : (
                <span>{rooms.length} {rooms.length === 1 ? "FLOOR" : "FLOORS"}</span>
              )}
            </div>
          </div>
        </div>

        {!building && (
          <button
            type="button"
            className="rp-building-start"
            onClick={() => {
              const b = createBuilding();
              setBuilding(b);
              void saveBuilding(b);
            }}
          >
            START A BUILDING
          </button>
        )}

        {void showObjectives}

        {building && (
          <div className="rp-tower" role="list" aria-label="The building">
            <button
              type="button"
              className="rp-roof"
              onClick={() => {
                if (building) {
                  setSelectedSurvivors(building.roster.slice(0, 3).map((s) => s.id));
                }
                setShowNewRoomForm(true);
              }}
              aria-label="Add a new floor"
            >
              <span className="rp-roof-label">
                <span className="rp-roof-title">ADD A FLOOR</span>
                <span className="rp-roof-sub">build upward · deal ingredients</span>
              </span>
              <span className="rp-roof-btn">+</span>
            </button>

            {activeRoom && (() => {
              const archived = isArchivedRoom(activeRoom);
              const canRegen = archived && !!(activeRoom.prompt && activeRoom.prompt.trim());
              return (
                <div className={`rp-floor is-active ${archived ? "is-archived" : ""}`} role="listitem">
                  <div className="rp-floor-num">{building.floors.length + 1}</div>
                  <div className="rp-floor-body">
                    <MiniRoomCanvas room={activeRoom} />
                    <div className="rp-floor-info">
                      <div className="rp-floor-name">{activeRoom.snapshot.scene.name || activeRoom.name}</div>
                      {archived ? (
                        <div className="rp-floor-status" style={{ color: "var(--ink-dim)" }}>
                          ARCHIVED FLOOR — TOP-DOWN LAYOUT
                        </div>
                      ) : (
                        <div className="rp-floor-status">IN PROGRESS · TENSION {Math.round(activeRoom.snapshot.tension)}</div>
                      )}
                      <div className="rp-floor-cast">
                        {activeRoom.snapshot.characters.filter((c) => !c.transient && !c.dead).map((c) => (
                          <span key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            <span className="dot" style={{ background: c.palette.cloak }} />
                            {c.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    {archived ? (
                      canRegen ? (
                        <button
                          type="button"
                          className="rp-floor-enter"
                          onClick={() => onRegenerateRoom(activeRoom)}
                          title="Rebuild this floor as a side-elevation layout"
                        >REGENERATE ›</button>
                      ) : (
                        <button
                          type="button"
                          className="rp-floor-enter"
                          disabled
                          title="No original prompt saved — delete from localStorage to start fresh"
                          style={{ opacity: 0.5, cursor: "not-allowed" }}
                        >NO PROMPT</button>
                      )
                    ) : (
                      <button type="button" className="rp-floor-enter" onClick={() => onEnterRoom(activeRoom.id)}>ENTER ›</button>
                    )}
                  </div>
                </div>
              );
            })()}

            {building.floors.slice().reverse().map((floor, ri) => (
              <FloorCard key={floor.id} floor={floor} floorNum={building.floors.length - ri} />
            ))}

            <div className="rp-foundation">FOUNDED {relativeTime(building.createdAt).toUpperCase()}</div>
          </div>
        )}

        {lockedAlert && (() => {
          const agoSec = Math.round((Date.now() - lockedAlert.lockedAt) / 1000);
          return (
            <div className="rp-spent-overlay" role="dialog" aria-modal="true">
              <div className="rp-spent-card">
                <h2>IN USE ON ANOTHER DEVICE</h2>
                <p>
                  This floor is being played on another device.{" "}
                  Last heartbeat {agoSec}s ago.
                </p>
                <button
                  type="button"
                  className="rp-btn-primary"
                  style={{ width: "100%", justifyContent: "center" }}
                  onClick={async () => {
                    const targetId = lockedAlert.roomId;
                    setLockedAlert(null);
                    // Take over: push the room with takeOver flag (stamps new lock)
                    const loaded = loadRoomById(targetId, performance.now());
                    if (!loaded) return;
                    // Immediately push taking over
                    const saved = listRooms().find((r) => r.id === targetId);
                    if (saved) {
                      await pushRoom(saved, { takeOver: true });
                      setRoomLocks((prev) => {
                        const next = { ...prev };
                        delete next[targetId];
                        return next;
                      });
                    }
                    stateRef.current = loaded;
                    resetCodaFlag();
                    setState({ ...loaded });
                  }}
                >
                  TAKE OVER
                </button>
                <button
                  type="button"
                  className="rp-btn-ghost"
                  style={{ width: "100%", marginTop: 10, justifyContent: "center" }}
                  onClick={() => setLockedAlert(null)}
                >
                  NEVER MIND
                </button>
              </div>
            </div>
          );
        })()}
      </div>
    );
  }

  // ─── In-Floor (playing phase) — full-bleed cinema ─────────────────────
  const effectiveNow =
    state.paused && pausedAtRef.current !== null
      ? pausedAtRef.current
      : performance.now();
  const hour = simHour(effectiveNow, state.simStartedAt);
  const { clock: clockFace, label: clockLabel } = formatSimTime(hour);
  const tensionPct = Math.min(100, state.tension);
  const liveCast = state.characters.filter((c) => !c.transient && !c.dead);

  return (
    <div className="rp-shell">
      <div className="rp-shell-bg" />
      <div className="rp-shell-streaks">
        <div className="rp-streak rp-streak-1" />
        <div className="rp-streak rp-streak-2" />
        <div className="rp-streak rp-streak-3" />
      </div>

      {/* Help overlay */}
      {showHelp && (
        <div className="rp-help-overlay" role="dialog" aria-modal="true" onClick={() => setShowHelp(false)}>
          <div className="rp-help-card" onClick={(e) => e.stopPropagation()}>
            <h2>SHORTCUTS</h2>
            <dl className="rp-help-list">
              <dt>Space</dt><dd>pause / play</dd>
              <dt>Z</dt><dd>rewind one beat</dd>
              <dt>S</dt><dd>skip current narration</dd>
              <dt>L</dt><dd>show / hide story log</dd>
              <dt>/</dt><dd>focus the directive input</dd>
              <dt>?</dt><dd>open / close this panel</dd>
              <dt>Esc</dt><dd>close this panel</dd>
            </dl>
            <p className="rp-help-tip">Click the canvas to skip a line.</p>
          </div>
        </div>
      )}

      {/* Spent overlay */}
      {spent && (
        <div className="rp-spent-overlay" role="dialog" aria-modal="true">
          <div className="rp-spent-card">
            <h2>THIS FLOOR HAS SPENT ITSELF</h2>
            <p>The story on this floor is over. What happens next is one floor up.</p>
            {building ? (
              <>
                <button
                  type="button"
                  className="rp-btn-primary"
                  style={{ width: "100%", justifyContent: "center" }}
                  onClick={() => {
                    void (async () => {
                      const live = stateRef.current;
                      const bld = buildingRef.current;
                      if (!bld) return;
                      setNarratorThinking(true);
                      const epitaph = await fetchEpitaph(live);
                      spendRoom(live, bld, epitaph);
                      bld.streak.totalRoomsSpent += 1;
                      rollObjectivesIfNeeded(bld);
                      const done = evaluateObjectives(bld);
                      for (const o of done) flashToast(`+${o.reward} · ${o.label}`);
                      await saveBuilding(bld);
                      setBuilding({ ...bld });
                      setNarratorThinking(false);
                      onEndScene();
                    })();
                  }}
                  disabled={narratorThinking}
                >
                  {narratorThinking ? "SEALING…" : "SEAL THIS FLOOR"}
                </button>
                <p className="rp-spent-sub">
                  {extractSurvivorsCount(state)} SURVIVOR{extractSurvivorsCount(state) !== 1 ? "S" : ""} WILL CARRY UP
                </p>
              </>
            ) : (
              <button
                type="button"
                className="rp-btn-primary"
                style={{ width: "100%", justifyContent: "center" }}
                onClick={onEndScene}
              >
                START A NEW FLOOR
              </button>
            )}
          </div>
        </div>
      )}

      {/* Top chrome */}
      <div className="rp-top">
        <div className="rp-top-left">
          <button
            type="button"
            className="rp-icon-btn"
            onClick={onBackToMenu}
            title="Back to the building"
            aria-label="Back to the building"
          >
            ‹
          </button>
        </div>
        <div className="rp-top-center">
          <h1 className="rp-floor-title">FLOOR {state.floorIndex >= 0 ? state.floorIndex + 1 : ""}</h1>
          <div className="rp-scene-name">{state.scene.name}</div>
        </div>
        <div className="rp-top-right">
          <div className="rp-clock" aria-label={`${clockFace}, ${clockLabel}`}>
            <span className="rp-clock-face">{clockFace}</span>
            <span className="rp-clock-label">{clockLabel}</span>
          </div>
        </div>
      </div>

      {/* Tension rail */}
      <div className="rp-tension-rail" aria-label={`Tension ${Math.round(state.tension)}`}>
        <span className="rp-tension-label">TENSION</span>
        <div className="rp-tension-track">
          <div className={`rp-tension-fill ${spent ? "is-spent" : ""}`} style={{ width: `${tensionPct}%` }} />
        </div>
        <span className="rp-tension-label" style={{ minWidth: 28, textAlign: "right" }}>{Math.round(state.tension)}</span>
      </div>

      {state.stakes && (
        <div className="rp-stakes-strip" role="note">
          <span className="tag">THE STAKES</span>{state.stakes}
        </div>
      )}

      {/* Stage (canvas) — sized by ResizeObserver to fill the frame. */}
      <div className="rp-stage">
        <div className="rp-canvas-frame">
          <canvas
            ref={canvasRef}
            className={`rp-canvas ${state.pending ? "is-skippable" : ""}`}
            onClick={state.pending ? onSkipLine : undefined}
            title={state.pending ? "Click to skip this line" : undefined}
          />
        </div>

        {/* Desktop cast drawer (left) — hidden on mobile via media query */}
        <aside className="rp-drawer rp-drawer-left" aria-label="Cast">
          <div className="rp-drawer-head">
            <span>THE CAST</span>
            <span>{liveCast.length}</span>
          </div>
          {liveCast.map((c) => (
            <div key={c.id} className="rp-cast-card">
              <div className="rp-cast-head">
                <span className="rp-cast-dot" style={{ background: c.palette.cloak }} />
                <span className="rp-cast-name">{c.name}</span>
                <span className="rp-cast-mood">· {c.mood}</span>
              </div>
              {c.description && <div className="rp-cast-desc">{c.description}</div>}
              {c.inventory.length > 0 && (
                <div className="rp-cast-inv">carries: {c.inventory.join(", ")}</div>
              )}
              {c.objective && <div className="rp-cast-desc" style={{ color: "var(--ink-dim)", fontStyle: "italic" }}>wants: {c.objective}</div>}
            </div>
          ))}
        </aside>

        {/* Desktop / mobile log panel */}
        {showLog && (
          <aside className="rp-log-panel" aria-label="Story log">
            <div className="rp-log-handle" />
            <div className="rp-log-head">
              <span>STORY LOG · {state.log.length}</span>
              <button type="button" onClick={() => setShowLog(false)} style={{ background: "none", border: "none", color: "var(--ink-dim)", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10 }}>× CLOSE</button>
            </div>
            {state.log.length === 0 ? (
              <div className="rp-log-empty">Nothing has happened yet.</div>
            ) : (
              <ul className="rp-log-list">
                {[...state.log].reverse().map((l) => (
                  <li key={l.id} className={`rp-log-line kind-${l.kind}`}>
                    {l.kind === "action" && <span className="rp-log-tag">action</span>}
                    {l.kind === "ambient" && <span className="rp-log-tag dim">ambient</span>}
                    {l.text}
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
      </div>

      {/* Live region for screen readers */}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {pending ? shown : narratorThinking ? "the narrator is thinking" : ""}
      </div>

      {llmFallbackReason && (
        <p className="rp-fallback-banner" role="status">
          narrator offline — using notes ({llmFallbackReason})
        </p>
      )}

    </div>
  );
  })();

  // ─── Persistent dock + sheets at the top of the layer stack ────────────
  // Rendered ONCE, outside the phase-specific view content. React keeps
  // this element alive across setup ⇄ playing transitions, so nothing
  // flickers or remounts when you enter / leave a floor.
  const inPlay = state.phase === "playing";
  const spentNow = state.phase === "playing" && state.tension >= 100;
  return (
    <>
      {viewNode}

      <div className="rp-dock">
        {inPlay ? (
          <>
            <form
              className="rp-dock-directive"
              onSubmit={(e) => { e.preventDefault(); void onSubmitDirective(); }}
            >
              <span
                className={`rp-directive-pulse ${narratorThinking ? "" : busy ? "is-off" : ""}`}
                aria-hidden="true"
              />
              <label className="visually-hidden" htmlFor="rp-directive-input">What happens next</label>
              <input
                id="rp-directive-input"
                type="text"
                className="rp-directive-input"
                placeholder={
                  narratorThinking
                    ? "director is composing…"
                    : busy
                      ? "the floor is unfolding…"
                      : "What happens next?"
                }
                value={directive}
                onChange={(e) => setDirective(e.target.value)}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="submit"
                className="rp-directive-send"
                disabled={busy || !directive.trim()}
                aria-label="Submit"
              >
                ↑
              </button>
            </form>
            <div className="rp-dock-row">
              <button
                type="button"
                className="rp-dock-menu"
                onClick={() => setActiveSheet("menu")}
                title="Menu"
                aria-label="Menu"
              >
                ☰
              </button>
              <div className="rp-dock-tape" role="group" aria-label="Playback">
                <button type="button" className="rp-icon-btn" onClick={onRewind} disabled={state.history.length === 0 || spentNow} title={state.history.length === 0 ? "Nothing to rewind" : `Rewind (${state.history.length})`} aria-label="Rewind">⟲</button>
                <button type="button" className={`rp-icon-btn ${!state.paused ? "is-active" : ""}`} onClick={onTogglePause} title={state.paused ? "Play" : "Pause"} aria-label={state.paused ? "Play" : "Pause"}>{state.paused ? "▶" : "❚❚"}</button>
                <button type="button" className="rp-icon-btn" onClick={onSkipLine} disabled={!state.pending} title="Skip line" aria-label="Skip line">⏭</button>
                <button type="button" className="rp-icon-btn" onClick={onToggleSpeed} title={`Reading speed ${state.narrationSpeed >= 2 ? "2x" : "1x"}`} aria-pressed={state.narrationSpeed >= 2}>{state.narrationSpeed >= 2 ? "2×" : "1×"}</button>
                <button type="button" className="rp-icon-btn" onClick={() => setShowLog((v) => !v)} title={showLog ? "Hide log" : "Show log"} aria-pressed={showLog}>☰</button>
              </div>
            </div>
          </>
        ) : (
          <div className="rp-dock-tabs">
            <button
              type="button"
              className="rp-dock-tab"
              aria-pressed={activeSheet === "profile"}
              onClick={() => setActiveSheet(activeSheet === "profile" ? null : "profile")}
            >
              <span className="rp-dock-tab-glyph">◉</span>
              <span className="rp-dock-tab-label">PROFILE</span>
            </button>
            <button
              type="button"
              className="rp-dock-tab"
              aria-pressed={activeSheet === "season"}
              onClick={() => setActiveSheet(activeSheet === "season" ? null : "season")}
            >
              <span className="rp-dock-tab-glyph">☼</span>
              <span className="rp-dock-tab-label">SEASON</span>
            </button>
            <button
              type="button"
              className="rp-dock-tab"
              aria-pressed={activeSheet === "settings"}
              onClick={() => setActiveSheet(activeSheet === "settings" ? null : "settings")}
            >
              <span className="rp-dock-tab-glyph">⚙</span>
              <span className="rp-dock-tab-label">SETTINGS</span>
            </button>
            <button
              type="button"
              className="rp-dock-tab"
              aria-pressed
              onClick={() => setActiveSheet(null)}
              title="You're on the building view"
            >
              <span className="rp-dock-tab-glyph">⌂</span>
              <span className="rp-dock-tab-label">BUILDING</span>
            </button>
          </div>
        )}
      </div>

      {activeSheet && (
        <Sheet
          active={activeSheet}
          setActive={setActiveSheet}
          building={building}
          setBuilding={setBuilding}
          userId={getUserId()}
          onBackToMenu={onBackToMenu}
          onShowObjectives={() => setActiveSheet("season")}
          onShowHelp={() => { setActiveSheet(null); setShowHelp(true); }}
          onSignOut={() => { clearSession(); window.location.reload(); }}
          onToggleSpeed={onToggleSpeed}
          narrationSpeed={state.narrationSpeed}
          inPlay={inPlay}
        />
      )}

      {toast && <div className="rp-toast" role="status">{toast}</div>}
    </>
  );
}

// ─── Canvas drawing ────────────────────────────────────────────────────────

// ─── Home screen: room card + thumbnail ───────────────────────────────────

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function IngredientPicker({
  selected,
  onToggle,
  onShuffle,
  onClear,
}: {
  selected: string[];
  onToggle: (id: string) => void;
  onShuffle: () => void;
  onClear: () => void;
}) {
  const categories: IngredientCategory[] = ["where", "who", "what", "when", "mood", "trouble"];
  return (
    <div className="rp-ingredients">
      <div className="rp-ingredients-head">
        <span className="rp-ingredients-label">
          pick 2–6 ingredients{selected.length > 0 ? ` · ${selected.length} chosen` : ""}
        </span>
        <div className="rp-ingredients-actions">
          <button type="button" className="rp-ingredients-btn" onClick={onShuffle}>
            shuffle
          </button>
          {selected.length > 0 && (
            <button type="button" className="rp-ingredients-btn" onClick={onClear}>
              clear
            </button>
          )}
        </div>
      </div>
      {categories.map((cat) => {
        const cards = INGREDIENTS.filter((c) => c.category === cat);
        return (
          <div key={cat} className="rp-ingredients-row">
            <div className="rp-ingredients-cat">{CATEGORY_LABELS[cat]}</div>
            <div className="rp-ingredients-cards">
              {cards.map((card) => {
                const isOn = selected.includes(card.id);
                return (
                  <button
                    key={card.id}
                    type="button"
                    className={`rp-ingredient ${isOn ? "on" : ""}`}
                    onClick={() => onToggle(card.id)}
                    title={card.label}
                    aria-pressed={isOn}
                  >
                    <span className="rp-ingredient-glyph">{card.glyph}</span>
                    <span className="rp-ingredient-label">{card.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FloorCard({ floor, floorNum }: { floor: SpentFloor; floorNum: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cols = floor.thumbnailScene?.map?.[0]?.length ?? 16;
  const rows = floor.thumbnailScene?.map?.length ?? 11;
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    try {
      drawMiniRoom(ctx, {
        scene: floor.thumbnailScene,
        characters: floor.thumbnailCharacters as unknown as Character[],
      } as unknown as GameState);
    } catch {
      ctx.fillStyle = "#1a1620";
      ctx.fillRect(0, 0, c.width, c.height);
    }
  }, [floor.id]);

  return (
    <div className="rp-floor is-sealed" role="listitem">
      <div className="rp-floor-num">{floorNum}</div>
      <div className="rp-floor-body">
        <canvas
          ref={ref}
          className="rp-floor-thumb"
          width={cols * 8}
          height={rows * 8}
          aria-hidden="true"
        />
        <div className="rp-floor-info">
          <div className="rp-floor-name">{floor.name}</div>
          <div className="rp-floor-epitaph">{floor.epitaph}</div>
          <div className="rp-floor-meta">
            {floor.survivors.length > 0 && (
              <span className="survived">{floor.survivors.map((s) => s.name).join(", ")} SURVIVED</span>
            )}
            {floor.ghosts.length > 0 && (
              <span className="lost">{floor.ghosts.map((g) => g.name).join(", ")} LOST</span>
            )}
          </div>
        </div>
        <span className="rp-floor-tag">SEALED</span>
      </div>
    </div>
  );
}

// ─── Drawer sheets ──────────────────────────────────────────────────────

type SheetKind = "profile" | "season" | "settings" | "menu";
interface SheetProps {
  active: SheetKind;
  setActive: (s: SheetKind | null) => void;
  building: BuildingState | null;
  setBuilding: (b: BuildingState | null) => void;
  userId: string | null;
  onBackToMenu: () => void;
  onShowObjectives: () => void;
  onShowHelp: () => void;
  onSignOut: () => void;
  onToggleSpeed: () => void;
  narrationSpeed: number;
  inPlay: boolean;
}

function Sheet(props: SheetProps) {
  const { active, setActive, building, setBuilding, userId, onBackToMenu, onShowHelp, onSignOut, inPlay } = props;
  const close = () => setActive(null);

  const titles: Record<SheetKind, { title: string; sub: string }> = {
    profile: { title: "PROFILE", sub: "your identity · your devices" },
    season: {
      title: "SEASON",
      sub: building?.progress?.season.name ?? "this season",
    },
    settings: { title: "SETTINGS", sub: "preferences · sync" },
    menu: { title: "MENU", sub: "while on this floor" },
  };

  return (
    <>
      <div className="rp-sheet-backdrop" onClick={close} />
      <div className="rp-sheet" role="dialog" aria-modal="true">
        <div className="rp-sheet-handle" />
        <div className="rp-sheet-head">
          <div>
            <div className="rp-sheet-title">{titles[active].title}</div>
            <div className="rp-sheet-sub">{titles[active].sub}</div>
          </div>
          <button type="button" className="rp-sheet-close" onClick={close} aria-label="Close">×</button>
        </div>

        {active === "profile" && (
          <div>
            <div className="rp-sheet-row">
              <span className="rp-sheet-row-label">User id</span>
              <span className="rp-sheet-row-val">{userId ?? "—"}</span>
            </div>
            <div className="rp-sheet-row">
              <span className="rp-sheet-row-label">Device id</span>
              <span className="rp-sheet-row-val">{getDeviceId().slice(0, 12)}…</span>
            </div>
            <div className="rp-sheet-row">
              <span className="rp-sheet-row-label">Building</span>
              <span className="rp-sheet-row-val">{building?.name ?? "—"}</span>
            </div>
            <button type="button" className="rp-sheet-action danger" onClick={onSignOut}>
              SIGN OUT OF THIS DEVICE
            </button>
          </div>
        )}

        {active === "season" && building?.progress && (
          <div>
            <ObjectivesPanel building={building} />
          </div>
        )}
        {active === "season" && !building?.progress && (
          <div className="rp-sheet-row-val" style={{ textAlign: "center", padding: 24 }}>
            No season in progress — start a building first.
          </div>
        )}

        {active === "settings" && (
          <div>
            <BuildingNameEditor building={building} setBuilding={setBuilding} />
            <div className="rp-sheet-row">
              <span className="rp-sheet-row-label">Sync</span>
              <span className="rp-sheet-row-val">auto · every change</span>
            </div>
            <div className="rp-sheet-row">
              <span className="rp-sheet-row-label">Device id</span>
              <span className="rp-sheet-row-val">{getDeviceId().slice(0, 12)}…</span>
            </div>
            <button type="button" className="rp-sheet-action" onClick={onShowHelp}>
              KEYBOARD SHORTCUTS
            </button>
            <button
              type="button"
              className="rp-sheet-action danger"
              onClick={() => {
                if (confirm("Clear local cache? Your server-synced data stays safe.")) {
                  try {
                    localStorage.removeItem("augur-sync-versions");
                    indexedDB.deleteDatabase("augur");
                  } catch { /* ignore */ }
                  window.location.reload();
                }
              }}
            >
              CLEAR LOCAL CACHE
            </button>
            <button type="button" className="rp-sheet-action danger" onClick={onSignOut}>
              SIGN OUT
            </button>
          </div>
        )}

        {active === "menu" && inPlay && (
          <div>
            <button type="button" className="rp-sheet-action primary" onClick={() => { setActive(null); onBackToMenu(); }}>
              ← BACK TO THE BUILDING
            </button>
            <button type="button" className="rp-sheet-action" onClick={() => setActive("season")}>
              SEASON · OBJECTIVES
            </button>
            <button type="button" className="rp-sheet-action" onClick={() => setActive("settings")}>
              SETTINGS
            </button>
            <button type="button" className="rp-sheet-action" onClick={() => setActive("profile")}>
              PROFILE
            </button>
            <button type="button" className="rp-sheet-action" onClick={onShowHelp}>
              KEYBOARD SHORTCUTS
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function BuildingNameEditor({
  building,
  setBuilding,
}: {
  building: BuildingState | null;
  setBuilding: (b: BuildingState | null) => void;
}) {
  const [val, setVal] = useState(building?.name ?? "");
  useEffect(() => { setVal(building?.name ?? ""); }, [building?.id]);
  if (!building) return null;
  return (
    <div className="rp-sheet-row">
      <span className="rp-sheet-row-label">Building name</span>
      <input
        type="text"
        className="rp-sheet-input"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => {
          const trimmed = val.trim();
          if (!trimmed || trimmed === building.name) return;
          const next = { ...building, name: trimmed };
          setBuilding(next);
          void saveBuilding(next);
        }}
        maxLength={40}
      />
    </div>
  );
}

function ObjectivesPanel({ building }: { building: BuildingState }) {
  const p = building.progress!;
  if (p.objectives.length === 0) return null;
  const order: Array<"daily" | "weekly" | "seasonal"> = ["daily", "weekly", "seasonal"];
  const groupLabel: Record<string, string> = {
    daily: "TODAY",
    weekly: "THIS WEEK",
    seasonal: `SEASON · ${p.season.name.toUpperCase()}`,
  };
  return (
    <section className="rp-objectives" aria-label="Objectives">
      <div className="rp-objectives-head">
        <span className="lbl">CHAPTERS</span>
        <span className="ch">{p.chapters}</span>
      </div>
      {order.map((kind) => {
        const list = p.objectives.filter((o) => o.kind === kind);
        if (list.length === 0) return null;
        return (
          <div key={kind} className="rp-objectives-group">
            <div className="rp-objectives-group-label">{groupLabel[kind]}</div>
            <ul className="rp-objectives-list">
              {list.map((o) => {
                const done = p.completedIds.includes(o.id);
                const { progress } = checkObjective(o, building);
                const target = o.target ?? 1;
                const pct = Math.min(100, Math.round((progress / Math.max(1, target)) * 100));
                return (
                  <li key={o.id} className={`rp-obj ${done ? "is-done" : ""}`}>
                    <div className="rp-obj-top">
                      <span className="rp-obj-label">{o.label}</span>
                      <span className="rp-obj-reward">+{o.reward}</span>
                    </div>
                    <div className="rp-obj-desc">{o.desc}</div>
                    <div className="rp-obj-track">
                      <div className="rp-obj-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="rp-obj-meta">
                      {done ? "EARNED" : `${Math.min(progress, target)} / ${target}`}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

const MINI_TPX = 12; // 16 * 12 = 192 wide; 11 * 12 = 132 tall

function MiniRoomCanvas({ room }: { room: SavedRoom }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cols = room.snapshot.scene?.map?.[0]?.length ?? 16;
  const rows = room.snapshot.scene?.map?.length ?? 11;
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    try {
      drawMiniRoom(ctx, room.snapshot);
    } catch {
      ctx.fillStyle = "#1a1620";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = "#6a5038";
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillText("(snapshot malformed)", 8, 16);
    }
  }, [room.id, room.lastPlayedAt, room.snapshot]);
  return (
    <canvas
      ref={ref}
      className="rp-floor-thumb"
      width={cols * MINI_TPX}
      height={rows * MINI_TPX}
      aria-hidden="true"
    />
  );
}

function drawMiniRoom(ctx: CanvasRenderingContext2D, s: GameState) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const TPX = MINI_TPX;
  // Always paint a base so cards never look empty.
  ctx.fillStyle = "#13101a";
  ctx.fillRect(0, 0, W, H);
  if (!s || !s.scene || !Array.isArray(s.scene.map) || s.scene.map.length === 0) {
    ctx.fillStyle = "#6a5038";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText("(empty)", 10, 18);
    return;
  }
  const map = s.scene.map;
  const FLOOR = "#2e2a3a";
  const FLOOR_ALT = "#3a3346";
  for (let y = 0; y < map.length; y++) {
    const row = map[y] ?? "";
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const px = x * TPX;
      const py = y * TPX;
      if (ch === "#") {
        // Stone wall — warm grey with top highlight
        ctx.fillStyle = "#5a4a38";
        ctx.fillRect(px, py, TPX, TPX);
        ctx.fillStyle = "#7a6a4a";
        ctx.fillRect(px, py, TPX, 2);
      } else if (ch === "~") {
        // Hearth glow
        ctx.fillStyle = "#d8602a";
        ctx.fillRect(px, py, TPX, TPX);
        ctx.fillStyle = "#ffc070";
        ctx.fillRect(px + 2, py + 2, TPX - 4, TPX - 4);
      } else if (ch === "w") {
        // Window
        ctx.fillStyle = "#5a4a38";
        ctx.fillRect(px, py, TPX, TPX);
        ctx.fillStyle = "#6a8ab8";
        ctx.fillRect(px + 2, py + 2, TPX - 4, TPX - 4);
      } else if (ch === "b") {
        ctx.fillStyle = FLOOR;
        ctx.fillRect(px, py, TPX, TPX);
        ctx.fillStyle = "#7a6a58";
        ctx.fillRect(px + 1, py + 3, TPX - 2, TPX - 4);
      } else if (ch === "t") {
        ctx.fillStyle = FLOOR;
        ctx.fillRect(px, py, TPX, TPX);
        ctx.fillStyle = "#8a6a3a";
        ctx.fillRect(px + 1, py + 4, TPX - 2, TPX - 6);
      } else if (ch === "c") {
        ctx.fillStyle = FLOOR;
        ctx.fillRect(px, py, TPX, TPX);
        ctx.fillStyle = "#6a5030";
        ctx.fillRect(px + 3, py + 3, TPX - 6, TPX - 6);
      } else if (ch === "=") {
        ctx.fillStyle = FLOOR;
        ctx.fillRect(px, py, TPX, TPX);
        ctx.fillStyle = "#a8783a";
        ctx.fillRect(px, py + 4, TPX, 3);
      } else if (ch === "|") {
        // Door
        ctx.fillStyle = "#8a4a1a";
        ctx.fillRect(px, py, TPX, TPX);
        ctx.fillStyle = "#d8a04a";
        ctx.fillRect(px + TPX - 3, py + TPX / 2, 2, 2);
      } else if (ch === "l") {
        ctx.fillStyle = FLOOR;
        ctx.fillRect(px, py, TPX, TPX);
        ctx.fillStyle = "#e8c86a";
        ctx.fillRect(px + TPX / 2 - 1, py + TPX / 2 - 1, 3, 3);
      } else if (ch === "R") {
        ctx.fillStyle = "#4a3a1a";
        ctx.fillRect(px, py, TPX, TPX);
      } else if (s.scene.palette && s.scene.palette[ch]) {
        // Custom palette tile
        const entry = s.scene.palette[ch];
        ctx.fillStyle = FLOOR;
        ctx.fillRect(px, py, TPX, TPX);
        if (entry.walkable) {
          ctx.fillStyle = entry.color;
          ctx.globalAlpha = 0.45;
          ctx.fillRect(px + 2, py + 2, TPX - 4, TPX - 4);
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = entry.color;
          ctx.fillRect(px + 1, py + 2, TPX - 2, TPX - 4);
          if (entry.glow) {
            ctx.fillStyle = "rgba(255,220,140,0.5)";
            ctx.fillRect(px + 3, py + 4, TPX - 6, TPX - 8);
          }
        }
      } else {
        // Floor checker for visibility
        ctx.fillStyle = (x + y) % 2 === 0 ? FLOOR : FLOOR_ALT;
        ctx.fillRect(px, py, TPX, TPX);
      }
    }
  }
  // Soft hearth glow
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < (map[y]?.length ?? 0); x++) {
      if (map[y][x] === "~") {
        const cx = x * TPX + TPX / 2;
        const cy = y * TPX + TPX / 2;
        const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 28);
        g.addColorStop(0, "rgba(255,180,80,0.28)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(cx - 28, cy - 28, 56, 56);
      }
    }
  }
  // Characters (dead drawn faint). Give each a thin dark outline so they
  // read clearly against the floor.
  for (const c of s.characters ?? []) {
    const px = c.pos.x * TPX;
    const py = c.pos.y * TPX;
    ctx.globalAlpha = c.dead ? 0.35 : 1;
    ctx.fillStyle = "#0a0806";
    ctx.fillRect(px + 1, py + 1, TPX - 2, TPX - 2);
    ctx.fillStyle = c.palette.cloak;
    ctx.fillRect(px + 2, py + 3, TPX - 4, TPX - 5);
    ctx.fillStyle = c.palette.body;
    ctx.fillRect(px + 3, py + 2, TPX - 6, 4);
    ctx.fillStyle = c.palette.accent;
    ctx.fillRect(px + TPX / 2 - 1, py + 1, 2, 2);
    ctx.globalAlpha = 1;
  }
  // Candle_lit tiny glow (on a table anchor if present)
  if (s.flags?.candle_lit === "yes") {
    const t = s.scene.anchors.table_a ?? s.scene.anchors.table ?? s.scene.anchors.center;
    if (t) {
      const cx = t.x * TPX + TPX / 2;
      const cy = t.y * TPX + TPX / 2;
      const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, 20);
      g.addColorStop(0, "rgba(255,220,130,0.5)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(cx - 20, cy - 20, 40, 40);
    }
  }
  // Door bolted indicator: a bar on the door anchor
  if (s.flags?.door_bolted === "yes") {
    const d = s.scene.anchors.door_in;
    if (d) {
      const cx = d.x * TPX + TPX / 2;
      const cy = d.y * TPX + TPX / 2;
      ctx.fillStyle = "#7a7a80";
      ctx.fillRect(cx - 8, cy + 2, 16, 2);
    }
  }
  // Dim overlay for spent rooms
  if ((s.tension ?? 0) >= 100) {
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, W, H);
  }
}

// Draw discoverable items around the room at their anchor positions.
// Items without anchors get placed near "center". Each renders as a small
// glowing dot with its name floating beside it.
function drawRoomItems(
  ctx: CanvasRenderingContext2D,
  scene: AnyScene,
  items: Array<{ name: string; description: string; anchor?: string }>,
  now: number,
) {
  if (items.length === 0) return;
  ctx.save();
  ctx.font = "7px ui-monospace, SF Mono, monospace";
  ctx.textBaseline = "middle";
  // Group items sharing an anchor so we can stack their labels vertically
  // instead of scattering them horizontally (which caused overlap with the
  // character nameplates sitting on the same floor row).
  const perAnchor = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const anchorName = it.anchor && scene.anchors[it.anchor] ? it.anchor : "center";
    const a = scene.anchors[anchorName] ?? { x: 8, y: 5 };
    const stackIdx = perAnchor.get(anchorName) ?? 0;
    perAnchor.set(anchorName, stackIdx + 1);
    const px = a.x * TILE_PX + TILE_PX / 2;
    // Glow dot sits on the anchor tile's top edge (where the item rests).
    const py = a.y * TILE_PX + 4;
    // Warm glow pulse on the dot.
    const pulse = 0.5 + 0.3 * Math.sin(now / 600 + i * 1.7);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = "#e8c86a";
    ctx.beginPath();
    ctx.arc(px, py, 2.5, 0, Math.PI * 2);
    ctx.fill();
    // Label floats ABOVE the anchor, stacked per collision index so
    // multiple items on the same tile list cleanly top-down.
    ctx.globalAlpha = 0.85;
    const label = it.name.length > 14 ? it.name.slice(0, 12) + "…" : it.name;
    const tw = ctx.measureText(label).width;
    const labelH = 9;
    const labelY = py - 10 - stackIdx * (labelH + 2);
    const labelX = px - (tw + 6) / 2;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(labelX, labelY, tw + 6, labelH);
    ctx.fillStyle = "#e8c86a";
    ctx.fillText(label, labelX + 3, labelY + labelH / 2);
    // Connecting tether so the label visibly belongs to the dot.
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = "#e8c86a";
    ctx.fillRect(px - 0.5, labelY + labelH, 1, py - (labelY + labelH) - 1);
  }
  ctx.restore();
}

type TileCtx = {
  floorY: number;
  neighborLeft: string;
  neighborRight: string;
  neighborAbove: string;
  neighborBelow: string;
};

function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: {
    map: string[];
    floor_y: number;
    anchors: Record<string, { x: number; y: number }>;
    palette?: Record<string, { name: string; color: string; walkable: boolean; glow?: boolean }>;
  },
  now: number,
  band?: { topRow: number; bottomRow: number },
) {
  const rows = scene.map.length;
  const cols = scene.map[0]?.length ?? 0;
  const floorY = scene.floor_y;
  const worldW = cols * TILE_PX;
  const worldH = rows * TILE_PX;
  const floorPx = (floorY + 1) * TILE_PX;

  // Interior band bounds in world pixels. Fall back to the whole map when
  // the caller doesn't pass a band (keeps older call sites working).
  const bandTopPx = (band?.topRow ?? 0) * TILE_PX;
  const bandBottomPx = (band?.bottomRow ?? rows) * TILE_PX;

  // Vertical gradient background: interior dusk → floor line → foundation.
  // Stops are expressed as fractions of worldH so the existing gradient
  // reuses the same coordinate system as the rest of the scene.
  const bgGrad = ctx.createLinearGradient(0, 0, 0, worldH);
  bgGrad.addColorStop(0, "#12182a");
  const interiorStart = Math.max(0, (floorPx - TILE_PX * 6) / worldH);
  const floorStop = Math.max(0.001, Math.min(1, floorPx / worldH));
  bgGrad.addColorStop(Math.min(interiorStart, floorStop - 0.001), "#1a1628");
  bgGrad.addColorStop(Math.max(0.001, floorStop - 0.001), "#140f10");
  bgGrad.addColorStop(floorStop, "#0f0906");
  bgGrad.addColorStop(1, "#05030a");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, worldW, worldH);

  // Back-wall wash inside the visible band: soft vertical plank stripes
  // so the interior reads as an enclosed space instead of open sky.
  const backTop = Math.max(bandTopPx, 0);
  const backBottom = Math.min(bandBottomPx, floorPx);
  if (backBottom > backTop) {
    ctx.fillStyle = "rgba(60,42,24,0.08)";
    ctx.fillRect(0, backTop, worldW, backBottom - backTop);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    for (let x = TILE_PX; x < worldW; x += TILE_PX) {
      ctx.fillRect(x, backTop, 1, backBottom - backTop);
    }
    ctx.fillStyle = "rgba(210,170,110,0.06)";
    for (let x = TILE_PX; x < worldW; x += TILE_PX) {
      ctx.fillRect(x - 1, backTop, 1, backBottom - backTop);
    }
    // Ceiling shadow band at the top of the interior.
    const capH = Math.min(TILE_PX / 2, backBottom - backTop);
    const capGrad = ctx.createLinearGradient(0, backTop, 0, backTop + capH);
    capGrad.addColorStop(0, "rgba(0,0,0,0.45)");
    capGrad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = capGrad;
    ctx.fillRect(0, backTop, worldW, capH);
  }

  // Tiles
  for (let r = 0; r < rows; r++) {
    const row = scene.map[r] ?? "";
    for (let c = 0; c < cols; c++) {
      const ch = row[c] ?? " ";
      const sctx: TileCtx = {
        floorY,
        neighborLeft: row[c - 1] ?? " ",
        neighborRight: row[c + 1] ?? " ",
        neighborAbove: scene.map[r - 1]?.[c] ?? " ",
        neighborBelow: scene.map[r + 1]?.[c] ?? " ",
      };
      drawTile(ctx, c, r, ch, now, sctx, scene.palette);
    }
  }

  // Floor plank surface: a visible horizontal line so characters read as
  // standing ON the floor, not floating. Only paint over walkable columns
  // (don't overdraw walls/doors/hearth bases).
  {
    const plankTopY = floorY * TILE_PX;
    const plankBodyH = TILE_PX;
    const floorRow = scene.map[floorY] ?? "";
    for (let c = 0; c < cols; c++) {
      const ch = floorRow[c] ?? " ";
      // Skip tiles that already render their own base (walls, doors, hearth,
      // furniture with palette entries). Walk only paints over air/floor.
      if (ch !== "." && ch !== " ") continue;
      const x = c * TILE_PX;
      // Plank boards
      ctx.fillStyle = "#2a1d12";
      ctx.fillRect(x, plankTopY, TILE_PX, plankBodyH);
      // Woodgrain highlight strip (very top — catches a rim of light)
      ctx.fillStyle = "rgba(200,150,90,0.22)";
      ctx.fillRect(x, plankTopY, TILE_PX, 2);
      ctx.fillStyle = "rgba(230,180,110,0.35)";
      ctx.fillRect(x, plankTopY, TILE_PX, 1);
      // Plank seams
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(x, plankTopY, 1, plankBodyH);
      // Faint grain lines
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      for (let gy = 6; gy < plankBodyH - 2; gy += 9) {
        ctx.fillRect(x + ((c * 7 + gy) % (TILE_PX - 4)), plankTopY + gy, 3, 1);
      }
      // Baseboard shadow just under the plank top for contact depth
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(x, plankTopY + 3, TILE_PX, 1);
    }
  }

  // Hearth/custom glow pool
  for (let r = 0; r < rows; r++) {
    const row = scene.map[r] ?? "";
    for (let c = 0; c < cols; c++) {
      const ch = row[c];
      const isGlow = ch === "~" || scene.palette?.[ch]?.glow;
      if (!isGlow) continue;
      const hx = c * TILE_PX + TILE_PX / 2;
      const hy = r * TILE_PX + TILE_PX - TILE_PX / 3;
      const flick = (Math.sin(now / 180) + 1) / 2;
      const g = ctx.createRadialGradient(hx, hy, 12, hx, hy, 160);
      g.addColorStop(0, `rgba(255,200,110,${0.22 + flick * 0.1})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(hx - 160, hy - 160, 320, 320);
    }
  }
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  c: number,
  r: number,
  ch: string,
  now: number,
  sctx: TileCtx,
  palette?: Record<string, { name: string; color: string; walkable: boolean; glow?: boolean }>,
) {
  const x = c * TILE_PX;
  const y = r * TILE_PX;
  const T = TILE_PX;
  const isWallish = (g: string) => g === "#" || g === "R";

  // Below-floor foundation: packed earth for air/empty tiles below floor row.
  if (r > sctx.floorY && (ch === "." || ch === " ")) {
    ctx.fillStyle = "#1a1209";
    ctx.fillRect(x, y, T, T);
    ctx.fillStyle = "rgba(88,60,30,0.22)";
    const seed = (c * 31 + r * 17) % 11;
    for (let i = 0; i < 5; i++) {
      const dx = ((seed + i * 7) * 3) % (T - 4);
      const dy = ((seed + i * 13) * 2) % (T - 4);
      ctx.fillRect(x + dx, y + dy, 2, 2);
    }
    return;
  }

  // Air above floor: let the gradient show through.
  if (ch === "." || ch === " ") return;

  if (ch === "#") {
    // Stone wall column (side-view).
    ctx.fillStyle = "#2b2218";
    ctx.fillRect(x, y, T, T);
    ctx.fillStyle = "rgba(80,60,38,0.45)";
    for (let j = 0; j < T; j += 10) ctx.fillRect(x, y + j, T, 1);
    ctx.fillStyle = "rgba(30,20,10,0.55)";
    for (let i = 0; i < T; i += 8) ctx.fillRect(x + i, y, 1, T);
    ctx.fillStyle = "#1c150f";
    ctx.fillRect(x, y + T - 3, T, 3);
    // Top cap when above is air — parapet highlight.
    if (!isWallish(sctx.neighborAbove) && sctx.neighborAbove !== "l") {
      ctx.fillStyle = "#4a3a24";
      ctx.fillRect(x, y, T, 3);
      ctx.fillStyle = "#5e4a2a";
      ctx.fillRect(x, y, T, 1);
    }
    return;
  }

  if (ch === "R") {
    // Ceiling beam / roof timber.
    ctx.fillStyle = "#3a2a18";
    ctx.fillRect(x, y, T, T);
    ctx.fillStyle = "rgba(20,12,4,0.6)";
    for (let i = 0; i < T; i += 6) ctx.fillRect(x + i, y + 3, 1, T - 6);
    ctx.fillStyle = "#1f1509";
    ctx.fillRect(x, y + T - 2, T, 2);
    return;
  }

  if (ch === "|") {
    // Door: planked door in a frame, sitting on the floor.
    ctx.fillStyle = "#3a2818";
    ctx.fillRect(x, y, T, T);
    ctx.fillStyle = "#0a0604";
    ctx.fillRect(x + 4, y + 2, T - 8, T - 4);
    ctx.fillStyle = "#5a3a1e";
    ctx.fillRect(x + 5, y + 3, T - 10, T - 6);
    ctx.fillStyle = "#2a1808";
    for (let i = 0; i < T - 10; i += 5) ctx.fillRect(x + 5 + i, y + 3, 1, T - 6);
    ctx.fillStyle = "#c8a060";
    ctx.fillRect(x + T - 9, y + T / 2, 2, 2);
    return;
  }

  if (ch === "~") {
    // Hearth: stone arch with flames at the base.
    const flick = (Math.sin(now / 160 + (c + r)) + 1) / 2;
    // Back of hearth (dark)
    ctx.fillStyle = "#0d0804";
    ctx.fillRect(x + 2, y + 2, T - 4, T - 4);
    // Logs at floor
    ctx.fillStyle = "#3a2414";
    ctx.fillRect(x + 4, y + T - 12, T - 8, 7);
    ctx.fillStyle = "#1a0c06";
    ctx.fillRect(x + 4, y + T - 6, T - 8, 2);
    // Flames
    const flameH = Math.round(16 + flick * 10);
    const flameBaseY = y + T - 12;
    ctx.fillStyle = `rgba(220,120,50,${0.6 + flick * 0.25})`;
    ctx.fillRect(x + 6, flameBaseY - flameH, T - 12, flameH);
    ctx.fillStyle = `rgba(255,180,80,${0.55 + flick * 0.3})`;
    ctx.fillRect(x + 10, flameBaseY - flameH + 4, T - 20, flameH - 8);
    ctx.fillStyle = `rgba(255,230,140,${0.55 + flick * 0.3})`;
    ctx.fillRect(x + T / 2 - 2, flameBaseY - flameH + 10, 4, flameH - 14);
    // Stone arch surround
    ctx.fillStyle = "#5a4028";
    ctx.fillRect(x, y, 3, T);
    ctx.fillRect(x + T - 3, y, 3, T);
    ctx.fillRect(x, y, T, 3);
    ctx.fillStyle = "#7a5a38";
    ctx.fillRect(x, y, T, 1);
    return;
  }

  if (ch === "w") {
    // Window: wall column with a 4-pane insert.
    ctx.fillStyle = "#2b2218";
    ctx.fillRect(x, y, T, T);
    ctx.fillStyle = "rgba(80,60,38,0.45)";
    for (let j = 0; j < T; j += 10) ctx.fillRect(x, y + j, T, 1);
    // Pane glow (nightlike)
    ctx.fillStyle = "#24344a";
    ctx.fillRect(x + 5, y + 5, T - 10, T - 10);
    ctx.fillStyle = "rgba(160,190,220,0.35)";
    ctx.fillRect(x + 5, y + 5, T - 10, T - 10);
    // Mullions
    ctx.fillStyle = "#3a2c1c";
    ctx.fillRect(x + T / 2 - 1, y + 5, 2, T - 10);
    ctx.fillRect(x + 5, y + T / 2 - 1, T - 10, 2);
    // Frame
    ctx.fillStyle = "#4a3a24";
    ctx.fillRect(x + 4, y + 4, T - 8, 2);
    ctx.fillRect(x + 4, y + T - 6, T - 8, 2);
    ctx.fillRect(x + 4, y + 4, 2, T - 8);
    ctx.fillRect(x + T - 6, y + 4, 2, T - 8);
    return;
  }

  if (ch === "b") {
    // Bed: low mattress on the floor with pillow + legs.
    ctx.fillStyle = "#4a3a28";
    ctx.fillRect(x + 2, y + T - 16, T - 4, 12);
    ctx.fillStyle = "#6a4a2e";
    ctx.fillRect(x + 2, y + T - 16, T - 4, 4);
    ctx.fillStyle = "#c8b898";
    ctx.fillRect(x + 3, y + T - 18, 12, 4);
    ctx.fillStyle = "#2a1e10";
    ctx.fillRect(x + 3, y + T - 4, 3, 4);
    ctx.fillRect(x + T - 6, y + T - 4, 3, 4);
    return;
  }

  if (ch === "t") {
    // Table: slab top on two legs, sitting on floor row.
    ctx.fillStyle = "#5a4028";
    ctx.fillRect(x + 1, y + T - 20, T - 2, 4);
    ctx.fillStyle = "#7a5a38";
    ctx.fillRect(x + 1, y + T - 20, T - 2, 1);
    ctx.fillStyle = "#3a2818";
    ctx.fillRect(x + 4, y + T - 16, 3, 16);
    ctx.fillRect(x + T - 7, y + T - 16, 3, 16);
    return;
  }

  if (ch === "c") {
    // Chair: backrest + seat + legs (side profile).
    ctx.fillStyle = "#3a2818";
    ctx.fillRect(x + T - 14, y + T - 26, 4, 20);
    ctx.fillStyle = "#5a4028";
    ctx.fillRect(x + 4, y + T - 14, T - 8, 4);
    ctx.fillStyle = "#3a2818";
    ctx.fillRect(x + 5, y + T - 10, 2, 10);
    ctx.fillRect(x + T - 7, y + T - 10, 2, 10);
    return;
  }

  if (ch === "=") {
    // Bar/counter: waist-high slab along the floor.
    ctx.fillStyle = "#5a3a18";
    ctx.fillRect(x, y + T - 24, T, 20);
    ctx.fillStyle = "#7a5028";
    ctx.fillRect(x, y + T - 24, T, 3);
    ctx.fillStyle = "#2a1808";
    ctx.fillRect(x, y + T - 6, T, 2);
    ctx.fillStyle = "rgba(20,10,2,0.4)";
    for (let i = 0; i < T; i += 8) ctx.fillRect(x + i, y + T - 20, 1, 16);
    return;
  }

  if (ch === "l") {
    // Lantern: chain descending from ceiling, box with flame glow.
    const flick = (Math.sin(now / 170 + c) + 1) / 2;
    // Chain
    ctx.fillStyle = "#3a2c1c";
    for (let dy = 0; dy < T / 2 - 6; dy += 3) {
      ctx.fillRect(x + T / 2 - 1, y + dy, 2, 2);
    }
    // Lantern frame
    ctx.fillStyle = "#3a2c1c";
    ctx.fillRect(x + T / 2 - 8, y + T / 2 - 4, 16, 16);
    // Glass
    ctx.fillStyle = `rgba(255,200,110,${0.55 + flick * 0.3})`;
    ctx.fillRect(x + T / 2 - 6, y + T / 2 - 2, 12, 12);
    // Flame
    ctx.fillStyle = `rgba(255,230,150,${0.7 + flick * 0.25})`;
    ctx.fillRect(x + T / 2 - 2, y + T / 2 + 2, 4, 6);
    // Cap
    ctx.fillStyle = "#4a3a24";
    ctx.fillRect(x + T / 2 - 9, y + T / 2 - 7, 18, 3);
    return;
  }

  if (palette && palette[ch]) {
    const entry = palette[ch];
    if (entry.walkable) {
      // Thin floor mat near the bottom of the tile.
      ctx.fillStyle = entry.color;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x + 2, y + T - 6, T - 4, 4);
      ctx.globalAlpha = 1;
    } else {
      // Side silhouette standing on the floor.
      const h = Math.min(T - 4, 26);
      ctx.fillStyle = entry.color;
      ctx.fillRect(x + 3, y + T - h - 2, T - 6, h);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(x + 3, y + T - h - 2, T - 6, 2);
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(x + 3, y + T - 4, T - 6, 2);
      if (entry.glow) {
        const flick = (Math.sin(now / 200 + c + r) + 1) / 2;
        ctx.fillStyle = `rgba(255,220,140,${0.3 + flick * 0.2})`;
        ctx.fillRect(x + 7, y + T - h + 2, T - 14, h - 8);
      }
    }
    return;
  }
  // Unknown glyph — leave gradient.
}

type AnyScene = { anchors: Record<string, { x: number; y: number }> };

function isSeatedAnchor(name: string | null): boolean {
  if (!name) return false;
  return (
    name.startsWith("chair") ||
    name === "bed" ||
    name.startsWith("table") ||
    name.startsWith("bar")
  );
}

function drawCharacter(
  ctx: CanvasRenderingContext2D,
  c: Character,
  scene: AnyScene,
  now: number,
  all?: Character[],
) {
  // Overlap nudge: spread characters sharing the same x horizontally, and
  // stagger their overhead labels vertically so nameplates / speech bubbles
  // don't stack on top of each other.
  let xOffset = 0;
  let labelStackOffset = 0;
  if (all) {
    const here = all.filter((o) => !o.dead && Math.abs(o.pos.x - c.pos.x) < 0.6);
    if (here.length > 1) {
      const sorted = [...here].sort((a, b) => a.id.localeCompare(b.id));
      const idx = sorted.findIndex((o) => o.id === c.id);
      const mid = (sorted.length - 1) / 2;
      xOffset = Math.round((idx - mid) * 7);
      labelStackOffset = idx * 12;
    }
  }

  const struck = c.struckUntil ?? 0;
  const struckPhase = struck > now ? (struck - now) / 420 : 0;
  const shakeX = struckPhase > 0 ? Math.sin(now / 28) * 3 * struckPhase : 0;

  const T = TILE_PX;
  // Feet pinned to the bottom of the standing tile.
  const feetX = c.pos.x * T + T / 2 + xOffset + shakeX;
  const feetY = (c.pos.y + 1) * T;
  const seed = c.id.charCodeAt(0);
  const step = c.moving ? Math.sin(now / 110 + seed) : 0;
  const breath = c.moving ? 0 : Math.sin(now / 800 + seed * 2.1) * 0.5;
  const bob = Math.sin(now / 620 + seed) * 0.3;

  // Seated pose when parked next to a chair/bed/bar anchor.
  let seated = false;
  if (!c.moving) {
    for (const [name, a] of Object.entries(scene.anchors)) {
      if (!isSeatedAnchor(name)) continue;
      if (Math.abs(c.pos.x - a.x) < 0.6) { seated = true; break; }
    }
  }

  // Shadow at feet.
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.beginPath();
  ctx.ellipse(feetX, feetY - 1.5, 10, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // Sprite dimensions (authored facing right).
  const bodyH = seated ? 16 : 22;
  const headR = 5;
  const hipY = feetY - (seated ? 8 : 12);
  const bodyTopY = hipY - bodyH + bob + breath;
  const headCy = bodyTopY - headR - 1;

  if (c.dead) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = c.palette.cloak;
    ctx.fillRect(feetX - 14, feetY - 7, 28, 5);
    ctx.fillStyle = c.palette.body;
    ctx.beginPath();
    ctx.arc(feetX - 12, feetY - 6, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // Nameplate floats above the body so dead characters read as "here".
    ctx.font = "9px ui-monospace, SF Mono, monospace";
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    const nameW = Math.min(90, ctx.measureText(c.name).width + 10);
    const deadNameY = feetY - 20 - labelStackOffset;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(feetX - nameW / 2, deadNameY, nameW, 10);
    ctx.fillStyle = "#7a7a7a";
    ctx.fillText(c.name, feetX, deadNameY + 1);
    ctx.textAlign = "start";
    return;
  }

  // Mirror sprite drawing for facing left.
  ctx.save();
  if (c.facing === "left") {
    ctx.translate(feetX, 0);
    ctx.scale(-1, 1);
    ctx.translate(-feetX, 0);
  }

  if (seated) {
    // Torso
    ctx.fillStyle = c.palette.cloak;
    ctx.fillRect(feetX - 5, bodyTopY, 10, bodyH);
    ctx.fillStyle = c.palette.accent;
    ctx.fillRect(feetX - 5, bodyTopY, 10, 2);
    // Hand resting forward
    ctx.fillStyle = c.palette.cloak;
    ctx.fillRect(feetX + 2, bodyTopY + 4, 4, 7);
    // Seated legs extend forward
    ctx.fillStyle = "#2a1e10";
    ctx.fillRect(feetX - 2, hipY, 10, 3);
    ctx.fillRect(feetX + 4, hipY + 2, 3, 6);
    // Head
    ctx.fillStyle = c.palette.body;
    ctx.beginPath();
    ctx.arc(feetX, headCy, headR, 0, Math.PI * 2);
    ctx.fill();
    // Hair/hat accent
    ctx.fillStyle = c.palette.accent;
    ctx.fillRect(feetX - headR, headCy - headR, headR * 2, 2);
    // Eye (right-facing)
    ctx.fillStyle = "#0a0806";
    ctx.fillRect(feetX + 1, headCy - 1, 2, 2);
  } else {
    // Legs (x-split, swing opposite-phase)
    const legOff = Math.round(step * 3);
    ctx.fillStyle = "#2a1e10";
    ctx.fillRect(feetX - 3, hipY, 3, 12 + legOff);
    ctx.fillRect(feetX, hipY, 3, 12 - legOff);
    // Feet stubs
    ctx.fillStyle = "#1a1008";
    ctx.fillRect(feetX - 5, feetY - 2, 5, 2);
    ctx.fillRect(feetX + 1, feetY - 2, 5, 2);
    // Torso
    ctx.fillStyle = c.palette.cloak;
    ctx.fillRect(feetX - 4, bodyTopY, 8, bodyH);
    // Accent trim
    ctx.fillStyle = c.palette.accent;
    ctx.fillRect(feetX - 4, bodyTopY, 8, 2);
    // Arms (back + front, opposite-phase to legs)
    const armOff = c.moving
      ? Math.round(step * 3)
      : Math.round(Math.sin(now / 1200 + seed * 3.3) * 0.8);
    ctx.fillStyle = c.palette.cloak;
    ctx.fillRect(feetX - 5, bodyTopY + 4 - armOff, 2, 9);
    ctx.fillRect(feetX + 3, bodyTopY + 4 + armOff, 2, 9);
    // Head
    ctx.fillStyle = c.palette.body;
    ctx.beginPath();
    ctx.arc(feetX, headCy, headR, 0, Math.PI * 2);
    ctx.fill();
    // Hair/hat
    ctx.fillStyle = c.palette.accent;
    ctx.fillRect(feetX - headR, headCy - headR, headR * 2, 2);
    // Eye + blink
    const blink = ((now / 1000 + seed) % 4) > 3.85;
    ctx.fillStyle = "#0a0806";
    if (!blink) ctx.fillRect(feetX + 1, headCy - 1, 2, 2);
    else ctx.fillRect(feetX + 1, headCy - 1, 2, 0.5);
  }

  ctx.restore();

  // Hit-flash red tint (screen-axis).
  if (struckPhase > 0) {
    ctx.save();
    ctx.globalAlpha = 0.55 * struckPhase;
    ctx.fillStyle = "#d9614a";
    ctx.fillRect(feetX - 7, bodyTopY - 2, 14, bodyH + headR * 2 + 4);
    ctx.restore();
  }

  // Labels now stack ABOVE the head (RPG convention) so they don't collide
  // with item labels sitting on the same floor row.
  ctx.font = "9px ui-monospace, SF Mono, monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  const nameW = Math.min(90, ctx.measureText(c.name).width + 10);
  const nameY = headCy - headR - 12 - labelStackOffset;
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(feetX - nameW / 2, nameY, nameW, 10);
  ctx.fillStyle = c.palette.accent;
  ctx.fillText(c.name, feetX, nameY + 1);
  ctx.textAlign = "start";

  // HP pips tucked to the right of the nameplate.
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i < c.hp ? "#5ec26a" : "#3a3a3a";
    ctx.fillRect(feetX + nameW / 2 + 2 + i * 4, nameY + 3, 3, 3);
  }

  // Inventory label sits one row above the nameplate.
  if (c.inventory.length > 0) {
    const itemName = c.inventory[0].length > 12
      ? c.inventory[0].slice(0, 10) + "…"
      : c.inventory[0];
    ctx.font = "7px ui-monospace, SF Mono, monospace";
    const iw = ctx.measureText(itemName).width + 6;
    const iy = nameY - 11;
    ctx.fillStyle = "rgba(232, 200, 106, 0.25)";
    ctx.fillRect(feetX - iw / 2, iy, iw, 9);
    ctx.fillStyle = "#e8c86a";
    ctx.textAlign = "center";
    ctx.fillText(itemName, feetX, iy + 1);
    ctx.textAlign = "start";
    for (let i = 1; i < Math.min(c.inventory.length, 4); i++) {
      ctx.fillStyle = "#e8c86a";
      ctx.fillRect(feetX + iw / 2 + 2 + (i - 1) * 4, iy + 3, 2, 2);
    }
  }

  // Emote + speech float further above the head.
  const inventoryOffset = c.inventory.length > 0 ? 13 : 0;
  if (c.emote) drawEmote(ctx, feetX, nameY - 14 - inventoryOffset, c.emote.kind, now);
  if (c.speech) drawSpeech(ctx, feetX, nameY - 24 - inventoryOffset, c.speech.text);
}

function drawSpeech(ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string) {
  const trim = text.length > 48 ? text.slice(0, 46) + "…" : text;
  ctx.font = "10px ui-monospace, SF Mono, monospace";
  const metrics = ctx.measureText(trim);
  const innerW = Math.ceil(metrics.width) + 10;
  const innerH = 14;
  const w = innerW + 4; // for the gold frame
  const h = innerH + 4;
  const x = Math.max(4, Math.min(ctx.canvas.width - w - 4, cx - w / 2));
  const y = Math.max(4, cy - h);
  // Pixel dialog frame: gold outer, black inset, cream inner.
  ctx.fillStyle = "#e8c86a";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#1a1409";
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
  ctx.fillStyle = "#f0e8d2";
  ctx.fillRect(x + 2, y + 2, innerW, innerH);
  ctx.fillStyle = "#1a1409";
  ctx.textBaseline = "top";
  ctx.fillText(trim, x + 7, y + 4);
  // Pointer stem (pixel steps, not a triangle)
  ctx.fillStyle = "#e8c86a";
  ctx.fillRect(cx - 2, y + h, 4, 1);
  ctx.fillRect(cx - 1, y + h + 1, 2, 1);
  ctx.fillStyle = "#1a1409";
  ctx.fillRect(cx, y + h + 2, 1, 1);
}

// Render world flags as visible overlays on the canvas.
function drawFlagOverlays(
  ctx: CanvasRenderingContext2D,
  scene: AnyScene,
  flags: Record<string, string>,
  now: number,
) {
  if (flags.candle_lit === "yes") {
    // Put a candle glow on any anchor named "table_*" or "center"
    const spot =
      scene.anchors.table_a ?? scene.anchors.table ?? scene.anchors.center;
    if (spot) {
      const cx = spot.x * TILE_PX + TILE_PX / 2;
      const cy = spot.y * TILE_PX + TILE_PX / 2;
      const flick = (Math.sin(now / 140) + 1) / 2;
      ctx.fillStyle = "#3a2c1c";
      ctx.fillRect(cx - 1, cy - 2, 3, 7);
      ctx.fillStyle = `rgba(255,220,130,${0.7 + flick * 0.25})`;
      ctx.fillRect(cx, cy - 6 - Math.floor(flick * 2), 1, 4);
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 60 + flick * 6);
      g.addColorStop(0, `rgba(255,180,80,${0.3 + flick * 0.15})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, 60 + flick * 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }
  }
  if (flags.door_bolted === "yes") {
    const spot = scene.anchors.door_in;
    if (spot) {
      const cx = spot.x * TILE_PX + TILE_PX / 2;
      const cy = spot.y * TILE_PX + TILE_PX / 2;
      ctx.fillStyle = "#7a7a80";
      ctx.fillRect(cx - 10, cy + 6, 20, 3);
      ctx.fillStyle = "#3a3a40";
      ctx.fillRect(cx - 10, cy + 8, 20, 1);
    }
  }
  if (flags.rain === "yes" || flags.raining === "yes") {
    ctx.strokeStyle = "rgba(140,170,200,0.35)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 30; i++) {
      const seed = (i * 37 + Math.floor(now / 32)) % 1000;
      const dx = (seed * 13) % ctx.canvas.width;
      const dy = (((seed * 7 + Math.floor(now * 0.4)) % 1000) * ctx.canvas.height) / 1000;
      ctx.beginPath();
      ctx.moveTo(dx, dy);
      ctx.lineTo(dx - 1, dy - 6);
      ctx.stroke();
    }
  }
  if (flags.letter_burned === "yes") {
    const spot = scene.anchors.hearth ?? scene.anchors.center;
    if (spot) {
      const cx = spot.x * TILE_PX + TILE_PX / 2;
      const cy = spot.y * TILE_PX + TILE_PX / 2;
      ctx.fillStyle = "rgba(40,40,40,0.8)";
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(cx - 6 + i * 5, cy + 2, 3, 2);
      }
    }
  }
}

function drawEmote(ctx: CanvasRenderingContext2D, cx: number, cy: number, kind: EmoteKind, now: number) {
  const bob = Math.sin(now / 220) * 2;
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.beginPath();
  ctx.arc(cx, cy + bob, 9, 0, Math.PI * 2);
  ctx.fill();
  const gly: Record<EmoteKind, string> = {
    startle: "!", still: "·", warm: "♥", sad: "•", puzzle: "?",
  };
  const col: Record<EmoteKind, string> = {
    startle: "#ffe066",
    still: "#c8c8d0",
    warm: "#e8a080",
    sad: "#8abfd8",
    puzzle: "#c8a06a",
  };
  ctx.fillStyle = col[kind];
  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(gly[kind], cx, cy + bob + 1);
  ctx.textAlign = "start";
  ctx.textBaseline = "top";
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawDialog(
  ctx: CanvasRenderingContext2D,
  pending: { full: string; shown: number; kind: "narration" | "ambient" | "speech_marrow" | "speech_soren" | "action" } | null,
  now: number,
  W: number,
  H: number,
) {
  if (!pending) return;
  const shown = pending.full.slice(0, Math.floor(pending.shown));
  const boxX = 6;
  const boxH = 92;
  const boxY = H - boxH - 6;
  const boxW = W - 12;

  // Scene is clipped above the dialog now, so the box no longer overlaps
  // characters. A deeper background keeps the typography readable.
  ctx.fillStyle = "rgba(11, 10, 22, 0.88)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  // Gold frame drawn as stroked rects (scene still visible inside)
  ctx.fillStyle = "#e8c86a";
  ctx.fillRect(boxX, boxY, boxW, 2);           // top
  ctx.fillRect(boxX, boxY + boxH - 2, boxW, 2); // bottom
  ctx.fillRect(boxX, boxY, 2, boxH);           // left
  ctx.fillRect(boxX + boxW - 2, boxY, 2, boxH); // right
  // Subtle inner black rule
  ctx.strokeStyle = "rgba(26, 20, 9, 0.6)";
  ctx.lineWidth = 1;
  ctx.strokeRect(boxX + 3.5, boxY + 3.5, boxW - 7, boxH - 7);
  // Corner studs
  ctx.fillStyle = "#e8c86a";
  ctx.fillRect(boxX + 4, boxY + 4, 6, 2);
  ctx.fillRect(boxX + boxW - 10, boxY + 4, 6, 2);
  ctx.fillRect(boxX + 4, boxY + boxH - 6, 6, 2);
  ctx.fillRect(boxX + boxW - 10, boxY + boxH - 6, 6, 2);

  // Speaker tag (if it's a speech line attributed to a character)
  let speakerLabel = "";
  let speakerColor = "#e8c86a";
  if (pending.kind === "speech_marrow") {
    speakerLabel = "MARROW";
  } else if (pending.kind === "speech_soren") {
    speakerLabel = "SOREN";
    speakerColor = "#8ab0c8";
  }
  let textTopPad = 10;
  if (speakerLabel) {
    ctx.fillStyle = speakerColor;
    ctx.font = "bold 9px ui-monospace, SF Mono, monospace";
    ctx.textBaseline = "top";
    ctx.fillText(speakerLabel, boxX + 10, boxY + 8);
    textTopPad = 22;
  }

  // Strip the "Name: " prefix if it's a speech line — we show the
  // speaker as the tag instead.
  let displayText = shown;
  if (speakerLabel) {
    displayText = displayText.replace(/^[A-Za-z]+:\s*/, "");
    displayText = displayText.replace(/^["']|["']$/g, "");
  }

  // Body text
  ctx.fillStyle = "#f0e8d2";
  ctx.font = "13px ui-monospace, SF Mono, monospace";
  ctx.textBaseline = "top";
  const lineH = 17;
  const maxLines = Math.floor((boxH - textTopPad - 8) / lineH);
  const lines = wrapText(ctx, displayText, boxW - 20);
  const visibleLines = lines.slice(Math.max(0, lines.length - maxLines));
  for (let i = 0; i < visibleLines.length; i++) {
    ctx.fillText(visibleLines[i], boxX + 10, boxY + textTopPad + i * lineH);
  }

  // Blinking pixel caret if still typing
  if (Math.floor(pending.shown) < pending.full.length) {
    const blink = Math.floor(now / 450) % 2;
    if (blink) {
      const lastLine = visibleLines[visibleLines.length - 1] ?? "";
      const tx = boxX + 10 + ctx.measureText(lastLine).width + 4;
      const ty = boxY + textTopPad + Math.max(0, visibleLines.length - 1) * lineH + 2;
      ctx.fillStyle = "#e8c86a";
      ctx.fillRect(tx, ty, 10, 10);
    }
  }
}

function drawTimeOfDay(ctx: CanvasRenderingContext2D, hour: number, W: number, H: number) {
  let overlay = "rgba(0,0,0,0)";
  if (hour < 5) overlay = "rgba(20,30,60,0.40)";
  else if (hour < 8) overlay = "rgba(120,80,80,0.18)";
  else if (hour < 17) overlay = "rgba(180,180,200,0.05)";
  else if (hour < 20) overlay = "rgba(150,80,40,0.20)";
  else overlay = "rgba(20,30,60,0.40)";
  ctx.fillStyle = overlay;
  ctx.fillRect(0, 0, W, H);
}

function drawVignette(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const g = ctx.createRadialGradient(
    W / 2, H / 2, W * 0.2,
    W / 2, H / 2, W * 0.7,
  );
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.7)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}
