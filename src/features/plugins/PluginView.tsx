import { useEffect, useRef } from "react";
import { PuzzlePiece } from "@phosphor-icons/react";
import { isNative } from "../../platform/native";
import { pluginApi } from "../../platform/services";
import { requestSize, sizeOverride } from "../../notch/size";
import { activeTheme } from "../themes/store";
import { receivePluginNotice } from "../notices/store";
import { lang, t } from "../../i18n";
import { Empty } from "../../ui/controls";
import { API, allowNotice, clampSize, pageUrl, parseRequest, permitted, plainText, toolId, type PluginManifest, type PluginRequest } from "./model";

/** The theme tokens a page gets: NotNotch's colour variables by their short name, and the font. */
const TOKENS = ["accent", "label", "label-2", "label-3", "label-4", "fill-1", "fill-2", "fill-3", "separator", "elevated", "notch", "link", "green", "orange", "red", "yellow"];

function themeTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const out: Record<string, string> = Object.fromEntries(TOKENS.map((k) => [k, style.getPropertyValue(`--color-${k}`).trim()]));
  out.font = getComputedStyle(document.body).fontFamily;
  return out;
}

/** Fetches one plugin page may have running at once. */
const MAX_FETCHES = 4;

/** Answers one checked request. Errors are short codes the page gets as the message of a rejected promise. */
function handler(m: PluginManifest) {
  const notices: number[] = [];
  let fetching = 0;
  return async (req: PluginRequest): Promise<unknown> => {
    if (!permitted(req, m)) throw "permission";
    switch (req.type) {
      case "hello":
        return { api: API, plugin: { id: m.id, name: m.name, version: m.version }, permissions: m.permissions, theme: themeTokens(), language: lang() };
      case "theme":
        return themeTokens();
      case "storage.keys":
        return pluginApi.storage(m.id, { op: "keys" });
      case "storage.get":
        return pluginApi.storage(m.id, { op: "get", key: req.key });
      case "storage.remove":
        return pluginApi.storage(m.id, { op: "remove", key: req.key });
      case "storage.set":
        return pluginApi.storage(m.id, { op: "set", key: req.key, value: req.value });
      case "fetch": {
        if (fetching >= MAX_FETCHES) throw "busy";
        fetching++;
        try {
          return await pluginApi.fetch(m.id, { url: req.url, method: req.method, headers: req.headers, body: req.body });
        } finally {
          fetching--;
        }
      }
      case "notify": {
        const title = plainText(req.title);
        if (!title) throw "bad-field";
        if (!allowNotice(notices, Date.now())) throw "rate-limited";
        receivePluginNotice({ source: "plugin", appId: toolId(m.id), appName: m.name, title, body: plainText(req.body ?? ""), at: Date.now() });
        return null;
      }
      case "resize": {
        const size = clampSize(req.w, req.h);
        requestSize(toolId(m.id), size);
        return size;
      }
    }
  };
}

/**
 * A plugin's page in a sandboxed frame: scripts run, but with an opaque origin, so it reaches nothing of NotNotch's
 * (no storage, no cookies, no Tauri bridge). Messages count only when they come from this frame's window; each is
 * checked (model.ts) before anything runs. The page loads fresh each time the tool opens.
 */
export function PluginView({ manifest }: { manifest: PluginManifest }) {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const handle = handler(manifest);
    const post = (msg: unknown) => el.contentWindow?.postMessage(msg, "*");
    const onMessage = (e: MessageEvent) => {
      if (!el.contentWindow || e.source !== el.contentWindow) return;
      const parsed = parseRequest(e.data);
      if (parsed.kind === "ignore") return;
      if (parsed.kind === "error") return post({ notnotch: API, id: parsed.id, ok: false, error: parsed.error });
      handle(parsed.req).then(
        (result) => post({ notnotch: API, id: parsed.id, ok: true, result: result ?? null }),
        (error) => post({ notnotch: API, id: parsed.id, ok: false, error: String(error).slice(0, 64) }),
      );
    };
    window.addEventListener("message", onMessage);
    // The theme's variables are set in the same tick as the store; read them a frame later.
    const offTheme = activeTheme.subscribe(() => requestAnimationFrame(() => post({ notnotch: API, event: "theme", data: themeTokens() })));
    const tool = toolId(manifest.id);
    return () => {
      window.removeEventListener("message", onMessage);
      offTheme();
      if (sizeOverride.get()?.tabId === tool) requestSize(tool, null);
    };
  }, [manifest]);

  if (!isNative) return <Empty icon={PuzzlePiece} title={t("Plugins laufen nur in der App")} />;
  return (
    <iframe
      ref={frame}
      src={pageUrl(manifest)}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={manifest.name}
      className="block h-full w-full border-0 bg-transparent"
    />
  );
}
