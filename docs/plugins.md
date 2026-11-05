# Plugins

A plugin is a small web page that NotNotch shows as a tool in the open notch, with its own icon in the tool bar. It is plain HTML, CSS and JavaScript in a folder, with a `notnotch-plugin.json` that says what it is and what it may do. NotNotch runs it isolated from everything else: it cannot read your files, keys, vault, clipboard, settings or other plugins, and it can reach the network only through NotNotch, only to the addresses it declares.

A working example is in [`examples/plugins/hello-notnotch`](../examples/plugins/hello-notnotch): a countdown kept in the plugin's storage and a line from GitHub's zen endpoint.

## Installing

**Settings → Plugins → Folder …** or **ZIP …** picks a plugin folder or a `.zip` of one (the files at the top of the archive, or in one folder at the top). NotNotch reads and checks every file first, then shows the plugin's name, version, author and description and exactly what it asks for:

- the addresses it may fetch from, or no network at all;
- whether it keeps its own data on this PC;
- whether it may show notices in the closed notch.

Nothing is installed until you press **Install**. Installing the same id again replaces the files and keeps the plugin's data; NotNotch says which version it replaces. The plugin then appears in the tool bar, can be switched off there or in **Settings → Tools** like any tool, and **Remove with its data** in **Settings → Plugins** deletes its files and its storage.

Plugins live in the `plugins` folder of NotNotch's data folder (`%APPDATA%\io.github.latiefahmad.notnotch\plugins\<id>`, or `data\plugins\<id>` next to a portable NotNotch.exe), and their storage in `plugin-data\<id>` beside it.

## The folder

```text
hello-notnotch/
  notnotch-plugin.json
  index.html
  app.js
  style.css
```

```json
{
  "id": "hello-notnotch",
  "name": "Hello NotNotch",
  "version": "1.0.0",
  "author": "latiefahmad",
  "description": "A countdown kept in the plugin's own storage and a line from GitHub's zen endpoint.",
  "icon": "rocket",
  "entry": "index.html",
  "size": { "w": 520, "h": 250 },
  "permissions": { "network": ["api.github.com"], "storage": true, "notices": true }
}
```

| Field | Rule |
| --- | --- |
| `id` | 3 to 32 characters: lowercase letters, digits and `-`, not starting or ending with `-`. The folder it is installed to and its tool id `plugin:<id>` |
| `name` | 1 to 40 characters, shown in the tool bar and the header |
| `version` | Three numbers, `1.2.3` |
| `author`, `description` | Optional, up to 60 and 200 characters |
| `icon` | Optional, one of the [icons](#icons) below (default `puzzle`). NotNotch draws it itself; no image is loaded from the plugin for the tool bar |
| `entry` | The page the tool opens, an `.html` file in the folder |
| `size` | The open notch's size for the tool, header and tool bar included: `w` 320 to 740, `h` 160 to 540 |
| `permissions.network` | Up to 8 host names the plugin may fetch from, for example `api.github.com` |
| `permissions.storage` | `true` for a key-value storage of its own |
| `permissions.notices` | `true` to show notices in the closed notch |

Text fields may not hold control characters or the characters that reverse text direction. Any other field, a wrong type or a value out of range refuses the plugin.

Files may be `html`, `js`, `mjs`, `css`, `json`, `svg`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `ico`, `woff`, `woff2`, `ttf`, `otf`, `txt`, `md`, or have no extension (a `LICENSE`). Names use letters, digits, `.`, `_` and `-`, at most 8 folders deep. Names starting with a dot (`.git`) and the `__MACOSX` folder are left out. At most 200 files, 5 MB per file and 10 MB in all, 20 MB for the `.zip`.

## Writing the page

The page runs in a frame with an opaque origin and a strict content security policy:

- scripts, styles, images, fonts and media only from the plugin's own folder (relative paths work), plus `data:` and `blob:` images; inline styles are allowed, inline scripts, `eval` and inline event handlers (`onclick="…"`) are not;
- no `fetch`, XHR, WebSocket, EventSource or beacon, no images from other hosts, no forms, frames, workers, pop-ups or navigation away;
- no cookies, `localStorage` or IndexedDB (an opaque origin has none): use the storage below;
- WebRTC and the clipboard are removed from the page.

The page is loaded fresh each time its tool opens and stops when the notch closes or another tool opens, so keep what must last in storage. A timer that should fire while the notch is closed is better as `notnotch-notify` from a script.

NotNotch adds a script to the top of every page that defines `window.notnotch`. Theme tokens make the page match NotNotch's look; a transparent background lets the notch show through.

## API (version 1)

Every call returns a promise. A refused call rejects with an `Error` whose message is a short code (`permission`, `bad-field`, `domain`, `timeout`, …).

```js
const hello = await notnotch.hello();
// { api: 1, plugin: { id, name, version }, permissions, theme, language }

const theme = await notnotch.theme();
// { accent, label, "label-2", "label-3", "label-4", "fill-1", "fill-2", "fill-3", separator, elevated, notch, link, green, orange, red, yellow, font }
const stop = notnotch.on("theme", (theme) => { /* NotNotch's theme changed */ });

await notnotch.storage.set("count", 3);        // any JSON value
await notnotch.storage.get("count");           // 3, or null
await notnotch.storage.remove("count");
await notnotch.storage.keys();                 // ["…"]

const r = await notnotch.fetch("https://api.github.com/zen", { method: "GET", headers: { accept: "text/plain" } });
// { status, contentType, body }   body is text

await notnotch.notify("Countdown finished", "Optional text");
await notnotch.resize(560, 300);               // returns the size it got
```

| Call | Needs | Limits |
| --- | --- | --- |
| `storage.*` | `storage: true` | Keys 1 to 128 characters; a value up to 32 KB as JSON; 256 keys and 256 KB in all |
| `fetch` | the URL's host in `network` | `https` on the default port, the host exactly as declared (no subdomains), no IP addresses, no user name in the URL; GET, POST, PUT, PATCH or DELETE; up to 16 headers (not `Cookie`, `Host`, `Origin`, `Referer`, `Proxy-*`, `Sec-*` and other connection headers); a body up to 64 KB; the answer up to 1 MB within 15 seconds; redirects are not followed; 4 requests at a time |
| `notify` | `notices: true` | A title up to 80 characters and a text up to 300; 3 a minute. It goes through the rules of **Settings → Notices** like any other notice, and needs live notices on |
| `resize` | nothing | The panel's size within the bounds of `size` |

### The messages underneath

`window.notnotch` is a thin layer over `postMessage`; a page can also talk to NotNotch directly. A request is a plain object sent to `parent`:

```js
parent.postMessage({ notnotch: 1, id: 7, type: "storage.get", key: "count" }, "*");
```

`id` is a number or a string up to 64 characters; `type` is `hello`, `theme`, `storage.get`, `storage.set`, `storage.remove`, `storage.keys`, `fetch`, `notify` or `resize`, with the fields shown above (`key`, `value`, `url`, `method`, `headers`, `body`, `title`, `w`, `h`). The answer comes back as a message `{ notnotch: 1, id, ok: true, result }` or `{ notnotch: 1, id, ok: false, error }`. Theme changes arrive as `{ notnotch: 1, event: "theme", data }`. A message with an unknown type or an unknown field is answered with an error; one without `notnotch: 1` or an id is ignored.

## Security model

- **Isolation.** The page runs in an `<iframe sandbox="allow-scripts">`, without `allow-same-origin`, so its origin is opaque: it cannot read NotNotch's window, storage or cookies. Tauri's command bridge is only injected into NotNotch's own page, never into frames. NotNotch answers a message only when it comes from that plugin's own frame, and only for the plugin that frame was opened for.
- **Its own files only.** The pages come from a protocol of their own (`notnotchplugin`) that serves a file only from the plugin's installed folder, only to NotNotch's own window, after checking every path name again. Each response carries a content security policy with `connect-src 'none'`, `default-src 'none'` and the plugin's folder as the only source of scripts, styles and images, plus `sandbox allow-scripts`, and NotNotch's own window lets frames load only from that protocol, so a page cannot navigate its frame elsewhere. DNS prefetching is off for plugin pages.
- **Network through NotNotch.** `fetch` runs in NotNotch's Rust side. The URL is checked against the declared hosts again there; the host name is resolved and every address must be public (no loopback, private network, link-local, carrier NAT or reserved range, including IPv4 inside IPv6), and the connection is pinned to those addresses so a name that changes its answer cannot reach your router or a local service. No proxy, cookies, credentials or redirects.
- **Install checks.** The manifest is parsed strictly. A folder with a symbolic link or junction anywhere is refused, and every file must still be inside the folder once resolved. In a `.zip`, names with `..`, a root, a drive, a backslash or a reserved Windows name are refused, links are refused, and sizes are counted on what is actually unpacked. Two names that differ only in case are refused. Files are written to a staging folder and moved into place only after you confirm.
- **No reach into NotNotch.** No API touches files, keys, the vault, the clipboard, other plugins or NotNotch's settings. Storage is a separate file per plugin, outside the folder its pages are served from.
- **What remains.** A plugin can still use what any web page has inside its own frame: it can use your CPU while its tool is open, show misleading text inside its own panel, and the declared hosts receive whatever it sends them. Install plugins you trust, and check the addresses NotNotch shows before installing.

The Microsoft Store build supports plugins the same way. They are installed only from files you pick and run in the same sandbox as any web content; NotNotch downloads no code of its own accord and has no plugin store.

## notnotch-notify parts

Scripts can also add parts to the closed row without a plugin: `notnotch-notify part <id> "text" -i <icon> -p <0-100> -o <tool> -t <seconds>`, and `-o plugin:<id>` opens a plugin on click. Details: [notices.md](notices.md#custom-parts-in-the-closed-row).

## Icons

`puzzle`, `star`, `heart`, `bell`, `clock`, `timer`, `calendar`, `cloud`, `sun`, `moon`, `chart`, `code`, `terminal`, `music`, `book`, `quote`, `globe`, `rocket`, `lightning`, `check`, `warning`, `flag`, `fire`, `coffee`, `game`, `build`, `bug`, `branch`, `download`, `upload`, `cpu`, `battery`, `wifi`, `money`, `cart`, `mail`, `chat`, `user`, `home`, `leaf`.
