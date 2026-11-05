import { openOn } from "../../nav";
import { settings } from "../../../settings/store";
import { iconFor } from "../../../features/plugins/icons";
import type { ScriptPart } from "../../../features/notices/scriptParts";
import { measureText } from "../measure";

const ICON = 14, GAP = 4, BAR = 22, MAX = 140, SPACE = 10;

const itemWidth = (p: ScriptPart) => {
  const pieces = [iconFor(p.icon) ? ICON : 0, p.text ? Math.min(MAX, measureText(p.text)) : 0, p.progress !== null ? BAR : 0].filter((w) => w > 0);
  return pieces.reduce((a, b) => a + b, 0) + GAP * Math.max(0, pieces.length - 1);
};

/** Room for every custom part side by side. */
export const scriptPartsWidth = (parts: ScriptPart[]) => parts.reduce((w, p, i) => w + (i ? SPACE : 0) + itemWidth(p), 0);

/** The parts scripts set with `notnotch-notify part`: icon, text and a small progress bar each. A part that names an enabled tool opens it on click. */
export function ScriptParts({ parts }: { parts: ScriptPart[] }) {
  return (
    <span className="flex items-center whitespace-nowrap text-footnote font-medium text-label" style={{ gap: SPACE }}>
      {parts.map((p) => (
        <Item key={p.id} part={p} />
      ))}
    </span>
  );
}

function Item({ part: p }: { part: ScriptPart }) {
  const I = iconFor(p.icon);
  const body = (
    <>
      {I && <I size={ICON} weight="bold" className="shrink-0" />}
      {p.text && <span className="truncate" style={{ maxWidth: MAX }}>{p.text}</span>}
      {p.progress !== null && (
        <span className="relative h-[3px] shrink-0 overflow-hidden rounded-full bg-fill-3" style={{ width: BAR }}>
          <span className="absolute inset-y-0 left-0 rounded-full bg-label" style={{ width: `${p.progress}%` }} />
        </span>
      )}
    </>
  );
  const target = p.open && settings.get().tools.some((x) => x.id === p.open && x.enabled) ? p.open : null;
  if (!target) return <span className="flex items-center" style={{ gap: GAP, width: itemWidth(p) }} title={p.source}>{body}</span>;
  return (
    <button className="pointer-events-auto flex items-center" style={{ gap: GAP, width: itemWidth(p) }} title={p.source} onClick={() => openOn(target)}>
      {body}
    </button>
  );
}
