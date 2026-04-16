import { authenticate } from "./auth";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// How long after a deviceId's last push we still consider it the "driver"
// of a row. Shorter = faster failover when a device goes offline; too short
// and legitimate slow pushes fight for the lock. 60s is a good middle.
const LOCK_TTL = 60_000;

interface PushItem {
  id: string;
  type: string; // "building" | "room"
  data: unknown;
  version: number;
  /** If true, caller is intentionally forcing a takeover of an existing lock. */
  takeOver?: boolean;
}

interface PushRequest {
  deviceId?: string;
  items: PushItem[];
}

export async function handlePush(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const userId = await authenticate(request, db);
  if (!userId) return json({ error: "unauthorized" }, 401);

  const body = (await request.json()) as PushRequest;
  if (!Array.isArray(body.items)) return json({ error: "bad request" }, 400);
  const deviceId = (body.deviceId ?? "").toString().slice(0, 64);

  const results: Array<{
    id: string;
    version: number;
    status: string;
    lockedBy?: string | null;
    lockedAt?: number | null;
  }> = [];
  const now = Date.now();

  for (const item of body.items.slice(0, 50)) {
    const dataStr = typeof item.data === "string" ? item.data : JSON.stringify(item.data);

    const existing = await db
      .prepare(
        "SELECT version, locked_by, locked_at FROM game_state WHERE user_id = ? AND entity_type = ? AND entity_id = ?",
      )
      .bind(userId, item.type, item.id)
      .first<{ version: number; locked_by: string | null; locked_at: number | null }>();

    if (!existing) {
      // New row — first writer becomes the lock holder.
      await db
        .prepare(
          "INSERT INTO game_state (user_id, entity_type, entity_id, data, version, updated_at, locked_by, locked_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
        )
        .bind(userId, item.type, item.id, dataStr, now, deviceId || null, deviceId ? now : null)
        .run();
      results.push({
        id: item.id,
        version: 1,
        status: "ok",
        lockedBy: deviceId || null,
        lockedAt: deviceId ? now : null,
      });
      continue;
    }

    // Lock check: if the row is locked by a DIFFERENT device whose lock
    // hasn't expired, and the caller didn't ask for a takeover, reject.
    const lockFresh =
      existing.locked_at != null && now - existing.locked_at < LOCK_TTL;
    const lockedByOther =
      lockFresh &&
      existing.locked_by &&
      existing.locked_by !== deviceId;
    if (lockedByOther && !item.takeOver) {
      results.push({
        id: item.id,
        version: existing.version,
        status: "locked",
        lockedBy: existing.locked_by,
        lockedAt: existing.locked_at,
      });
      continue;
    }

    if (item.version >= existing.version) {
      const newVersion = existing.version + 1;
      await db
        .prepare(
          "UPDATE game_state SET data = ?, version = ?, updated_at = ?, locked_by = ?, locked_at = ? WHERE user_id = ? AND entity_type = ? AND entity_id = ?",
        )
        .bind(
          dataStr,
          newVersion,
          now,
          deviceId || null,
          deviceId ? now : null,
          userId,
          item.type,
          item.id,
        )
        .run();
      results.push({
        id: item.id,
        version: newVersion,
        status: "ok",
        lockedBy: deviceId || null,
        lockedAt: deviceId ? now : null,
      });
    } else {
      results.push({
        id: item.id,
        version: existing.version,
        status: "conflict",
        lockedBy: existing.locked_by,
        lockedAt: existing.locked_at,
      });
    }
  }

  return json({ results });
}

interface PullRequest {
  since?: number;
}

export async function handlePull(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const userId = await authenticate(request, db);
  if (!userId) return json({ error: "unauthorized" }, 401);

  const body = (await request.json().catch(() => ({}))) as PullRequest;
  const since = body.since ?? 0;

  const rows = await db
    .prepare(
      "SELECT entity_type, entity_id, data, version, updated_at, locked_by, locked_at FROM game_state WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT 200",
    )
    .bind(userId, since)
    .all<{
      entity_type: string;
      entity_id: string;
      data: string;
      version: number;
      updated_at: number;
      locked_by: string | null;
      locked_at: number | null;
    }>();

  const items = (rows.results ?? []).map((r) => ({
    type: r.entity_type,
    id: r.entity_id,
    data: JSON.parse(r.data),
    version: r.version,
    updatedAt: r.updated_at,
    lockedBy: r.locked_by,
    lockedAt: r.locked_at,
  }));

  return json({ items });
}

interface ReleaseRequest {
  deviceId?: string;
  ids: Array<{ type: string; id: string }>;
}

export async function handleRelease(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const userId = await authenticate(request, db);
  if (!userId) return json({ error: "unauthorized" }, 401);
  const body = (await request.json()) as ReleaseRequest;
  const deviceId = (body.deviceId ?? "").toString().slice(0, 64);
  if (!deviceId || !Array.isArray(body.ids)) return json({ error: "bad request" }, 400);
  for (const { type, id } of body.ids.slice(0, 50)) {
    await db
      .prepare(
        "UPDATE game_state SET locked_by = NULL, locked_at = NULL WHERE user_id = ? AND entity_type = ? AND entity_id = ? AND locked_by = ?",
      )
      .bind(userId, type, id, deviceId)
      .run();
  }
  return json({ ok: true });
}
