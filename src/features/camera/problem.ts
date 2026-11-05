/** Why the camera shows no picture. */
export type CameraProblem = "none" | "denied" | "busy" | "other";

/** Sorts a getUserMedia failure by its DOMException name (older names from Chromium included). */
export function cameraProblem(error: unknown): CameraProblem {
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "none";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return "denied";
  // Windows lets one app hold a camera at a time; WebView2 reports the others as unreadable.
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "other";
}
