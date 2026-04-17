import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// SW unlocks the Chromium install prompt AND is required to receive web push.
// Browsers treat localhost as a secure origin, so we register there too —
// the SW's fetch handler is empty, so Vite HMR is untouched.
if ("serviceWorker" in navigator) {
  const isSecure =
    window.location.protocol === "https:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  if (isSecure) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
}
