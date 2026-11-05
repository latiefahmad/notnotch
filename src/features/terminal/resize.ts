/*
 * PTY resize: the panel morphs and the font size slider moves in steps, and every
 * ConPTY resize makes conhost repaint the screen. So only the size the panel
 * settles on is sent, and never the same size twice.
 */

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export function createResizer(send: (cols: number, rows: number) => void, delayMs = 80, timers: Timers = realTimers) {
  let last = "";
  let pending: { cols: number; rows: number } | null = null;
  let timer: unknown;

  const flush = () => {
    timers.clear(timer);
    if (!pending) return;
    const { cols, rows } = pending;
    pending = null;
    const key = `${cols}x${rows}`;
    if (key === last) return;
    last = key;
    send(cols, rows);
  };

  return {
    push(cols: number, rows: number) {
      // A hidden or collapsed container measures as a sliver; keep the last real size.
      if (!(cols >= 2 && rows >= 2)) return;
      pending = { cols, rows };
      timers.clear(timer);
      timer = timers.set(flush, delayMs);
    },
    flush,
    /** New session: it starts at the current size, so the next push is sent again. */
    reset(cols: number, rows: number) {
      timers.clear(timer);
      pending = null;
      last = `${cols}x${rows}`;
    },
  };
}
