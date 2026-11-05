import { createStore } from "../../lib/store";
import { settings, updateSettings } from "../../settings/store";
import { nextWaterAlert, prune, undoLast, type Drink, type WaterConfig } from "./water";

interface WaterState {
  log: Drink[];
  /** Last drink or dismissed reminder; the next reminder counts from here. */
  lastAt: number | null;
}

export const water = createStore<WaterState>({ log: [], lastAt: null }, { persist: "water" });
// A broken or foreign entry becomes an empty log rather than NaN totals.
water.set((s) => ({
  log: Array.isArray(s?.log) ? prune(s.log.filter((d) => Number.isFinite(d?.at) && Number.isFinite(d?.ml)), Date.now()) : [],
  lastAt: Number.isFinite(s?.lastAt) ? s.lastAt : null,
}));

/** A reminder is showing. Set by the scheduler; false while the Water tool or its reminders are off. */
export const waterDue = createStore(false);

export const waterActions = {
  drink(ml = settings.get().productivity.water.bottleMl) {
    const now = Date.now();
    water.set((s) => ({ log: prune([...s.log, { at: now, ml, prev: s.lastAt }], now), lastAt: now }));
  },
  /** Takes back today's last drink (a click by mistake). */
  undo: () => water.set((s) => undoLast(s.log, s.lastAt, Date.now())),
  /** Hides the reminder until the next interval. */
  dismiss: () => water.set((s) => ({ ...s, lastAt: Date.now() })),
  setConfig(patch: Partial<WaterConfig>) {
    // Turning reminders on starts counting now, so the first one does not show at once.
    if (patch.remind && !settings.get().productivity.water.remind) water.set((s) => ({ ...s, lastAt: Date.now() }));
    updateSettings((cur) => ({ productivity: { ...cur.productivity, water: { ...cur.productivity.water, ...patch } } }));
  },
};

// One timeout to the next reminder (at most a minute, for standby and midnight), none while it shows or is off.
let timeout: number | undefined;
function check() {
  window.clearTimeout(timeout);
  const now = Date.now();
  const s = settings.get();
  const cfg = s.productivity.water;
  const on = s.tools.some((t) => t.id === "water" && t.enabled);
  const { log, lastAt } = water.get();
  const next = on ? nextWaterAlert(now, lastAt, cfg, log) : null;
  const due = next !== null && next <= now;
  if (due !== waterDue.get()) waterDue.set(due);
  if (next !== null && !due) timeout = window.setTimeout(check, Math.min(60_000, next - now) + 20);
}

export function startWaterReminders() {
  water.subscribe(check);
  settings.subscribe(check);
  check();
}
