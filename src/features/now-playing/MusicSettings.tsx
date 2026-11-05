import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CaretUp } from "@phosphor-icons/react";
import { settings } from "../../settings/store";
import { isNative } from "../../platform/native";
import { Button, Group, Row, Segmented, Switch } from "../../ui/controls";
import { providerInfo } from "../ask/providers";
import { sourceName } from "./sources";
import { LYRIC_SOURCES } from "./lyricSources";
import { setMusic } from "./music";
import { t } from "../../i18n";

const TERMS: Record<string, string> = {
  lrclib: "Offene Community-Datenbank, freie API ohne Schlüssel",
  kugou: "Inoffizielle API ohne Konto; Wort-Timing, Übersetzungen und Lautschrift",
  netease: "Inoffizielle API ohne Konto; Übersetzungen und Lautschrift",
};

/** Settings > Display > Music: lyrics in the closed notch, the equalizer and progress bar looks, undoing a pinned player, and the lyrics sources and extras. */
export function MusicSettings() {
  const s = settings.use();
  const music = s.music;
  const sources = music.lyricSources;
  const moveUp = (i: number) => setMusic({ lyricSources: [...sources.slice(0, i - 1), sources[i], sources[i - 1], ...sources.slice(i + 1)] });
  return (
    <>
      <Group title={t("Musik")} id="settings-music">
        <Row label={t("Songtext in der geschlossenen Notch")} hint={t("Zeigt beim Abspielen nur Cover und die aktuelle Zeile, die Notch passt sich jeder Zeile an")}>
          <Switch label={t("Songtext in der geschlossenen Notch")} checked={music.notchLyrics} onChange={(notchLyrics) => setMusic({ notchLyrics })} />
        </Row>
        <Row label={t("Equalizer-Stil")} hint={t("Im Musik-Tool; die geschlossene Notch behält ihre vier Balken")}>
          <Segmented
            id="music-eq-style"
            value={music.eqStyle}
            options={[
              { value: "bars", label: t("Balken") },
              { value: "spectrum", label: t("Spektrum") },
              { value: "wave", label: t("Welle") },
            ]}
            onChange={(eqStyle) => setMusic({ eqStyle })}
          />
        </Row>
        <Row label={t("Fortschrittsbalken")} hint={t("Wellig schwingt beim Abspielen und wird bei Pause flach")}>
          <Segmented
            id="music-progress-style"
            value={music.progressStyle}
            options={[
              { value: "line", label: t("Linie") },
              { value: "wavy", label: t("Wellig") },
            ]}
            onChange={(progressStyle) => setMusic({ progressStyle })}
          />
        </Row>
        {music.pinned && (
          <Row label={t("Angehefteter Player")} hint={t("{app} bleibt in der Notch, auch wenn eine andere App spielt", { app: sourceName(music.pinned) })}>
            <Button onClick={() => setMusic({ pinned: null })}>{t("Lösen")}</Button>
          </Row>
        )}
      </Group>
      <Group title={t("Songtexte")} id="settings-lyrics">
        <Row label={t("Quellen")} hint={t("Werden von oben nach unten gefragt, bis eine den Song hat. Gesendet werden nur Titel, Interpret und Länge, und nur wenn Songtexte an sind.")} />
        {sources.map((src, i) => {
          const info = LYRIC_SOURCES.find((x) => x.id === src.id)!;
          return (
            <Row key={src.id} label={`${i + 1}. ${info.name}`} hint={`${info.host} · ${t(TERMS[src.id])}`}>
              <div className="flex items-center gap-1.5">
                <button
                  aria-label={t("Nach oben")}
                  title={t("Nach oben")}
                  disabled={i === 0}
                  onClick={() => moveUp(i)}
                  className="pressable flex size-6 items-center justify-center rounded-full text-label-3 hover:bg-fill-2 hover:text-label-2 disabled:opacity-30"
                >
                  <CaretUp size={12} weight="bold" />
                </button>
                <Switch label={info.name} checked={src.on} onChange={(on) => setMusic({ lyricSources: sources.map((x) => (x.id === src.id ? { ...x, on } : x)) })} />
              </div>
            </Row>
          );
        })}
        <Row label={t("Wort für Wort")} hint={t("Hebt die gesungenen Wörter hervor, wenn die Quelle jedes Wort timt (meist Kugou)")}>
          <Switch label={t("Wort für Wort")} checked={music.lyricWords} onChange={(lyricWords) => setMusic({ lyricWords })} />
        </Row>
        <Row label={t("Übersetzung")} hint={t("Eine Zeile unter jeder Zeile, wenn die Quelle eine Übersetzung hat")}>
          <Switch label={t("Übersetzung")} checked={music.lyricTranslation} onChange={(lyricTranslation) => setMusic({ lyricTranslation })} />
        </Row>
        {music.lyricTranslation && (
          <Row
            label={t("Mit Ask übersetzen")}
            hint={t("Songs ohne Übersetzung gehen einmal an {p} mit deinem Schlüssel; die Antwort bleibt pro Song gespeichert", { p: providerInfo[s.ask.provider].label })}
          >
            <Switch label={t("Mit Ask übersetzen")} checked={music.lyricAskTranslation} onChange={(lyricAskTranslation) => setMusic({ lyricAskTranslation })} />
          </Row>
        )}
        <Row label={t("Lautschrift")} hint={t("Japanisch, Chinesisch und Koreanisch in lateinischen Buchstaben, offline; von der Quelle, wenn sie eine hat")}>
          <Switch label={t("Lautschrift")} checked={music.lyricRoman} onChange={(lyricRoman) => setMusic({ lyricRoman })} />
        </Row>
        {music.lyricRoman && <KanjiDictionary />}
      </Group>
    </>
  );
}

/** Download and removal of the kanji reading dictionary (src-tauri/src/romanize.rs). */
function KanjiDictionary() {
  const [size, setSize] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (isNative) void invoke<number>("lyrics_dict_status").then(setSize).catch(() => setSize(0));
  }, []);
  const run = (cmd: "lyrics_dict_download" | "lyrics_dict_remove") => {
    setBusy(true);
    setError(false);
    invoke<number | null>(cmd)
      .then((n) => setSize(n ?? 0))
      .catch(() => setError(true))
      .finally(() => setBusy(false));
  };
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  const hint = error
    ? t("Download fehlgeschlagen, später noch einmal versuchen")
    : size
      ? t("Installiert, {mb} MB im App-Datenordner. Lesungen nach Wörterbuch, nicht immer wie gesungen.", { mb: mb(size) })
      : t("Ohne Wörterbuch bekommen nur Kana Lautschrift. JMdict (EDRDG, CC BY-SA 4.0): 1,4 MB Download von GitHub, etwa 0,7 MB auf der Festplatte.");
  return (
    <Row label={t("Kanji-Wörterbuch")} hint={hint}>
      {isNative && size !== null && (
        <Button disabled={busy} onClick={() => run(size ? "lyrics_dict_remove" : "lyrics_dict_download")}>
          {size ? t("Entfernen") : t("Laden")}
        </Button>
      )}
    </Row>
  );
}
