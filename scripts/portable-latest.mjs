// Adds a portable zip to a release's latest.json as windows-<arch>-portable (the entry src-tauri/src/portable.rs updates from)
// and leaves everything else as it was: JSON.parse keeps pub_date as the string it was, and the result is checked before it is written.
//   node scripts/portable-latest.mjs latest.json x86_64 NotNotch-1.0.1-Portable-x64.zip.sig https://github.com/.../NotNotch-1.0.1-Portable-x64.zip
//   node scripts/portable-latest.mjs latest.json aarch64 NotNotch-1.0.1-Portable-arm64.zip.sig https://github.com/.../NotNotch-1.0.1-Portable-arm64.zip
import { readFileSync, writeFileSync } from "node:fs";

const [file, arch, sigFile, url] = process.argv.slice(2);
const fail = (why) => {
  console.error(`portable-latest: ${why}`);
  process.exit(1);
};
if (!file || !arch || !sigFile || !url) fail("usage: portable-latest.mjs <latest.json> <x86_64|aarch64> <zip.sig> <zip url>");
if (arch !== "x86_64" && arch !== "aarch64") fail(`unknown architecture ${arch}`);

const key = `windows-${arch}-portable`;
const text = readFileSync(file, "utf8");
const original = JSON.parse(text);
const latest = JSON.parse(text);
const signature = readFileSync(sigFile, "utf8").trim();
if (!signature) fail("empty signature");
const platforms = Object.keys(original.platforms ?? {});
const installers = platforms.filter((k) => (k === `windows-${arch}` || k.startsWith(`windows-${arch}-`)) && k !== key);
if (!installers.length) fail(`latest.json has no windows-${arch} entry`);

latest.platforms[key] = { signature, url };
const out = `${JSON.stringify(latest, null, 2)}\n`;

const back = JSON.parse(out);
if (typeof original.pub_date === "string" && !out.includes(JSON.stringify(original.pub_date))) fail("pub_date changed");
if (back.pub_date !== original.pub_date || back.version !== original.version) fail("pub_date or version changed");
// Every other entry, the installers of both architectures and the other portable zip, stays byte for byte the same.
for (const k of platforms) if (k !== key && JSON.stringify(back.platforms[k]) !== JSON.stringify(original.platforms[k])) fail(`${k} changed`);
if (Object.keys(back.platforms).length !== new Set([...platforms, key]).size) fail("an entry was added or lost");
if (back.platforms[key]?.signature !== signature || back.platforms[key]?.url !== url) fail("portable entry missing");

writeFileSync(file, out);
console.log(`portable-latest: added ${key}, kept ${platforms.filter((k) => k !== key).join(", ")}`);
