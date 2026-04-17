import { useEffect, useMemo, useState } from "react";
import { useAugur } from "./state";
import { createWSClient, type ConnectionStatus } from "./lib/ws";
import { TopBar } from "./components/TopBar";
import { ClawRail } from "./components/ClawRail";
import { ReadingPane } from "./components/ReadingPane";
import { StateStrip } from "./components/StateStrip";
import { DMBar } from "./components/DMBar";
import { ClawHandDrawer } from "./components/ClawHandDrawer";
import { KickedScreen } from "./components/KickedScreen";
import { RunEndOverlay } from "./components/RunEndOverlay";
import { SoftWarningBanner } from "./components/SoftWarningBanner";

export function App() {
  const apply = useAugur((s) => s.applyServer);
  const kicked = useAugur((s) => s.kicked);
  const errorMessage = useAugur((s) => s.errorMessage);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  const ws = useMemo(() => createWSClient(), []);

  useEffect(() => {
    const offMsg = ws.onMessage(apply);
    const offStatus = ws.onStatus(setStatus);
    ws.connect();
    return () => {
      offMsg();
      offStatus();
      ws.close();
    };
  }, [ws, apply]);

  return (
    <div className="reactor">
      <TopBar status={status} />
      <div className="rule-row" aria-hidden />
      <div className="body">
        <ClawRail />
        <ReadingPane />
      </div>
      <div className="rule-row" aria-hidden />
      <StateStrip />
      <div className="rule-row" aria-hidden />
      <DMBar />
      {errorMessage && <div className="error-banner">{errorMessage}</div>}
      <SoftWarningBanner />
      <ClawHandDrawer
        onPlay={(cardId) => ws.send({ type: "play", cardId })}
      />
      <RunEndOverlay />
      {kicked && <KickedScreen />}
    </div>
  );
}
