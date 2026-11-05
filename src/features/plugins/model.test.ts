import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ICON_NAMES, NOTICE_MAX, NOTICE_WINDOW_MS, allowNotice, clampSize, parseRequest, permitted, plainText, pluginOf, toolId, type PluginManifest } from "./model.ts";

const msg = (o: Record<string, unknown>) => parseRequest({ notnotch: 1, id: 7, ...o });

test("not a NotNotch message is ignored", () => {
  for (const bad of [null, "x", 1, [], { notnotch: 2, id: 1, type: "hello" }, { id: 1, type: "hello" }, { notnotch: 1, type: "hello" }, { notnotch: 1, id: -1, type: "hello" },
    { notnotch: 1, id: 1.5, type: "hello" }, { notnotch: 1, id: "", type: "hello" }, { notnotch: 1, id: "x".repeat(65), type: "hello" }, new Map()]) {
    assert.deepEqual(parseRequest(bad), { kind: "ignore" }, JSON.stringify(bad));
  }
  // A class instance is not a plain message.
  class Fake { notnotch = 1; id = 1; type = "hello"; }
  assert.deepEqual(parseRequest(new Fake()), { kind: "ignore" });
});

test("unknown types and fields are refused", () => {
  assert.deepEqual(msg({ type: "readFile", path: "C:/x" }), { kind: "error", id: 7, error: "unknown-type" });
  assert.deepEqual(msg({ type: "__proto__" }), { kind: "error", id: 7, error: "unknown-type" });
  assert.deepEqual(msg({ type: "toString" }), { kind: "error", id: 7, error: "unknown-type" });
  assert.deepEqual(msg({ type: 5 }), { kind: "error", id: 7, error: "unknown-type" });
  assert.deepEqual(msg({ type: "hello", plugin: "other" }), { kind: "error", id: 7, error: "bad-field" });
  assert.deepEqual(msg({ type: "storage.get", key: "a", id2: 1 }), { kind: "error", id: 7, error: "bad-field" });
});

test("fields are checked", () => {
  assert.equal(msg({ type: "hello" }).kind, "ok");
  assert.equal(parseRequest({ notnotch: 1, id: "a-1", type: "theme" }).kind, "ok");
  assert.equal(msg({ type: "storage.get", key: "count" }).kind, "ok");
  for (const key of ["", 1, null, "k".repeat(129)]) assert.equal(msg({ type: "storage.get", key }).kind, "error", String(key));
  assert.equal(msg({ type: "storage.set", key: "a" }).kind, "error", "a value is needed");
  assert.equal(msg({ type: "storage.set", key: "a", value: "x".repeat(40_000) }).kind, "error", "value over the cap");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(msg({ type: "storage.set", key: "a", value: cyclic }).kind, "error");
  const set = msg({ type: "storage.set", key: "a", value: { at: new Date(0), n: 1 } });
  assert.ok(set.kind === "ok" && set.req.type === "storage.set");
  if (set.kind === "ok" && set.req.type === "storage.set") assert.deepEqual(set.req.value, { at: "1970-01-01T00:00:00.000Z", n: 1 });
  assert.equal(msg({ type: "fetch", url: "https://api.github.com/zen" }).kind, "ok");
  assert.equal(msg({ type: "fetch", url: "https://x", method: "POST", headers: { accept: "text/plain" }, body: "{}" }).kind, "ok");
  assert.equal(msg({ type: "fetch", url: "https://x", method: "TRACE" }).kind, "error");
  assert.equal(msg({ type: "fetch", url: "https://x", headers: { a: 1 } }).kind, "error");
  assert.equal(msg({ type: "fetch", url: "https://x", headers: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`h${i}`, "v"])) }).kind, "error");
  assert.equal(msg({ type: "fetch", url: "https://x", body: "x".repeat(70_000) }).kind, "error");
  assert.equal(msg({ type: "fetch" }).kind, "error");
  assert.equal(msg({ type: "notify", title: "Done" }).kind, "ok");
  assert.equal(msg({ type: "notify", title: "" }).kind, "error");
  assert.equal(msg({ type: "notify", title: "x".repeat(81) }).kind, "error");
  assert.equal(msg({ type: "resize", w: 400, h: 300 }).kind, "ok");
  assert.equal(msg({ type: "resize", w: Infinity, h: 300 }).kind, "error");
  assert.equal(msg({ type: "resize", w: "400", h: 300 }).kind, "error");
});

test("permissions", () => {
  const m: PluginManifest = { id: "a-b", name: "A", version: "1.0.0", author: "", description: "", icon: "puzzle", entry: "index.html", size: { w: 400, h: 300 }, permissions: { network: [], storage: false, notices: false } };
  const req = (o: Record<string, unknown>) => { const p = msg(o); assert.equal(p.kind, "ok"); return (p as { req: never }).req; };
  assert.equal(permitted(req({ type: "hello" }), m), true);
  assert.equal(permitted(req({ type: "storage.keys" }), m), false);
  assert.equal(permitted(req({ type: "fetch", url: "https://x" }), m), false);
  assert.equal(permitted(req({ type: "notify", title: "x" }), m), false);
  const all = { ...m, permissions: { network: ["x.com"], storage: true, notices: true } };
  assert.equal(permitted(req({ type: "storage.keys" }), all), true);
  assert.equal(permitted(req({ type: "fetch", url: "https://x" }), all), true);
  assert.equal(permitted(req({ type: "notify", title: "x" }), all), true);
});

test("sizes, ids, notices, text", () => {
  assert.deepEqual(clampSize(10, 10_000), { w: 320, h: 540 });
  assert.deepEqual(clampSize(500.4, 300.6), { w: 500, h: 301 });
  assert.equal(toolId("hello-notnotch"), "plugin:hello-notnotch");
  assert.equal(pluginOf("plugin:hello-notnotch"), "hello-notnotch");
  assert.equal(pluginOf("timer"), null);
  const times: number[] = [];
  for (let i = 0; i < NOTICE_MAX; i++) assert.equal(allowNotice(times, i), true);
  assert.equal(allowNotice(times, 10), false);
  assert.equal(allowNotice(times, NOTICE_WINDOW_MS), true);
  assert.equal(plainText(" a\u{202E}b\nc\u{0007} "), "a b c");
});

test("icon names match the Rust list", () => {
  const rust = readFileSync(new URL("../../../src-tauri/src/notify_wire.rs", import.meta.url), "utf8");
  const block = /pub const ICONS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)![1];
  assert.deepEqual([...block.matchAll(/"([a-z]+)"/g)].map((m) => m[1]), [...ICON_NAMES]);
});
