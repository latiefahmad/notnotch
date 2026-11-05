// Find on screen: which recognised lines match the query, and where to highlight them. Pure.

export interface Segment {
  text: string;
  hit: boolean;
}

/** Lower case without accents or ligatures, and for each folded unit the span of `s` it came from. */
function fold(s: string): { text: string; start: number[]; end: number[] } {
  let text = "";
  const start: number[] = [], end: number[] = [];
  let i = 0;
  for (const ch of s) {
    const f = ch.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < f.length; k++) {
      start.push(i);
      end.push(i + ch.length);
    }
    text += f;
    i += ch.length;
  }
  return { text, start, end };
}

/** The query's words, folded; empty for a blank query. */
export function queryWords(query: string): string[] {
  return fold(query).text.split(/\s+/).filter(Boolean);
}

/** The line cut into plain and matched parts, or null unless every word is in it. */
export function matchLine(line: string, words: string[]): Segment[] | null {
  if (!words.length) return null;
  const f = fold(line);
  const ranges: [number, number][] = [];
  for (const w of words) {
    let at = f.text.indexOf(w);
    if (at < 0) return null;
    for (; at >= 0; at = f.text.indexOf(w, at + w.length)) ranges.push([f.start[at], f.end[at + w.length - 1]]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out: Segment[] = [];
  let pos = 0;
  for (const [a, b] of ranges) {
    if (b <= pos) continue;
    const from = Math.max(a, pos);
    if (from > pos) out.push({ text: line.slice(pos, from), hit: false });
    const last = out[out.length - 1];
    // Overlapping or touching matches make one highlight.
    if (last?.hit && from === pos) last.text += line.slice(from, b);
    else out.push({ text: line.slice(from, b), hit: true });
    pos = b;
  }
  if (pos < line.length) out.push({ text: line.slice(pos), hit: false });
  return out;
}
