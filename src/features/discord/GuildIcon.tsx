import type { DiscordCall } from "../../platform/services";

/** Server icon; initials without one (like Discord itself). Split out of DiscordView, so the closed row's
 * Discord part (rows/CompactRow) doesn't pull the whole tool view into the startup bundle. */
export function GuildIcon({ call, size }: { call: DiscordCall; size: number }) {
  const name = call.guildName ?? call.channelName;
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 3);
  const radius = size * 0.3;
  if (call.guildIcon) return <img src={call.guildIcon} alt="" draggable={false} className="shrink-0 object-cover" style={{ width: size, height: size, borderRadius: radius }} />;
  return (
    <span
      className="flex shrink-0 items-center justify-center bg-fill-3 font-semibold text-label"
      style={{ width: size, height: size, borderRadius: radius, fontSize: size >= 32 ? undefined : 9 }}
    >
      <span className={size >= 32 ? "text-body" : undefined}>{initials}</span>
    </span>
  );
}
