import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Difficulty,
  HealthSnapshot,
  MissedEvent,
  NpcDay,
  PeerInfo,
} from "../../../app/shared/protocol";
import type { Character } from "./engine";
import type {
  HearthAgentLive,
  HearthHello,
  HearthMoment,
  HearthStatus,
} from "./useHearth";
import { slugify, stripNpcPrefix } from "./useHearth";

type SheetKind = null | "profile" | "season" | "settings" | "menu";
type ConsoleMode = "scene" | "cast" | "room" | "log";

const DIFFICULTIES: Difficulty[] = ["tourist", "resident", "native"];

/**
 * Ribbon modes are only meaningful in-play. When !inPlay the dock renders
 * the BuildingPane directly — no ribbon, no tape. The ☰ menu button lives
 * in the tape and is the canonical way to open profile/season/settings.
 */
const MODE_DEFS: Array<{
  id: ConsoleMode;
  label: string;
  glyph: string;
}> = [
  { id: "scene", label: "scene", glyph: "◎" },
  { id: "cast", label: "cast", glyph: "☰" },
  { id: "room", label: "room", glyph: "◌" },
  { id: "log", label: "log", glyph: "▤" },
];

interface Props {
  /** Scene context */
  hello: HearthHello | null;
  status: HearthStatus;
  role: "owner" | "observer";
  peers: PeerInfo[];
  selfPeerId: string;
  health: HealthSnapshot | null;
  agents: Record<string, HearthAgentLive>;
  moments: HearthMoment[];
  inviteToken: string;
  difficulty: Difficulty;
  missedEvents: MissedEvent[];
  npcsByAgentId: Record<string, NpcDay>;
  liveCast: Character[];
  inPlay: boolean;

  /** Directive */
  directive: string;
  setDirective: (v: string) => void;
  onSubmitDirective: () => void;
  narratorThinking: boolean;
  busy: boolean;

  /** Tape */
  paused: boolean;
  narrationSpeed: number;
  historyCount: number;
  pending: boolean;
  spent: boolean;
  onTogglePause: () => void;
  onRewind: () => void;
  onSkipLine: () => void;
  onToggleSpeed: () => void;

  /** Menu / sheets */
  activeSheet: SheetKind;
  setActiveSheet: (v: SheetKind) => void;

  /** Status actions */
  onSetDifficulty: (next: Difficulty) => void;
  onRotateInvite: () => void;
  onDismissMissed: () => void;

  /** Back out of the room to the building view. */
  onBackToMenu: () => void;
}

/**
 * Unified bottom-mounted control surface with switchable view modes.
 *
 * One dock, many "channels." The mode ribbon at the top toggles what fills
 * the main pane: a compact scene view (directive + cast chips + room pill),
 * a cast focus, a room/status focus, a live moment log, or the out-of-play
 * menu tabs. The tape strip (playback + alarm) is persistent at the bottom
 * across every mode. Nothing floats outside the dock — the status HUD and
 * the left cast drawer are gone; their data is reachable via dedicated modes.
 */
export function StageConsole(props: Props) {
  const {
    hello,
    status,
    role,
    peers,
    selfPeerId,
    health,
    agents,
    moments,
    inviteToken,
    difficulty,
    missedEvents,
    npcsByAgentId,
    liveCast,
    inPlay,
    directive,
    setDirective,
    onSubmitDirective,
    narratorThinking,
    busy,
    paused,
    narrationSpeed,
    historyCount,
    pending,
    spent,
    onTogglePause,
    onRewind,
    onSkipLine,
    onToggleSpeed,
    activeSheet,
    setActiveSheet,
    onSetDifficulty,
    onRotateInvite,
    onDismissMissed,
    onBackToMenu,
  } = props;

  // Ribbon mode only matters in-play. Default to "scene".
  const [mode, setMode] = useState<ConsoleMode>("scene");

  // Dock collapse — drag the grabber down to reveal the canvas underneath.
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [dragOffset, setDragOffset] = useState<number | null>(null);

  // Pop the dock back up whenever a new game launches: if the player
  // collapsed it in the menu or on a prior floor, a fresh run should
  // start with the console visible.
  useEffect(() => {
    if (inPlay) setCollapsed(false);
  }, [inPlay]);
  const dragStartRef = useRef<
    { y: number; baseline: number; height: number; moved: boolean } | null
  >(null);
  const GRABBER_PEEK = 40;

  const onGrabberPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const el = consoleRef.current;
    if (!el) return;
    const height = el.offsetHeight;
    const baseline = collapsed ? Math.max(0, height - GRABBER_PEEK) : 0;
    dragStartRef.current = { y: e.clientY, baseline, height, moved: false };
    setDragOffset(baseline);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onGrabberPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    const delta = e.clientY - start.y;
    if (Math.abs(delta) > 4) start.moved = true;
    const maxOffset = Math.max(0, start.height - GRABBER_PEEK);
    const next = Math.min(maxOffset, Math.max(0, start.baseline + delta));
    setDragOffset(next);
  };

  const onGrabberPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const start = dragStartRef.current;
    if (!start) {
      setDragOffset(null);
      return;
    }
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    // Asymmetric commit:
    //  • Collapsed → open: any release opens. The dock is tall and dragging
    //    it all the way up is physically tedious, so we don't gate on drag
    //    distance. Tap or nudge — either one brings it back.
    //  • Open → collapse: require real intent (past halfway or a clear
    //    downward flick) so accidental touches don't close the dock.
    if (collapsed) {
      setCollapsed(false);
    } else if (!start.moved) {
      setCollapsed(true);
    } else {
      const maxOffset = Math.max(1, start.height - GRABBER_PEEK);
      const delta = e.clientY - start.y;
      const finalOffset = Math.min(
        maxOffset,
        Math.max(0, start.baseline + delta),
      );
      const FLICK = 36;
      const close = finalOffset > maxOffset / 2 || delta > FLICK;
      setCollapsed(close);
    }
    dragStartRef.current = null;
    setDragOffset(null);
  };

  const dragStyle =
    dragOffset !== null
      ? {
          transform: `translateY(${dragOffset}px)`,
          transition: "none" as const,
        }
      : undefined;

  const collapsedClass = collapsed ? " is-collapsed" : "";

  const grabber = (
    <button
      type="button"
      className="rp-console-grabber"
      onPointerDown={onGrabberPointerDown}
      onPointerMove={onGrabberPointerMove}
      onPointerUp={onGrabberPointerUp}
      onPointerCancel={onGrabberPointerUp}
      aria-label={collapsed ? "Expand dock" : "Collapse dock"}
      aria-expanded={!collapsed}
    >
      <span className="rp-console-grabber-bar" aria-hidden />
    </button>
  );

  // Clock tick for "relative time" displays.
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
      window.prompt("copy this link", shareUrl);
    }
  };

  // Cast chips (shared by scene + cast modes).
  type Chip = {
    agentId: string;
    name: string;
    palette: string;
    kind: "director" | "npc";
    live: HearthAgentLive | null;
    npc: NpcDay | null;
    localChar: Character | null;
  };

  const chips: Chip[] = useMemo(() => {
    const out: Chip[] = [];
    const director = agents["director"];
    if (director) {
      out.push({
        agentId: "director",
        name: "Director",
        palette: "#f7c87b",
        kind: "director",
        live: director,
        npc: null,
        localChar: null,
      });
    }
    const orderedNpcIds: string[] = [];
    if (hello?.dailyPlan?.npcs) {
      for (const n of hello.dailyPlan.npcs) {
        orderedNpcIds.push(`npc:${slugify(n.name)}`);
      }
    }
    for (const id of Object.keys(agents)) {
      if (id === "director") continue;
      if (!orderedNpcIds.includes(id)) orderedNpcIds.push(id);
    }
    for (const agentId of orderedNpcIds) {
      const npc = npcsByAgentId[agentId] ?? null;
      const live = agents[agentId] ?? null;
      const localChar =
        liveCast.find((c) => `npc:${slugify(c.name)}` === agentId) ?? null;
      const name = npc?.name ?? localChar?.name ?? stripNpcPrefix(agentId);
      const palette = localChar?.palette.cloak ?? paletteSwatch(npc?.palette);
      out.push({
        agentId,
        name,
        palette,
        kind: "npc",
        live,
        npc,
        localChar,
      });
    }
    return out;
  }, [agents, hello, npcsByAgentId, liveCast]);

  // Aggregate live-indicator badges for the mode ribbon.
  const thinkingCount = chips.filter(
    (c) => c.live && c.live.thinkingCount > 0 && c.live.thinking.length > 0,
  ).length;
  const momentCount = moments.length;
  const missedCount = missedEvents.length;

  // Room readout values.
  const planSource = health?.planSource ?? "—";
  const planGen = health?.planGeneratedAt ?? null;
  const lastAlarm = health?.lastAlarmAt ?? null;
  const alarmLabel = lastAlarm ? `${relShort(now - lastAlarm)}` : "—";

  // Out-of-play: one simple pane, no ribbon, no tape. The dock is just a
  // menu surface — profile / season / settings / building.
  if (!inPlay) {
    return (
      <div
        ref={consoleRef}
        className={`rp-console is-building${collapsedClass}`}
        role="region"
        aria-label="Menu"
        style={dragStyle}
      >
        {grabber}
        <BuildingPane
          activeSheet={activeSheet}
          setActiveSheet={setActiveSheet}
        />
      </div>
    );
  }

  const modeClass = `is-${mode}`;

  return (
    <div
      ref={consoleRef}
      className={`rp-console ${modeClass}${collapsedClass}`}
      role="region"
      aria-label="Stage console"
      style={dragStyle}
    >
      {grabber}
      {/* ── Mode ribbon ─────────────────────────────────────────── */}
      <div className="rp-console-ribbon" role="tablist" aria-label="Dock mode">
        {MODE_DEFS.map((m) => {
          const badge =
            m.id === "cast" && thinkingCount > 0
              ? "●"
              : m.id === "log" && momentCount > 0
                ? String(Math.min(99, momentCount))
                : m.id === "room" && missedCount > 0
                  ? "!"
                  : null;
          return (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              className={`rp-ribbon-tab ${mode === m.id ? "is-active" : ""}`}
              onClick={() => setMode(m.id)}
              title={m.label}
            >
              <span className="rp-ribbon-glyph" aria-hidden>
                {m.glyph}
              </span>
              <span className="rp-ribbon-label">{m.label}</span>
              {badge && <span className="rp-ribbon-badge">{badge}</span>}
            </button>
          );
        })}
        <span className="rp-ribbon-fill" aria-hidden />
        <span className="rp-ribbon-readout" title="live status">
          <span className={`rp-live-dot ${status}`} aria-hidden />
          <span>{statusLabel(status)}</span>
          <span className="rp-ribbon-sep">·</span>
          <span>{peers.length}p</span>
          <span className="rp-ribbon-sep">·</span>
          <span>{difficulty}</span>
        </span>
      </div>

      {/* Missed-events banner — surfaces in every mode except log (log shows
          them in its own header). */}
      {missedEvents.length > 0 && mode !== "log" && (
        <div className="rp-console-missed" role="status">
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
            {missedEvents.slice(-4).map((ev, idx) => (
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

      <div className="rp-console-pane">
        {mode === "scene" && (
          <ScenePane
            chips={chips}
            directive={directive}
            setDirective={setDirective}
            onSubmitDirective={onSubmitDirective}
            narratorThinking={narratorThinking}
            busy={busy}
            onOpenCastMode={() => setMode("cast")}
          />
        )}
        {mode === "cast" && <CastPane chips={chips} />}
        {mode === "room" && (
          <RoomPane
            status={status}
            role={role}
            peers={peers}
            selfPeerId={selfPeerId}
            planSource={planSource}
            planGen={planGen}
            lastAlarm={lastAlarm}
            now={now}
            difficulty={difficulty}
            inviteToken={inviteToken}
            shareUrl={shareUrl}
            copied={copied}
            copyShare={copyShare}
            onSetDifficulty={onSetDifficulty}
            onRotateInvite={onRotateInvite}
          />
        )}
        {mode === "log" && (
          <LogPane
            moments={moments}
            missedEvents={missedEvents}
            onDismissMissed={onDismissMissed}
            now={now}
          />
        )}
      </div>

      {/* Tape strip: back + menu + playback + alarm. The ‹ leaves the room
          for the building view. The ☰ opens profile / season / settings. */}
      <div className="rp-console-tape">
        <button
          type="button"
          className="rp-console-menu"
          onClick={onBackToMenu}
          title="Back to the building"
          aria-label="Back to the building"
        >
          ‹
        </button>
        <button
          type="button"
          className="rp-console-menu"
          onClick={() => setActiveSheet("menu")}
          title="Menu"
          aria-label="Menu"
        >
          ☰
        </button>
        <div
          className="rp-console-tape-controls"
          role="group"
          aria-label="Playback"
        >
          <button
            type="button"
            className="rp-icon-btn"
            onClick={onRewind}
            disabled={historyCount === 0 || spent}
            title={
              historyCount === 0 ? "Nothing to rewind" : `Rewind (${historyCount})`
            }
            aria-label="Rewind"
          >
            ⟲
          </button>
          <button
            type="button"
            className={`rp-icon-btn ${!paused ? "is-active" : ""}`}
            onClick={onTogglePause}
            title={paused ? "Play" : "Pause"}
            aria-label={paused ? "Play" : "Pause"}
          >
            {paused ? "▶" : "❚❚"}
          </button>
          <button
            type="button"
            className="rp-icon-btn"
            onClick={onSkipLine}
            disabled={!pending}
            title="Skip line"
            aria-label="Skip line"
          >
            ⏭
          </button>
          <button
            type="button"
            className="rp-icon-btn"
            onClick={onToggleSpeed}
            title={`Reading speed ${narrationSpeed >= 2 ? "2x" : "1x"}`}
            aria-pressed={narrationSpeed >= 2}
          >
            {narrationSpeed >= 2 ? "2×" : "1×"}
          </button>
        </div>
        <span className="rp-console-alarm" title="Last alarm tick">
          alarm {alarmLabel}
        </span>
      </div>
    </div>
  );
}

// ─── Pane: Scene ────────────────────────────────────────────────────────
// Compact default: cast chips (full-width, clicks into cast mode) on top,
// directive input below. Room/status is reachable from the ribbon's
// right-side readout and the dedicated room tab — no duplicate pill here.
function ScenePane(props: {
  chips: Array<{
    agentId: string;
    name: string;
    palette: string;
    kind: "director" | "npc";
    live: HearthAgentLive | null;
    npc: NpcDay | null;
    localChar: Character | null;
  }>;
  directive: string;
  setDirective: (v: string) => void;
  onSubmitDirective: () => void;
  narratorThinking: boolean;
  busy: boolean;
  onOpenCastMode: () => void;
}) {
  const {
    chips,
    directive,
    setDirective,
    onSubmitDirective,
    narratorThinking,
    busy,
    onOpenCastMode,
  } = props;
  return (
    <div className="rp-console-strip">
      <button
        type="button"
        className="rp-console-cast-trigger"
        onClick={onOpenCastMode}
        title="Open cast"
      >
        {chips.length === 0 && (
          <span className="rp-console-empty">assembling cast…</span>
        )}
        {chips.slice(0, 4).map((c) => {
          const isThinking = !!(
            c.live &&
            c.live.thinkingCount > 0 &&
            c.live.thinking.length > 0
          );
          const isDecided = !!c.live?.lastDecidedAt;
          return (
            <span
              key={c.agentId}
              className={`rp-agent-chip ${isThinking ? "is-thinking" : isDecided ? "is-decided" : ""}`}
              title={c.live?.lastReason ?? c.name}
            >
              <span
                className="rp-agent-chip-swatch"
                style={{ background: c.palette }}
                aria-hidden
              />
              <span className="rp-agent-chip-name">{c.name}</span>
              {isThinking && c.live && (
                <span className="rp-agent-chip-stream" aria-hidden>
                  {c.live.thinking.slice(-40)}
                </span>
              )}
            </span>
          );
        })}
        {chips.length > 4 && (
          <span className="rp-agent-chip is-more">+{chips.length - 4}</span>
        )}
      </button>

      {/* Directive input at hero width */}
      <form
        className="rp-console-directive"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmitDirective();
        }}
      >
        <span
          className={`rp-directive-pulse ${narratorThinking ? "" : busy ? "is-off" : ""}`}
          aria-hidden="true"
        />
        <label className="visually-hidden" htmlFor="rp-directive-input">
          What happens next
        </label>
        <input
          id="rp-directive-input"
          type="text"
          className="rp-directive-input"
          placeholder={
            narratorThinking
              ? "director is composing…"
              : busy
                ? "the floor is unfolding…"
                : "What happens next?"
          }
          value={directive}
          onChange={(e) => setDirective(e.target.value)}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="submit"
          className="rp-directive-send"
          disabled={busy || !directive.trim()}
          aria-label="Submit"
        >
          ↑
        </button>
      </form>
    </div>
  );
}

// ─── Pane: Cast ─────────────────────────────────────────────────────────
// All agents in a grid, each with full chip head + live thought stream
// and a short bio line. Big enough to watch the scene think.
function CastPane(props: {
  chips: Array<{
    agentId: string;
    name: string;
    palette: string;
    kind: "director" | "npc";
    live: HearthAgentLive | null;
    npc: NpcDay | null;
    localChar: Character | null;
  }>;
}) {
  const { chips } = props;
  return (
    <div className="rp-castpane">
      {chips.length === 0 && (
        <div className="rp-console-empty">assembling cast…</div>
      )}
      {chips.map((c) => {
        const isThinking = !!(
          c.live &&
          c.live.thinkingCount > 0 &&
          c.live.thinking.length > 0
        );
        const isDecided = !!c.live?.lastDecidedAt;
        return (
          <div
            key={c.agentId}
            className={`rp-castpane-card ${isThinking ? "is-thinking" : isDecided ? "is-decided" : ""}`}
          >
            <div className="rp-castpane-head">
              <span
                className="rp-agent-chip-swatch"
                style={{ background: c.palette }}
                aria-hidden
              />
              <span className="rp-castpane-name">{c.name}</span>
              {c.kind === "director" && (
                <span className="rp-castpane-tag">director</span>
              )}
              {isThinking && (
                <span className="rp-castpane-tag is-thinking">· thinking</span>
              )}
            </div>
            {c.npc?.backstory && (
              <div className="rp-castpane-desc">{c.npc.backstory}</div>
            )}
            {c.npc?.objective && (
              <div className="rp-castpane-desc rp-castpane-italic">
                wants: {c.npc.objective}
              </div>
            )}
            {c.npc?.motive && (
              <div className="rp-castpane-desc rp-castpane-italic rp-castpane-dim">
                privately: {c.npc.motive}
              </div>
            )}
            {isThinking && c.live && (
              <div className="rp-castpane-stream">
                <span className="rp-castpane-stream-label">live</span>
                <span className="rp-castpane-stream-text">
                  {c.live.thinking.slice(-240)}
                </span>
              </div>
            )}
            {!isThinking && c.live?.lastReason && (
              <div className="rp-castpane-quote">“{c.live.lastReason}”</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Pane: Room ─────────────────────────────────────────────────────────
// Plan provenance, alarm clock, peers, pace, share. All visible at once.
function RoomPane(props: {
  status: HearthStatus;
  role: "owner" | "observer";
  peers: PeerInfo[];
  selfPeerId: string;
  planSource: string;
  planGen: number | null;
  lastAlarm: number | null;
  now: number;
  difficulty: Difficulty;
  inviteToken: string;
  shareUrl: string;
  copied: boolean;
  copyShare: () => void;
  onSetDifficulty: (d: Difficulty) => void;
  onRotateInvite: () => void;
}) {
  const {
    status,
    role,
    peers,
    selfPeerId,
    planSource,
    planGen,
    lastAlarm,
    now,
    difficulty,
    inviteToken,
    shareUrl,
    copied,
    copyShare,
    onSetDifficulty,
    onRotateInvite,
  } = props;
  return (
    <div className="rp-roompane">
      <div className="rp-roompane-head">
        <span className={`rp-live-dot ${status}`} aria-hidden />
        <span className="rp-roompane-title">{statusLabel(status)}</span>
        <span className="rp-pop-sep">·</span>
        <span className="rp-pop-tag">{role}</span>
      </div>
      <div className="rp-roompane-grid">
        <div className="rp-roompane-cell">
          <span className="rp-pop-key">plan</span>
          <span className={`rp-status-val rp-plan-${planSource}`}>
            {planSource}
            {planGen ? ` · ${relShort(now - planGen)} ago` : ""}
          </span>
        </div>
        <div className="rp-roompane-cell">
          <span className="rp-pop-key">alarm</span>
          <span className="rp-status-val">
            {lastAlarm ? `${relShort(now - lastAlarm)} ago` : "(never)"}
          </span>
        </div>
        <div className="rp-roompane-cell rp-roompane-full">
          <span className="rp-pop-key">peers</span>
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
            <div className="rp-roompane-cell rp-roompane-full">
              <span className="rp-pop-key">pace</span>
              <span
                className="rp-diff-group"
                role="radiogroup"
                aria-label="Difficulty"
              >
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
            <div className="rp-roompane-cell rp-roompane-full rp-share-row">
              <button
                type="button"
                className="rp-share-btn"
                onClick={() => void copyShare()}
                disabled={!shareUrl || !inviteToken}
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
    </div>
  );
}

// ─── Pane: Log ──────────────────────────────────────────────────────────
// Live scrolling feed of agent-decided moments.
function LogPane(props: {
  moments: HearthMoment[];
  missedEvents: MissedEvent[];
  onDismissMissed: () => void;
  now: number;
}) {
  const { moments, missedEvents, onDismissMissed, now } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll to latest on new moment.
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [moments.length]);

  return (
    <div className="rp-logpane">
      {missedEvents.length > 0 && (
        <div className="rp-console-missed" role="status">
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
      <div className="rp-logpane-list" ref={scrollRef}>
        {moments.length === 0 ? (
          <div className="rp-console-empty">
            the scene is quiet. waiting for the next agent to wake…
          </div>
        ) : (
          moments
            .slice(-80)
            .map((m, i) => (
              <div key={`${m.ts}-${i}`} className="rp-logpane-row">
                <span className="rp-logpane-ts">
                  {relShort(now - m.ts)} ago
                </span>
                <span className="rp-logpane-agent">
                  {m.npcName ?? shortAgentName(m.agentId)}
                </span>
                {m.action?.type && (
                  <span className={`rp-logpane-kind kind-${m.action.type}`}>
                    {m.action.type}
                  </span>
                )}
                {m.action?.text && (
                  <span className="rp-logpane-text">“{m.action.text}”</span>
                )}
                <span className="rp-logpane-reason">· {m.reason}</span>
              </div>
            ))
        )}
      </div>
    </div>
  );
}

// ─── Pane: Building (out-of-play) ──────────────────────────────────────
// Shown only when !inPlay. Four tabs open Sheet overlays; BUILDING is the
// current view so it stays pressed as a contextual anchor.
function BuildingPane(props: {
  activeSheet: SheetKind;
  setActiveSheet: (v: SheetKind) => void;
}) {
  const { activeSheet, setActiveSheet } = props;
  return (
    <div className="rp-menupane">
      <button
        type="button"
        className="rp-dock-tab"
        aria-pressed={activeSheet === "profile"}
        onClick={() => setActiveSheet(activeSheet === "profile" ? null : "profile")}
      >
        <span className="rp-dock-tab-glyph">◉</span>
        <span className="rp-dock-tab-label">PROFILE</span>
      </button>
      <button
        type="button"
        className="rp-dock-tab"
        aria-pressed={activeSheet === "season"}
        onClick={() => setActiveSheet(activeSheet === "season" ? null : "season")}
      >
        <span className="rp-dock-tab-glyph">☼</span>
        <span className="rp-dock-tab-label">SEASON</span>
      </button>
      <button
        type="button"
        className="rp-dock-tab"
        aria-pressed={activeSheet === "settings"}
        onClick={() =>
          setActiveSheet(activeSheet === "settings" ? null : "settings")
        }
      >
        <span className="rp-dock-tab-glyph">⚙</span>
        <span className="rp-dock-tab-label">SETTINGS</span>
      </button>
      <button
        type="button"
        className="rp-dock-tab"
        aria-pressed
        onClick={() => setActiveSheet(null)}
        title="You're on the building view"
      >
        <span className="rp-dock-tab-glyph">⌂</span>
        <span className="rp-dock-tab-label">BUILDING</span>
      </button>
    </div>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────

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

function paletteSwatch(palette: string | undefined): string {
  switch (palette) {
    case "warm":
      return "#e8d0a8";
    case "cool":
      return "#9bb0c9";
    case "ash":
      return "#8c8c8c";
    case "ember":
      return "#d67a4a";
    case "moss":
      return "#7ea872";
    default:
      return "#8c8c8c";
  }
}
