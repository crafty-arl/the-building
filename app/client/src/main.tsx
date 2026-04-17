import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Stub SW unlocks the Chromium install prompt. Skip in dev so Vite HMR stays
// uncached and DevTools doesn't flag an unnecessary worker.
if (
  "serviceWorker" in navigator &&
  import.meta.env.PROD &&
  window.location.protocol === "https:"
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
