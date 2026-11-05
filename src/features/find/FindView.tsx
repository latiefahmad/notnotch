import { useEffect, useMemo, useState } from "react";
import { Crosshair, MagnifyingGlass } from "@phosphor-icons/react";
import { capture } from "../../platform/services";
import { Button, Skeleton, TextField } from "../../ui/controls";
import { t } from "../../i18n";
import { matchLine, queryWords } from "./match";
import { forgetScreens, found, scanScreens } from "./store";

const MAX_RESULTS = 60;

const errors: Record<string, string> = {
  timeout: "Das Lesen hat zu lange gedauert",
  "no-ocr": "Windows hat keine Texterkennung für deine Sprachen",
};

/**
 * Find on screen, opened by its shortcut: the screens are read once on opening, the query filters the lines.
 *   [🔍 Search the screens …          ] [Read again]
 *   Invoice [number] 2026-1104      Display 2   ⌖
 */
export function FindView() {
  const f = found.use();
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  // The text lives only while the page is open.
  useEffect(() => {
    scanScreens();
    return forgetScreens;
  }, []);

  const words = useMemo(() => queryWords(query), [query]);
  const results = useMemo(() => {
    const out = [];
    for (const [i, line] of f.lines.entries()) {
      const segments = matchLine(line.text, words);
      if (segments) out.push({ i, line, segments });
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  }, [f.lines, words]);

  const copy = (i: number, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(i);
      window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 1200);
    });
  };

  const status =
    f.phase === "reading"
      ? null
      : f.phase === "error"
        ? t(errors[f.error ?? ""] ?? "Bildschirme nicht lesbar")
        : !f.lines.length
          ? t("Kein Text auf den Bildschirmen erkannt")
          : !words.length
            ? t("Erkannte Zeilen: {n}", { n: f.lines.length })
            : !results.length
              ? t("Nichts gefunden")
              : null;

  return (
    <div className="flex h-full flex-col gap-2 px-4 pt-1 pb-2">
      <div className="flex items-center gap-2">
        <MagnifyingGlass size={14} weight="bold" className="shrink-0 text-label-3" />
        <TextField
          value={query}
          onChange={setQuery}
          placeholder={t("Auf den Bildschirmen suchen")}
          width="flex-1"
          autoFocus
          onSubmit={() => results[0] && copy(results[0].i, results[0].line.text)}
        />
        <Button onClick={scanScreens} disabled={f.phase === "reading"}>
          {t("Erneut lesen")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-[12px] bg-fill-1 [scrollbar-width:none]">
        {f.phase === "reading" ? (
          <div className="flex flex-col gap-2 p-3" aria-label={t("Lese die Bildschirme …")}>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : status ? (
          <div className="p-3 text-caption text-label-3">{status}</div>
        ) : (
          results.map(({ i, line, segments }) => (
            <div key={i} className="flex h-9 items-center hover:bg-fill-2">
              <button title={t("Kopieren")} onClick={() => copy(i, line.text)} className="flex h-full min-w-0 flex-1 items-center gap-2.5 ps-3 text-start">
                <span className="min-w-0 flex-1 truncate text-body text-label-2">
                  {segments.map((s, k) =>
                    s.hit ? (
                      <mark key={k} className="rounded-[3px] bg-orange/25 text-label">
                        {s.text}
                      </mark>
                    ) : (
                      <span key={k}>{s.text}</span>
                    ),
                  )}
                </span>
                <span className={`shrink-0 text-caption ${copied === i ? "text-green" : "text-label-3"}`}>
                  {copied === i ? t("Kopiert") : t("Bildschirm {n}", { n: line.monitor + 1 })}
                </span>
              </button>
              <button
                aria-label={t("Auf dem Bildschirm zeigen")}
                title={t("Auf dem Bildschirm zeigen")}
                onClick={() => capture.findHighlight(line.rect)}
                className="pressable me-1 p-2 text-label-3 hover:text-label"
              >
                <Crosshair size={14} weight="bold" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
