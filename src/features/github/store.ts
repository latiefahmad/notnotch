import { useEffect } from "react";
import { createStore } from "../../lib/store";
import { rowVisible } from "../../notch/row/visibility";
import { fetchGithub, type GithubContributions } from "../../platform/services";
import { settings } from "../../settings/store";

/** Rust caches for an hour; asking more often would only return the cache. */
const POLL_MS = 3_600_000;

/** Calendar shared by the GitHub tool and the closed-row part; `error` is a code from Rust. */
export const github = createStore<{ data: GithubContributions | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });

const viewers = createStore(0);
let timer: ReturnType<typeof setInterval> | null = null;
let timerUser = "";
let latest = 0;
/** The user the last request was for: a different one is always fetched at once. */
let askedUser = "";
/** One retry a few minutes after an error, then the hourly poll takes over again. */
const RETRY_MS = 4 * 60_000;
let retry: ReturnType<typeof setTimeout> | null = null;
let retried = false;

export function refreshGithub(force = false): Promise<void> {
  const call = ++latest, user = settings.get().github.user.trim();
  askedUser = user.toLowerCase();
  github.set((g) => ({ ...g, loading: true }));
  return fetchGithub(user, force).then(
    (data) => {
      if (call !== latest) return;
      retried = false;
      github.set({ data, error: null, loading: false });
    },
    (e) => {
      if (call !== latest) return;
      // Keep the last calendar on a passing error (offline); drop it when the user or token is wrong.
      const drop = e === "not-found" || e === "no-user" || e === "token-rejected";
      github.set((g) => ({ data: drop ? null : g.data, error: String(e), loading: false }));
      if (!retried && !retry && e !== "no-user") {
        retried = true;
        retry = setTimeout(() => {
          retry = null;
          if (wanted()) void refreshGithub();
        }, RETRY_MS);
      }
    },
  );
}

function wanted(): boolean {
  const s = settings.get();
  return !!s.github.user.trim() && ((s.closed.parts.github && rowVisible.get()) || viewers.get() > 0);
}

function apply() {
  const user = settings.get().github.user.trim();
  if (!wanted()) {
    if (timer) clearInterval(timer);
    timer = null;
    if (retry) clearTimeout(retry);
    retry = null;
    if (!user && (github.get().data || github.get().error)) {
      latest++;
      askedUser = "";
      github.set({ data: null, error: null, loading: false });
    }
    return;
  }
  if (timer && timerUser === user) return;
  if (timer) clearInterval(timer);
  const { data, loading } = github.get();
  if (askedUser !== user.toLowerCase()) {
    // Another user: never show the old one's calendar, and do not wait for a request still running for it.
    retried = false;
    github.set({ data: null, error: null, loading: false });
    void refreshGithub();
  } else if (!loading && (!data || Date.now() - data.fetchedAt >= POLL_MS)) void refreshGithub();
  timer = setInterval(() => void refreshGithub(), POLL_MS);
  timerUser = user;
}
export function startGithub() {
  apply();
  settings.subscribe(apply);
  rowVisible.subscribe(apply);
  viewers.subscribe(apply);
}

/** For views that show the calendar: polling while mounted. */
export function useGithubViewer() {
  useEffect(() => {
    viewers.set((n) => n + 1);
    return () => viewers.set((n) => n - 1);
  }, []);
}
