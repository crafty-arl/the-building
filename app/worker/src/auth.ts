import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

function toBase64Url(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

const RP_NAME = "Augur";
const RP_ID_PROD = "augur-prototype.pages.dev";
const RP_ORIGIN_PROD = "https://augur-prototype.pages.dev";

function rpConfig(request: Request) {
  const origin = new URL(request.url).origin;
  const host = new URL(request.url).hostname;
  const rpID = host === "localhost" ? "localhost" : RP_ID_PROD;
  const expectedOrigin = host === "localhost" ? origin : RP_ORIGIN_PROD;
  return { rpID, rpName: RP_NAME, expectedOrigin };
}

function genId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function genToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
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

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const CHALLENGE_TTL = 5 * 60 * 1000; // 5 min

// ─── Register ──────────────────────────────────────────────────────────────

export async function handleRegisterOptions(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const rp = rpConfig(request);
  const userId = genId();
  const body = await request.json().catch(() => ({})) as { displayName?: string };
  const displayName = (body.displayName ?? "").toString().slice(0, 60) || "Augur Player";

  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: displayName,
    userDisplayName: displayName,
    userID: new TextEncoder().encode(userId) as Uint8Array<ArrayBuffer>,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });

  const challengeToken = genToken();
  const now = Date.now();
  await db
    .prepare("INSERT INTO challenges (token, challenge, user_id, expires_at) VALUES (?, ?, ?, ?)")
    .bind(challengeToken, options.challenge, userId, now + CHALLENGE_TTL)
    .run();

  // Stash displayName alongside challenge for use during verify.
  await db
    .prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(userId, displayName, now, now)
    .run();

  return json({ options, challengeToken });
}

export async function handleRegisterVerify(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const rp = rpConfig(request);
  const body = (await request.json()) as {
    challengeToken: string;
    credential: unknown;
  };

  const row = await db
    .prepare("SELECT challenge, user_id FROM challenges WHERE token = ? AND expires_at > ?")
    .bind(body.challengeToken, Date.now())
    .first<{ challenge: string; user_id: string }>();
  if (!row) return json({ error: "challenge expired or invalid" }, 400);

  await db.prepare("DELETE FROM challenges WHERE token = ?").bind(body.challengeToken).run();

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential as never,
      expectedChallenge: row.challenge,
      expectedOrigin: rp.expectedOrigin,
      expectedRPID: rp.rpID,
    });
  } catch (e) {
    return json({ error: `verification failed: ${String(e)}` }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return json({ error: "verification rejected" }, 400);
  }

  const { credential } = verification.registrationInfo;
  const now = Date.now();

  await db
    .prepare(
      "INSERT INTO credentials (credential_id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      typeof credential.id === "string" ? credential.id : toBase64Url(credential.id as unknown as Uint8Array),
      row.user_id,
      typeof credential.publicKey === "string" ? credential.publicKey : toBase64Url(credential.publicKey as unknown as Uint8Array),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      now,
    )
    .run();

  const sessionToken = genToken();
  await db
    .prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(sessionToken, row.user_id, now, now + SESSION_TTL)
    .run();

  return json({ sessionToken, userId: row.user_id });
}

// ─── Login ─────────────────────────────────────────────────────────────────

export async function handleLoginOptions(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const rp = rpConfig(request);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: "required",
  });

  const challengeToken = genToken();
  await db
    .prepare("INSERT INTO challenges (token, challenge, user_id, expires_at) VALUES (?, ?, ?, ?)")
    .bind(challengeToken, options.challenge, null, Date.now() + CHALLENGE_TTL)
    .run();

  return json({ options, challengeToken });
}

export async function handleLoginVerify(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const rp = rpConfig(request);
  const body = (await request.json()) as {
    challengeToken: string;
    credential: unknown;
  };

  const challengeRow = await db
    .prepare("SELECT challenge FROM challenges WHERE token = ? AND expires_at > ?")
    .bind(body.challengeToken, Date.now())
    .first<{ challenge: string }>();
  if (!challengeRow) return json({ error: "challenge expired" }, 400);

  await db.prepare("DELETE FROM challenges WHERE token = ?").bind(body.challengeToken).run();

  const cred = body.credential as { id?: string; rawId?: string };
  const credId = cred.id || cred.rawId || "";
  const credRow = await db
    .prepare("SELECT credential_id, user_id, public_key, counter, transports FROM credentials WHERE credential_id = ?")
    .bind(credId)
    .first<{
      credential_id: string;
      user_id: string;
      public_key: string;
      counter: number;
      transports: string;
    }>();
  if (!credRow) return json({ error: "unknown credential" }, 400);

  let verification;
  try {
    const transports = JSON.parse(credRow.transports || "[]") as AuthenticatorTransportFuture[];
    verification = await verifyAuthenticationResponse({
      response: body.credential as never,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: rp.expectedOrigin,
      expectedRPID: rp.rpID,
      credential: {
        id: credRow.credential_id,
        publicKey: fromBase64Url(credRow.public_key) as Uint8Array<ArrayBuffer>,
        counter: credRow.counter,
        transports,
      },
    });
  } catch (e) {
    return json({ error: `verification failed: ${String(e)}` }, 400);
  }

  if (!verification.verified) return json({ error: "rejected" }, 400);

  const now = Date.now();
  await db
    .prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?")
    .bind(
      verification.authenticationInfo.newCounter,
      now,
      credRow.credential_id,
    )
    .run();

  const sessionToken = genToken();
  await db
    .prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(sessionToken, credRow.user_id, now, now + SESSION_TTL)
    .run();

  return json({ sessionToken, userId: credRow.user_id });
}

// ─── Session ───────────────────────────────────────────────────────────────

export async function authenticate(
  request: Request,
  db: D1Database,
): Promise<string | null> {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const row = await db
    .prepare("SELECT user_id, expires_at FROM sessions WHERE token = ? AND expires_at > ?")
    .bind(token, Date.now())
    .first<{ user_id: string; expires_at: number }>();
  if (!row) return null;
  // Sliding window: extend if within 7 days of expiry.
  if (row.expires_at - Date.now() < 7 * 24 * 60 * 60 * 1000) {
    await db
      .prepare("UPDATE sessions SET expires_at = ? WHERE token = ?")
      .bind(Date.now() + SESSION_TTL, token)
      .run();
  }
  return row.user_id;
}

export async function handleMe(
  request: Request,
  db: D1Database,
): Promise<Response> {
  const userId = await authenticate(request, db);
  if (!userId) return json({ error: "unauthorized" }, 401);
  const user = await db
    .prepare("SELECT id, display_name, created_at FROM users WHERE id = ?")
    .bind(userId)
    .first();
  if (!user) return json({ error: "user not found" }, 404);
  return json({ user });
}
