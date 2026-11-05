import { DownloadSimple } from "@phosphor-icons/react";
import type { DownloadProgress } from "../../../platform/services";
import { formatBytes } from "../../../lib/format";
import { rate } from "../../../features/system/format";
import { measureText } from "../measure";

const ICON = 14, GAP = 4;

/** "124 MB · 8.2 MB/s"; with more downloads their count first and the sums. */
export function downloadsCaption(list: DownloadProgress[]): string {
  const size = list.reduce((a, d) => a + d.size, 0), speed = rate(list.reduce((a, d) => a + d.speed, 0));
  const text = `${formatBytes(size, size >= 1024 ** 3 ? 1 : 0)} · ${speed.n} ${speed.unit}`;
  return list.length > 1 ? `${list.length} · ${text}` : text;
}

/** Measured with zeros, so the width only changes when a digit is added, not every second. */
export const downloadsWidth = (caption: string) => ICON + GAP + measureText(caption.replace(/\d/g, "0"));

/** Downloads in progress: an icon, the size so far and the speed; the names in the tooltip. */
export function DownloadsPart({ list, caption }: { list: DownloadProgress[]; caption: string }) {
  return (
    <span className="flex items-center whitespace-nowrap text-footnote font-medium text-label" style={{ gap: GAP }} title={list.map((d) => d.name).filter(Boolean).join("\n")}>
      <DownloadSimple size={ICON} weight="bold" className="shrink-0" />
      <span className="tabular">{caption}</span>
    </span>
  );
}
