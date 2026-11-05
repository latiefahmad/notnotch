import { createStore } from "../../lib/store";
import { holdOpen } from "../../notch/useNotchState";
import { pluginApi, type StagedPlugin } from "../../platform/services";
import { settings, updateSettings } from "../../settings/store";
import { toolId, type PluginManifest } from "./model";

/*
 * Installed plugins, as Rust read them from disk. Each is a tool `plugin:<id>` in the tool list, so the tool bar and
 * its order work as for any tool; installing switches it on, removing takes it out of the list.
 */
export const plugins = createStore<PluginManifest[]>([]);

/** The install in progress: picking, reading, waiting for the user's yes (with what was staged), or the last error code. */
export const install = createStore<{ phase: "idle" | "busy" | "confirm"; staged: StagedPlugin | null; error: string | null }>({ phase: "idle", staged: null, error: null });

export async function refreshPlugins() {
  // A failed read is not "no plugins": syncing on it would drop every plugin tool and add them back switched off.
  const list = await pluginApi.list().catch(() => null);
  if (!list) return;
  plugins.set(list);
  const ids = new Set(list.map((m) => toolId(m.id)));
  const tools = settings.get().tools;
  const stale = tools.some((x) => x.id.startsWith("plugin:") && !ids.has(x.id));
  const missing = [...ids].filter((id) => !tools.some((x) => x.id === id));
  if (!stale && !missing.length) return;
  updateSettings((cur) => ({
    tools: [...cur.tools.filter((x) => !x.id.startsWith("plugin:") || ids.has(x.id)), ...missing.map((id) => ({ id, enabled: false }))],
  }));
}

/** Picks a folder or .zip and stages it; the settings then show its manifest and permissions for a yes or no. */
export async function pickPlugin(zip: boolean) {
  if (install.get().phase !== "idle") return;
  install.set({ phase: "busy", staged: null, error: null });
  // The picker takes the pointer off the notch; it stays open meanwhile.
  holdOpen(true);
  try {
    const path = await pluginApi.pick(zip);
    if (!path) return install.set({ phase: "idle", staged: null, error: null });
    install.set({ phase: "confirm", staged: await pluginApi.stage(path), error: null });
  } catch (e) {
    install.set({ phase: "idle", staged: null, error: String(e) });
  } finally {
    holdOpen(false);
  }
}

export async function confirmInstall() {
  const staged = install.get().staged;
  if (!staged) return;
  install.set({ phase: "busy", staged: null, error: null });
  try {
    const m = await pluginApi.commit(staged.token);
    await refreshPlugins();
    setPluginEnabled(m.id, true);
    install.set({ phase: "idle", staged: null, error: null });
  } catch (e) {
    install.set({ phase: "idle", staged: null, error: String(e) });
  }
}

export function cancelInstall() {
  const staged = install.get().staged;
  if (staged) void pluginApi.discard(staged.token);
  install.set({ phase: "idle", staged: null, error: null });
}

export function setPluginEnabled(id: string, enabled: boolean) {
  const tool = toolId(id);
  updateSettings((cur) => ({
    tools: cur.tools.some((x) => x.id === tool) ? cur.tools.map((x) => (x.id === tool ? { ...x, enabled } : x)) : [...cur.tools, { id: tool, enabled }],
  }));
}

/** Removes the plugin's files and its storage. */
export async function removePlugin(id: string) {
  try {
    await pluginApi.remove(id);
    install.set((s) => ({ ...s, error: null }));
  } catch (e) {
    install.set((s) => ({ ...s, error: String(e) }));
  }
  await refreshPlugins();
}

export function startPlugins() {
  void refreshPlugins();
}
