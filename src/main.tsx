/**
 * Entry point. Bootstraps React + global providers.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import "./styles/globals.css";

document.addEventListener("contextmenu", (e) => {
  if ((e.target as HTMLElement).closest("[data-ctx]")) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
