import { useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Copy, Trash, X } from "@phosphor-icons/react";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { createStore } from "../../lib/store";
import { Select } from "../../ui/controls";
import { t } from "../../i18n";
import { LANGUAGES, indentOf, tokenize, type Language, type TokenKind } from "./highlight";

interface Pad { lang: Language; texts: Partial<Record<Language, string>> }
/** One draft per language, saved on every keystroke (localStorage, nothing leaves the PC). */
const pad = createStore<Pad>({ lang: "javascript", texts: {} }, { persist: "scratchpad" });
pad.set((s) => ({ lang: LANGUAGES.includes(s?.lang) ? s.lang : "javascript", texts: typeof s?.texts === "object" && s.texts ? s.texts : {} }));

const names: Record<Language, string> = { javascript: "JavaScript", typescript: "TypeScript", rust: "Rust", python: "Python", plain: "Nur Text" };
const colors: Record<TokenKind, string | undefined> = {
  plain: undefined,
  comment: "var(--color-label-3)",
  string: "var(--color-green)",
  number: "var(--color-orange)",
  keyword: "var(--color-link)",
};
/** The draft taken by the last Clear, for one undo; kept while the notch closes, dropped on the next edit. */
let cleared: { lang: Language; text: string } | null = null;

// Same metrics on the textarea and the coloured copy below it, or the caret drifts.
const TEXT = "font-mono text-[12px] leading-[18px] [tab-size:4] whitespace-pre";

/**
 * A plain textarea over a coloured <pre> with the same text. Both are sized by their content inside one
 * scroller, so nothing has to keep their scroll positions in sync.
 */
export function ScratchpadView() {
  const { lang, texts } = pad.use();
  const text = texts[lang] ?? "";
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [, redraw] = useState(0);
  const canUndo = !text && cleared?.lang === lang;
  const area = useRef<HTMLTextAreaElement>(null);
  const tokens = useMemo(() => tokenize(text, lang), [text, lang]);
  const lines = text.split("\n").length;
  const setText = (v: string) => pad.set((s) => ({ ...s, texts: { ...s.texts, [s.lang]: v } }));

  const edit = (v: string) => {
    cleared = null;
    setText(v);
  };
  const clearOrUndo = () => {
    if (canUndo) {
      setText(cleared!.text);
      cleared = null;
    } else {
      cleared = { lang, text };
      setText("");
    }
    redraw((n) => n + 1);
    area.current?.focus();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied(null), 1600);
  };

  // Escape leaves the field first and stops there, so it does not also close the notch; the next Escape closes.
  // Tab indents instead of leaving the field; with a selection it indents every selected line, Shift+Tab outdents.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      return e.currentTarget.blur();
    }
    if (e.key !== "Tab" || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const el = e.currentTarget, ind = indentOf(lang);
    const { selectionStart: a, value } = el;
    // A selection ending at the start of a line (whole lines picked) leaves that next line alone.
    const b = el.selectionEnd > a && value[el.selectionEnd - 1] === "\n" ? el.selectionEnd - 1 : el.selectionEnd;
    const lineStart = value.lastIndexOf("\n", a - 1) + 1;
    if (a === b && !e.shiftKey) {
      el.setRangeText(ind, a, b, "end");
    } else {
      const block = value.slice(lineStart, b);
      const next = e.shiftKey ? block.replace(new RegExp(`^ {1,${ind.length}}`, "gm"), "") : block.replace(/^/gm, ind);
      el.setRangeText(next, lineStart, b, "select");
    }
    edit(el.value);
  };

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-1">
      <HeaderActions>
        <Select width="w-32" value={lang} onChange={(l) => pad.set((s) => ({ ...s, lang: l }))} options={LANGUAGES.map((l) => ({ value: l, label: t(names[l]) }))} />
        <HeaderButton label={copied === "ok" ? t("Kopiert") : copied === "failed" ? t("Kopieren fehlgeschlagen") : t("Kopieren")} disabled={!text} onClick={() => void copy()}>
          {copied === "ok" ? <Check size={14} weight="bold" /> : copied === "failed" ? <X size={14} weight="bold" className="text-red" /> : <Copy size={14} weight="bold" />}
        </HeaderButton>
        <HeaderButton label={canUndo ? t("Leeren rückgängig") : t("Leeren")} disabled={!text && !canUndo} onClick={clearOrUndo}>
          {canUndo ? <ArrowCounterClockwise size={14} weight="bold" /> : <Trash size={14} weight="bold" />}
        </HeaderButton>
      </HeaderActions>

      <div dir="ltr" className="flex min-h-0 flex-1 overflow-auto rounded-[12px] bg-fill-1 py-2 [scrollbar-width:thin]" onClick={() => area.current?.focus()}>
        <div aria-hidden className={`${TEXT} shrink-0 pr-3 pl-3 text-right text-label-4 select-none`}>
          {Array.from({ length: lines }, (_, i) => `${i + 1}\n`).join("")}
        </div>
        {/* No min-w-0: the box is at least as wide as the longest line, so the textarea covers all of it. */}
        <div className="relative flex-1 pr-3">
          <pre aria-hidden className={`${TEXT} m-0 min-h-full text-label`}>
            {tokens.map((tk, i) => (
              <span key={i} style={{ color: colors[tk.kind] }}>
                {tk.text}
              </span>
            ))}
            {/* A trailing newline needs a character after it to take up its line. */}
            {"\n"}
          </pre>
          <textarea
            ref={area}
            value={text}
            onChange={(e) => edit(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            wrap="off"
            aria-label={t("Code")}
            placeholder={t("Code hier schreiben, wird lokal gespeichert")}
            className={`${TEXT} absolute inset-0 resize-none overflow-hidden bg-transparent text-transparent caret-label outline-none placeholder:text-label-4 selection:bg-link/40`}
          />
        </div>
      </div>
    </div>
  );
}
