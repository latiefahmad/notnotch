import { test } from "node:test";
import assert from "node:assert/strict";
import { aiKey, detectAi, mergeApps, moveFavorite, normalizeFavorites, searchApps, toggleFavorite, type LauncherApp } from "./apps.ts";

const start = (name: string, id = `shell:AppsFolder\\${name}`): LauncherApp => ({ id, name, source: "start" });
const path = (name: string, id: string): LauncherApp => ({ id, name, source: "apppaths" });

test("ai detection by name", () => {
  for (const n of ["Claude", "ChatGPT", "Copilot", "Microsoft Copilot", "Cursor", "Codex", "Perplexity", "Gemini", "Windsurf", "LM Studio", "Ollama", "Jan"]) assert.ok(aiKey({ name: n }), n);
  for (const n of ["Uninstall Claude", "Cursor Help", "Notepad", "January Planner", "GitHub Copilot Chat Extension", "Visual Studio Code"]) assert.equal(aiKey({ name: n }), null, n);
  assert.equal(aiKey({ name: "Microsoft Copilot" }), "copilot");
  assert.equal(aiKey({ name: "  claude  " }), "claude");
});

test("merge keeps start entries and adds AI apps only found in App Paths", () => {
  const list = mergeApps([
    start("Notepad"),
    start("Uninstall Cursor"),
    start("Claude"),
    path("Claude", "C:\\Claude\\claude.exe"),
    path("Cursor", "C:\\Cursor\\cursor.exe"),
    path("Excel", "C:\\Office\\excel.exe"),
    start(" "),
    start("Notepad"),
  ]);
  assert.deepEqual(
    list.map((a) => [a.name, a.source]),
    [
      ["Claude", "start"],
      ["Cursor", "apppaths"],
      ["Notepad", "start"],
    ],
  );
});

test("detect one entry per app", () => {
  const apps = mergeApps([start("ChatGPT"), start("ChatGPT Classic", "x"), start("Gemini"), start("Paint")]);
  assert.deepEqual(detectAi(apps).map((a) => a.name), ["ChatGPT", "Gemini"]);
});

test("search ranks AI apps and name starts first", () => {
  const apps = [start("Paint"), start("Paint 3D"), start("Snipping Tool"), start("Perplexity"), start("Claude")];
  assert.deepEqual(searchApps(apps, "").map((a) => a.name), ["Perplexity", "Claude", "Paint", "Paint 3D", "Snipping Tool"]);
  assert.deepEqual(searchApps(apps, "pai").map((a) => a.name), ["Paint", "Paint 3D"]);
  assert.deepEqual(searchApps(apps, "3d paint").map((a) => a.name), ["Paint 3D"]);
  assert.deepEqual(searchApps(apps, "t", 2).map((a) => a.name), ["Perplexity", "Paint"]);
});

test("saved favourites are repaired", () => {
  assert.equal(normalizeFavorites(undefined), null);
  assert.equal(normalizeFavorites("x"), null);
  assert.deepEqual(normalizeFavorites([]), []);
  assert.deepEqual(
    normalizeFavorites([{ id: "a", name: "A", extra: 1 }, null, { id: 3, name: "B" }, { id: "a", name: "A again" }, { id: "", name: "C" }, { id: "d", name: "D" }]),
    [
      { id: "a", name: "A" },
      { id: "d", name: "D" },
    ],
  );
});

test("move favourite", () => {
  const favs = ["a", "b", "c"].map((id) => ({ id, name: id }));
  const ids = (f: { id: string }[]) => f.map((x) => x.id).join("");
  assert.equal(ids(moveFavorite(favs, 0, 1)), "bac");
  assert.equal(ids(moveFavorite(favs, 2, -1)), "acb");
  assert.equal(ids(moveFavorite(favs, 0, -1)), "abc");
  assert.equal(ids(moveFavorite(favs, 2, 1)), "abc");
  assert.equal(ids(moveFavorite(favs, 5, -1)), "abc");
  assert.equal(ids(favs), "abc");
});

test("toggle favourite", () => {
  const a = start("Claude"), b = start("Cursor");
  let favs = toggleFavorite([], a);
  favs = toggleFavorite(favs, b);
  assert.deepEqual(favs.map((f) => f.name), ["Claude", "Cursor"]);
  assert.deepEqual(toggleFavorite(favs, a).map((f) => f.name), ["Cursor"]);
});
