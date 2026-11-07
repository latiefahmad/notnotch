import { createStore } from "./store";
import { settings } from "../settings/store";
import { build, fetchChangelog, updater, type ChangelogEntry, type UpdateHandle } from "../platform/services";

/*
 * Updates: check (anonymously, only the latest.json of the newest GitHub release), show the
 * version, download + install only on click. Signed: the app only installs updates with a
 * valid signature (key in tauri.conf.json → plugins.updater.pubkey).
 */

type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "error";

/** Why the last attempt failed: the check itself, the download and install, or the package's signature. */
type Failure = "check-failed" | "install-failed" | "signature";

export const update = createStore<{
  current: string | null;
  phase: Phase;
  /** New version, if available. */
  version: string | null;
  progress: number;
  checkedAt: number | null;
  /** Changelog of the new version (all versions, filtered in the UI); null = not loaded. */
  notes: ChangelogEntry[] | null;
  /** The Microsoft Store build: the Store updates it, so there is nothing to check here. */
  store: boolean;
  /** Why the last attempt failed (Copy diagnostics); null while it works. */
  error: Failure | null;
}>({ current: null, phase: "idle", version: null, progress: 0, checkedAt: null, notes: null, store: false, error: null });

let found: UpdateHandle | null = null;

export async function checkForUpdate() {
  // Store policy: the Store build never looks for updates anywhere else, not even on the automatic check.
  if ((await build.info()).store) return;
  const phase = update.get().phase;
  if (phase === "checking" || phase === "downloading") return;
  update.set((s) => ({ ...s, phase: "checking" }));
  try {
    found = await updater.check();
    const version = found?.version ?? null;
    const known = update.get();
    update.set((s) => ({ ...s, phase: found ? "available" : "current", version, checkedAt: Date.now(), error: null, notes: version === known.version ? s.notes : null }));
    if (version && (version !== known.version || !known.notes)) {
      void fetchChangelog(version).then((notes) => update.get().version === version && update.set((s) => ({ ...s, notes })));
    }
  } catch {
    found = null;
    update.set((s) => ({ ...s, phase: "error", error: "check-failed", checkedAt: Date.now() }));
  }
}

export async function installUpdate() {
  if (!found || update.get().phase !== "available") return;
  update.set((s) => ({ ...s, phase: "downloading", progress: 0, error: null }));
  try {
    // A portable copy in a folder it can't write only opened the download page: the update stays on offer.
    if ((await found.install((progress) => update.set((s) => ({ ...s, progress })))) === "page") update.set((s) => ({ ...s, phase: "available" }));
  } catch (e) {
    update.set((s) => ({ ...s, phase: "error", error: installFailure(e) }));
  }
}

/** The updater rejected the package's signature: it was signed with another key than the app accepts, and a retry cannot fix that. */
function installFailure(e: unknown): Failure {
  return /signature|minisign/i.test(String(e)) ? "signature" : "install-failed";
}

const DAY = 24 * 60 * 60 * 1000;

/** On start (slightly delayed to keep startup fast) and daily after that, if allowed. */
export function startUpdateWatch() {
  void updater.current().then((current) => update.set((s) => ({ ...s, current })));
  void build.info().then(({ store }) => update.set((s) => ({ ...s, store })));
  const auto = () => settings.get().updates.auto && void checkForUpdate();
  setTimeout(auto, 15_000);
  setInterval(auto, DAY);
}
