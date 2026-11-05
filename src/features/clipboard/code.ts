// Does a copied text look like code? A heuristic over its lines, no parser. Pure.

const KEYWORD = /^\s*(import|export|from|const|let|var|function|def|class|return|if|elif|else|for|while|switch|case|try|catch|finally|fn|pub|impl|use|struct|enum|match|mod|async|await|package|public|private|protected|static|void|int|interface|type|namespace|using|lambda|yield|raise|with|#include|#define|#!)\b/;
const SQL = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\s.+\b(FROM|INTO|SET|TABLE|WHERE|VALUES|AS)\b/;
const OPERATOR = /(=>|===|!==|==|!=|<=|>=|&&|\|\||::|->|\+=|-=|\+\+|--\w|<\/?[a-zA-Z][\w-]*[\s>/])/;
// `name(…)` with no space before the bracket, or `obj.method`.
const CALL = /[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\([^()]*\)/;
const MEMBER = /\b[a-z_$][\w$]*\.[a-z_$][\w$]*\(/i;
const COMMENT = /^\s*(\/\/|\/\*|\*\/|<!--|--\s)/;
// "# " is a Python or shell comment but also a Markdown heading, so it only counts a little.
const HASH = /^\s*# /;
const ENDING = /[;{}]\s*$|^\s*[)\]}][;,)]*\s*$/;
const ASSIGN = /^\s*[A-Za-z_$][\w$.[\]]*\s*[:+\-*/]?=\s*\S/;
// Words that also start English sentences ("go", "make") are left out.
const SHELL = /^\s*(\$ |PS> |sudo |npm |npx |pnpm |yarn |bun |deno |git |cargo |rustup |pip3? |python3? |node |docker |kubectl |curl |wget |cd |ls |mkdir |rm |cp |mv |chmod |ssh |scp |brew |apt(-get)? |winget |choco |dotnet |cmake |gcc |clang )\S/;
const MARKUP = /^\s*<\/?[a-zA-Z][\w-]*(\s[^>]*)?\/?>/;
const URL_ONLY = /^\s*(https?:\/\/|www\.)\S+\s*$/;

/** How code-like one line is: 2 strong, 1 weak, 0 none. */
function lineScore(line: string): number {
  if (!line.trim()) return 0;
  if (COMMENT.test(line) || ENDING.test(line) || SQL.test(line) || MARKUP.test(line) || /^\s*(#include|#define|#pragma|#!\/)/.test(line)) return 2;
  const keyword = KEYWORD.test(line), op = OPERATOR.test(line), call = CALL.test(line) || MEMBER.test(line);
  // An indented line starting with a keyword is a block body (Python has no other punctuation to go by).
  if (keyword && (op || call || /[(){}=:[\]]/.test(line) || (/^(\s{2,}|\t)/.test(line) && /[^\w\s]/.test(line)))) return 2;
  if (op && (call || ASSIGN.test(line))) return 2;
  // `x = …` unless words follow ("Total = 5 apples").
  if (ASSIGN.test(line) && !/\w+\s+[A-Za-z]{2,}/.test(line.slice(line.indexOf("=") + 1))) return 2;
  return keyword || op || call || HASH.test(line) || /^\s{2,}\S|^\t/.test(line) ? 1 : 0;
}

function isJson(s: string): boolean {
  if (!/^[[{]/.test(s) || !/[\]}]$/.test(s)) return false;
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
  } catch {
    return false;
  }
}

/** True for snippets, commands, JSON and markup; false for prose, lists, addresses and bare links. */
export function isCode(text: string): boolean {
  const s = text.trim();
  if (s.length < 4 || URL_ONLY.test(s)) return false;
  if (isJson(s)) return true;
  // The first 200 lines decide; a huge paste costs no more than that.
  const lines = s.split(/\r?\n/, 400).filter((l) => l.trim()).slice(0, 200);
  if (lines.length === 1) {
    const l = lines[0];
    // A sentence ending in a full stop, question or exclamation mark is prose, whatever it mentions.
    if (/[a-z][.?!]["')]?$/i.test(l) && !/[;{}]/.test(l)) return false;
    return SHELL.test(l) || lineScore(l) === 2;
  }
  const scores = lines.map(lineScore);
  const strong = scores.filter((x) => x === 2).length, any = scores.filter((x) => x > 0).length;
  // Most lines look like code, and at least a couple of them clearly.
  return strong >= Math.min(2, lines.length) && any / lines.length >= 0.5 || strong / lines.length >= 0.6;
}
