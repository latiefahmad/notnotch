import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAccount, fetchRates, recordHistory, type RecordEntry } from "../../platform/portfolio";
import { secrets } from "../../platform/services";
import { settings } from "../../settings/store";
import { adoptBase, effectiveBase } from "./base";
import { manualHoldings } from "./manual";
import { addTotals, manualAccount, mergeRates, priceNeeds, summarize, type Account, type History, type Rates, type Summary, type Totals } from "./portfolio";
import { providers } from "./providers";

/** Polls while the tool is open; each provider's cache in Rust keeps within its rate limit. */
const POLL_MS = 30_000;

export interface AccountState {
  /** Provider id or "manual". */
  id: string;
  /** History scope ("t212-live", "kraken", …). */
  scope: string;
  account: Account | null;
  summary: Summary | null;
  error: string | null;
  /** Still fetching (first load, or no data yet). */
  loading: boolean;
  history: History | null;
}

export interface PortfolioState {
  base: string;
  /** Set-up accounts in provider order, manual last. */
  accounts: AccountState[];
  /** Over the accounts with data so far. */
  total: Totals | null;
  /** Every account loaded, priced and complete: only then is the total recorded. */
  complete: boolean;
  history: History | null;
  /** Price sources that failed on the last refresh. */
  failed: string[];
  /** Nothing is set up. */
  empty: boolean;
}

type Slot = { id: string; scope: string; account: Account | null; error: string | null; loading: boolean };

/**
 * Fetches every set-up account in parallel and publishes the state each time one settles, so
 * the first paint does not wait for the slowest provider. History is recorded once at the end.
 */
export function usePortfolio() {
  const { env, base: stored } = settings.use().trading;
  const base = effectiveBase(stored);
  const manual = manualHoldings.use();
  const [state, setState] = useState<PortfolioState | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  /** Bumped by every mount and settings change; an older refresh then stops publishing. */
  const epoch = useRef(0);
  const running = useRef(-1);
  const last = useRef<{ base: string; accounts: Record<string, Account>; rates: Rates | null; histories: Record<string, History> }>({ base, accounts: {}, rates: null, histories: {} });

  const refresh = useCallback(async () => {
    const mine = epoch.current;
    const fresh = () => epoch.current === mine;
    // An interval tick during a slow refresh is skipped, not queued.
    if (running.current === mine) return;
    running.current = mine;
    setLoading(true);
    // Histories and prices are per base currency.
    if (last.current.base !== base) last.current = { base, accounts: last.current.accounts, rates: null, histories: {} };
    try {
      const configured = (await Promise.all(providers.map(async (p) => ((await secrets.has(p.fields[0].secret)) ? p.id : null)))).filter((id) => id !== null);
      const slots: Slot[] = configured.map((id) => {
        const scope = id === "t212" ? `t212-${env}` : id;
        return { id, scope, account: last.current.accounts[scope] ?? null, error: null, loading: true };
      });
      if (manual.length) slots.push({ id: "manual", scope: "manual", account: manualAccount(manual), error: null, loading: false });

      // Publications run one after another, so a slow price call cannot overwrite a newer state.
      let chain = Promise.resolve();
      const publish = (final: boolean) => (chain = chain.then(() => compute(slots, final)));
      let adopted = false;

      const compute = async (list: Slot[], final: boolean) => {
        if (!fresh() || adopted) return;
        const loaded = list.flatMap((a) => (a.account ? [a.account] : []));
        const needs = priceNeeds(loaded, base);
        let rates = last.current.rates;
        if (loaded.length) {
          try {
            rates = mergeRates(await fetchRates(base, needs.crypto, needs.fiats), last.current.rates);
            last.current.rates = rates;
          } catch {
            // Offline: older prices beat none.
          }
        }
        const usable: Rates = rates && rates.base === base ? rates : { base, crypto: {}, fx: {}, failed: loaded.length ? ["coingecko", "frankfurter"] : [] };
        const summaries = list.map((a) => ({ ...a, summary: a.account ? summarize(a.account, usable) : null }));
        const ok = summaries.flatMap((a) => (a.summary ? [a.summary] : []));
        const total = ok.length ? addTotals(ok) : null;
        const usableSummary = (s: Summary | null) => s && !s.partial && !s.missing.length;
        const complete = summaries.every((a) => !a.loading && !a.error && usableSummary(a.summary));

        if (final) {
          // History only from complete data, so a failed account or a missing price makes no dip.
          const entries: RecordEntry[] = [];
          const t212 = summaries.find((a) => a.id === "t212")?.account;
          const seed = t212?.holdings.find((h) => h.currency)?.currency === base ? env : undefined;
          for (const a of summaries) {
            if (a.summary && !a.error && usableSummary(a.summary)) entries.push({ scope: a.scope, ...point(a.summary), seed: a.id === "t212" ? seed : undefined });
          }
          if (total && complete) entries.push({ scope: "all", ...point(total), seed: summaries.length === 1 && summaries[0].id === "t212" ? seed : undefined });
          // Scopes not recorded this time keep the history from before.
          if (entries.length) Object.assign(last.current.histories, await recordHistory(base, entries));
        }
        if (!fresh()) return;
        const histories = last.current.histories;
        setState({
          base,
          accounts: summaries.map((a) => ({ ...a, history: histories[a.scope] ?? null })),
          total,
          complete,
          history: histories.all ?? null,
          failed: usable.failed,
          empty: list.length === 0,
        });
      };

      void publish(false);
      await Promise.all(
        configured.map(async (id, i) => {
          const slot = slots[i];
          try {
            slot.account = await fetchAccount(id, env);
            last.current.accounts[slot.scope] = slot.account;
            slot.error = null;
            // Upgrade from the Trading 212-only version: keep its currency, so its history carries on.
            // Only a different currency starts a new refresh (the settings change); this one then stops.
            const currency = slot.account.holdings.find((h) => h.currency)?.currency;
            if (id === "t212" && adoptBase(currency) && currency?.toUpperCase() !== base) adopted = true;
          } catch (e) {
            const error = String(e);
            // A rate limit while data is on screen keeps the last data.
            if (!(error === "rate" && slot.account)) {
              slot.account = null;
              slot.error = error;
            }
          }
          slot.loading = false;
          await publish(false);
        }),
      );
      // A new base starts a new refresh (the settings change); this one stops here.
      if (!adopted) await publish(true);
      if (fresh() && !adopted) setUpdatedAt(Date.now());
    } finally {
      if (running.current === mine) running.current = -1;
      if (fresh()) setLoading(false);
    }
  }, [env, base, manual]);

  useEffect(() => {
    epoch.current++;
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => {
      epoch.current++;
      clearInterval(id);
    };
  }, [refresh]);

  return { state, loading, updatedAt, refresh };
}

function point(t: Totals) {
  return { value: t.value, pnl: t.unrealized + t.realized, invested: t.invested, noCost: t.noCost };
}
