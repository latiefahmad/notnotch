import { settings } from "../../settings/store";
import type { Hue } from "./themes";

export type { Hue };

/**
 * Icon colours for "Coloured icons" (Settings, Themes): the tool bar, the settings pages, the weather and the Hardware tool.
 * Each hue is a CSS variable the active theme sets (HUE_PALETTE in themes.ts), held to 3:1 on its backgrounds.
 */

export const hueVar = (hue: Hue) => `var(--hue-${hue})`;

export const useIconColors = () => settings.use().themes.iconColors;

/** The icon's colour while coloured icons are on, else undefined (the icon keeps its text colour). */
export function useHue(hue: Hue | undefined): string | undefined {
  const on = useIconColors();
  return on && hue ? hueVar(hue) : undefined;
}
