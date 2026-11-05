import type { ReactNode } from "react";
import { Check, Checks, Prohibit, X } from "@phosphor-icons/react";
import { t } from "../../i18n";
import { Marquee } from "../../notch/row/Marquee";
import { measureText } from "../../notch/row/measure";
import { NOTICE_BUTTON as BUTTON, NOTICE_BUTTON_PAD as PAD, NoticeButton } from "../../notch/row/NoticeButton";
import { AppIcon } from "./NoticePop";
import { optionLabel, type Ask } from "./asks";
import { answerAsk } from "./store";

const ICON = 16, GAP = 6, BUTTON_GAP = 4, NAME_MAX = 76, LABEL_MAX = 110;
/** The question's text gets at least this much, however many buttons there are. */
const TEXT_MIN = 80;

// The whole body on one line: a command is allowed as a whole, so none of its lines may stay hidden.
const askLine = (a: Ask) => [a.title, a.body.split("\n").map((l) => l.trim()).filter(Boolean).join(" ")].filter(Boolean).join(" · ");

/** A question in the closed notch: logo, source, the text scrolling, one button per option, and close (no choice). */
export function askNotice(a: Ask, max: number): { width: number; key: string; body: ReactNode } {
  const text = askLine(a), labels = a.options.map((o) => optionLabel(o, t));
  const nameW = Math.min(NAME_MAX, measureText(a.appName)), textW = measureText(text);
  const buttons = labels.reduce((w, l) => w + Math.min(LABEL_MAX, measureText(l)) + 2 * PAD + BUTTON_GAP, 0) + BUTTON;
  const fixed = ICON + GAP + nameW + GAP + GAP + buttons;
  const room = Math.max(TEXT_MIN, max - fixed);
  return {
    width: fixed + Math.min(textW, room),
    key: `ask:${a.id}`,
    body: (
      <span className="flex h-full items-center" style={{ gap: GAP }}>
        <AppIcon n={a} size={ICON} />
        <span className="truncate text-footnote font-medium text-label-2" style={{ width: nameW }}>{a.appName}</span>
        {/* Three laps, not `once`: the command has to be read before it is allowed. */}
        <Marquee text={text} textWidth={textW} width={Math.min(textW, room)} paused={false} />
        <span className="flex" style={{ gap: BUTTON_GAP }}>
          {a.options.map((o, i) => (
            <NoticeButton key={o} wide label={labels[i]} onClick={() => answerAsk(a.id, o)}>
              <span className="truncate text-footnote font-medium" style={{ maxWidth: LABEL_MAX }}>{labels[i]}</span>
            </NoticeButton>
          ))}
          <NoticeButton label={t("Schließen")} onClick={() => answerAsk(a.id, null)}>
            <X size={12} weight="bold" />
          </NoticeButton>
        </span>
      </span>
    ),
  };
}

function OptionIcon({ id, label }: { id: string; label: string }) {
  if (id === "allow") return <Check size={12} weight="bold" />;
  if (id === "always") return <Checks size={12} weight="bold" />;
  if (id === "deny") return <Prohibit size={12} weight="bold" />;
  return <span className="text-caption font-semibold">{label.slice(0, 1).toUpperCase()}</span>;
}

/** The column on a side edge has no room for text: the logo, then round buttons whose labels show as tooltips. */
export function askColumn(a: Ask): { w: number; h: number; draw: () => ReactNode } {
  const n = a.options.length + 1;
  return {
    w: BUTTON,
    h: ICON + n * (BUTTON + BUTTON_GAP),
    draw: () => (
      <span className="flex flex-col items-center" style={{ gap: BUTTON_GAP }} title={askLine(a)}>
        <AppIcon n={a} size={ICON} />
        {a.options.map((o) => {
          const label = optionLabel(o, t);
          return (
            <NoticeButton key={o} label={label} onClick={() => answerAsk(a.id, o)}>
              <OptionIcon id={o} label={label} />
            </NoticeButton>
          );
        })}
        <NoticeButton label={t("Schließen")} onClick={() => answerAsk(a.id, null)}>
          <X size={12} weight="bold" />
        </NoticeButton>
      </span>
    ),
  };
}
