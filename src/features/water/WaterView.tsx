import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ArrowCounterClockwise, Drop, GearSix } from "@phosphor-icons/react";
import { springs } from "../../design/motion";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { settings } from "../../settings/store";
import { formatTime } from "../../lib/format";
import { t } from "../../i18n";
import { hourly, nextWaterAlert, progress, todayTotal } from "./water";
import { water, waterActions, waterDue } from "./store";
import { formatMl } from "./format";

const CHART_H = 64;

/*
 *  1.25 L / 2 L                          [↺] [+ Drink 500 ml]
 *  63 % · next reminder 15:30
 *  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────────
 *  ▁ ▃ ▅   █ ▂ ▁                     ← ml per hour today
 *  09    12    15    18    21
 */
export function WaterView() {
  const { log, lastAt } = water.use();
  const cfg = settings.use().productivity.water;
  const due = waterDue.use();
  const now = useNow();
  const total = todayTotal(log, now);
  const p = progress(total, cfg.goalMl);
  const next = nextWaterAlert(now, lastAt, cfg, log);
  const bars = hourly(log, now, cfg);
  const peak = Math.max(cfg.bottleMl, ...bars.map((b) => b.ml));
  const hourNow = new Date(now).getHours();

  const status = total >= cfg.goalMl
    ? t("Ziel erreicht")
    : !cfg.remind
      ? t("Erinnerungen aus")
      : due
        ? t("Zeit zu trinken")
        : next !== null
          ? t("Nächste Erinnerung {time}", { time: formatTime(next) })
          : "";

  return (
    <div className="flex h-full flex-col gap-2.5 px-4 pt-1 pb-3">
      <HeaderActions>
        <HeaderButton label={t("Einstellungen")} onClick={() => navigate("settings", "water")}>
          <GearSix size={14} weight="bold" />
        </HeaderButton>
      </HeaderActions>

      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="tabular text-display font-semibold text-label">
            {formatMl(total)} <span className="text-title font-medium text-label-3">/ {formatMl(cfg.goalMl)}</span>
          </div>
          <div className="tabular mt-0.5 truncate text-footnote text-label-3">
            {Math.round(p * 100)} % · {status}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <HeaderButton label={t("Letzten Eintrag zurücknehmen")} disabled={total === 0} onClick={waterActions.undo}>
            <ArrowCounterClockwise size={14} weight="bold" />
          </HeaderButton>
          <button onClick={() => waterActions.drink()} className="pressable flex h-8 items-center gap-1.5 rounded-full bg-link px-3.5 text-footnote font-semibold text-black">
            <Drop size={14} weight="fill" /> {t("Trinken")} · {formatMl(cfg.bottleMl)}
          </button>
        </div>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-fill-2">
        <motion.div className="h-full origin-left rtl:origin-right rounded-full bg-link" initial={false} animate={{ transform: `scaleX(${p})` }} transition={springs.snappy} />
      </div>

      <div className="flex flex-1 flex-col justify-end">
        <div className="flex items-end gap-1" style={{ height: CHART_H }} role="img" aria-label={t("Getrunken pro Stunde")}>
          {bars.map((b) => (
            <div key={b.hour} className="flex h-full flex-1 flex-col justify-end" title={`${String(b.hour).padStart(2, "0")}:00 · ${formatMl(b.ml)}`}>
              <div
                className={`w-full rounded-[3px] ${b.ml > 0 ? "bg-link" : b.hour === hourNow ? "bg-fill-3" : "bg-fill-2"}`}
                style={{ height: b.ml > 0 ? Math.max(4, (b.ml / peak) * CHART_H) : 3 }}
              />
            </div>
          ))}
        </div>
        <div className="tabular mt-1 flex gap-1 text-caption text-label-3">
          {bars.map((b, i) => (
            <span key={b.hour} className="flex-1 text-center">
              {i % 3 === 0 ? String(b.hour).padStart(2, "0") : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
