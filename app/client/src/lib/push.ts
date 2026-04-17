/**
 * Push opt-in helpers. The UI is expected to gate these behind a user gesture
 * (iOS Safari requires it). Identity matches the WS convention: ?userId=...
 */

const DEFAULT_USER = "dev-user";

function userId(): string {
  return DEFAULT_USER;
}

function urlBase64ToArrayBuffer(b64: string): ArrayBuffer {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

export type PushState =
  | "unsupported" // browser can't do push at all
  | "denied" // user rejected; they have to unblock manually
  | "idle" // supported but not subscribed
  | "subscribed" // we have a live subscription on this device
  | "installing"; // SW still activating

export async function currentPushState(): Promise<PushState> {
  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return "installing";
  const existing = await reg.pushManager.getSubscription();
  return existing ? "subscribed" : "idle";
}

async function fetchVapidPublicKey(): Promise<string> {
  const res = await fetch("/api/push/vapid-public-key");
  if (!res.ok) throw new Error(`vapid-public-key ${res.status}`);
  const { publicKey } = (await res.json()) as { publicKey: string };
  if (!publicKey) throw new Error("vapid-public-key empty");
  return publicKey;
}

function subscriptionToJSON(sub: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const json = sub.toJSON();
  return {
    endpoint: json.endpoint ?? sub.endpoint,
    keys: {
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
    },
  };
}

export async function subscribeToPush(): Promise<PushSubscription> {
  const reg = await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("permission not granted");

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const publicKey = await fetchVapidPublicKey();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToArrayBuffer(publicKey),
    });
  }

  const res = await fetch(
    `/api/push/subscribe?userId=${encodeURIComponent(userId())}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscriptionToJSON(sub)),
    },
  );
  if (!res.ok) throw new Error(`subscribe ${res.status}`);
  return sub;
}

export async function unsubscribeFromPush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

export async function sendTestPush(): Promise<{
  sent: number;
  pruned: number;
}> {
  const res = await fetch(
    `/api/push/test?userId=${encodeURIComponent(userId())}`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`test ${res.status}`);
  return (await res.json()) as { sent: number; pruned: number };
}
