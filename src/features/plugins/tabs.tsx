import { PuzzlePiece } from "@phosphor-icons/react";
import type { NotchTab } from "../../notch/tabs";
import { iconFor } from "./icons";
import { pluginOf, toolId, type PluginManifest } from "./model";
import { PluginView } from "./PluginView";
import { plugins } from "./store";

/** One tab object per installed version, so the dock and the panel keep the same component (and the frame is not reloaded) between renders. */
const cache = new Map<string, { manifest: PluginManifest; tab: NotchTab }>();

/** The tool for `plugin:<id>` while that plugin is installed. */
export function pluginTab(tool: string): NotchTab | undefined {
  const id = pluginOf(tool);
  const m = id ? plugins.get().find((p) => p.id === id) : undefined;
  if (!m) return undefined;
  const hit = cache.get(tool);
  if (hit && hit.manifest === m) return hit.tab;
  const View = () => <PluginView manifest={m} />;
  const tab: NotchTab = { id: toolId(m.id), label: m.name, icon: iconFor(m.icon) ?? PuzzlePiece, size: m.size, View };
  cache.set(tool, { manifest: m, tab });
  return tab;
}
