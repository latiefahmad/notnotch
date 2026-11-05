import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle, LockSimple, Plus, X } from "@phosphor-icons/react";
import { fade } from "../../design/motion";
import { formatMoney } from "../../lib/format";
import { secrets } from "../../platform/services";
import { forgetAccount, localDate } from "../../platform/portfolio";
import { effectiveBase } from "./base";
import { settings, updateSettings } from "../../settings/store";
import { Button, Group, Row, Segmented, Select, TextField } from "../../ui/controls";
import { locale, t } from "../../i18n";
import { SecretRow } from "../settings/SettingsView";
import { manualHoldings, removeManual, saveManual } from "./manual";
import { BASES, parseAmount, type ManualHolding } from "./portfolio";
import { providers, type ProviderInfo } from "./providers";

const baseOptions = BASES.map((b) => ({ value: b as string, label: b }));

/** Settings → Connections → Portfolio: base currency, read-only keys per provider, manual holdings. */
export function TradingSettings() {
  const s = settings.use();
  return (
    <>
      <Group title={t("Portfolio")} id="settings-trading">
        <Row label={t("Basiswährung")} hint={t("Alle Konten werden darin angezeigt")}>
          <Select value={effectiveBase(s.trading.base)} options={baseOptions} onChange={(base) => updateSettings((p) => ({ trading: { ...p.trading, base } }))} width="w-24" />
        </Row>
        <div className="flex items-start gap-1.5 px-3 py-2 text-caption text-label-3">
          <LockSimple size={11} weight="bold" className="mt-0.5 shrink-0" />
          {t("NotNotch liest nur: keine Orders, keine Überweisungen. Jeden Schlüssel nur mit Leserechten erstellen. Kurse: CoinGecko und EZB-Referenzkurse.")}
        </div>
        {providers.map((p) => (
          <ProviderRow key={p.id} provider={p} />
        ))}
      </Group>
      <ManualHoldings />
    </>
  );
}

function ProviderRow({ provider: p }: { provider: ProviderInfo }) {
  const s = settings.use();
  const [connected, setConnected] = useState(false);
  const [open, setOpen] = useState(false);
  // Deleting the main key also forgets that account's cache, Kraken ledger and history.
  const was = useRef(false);
  const check = () =>
    void secrets.has(p.fields[0].secret).then((has) => {
      if (was.current && !has) void forgetAccount(p.id);
      was.current = has;
      setConnected(has);
    });
  useEffect(check, [p]);

  return (
    <div>
      <Row label={p.name} hint={connected ? t("Verbunden") : undefined}>
        <div className="flex items-center gap-1.5">
          {connected && <CheckCircle size={14} weight="fill" className="text-green" />}
          <Button onClick={() => setOpen((o) => !o)}>{open ? t("Fertig") : connected ? t("Bearbeiten") : t("Einrichten")}</Button>
        </div>
      </Row>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden bg-fill-1">
            {p.id === "t212" && (
              <Row label={t("Konto")}>
                <Segmented
                  id="t212-env"
                  size="sm"
                  value={s.trading.env}
                  onChange={(env) => updateSettings((prev) => ({ trading: { ...prev.trading, env } }))}
                  options={[
                    { value: "live", label: t("Echt") },
                    { value: "demo", label: "Demo" },
                  ]}
                />
              </Row>
            )}
            {p.fields.map((f) => (
              <SecretRow key={f.secret} name={f.secret} label={t(f.label)} hint={f.hint && t(f.hint)} onSaved={check} />
            ))}
            <div className="px-3 py-2 text-caption text-label-3">{t(p.help)}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type Draft = { id: string | null; kind: "crypto" | "stock"; symbol: string; name: string; quantity: string; cost: string; currency: string; price: string };

const emptyDraft = (currency: string): Draft => ({ id: null, kind: "crypto", symbol: "", name: "", quantity: "", cost: "", currency, price: "" });

const num = (n: number | null) => (n === null ? "" : n.toLocaleString("en-US", { maximumFractionDigits: 8, useGrouping: false }));

/** Holdings typed in by hand: coins are priced by CoinGecko, stocks and ETFs at the price entered. */
function ManualHoldings() {
  const list = manualHoldings.use();
  const base = effectiveBase(settings.use().trading.base);
  const [draft, setDraft] = useState<Draft | null>(null);

  const edit = (m: ManualHolding) =>
    setDraft({ id: m.id, kind: m.kind, symbol: m.symbol, name: m.name, quantity: num(m.quantity), cost: num(m.cost), currency: m.currency, price: num(m.price) });

  return (
    <Group title={t("Manuelle Bestände")} id="settings-manual">
      {list.map((m) => (
        <Row
          key={m.id}
          label={`${m.symbol} · ${m.quantity.toLocaleString(locale(), { maximumFractionDigits: 8 })}`}
          hint={[
            m.cost !== null ? t("Einstand {v}", { v: formatMoney(m.cost, m.currency) }) : t("Einstand unbekannt"),
            m.kind === "crypto" ? t("Kurs live") : m.price !== null ? t("Kurs {v}", { v: formatMoney(m.price, m.currency) }) : t("Kein Kurs"),
          ].join(" · ")}
        >
          <div className="flex items-center gap-1.5">
            <Button onClick={() => edit(m)}>{t("Bearbeiten")}</Button>
            <button aria-label={t("Entfernen")} onClick={() => removeManual(m.id)} className="pressable rounded-full p-1 text-label-3 hover:text-label-2">
              <X size={13} weight="bold" />
            </button>
          </div>
        </Row>
      ))}
      {draft ? (
        <ManualForm draft={draft} onChange={setDraft} onDone={() => setDraft(null)} />
      ) : (
        <Row label={list.length ? "" : t("Noch nichts eingetragen")}>
          <Button icon={Plus} onClick={() => setDraft(emptyDraft(base))}>
            {t("Bestand hinzufügen")}
          </Button>
        </Row>
      )}
    </Group>
  );
}

function ManualForm({ draft: d, onChange, onDone }: { draft: Draft; onChange: (d: Draft) => void; onDone: () => void }) {
  const set = (patch: Partial<Draft>) => onChange({ ...d, ...patch });
  const quantity = parseAmount(d.quantity);
  const cost = d.cost.trim() ? parseAmount(d.cost) : null;
  const price = d.price.trim() ? parseAmount(d.price) : null;
  const symbol = d.symbol.trim().toUpperCase();
  const valid =
    /^[A-Z0-9.\-]{1,15}$/.test(symbol) &&
    quantity !== null &&
    quantity > 0 &&
    (!d.cost.trim() || (cost !== null && cost >= 0)) &&
    (!d.price.trim() || (price !== null && price > 0));

  const save = () => {
    if (!valid || quantity === null) return;
    const before = manualHoldings.get().find((m) => m.id === d.id);
    const stockPrice = d.kind === "stock" ? price : null;
    saveManual({
      id: d.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind: d.kind,
      symbol,
      name: d.name.trim(),
      quantity,
      cost,
      currency: d.currency,
      price: stockPrice,
      // The price date moves only when the price changes.
      priceDate: stockPrice === null ? null : before && before.price === stockPrice && before.priceDate ? before.priceDate : localDate(new Date()),
    });
    onDone();
  };

  return (
    <div className="bg-fill-1">
      <Row label={t("Art")}>
        <Segmented
          id="manual-kind"
          size="sm"
          value={d.kind}
          onChange={(kind) => set({ kind })}
          options={[
            { value: "crypto", label: t("Krypto") },
            { value: "stock", label: t("Aktie / ETF") },
          ]}
        />
      </Row>
      <Row label={t("Symbol")} hint={d.kind === "crypto" ? t("z. B. BTC, ETH") : t("z. B. VWCE, AAPL")}>
        <TextField value={d.symbol} onChange={(symbol) => set({ symbol })} placeholder="BTC" width="w-32" autoFocus />
      </Row>
      <Row label={t("Name")} hint={t("Optional")}>
        <TextField value={d.name} onChange={(name) => set({ name })} width="w-32" />
      </Row>
      <Row label={t("Menge")}>
        <TextField value={d.quantity} onChange={(quantity) => set({ quantity })} placeholder="0.5" width="w-32" onSubmit={save} />
      </Row>
      <Row label={t("Währung")} hint={t("Für Einstand und Kurs")}>
        <Select value={d.currency} options={baseOptions} onChange={(currency) => set({ currency })} width="w-24" />
      </Row>
      <Row label={t("Einstand gesamt")} hint={t("Was alle Stücke gekostet haben, leer = unbekannt")}>
        <TextField value={d.cost} onChange={(cost) => set({ cost })} placeholder="0" width="w-32" onSubmit={save} />
      </Row>
      <AnimatePresence initial={false}>
        {d.kind === "stock" && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={fade} className="overflow-hidden">
            <Row label={t("Kurs je Stück")} hint={t("Von Hand, es gibt keine freie Kursquelle für Aktien")}>
              <TextField value={d.price} onChange={(price) => set({ price })} placeholder="0" width="w-32" onSubmit={save} />
            </Row>
          </motion.div>
        )}
      </AnimatePresence>
      <Row label="">
        <div className="flex gap-1.5">
          <Button onClick={onDone}>{t("Abbrechen")}</Button>
          <Button primary disabled={!valid} onClick={save}>
            {t("Sichern")}
          </Button>
        </div>
      </Row>
    </div>
  );
}
