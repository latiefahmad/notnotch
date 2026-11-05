import { test } from "node:test";
import assert from "node:assert/strict";
import { offersSources, sourceName, sourceRows } from "./sources.ts";

test("names for media app IDs", () => {
  assert.equal(sourceName("Spotify.exe"), "Spotify");
  assert.equal(sourceName("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
  assert.equal(sourceName("AppleInc.AppleMusicWin_nzyj5cx40ttqa!App"), "Apple Music");
  assert.equal(sourceName("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
  assert.equal(sourceName("Chrome"), "Chrome");
  assert.equal(sourceName("MSEdge"), "Edge");
  assert.equal(sourceName("308046B0AF4A39CB"), "Firefox");
  assert.equal(sourceName("vlc.exe"), "VLC");
  assert.equal(sourceName("Foo.BarPlayer_abc123!App"), "Bar Player");
  assert.equal(sourceName("C:\\Apps\\cool_player.exe"), "Cool player");
  assert.equal(sourceName(""), "");
});

const spotify = { appId: "Spotify.exe", isPlaying: false };
const chrome = { appId: "Chrome", isPlaying: true };

test("menu rows", () => {
  const auto = sourceRows([spotify, chrome], null);
  assert.deepEqual(auto.map((r) => [r.appId, r.checked, r.running]), [[null, true, true], ["Spotify.exe", false, true], ["Chrome", false, true]]);
  assert.equal(auto[2].isPlaying, true);
  const pinned = sourceRows([spotify, chrome], "Spotify.exe");
  assert.deepEqual(pinned.map((r) => r.checked), [false, true, false]);
  // A pinned app that is gone stays listed, checked, so the pin can be seen and undone.
  const gone = sourceRows([chrome], "Spotify.exe");
  assert.deepEqual(gone.map((r) => [r.appId, r.checked, r.running]), [[null, false, true], ["Chrome", false, true], ["Spotify.exe", true, false]]);
});

test("when the menu is offered", () => {
  assert.equal(offersSources([], null), false);
  assert.equal(offersSources([chrome], null), false);
  assert.equal(offersSources([chrome], "Chrome"), false);
  assert.equal(offersSources([spotify, chrome], null), true);
  assert.equal(offersSources([chrome], "Spotify.exe"), true);
  assert.equal(offersSources([], "Spotify.exe"), true);
});
