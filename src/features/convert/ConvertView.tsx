import { AnimatePresence, motion } from "motion/react";
import { content } from "../../design/motion";
import { Segmented } from "../../ui/controls";
import { UnitsPanel } from "./units";
import { CurrencyPanel } from "./currency";
import { HeaderActions } from "../../notch/header";
import { t } from "../../i18n";
import { createStore } from "../../lib/store";

type Mode = "units" | "currency";

/** Units or currency, as last left: the tool opens there again. */
const lastMode = createStore<Mode>("units", { persist: "convert-mode" });

export function ConvertView() {
  const mode = lastMode.use() === "currency" ? "currency" : "units";
  const setMode = (m: Mode) => lastMode.set(m);
  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-1">
      <HeaderActions>
        <Segmented
          id="convert-mode"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "units", label: t("Einheiten") },
            { value: "currency", label: t("Währung") },
          ]}
        />
      </HeaderActions>
      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={mode}
            className="absolute inset-0"
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          >
            {mode === "units" ? <UnitsPanel /> : <CurrencyPanel />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
