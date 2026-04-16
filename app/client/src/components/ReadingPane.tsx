import { useMemo } from "react";
import { useAugur, activeBranch } from "../state";
import { glyphForMechanic } from "../lib/glyphs";
import type { TreeEntryWire } from "../../../shared/protocol";

/**
 * Main prose column. 640px wide, centered. Scene-top (glyph + uppercased
 * location), scene-meta line, then active-branch prose interleaved with
 * inline card markers. Last entry's final italic sentence is rendered in
 * amber as a callout if we can detect one.
 *
 * TODO(proxy): day counter is a crude fn of branch length. The protocol
 * doesn't carry a day field yet.
 */
export function ReadingPane() {
  const scene = useAugur((s) => s.scene);
  const tree = useAugur((s) => s.tree);
  const streaming = useAugur((s) => s.streamingTurn);

  const branch = useMemo(
    () => activeBranch(tree.entries, tree.leafId),
    [tree.entries, tree.leafId],
  );

  // TODO(proxy): pack name is hardcoded.
  const packName = "Primal Script";
  const day = Math.max(1, Math.floor(tree.entries.length / 3) + 1);
  const tod = scene?.timeOfDay ?? "dusk";
  const sceneTitle = (scene?.location ?? "A Quiet Room").toUpperCase();

  return (
    <div className="main-col">
      <div className="reading-pane">
        <div className="scene-top">
          <span className="scene-rule" aria-hidden />
          <span className="scene-title">{sceneTitle}</span>
          <span className="scene-rule" aria-hidden />
        </div>
        <div className="scene-meta">
          {packName} · day {day} · {tod}
        </div>

        {branch.length === 0 && !streaming && (
          <p className="prose-paragraph muted">
            The scene is set. Claw is waiting for the first stirring.
          </p>
        )}

        {branch.map((entry, idx) => {
          const isLast = idx === branch.length - 1 && !streaming;
          return (
            <EntryBlock key={entry.id} entry={entry} highlightCallout={isLast} />
          );
        })}

        {streaming && (
          <>
            <p className="prose-paragraph">{streaming.text}</p>
            <div className="stream-cursor">
              <span className="stream-dot" aria-hidden />
              <span className="stream-label">writing</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EntryBlock({
  entry,
  highlightCallout,
}: {
  entry: TreeEntryWire;
  highlightCallout: boolean;
}) {
  // Split the entry text. If the final sentence reads like a reveal (ends
  // on a period and sits on its own paragraph) we render the last paragraph
  // as an amber italic callout, but only for the most-recent entry.
  const paragraphs = useMemo(() => splitParagraphs(entry.text), [entry.text]);

  return (
    <>
      {entry.card && (
        <div className="inline-card-wrap">
          <InlineCard
            mechanic={entry.card.mechanic}
            label={entry.label ?? entry.card.id}
          />
        </div>
      )}
      {paragraphs.map((p, i) => {
        const isFinal = i === paragraphs.length - 1;
        const isCallout = highlightCallout && isFinal && paragraphs.length > 1;
        return (
          <p
            key={i}
            className={"prose-paragraph" + (isCallout ? " callout" : "")}
          >
            {p}
          </p>
        );
      })}
    </>
  );
}

function InlineCard({ mechanic, label }: { mechanic: string; label: string }) {
  const glyph = glyphForMechanic(mechanic);
  return (
    <span className="inline-card">
      <span
        className="inline-card-glyph"
        aria-hidden
        style={glyph.color ? { color: glyph.color } : undefined}
      >
        {glyph.char}
      </span>
      <span className="inline-card-title">{prettify(label)}</span>
    </span>
  );
}

function prettify(s: string): string {
  return s.replace(/[-_]/g, " ");
}

function splitParagraphs(text: string): string[] {
  const parts = text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}
