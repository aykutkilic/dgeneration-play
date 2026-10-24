// Room parsing and spatial queries.
//
// A room is authored as an ASCII map plus a table of character definitions:
//   '#' wall      '.' floor     ' ' void (outside the building)
//   '@' player start (first room of a floor)
//   '1'..'9' exits to neighbouring rooms (see def.exits)
//   '^' red-arrow rescue hall (survivors leave through it)
//   'T' gravity tube to the next floor
//   '*' electrified plate   'x' mine
//   '%' desk   '&' plant   '=' cabinet
// Any other character is looked up in def.defs, e.g. { t: 'door', color: 'blue' }.

import { DIRS8, DIR_NAMES } from './util.js';

export const VOID = 0, FLOOR = 1, WALL = 2, DOOR = 3;

// Object types that sit inside a wall tile rather than on the floor.
const WALL_MOUNTED = new Set(['switch', 'keyhole', 'eye', 'window', 'panel']);
// Floor objects that block movement.
const SOLID = new Set(['turret', 'prop', 'terminal', 'dish']);
// Floor objects that also stop laser bolts.
const BLOCKS_LASER = new Set(['turret', 'dish']);

// Walls are thin slabs: WALL_THICK wide, standing WALL_INSET back from the floor they face.
export const WALL_INSET = 0.2;
export const WALL_THICK = 0.2;
const DOOR_HALF = 0.2;
// Wall geometry is rasterised on a sub-grid this fine; every inset and thickness is a multiple of it.
const SUB = 10;

const BUILTIN = {
  'T': { t: 'tube' },
  '*': { t: 'plate' },
  'x': { t: 'mine' },
  '%': { t: 'prop', kind: 'desk' },
  '&': { t: 'prop', kind: 'plant' },
  '=': { t: 'prop', kind: 'cabinet' },
};

export function parseRoom(def, id) {
  const lines = def.map;
  const H = lines.length;
  const W = Math.max(...lines.map((l) => l.length));
  const tiles = new Uint8Array(W * H);
  const objs = [];
  const exits = [];
  const arrows = [];
  let start = null;
  const objAt = new Map();

  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const ch = lines[z][x] ?? ' ';
      const idx = z * W + x;
      if (ch === ' ') { tiles[idx] = VOID; continue; }
      if (ch === '#') { tiles[idx] = WALL; continue; }
      tiles[idx] = FLOOR;
      if (ch === '.') continue;
      if (ch === '@') { start = { x, z }; continue; }
      if (ch === '^') { arrows.push({ x, z }); continue; }
      if (ch >= '1' && ch <= '9') {
        const to = def.exits && def.exits[ch];
        if (!to) throw new Error(`room ${id}: exit ${ch} has no destination`);
        const [room, n] = to.split(':');
        exits.push({ n: ch, x, z, room, at: n || ch });
        continue;
      }
      const d = (def.defs && def.defs[ch]) || BUILTIN[ch];
      if (!d) throw new Error(`room ${id}: unknown map character '${ch}' at ${x},${z}`);
      if (d.t === 'door') tiles[idx] = DOOR;
      else if (WALL_MOUNTED.has(d.t)) tiles[idx] = WALL;
      const o = { ...d, ch, x, z, id: `${id}@${x},${z}` };
      objs.push(o);
      objAt.set(idx, o);
    }
  }

  const room = { def, id, W, H, tiles, objs, exits, arrows, start, objAt };
  room.byChar = new Map();
  for (const o of objs) {
    if (!room.byChar.has(o.ch)) room.byChar.set(o.ch, []);
    room.byChar.get(o.ch).push(o);
  }
  room.exitAt = new Map(exits.map((e) => [e.z * W + e.x, e]));

  for (const o of objs) initObject(room, o);
  computeWallBoxes(room);
  return room;
}

function initObject(room, o) {
  const { x, z } = o;
  switch (o.t) {
    case 'door': {
      const wl = isWallish(room, x - 1, z), wr = isWallish(room, x + 1, z);
      o.axis = wl || wr ? 'x' : 'z';
      o.open = !!o.open;
      o.broken = false;
      o.color = o.color || (o.sec ? 'red' : 'blue');
      break;
    }
    case 'switch': case 'keyhole': case 'eye': case 'window': case 'panel': {
      o.faces = [];
      for (const [name, [dx, dz]] of Object.entries(DIR_NAMES)) {
        if (name.length > 1) continue;
        if (tileAt(room, x + dx, z + dz) === FLOOR) o.faces.push(name);
      }
      if (o.t === 'eye') {
        o.dir = o.dir || o.faces[0] || 's';
        o.on = o.on !== false;
      }
      if (o.t === 'switch') { o.on = !!o.on; o.found = !o.secret; }
      break;
    }
    case 'turret': o.on = o.on !== false; o.angle = o.angle ?? 0; o.rot = o.rot ?? 1.1; break;
    case 'plate': o.enabled = o.enabled !== false; o.onT = o.onT ?? 1.1; o.offT = o.offT ?? 1.3; o.phase = o.phase ?? 0; break;
    case 'tele': o.on = o.on !== false; break;
    case 'vent': o.gen = o.gen || 'A'; o.sealed = false; break;
  }
}

export function tileAt(room, x, z) {
  if (x < 0 || z < 0 || x >= room.W || z >= room.H) return VOID;
  return room.tiles[z * room.W + x];
}

function isWallish(room, x, z) {
  const t = tileAt(room, x, z);
  return t === WALL || t === DOOR;
}

// Builds the geometry of every wall tile:
//   room.wallSlabs[i]  thin visible slabs { b: [x0, z0, x1, z1], hub?, from? } (from = tile index whose
//                      height an arm or connector should take)
//   room.wallFloor[i]  the parts of the tile that belong to the room (floor shows there)
//   room.wallBoxes[i]  collision: everything that is not open floor, i.e. the slabs plus the outside
// A tile facing floor on one side gets a slab along that side; floor on two opposite sides makes a
// centred partition; a tile that only touches floor diagonally is a corner or junction post with arms
// reaching its wall neighbours. Doors count as floor here so walls wrap round their frames.
function computeWallBoxes(room) {
  const { W, H } = room;
  const I = WALL_INSET, T = WALL_THICK, C0 = 0.5 - T / 2, C1 = 0.5 + T / 2;
  const N = W * H;
  room.wallSlabs = new Array(N).fill(null);
  room.wallFloor = new Array(N).fill(null);
  room.wallBoxes = new Array(N).fill(null);
  const open = (x, z) => { const t = tileAt(room, x, z); return t === FLOOR || t === DOOR; };
  const hubs = [];
  const kind = new Array(N).fill(null); // 'x2' / 'z2': partition running along z / x
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (tileAt(room, x, z) !== WALL) continue;
      const i = z * W + x;
      const xm = open(x - 1, z), xp = open(x + 1, z), zm = open(x, z - 1), zp = open(x, z + 1);
      const slabs = [], floor = [];
      if (xm && xp && zm && zp) {
        slabs.push({ b: [x + I, z + I, x + 1 - I, z + 1 - I] });
        floor.push([x, z, x + 1, z + 1]);
      } else if (xm && xp) {
        slabs.push({ b: [x + C0, z + (zm ? I : 0), x + C1, z + 1 - (zp ? I : 0)] });
        floor.push([x, z, x + 1, z + 1]);
        kind[i] = 'x2';
      } else if (zm && zp) {
        slabs.push({ b: [x + (xm ? I : 0), z + C0, x + 1 - (xp ? I : 0), z + C1] });
        floor.push([x, z, x + 1, z + 1]);
        kind[i] = 'z2';
      } else if (xm || xp || zm || zp) {
        const za = z + (zm ? I : 0), zb = z + 1 - (zp ? I : 0);
        const xa = x + (xm ? I : 0), xb = x + 1 - (xp ? I : 0);
        if (xm) { slabs.push({ b: [x + I, za, x + I + T, zb] }); floor.push([x, z, x + I + T, z + 1]); }
        if (xp) { slabs.push({ b: [x + 1 - I - T, za, x + 1 - I, zb] }); floor.push([x + 1 - I - T, z, x + 1, z + 1]); }
        if (zm) { slabs.push({ b: [xa, z + I, xb, z + I + T] }); floor.push([x, z, x + 1, z + I + T]); }
        if (zp) { slabs.push({ b: [xa, z + 1 - I - T, xb, z + 1 - I] }); floor.push([x, z + 1 - I - T, x + 1, z + 1]); }
      } else {
        const dxm = open(x - 1, z - 1) || open(x - 1, z + 1), dxp = open(x + 1, z - 1) || open(x + 1, z + 1);
        const dzm = open(x - 1, z - 1) || open(x + 1, z - 1), dzp = open(x - 1, z + 1) || open(x + 1, z + 1);
        if (!dxm && !dxp) continue; // touches no floor at all: solid, invisible filler
        const span = (m, p, o) => (m && !p ? [o + I, o + I + T, o, o + I + T]
          : p && !m ? [o + 1 - I - T, o + 1 - I, o + 1 - I - T, o + 1] : [o + C0, o + C1, o, o + 1]);
        const [hx0, hx1, fx0, fx1] = span(dxm, dxp, x), [hz0, hz1, fz0, fz1] = span(dzm, dzp, z);
        slabs.push({ b: [hx0, hz0, hx1, hz1], hub: true });
        floor.push([fx0, fz0, fx1, fz1]);
        hubs.push(i);
      }
      room.wallSlabs[i] = slabs;
      room.wallFloor[i] = floor;
    }
  }

  // Where a partition branches off a line of partitions, the tile at the branch faces floor on one
  // side only. Line it up with the partitions either side instead of standing back from its floor.
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      const slabs = room.wallSlabs[i];
      if (!slabs || kind[i] || slabs[0].hub || slabs.length !== 1) continue;
      const xm = open(x - 1, z), xp = open(x + 1, z), zm = open(x, z - 1), zp = open(x, z + 1);
      if (xm + xp + zm + zp !== 1) continue;
      const alongX = zm || zp, want = alongX ? 'z2' : 'x2';
      const ns = alongX ? [[x - 1, z, 2, x], [x + 1, z, 0, x + 1]] : [[x, z - 1, 3, z], [x, z + 1, 1, z + 1]];
      let line = null;
      for (const [nx, nz, side, edge] of ns) {
        if (tileAt(room, nx, nz) !== WALL || kind[nz * W + nx] !== want) continue;
        const t = room.wallSlabs[nz * W + nx].find((s) => Math.abs(s.b[side] - edge) < 1e-6);
        if (t) { line = alongX ? [t.b[1], t.b[3]] : [t.b[0], t.b[2]]; break; }
      }
      if (!line) continue;
      const b = slabs[0].b;
      if (alongX) { b[1] = line[0]; b[3] = line[1]; room.wallFloor[i] = [zp ? [x, line[0], x + 1, z + 1] : [x, z, x + 1, line[1]]]; }
      else { b[0] = line[0]; b[2] = line[1]; room.wallFloor[i] = [xp ? [line[0], z, x + 1, z + 1] : [x, z, line[1], z + 1]]; }
    }
  }

  // A tile that faces floor on its sides can also touch a separate patch of floor through a corner.
  // Close that corner with a small L that lines up with the walls arriving from both neighbours.
  const pockets = [];
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const i = z * W + x;
      const slabs = room.wallSlabs[i];
      if (!slabs || slabs[0].hub) continue;
      for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (!open(x + dx, z + dz) || open(x + dx, z) || open(x, z + dz)) continue;
        // x-range of the wall coming in from the z neighbour, z-range of the one from the x neighbour.
        const ez = z + (dz > 0 ? 1 : 0), ex = x + (dx > 0 ? 1 : 0);
        const nzS = (room.wallSlabs[(z + dz) * W + x] || []).filter((s) => Math.abs(s.b[dz > 0 ? 1 : 3] - ez) < 1e-6);
        const nxS = (room.wallSlabs[z * W + x + dx] || []).filter((s) => Math.abs(s.b[dx > 0 ? 0 : 2] - ex) < 1e-6);
        const [px0, px1] = nzS.length ? [nzS[0].b[0], nzS[0].b[2]] : dx > 0 ? [x + 1 - I - T, x + 1 - I] : [x + I, x + I + T];
        const [pz0, pz1] = nxS.length ? [nxS[0].b[1], nxS[0].b[3]] : dz > 0 ? [z + 1 - I - T, z + 1 - I] : [z + I, z + I + T];
        pockets.push([i,
          { b: [px0, dz > 0 ? pz0 : z, px1, dz > 0 ? z + 1 : pz1] },
          { b: [dx > 0 ? px0 : x, pz0, dx > 0 ? x + 1 : px1, pz1] },
          [dx > 0 ? px0 : x, dz > 0 ? pz0 : z, dx > 0 ? x + 1 : px1, dz > 0 ? z + 1 : pz1]]);
      }
    }
  }
  for (const [i, a, b, f] of pockets) { room.wallSlabs[i].push(a, b); room.wallFloor[i].push(f); }

  const present = (x, z) => tileAt(room, x, z) === WALL && room.wallSlabs[z * W + x] !== null;
  // Corner and junction posts reach out to the walls (and doors) next to them.
  for (const i of hubs) {
    const x = i % W, z = (i - x) / W;
    const [hx0, hz0, hx1, hz1] = room.wallSlabs[i][0].b;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!present(nx, nz) && tileAt(room, nx, nz) !== DOOR) continue;
      const b = dx > 0 ? [hx1, hz0, x + 1, hz1] : dx < 0 ? [x, hz0, hx0, hz1]
        : dz > 0 ? [hx0, hz1, hx1, z + 1] : [hx0, z, hx1, hz0];
      room.wallSlabs[i].push({ b, from: nz * W + nx });
    }
  }

  // Where neighbouring slabs meet a shared edge at different offsets, bridge them.
  const EPS = 1e-6;
  const link = (ia, ib, axis, edge) => {
    // axis 0: tiles side by side in x, shared edge x = edge; axis 1: in z.
    const lo = axis === 0 ? 0 : 1, hi = lo + 2, pl = 1 - axis, ph = pl + 2;
    const touchA = room.wallSlabs[ia].filter((s) => Math.abs(s.b[hi] - edge) < EPS);
    const touchB = room.wallSlabs[ib].filter((s) => Math.abs(s.b[lo] - edge) < EPS);
    const overlaps = (s, t) => Math.min(s.b[ph], t.b[ph]) - Math.max(s.b[pl], t.b[pl]) > EPS;
    const box = (along0, along1, perp0, perp1) => (axis === 0 ? [along0, perp0, along1, perp1] : [perp0, along0, perp1, along1]);
    const bridge = (src, own, dstIdx, inward) => {
      for (const s of src) {
        if (own.length) {
          if (own.some((t) => overlaps(s, t))) continue;
          let best = null;
          for (const t of own) {
            const d = Math.min(Math.abs(t.b[pl] - s.b[ph]), Math.abs(s.b[pl] - t.b[ph]));
            if (!best || d < best.d) best = { d, t };
          }
          const p0 = Math.min(s.b[pl], best.t.b[pl]), p1 = Math.max(s.b[ph], best.t.b[ph]);
          room.wallSlabs[dstIdx].push({ b: inward ? box(edge, edge + T, p0, p1) : box(edge - T, edge, p0, p1), from: dstIdx === ia ? ib : ia });
        } else {
          // The neighbour has nothing at this edge: run on until we reach its nearest slab.
          let best = null;
          for (const t of room.wallSlabs[dstIdx]) {
            if (!overlaps(s, t)) continue;
            const d = inward ? t.b[lo] - edge : edge - t.b[hi];
            if (d > EPS && (!best || d < best.d)) best = { d, t };
          }
          if (!best) continue;
          room.wallSlabs[dstIdx].push({ b: inward ? box(edge, best.t.b[lo], s.b[pl], s.b[ph]) : box(best.t.b[hi], edge, s.b[pl], s.b[ph]), from: dstIdx === ia ? ib : ia });
        }
      }
    };
    if (touchA.length) bridge(touchA, touchB, touchB.length ? ia : ib, !touchB.length);
    if (touchB.length && !touchA.length) bridge(touchB, touchA, ia, false);
  };
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (!present(x, z)) continue;
      if (present(x + 1, z)) link(z * W + x, z * W + x + 1, 0, x + 1);
      if (present(x, z + 1)) link(z * W + x, (z + 1) * W + x, 1, z + 1);
    }
  }

  // Collision: rasterise each tile and merge the solid cells into rectangles.
  const inside = (rs, px, pz) => rs.some((r) => px > r[0] && px < r[2] && pz > r[1] && pz < r[3]);
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (tileAt(room, x, z) !== WALL) continue;
      const i = z * W + x;
      const slabs = room.wallSlabs[i];
      if (!slabs) { room.wallBoxes[i] = [[x, z, x + 1, z + 1]]; continue; }
      const sb = slabs.map((s) => s.b);
      const solid = new Uint8Array(SUB * SUB);
      for (let v = 0; v < SUB; v++) {
        for (let u = 0; u < SUB; u++) {
          const px = x + (u + 0.5) / SUB, pz = z + (v + 0.5) / SUB;
          solid[v * SUB + u] = !inside(room.wallFloor[i], px, pz) || inside(sb, px, pz) ? 1 : 0;
        }
      }
      room.wallBoxes[i] = mergeRects(solid, SUB, SUB, 1).map(([u0, v0, u1, v1]) => [x + u0 / SUB, z + v0 / SUB, x + u1 / SUB, z + v1 / SUB]);
    }
  }
}

// Greedy merge of the cells of a w×h grid that equal v into rectangles [u0, v0, u1, v1] (cell units).
export function mergeRects(grid, w, h, v) {
  const used = new Uint8Array(w * h);
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (grid[i] !== v || used[i]) continue;
      let x1 = x;
      while (x1 + 1 < w && grid[i + x1 + 1 - x] === v && !used[i + x1 + 1 - x]) x1++;
      let y1 = y;
      for (;;) {
        if (y1 + 1 >= h) break;
        let ok = true;
        for (let k = x; k <= x1; k++) if (grid[(y1 + 1) * w + k] !== v || used[(y1 + 1) * w + k]) { ok = false; break; }
        if (!ok) break;
        y1++;
      }
      for (let yy = y; yy <= y1; yy++) for (let k = x; k <= x1; k++) used[yy * w + k] = 1;
      out.push([x, y, x1 + 1, y1 + 1]);
    }
  }
  return out;
}

// The floor tile a point counts as standing on. Inside a wall tile (beside a thin partition) that
// is the open neighbour on the same side of the wall.
export function standTile(room, px, pz) {
  const x = Math.floor(px), z = Math.floor(pz);
  if (tileAt(room, x, z) !== WALL) return [x, z];
  let best = [x, z], bd = Infinity;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const t = tileAt(room, x + dx, z + dz);
    if (t !== FLOOR && t !== DOOR) continue;
    const d = Math.hypot(x + dx + 0.5 - px, z + dz + 0.5 - pz);
    if (d < bd) { bd = d; best = [x + dx, z + dz]; }
  }
  return best;
}

export function doorBox(o) {
  return o.axis === 'x'
    ? [o.x, o.z + 0.5 - DOOR_HALF, o.x + 1, o.z + 0.5 + DOOR_HALF]
    : [o.x + 0.5 - DOOR_HALF, o.z, o.x + 0.5 + DOOR_HALF, o.z + 1];
}

// Boxes that block something at tile (x, z).
// mode: 'move' (player), 'walker' (creatures/survivors: exits and tubes are walls),
//       'laser', 'shot' (turret shots / grenades), 'sight'.
export function boxesAt(room, x, z, mode) {
  const t = tileAt(room, x, z);
  if (t === VOID) return mode === 'sight' ? null : [[x, z, x + 1, z + 1]];
  if (t === WALL) return room.wallBoxes[z * room.W + x];
  const o = room.objAt.get(z * room.W + x);
  if (t === DOOR) return o.open ? null : [doorBox(o)];
  if (mode === 'walker' && (room.exitAt.has(z * room.W + x) || (o && o.t === 'tube'))) {
    return [[x, z, x + 1, z + 1]];
  }
  if (!o || o.destroyed) return null;
  if (mode === 'sight') return null;
  if (mode === 'laser' && !BLOCKS_LASER.has(o.t)) return null;
  if (SOLID.has(o.t)) {
    const s = o.t === 'prop' ? 0.36 : 0.32;
    return [[x + 0.5 - s, z + 0.5 - s, x + 0.5 + s, z + 0.5 + s]];
  }
  return null;
}

export function isSolidPoint(room, px, pz, mode) {
  const x = Math.floor(px), z = Math.floor(pz);
  const bs = boxesAt(room, x, z, mode);
  if (!bs) return null;
  for (const b of bs) if (px > b[0] && px < b[2] && pz > b[1] && pz < b[3]) return b;
  return null;
}

export function lineOfSight(room, ax, az, bx, bz) {
  const d = Math.hypot(bx - ax, bz - az);
  const n = Math.ceil(d / 0.15);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
    const x = Math.floor(px), z = Math.floor(pz);
    const tt = tileAt(room, x, z);
    if (tt === WALL && room.wallBoxes[z * room.W + x].some((b) => px > b[0] && px < b[2] && pz > b[1] && pz < b[3])) return false;
    if (tt === DOOR) {
      const o = room.objAt.get(z * room.W + x);
      if (!o.open) return false;
    }
  }
  return true;
}

// Walkable for creatures and survivors (used by the flow field).
export function walkable(room, x, z) {
  const t = tileAt(room, x, z);
  if (t === FLOOR) {
    const idx = z * room.W + x;
    if (room.exitAt.has(idx)) return false;
    const o = room.objAt.get(idx);
    if (o && !o.destroyed && (SOLID.has(o.t) || o.t === 'tube')) return false;
    return true;
  }
  if (t === DOOR) return room.objAt.get(z * room.W + x).open;
  return false;
}

// Breadth-first distance field from a set of target tiles (8-connected, no corner cutting).
export function flowField(room, targets) {
  const { W, H } = room;
  const dist = new Float32Array(W * H).fill(Infinity);
  const q = [];
  for (const [x, z] of targets) {
    if (x < 0 || z < 0 || x >= W || z >= H) continue;
    dist[z * W + x] = 0;
    q.push(x, z);
  }
  let head = 0;
  while (head < q.length) {
    const x = q[head++], z = q[head++];
    const d0 = dist[z * W + x];
    for (const [dx, dz] of DIRS8) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
      if (!walkable(room, nx, nz)) continue;
      if (dx && dz && (!walkable(room, x + dx, z) || !walkable(room, x, z + dz))) continue;
      const nd = d0 + (dx && dz ? 1.414 : 1);
      if (nd < dist[nz * W + nx]) {
        dist[nz * W + nx] = nd;
        q.push(nx, nz);
      }
    }
  }
  return dist;
}

// Pick the next waypoint (tile centre) that descends the flow field from (px, pz).
export function flowStep(room, field, px, pz) {
  const { W } = room;
  const x = Math.floor(px), z = Math.floor(pz);
  let best = null, bd = field[z * W + x] ?? Infinity;
  for (const [dx, dz] of DIRS8) {
    const nx = x + dx, nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= room.W || nz >= room.H) continue;
    if (dx && dz && (!walkable(room, x + dx, z) || !walkable(room, x, z + dz))) continue;
    const d = field[nz * W + nx];
    if (d < bd) { bd = d; best = [nx + 0.5, nz + 0.5]; }
  }
  return best;
}
