import { useEffect, type RefObject } from "react";
import { isNative } from "../platform/native";
import { display } from "../platform/services";
import { settings } from "../settings/store";

/*
 * "All monitors": the other monitors show a copy of the closed notch (src-tauri/src/mirror.rs, page mirror.html). This window
 * stays the only one that runs the app; while the notch is closed it sends its markup, a few times a second while it changes
 * (an equalizer moves every frame), and the copies draw it with the same styles. Images go only when they change.
 */

const EVERY_MS = 250;

/** The markup of `root` with its `data:` images taken out by index (mirror.rs Picture), so a cover is not sent four times a second. */
export function picture(root: Element): { html: string; images: string[] } {
  const copy = root.cloneNode(true) as Element;
  const images: string[] = [];
  copy.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (!src?.startsWith("data:")) return;
    img.setAttribute("data-mirror-img", String(images.push(src) - 1));
    img.removeAttribute("src");
  });
  return { html: copy.outerHTML, images };
}

/** Sends the closed notch under `root` to the copies while `closed` (closed, not peeking, and not changed by a window rule). */
export function useMirror(root: RefObject<HTMLElement | null>, closed: boolean) {
  const all = settings.use().display.monitorMode === "all";
  useEffect(() => {
    if (!isNative || !all || !closed) return;
    let last = "";
    let sent: string[] | null = null;
    const take = () => {
      const el = root.current, hit = el?.querySelector("[data-notch-hit]");
      if (!el || !hit) return;
      const { html, images } = picture(el);
      const doc = document.documentElement, css = doc.style.cssText, theme = doc.dataset.theme ?? "";
      const same = sent !== null && images.length === sent.length && images.every((src, i) => src === sent![i]);
      const key = `${theme}|${css}|${html}`;
      if (key === last && same) return;
      last = key;
      sent = images;
      const r = hit.getBoundingClientRect();
      display.mirror({ html, root: css, theme, images: same ? null : images }, { x: r.x, y: r.y, w: r.width, h: r.height });
    };
    take();
    const id = window.setInterval(take, EVERY_MS);
    return () => window.clearInterval(id);
  }, [all, closed, root]);
}
