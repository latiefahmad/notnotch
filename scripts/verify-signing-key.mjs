#!/usr/bin/env node
// The app installs only what was signed with the key whose public half it ships (src-tauri/tauri.conf.json →
// plugins.updater.pubkey): the updater compares the minisign key id before it runs a package, so a release signed
// with another key — a wrong or rotated repository secret — is refused by every installed copy as unverifiable.
// The release workflow runs this before the release becomes the latest one, which is what the updater reads.
//
//   node scripts/verify-signing-key.mjs latest.json   every platform entry of the update manifest
//   node scripts/verify-signing-key.mjs app.exe.sig   one signature, e.g. made with a candidate private key
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The 8-byte minisign key id: "untrusted comment: …\n<base64 of algorithm(2) | key id(8) | key or signature>". */
function keyId(base64) {
  const line = Buffer.from(base64, "base64")
    .toString("utf8")
    .split("\n")
    .find((l) => l && !l.startsWith("untrusted comment:"));
  return line ? Buffer.from(line.trim(), "base64").subarray(2, 10).toString("hex") : null;
}

const conf = JSON.parse(readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8"));
const expected = keyId(conf.plugins?.updater?.pubkey ?? "");
const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/verify-signing-key.mjs <latest.json|file.sig>");
  process.exit(2);
}

const text = readFileSync(file, "utf8");
const signatures = file.endsWith(".json")
  ? Object.entries(JSON.parse(text).platforms ?? {}).map(([target, entry]) => [target, entry.signature])
  : [[file, text]];
const wrong = signatures.filter(([, signature]) => keyId(signature) !== expected).map(([target]) => target);

if (!expected || !signatures.length || wrong.length) {
  const signed = wrong.length ? wrong.join(", ") : file;
  console.error(
    `::error::${signed} does not match the key the app accepts (${expected ?? "no plugins.updater.pubkey in tauri.conf.json"}). ` +
      "Set the repository secret TAURI_SIGNING_PRIVATE_KEY to the private key of that public key and build the release again.",
  );
  process.exit(1);
}
console.log(`${signatures.length} updater signature${signatures.length === 1 ? "" : "s"} match the app's public key (${expected}).`);
