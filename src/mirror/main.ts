import "../styles/global.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MirrorPicture } from "../platform/services";

/*
 * Entry of a copy of the closed notch on another monitor ("All monitors", mirror.html, src-tauri/src/mirror.rs). No React and
 * no stores: it only draws the markup the notch window sends (src/notch/mirror.ts) with the same styles. The window is
 * click-through; Rust reads the pointer over it and moves the notch here.
 */

const root = document.getElementById("root")!;
let images: string[] = [];
let fresh = false;

function show(p: MirrorPicture) {
  const doc = document.documentElement;
  doc.style.cssText = p.root;
  if (p.theme) doc.dataset.theme = p.theme;
  if (p.images) images = p.images;
  // Markup the notch window serialized from its own DOM (text and attributes come escaped), shown under the same CSP.
  root.innerHTML = p.html;
  for (const img of root.querySelectorAll<HTMLImageElement>("img[data-mirror-img]")) {
    const src = images[Number(img.dataset.mirrorImg)];
    if (src) img.src = src;
  }
}

void listen<MirrorPicture>("mirror://picture", (e) => {
  fresh = true;
  show(e.payload);
});
// The picture sent before this page loaded; a newer one may already be here.
void invoke<MirrorPicture>("mirror_picture").then((p) => {
  if (!fresh && p.html) show(p);
});
