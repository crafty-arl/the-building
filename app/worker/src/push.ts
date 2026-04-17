/**
 * Web push — hello-world surface.
 *
 * Four routes, all keyed by `?userId` query param (mirrors the WebSocket
 * convention in index.ts; real auth arrives with PassKey later):
 *
 *   GET  /api/push/vapid-public-key         → { publicKey }
 *   POST /api/push/subscribe?userId=...     body: PushSubscriptionJSON → { ok }
 *   POST /api/push/unsubscribe?userId=...   body: { endpoint }         → { ok }
 *   POST /api/push/test?userId=...                                      → { sent, pruned }
 *
 * Send uses webpush-webcrypto (pure WebCrypto). 410/404 responses prune the
 * row. No retries, no queueing — that can come later.
 *
 * Known limitation: webpush-webcrypto sends with `Content-Encoding: aesgcm`
 * (RFC 8188 draft). Chrome / Edge / FCM / Firefox still accept it; iOS
 * Safari 16.4+ requires `aes128gcm` (RFC 8291) and will reject these pushes.
 * Swap the library or hand-roll aes128gcm when we want iOS delivery.
 */

import {
  ApplicationServerKeys,
  generatePushHTTPRequest,
} from "webpush-webcrypto";

export interface PushEnv {
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

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

function requireUserId(url: URL): string | null {
  const u = url.searchParams.get("userId");
  return u && u.length <= 128 ? u : null;
}

function requireVapid(env: PushEnv):
  | { publicKey: string; privateKey: string; subject: string }
  | null {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return null;
  return {
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: VAPID_PRIVATE_KEY,
    subject: VAPID_SUBJECT,
  };
}

export function handleVapidPublicKey(env: PushEnv): Response {
  const v = requireVapid(env);
  if (!v) return json({ error: "vapid not configured" }, 500);
  return json({ publicKey: v.publicKey });
}

interface SubscribeBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function handleSubscribe(
  request: Request,
  env: PushEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const userId = requireUserId(url);
  if (!userId) return json({ error: "missing userId" }, 400);

  let body: SubscribeBody;
  try {
    body = (await request.json()) as SubscribeBody;
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (
    typeof body?.endpoint !== "string" ||
    !body.endpoint.startsWith("https://") ||
    typeof body?.keys?.p256dh !== "string" ||
    typeof body?.keys?.auth !== "string"
  ) {
    return json({ error: "bad subscription" }, 400);
  }

  // Upsert keyed by endpoint (each device/browser gets exactly one endpoint).
  await env.DB
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth`,
    )
    .bind(body.endpoint, userId, body.keys.p256dh, body.keys.auth, Date.now())
    .run();

  return json({ ok: true });
}

export async function handleUnsubscribe(
  request: Request,
  env: PushEnv,
): Promise<Response> {
  let body: { endpoint?: string };
  try {
    body = (await request.json()) as { endpoint?: string };
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (typeof body.endpoint !== "string") {
    return json({ error: "missing endpoint" }, 400);
  }
  await env.DB
    .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
    .bind(body.endpoint)
    .run();
  return json({ ok: true });
}

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function sendOne(
  keys: ApplicationServerKeys,
  subject: string,
  sub: SubRow,
  payload: string,
): Promise<{ status: number }> {
  const { headers, body, endpoint } = await generatePushHTTPRequest({
    applicationServerKeys: keys,
    payload,
    target: {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    },
    adminContact: subject,
    ttl: 60,
    urgency: "normal",
  });
  const res = await fetch(endpoint, { method: "POST", headers, body });
  return { status: res.status };
}

export async function handleTest(
  request: Request,
  env: PushEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const userId = requireUserId(url);
  if (!userId) return json({ error: "missing userId" }, 400);

  const vapid = requireVapid(env);
  if (!vapid) return json({ error: "vapid not configured" }, 500);

  const rows = await env.DB
    .prepare(
      "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
    )
    .bind(userId)
    .all<SubRow>();
  const subs = rows.results ?? [];
  if (subs.length === 0) return json({ sent: 0, pruned: 0, note: "no subscriptions" });

  const keys = await ApplicationServerKeys.fromJSON({
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
  });

  const payload = JSON.stringify({
    title: "Augur",
    body: "Hello from the Building.",
    url: "/",
  });

  let sent = 0;
  let pruned = 0;
  for (const sub of subs) {
    try {
      const { status } = await sendOne(keys, vapid.subject, sub, payload);
      if (status === 201 || status === 202 || status === 200) {
        sent++;
      } else if (status === 404 || status === 410) {
        await env.DB
          .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
          .bind(sub.endpoint)
          .run();
        pruned++;
      } else {
        console.log(`push: unexpected status ${status} for ${sub.endpoint}`);
      }
    } catch (e) {
      console.log(`push: send failed for ${sub.endpoint}: ${String(e)}`);
    }
  }

  return json({ sent, pruned, total: subs.length });
}
