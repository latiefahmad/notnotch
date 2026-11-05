// Copy diagnostics (Settings, General): a plain-text block for bug reports. Every field is a version, an enumerated
// setting or a short error code; nothing names the user, the PC, a path, an account, a key or a place.

export interface Diagnostics {
  version: string;
  build: "installer" | "portable" | "store";
  /** Windows edition ("Windows 11 Home") and build number, from Rust (sysinfo). */
  os: string | null;
  osBuild: string | null;
  /** The architecture this build was made for, and the PC's own (they differ when an x64 build runs emulated on ARM). */
  arch: string;
  machine: string | null;
  /** Windows scale of each monitor, 1 = 100 %. */
  scales: number[];
  /** Panel scale from Settings, Window, in percent. */
  panelScale: number;
  tools: string[];
  closedStyle: string;
  edge: string;
  anchor: string;
  /** Where an error was seen and its code, as the stores hold them (only code-like values are kept). */
  errors: [string, string | null][];
}

/** The codes Rust reports (github.rs, fps.rs) and the update check's own. */
const KNOWN = new Set(["check-failed", "not-found", "no-user", "token-rejected", "rate-limited", "failed", "no-admin", "relogin"]);

/** A tracked error as a known code; anything else (free text from a server, a message with a path) becomes "other". */
export function errorCode(value: string | null): string | null {
  if (!value) return null;
  return KNOWN.has(value) ? value : "other";
}

const percent = (scale: number) => `${Math.round(scale * 100)} %`;

export function diagnosticsText(d: Diagnostics): string {
  const errors = d.errors.flatMap(([where, code]) => {
    const c = errorCode(code);
    return c ? [`${where} ${c}`] : [];
  });
  const lines = [
    "NotNotch diagnostics",
    `App: ${d.version} (${d.build}, ${d.arch})`,
    `Windows: ${d.os ?? "unknown"}, build ${d.osBuild ?? "unknown"}, PC ${d.machine ?? "unknown"}`,
    `Monitors: ${d.scales.length} (${d.scales.map(percent).join(", ") || "none"})`,
    `Panel scale: ${d.panelScale} %`,
    `Tools: ${d.tools.join(", ") || "none"}`,
    `Closed: ${d.closedStyle}, edge ${d.edge} (${d.anchor})`,
    `Errors: ${errors.join("; ") || "none"}`,
  ];
  // Last line of defence: no field should hold a path, but a drive or user-folder path never leaves.
  return `${lines.join("\n").replace(/[A-Za-z]:[\\/][^\s,;()]*/g, "<path>").replace(/\\\\[^\s,;()]+/g, "<path>")}\n`;
}
