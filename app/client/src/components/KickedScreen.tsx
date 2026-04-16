export function KickedScreen() {
  return (
    <div className="kicked-overlay" role="alertdialog" aria-modal="true">
      <div className="kicked-panel">
        <h1>You're watching this run in another window.</h1>
        <p>
          Augur only allows one DM at a time. Close the other window, then
          return here to resume watching Claw.
        </p>
        <button className="primary" onClick={() => location.reload()}>
          Reconnect
        </button>
      </div>
    </div>
  );
}
