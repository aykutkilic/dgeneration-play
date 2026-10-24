// Small math helpers shared by the simulation.

export const DIRS8 = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

export const DIR_NAMES = { e: [1, 0], s: [0, 1], w: [-1, 0], n: [0, -1],
  se: [1, 1], sw: [-1, 1], nw: [-1, -1], ne: [1, -1] };

export function dirIndex(dx, dz) {
  const a = Math.atan2(dz, dx);
  return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
}

export function unitDir(i) {
  const [dx, dz] = DIRS8[i];
  const l = Math.hypot(dx, dz);
  return [dx / l, dz / l];
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Deterministic PRNG so the simulation can be replayed in tests.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function deepCopy(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
}

// Push a circle {x, z, r} out of an axis-aligned box [minX, minZ, maxX, maxZ].
// Returns true when the circle was touching the box.
export function pushOut(e, b) {
  const cx = clamp(e.x, b[0], b[2]);
  const cz = clamp(e.z, b[1], b[3]);
  const dx = e.x - cx;
  const dz = e.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= e.r * e.r) return false;
  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    const p = (e.r - d) / d;
    e.x += dx * p;
    e.z += dz * p;
  } else {
    const l = e.x - b[0], r = b[2] - e.x, t = e.z - b[1], bt = b[3] - e.z;
    const m = Math.min(l, r, t, bt);
    if (m === l) e.x = b[0] - e.r;
    else if (m === r) e.x = b[2] + e.r;
    else if (m === t) e.z = b[1] - e.r;
    else e.z = b[3] + e.r;
  }
  return true;
}

export const inBox = (x, z, b) => x > b[0] && x < b[2] && z > b[1] && z < b[3];
