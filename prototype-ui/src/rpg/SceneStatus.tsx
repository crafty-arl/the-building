import { useEffect, useMemo, useState } from "react";
import type {
  Difficulty,
  HealthSnapshot,
  MissedEvent,
  PeerInfo,
} from "../../../app/shared/protocol";
import type { HearthAgentLive, HearthStatus } from "./useHearth";

const DIFFICULTIES: Difficulty[] = ["tourist", "resident", "native"];

interface Props {
  status: HearthStatus;
  role: "owner" | "observer";
  peers: PeerInfo[];
  selfPeerId: string;
  health: HealthSnapshot | null;
  agents: Record<string, HearthAgentLive>;
  inviteToken: string;
  difficulty: Difficulty;
  missedEvents: MissedEvent[];
  onSetDifficulty: (next: Difficulty) => void;
  onRotateInvite: () => void;
  onDismissMissed: () => void;
}

/**
 * Liveness HUD + peer roster + share link + difficulty toggle, rendered as
 * a single floating panel at the top-right of the scene. Everything that
 * proves "the scene is real" — plan provenance, alarm age, per-agent
 * heartbeat dots, connected peers — shows up here so any observer can tell
 * at a glance that the autonomous scene is actually live.
 */
export function SceneStatus(props: Props) {
  const {
    status,
    role,
    peers,
    selfPeerId,
    health,
    agents,
    inviteToken,
    difficulty,
    missedEvents,
    onSetDifficulty,
    onRotateInvite,
    onDismissMissed,
  } = props;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [copied, setCopied] = useState(false);
  const shareUrl = useMemo(() => {
    if (typeof window === "undefined" || !inviteToken) return "";
    const u = new URL(window.location.href);
    u.searchParams.set("inv", inviteToken);
    return u.toString();
  }, [inviteToken]);

  const copyShare = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API denied (http, iframes, etc). Fall back to prompt.
      window.prompt("copy this link", shareUrl);
    }
  };

  const agentList = useMemo(() => {
    const arr = Object.values(agents).filter((a) => a.agentId !== "director");
    arr.sort((a, b) => a.agentId.localeCompare(b.agentId));
    const director = agents["director"];
    return director ? [director, ...arr] : arr;
  }, [agents]);

  const planSource = health?.planSource ?? "—";
  const planGen = health?.planGeneratedAt ?? null;
  const lastAlarm = health?.lastAlarmAt ?? null;

  return (
    <div className="rp-scene-status" role="complementary" aria-label="Scene status">
      {missedEvents.length > 0 && (
        <div className="rp-missed-banner" role="status">
          <div className="rp-missed-head">
            <strong>while you were away · {missedEvents.length}</strong>
            <button
              type="button"
              className="rp-missed-close"
              onClick={onDismissMissed}
              aria-label="Dismiss"
              title="Dismiss"
            >
              ×
            </button>
          </div>
          <ul className="rp-missed-list">
            {missedEvents.slice(-6).map((ev, idx) => (
              <li key={`${ev.at}-${idx}`}>
                <strong>{shortAgentName(ev.agentId)}</strong>{" "}
                {ev.actionType ? <em>({ev.actionType})</em> : null}{" "}
                {ev.actionText ? `“${ev.actionText}” · ` : ""}
                <span className="rp-missed-reason">{ev.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rp-status-row">
        <span className={`rp-live-dot ${status}`} aria-hidden />
        <span className="rp-status-label">{statusLabel(status)}</span>
        <span className="rp-status-sep">·</span>
        <span className="rp-status-role">{role}</span>
      </div>

      <div className="rp-status-row">
        <span className="rp-status-key">plan</span>
        <span className={`rp-status-val rp-plan-${planSource}`}>
          {planSource}
          {planGen ? ` · ${relShort(now - planGen)} ago` : ""}
        </span>
      </div>

      <div className="rp-status-row">
        <span className="rp-status-key">alarm</span>
        <span className="rp-status-val">
          {lastAlarm ? `${relShort(now - lastAlarm)} ago` : "(never)"}
        </span>
      </div>

      {agentList.length > 0 && (
        <div className="rp-status-row rp-status-agents">
          <span className="rp-status-key">agents</span>
          <span className="rp-agent-dots">
            {agentList.map((a) => {
              const thinking = a.thinkingCount > 0 && a.thinking.length > 0;
              return (
                <span
                  key={a.agentId}
                  className={`rp-agent-dot ${thinking ? "is-thinking" : a.lastDecidedAt ? "is-decided" : ""}`}
                  title={`${a.agentId}${a.lastReason ? ` — ${a.lastReason}` : ""}`}
                />
              );
            })}
          </span>
        </div>
      )}

      <div className="rp-status-row rp-peers-row">
        <span className="rp-status-key">peers</span>
        <ul className="rp-peer-list">
          {peers.map((p) => (
            <li
              key={p.peerId}
              className={`rp-peer-chip role-${p.role}${p.peerId === selfPeerId ? " is-self" : ""}`}
              title={`${p.displayName} · ${p.role}`}
            >
              {p.displayName}
            </li>
          ))}
          {peers.length === 0 && <li className="rp-peer-empty">(none)</li>}
        </ul>
      </div>

      {role === "owner" && (
        <>
          <div className="rp-status-row rp-diff-row">
            <span className="rp-status-key">pace</span>
            <span className="rp-diff-group" role="radiogroup" aria-label="Difficulty">
              {DIFFICULTIES.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`rp-diff-btn ${d === difficulty ? "is-active" : ""}`}
                  onClick={() => onSetDifficulty(d)}
                  aria-pressed={d === difficulty}
                >
                  {d}
                </button>
              ))}
            </span>
          </div>

          <div className="rp-status-row rp-share-row">
            <button
              type="button"
              className="rp-share-btn"
              onClick={() => void copyShare()}
              disabled={!shareUrl}
              title="Copy a view-only link to this room"
            >
              {copied ? "copied" : "copy link"}
            </button>
            <button
              type="button"
              className="rp-share-btn rp-share-rotate"
              onClick={onRotateInvite}
              title="Rotate the invite — old links stop working"
            >
              rotate
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function statusLabel(status: HearthStatus): string {
  switch (status) {
    case "open":
      return "live";
    case "connecting":
      return "connecting";
    case "closed":
      return "offline";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function shortAgentName(agentId: string): string {
  if (agentId === "director") return "director";
  if (agentId.startsWith("npc:")) {
    return agentId
      .slice(4)
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return agentId;
}

function relShort(ms: number): string {
  if (ms < 1000) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}
