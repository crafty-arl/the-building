import { useMemo } from "react";
import { useAugur, activeBranch } from "../state";
import { glyphForMechanic } from "../lib/glyphs";
import type { TreeEntryWire } from "../../../shared/protocol";

/**
 * Claw's thought — side rail. Collapsed is a 48px column with a single blue
 * dot (click to expand). Expanded shows per-turn records: "TURN n · card-id"
 * header, italic prose derived from the entry text, and a small play-marker
 * that echoes the card that was played.
 *
 * Per-turn hand/footsteps metadata is not on the wire as a history; we
 * display the card label + the cost at play-time. TODO: once the server
 * emits historical footstep counts per entry we'll wire those.
 */
export function ClawRail() {
  const open = useAugur((s) => s.clawThoughtOpen);
  const setOpen = useAugur((s) => s.setClawThoughtOpen);
  const tree = useAugur((s) => s.tree);
  const streaming = useAugur((s) => s.streamingTurn);

  const branch = useMemo(
    () => activeBranch(tree.entries, tree.leafId),
    [tree.entries, tree.leafId],
  );

  if (!open) {
    return (
      <aside
        className="claw-rail collapsed"
        onClick={() => setOpen(true)}
        role="button"
        aria-label="Open Claw's thought"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen(true);
        }}
      >
        <span className="rail-dot" aria-hidden />
      </aside>
    );
  }

  return (
    <aside className="claw-rail expanded" aria-label="Claw's thought">
      <div className="claw-rail-header">
        <span className="claw-rail-header-dot" aria-hidden />
        <span className="claw-rail-header-text">Claw's Thought</span>
        <button
          className="claw-rail-close"
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Collapse Claw's thought"
        >
          close
        </button>
      </div>
      <div className="claw-rail-sublabel">what the agent sees &amp; chooses</div>
      <div className="claw-rail-rule" aria-hidden />

      {branch.length === 0 && !streaming && (
        <p className="turn-text">Claw has not yet begun. Gift a card or wait.</p>
      )}

      {branch.map((entry, idx) => {
        const isLast = idx === branch.length - 1 && !streaming;
        return (
          <TurnRecord
            key={entry.id}
            turnNumber={idx + 1}
            entry={entry}
            isCurrent={isLast}
          />
        );
      })}

      {streaming && (
        <div className="turn-record">
          <div className="turn-head">
            <span className="turn-label live">
              TURN {branch.length + 1}
            </span>
            <span className="turn-live-tag">LIVE</span>
          </div>
          <p className="turn-text current">
            {streaming.text}
            <span className="stream-dot" style={{ display: "inline-block", width: 8, height: 14, verticalAlign: "middle", marginLeft: 4 }} aria-hidden />
          </p>
        </div>
      )}
    </aside>
  );
}

function TurnRecord({
  turnNumber,
  entry,
  isCurrent,
}: {
  turnNumber: number;
  entry: TreeEntryWire;
  isCurrent: boolean;
}) {
  const glyph = entry.card ? glyphForMechanic(entry.card.mechanic) : null;
  const label = entry.label ?? (entry.card ? prettify(entry.card.id) : null);
  return (
    <div className="turn-record">
      <div className="turn-head">
        <span className={"turn-label" + (isCurrent ? " live" : "")}>
          TURN {turnNumber}
        </span>
        {isCurrent && <span className="turn-live-tag">LIVE</span>}
        {label && (
          <>
            <span className="turn-sep" aria-hidden>·</span>
            <span className="turn-meta">{label}</span>
          </>
        )}
      </div>
      <p className={"turn-text" + (isCurrent ? " current" : "")}>{entry.text}</p>
      {entry.card && glyph && label && (
        <div className="turn-play">
          <span className="turn-play-arrow" aria-hidden>→</span>
          <span
            className="turn-play-glyph"
            aria-hidden
            style={glyph.color ? { color: glyph.color } : undefined}
          >
            {glyph.char}
          </span>
          <span className="turn-play-text">{label}</span>
        </div>
      )}
    </div>
  );
}

function prettify(id: string): string {
  return id.replace(/[-_]/g, " ");
}
