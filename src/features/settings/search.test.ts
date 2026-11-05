import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, searchSettings, type SearchEntry } from "./search.ts";

const entry = (label: string, hint = "", group = "", en: Partial<SearchEntry["en"]> = {}): SearchEntry => ({
  label,
  hint,
  group,
  en: { label: "", hint: "", group: "", ...en },
});

test("fold drops case and accents, keeps other scripts", () => {
  assert.equal(fold("Schließen-Verzögerung"), "schliessen-verzogerung");
  assert.equal(fold("Thème"), "theme");
  assert.equal(fold("सेटिंग"), "सेटिंग".normalize("NFD"));
});

test("empty query finds nothing", () => {
  assert.deepEqual(searchSettings([entry("Sprache")], "  "), []);
});

test("every word must appear in label, hint or group", () => {
  const rows = [entry("Lautstärke", "Wie laut der Alarm klingt", "Alarm"), entry("Dauer", "Wie lange der Alarm klingelt")];
  assert.deepEqual(searchSettings(rows, "alarm laut").map((r) => r.label), ["Lautstärke"]);
  assert.deepEqual(searchSettings(rows, "ALARM").length, 2);
  assert.deepEqual(searchSettings(rows, "alarm mute"), []);
});

test("accent and case insensitive both ways", () => {
  const rows = [entry("Schließen-Verzögerung")];
  assert.equal(searchSettings(rows, "verzogerung").length, 1);
  assert.equal(searchSettings(rows, "SCHLIESSEN").length, 1);
});

test("English text matches when the interface is in another language", () => {
  const rows = [entry("Themen", "", "", { label: "Themes" }), entry("Sprache", "", "", { label: "Language" })];
  assert.deepEqual(searchSettings(rows, "theme").map((r) => r.label), ["Themen"]);
});

test("label matches rank above hint and group matches, ties keep order", () => {
  const rows = [
    entry("Dauer", "Wie lange der Alarm klingelt"),
    entry("Statusmeldungen", "", "Alarm"),
    entry("Alarm-Ton"),
    entry("Alarm aus", "Alarm"),
  ];
  assert.deepEqual(searchSettings(rows, "alarm").map((r) => r.label), ["Alarm-Ton", "Alarm aus", "Dauer", "Statusmeldungen"]);
});

test("more query words in the label rank higher", () => {
  const rows = [entry("Fokus", "Darstellung der Notch"), entry("Fokus-Darstellung")];
  assert.deepEqual(searchSettings(rows, "fokus darstellung").map((r) => r.label), ["Fokus-Darstellung", "Fokus"]);
});
