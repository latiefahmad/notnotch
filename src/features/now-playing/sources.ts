// Choice of player, the pure part: names for media app IDs and the rows of the player menu.
// Which session is shown is decided in Rust (src-tauri/src/media_pick.rs); this only describes it.

export interface SourceState {
  appId: string;
  isPlaying: boolean;
}

export interface SourceRow {
  /** null = Automatic. */
  appId: string | null;
  name: string;
  isPlaying: boolean;
  /** False for a pinned app that has no session now. */
  running: boolean;
  checked: boolean;
}

const KNOWN: [RegExp, string][] = [
  [/^308046b0af4a39cb$|firefox/, "Firefox"],
  [/spotify/, "Spotify"],
  [/applemusic/, "Apple Music"],
  [/zunemusic|mediaplayer/, "Media Player"],
  [/msedge|microsoftedge/, "Edge"],
  [/chrome/, "Chrome"],
  [/brave/, "Brave"],
  [/opera/, "Opera"],
  [/vivaldi/, "Vivaldi"],
  [/vlc/, "VLC"],
  [/itunes/, "iTunes"],
  [/tidal/, "TIDAL"],
  [/deezer/, "Deezer"],
  [/amazonmusic/, "Amazon Music"],
  [/musicbee/, "MusicBee"],
  [/foobar2000/, "foobar2000"],
  [/aimp/, "AIMP"],
];

/**
 * A readable name for a media app ID: "Spotify.exe", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", "Chrome", or Firefox's
 * fixed hash. Unknown apps: the exe or package name with its words split.
 */
export function sourceName(appId: string): string {
  const squashed = appId.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [re, name] of KNOWN) if (re.test(squashed)) return name;
  // Packaged: "Publisher.Name_hash!App" -> "Name"; desktop: "Some App.exe" -> "Some App".
  const base = appId.includes("!") ? (appId.split("!")[0].split("_")[0].split(".").pop() ?? appId) : appId.replace(/\.exe$/i, "").split(/[\\/]/).pop()!;
  const words = base.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : appId;
}

/** The menu: Automatic first, then each app in Windows' order, then a pinned app that is not running. */
export function sourceRows(sources: SourceState[], pinned: string | null): SourceRow[] {
  const pinRunning = pinned !== null && sources.some((s) => s.appId === pinned);
  const rows: SourceRow[] = [{ appId: null, name: "", isPlaying: false, running: true, checked: pinned === null }];
  for (const s of sources) rows.push({ appId: s.appId, name: sourceName(s.appId), isPlaying: s.isPlaying, running: true, checked: s.appId === pinned });
  if (pinned !== null && !pinRunning) rows.push({ appId: pinned, name: sourceName(pinned), isPlaying: false, running: false, checked: true });
  return rows;
}

/** The menu is offered when there is a choice, or to undo a pin whose app is gone. */
export function offersSources(sources: SourceState[], pinned: string | null): boolean {
  return sources.length >= 2 || (pinned !== null && !sources.some((s) => s.appId === pinned));
}
