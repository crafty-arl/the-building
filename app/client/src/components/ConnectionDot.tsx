import type { ConnectionStatus } from "../lib/ws";

/**
 * Legacy dot retained for any consumer; the top-bar now uses its own
 * inline live-pill, but Kicked screen + error banners still call in here.
 */
export function ConnectionDot({ status }: { status: ConnectionStatus }) {
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting\u2026"
        : status === "kicked"
          ? "Kicked"
          : "Disconnected";
  return (
    <span className="live-pill" title={label}>
      <span className={`live-dot ${status}`} aria-hidden />
    </span>
  );
}
