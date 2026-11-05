import { AnimatePresence, motion } from "motion/react";
import { springs } from "../../design/motion";
import { t } from "../../i18n";
import { settings } from "../../settings/store";
import { discordState } from "../discord/store";
import { privacy } from "./store";

/** Dot size and the space between two dots. */
const DOT = 6, DOT_GAP = 5;
export const dotsWidth = (n: number) => (n > 0 ? n * DOT + (n - 1) * DOT_GAP : 0);

/** The dots on now: red = screen recorded or streamed, green = mic or camera in use (call, Discord). Empty while the setting is off. */
export function usePrivacyDots(): ("red" | "green")[] {
  const enabled = settings.use().privacyDots;
  const p = privacy.use();
  const call = discordState.use().call;
  const talk = p.mic || p.camera || (!!call && !call.mute);
  return enabled ? [p.screen && ("red" as const), talk && ("green" as const)].filter((d): d is "red" | "green" => !!d) : [];
}

/** Dots like on iPhone, in a row. While you talk in a Discord call, the green dot glows. */
export function Dots({ dots }: { dots: ("red" | "green")[] }) {
  const call = discordState.use().call;
  return (
    <div className="pointer-events-none flex items-center" style={{ gap: DOT_GAP }}>
      <AnimatePresence>
        {dots.map((color) => (
          <motion.span
            key={color}
            className="privacy-dot shrink-0 rounded-full"
            title={color === "red" ? t("Bildschirm wird aufgenommen") : t("Mikrofon oder Kamera aktiv")}
            data-pulse={color === "green" && call?.speaking ? true : undefined}
            style={{ width: DOT, height: DOT, backgroundColor: `var(--color-${color})`, ["--dot" as string]: `var(--color-${color})` }}
            initial={{ opacity: 0, transform: "scale(0.9)" }}
            animate={{ opacity: 1, transform: "scale(1)" }}
            exit={{ opacity: 0, transform: "scale(0.9)" }}
            transition={springs.snappy}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

/** The open notch: the dots a bit right of the imagined camera in the middle, clear of the header's title and buttons. Closed, the row shows them at its end.
 *  `centered`: in the middle of the shape (the dimmed column on a side edge is too narrow for the offset). */
export function PrivacyDots({ centered = false }: { centered?: boolean }) {
  const dots = usePrivacyDots();
  return (
    <div
      className={`pointer-events-none absolute flex items-center ${centered ? "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" : "top-0 left-1/2 ml-[24px] h-[30px]"}`}
    >
      <Dots dots={dots} />
    </div>
  );
}
