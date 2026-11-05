import type { TaskColor } from "./model";

const VARS: Record<TaskColor, string> = {
  red: "var(--color-red)",
  orange: "var(--color-orange)",
  yellow: "var(--color-yellow)",
  green: "var(--color-green)",
  blue: "var(--color-link)",
};

export const colorVar = (c: TaskColor | null): string | null => (c ? VARS[c] : null);
