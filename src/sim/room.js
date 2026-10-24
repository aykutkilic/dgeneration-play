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

const WALL_INSET = 0.2;
const DOOR_HALF = 0.2;

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

function computeWallBoxes(room) {
  const { W, H } = room;
  room.wallBox = new Array(W * H).fill(null);
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (tileAt(room, x, z) !== WALL) continue;
      const fl = (dx, dz) => tileAt(room, x + dx, z + dz) === FLOOR;
      room.wallBox[z * W + x] = [
        x + (fl(-1, 0) ? WALL_INSET : 0),
        z + (fl(0, -1) ? WALL_INSET : 0),
        x + 1 - (fl(1, 0) ? WALL_INSET : 0),
        z + 1 - (fl(0, 1) ? WALL_INSET : 0),
      ];
    }
  }
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
  if (t === WALL) return [room.wallBox[z * room.W + x]];
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
    if (tt === WALL) return false;
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
