import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { RPG } from "./rpg/RPG";
import { AuthGate } from "./rpg/AuthGate";
import "./styles.css";

function App() {
  const [authed, setAuthed] = useState(false);
  return (
    <AuthGate onAuthenticated={() => setAuthed(true)}>
      {authed && <RPG />}
    </AuthGate>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
