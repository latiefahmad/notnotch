// A small syntax colouring for the scratchpad: comments, strings, numbers and keywords per language. Pure, one regex pass, no parser.

export const LANGUAGES = ["javascript", "typescript", "rust", "python", "plain"] as const;
export type Language = (typeof LANGUAGES)[number];
export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword";
export interface Token { kind: TokenKind; text: string }

const JS = "await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield async";
const KEYWORDS: Record<Exclude<Language, "plain">, string> = {
  javascript: JS,
  typescript: `${JS} abstract any as boolean declare enum implements interface keyof never number private protected public readonly string type unknown satisfies`,
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err",
  python: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self",
};

const COMMENTS: Record<Exclude<Language, "plain">, string> = {
  javascript: String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`,
  typescript: String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`,
  rust: String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`,
  python: String.raw`#[^\n]*`,
};
const STRINGS: Record<Exclude<Language, "plain">, string> = {
  javascript: String.raw`"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|\x60(?:\\.|[^\x60\\])*\x60?`,
  typescript: String.raw`"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|\x60(?:\\.|[^\x60\\])*\x60?`,
  // Lifetimes ('a) look like chars, so only a closed one-character literal counts.
  rust: String.raw`"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\\n])'`,
  python: String.raw`"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?`,
};
const NUMBER = String.raw`\b(?:0[xXoObB][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`;

const cache = new Map<Language, RegExp>();
function pattern(lang: Exclude<Language, "plain">): RegExp {
  let re = cache.get(lang);
  if (!re) {
    const words = KEYWORDS[lang].split(" ").join("|");
    re = new RegExp(`(${COMMENTS[lang]})|(${STRINGS[lang]})|(${NUMBER})|\\b(${words})\\b`, "g");
    cache.set(lang, re);
  }
  return re;
}

/** Splits `text` into coloured runs; joined back they give `text` exactly. */
export function tokenize(text: string, lang: Language): Token[] {
  if (lang === "plain" || !text) return text ? [{ kind: "plain", text }] : [];
  const re = pattern(lang);
  const out: Token[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "") { re.lastIndex++; continue; }
    if (m.index > last) out.push({ kind: "plain", text: text.slice(last, m.index) });
    out.push({ kind: m[1] ? "comment" : m[2] ? "string" : m[3] ? "number" : "keyword", text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "plain", text: text.slice(last) });
  return out;
}

/** Spaces a Tab key inserts. */
export const indentOf = (lang: Language) => (lang === "python" || lang === "rust" ? "    " : "  ");
