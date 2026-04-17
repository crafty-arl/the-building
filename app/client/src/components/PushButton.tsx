import { useEffect, useState } from "react";
import {
  currentPushState,
  sendTestPush,
  subscribeToPush,
  type PushState,
} from "../lib/push";

/**
 * Tiny opt-in surface for the push hello-world. Three visual states:
 *   idle         → "Enable notifications"  (subscribe flow)
 *   subscribed   → "Send test push"        (hits /api/push/test)
 *   denied/unsupported → disabled, reason in title
 */
export function PushButton() {
  const [state, setState] = useState<PushState>("installing");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    currentPushState().then(setState);
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  if (state === "unsupported") {
    return (
      <button
        className="icon-btn"
        type="button"
        disabled
        title="Push notifications not supported in this browser"
      >
        🔕
      </button>
    );
  }

  if (state === "denied") {
    return (
      <button
        className="icon-btn"
        type="button"
        disabled
        title="Notifications blocked in browser settings"
      >
        🔕
      </button>
    );
  }

  async function onClick() {
    setBusy(true);
    try {
      if (state === "idle" || state === "installing") {
        await subscribeToPush();
        setState("subscribed");
        setFlash("subscribed");
      } else if (state === "subscribed") {
        const { sent } = await sendTestPush();
        setFlash(sent > 0 ? "sent" : "no subs");
      }
    } catch (e) {
      setFlash("error: " + String(e instanceof Error ? e.message : e).slice(0, 40));
      const next = await currentPushState();
      setState(next);
    } finally {
      setBusy(false);
    }
  }

  const label =
    state === "subscribed"
      ? flash === "sent"
        ? "Sent ✓"
        : "Send test push"
      : busy
        ? "…"
        : "Enable notifications";

  return (
    <button
      className="push-button"
      type="button"
      onClick={onClick}
      disabled={busy}
      title={flash ?? label}
    >
      {label}
    </button>
  );
}
