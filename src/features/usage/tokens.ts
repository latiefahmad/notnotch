// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/ModelUsage.cs and Pricing.cs (Summarize).
// Groups the token buckets from the local logs by local day and by model, and prices them. Pure, so the views only render.
import { cost, type Prices, type TokenCounts } from "./pricing.ts";

/** One model's tokens in one quarter hour (see src-tauri/src/usage_logs.rs). */
export interface TokenBucket extends TokenCounts { at: number; model: string; band: number }
export interface ToolTokens { id: "claude" | "codex"; found: boolean; files: number; unreadable: number; buckets: TokenBucket[] }
export interface TokenReport { since: number; tools: ToolTokens[] }

export interface Totals extends TokenCounts {
  tokens: number;
  /** USD of the priced tokens. */
  cost: number;
  /** Tokens of models without a price (not in `cost`). */
  unpriced: number;
}

/** Local midnight `daysBack` days before the day of `now` (0 = today). */
export function dayStart(now: number, daysBack: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.getTime();
}

const empty = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, tokens: 0, cost: 0, unpriced: 0 });

function add(t: Totals, b: TokenBucket, manual: Record<string, Prices>) {
  const n = b.input + b.output + b.cacheRead + b.cacheWrite + b.cacheWrite1h;
  t.input += b.input;
  t.output += b.output;
  t.cacheRead += b.cacheRead;
  t.cacheWrite += b.cacheWrite;
  t.cacheWrite1h += b.cacheWrite1h;
  t.tokens += n;
  const usd = cost(b.model, b.band, b, manual);
  if (usd === null) t.unpriced += n;
  else t.cost += usd;
}

/** Everything from `from` (Unix ms) on. */
export function totals(buckets: TokenBucket[], from: number, manual: Record<string, Prices>): Totals {
  const t = empty();
  for (const b of buckets) if (b.at >= from) add(t, b, manual);
  return t;
}

export interface ModelRow extends Totals { tool: ToolTokens["id"]; model: string }

/** One row per tool and model from `from` on, most tokens first. Tools are kept apart even when a model name is shared. */
export function byModel(report: TokenReport, tools: ReadonlySet<string>, from: number, manual: Record<string, Prices>): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const tool of report.tools) {
    if (!tools.has(tool.id)) continue;
    for (const b of tool.buckets) {
      if (b.at < from) continue;
      const key = `${tool.id}\n${b.model}`;
      let row = rows.get(key);
      if (!row) rows.set(key, (row = { ...empty(), tool: tool.id, model: b.model }));
      add(row, b, manual);
    }
  }
  return [...rows.values()].sort((a, b) => b.tokens - a.tokens || a.tool.localeCompare(b.tool) || a.model.localeCompare(b.model));
}

/** Sum of rows (the table's total line). */
export function sumRows(rows: Totals[]): Totals {
  const t = empty();
  for (const r of rows) {
    t.input += r.input;
    t.output += r.output;
    t.cacheRead += r.cacheRead;
    t.cacheWrite += r.cacheWrite;
    t.cacheWrite1h += r.cacheWrite1h;
    t.tokens += r.tokens;
    t.cost += r.cost;
    t.unpriced += r.unpriced;
  }
  return t;
}
