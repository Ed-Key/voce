import React from "react";
import ReactDOM from "react-dom/client";
import "../i18n";
import { AssistieNotch } from "./notch";
import "../styles/theme.css";
import "./notch.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AssistieNotch />
  </React.StrictMode>,
);
