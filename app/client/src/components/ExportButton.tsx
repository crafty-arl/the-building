/**
 * Principle 7: Ownership is non-negotiable. Export lives in the top bar of
 * every Fiction Reactor page. Disabled until the export pipeline lands —
 * never hidden (except on phones where space is too tight; hide via CSS).
 */
export function ExportButton() {
  return (
    <button
      className="export-button"
      type="button"
      disabled
      title="Coming soon — your run will be exportable as a file."
    >
      Export
    </button>
  );
}
