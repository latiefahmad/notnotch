/** SVG paths for the Wave equalizer and the Wavy progress bar (pure, tested in shapes.test.ts). */

const r = (n: number) => Math.round(n * 100) / 100;

/**
 * A smooth line through band levels (0..1), bass on the left: 0 sits at the bottom, 1 at the top,
 * `pad` keeps the stroke inside. Catmull-Rom through the points, as cubic Béziers, with the control
 * points kept inside the box so the curve never leaves it by more than a hair.
 */
export function wavePath(levels: readonly number[], width: number, height: number, pad = 1): string {
  const n = levels.length;
  if (n === 0) return "";
  const lo = pad;
  const hi = height - pad;
  const clamp = (y: number) => Math.min(hi, Math.max(lo, y));
  const pts = levels.map((v, i) => [n === 1 ? width / 2 : (i / (n - 1)) * width, clamp(hi - Math.min(1, Math.max(0, v)) * (hi - lo))]);
  if (n === 1) return `M0 ${r(pts[0][1])}H${r(width)}`;
  let d = `M${r(pts[0][0])} ${r(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [p0, p1, p2, p3] = [pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(n - 1, i + 2)]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clamp(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clamp(p2[1] - (p3[1] - p1[1]) / 6)];
    d += `C${r(c1[0])} ${r(c1[1])} ${r(c2[0])} ${r(c2[1])} ${r(p2[0])} ${r(p2[1])}`;
  }
  return d;
}

/**
 * A sine from x = 0 to x = `to` around the line y = `mid`: amplitude `amp` (0 = a straight line),
 * one period every `wavelength` px, shifted by `phase` (radians). The last half period tapers to
 * `mid`, so the wave meets the flat rest of the bar at the play head. Sampled every `step` px,
 * enough for a 2 to 5 px stroke with round joins.
 */
export function sinePath(to: number, mid: number, amp: number, wavelength: number, phase: number, step = 2): string {
  if (to <= 0) return "";
  if (amp === 0) return `M0 ${r(mid)}H${r(to)}`;
  const k = (2 * Math.PI) / wavelength;
  const y = (x: number) => r(mid - amp * Math.min(1, (to - x) / (wavelength / 2)) * Math.sin(k * x + phase));
  let d = `M0 ${y(0)}`;
  for (let x = step; x < to; x += step) d += `L${r(x)} ${y(x)}`;
  return `${d}L${r(to)} ${y(to)}`;
}
