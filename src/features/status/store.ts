import { createStore } from "../../lib/store";
import { status, type StatusSeed } from "../../platform/services";
import { settings } from "../../settings/store";
import { focusMode } from "../../notch/focus";
import { fullscreen } from "../system/gaming";
import { t } from "../../i18n";
import { STATUS, btAlert, levelAlert, lockAlert, netAlert, osdHidden, powerAlert, mergeSeed, type LowBattery, type PowerState, type StatusAlert } from "../../notch/row/status";

/** The status alert on screen, for STATUS.showMs; a new one replaces it. */
export const statusAlert = createStore<StatusAlert | null>(null);

let started = false;

/** Listens to sysevents.rs from the seed on and turns each change into an alert by the rules in status.ts. */
export function startStatusWatch() {
  if (started) return;
  started = true;
  let power: PowerState | null = null, online: boolean | null = null, hide = 0;
  const low: LowBattery = { warned20: false, warned10: false };
  // Bluetooth devices connected now: one already there (from the seed) does not alert when reported again.
  let devices = new Set<string>();
  const show = (alert: StatusAlert | null, on: boolean) => {
    // Not in focus mode nor over a fullscreen app; dropped rather than kept for later.
    if (!alert || !on || focusMode.get() || fullscreen.get()) return;
    statusAlert.set(alert);
    clearTimeout(hide);
    hide = window.setTimeout(() => statusAlert.set(null), STATUS.showMs);
  };
  // The command and the event may both deliver it, and the command can return a partial one while sysevents.rs still registers.
  const seed = (s: StatusSeed) => {
    if (s.power && !power) powerAlert(null, s.power, low, t);
    ({ power, online, devices } = mergeSeed({ power, online, devices }, s));
  };
  status.on({
    seed,
    power: (next) => {
      const alert = powerAlert(power, next, low, t);
      power = next;
      show(alert, settings.get().closed.statusAlerts.power);
    },
    net: (next) => {
      const alert = netAlert(online, next, t);
      online = next;
      show(alert, settings.get().closed.statusAlerts.net);
    },
    bt: (e) => {
      const known = devices.has(e.name);
      if (e.connected) devices.add(e.name);
      else devices.delete(e.name);
      if (e.connected && known) return;
      show(btAlert(e, t), settings.get().closed.statusAlerts.bt);
    },
    level: (e) => show(levelAlert(e, t), settings.get().closed.statusAlerts[e.kind]),
    lock: (e) => show(lockAlert(e, t), settings.get().closed.statusAlerts.lock),
  });
  void status.seed().then(seed, () => {});
  // Tells Rust what to read and whether to hide the Windows indicator; sent again only when that changes.
  let sent = "";
  const configure = () => {
    const alerts = settings.get().closed.statusAlerts;
    const c = { ddc: alerts.brightness, locks: alerts.lock, hideOsd: osdHidden(alerts, focusMode.get(), fullscreen.get()) };
    if (JSON.stringify(c) === sent) return;
    sent = JSON.stringify(c);
    status.configure(c);
  };
  settings.subscribe(configure);
  focusMode.subscribe(configure);
  fullscreen.subscribe(configure);
  configure();
}
