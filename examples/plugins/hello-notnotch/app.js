// Hello NotNotch: a countdown kept in the plugin's storage and a line from GitHub's zen endpoint.
// Everything goes through window.notnotch (docs/plugins.md); the page itself cannot reach the network.
const $ = (id) => document.getElementById(id);
let endsAt = null;
let notified = false;

/** NotNotch's theme tokens as CSS variables (--label, --fill-2, --font, ...). */
function applyTheme(theme) {
  for (const [name, value] of Object.entries(theme)) {
    if (value) document.documentElement.style.setProperty(`--${name}`, value);
  }
}

async function loadZen() {
  $("zen").textContent = "…";
  try {
    const r = await notnotch.fetch("https://api.github.com/zen", { headers: { accept: "text/plain" } });
    $("zen").textContent = r.status === 200 ? r.body.trim() : `GitHub answered ${r.status}.`;
  } catch (e) {
    $("zen").textContent = `No line this time (${e.message}).`;
  }
}

// The page only runs while its tool is open: a countdown that ended meanwhile is announced on the next open.
function render() {
  const left = endsAt ? Math.max(0, endsAt - Date.now()) : 0;
  $("clock").textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`;
  $("stop").hidden = !endsAt;
  if (endsAt && left === 0 && !notified) {
    notified = true;
    notnotch.storage.set("notified", true);
    notnotch.notify("Countdown finished", "Hello from a NotNotch plugin").catch(() => {});
  }
}

async function start(minutes) {
  endsAt = Date.now() + minutes * 60_000;
  notified = false;
  await notnotch.storage.set("endsAt", endsAt);
  await notnotch.storage.set("notified", false);
  render();
}

async function stop() {
  endsAt = null;
  await notnotch.storage.remove("endsAt");
  render();
}

(async () => {
  const hello = await notnotch.hello();
  applyTheme(hello.theme);
  notnotch.on("theme", applyTheme);
  endsAt = await notnotch.storage.get("endsAt");
  notified = (await notnotch.storage.get("notified")) === true;
  for (const b of document.querySelectorAll("[data-min]")) b.addEventListener("click", () => start(Number(b.dataset.min)));
  $("stop").addEventListener("click", stop);
  $("again").addEventListener("click", loadZen);
  render();
  setInterval(render, 1000);
  loadZen();
})();
