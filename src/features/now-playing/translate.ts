// Lyrics translated by the Ask provider, the pure part: the prompt, reading the reply, and the answer as LRC.
import type { LyricLine } from "./lrc.ts";

/** Lines are numbered so a reply that skips or merges one still lands on the right lines. */
export function translationPrompt(texts: string[], language: string): string {
  const numbered = texts.map((t, i) => (t.trim() ? `${i + 1}\t${t.trim()}` : null)).filter(Boolean);
  return [
    `Translate these song lyrics into ${language}. Each line is "number<TAB>text".`,
    `Reply with one line per input line, "number<TAB>translation", the same numbers, and nothing else.`,
    `If a line is already in ${language}, repeat it unchanged.`,
    "",
    ...numbered,
  ].join("\n");
}

/** Translations by line index from a reply; null where the reply has none. */
export function parseTranslation(reply: string, count: number): (string | null)[] {
  const out: (string | null)[] = Array(count).fill(null);
  for (const line of reply.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*[\t:.)-]\s*(.*\S)\s*$/.exec(line);
    const i = m ? Number(m[1]) - 1 : -1;
    if (i >= 0 && i < count) out[i] = m![2];
  }
  return out;
}

const stamp = (t: number) => {
  const cs = Math.round(t * 100);
  return `${String(Math.floor(cs / 6000)).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** The translations as LRC with the lines' stamps, for the lyrics cache; null when there is none. */
export function translationLrc(lines: LyricLine[], translated: (string | null)[]): string | null {
  const out = lines.map((l, i) => (translated[i] ? `[${stamp(l.time)}]${translated[i]}\n` : "")).join("");
  return out || null;
}
