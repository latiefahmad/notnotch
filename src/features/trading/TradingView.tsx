import { useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowClockwise, CaretLeft, CaretRight, Key, WarningCircle, Wallet } from "@phosphor-icons/react";
import { DepotIcon } from "../../ui/icons";
import { content, fade, spin, springs } from "../../design/motion";
import { formatAgo, formatMoney, formatPercent, formatTime } from "../../lib/format";
import { createStore } from "../../lib/store";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { settings } from "../../settings/store";
import { Button, Empty, Segmented, Skeleton } from "../../ui/controls";
import { locale, t } from "../../i18n";
import { usePresenting } from "../privacy/store";
import { manualHoldings } from "./manual";
import { combineChanges, seriesFor, todayChange, type DayChange, type History, type Line, type Range, type Totals } from "./portfolio";
import { providerName } from "./providers";
import { usePortfolio, type AccountState } from "./usePortfolio";

/** Amounts in presentation mode: percentages stay, money is hidden. */
const MASK = "••••••";

const ranges: { value: Range; label: string }[] = [
  { value: "1d", label: "1T" },
  { value: "7d", label: "7T" },
  { value: "30d", label: "30T" },
  { value: "all", label: "Alles" },
];
const range = createStore<Range>("1d", { persist: "trading-range" });

/*
 *   ‹ All · Kraken                           [1D 7D 30D All] [⟳]
 *   12.345,67 €                         ╱╲    ╱‾‾
 *   +4,20 € (+0,17 %) today        ___╱  ╲__╱      P&L +12,30 € · 7D
 *   [Cash] [Invested] [Open +0,07 € +1,9 %] [Realized +85 €]
 *   Kraken    3 positions                        845,20 €  [+2,10 %]   (all accounts)
 *   AAPL  Apple                                  845,20 €  [+2,10 %]   (one account)
 *
 * Everything is in the base currency (settings). All changes are based on profit
 * (realized + unrealized) instead of value, so deposits and withdrawals distort neither
 * "today" nor the history. Percent today = change / yesterday's value; percent open =
 * open P&L / cost basis.
 */
export function TradingView() {
  const env = settings.use().trading.env;
  const { state, loading, updatedAt, refresh } = usePortfolio();
  const [picked, setPicked] = useState<string | null>(null);
  const r = range.use();
  const hidden = usePresenting();

  const accounts = state?.accounts ?? [];
  const single = accounts.length === 1 ? accounts[0] : null;
  const selected = single ?? accounts.find((a) => a.id === picked) ?? null;
  const base = state?.base ?? "EUR";
  const money = (v: number, opts?: { signed?: boolean }) => (hidden ? MASK : formatMoney(v, base, opts));

  const actions = (
    <HeaderActions>
      {env === "demo" && accounts.some((a) => a.id === "t212") && <span className="me-1 rounded-full bg-fill-2 px-1.5 text-caption text-label-2">{t("Demo")}</span>}
      {state?.total && <Segmented id="trading-range" size="sm" value={r} onChange={range.set} options={ranges.map((o) => ({ ...o, label: t(o.label) }))} />}
      <HeaderButton label={updatedAt ? t("Aktualisiert {ago}", { ago: formatAgo(Date.now() - updatedAt) }) : t("Aktualisieren")} onClick={() => void refresh()}>
        <motion.span className="flex" animate={{ rotate: loading ? 360 : 0 }} transition={loading ? spin : { duration: 0 }}>
          <ArrowClockwise size={14} weight="bold" />
        </motion.span>
      </HeaderButton>
    </HeaderActions>
  );

  if (!state) return <LoadingState />;
  if (state.empty) {
    return (
      <Empty
        icon={Wallet}
        title={t("Portfolio verbinden")}
        text={t("Broker oder Börse mit einem Nur-Lese-Schlüssel verbinden oder Bestände von Hand eintragen.")}
        action={<Button primary onClick={() => navigate("settings", "trading")}>{t("Einrichten")}</Button>}
      />
    );
  }
  if (single?.error) return <ErrorState name={providerName(single.id)} code={single.error} onRetry={() => void refresh()} />;

  const totals: Totals | null = selected ? selected.summary : state.total;
  const history: History | null = selected ? selected.history : state.history;
  if (!totals) {
    // Nothing to show yet: the first accounts are still on their way.
    if (accounts.some((a) => a.loading)) return <LoadingState />;
    return <ErrorState name={t("Portfolio")} code={accounts.find((a) => a.error)?.error ?? "network:"} onRetry={() => void refresh()} />;
  }
  // The total compares only accounts with points on both days, so a new or failing one is no jump.
  const today = selected
    ? selected.history && todayChange(performance(totals), selected.history)
    : combineChanges(accounts.map((a) => (a.summary && a.history ? todayChange(performance(a.summary), a.history) : null)));

  return (
    <div className="flex h-full flex-col px-5 pt-1 pb-2">
      {actions}
      <Overview totals={totals} history={history} today={today} range={r} money={money} title={selected && !single ? <BackLink name={t(providerName(selected.id))} onBack={() => setPicked(null)} /> : null} />
      <Notice state={selected ? [selected] : accounts} failed={state.failed} />
      <div className="-mx-2 mt-2 min-h-0 flex-1 overflow-y-auto px-2 [scrollbar-width:none]">
        {selected ? <Positions account={selected} money={money} hidden={hidden} /> : accounts.map((a, i) => <AccountRow key={a.id} account={a} index={i} money={money} onOpen={() => setPicked(a.id)} />)}
      </div>
    </div>
  );
}

type MoneyFn = (v: number, opts?: { signed?: boolean }) => string;

/** Performance now: P&L plus the value of positions without a cost basis (see portfolio.ts). */
const performance = (t: Totals) => t.unrealized + t.realized + t.noCost;

function Overview(props: { totals: Totals; history: History | null; today: DayChange | null; range: Range; money: MoneyFn; title: ReactNode }) {
  const { totals, history, today, range: r, money, title } = props;
  const series = history ? seriesFor(history, r) : [];
  const openPct = totals.invested > 0 ? (totals.unrealized / totals.invested) * 100 : null;
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {title}
          <AnimatedValue className="tabular text-[30px] leading-9 font-semibold tracking-[-0.025em]" text={money(totals.value)} />
          {today ? (
            <Change value={today.change} pct={today.pct} money={money(today.change, { signed: true })} suffix={today.since === null ? t("heute") : t("seit {time}", { time: formatTime(today.since) })} />
          ) : (
            <div className="text-footnote text-label-3">{t("Tagesänderung ab dem nächsten Abruf")}</div>
          )}
        </div>
        <Chart series={series} money={(v) => money(v, { signed: true })} rangeLabel={t(ranges.find((x) => x.value === r)!.label)} />
      </div>
      <div className="mt-3 grid grid-cols-[1fr_1fr_1.45fr_1fr] gap-1.5">
        <Stat label={t("Cash")} value={money(totals.cash)} />
        <Stat label={t("Investiert")} value={money(totals.invested)} />
        <Stat label={t("Offen")} value={money(totals.unrealized, { signed: true })} sub={openPct !== null ? formatPercent(openPct) : undefined} tone={totals.unrealized} />
        <Stat label={t("Realisiert")} value={money(totals.realized, { signed: true })} tone={totals.realized} />
      </div>
    </>
  );
}

function BackLink({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <button onClick={onBack} className="pressable -ms-1 flex items-center gap-0.5 rounded-[6px] px-1 text-caption font-medium text-label-3 hover:text-label-2">
      <CaretLeft size={11} weight="bold" className="rtl:-scale-x-100" />
      {t("Alle Konten")} <span className="text-label-2">· {name}</span>
    </button>
  );
}

/** One line under the stats: the most important thing that makes the numbers incomplete. */
function Notice({ state, failed }: { state: AccountState[]; failed: string[] }) {
  const warn = state.find((a) => a.account?.warning === "key-can-trade");
  const noLedger = state.find((a) => a.account?.warning === "ledger-forbidden");
  const partial = state.find((a) => a.summary?.partial);
  const missing = [...new Set(state.flatMap((a) => a.summary?.missing ?? []))];
  const errors = state.filter((a) => a.error);
  const pending = state.filter((a) => a.loading && !a.summary);
  let text: string | null = null;
  if (warn) text = t("Der {name}-Schlüssel darf mehr als lesen. NotNotch liest nur, trotzdem besser einen Nur-Lese-Schlüssel erstellen.", { name: providerName(warn.id) });
  else if (errors.length) text = t("Nicht erreichbar: {names}. Nicht mitgezählt.", { names: errors.map((a) => t(providerName(a.id))).join(", ") });
  else if (noLedger) text = t("Dem {name}-Schlüssel fehlt „Query Ledger Entries“: Einstand unbekannt.", { name: providerName(noLedger.id) });
  else if (pending.length) text = t("Wird noch geladen: {names}.", { names: pending.map((a) => t(providerName(a.id))).join(", ") });
  else if (partial) text = t("{name}: Handelsverlauf wird noch geladen, G/V ist unvollständig.", { name: providerName(partial.id) });
  else if (failed.length && missing.length) text = t("Kurse gerade nicht abrufbar. Ohne Kurs: {symbols}.", { symbols: missing.slice(0, 4).join(", ") });
  else if (missing.length) text = t("Ohne Kurs, nicht mitgezählt: {symbols}.", { symbols: missing.slice(0, 4).join(", ") + (missing.length > 4 ? " …" : "") });
  if (!text) return null;
  const body = (
    <>
      <WarningCircle size={12} weight="fill" className={`mt-px shrink-0 ${warn ? "text-orange" : ""}`} />
      <span className="line-clamp-2">{text}</span>
    </>
  );
  const style = "mt-1.5 flex items-start gap-1 text-start text-caption text-label-3";
  // Only the key problems lead somewhere (the settings).
  return warn || errors.length || noLedger ? (
    <button onClick={() => navigate("settings", "trading")} className={style}>
      {body}
    </button>
  ) : (
    <div className={style}>{body}</div>
  );
}

function AccountRow({ account: a, index, money, onOpen }: { account: AccountState; index: number; money: MoneyFn; onOpen: () => void }) {
  const s = a.summary;
  const pnl = s ? s.unrealized : 0;
  const pct = s && s.invested > 0 ? (s.unrealized / s.invested) * 100 : null;
  const sub = a.error
    ? errorLine(a.error)
    : s
      ? t("{n} Positionen", { n: s.lines.length }) + (s.cash > 0.005 ? ` · ${t("Cash")} ${money(s.cash)}` : "")
      : t("Wird geladen …");
  return (
    <motion.button
      disabled={!a.error && !s}
      onClick={a.error ? () => navigate("settings", "trading") : onOpen}
      className="pressable flex h-10 w-full items-center gap-3 border-b border-separator px-1 text-start last:border-0"
      initial={{ opacity: 0, transform: "translateY(4px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{ ...content.enter, delay: 0.03 * index }}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-footnote font-semibold text-label">{t(providerName(a.id))}</div>
        <div className={`truncate text-caption ${a.error ? "text-red" : "text-label-3"}`}>{sub}</div>
      </div>
      {s && (
        <div className="text-end">
          <div className="tabular text-footnote text-label">{money(s.value)}</div>
          <div className={`tabular text-caption ${tone(pnl)}`}>{s.invested > 0 ? money(pnl, { signed: true }) : "–"}</div>
        </div>
      )}
      {s && <span className={`tabular w-[68px] rounded-[6px] py-0.5 text-center text-caption font-semibold ${pill(pnl)}`}>{pct !== null ? formatPercent(pct) : "–"}</span>}
      <CaretRight size={11} weight="bold" className="shrink-0 text-label-4 rtl:-scale-x-100" />
    </motion.button>
  );
}

function Positions({ account, money, hidden }: { account: AccountState; money: MoneyFn; hidden: boolean }) {
  const manual = manualHoldings.use();
  const lines = account.summary?.lines ?? [];
  if (!lines.length) return <div className="py-4 text-center text-caption text-label-3">{t("Keine offenen Positionen")}</div>;
  return (
    <>
      {lines.map((p, i) => {
        const pct = p.cost && p.cost > 0 && p.pnl !== null ? (p.pnl / p.cost) * 100 : null;
        const priceDate = account.id === "manual" && p.kind === "stock" ? manual.find((m) => m.symbol.toUpperCase() === p.symbol)?.priceDate : null;
        return (
          <motion.div
            key={p.symbol}
            className="flex h-10 items-center gap-3 border-b border-separator px-1 last:border-0"
            initial={{ opacity: 0, transform: "translateY(4px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            transition={{ ...content.enter, delay: 0.03 * i }}
            title={hidden ? undefined : tooltip(p, money)}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-footnote font-semibold text-label">{p.symbol}</div>
              <div className="truncate text-caption text-label-3">{priceDate ? t("Kurs vom {date}", { date: new Date(priceDate).toLocaleDateString(locale(), { day: "numeric", month: "short" }) }) : p.name === "unknown-asset" ? t("Unbekannter Wert") : p.name}</div>
            </div>
            <div className="text-end">
              <div className="tabular text-footnote text-label">{p.value !== null ? money(p.value) : t("Kein Kurs")}</div>
              <div className={`tabular text-caption ${tone(p.pnl ?? 0)}`}>{p.pnl !== null ? (p.approx ? "≈ " : "") + money(p.pnl, { signed: true }) : "–"}</div>
            </div>
            <span className={`tabular w-[68px] rounded-[6px] py-0.5 text-center text-caption font-semibold ${pill(p.pnl ?? 0)}`}>{pct !== null ? formatPercent(pct) : "–"}</span>
          </motion.div>
        );
      })}
    </>
  );
}

function tooltip(p: Line, money: MoneyFn): string {
  const qty = p.quantity.toLocaleString(locale(), { maximumFractionDigits: 8 });
  const parts = [`${qty} ${t("Stk.")}`];
  if (p.price !== null) parts.push(`${t("Kurs")} ${money(p.price)}`);
  if (p.cost !== null && p.quantity) parts.push(`Ø ${money(p.cost / p.quantity)}`);
  if (p.approx) parts.push(t("G/V nur für gehandelte Stücke"));
  return parts.join(" · ");
}

function tone(v: number): string {
  return v > 0.004 ? "text-green" : v < -0.004 ? "text-red" : "text-label-3";
}

function pill(v: number): string {
  return v > 0.004 ? "bg-green/18 text-green" : v < -0.004 ? "bg-red/18 text-red" : "bg-fill-2 text-label-2";
}

function Change({ value, pct, money, suffix }: { value: number; pct: number | null; money: string; suffix: string }) {
  return (
    <div className={`tabular text-footnote font-medium ${tone(value)}`}>
      {money}
      {pct !== null && ` (${formatPercent(pct)})`} <span className="font-normal text-label-3">{suffix}</span>
    </div>
  );
}

function Stat({ label, value, sub, tone: t }: { label: string; value: string; sub?: string; tone?: number }) {
  return (
    <div className="min-w-0 rounded-[10px] bg-fill-1 px-2.5 py-1.5">
      <div className="text-caption text-label-3">{label}</div>
      <div className={`tabular flex items-baseline gap-1 text-footnote font-semibold ${t === undefined ? "text-label" : tone(t)}`}>
        <span className="truncate">{value}</span>
        {sub && <span className="shrink-0 text-caption font-medium opacity-80">{sub}</span>}
      </div>
    </div>
  );
}

/** Line + soft area, green or red depending on the range. Redraws on change. */
function Chart({ series, money, rangeLabel }: { series: number[]; money: (v: number) => string; rangeLabel: string }) {
  const w = 210;
  const h = 56;
  const path = useMemo(() => {
    if (series.length < 2) return null;
    const min = Math.min(...series);
    const max = Math.max(...series);
    const span = max - min || 1;
    const pts = series.map((v, i) => [(i / (series.length - 1)) * w, h - 4 - ((v - min) / span) * (h - 8)] as const);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    return { line, area: `${line} L${w},${h} L0,${h} Z`, delta: series.at(-1)! - series[0] };
  }, [series]);

  if (!path) {
    return (
      <div className="flex h-[74px] w-[210px] shrink-0 flex-col justify-end gap-1.5">
        <div className="h-px w-full border-t border-dashed border-fill-3" />
        <span className="text-end text-caption text-label-3">{t("Verlauf entsteht – ab jetzt wird gespeichert")}</span>
      </div>
    );
  }
  const color = path.delta >= 0 ? "var(--color-green)" : "var(--color-red)";
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
        <defs>
          <linearGradient id="trading-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.g key={path.line} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
            <path d={path.area} fill="url(#trading-fill)" />
            <motion.path
              d={path.line}
              fill="none"
              stroke={color}
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={springs.morph}
            />
          </motion.g>
        </AnimatePresence>
      </svg>
      <span className="tabular text-caption text-label-3">
        {t("G/V")} <span className={tone(path.delta)}>{money(path.delta)}</span> · {rangeLabel}
      </span>
    </div>
  );
}

/** Value crossfades on change (blur bridge) instead of jumping. */
function AnimatedValue({ text, className }: { text: string; className: string }) {
  return (
    <div className="relative">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={text}
          className={className}
          initial={{ opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
          exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
        >
          {text}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full flex-col gap-2 px-5 pt-2 pb-2">
      <Skeleton className="h-8 w-44" />
      <Skeleton className="h-3 w-32" />
      <Skeleton className="mt-2 h-10 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

const errorText: Record<string, string> = {
  "no-key": "Schlüssel fehlt.",
  unauthorized: "Schlüssel ungültig – bitte neu eintragen.",
  forbidden: "Dem Schlüssel fehlen Leserechte, siehe Einstellungen.",
  "bad-key": "Privater Schlüssel nicht lesbar. Nötig ist ein ECDSA-Schlüssel im PEM-Format.",
  rate: "Zu viele Abfragen, gleich wieder.",
};

/** Short text for an error code from Rust. */
function errorLine(code: string): string {
  if (errorText[code]) return t(errorText[code]);
  if (code.startsWith("network:")) return t("Keine Verbindung ({e}).", { e: code.slice(8) || "?" });
  if (code.startsWith("api:")) return code.slice(4);
  return code;
}

function ErrorState({ name, code, onRetry }: { name: string; code: string; onRetry: () => void }) {
  const isKey = code in errorText && code !== "rate";
  return (
    <Empty
      icon={isKey ? Key : WarningCircle}
      title={isKey ? t("Zugang prüfen") : t("{name} nicht erreichbar", { name })}
      text={errorLine(code)}
      action={
        <div className="flex gap-2">
          <Button onClick={() => navigate("settings", "trading")}>{t("Einstellungen")}</Button>
          <Button primary onClick={onRetry} icon={DepotIcon}>{t("Erneut laden")}</Button>
        </div>
      }
    />
  );
}
