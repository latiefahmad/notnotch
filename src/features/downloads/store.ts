import { createStore } from "../../lib/store";
import { downloadWatch, type DownloadFinished, type DownloadProgress } from "../../platform/services";
import { settings } from "../../settings/store";
import { presentingNow } from "../privacy/store";
import { inQuiet } from "../notices/rules";

/*
 * Downloads in the Downloads folder (downloads.rs): the ones running, for the closed row's Downloads part, and the one just
 * finished, for its notice. Rust watches only while the part or the notice is on.
 */

/** How long the finished notice stays. */
export const DOWNLOAD_SHOW_MS = 6000;

export const downloads = createStore<DownloadProgress[]>([]);
export const finishedDownload = createStore<(DownloadFinished & { at: number }) | null>(null);

let hideTimer: number | undefined;

export function dismissDownload() {
  window.clearTimeout(hideTimer);
  finishedDownload.set(null);
}

function finished(d: DownloadFinished) {
  const { closed, notices } = settings.get();
  const now = new Date();
  // The notices' quiet hours and presentation mode keep it quiet: a file name can be private.
  if (!closed.downloadAlerts || presentingNow() || (notices.quiet.on && inQuiet(now.getHours() * 60 + now.getMinutes(), notices.quiet.from, notices.quiet.to))) return;
  finishedDownload.set({ ...d, at: Date.now() });
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => finishedDownload.set(null), DOWNLOAD_SHOW_MS);
}

export function startDownloads() {
  downloadWatch.on((list) => downloads.set(list), finished);
  let last: boolean | null = null;
  const apply = () => {
    const c = settings.get().closed;
    const on = c.parts.downloads || c.downloadAlerts;
    if (on === last) return;
    last = on;
    downloadWatch.configure(on);
    if (!on) {
      downloads.set([]);
      dismissDownload();
    }
  };
  apply();
  settings.subscribe(apply);
}
