import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "../../../styles/global.css";
import { settings, type Settings } from "../../../settings/store";
import { TimerWindow } from "./TimerWindow";
import { language, startLanguage } from "../../../i18n";

/*
 * Entry of the detached timer window (timer.html). Loads only the timer, its settings and
 * the styles; the timer state follows the notch window through localStorage (see store.ts).
 */

// A new look picked in the notch settings shows here right away.
window.addEventListener("storage", (e) => {
  if (e.key !== "notch:settings" || !e.newValue) return;
  try {
    settings.set(JSON.parse(e.newValue) as Settings);
  } catch {
    // Broken entry: keep the current settings.
  }
});

// A window, not a web page: no browser menu, reload or print.
window.addEventListener("contextmenu", (e) => e.preventDefault());
// WebView2 would open a dropped file or link in this window; nothing can be dropped here.
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
});
window.addEventListener("drop", (e) => e.preventDefault());
window.addEventListener("keydown", (e) => {
  if (e.key === "F5" || e.key === "F7" || e.key === "F12" || (e.ctrlKey && ["r", "p", "f", "j", "u", "s"].includes(e.key.toLowerCase()))) e.preventDefault();
});

/** Re-renders on a language change, as the notch's root does. */
function App() {
  language.use();
  return (
    <MotionConfig reducedMotion="user">
      <TimerWindow />
    </MotionConfig>
  );
}

void startLanguage(settings).then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
