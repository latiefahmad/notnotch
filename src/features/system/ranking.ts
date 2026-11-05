// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/SteadyRanking.cs.
// A ranking that does not jump: each entry keeps a level that rises at once with its reading but falls slowly, and an
// entry only passes another when its level is clearly above the other's. A process that spikes for one reading climbs
// at once; two processes at nearly the same load do not swap places every second.

export class SteadyRanking {
  private levels = new Map<string, number>();
  private order: string[] = [];

  /**
   * @param relative an entry passes another when its level is above by this share of the other's...
   * @param margin ...plus this much in the readings' unit
   * @param fall seconds for a level to lose about two thirds of its distance to a lower reading
   */
  readonly relative: number;
  readonly margin: number;
  readonly fall: number;
  constructor(relative: number, margin: number, fall: number) {
    this.relative = relative;
    this.margin = margin;
    this.fall = fall;
  }

  /** For CPU in percent of one core. */
  static cpu = () => new SteadyRanking(0.12, 1, 4);
  /** For memory in bytes. */
  static memory = () => new SteadyRanking(0.04, 24 * 1_048_576, 4);

  /** The ids in display order, `elapsed` seconds after the last call. With `hold` nothing already listed changes rank (the pointer is over the list); new entries go last. */
  step(entries: { id: string; value: number }[], elapsed: number, hold = false): string[] {
    const keep = this.fall > 0 ? Math.exp(-Math.max(0, elapsed) / this.fall) : 0;
    const next = new Map<string, number>();
    for (const { id, value } of entries) {
      if (next.has(id)) continue;
      const level = this.levels.get(id);
      next.set(id, level === undefined ? value : Math.max(value, value + (level - value) * keep));
    }
    this.levels = next;

    const result = this.order.filter((id) => next.has(id));
    const seen = new Set(result);
    const known = seen.size > 0;
    const arrivals = entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => !seen.has(e.id) && seen.add(e.id))
      .sort((a, b) => b.e.value - a.e.value || a.i - b.i)
      .map(({ e }) => e.id);
    result.push(...arrivals);
    // Arrivals are placed even under a hold when there was no list before.
    if (!hold || !known) {
      for (let i = 1; i < result.length; i++) {
        const level = next.get(result[i])!;
        const target = result.slice(0, i).findIndex((other) => level > next.get(other)! * (1 + this.relative) + this.margin);
        if (target < 0) continue;
        const [id] = result.splice(i, 1);
        result.splice(target, 0, id);
      }
    }
    this.order = result;
    return result;
  }

  /** The items in the order this ranking settles on. */
  arrange<T extends { id: string }>(items: T[], value: (item: T) => number, elapsed: number, hold = false): T[] {
    const byId = new Map<string, T>();
    for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it);
    return this.step(items.map((it) => ({ id: it.id, value: value(it) })), elapsed, hold).map((id) => byId.get(id)!);
  }
}
