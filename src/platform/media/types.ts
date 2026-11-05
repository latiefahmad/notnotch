export interface NowPlaying {
  title: string;
  artist: string;
  /** Cover image URL (in the app: data URL from the GSMTC thumbnail). */
  artwork: string | null;
  /** Accent color from the cover, drives the equalizer & progress bar. */
  accent: string;
  isPlaying: boolean;
  /** Position in seconds at `updatedAt` (ms, performance.now()). */
  position: number;
  /** Seconds; 0 = unknown (live stream, some browser players). */
  duration: number;
  /** Does the source allow seeking? */
  canSeek: boolean;
  updatedAt: number;
  /** Media app ID of the shown session ("Spotify.exe", "Chrome" …). */
  appId: string;
  /** null = the app offers no shuffle (repeat) control. */
  shuffle: boolean | null;
  repeat: RepeatMode | null;
  /** Every media session, one per app. */
  sources: { appId: string; isPlaying: boolean }[];
}

export type RepeatMode = "none" | "list" | "track";

/** A session with its track, for the player menu. */
export interface SourceInfo {
  appId: string;
  title: string;
  artist: string;
  isPlaying: boolean;
}

/**
 * Bridge to the media source. A mock in the browser, in Tauri the
 * Windows API GlobalSystemMediaTransportControls.
 */
export interface MediaSource {
  get(): NowPlaying | null;
  subscribe(listener: () => void): () => void;
  toggle(): void;
  next(): void;
  previous(): void;
  /** Seeks to `position` seconds. */
  seek(position: number): void;
  /** Brings the playing app (Spotify, the browser …) to the front. false = not found. */
  openSource(): Promise<boolean>;
  toggleShuffle(): void;
  /** Off, list, track, off. */
  cycleRepeat(): void;
  /** Shows this app whatever else plays; null = automatic. */
  pin(appId: string | null): void;
  /** Lyrics are on screen: the position is refreshed every few seconds while playing. */
  lyricsShown(on: boolean): void;
  /** Every session with its track (asked when the player menu opens). */
  sources(): Promise<SourceInfo[]>;
}

/** Current playback position, extrapolated from the last state. */
export function livePosition(np: NowPlaying, now = performance.now()): number {
  if (!np.isPlaying) return np.position;
  const pos = np.position + (now - np.updatedAt) / 1000;
  return np.duration > 0 ? Math.min(np.duration, pos) : pos;
}
