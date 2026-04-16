import { authHeaders, getSessionToken } from "./auth";
import type { BuildingState, SavedRoom } from "./engine";

const API_BASE =
  typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "http://localhost:8788"
    : "https://augur.carl-lewis.workers.dev";

const SYNC_VERSION_KEY = "augur-sync-versions";
const DEVICE_ID_KEY = "augur-device-id";

function readVersions(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SYNC_VERSION_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeVersions(v: Record<string, number>): void {
  try { localStorage.setItem(SYNC_VERSION_KEY, JSON.stringify(v)); } catch { /* ignore */ }
}

// A per-browser id persisted in localStorage. Used by the server to
// enforce single-driver locks on active game state.
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    const id = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return "unknown";
  }
}

export interface PushResult {
  id: string;
  version: number;
  status: "ok" | "locked" | "conflict";
  lockedBy: string | null;
  lockedAt: number | null;
}

// Push a building. Buildings don't enforce a lock, but the row-level
// locked_by is updated so the server knows who last wrote.
export async function pushBuilding(b: BuildingState): Promise<void> {
  if (!getSessionToken()) return;
  const versions = readVersions();
  try {
    const resp = await fetch(`${API_BASE}/api/sync/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        deviceId: getDeviceId(),
        items: [{
          id: b.id,
          type: "building",
          data: b,
          version: versions[`building:${b.id}`] ?? 0,
        }],
      }),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as { results: PushResult[] };
    for (const r of data.results) {
      if (r.status === "ok") versions[`building:${r.id}`] = r.version;
    }
    writeVersions(versions);
  } catch {
    /* offline — will retry next save */
  }
}

export async function pushRoom(
  room: SavedRoom,
  opts?: { takeOver?: boolean },
): Promise<PushResult | null> {
  if (!getSessionToken()) return null;
  const versions = readVersions();
  try {
    const resp = await fetch(`${API_BASE}/api/sync/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        deviceId: getDeviceId(),
        items: [{
          id: room.id,
          type: "room",
          data: room,
          version: versions[`room:${room.id}`] ?? 0,
          takeOver: !!opts?.takeOver,
        }],
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { results: PushResult[] };
    const r = data.results[0] ?? null;
    if (r && r.status === "ok") {
      versions[`room:${r.id}`] = r.version;
      writeVersions(versions);
    }
    return r;
  } catch {
    return null;
  }
}

export interface PullResult {
  buildings: BuildingState[];
  rooms: Array<{ room: SavedRoom; lockedBy: string | null; lockedAt: number | null }>;
}

export async function pullAll(): Promise<PullResult | null> {
  if (!getSessionToken()) return null;
  try {
    const resp = await fetch(`${API_BASE}/api/sync/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({}),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      items: Array<{
        type: string;
        id: string;
        data: unknown;
        version: number;
        updatedAt: number;
        lockedBy: string | null;
        lockedAt: number | null;
      }>;
    };
    const versions = readVersions();
    const buildings: BuildingState[] = [];
    const rooms: Array<{ room: SavedRoom; lockedBy: string | null; lockedAt: number | null }> = [];
    for (const item of data.items) {
      versions[`${item.type}:${item.id}`] = item.version;
      if (item.type === "building") buildings.push(item.data as BuildingState);
      if (item.type === "room") {
        rooms.push({
          room: item.data as SavedRoom,
          lockedBy: item.lockedBy,
          lockedAt: item.lockedAt,
        });
      }
    }
    writeVersions(versions);
    return { buildings, rooms };
  } catch {
    return null;
  }
}

export async function releaseLock(roomId: string): Promise<void> {
  if (!getSessionToken()) return;
  try {
    await fetch(`${API_BASE}/api/sync/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        deviceId: getDeviceId(),
        ids: [{ type: "room", id: roomId }],
      }),
    });
  } catch {
    /* best-effort */
  }
}

let pushTimer: number | null = null;

export function enqueuePush(fn: () => void): void {
  if (pushTimer) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    pushTimer = null;
    fn();
  }, 2000);
}
