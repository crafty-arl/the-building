import { create } from "zustand";
import type {
  CardWire,
  DailyPlan,
  RunClock,
  SceneWire,
  ServerMessage,
  TreeEntryWire,
  TreeSnapshot,
} from "../../shared/protocol";

export interface RunEnd {
  reason: "time" | "footsteps" | "schedule";
  epitaph: string;
}

interface StreamingTurn {
  turnId: string;
  text: string;
}

interface AugurState {
  scene: SceneWire | null;
  tree: TreeSnapshot;
  hand: CardWire[];
  footsteps: number;
  streamingTurn: StreamingTurn | null;
  kicked: boolean;
  connected: boolean;
  errorMessage: string | null;
  dailyPlan: DailyPlan | null;
  clock: RunClock | null;
  softWarningMs: number | null;
  runEnd: RunEnd | null;

  // UI-only state — the Fiction Reactor shell.
  clawThoughtOpen: boolean;
  handDrawerOpen: boolean;

  applyServer(msg: ServerMessage): void;
  setConnected(c: boolean): void;
  setKicked(k: boolean): void;
  setClawThoughtOpen(open: boolean): void;
  setHandDrawerOpen(open: boolean): void;
  dismissSoftWarning(): void;
  reset(): void;
}

const emptyTree: TreeSnapshot = { entries: [], leafId: null, facts: {}, vows: [] };

export const useAugur = create<AugurState>((set) => ({
  scene: null,
  tree: emptyTree,
  hand: [],
  footsteps: 0,
  streamingTurn: null,
  kicked: false,
  connected: false,
  errorMessage: null,
  dailyPlan: null,
  clock: null,
  softWarningMs: null,
  runEnd: null,
  clawThoughtOpen: false,
  handDrawerOpen: false,

  applyServer(msg) {
    switch (msg.type) {
      case "hello":
        set({
          scene: msg.scene,
          tree: msg.tree,
          hand: msg.hand,
          footsteps: msg.footsteps,
          dailyPlan: msg.dailyPlan,
          clock: msg.clock,
          softWarningMs: null,
          runEnd: null,
          streamingTurn: null,
          errorMessage: null,
        });
        break;
      case "soft-warning":
        set({ softWarningMs: msg.remainingMs });
        break;
      case "run-ended":
        set({ runEnd: { reason: msg.reason, epitaph: msg.epitaph } });
        break;
      case "token":
        set((s) => {
          const cur = s.streamingTurn;
          if (!cur || cur.turnId !== msg.turnId) {
            return { streamingTurn: { turnId: msg.turnId, text: msg.delta } };
          }
          return { streamingTurn: { turnId: cur.turnId, text: cur.text + msg.delta } };
        });
        break;
      case "entry":
        set((s) => {
          const next: TreeSnapshot = {
            ...s.tree,
            entries: [...s.tree.entries.filter((e) => e.id !== msg.entry.id), msg.entry],
            leafId: msg.entry.id,
          };
          const stillStreaming =
            s.streamingTurn && s.streamingTurn.turnId !== msg.turnId
              ? s.streamingTurn
              : null;
          return { tree: next, streamingTurn: stillStreaming };
        });
        break;
      case "tree":
        set({ tree: msg.tree, footsteps: msg.footsteps, hand: msg.hand });
        break;
      case "kicked":
        set({ kicked: true, connected: false });
        break;
      case "error":
        set({ errorMessage: msg.message });
        break;
    }
  },

  setConnected(connected) {
    set({ connected });
  },
  setKicked(kicked) {
    set({ kicked });
  },
  setClawThoughtOpen(clawThoughtOpen) {
    set({ clawThoughtOpen });
  },
  setHandDrawerOpen(handDrawerOpen) {
    set({ handDrawerOpen });
  },
  dismissSoftWarning() {
    set({ softWarningMs: null });
  },
  reset() {
    set({
      scene: null,
      tree: emptyTree,
      hand: [],
      footsteps: 0,
      streamingTurn: null,
      kicked: false,
      connected: false,
      errorMessage: null,
      dailyPlan: null,
      clock: null,
      softWarningMs: null,
      runEnd: null,
      clawThoughtOpen: false,
      handDrawerOpen: false,
    });
  },
}));

/**
 * Derived: walk the active branch from root → leaf. Returns [] when no leaf.
 * Kept here so components don't each re-implement the walk.
 */
export function activeBranch(
  entries: TreeEntryWire[],
  leafId: string | null,
): TreeEntryWire[] {
  if (!leafId) return [];
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const chain: TreeEntryWire[] = [];
  let cur: TreeEntryWire | undefined = byId.get(leafId);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();
  return chain;
}
