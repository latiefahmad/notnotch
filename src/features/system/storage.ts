// Translated from BrimDeck (Apache-2.0, github.com/MoFeng2223/BrimDeck), src/BrimDeck.Core/Storage.cs.
// The drives the Hardware tool shows: fixed lettered volumes on internal drives, grouped by physical drive. USB, SD and
// MMC media, removable media and virtual disks are left out, and so are volumes too small to matter (a recovery
// partition with a letter).

import { diskLevel, plausible } from "./temps.ts";
import type { Level } from "./levels.ts";

export interface VolumeRaw { letter: string; total: number; free: number; disk: number | null }
export interface DiskRaw { number: number; model: string; bus: number; removable: boolean; ssd: boolean; temp: [number, number, number] | null }
export interface DrivesRaw { volumes: VolumeRaw[]; disks: DiskRaw[] }

export interface Drive { key: string; model: string; letters: string; total: number; used: number; temp: number | null; tempLevel: Level }

/** STORAGE_BUS_TYPE values that are not internal drives: USB, SD, MMC, virtual. A file-backed virtual disk (a Dev Drive) stays. */
const EXTERNAL_BUS = new Set([7, 12, 13, 14]);
export const SMALLEST_VOLUME = 1024 ** 3;

export const internal = (d: DiskRaw) => !d.removable && !EXTERNAL_BUS.has(d.bus);

/** Drives in the order of their first letter; a volume without a known drive is a drive of its own. */
export function groupDrives(raw: DrivesRaw | null): Drive[] {
  if (!raw) return [];
  const disks = new Map(raw.disks.map((d) => [d.number, d]));
  const kept = raw.volumes.filter((v) => v.total >= SMALLEST_VOLUME && (v.disk === null || (disks.has(v.disk) && internal(disks.get(v.disk)!))));
  const groups = new Map<string, VolumeRaw[]>();
  for (const v of kept) {
    const key = v.disk === null ? `vol ${v.letter}` : `disk ${v.disk}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  const drives = [...groups].map(([key, vols]): Drive => {
    vols.sort((a, b) => a.letter.localeCompare(b.letter));
    const disk = vols[0].disk === null ? undefined : disks.get(vols[0].disk);
    const t = disk?.temp ? plausible(disk.temp[0]) : null;
    const total = vols.reduce((s, v) => s + v.total, 0);
    const used = vols.reduce((s, v) => s + Math.max(0, v.total - Math.min(v.free, v.total)), 0);
    return {
      key,
      model: disk?.model ?? "",
      letters: vols.map((v) => v.letter).join(" "),
      total,
      used,
      temp: t,
      tempLevel: t === null ? 0 : diskLevel(t, disk!.temp![1], disk!.temp![2]),
    };
  });
  return drives.sort((a, b) => a.letters.localeCompare(b.letters));
}
