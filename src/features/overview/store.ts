import { createStore } from "../../lib/store";
import { keepAwake } from "../../platform/services";
import { awakeStart, type Awake } from "./awake";

/** Keep awake; never saved, so NotNotch always starts with it off. */
export const awake = createStore<Awake>(null);

let ends: number | undefined;

/** On for `minutes` (null = until turned off). The backend ends a timed one by itself; this only follows. */
export function startAwake(minutes: number | null) {
  const next = awakeStart(minutes, Date.now());
  awake.set(next);
  window.clearTimeout(ends);
  if (next?.endsAt != null) ends = window.setTimeout(() => awake.set(null), next.endsAt - Date.now());
  void keepAwake(true, minutes).catch(() => stopAwake());
}

export function stopAwake() {
  window.clearTimeout(ends);
  awake.set(null);
  void keepAwake(false, null).catch(() => {});
}

// A reloaded page starts off, so the backend must too.
void keepAwake(false, null).catch(() => {});
