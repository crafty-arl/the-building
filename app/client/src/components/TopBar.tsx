import { useAugur } from "../state";
import { ExportButton } from "./ExportButton";
import type { ConnectionStatus } from "../lib/ws";

interface Props {
  status: ConnectionStatus;
}

/**
 * Top bar — breadcrumb left, LIVE dot + gear right. Matches the Fiction
 * Reactor frame `mTxdf`. Scene crumb displays the uppercased location the
 * DM is watching right now.
 *
 * TODO: run/pack name comes from a future pack-level field; hardcoded.
 */
export function TopBar({ status }: Props) {
  const scene = useAugur((s) => s.scene);
  const dailyPlan = useAugur((s) => s.dailyPlan);
  const clock = useAugur((s) => s.clock);

  const packName = dailyPlan ? dailyPlan.dayOfWeek.toUpperCase() : "TODAY";
  const sceneNum = clock
    ? `${String(clock.gameHour).padStart(2, "0")}:${String(clock.gameMinute).padStart(2, "0")}`
    : "—";
  const sceneName = (scene?.location ?? "A QUIET ROOM").toUpperCase();

  const liveLabel =
    status === "connected"
      ? "LIVE"
      : status === "connecting"
        ? "CONNECTING"
        : status === "kicked"
          ? "KICKED"
          : "OFFLINE";

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="back-icon" aria-hidden>
          {"\u2039"}
        </span>
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <span className="crumb crumb-pack">{packName}</span>
          <span className="crumb-sep crumb-pack">·</span>
          <span className="crumb crumb-scene-num">{sceneNum}</span>
          <span className="crumb-sep crumb-scene-num">·</span>
          <span className="crumb crumb-active crumb-scene">{sceneName}</span>
        </nav>
      </div>
      <div className="topbar-right">
        <span className="live-pill" title={liveLabel}>
          <span className={`live-dot ${status}`} aria-hidden />
          <span className="live-label">{liveLabel}</span>
        </span>
        <span className="topbar-divider" aria-hidden />
        <ExportButton />
        <button className="icon-btn" type="button" aria-label="Settings" title="Settings">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
