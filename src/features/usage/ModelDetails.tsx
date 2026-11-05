// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck/ModelDetails.cs (table layout: input, cache write, cache read, output, total, cost).
import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { PencilSimple, Table } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import { settings, updateSettings } from "../../settings/store";
import { BrandLogo } from "../../ui/brands";
import { Button, Empty, Segmented, Skeleton, TextField } from "../../ui/controls";
import { locale, t } from "../../i18n";
import { findPrices, normalizeModel, validPrices, type Prices } from "./pricing";
import { byModel, dayStart, sumRows, type ModelRow, type TokenReport, type Totals } from "./tokens";
import { formatCost, formatTokens } from "./format";

type Range = "1" | "7" | "30";
const ranges: { value: Range; label: string }[] = [
  { value: "1", label: "Heute" },
  { value: "7", label: "7 Tage" },
  { value: "30", label: "30 Tage" },
];
const toolNames = { claude: "Claude Code", codex: "Codex" } as const;

// Kept while the notch is open, like the settings page.
let savedRange: Range = "7";
let savedTools: string[] = ["claude", "codex"];

const COLS = "grid grid-cols-[minmax(0,1fr)_repeat(5,58px)_70px] items-center gap-x-2";

/** Tokens and cost per model from the local logs, by tool and date range. Clicking a cost sets that model's price by hand. */
export function ModelDetails({ state }: { state: { report: TokenReport | null; loading: boolean; failed: boolean } }) {
  const manual = settings.use().aiUsage.prices;
  const [range, setRangeState] = useState<Range>(savedRange);
  const [tools, setToolsState] = useState(() => new Set(savedTools));
  const [editing, setEditing] = useState<string | null>(null);
  const report = state.report;

  const setRange = (r: Range) => setRangeState((savedRange = r));
  const toggleTool = (id: string) =>
    setToolsState((cur) => {
      const next = new Set(cur);
      if (next.has(id) && next.size > 1) next.delete(id);
      else next.add(id);
      savedTools = [...next];
      return next;
    });

  if (!report) {
    if (state.failed) return <Empty icon={Table} title={t("Protokolle nicht lesbar")} />;
    return (
      <div className="flex flex-col gap-2 px-4 pt-3">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-4 w-full" />)}
        <span className="text-caption text-label-3">{t("Lese die Protokolle …")}</span>
      </div>
    );
  }
  if (!report.tools.some((x) => x.found)) {
    return <Empty icon={Table} title={t("Keine Protokolle auf diesem PC")} text={t("Claude Code und die Codex CLI legen ihre Protokolle unter ~/.claude und ~/.codex ab.")} />;
  }

  const from = dayStart(Date.now(), Number(range) - 1);
  const rows = byModel(report, tools, from, manual);
  const total = sumRows(rows);
  const shown = report.tools.filter((x) => tools.has(x.id));
  const files = shown.reduce((n, x) => n + x.files, 0);
  const unreadable = shown.reduce((n, x) => n + x.unreadable, 0);

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-2">
      <div className="mb-2 flex items-center gap-2">
        <Segmented id="usage-range" size="sm" value={range} onChange={setRange} options={ranges.map((r) => ({ ...r, label: t(r.label) }))} />
        <div className="flex gap-1">
          {report.tools.map((x) => (
            <button
              key={x.id}
              aria-pressed={tools.has(x.id)}
              onClick={() => toggleTool(x.id)}
              className={`pressable flex h-6 items-center gap-1 rounded-full px-2 text-caption font-medium transition-colors ${tools.has(x.id) ? "bg-fill-3 text-label" : "bg-fill-1 text-label-3 hover:text-label-2"}`}
            >
              <BrandLogo id={x.id} size={11} />
              {toolNames[x.id]}
            </button>
          ))}
        </div>
      </div>

      <div className={`${COLS} border-b border-separator pb-1 text-caption text-label-3`}>
        <span>{t("Modell")}</span>
        {["Eingabe", "Cache schreiben", "Cache lesen", "Ausgabe", "Tokens"].map((h) => (
          <span key={h} className="truncate text-end" title={t(h)}>
            {t(h)}
          </span>
        ))}
        <span className="text-end">{t("Kosten · USD")}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">
        {rows.length === 0 ? (
          <div className="py-6 text-center text-caption text-label-3">{t("Keine Tokens in diesem Zeitraum")}</div>
        ) : (
          rows.map((r, i) => {
            const key = `${r.tool}\n${r.model}`;
            return (
              <motion.div key={key} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ ...content.enter, delay: Math.min(i, 8) * 0.02 }}>
                <Line
                  totals={r}
                  label={
                    <span className="flex min-w-0 items-center gap-1.5">
                      <BrandLogo id={r.tool} size={11} className="shrink-0 text-label-3" />
                      <span className="truncate text-label" title={r.model}>{r.model}</span>
                      {manual[normalizeModel(r.model)] && <span className="shrink-0 rounded-full bg-fill-2 px-1 text-[10px] text-label-3">{t("eigener Preis")}</span>}
                    </span>
                  }
                  onCost={() => setEditing(editing === key ? null : key)}
                />
                {editing === key && <PriceEditor row={r} manual={manual} onDone={() => setEditing(null)} />}
              </motion.div>
            );
          })
        )}
      </div>

      {rows.length > 0 && <Line totals={total} label={<span className="font-semibold text-label">{t("Summe")}</span>} strong />}
      <div className="line-clamp-2 pt-1 text-caption text-label-4">
        {[
          t("API-Listenpreise, geschätzt aus den Protokollen auf diesem PC"),
          tools.has("codex") ? t("Neuere GPT-Modelle brauchen einen eigenen Preis") : "",
          t("{n} Dateien", { n: files }),
          unreadable > 0 ? t("{n} Zeilen nicht lesbar", { n: unreadable }) : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </div>
  );
}

function Line({ totals: x, label, onCost, strong }: { totals: Totals; label: ReactNode; onCost?: () => void; strong?: boolean }) {
  const n = (v: number) => (
    <span className="truncate text-end" title={v.toLocaleString(locale())}>
      {formatTokens(v)}
    </span>
  );
  return (
    <div className={`${COLS} tabular h-7 text-footnote ${strong ? "border-t border-separator text-label" : "text-label-2"}`}>
      {label}
      {n(x.input)}
      {n(x.cacheWrite + x.cacheWrite1h)}
      {n(x.cacheRead)}
      {n(x.output)}
      {n(x.tokens)}
      {onCost ? (
        <button className="group flex items-center justify-end gap-1 text-end font-semibold text-label hover:text-link" title={t("Preis festlegen")} onClick={onCost}>
          <PencilSimple size={10} weight="bold" className="opacity-0 transition-opacity group-hover:opacity-100" />
          {formatCost(x)}
        </button>
      ) : (
        <span className="text-end font-semibold">{formatCost(x)}</span>
      )}
    </div>
  );
}

const fields: { key: keyof Prices; label: string }[] = [
  { key: "input", label: "Eingabe" },
  { key: "output", label: "Ausgabe" },
  { key: "cacheRead", label: "Cache lesen" },
  { key: "cacheWrite", label: "Cache schreiben" },
];

/** USD per million tokens for one model. Empty cache fields follow the usual rule (read 0.1x, write 1.25x the input price). */
function PriceEditor({ row, manual, onDone }: { row: ModelRow; manual: Record<string, Prices>; onDone: () => void }) {
  const key = normalizeModel(row.model);
  const current = findPrices(row.model, manual);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, current?.prices[f.key] !== undefined ? String(current.prices[f.key]) : ""])),
  );
  const parse = (s: string) => (s.trim() === "" ? undefined : Number(s.replace(",", ".")));
  const next: Partial<Prices> = Object.fromEntries(fields.map((f) => [f.key, parse(values[f.key])]).filter(([, v]) => v !== undefined));
  const valid = validPrices(next);
  const setPrices = (prices: Record<string, Prices>) => updateSettings((s) => ({ aiUsage: { ...s.aiUsage, prices } }));

  return (
    <div className="mb-1 flex flex-wrap items-center gap-2 rounded-[10px] bg-fill-1 px-2 py-1.5 text-caption text-label-3">
      <span>{t("USD je 1 Mio. Tokens")}</span>
      {fields.map((f) => (
        <label key={f.key} className="flex items-center gap-1">
          {t(f.label)}
          <TextField width="w-14" value={values[f.key]} placeholder={f.key === "input" || f.key === "output" ? "0" : t("auto")} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} />
        </label>
      ))}
      <div className="ms-auto flex gap-1">
        {manual[key] && (
          <Button
            onClick={() => {
              const rest = { ...manual };
              delete rest[key];
              setPrices(rest);
              onDone();
            }}
          >
            {t("Zurücksetzen")}
          </Button>
        )}
        <Button
          primary
          disabled={!valid}
          onClick={() => {
            if (!valid) return;
            setPrices({ ...manual, [key]: next });
            onDone();
          }}
        >
          {t("Sichern")}
        </Button>
      </div>
    </div>
  );
}
