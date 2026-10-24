// three.js view of the simulation: builds a room's static geometry on every flip,
// mirrors dynamic entities into meshes, and plays particle effects for game events.
import * as THREE from '../../vendor/three.module.min.js';
import * as M from './models.js';
import { tileAt, VOID, FLOOR, WALL, DOOR, doorBox, mergeRects, WALL_INSET, WALL_THICK } from '../sim/room.js';
import { DIR_NAMES, mulberry32 } from '../sim/util.js';

// Colours follow the original's palette: flat floors with a faint checker, mid-grey wall caps over
// dark wall faces, and a black building facade drawn in thin vertical lines.
// wallZ / wallX are the faces turned toward +z and +x (the two the camera sees).
export const THEMES = {
  navy: { floorA: '#24304d', floorB: '#202c49', grid: '#18213b', wallTop: '#6e6e6e', wallZ: '#103069', wallX: '#0a2554', facade: '#0d2a66', accent: '#ff44ff' },
  steel: { floorA: '#2c3442', floorB: '#28303d', grid: '#1e2531', wallTop: '#707070', wallZ: '#3c4859', wallX: '#2f3947', facade: '#2a3a52', accent: '#ffff00' },
  teal: { floorA: '#173b3f', floorB: '#14363a', grid: '#0f2a2e', wallTop: '#6c6e6e', wallZ: '#1a5056', wallX: '#123e44', facade: '#0f4a4e', accent: '#33bb88' },
  maroon: { floorA: '#360a18', floorB: '#310815', grid: '#55122a', wallTop: '#5f5f5f', wallZ: '#702730', wallX: '#531723', facade: '#4a1020', accent: '#ff44ff' },
  plum: { floorA: '#2b1a3a', floorB: '#271735', grid: '#1e1029', wallTop: '#686670', wallZ: '#4c2c68', wallX: '#3a2052', facade: '#3c1c58', accent: '#ff44ff' },
  olive: { floorA: '#28321d', floorB: '#242d1a', grid: '#1b2314', wallTop: '#6a6c66', wallZ: '#3f5329', wallX: '#30411f', facade: '#2c4220', accent: '#ffff00' },
  dream: { floorA: '#1a0828', floorB: '#160623', grid: '#b030c0', wallTop: '#b080d0', wallZ: '#6020a0', wallX: '#4a1680', facade: '#ff60ff', accent: '#ff60ff' },
  white: { floorA: '#3c3c42', floorB: '#37373d', grid: '#2c2c32', wallTop: '#8c8c90', wallZ: '#5e5e68', wallX: '#4a4a54', facade: '#4a4a56', accent: '#dd1111' },
};

// Wall heights: back walls stand tall, partitions are cut away to chest height, and the edges nearest
// the camera are just a kerb at floor level.
const TALL = 1.35, LOW = 0.42, FLAT = 0.05;
const I = WALL_INSET, T = WALL_THICK;
const SUB = 10, MARGIN = 3; // floor raster: cells per tile, tiles of margin round the map
const FACADE_DEPTH = 8, FACADE_STEP = 0.2, FACADE_FLOOR = 1.5;
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function canvasTex(w, h, draw, nearest = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (nearest) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; }
  return t;
}

// Two-tone checker, one texel per tile (floor UVs are world units / 2).
function checkerTexture(th) {
  const t = canvasTex(2, 2, (g) => {
    g.fillStyle = th.floorA; g.fillRect(0, 0, 2, 2);
    g.fillStyle = th.floorB; g.fillRect(1, 0, 1, 1); g.fillRect(0, 1, 1, 1);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// The night city seen through a window: perspective lines, distant lit floors and sparkles.
function cityTexture(seed) {
  const rnd = mulberry32(seed);
  return canvasTex(40, 16, (g, w, h) => {
    g.fillStyle = '#000000'; g.fillRect(0, 0, w, h);
    const px = (x, y, c) => { g.fillStyle = c; g.fillRect(x | 0, y | 0, 1, 1); };
    const vx = 6 + rnd() * 28;
    for (let i = 0; i < 6; i++) {
      const c = i % 2 ? '#229944' : '#4455dd';
      const tx = rnd() * w * 1.6 - w * 0.3;
      for (let k = 0; k <= 40; k++) px(vx + (tx - vx) * k / 40, 2 + (h - 2) * k / 40, c);
    }
    for (let i = 0; i < 7; i++) {
      const x = rnd() * w, y = 2 + rnd() * (h - 4), n = 2 + rnd() * 6;
      for (let k = 0; k < n; k += 2) px(x + k, y, '#ccbbaa');
    }
    for (let i = 0; i < 3; i++) {
      const x = 2 + rnd() * (w - 4), y = 2 + rnd() * (h - 4);
      px(x, y, '#ff44ff'); px(x - 1, y, '#ff44ff'); px(x + 1, y, '#ff44ff'); px(x, y - 1, '#ff44ff'); px(x, y + 1, '#ff44ff');
    }
  });
}

// 3×5 pixel glyphs for wall signs.
const GLYPHS = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
  5: '111100111001111', 6: '111100111101111', 7: '111001001001001', 8: '111101111101111', 9: '111101111001111',
  G: '111100101101111', E: '111100110100111', N: '101111111101101', O: '111101101101111', Q: '111101101111011',
};
// Laid out in a row, or down a vertical sign with each letter turned a quarter clockwise.
function pixelText(str, fg, bg, vertical) {
  const n = str.length;
  const w = vertical ? 7 : n * 4 + 1, h = vertical ? n * 4 + 1 : 7;
  return canvasTex(w, h, (g) => {
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
    g.fillStyle = fg;
    [...str].forEach((ch, i) => {
      const bits = GLYPHS[ch];
      for (let k = 0; k < 15; k++) {
        if (bits[k] !== '1') continue;
        const gx = k % 3, gy = (k / 3) | 0;
        if (vertical) g.fillRect(1 + 4 - gy, 1 + i * 4 + gx, 1, 1);
        else g.fillRect(1 + i * 4 + gx, 1 + gy, 1, 1);
      }
    });
  });
}

// The Genoq logo painted on lobby floors: a ring opened into a G, crossed at the foot.
// Drawn upright for the camera; units are the ring's outer radius.
function logoTexture() {
  const k = 46, cx = 50, cy = 50;
  return canvasTex(100, 108, (g) => {
    g.fillStyle = '#ca38cd';
    const rad = (d) => (d * Math.PI) / 180;
    g.beginPath();
    g.arc(cx, cy, k, rad(35), rad(355));
    g.arc(cx, cy, k * 0.71, rad(355), rad(35), true);
    g.closePath();
    g.fill();
    g.beginPath();
    for (const [x, y] of [[0.26, 0], [0.83, 0.58], [0.58, 0.52], [0.26, 0.3]]) g.lineTo(cx + x * k, cy + y * k);
    g.closePath();
    g.fill();
    g.fillRect(cx - 0.08 * k, cy + 0.32 * k, 0.25 * k, 0.91 * k);
  });
}

// Door panel: bright top, darker sides with a row of rivets along their top and bottom edges.
function doorMats(c, wx, wz, h) {
  const rows = Math.max(8, Math.round(h / 0.03));
  const side = (shade, len) => {
    const col = c.clone().multiplyScalar(shade);
    const t = canvasTex(4, rows, (g) => {
      g.fillStyle = `#${col.getHexString()}`; g.fillRect(0, 0, 4, rows);
      g.fillStyle = `#${col.clone().multiplyScalar(0.25).getHexString()}`;
      g.fillRect(1, 1, 1, 1); g.fillRect(1, rows - 2, 1, 1);
    });
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.x = Math.max(1, Math.round(len / 0.11));
    return new THREE.MeshBasicMaterial({ map: t });
  };
  const x = side(0.45, wz), z = side(0.68, wx), y = new THREE.MeshBasicMaterial({ color: c });
  return [x, x, y, y, z, z];
}

// Unlit box materials: the top in one colour, the two camera-facing sides in their own shades.
// Order follows BoxGeometry's groups (+x, -x, +y, -y, +z, -z). Cached and shared between rooms.
const flatMatCache = new Map();
function flatMats(top, sideX, sideZ) {
  const key = `${top}|${sideX}|${sideZ}`;
  if (!flatMatCache.has(key)) {
    const mk = (c) => new THREE.MeshBasicMaterial({ color: c });
    const x = mk(sideX), y = mk(top), z = mk(sideZ);
    flatMatCache.set(key, [x, x, y, y, z, z]);
  }
  return flatMatCache.get(key);
}
function shadeMats(color) {
  const c = new THREE.Color(color);
  return flatMats(c.getHex(), c.clone().multiplyScalar(0.45).getHex(), c.clone().multiplyScalar(0.7).getHex());
}

export class View {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
    this.camDir = new THREE.Vector3(1, 0.8165, 1).normalize();
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.35));
    const sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.position.set(2, 5, 3.6);
    this.scene.add(sun);
    this.roomGroup = new THREE.Group();
    this.entGroup = new THREE.Group();
    this.fxGroup = new THREE.Group();
    this.scene.add(this.roomGroup, this.entGroup, this.fxGroup);
    this.objMeshes = new Map();
    this.entMeshes = new Map();
    this.particles = [];
    this.flashes = [];
    this.pixelScale = 1;
    this.hudPx = 64;
    this.texCache = {};
    this.sharedTex = new Set();
    this.shake = 0;
    this.time = 0;
    this.resize();
  }

  setPixelScale(s) { this.pixelScale = s; this.resize(); }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const ratio = this.pixelScale === 0 ? Math.min(window.devicePixelRatio || 1, 2) : 1 / (this.pixelScale + 1);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    if (this.room) this.fitCamera();
  }

  theme(game) {
    const name = game.room.def.theme || game.floor.theme || 'navy';
    return { name, ...(THEMES[name] || THEMES.navy) };
  }

  tex(name, th, make) {
    const key = `${name}:${th.name}`;
    if (!this.texCache[key]) { this.texCache[key] = make(th); this.sharedTex.add(this.texCache[key]); }
    return this.texCache[key];
  }

  // Remove everything from a group and free GPU resources that aren't shared between rooms.
  clearGroup(g) {
    const shared = M.sharedResources();
    for (const ms of flatMatCache.values()) shared.add(ms[0]).add(ms[2]).add(ms[4]);
    g.traverse((o) => {
      if (!o.isMesh && !o.isLine) return;
      if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose();
      for (const m of [].concat(o.material)) {
        if (!m || shared.has(m)) continue;
        if (m.map && !this.sharedTex.has(m.map)) m.map.dispose();
        m.dispose();
      }
    });
    while (g.children.length) g.remove(g.children[0]);
  }

  // ------------------------------------------------------------ room geometry

  buildRoom(game) {
    const room = game.room;
    this.room = room;
    this.clearGroup(this.roomGroup);
    this.clearGroup(this.entGroup);
    this.clearGroup(this.fxGroup);
    this.objMeshes.clear();
    this.entMeshes.clear();
    this.particles = [];
    this.flashes = [];
    const th = this.theme(game);
    this.th = th;

    this.wallH = this.wallClasses(room);
    this.buildFloor(room, th);
    this.buildWalls(room, th);
    this.buildDecor(room, th, game);

    for (const a of room.arrows) {
      const g = M.arrowDecal();
      g.position.set(a.x + 0.5, 0, a.z + 0.5);
      // Point the arrow out of the room, toward the nearest void/edge.
      let best = [0, -1];
      for (const [dx, dz] of DIRS4) {
        const t = tileAt(room, a.x + dx, a.z + dz);
        if (t === WALL || t === VOID) { best = [dx, dz]; break; }
      }
      g.rotation.y = Math.atan2(-best[0], -best[1]);
      this.roomGroup.add(g);
    }

    for (const o of room.objs) this.buildObject(o, game);
    this.eyes = th.name === 'dream' ? this.buildEyes(room) : null;
    this.fitCamera();
  }

  // Height of each wall tile (see TALL / LOW / FLAT). Exits and doors don't count as floor here,
  // so the stubs flanking an exit stay low instead of rising in front of the room.
  wallClasses(room) {
    const { W, H } = room;
    const cls = new Array(W * H).fill(NaN);
    const fl = (x, z) => tileAt(room, x, z) === FLOOR && !room.exitAt.has(z * W + x);
    const gap = (x, z) => { const t = tileAt(room, x, z); return t === DOOR || (t === FLOOR && room.exitAt.has(z * W + x)); };
    const walls = [];
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        if (!room.wallSlabs[z * W + x]) continue;
        walls.push(z * W + x);
        const behind = fl(x - 1, z) || fl(x, z - 1) || fl(x - 1, z - 1);
        const front = fl(x + 1, z) || fl(x, z + 1) || fl(x + 1, z + 1);
        cls[z * W + x] = behind && front ? LOW : behind ? FLAT : front ? TALL
          : gap(x + 1, z) || gap(x, z + 1) ? LOW : gap(x - 1, z) || gap(x, z - 1) ? FLAT : NaN;
      }
    }
    // Posts that only touch floor at a side corner take the tallest wall they join.
    const out = cls.slice();
    for (const i of walls) {
      if (!Number.isNaN(cls[i])) continue;
      const x = i % W, z = (i - x) / W;
      let h = -1;
      for (const [dx, dz] of DIRS4) {
        if (tileAt(room, x + dx, z + dz) !== WALL) continue;
        const n = cls[(z + dz) * W + x + dx];
        if (!Number.isNaN(n)) h = Math.max(h, n);
      }
      out[i] = h < 0 ? LOW : h;
    }
    return out;
  }

  // Floor, exit corridors and the facade, all from one raster of the room's footprint.
  buildFloor(room, th) {
    const { W, H } = room;
    const GW = (W + 2 * MARGIN) * SUB, GH = (H + 2 * MARGIN) * SUB;
    const grid = new Uint8Array(GW * GH); // 0 outside, 1 floor, 2 dark exit floor
    const cell = (w) => Math.round((w + MARGIN) * SUB);
    const isExit = (x, z) => tileAt(room, x, z) === FLOOR && room.exitAt.has(z * W + x);
    const fillRect = (r, v, onlyEmpty = false) => {
      for (let gz = Math.max(0, cell(r[1])); gz < Math.min(GH, cell(r[3])); gz++) {
        for (let gx = Math.max(0, cell(r[0])); gx < Math.min(GW, cell(r[2])); gx++) {
          if (!onlyEmpty || !grid[gz * GW + gx]) grid[gz * GW + gx] = v;
        }
      }
    };
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const t = tileAt(room, x, z);
        if (t === FLOOR || t === DOOR) { fillRect([x, z, x + 1, z + 1], isExit(x, z) ? 2 : 1); continue; }
        const rects = t === WALL && room.wallFloor[z * W + x];
        if (!rects) continue;
        // Floor inside a wall tile belongs to whichever open tile is nearest: dark beside an exit.
        for (const r of rects) {
          for (let gz = cell(r[1]); gz < cell(r[3]); gz++) {
            for (let gx = cell(r[0]); gx < cell(r[2]); gx++) {
              const px = (gx + 0.5) / SUB - MARGIN, pz = (gz + 0.5) / SUB - MARGIN;
              let bd = Infinity, dark = false;
              for (let dz = -1; dz <= 1; dz++) {
                for (let dx = -1; dx <= 1; dx++) {
                  const nt = tileAt(room, x + dx, z + dz);
                  if (nt !== FLOOR && nt !== DOOR) continue;
                  const ddx = Math.max(x + dx - px, 0, px - (x + dx + 1)), ddz = Math.max(z + dz - pz, 0, pz - (z + dz + 1));
                  const d = Math.hypot(ddx, ddz);
                  const ex = isExit(x + dx, z + dz);
                  if (d < bd - 1e-6 || (Math.abs(d - bd) < 1e-6 && !ex)) { bd = d; dark = ex; }
                }
              }
              grid[gz * GW + gx] = dark ? 2 : 1;
            }
          }
        }
      }
    }

    // Exits open onto a dark corridor running two tiles out of the room: a low wall along its far
    // side (as beside the exit itself), a kerb along the near side.
    const kerb = [];
    for (const ex of room.exits) {
      for (const [dx, dz] of DIRS4) {
        if (tileAt(room, ex.x + dx, ex.z + dz) !== VOID) continue;
        for (let k = 1; k <= 2; k++) {
          const cx = ex.x + dx * k, cz = ex.z + dz * k;
          if (dx) {
            fillRect([cx, ex.z - I - T, cx + 1, ex.z + 1 + I + T], 2, true);
            kerb.push([[cx, ex.z - I - T, cx + 1, ex.z - I], LOW], [[cx, ex.z + 1 + I, cx + 1, ex.z + 1 + I + T], FLAT]);
          } else {
            fillRect([ex.x - I - T, cz, ex.x + 1 + I + T, cz + 1], 2, true);
            kerb.push([[ex.x - I - T, cz, ex.x - I, cz + 1], LOW], [[ex.x + 1 + I, cz, ex.x + 1 + I + T, cz + 1], FLAT]);
          }
        }
      }
    }
    for (const [b, h] of kerb) {
      const m = new THREE.Mesh(M.geo.box, this.wallMats(th, h));
      m.scale.set(b[2] - b[0], h, b[3] - b[1]);
      m.position.set((b[0] + b[2]) / 2, h / 2, (b[1] + b[3]) / 2);
      this.roomGroup.add(m);
    }

    // Floor quads.
    const quads = (v, uvs) => {
      const pos = [], uv = [], idx = [];
      for (const [u0, v0, u1, v1] of mergeRects(grid, GW, GH, v)) {
        const x0 = u0 / SUB - MARGIN, z0 = v0 / SUB - MARGIN, x1 = u1 / SUB - MARGIN, z1 = v1 / SUB - MARGIN;
        const b = pos.length / 3;
        pos.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
        if (uvs) uv.push(x0 / 2, z0 / 2, x1 / 2, z0 / 2, x1 / 2, z1 / 2, x0 / 2, z1 / 2);
        idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      if (uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      return g;
    };
    this.roomGroup.add(new THREE.Mesh(quads(1, true), new THREE.MeshBasicMaterial({ map: this.tex('checker', th, checkerTexture) })));
    this.roomGroup.add(new THREE.Mesh(quads(2, false), new THREE.MeshBasicMaterial({ color: 0x000000 })));

    // Faint grid on tile boundaries, only where floor lies on both sides.
    const gridPts = [];
    const at = (gx, gz) => (gx < 0 || gz < 0 || gx >= GW || gz >= GH ? 0 : grid[gz * GW + gx]);
    for (let x = 1; x < W; x++) {
      const gx = cell(x);
      let run = -1;
      for (let gz = 0; gz <= GH; gz++) {
        const on = gz < GH && at(gx - 1, gz) === 1 && at(gx, gz) === 1;
        if (on && run < 0) run = gz;
        if (!on && run >= 0) { gridPts.push(x, 0.003, run / SUB - MARGIN, x, 0.003, gz / SUB - MARGIN); run = -1; }
      }
    }
    for (let z = 1; z < H; z++) {
      const gz = cell(z);
      let run = -1;
      for (let gx = 0; gx <= GW; gx++) {
        const on = gx < GW && at(gx, gz - 1) === 1 && at(gx, gz) === 1;
        if (on && run < 0) run = gx;
        if (!on && run >= 0) { gridPts.push(run / SUB - MARGIN, 0.003, z, gx / SUB - MARGIN, 0.003, z); run = -1; }
      }
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
    this.roomGroup.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: th.grid })));

    // Facade: the tower drops away below every camera-facing edge of the footprint, drawn as black
    // panels with thin vertical lines and a horizontal line at each storey.
    const fpos = [], fidx = [], lpos = [], lcol = [];
    const top = new THREE.Color(th.facade), black = new THREE.Color(0x000000);
    const colAt = (y) => top.clone().lerp(black, Math.max(0, (-y / FACADE_DEPTH - 0.5) * 2));
    const line = (ax, ay, az, bx, by, bz) => {
      lpos.push(ax, ay, az, bx, by, bz);
      const ca = colAt(ay), cb = colAt(by);
      lcol.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b);
    };
    const panel = (axis, c, a, b) => {
      // axis 'x': face at x = c running along z from a to b; axis 'z': face at z = c along x.
      const P = (along, y) => (axis === 'x' ? [c, y, along] : [along, y, c]);
      const base = fpos.length / 3;
      fpos.push(...P(a, 0), ...P(b, 0), ...P(b, -FACADE_DEPTH), ...P(a, -FACADE_DEPTH));
      fidx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      for (let s = Math.ceil(a / FACADE_STEP - 1e-6) * FACADE_STEP; s <= b + 1e-6; s += FACADE_STEP) {
        line(...P(s, 0), ...P(s, -FACADE_DEPTH / 2));
        line(...P(s, -FACADE_DEPTH / 2), ...P(s, -FACADE_DEPTH));
      }
      for (let y = -FACADE_FLOOR; y > -FACADE_DEPTH; y -= FACADE_FLOOR) line(...P(a, y), ...P(b, y));
    };
    const inside = (gx, gz) => at(gx, gz) > 0;
    for (let gx = 0; gx < GW; gx++) {
      let run = -1;
      for (let gz = 0; gz <= GH; gz++) {
        const edge = gz < GH && inside(gx, gz) && !inside(gx + 1, gz);
        if (edge && run < 0) run = gz;
        if (!edge && run >= 0) { panel('x', (gx + 1) / SUB - MARGIN, run / SUB - MARGIN, gz / SUB - MARGIN); run = -1; }
      }
    }
    for (let gz = 0; gz < GH; gz++) {
      let run = -1;
      for (let gx = 0; gx <= GW; gx++) {
        const edge = gx < GW && inside(gx, gz) && !inside(gx, gz + 1);
        if (edge && run < 0) run = gx;
        if (!edge && run >= 0) { panel('z', (gz + 1) / SUB - MARGIN, run / SUB - MARGIN, gx / SUB - MARGIN); run = -1; }
      }
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
    fg.setIndex(fidx);
    // Pushed back in depth so the lines drawn on the panels win.
    this.roomGroup.add(new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })));
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lpos, 3));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(lcol, 3));
    this.roomGroup.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true })));
  }

  // Materials for a wall of height h: grey cap over the theme's wall faces, or all grey for a kerb.
  wallMats(th, h) {
    const top = new THREE.Color(th.wallTop);
    return h <= FLAT
      ? flatMats(top.getHex(), top.clone().multiplyScalar(0.35).getHex(), top.clone().multiplyScalar(0.55).getHex())
      : flatMats(top.getHex(), new THREE.Color(th.wallX).getHex(), new THREE.Color(th.wallZ).getHex());
  }

  // Thin wall slabs. Arms and connectors take the height of the wall they reach toward.
  buildWalls(room, th) {
    const { W, H } = room;
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const i = z * W + x;
        const slabs = room.wallSlabs[i];
        if (!slabs) continue;
        const hs = slabs.map((s) => (s.from != null && tileAt(room, s.from % W, Math.floor(s.from / W)) === WALL ? this.wallH[s.from] : this.wallH[i]));
        slabs.forEach((s, k) => { if (s.hub) hs[k] = Math.max(...hs); });
        slabs.forEach((s, k) => {
          const h = hs[k], b = s.b;
          const m = new THREE.Mesh(M.geo.box, this.wallMats(th, h));
          m.scale.set(b[2] - b[0], h, b[3] - b[1]);
          m.position.set((b[0] + b[2]) / 2, h / 2, (b[1] + b[3]) / 2);
          this.roomGroup.add(m);
        });
      }
    }
  }

  // Back walls carry windows onto the city, painted floor numbers, the Genoq sign and the security
  // panel that blinks red until the room is secured.
  buildDecor(room, th, game) {
    const { W } = room;
    const rnd = mulberry32(hash(`${game.floorNum}:${room.id}`));
    const fl = (x, z) => tileAt(room, x, z) === FLOOR && !room.exitAt.has(z * W + x);
    const open = (x, z) => { const t = tileAt(room, x, z); return t === FLOOR || t === DOOR; };
    // A plain stretch of tall wall facing +z (dir 'z') or +x (dir 'x').
    const plain = (x, z, dir) => tileAt(room, x, z) === WALL && this.wallH[z * W + x] === TALL && !room.objAt.has(z * W + x)
      && (dir === 'z' ? fl(x, z + 1) && !open(x - 1, z) && !open(x + 1, z) : fl(x + 1, z) && !open(x, z - 1) && !open(x, z + 1));
    const runs = [];
    for (const dir of ['z', 'x']) {
      for (let a = 0; a < (dir === 'z' ? room.H : W); a++) {
        let run = [];
        for (let b = 0; b <= (dir === 'z' ? W : room.H); b++) {
          const [x, z] = dir === 'z' ? [b, a] : [a, b];
          if (b < (dir === 'z' ? W : room.H) && plain(x, z, dir)) run.push(b);
          else { if (run.length) runs.push({ dir, a, tiles: run }); run = []; }
        }
      }
    }
    // Put a flat item on a wall face: `along` is its centre along the wall, y its centre height.
    const place = (mesh, dir, a, along, y) => {
      if (dir === 'z') mesh.position.set(along, y, a + 1 - I + 0.006);
      else { mesh.position.set(a + 1 - I + 0.006, y, along); mesh.rotation.y = Math.PI / 2; }
      this.roomGroup.add(mesh);
      return mesh;
    };
    const plane = (w, h, mat) => {
      const m = new THREE.Mesh(M.geo.plane, mat);
      m.scale.set(w, h, 1);
      return m;
    };
    // Windows are openings onto the city with a grey sill below and grey jambs at the ends.
    const cap = new THREE.Color(th.wallTop);
    const frameMats = flatMats(cap.getHex(), cap.clone().multiplyScalar(0.8).getHex(), cap.clone().multiplyScalar(0.8).getHex());
    const frame = (w, h, d) => {
      const m = new THREE.Mesh(M.geo.box, frameMats);
      m.scale.set(w, h, d);
      return m;
    };
    const singles = [];
    for (const r of runs) {
      let k = 0;
      while (k < r.tiles.length) {
        const v = rnd();
        if (k + 1 < r.tiles.length && r.tiles[k + 1] === r.tiles[k] + 1 && v < 0.55) {
          const along = r.tiles[k] + 1;
          const city = this.tex(`city${hash(room.id + k) % 4}`, th, () => cityTexture(hash(room.id + k) % 4 + 1));
          place(plane(1.5, 0.5, new THREE.MeshBasicMaterial({ map: city })), r.dir, r.a, along, 0.8);
          place(frame(1.58, 0.05, 0.12), r.dir, r.a, along, 0.525);
          for (const s of [-1, 1]) place(frame(0.04, 0.5, 0.06), r.dir, r.a, along + s * 0.77, 0.8);
          k += 3;
        } else {
          singles.push({ dir: r.dir, a: r.a, at: r.tiles[k] });
          k += 1;
        }
      }
    }
    // The security panel goes on the first free tile; a few others get signs.
    this.secPanel = null;
    if (room.threat && singles.length) {
      const s = singles.splice((rnd() * singles.length) | 0, 1)[0];
      const backing = new THREE.Mesh(M.geo.box, shadeMats(0x333333));
      backing.scale.set(0.26, 0.32, 0.03);
      place(backing, s.dir, s.a, s.at + 0.5, 0.7);
      const light = new THREE.Mesh(M.geo.plane, new THREE.MeshBasicMaterial({ color: 0xdd1111 }));
      light.scale.set(0.18, 0.24, 1);
      place(light, s.dir, s.a, s.at + 0.5, 0.7).position[s.dir === 'z' ? 'z' : 'x'] += 0.02;
      this.secPanel = light;
    }
    // At most one floor-number plate and one Genoq sign per room: pale panels lettered in red.
    let num = rnd() < 0.7, genoq = rnd() < 0.4;
    for (const s of singles) {
      if (rnd() < 0.5) continue;
      if (num) {
        num = false;
        const t = this.tex(`num${game.floorNum}`, th, () => pixelText(String(game.floorNum), '#ad5c6f', '#baaeb1', false));
        place(plane(0.4, 0.31, new THREE.MeshBasicMaterial({ map: t })), s.dir, s.a, s.at + 0.5, 0.8);
      } else if (genoq) {
        genoq = false;
        const t = this.tex('genoq', th, () => pixelText('GENOQ', '#ad5c6f', '#baaeb1', true));
        place(plane(0.24, 0.72, new THREE.MeshBasicMaterial({ map: t })), s.dir, s.a, s.at + 0.5, 0.7);
      }
    }

    // The company logo on the floor of the lobbies, turned to face the camera.
    if (room.def.logo) {
      const [lx, lz, r = 1.6] = room.def.logo;
      const m = new THREE.Mesh(M.geo.plane, new THREE.MeshBasicMaterial({ map: this.tex('logo', th, logoTexture), transparent: true, depthWrite: false }));
      // The ring's centre sits a little above the middle of the texture; bring it onto (lx, lz).
      m.scale.set(2.17 * r, 2.35 * r, 1);
      m.position.set(0, -0.087 * r, 0);
      const flat = new THREE.Group();
      flat.add(m);
      flat.rotation.x = -Math.PI / 2;
      const turn = new THREE.Group();
      turn.add(flat);
      turn.rotation.y = Math.PI / 4;
      turn.position.set(lx, 0.003, lz);
      this.roomGroup.add(turn);
    }
  }

  // Phase of the blink shared by every pressed switch.
  blinkOff() { return Math.floor(this.time * 4) % 2 === 1; }

  // The hallucination rooms are watched by giant floating eyes.
  buildEyes(room) {
    const eyes = [];
    for (let i = 0; i < 14; i++) {
      const g = new THREE.Group();
      const white = new THREE.Mesh(M.geo.sphere, new THREE.MeshBasicMaterial({ color: 0xf0e8ff }));
      const iris = new THREE.Mesh(M.geo.sphere, new THREE.MeshBasicMaterial({ color: [0x30c060, 0x3060e0, 0xa040c0][i % 3] }));
      const pupil = new THREE.Mesh(M.geo.sphere, new THREE.MeshBasicMaterial({ color: 0x000000 }));
      iris.scale.setScalar(0.55); iris.position.z = 0.25;
      pupil.scale.setScalar(0.28); pupil.position.z = 0.42;
      g.add(white, iris, pupil);
      const s = 0.6 + Math.random() * 1.2;
      g.scale.setScalar(s);
      // Scatter them around and below the room, outside the walkable area.
      const a = Math.random() * Math.PI * 2;
      const r = Math.max(room.W, room.H) * (0.6 + Math.random() * 0.4);
      g.position.set(room.W / 2 + Math.cos(a) * r, -1 - Math.random() * 4, room.H / 2 + Math.sin(a) * r);
      g.userData.phase = Math.random() * 10;
      this.roomGroup.add(g);
      eyes.push(g);
    }
    return eyes;
  }

  // Where a wall tile's face toward (dx, dz) is, measured through the tile's middle.
  faceCoord(o, dx, dz) {
    const cx = o.x + 0.5, cz = o.z + 0.5;
    let best = null;
    for (const { b } of this.room.wallSlabs[o.z * this.room.W + o.x] || []) {
      if (dx && (cz < b[1] || cz > b[3])) continue;
      if (dz && (cx < b[0] || cx > b[2])) continue;
      const v = dx > 0 ? b[2] : dx < 0 ? b[0] : dz > 0 ? b[3] : b[1];
      if (best === null || (dx + dz > 0 ? v > best : v < best)) best = v;
    }
    return best ?? (dx > 0 ? o.x + 1 - I : dx < 0 ? o.x + I : dz > 0 ? o.z + 1 - I : o.z + I);
  }

  wallFaceMarker(o, color, opts = {}) {
    const g = new THREE.Group();
    const h = this.wallH[o.z * this.room.W + o.x];
    const cx = o.x + 0.5, cz = o.z + 0.5;
    const make = () => new THREE.Mesh(opts.geo || M.geo.tri, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    // Flat marker on top of the wall, always visible from the camera. On a kerb it is the only marker.
    const top = make();
    top.rotation.x = -Math.PI / 2;
    top.scale.setScalar(h <= FLAT ? 0.42 : 0.26);
    const face = o.faces[0];
    let tx = cx, tz = cz;
    if (face) {
      const [dx, dz] = DIR_NAMES[face];
      if (dx) tx = this.faceCoord(o, dx, 0) - dx * T / 2;
      if (dz) tz = this.faceCoord(o, 0, dz) - dz * T / 2;
      top.rotation.z = { n: 0, s: Math.PI, w: Math.PI / 2, e: -Math.PI / 2 }[face];
    }
    top.position.set(tx, h + 0.005, tz);
    g.add(top);
    if (h > FLAT) {
      for (const f of o.faces) {
        const [dx, dz] = DIR_NAMES[f];
        const m = make();
        m.scale.setScalar(Math.min(0.38, h * 0.8));
        const y = Math.min(h * 0.55, 0.75);
        m.position.set(dx ? this.faceCoord(o, dx, 0) + dx * 0.01 : cx, y, dz ? this.faceCoord(o, 0, dz) + dz * 0.01 : cz);
        m.rotation.y = Math.atan2(dx, dz);
        g.add(m);
      }
    }
    return g;
  }

  buildObject(o, game) {
    const add = (group, update) => {
      this.roomGroup.add(group);
      this.objMeshes.set(o.id, { group, update, o });
    };
    const cx = o.x + 0.5, cz = o.z + 0.5;
    switch (o.t) {
      case 'door': {
        const W = this.room.W;
        const tall = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dz]) => this.wallH[(o.z + dz) * W + o.x + dx] === TALL);
        const h = tall ? 1.0 : 0.36;
        // Palette colours of the original's doors: a bright top over darker sides edged with rivets.
        const colors = { blue: 0x4b7ff8, pink: 0xff44ff, red: 0xdd1111, grey: 0x888888, green: 0x33bb55, yellow: 0xffff00, purple: 0xa040e0 };
        const c = new THREE.Color(colors[o.color] ?? colors.blue);
        // The panel spans the gap to the walls on either side, which stand back from the tile edge.
        let [x0, z0, x1, z1] = doorBox(o);
        const wall = (dx, dz) => (tileAt(this.room, o.x + dx, o.z + dz) === WALL ? I : 0);
        if (o.axis === 'x') { x0 -= wall(-1, 0); x1 += wall(1, 0); } else { z0 -= wall(0, -1); z1 += wall(0, 1); }
        const g = new THREE.Group();
        // It drops into a black slot in the floor.
        const slot = (pad, color, y) => {
          const m = new THREE.Mesh(M.geo.box, new THREE.MeshBasicMaterial({ color }));
          m.scale.set(x1 - x0 + pad, 0.004, z1 - z0 + pad);
          m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
          g.add(m);
        };
        slot(0.08, c.clone().multiplyScalar(0.75), 0.002);
        slot(0, 0x000000, 0.004);
        const panel = new THREE.Mesh(M.geo.box, doorMats(c, x1 - x0, z1 - z0, h));
        panel.scale.set(x1 - x0, h, z1 - z0);
        panel.position.set((x0 + x1) / 2, h / 2, (z0 + z1) / 2);
        g.add(panel);
        let y = o.open ? -h : 0;
        add(g, (o2, dt) => {
          const target = o2.broken ? -h - 0.1 : o2.open ? -h + 0.02 : 0;
          y += (target - y) * Math.min(1, dt * 10);
          panel.position.y = h / 2 + y;
          panel.visible = y > -h + 0.03;
        });
        break;
      }
      // Once pressed, a switch blinks until it is pressed again.
      case 'switch': {
        const g = this.wallFaceMarker(o, 0xfdf070);
        add(g, (o2) => {
          g.visible = o2.found !== false;
          const c = o2.on && this.blinkOff() ? 0x4a4410 : 0xfdf070;
          g.children.forEach((m) => m.material.color.setHex(c));
        });
        break;
      }
      case 'keyhole': {
        const g = this.wallFaceMarker(o, 0xffffff);
        const inner = this.wallFaceMarker(o, 0x777777);
        inner.children.forEach((m) => { m.scale.multiplyScalar(0.45); m.position.y += 0.002; m.renderOrder = 1; });
        inner.children[0].position.y += 0.004;
        g.add(inner);
        const outer = g.children.filter((m) => m !== inner);
        add(g, (o2) => {
          const c = o2.on && this.blinkOff() ? 0x505050 : 0xffffff;
          outer.forEach((m) => m.material.color.setHex(c));
        });
        break;
      }
      case 'eye': {
        const g = new THREE.Group();
        const [dx, dz] = DIR_NAMES[o.dir];
        const ex = dx ? this.faceCoord(o, dx, 0) : cx, ez = dz ? this.faceCoord(o, 0, dz) : cz;
        // On a kerb the eye sits just above the floor.
        const ey = this.wallH[o.z * this.room.W + o.x] <= FLAT ? 0.12 : 0.35;
        const bulb = M.box(0.12, 0.12, 0.12, 0xff40c0, { emissive: 0xc02080 });
        bulb.position.set(ex, ey, ez);
        const beam = new THREE.Mesh(M.geo.box, new THREE.MeshBasicMaterial({ color: 0xff2040, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
        g.add(bulb, beam);
        add(g, (o2, dt, gm) => {
          bulb.visible = !o2.destroyed;
          const on = !o2.destroyed && o2.on;
          beam.visible = on;
          if (on) {
            const bm = gm.eyeBeam(o2);
            const len = Math.max(0.01, bm.len);
            beam.scale.set(dx ? len : 0.03, 0.03, dz ? len : 0.03);
            beam.position.set(bm.x0 + dx * len / 2, ey, bm.z0 + dz * len / 2);
            beam.material.opacity = o2.tripped ? 1 : 0.55 + Math.sin(this.time * 20) * 0.2;
          }
        });
        break;
      }
      case 'vent': {
        const v = M.ventModel();
        v.group.position.set(cx, 0, cz);
        add(v.group, (o2) => {
          v.cover.material.color.setHex(o2.sealed ? 0x33bb55 : Math.sin(this.time * 6) > 0 ? 0xdd1111 : 0x991111);
        });
        break;
      }
      case 'plate': {
        const p = M.plateModel();
        p.group.position.set(cx, 0, cz);
        add(p.group, (o2, dt, gm) => {
          const on = gm.plateOn(o2);
          p.glow.material.opacity = on ? 0.6 + Math.random() * 0.4 : 0;
        });
        break;
      }
      case 'mine': {
        const mm = M.mineModel();
        mm.group.position.set(cx, 0, cz);
        add(mm.group, (o2) => {
          mm.group.visible = !o2.exploded;
          const a = this.time * 5;
          // The red light runs around the perimeter of the square.
          const s = ((a / (Math.PI * 2)) % 1) * 4;
          const seg = Math.floor(s), f = s - seg;
          const pts = [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3], [-0.3, -0.3]];
          mm.light.position.x = pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * f;
          mm.light.position.z = pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * f;
        });
        break;
      }
      case 'tele': {
        const t = M.teleModel();
        t.group.position.set(cx, 0, cz);
        add(t.group, (o2) => {
          t.disc.visible = o2.on;
          t.ring.rotation.z = this.time * 2;
          t.disc.material.opacity = 0.35 + Math.sin(this.time * 5) * 0.2;
        });
        break;
      }
      case 'turret': {
        const t = M.turretModel();
        t.group.position.set(cx, 0, cz);
        const rubble = new THREE.Group();
        for (let i = 0; i < 5; i++) {
          const r = M.box(0.15, 0.08, 0.12, 0x2a4a2a);
          r.position.set((Math.random() - 0.5) * 0.5, 0.04, (Math.random() - 0.5) * 0.5);
          r.rotation.y = Math.random() * 3;
          rubble.add(r);
        }
        t.group.add(rubble);
        add(t.group, (o2, dt) => {
          const alive = !o2.destroyed;
          t.head.visible = t.neck.visible = alive;
          rubble.visible = !alive;
          t.head.rotation.y = -o2.angle;
          // Switched off, the tracker sinks back into its hole.
          t.head.position.y += ((o2.on ? 0 : -0.24) - t.head.position.y) * Math.min(1, dt * 10);
          t.eye.material.color.setHex(o2.on ? 0xff2020 : 0x444444);
          t.eye.material.emissive.setHex(o2.on ? 0xff0000 : 0x000000);
        });
        break;
      }
      case 'tube': {
        const t = M.tubeModel();
        t.group.position.set(cx, 0, cz);
        add(t.group, () => {
          t.rings.forEach((r, i) => { r.position.y = 0.2 + ((this.time * 0.6 + i * 0.45) % 1.8); });
        });
        break;
      }
      case 'prop': {
        const g = M.propModel(o.kind);
        g.position.set(cx, 0, cz);
        if (o.rot) g.rotation.y = o.rot;
        add(g, () => {});
        break;
      }
      case 'terminal': {
        const t = M.terminalModel();
        t.group.position.set(cx, 0, cz);
        t.group.rotation.y = o.rot ?? 0;
        add(t.group, (o2) => {
          t.screen.material.color.setHex(o2.pass && !o2.unlocked && Math.sin(this.time * 4) < 0 ? 0x505050 : 0xffffff);
        });
        break;
      }
      case 'item': {
        const g = M.itemModel(o.item);
        const holder = new THREE.Group();
        holder.add(g);
        holder.position.set(cx, 0.35, cz);
        const shadow = new THREE.Mesh(M.geo.sphereLo, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
        shadow.scale.set(0.35, 0.01, 0.35);
        shadow.position.set(cx, 0.01, cz);
        const grp = new THREE.Group();
        grp.add(holder, shadow);
        add(grp, (o2) => {
          grp.visible = !o2.taken;
          g.rotation.y = this.time * 2;
          holder.position.y = 0.35 + Math.sin(this.time * 3) * 0.06;
        });
        break;
      }
      case 'dish': {
        const d = M.dishModel();
        d.group.position.set(cx, 0, cz);
        const [dx, dz] = DIR_NAMES[o.dir || 'w'];
        d.group.rotation.y = -Math.atan2(dz, dx);
        const beam = new THREE.Mesh(M.geo.box, new THREE.MeshBasicMaterial({ color: 0xffffa0, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
        this.roomGroup.add(beam);
        add(d.group, (o2) => {
          beam.visible = o2.beamT > 0;
          if (beam.visible) {
            const len = o2.beam.len;
            beam.scale.set(dx ? len : 0.5 + Math.random() * 0.2, 0.5 + Math.random() * 0.2, dz ? len : 0.5 + Math.random() * 0.2);
            beam.position.set(cx + dx * len / 2, 0.6, cz + dz * len / 2);
          }
        });
        break;
      }
    }
  }

  fitCamera() {
    const room = this.room;
    const w = window.innerWidth, h = window.innerHeight;
    const target = new THREE.Vector3(room.W / 2, 0, room.H / 2);
    this.camera.position.copy(target).addScaledVector(this.camDir, 60);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
    const inv = this.camera.matrixWorldInverse;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const v = new THREE.Vector3();
    for (const x of [0, room.W]) for (const z of [0, room.H]) for (const y of [-0.6, TALL]) {
      v.set(x, y, z).applyMatrix4(inv);
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    }
    const hud = this.hudPx;
    const availH = Math.max(100, h - hud - 24), availW = Math.max(100, w - 24);
    let scale = Math.max((maxX - minX) / availW, (maxY - minY) / availH); // world units per pixel
    scale = Math.max(scale, 9.5 / availH);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    // Shift so the room is centred in the area above the HUD.
    const offY = (hud / 2) * scale;
    this.camera.left = cx - (w / 2) * scale;
    this.camera.right = cx + (w / 2) * scale;
    this.camera.top = cy + (h / 2) * scale + offY - 6 * scale;
    this.camera.bottom = cy - (h / 2) * scale + offY - 6 * scale;
    this.camera.updateProjectionMatrix();
    this.baseCam = { left: this.camera.left, right: this.camera.right, top: this.camera.top, bottom: this.camera.bottom };
  }

  // ------------------------------------------------------------ entities

  makeEnt(e, game) {
    const g = new THREE.Group();
    const h = { group: g };
    switch (e.kind) {
      case 'player': {
        const hm = M.humanoid(M.PLAYER_COLORS);
        g.add(hm.group);
        h.hum = hm;
        const bubble = new THREE.Mesh(M.geo.sphere, new THREE.MeshBasicMaterial({ color: 0x60c0ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
        bubble.scale.set(0.75, 1.25, 0.75);
        bubble.position.y = 0.5;
        g.add(bubble);
        h.bubble = bubble;
        break;
      }
      case 'survivor': case 'npc': {
        const colors = e.kind === 'npc' && e.obj.look === 'derrida' ? M.DERRIDA_COLORS : M.survivorColors(hash(e.obj.id), e.obj.colors);
        const hm = M.humanoid(colors);
        g.add(hm.group);
        h.hum = hm;
        break;
      }
      case 'cgen': {
        let disguise;
        if (!e.look || e.look === 'survivor') {
          disguise = M.humanoid(M.survivorColors(hash(String(e.obj ? e.obj.id : e.id)), e.obj && e.obj.colors));
          h.dhum = disguise;
          g.add(disguise.group);
          h.disguise = disguise.group;
        } else {
          h.disguise = M.propModel(e.look);
          g.add(h.disguise);
        }
        const real = M.cgenRevealed();
        real.group.visible = false;
        g.add(real.group);
        h.real = real;
        break;
      }
      case 'agen': { const a = M.agenModel(); g.add(a.group); h.a = a; break; }
      case 'bgen': { const b = M.bgenModel(); g.add(b.group); h.b = b; break; }
      case 'dgen': { const d = M.dgenModel(); g.add(d.group); h.hum = d; break; }
      case 'laser': {
        const m = new THREE.Mesh(M.geo.box, new THREE.MeshBasicMaterial({ color: 0xc0ffff }));
        m.scale.set(0.45, 0.06, 0.06);
        const glow = new THREE.Mesh(M.geo.box, new THREE.MeshBasicMaterial({ color: 0x20c0ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
        glow.scale.set(0.55, 0.14, 0.14);
        g.add(m, glow);
        break;
      }
      case 'tshot': {
        g.add(new THREE.Mesh(M.geo.sphereLo, new THREE.MeshBasicMaterial({ color: 0xffa020 })));
        g.children[0].scale.setScalar(0.16);
        const glow = new THREE.Mesh(M.geo.sphereLo, new THREE.MeshBasicMaterial({ color: 0xff4000, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
        glow.scale.setScalar(0.3);
        g.add(glow);
        break;
      }
      case 'grenade': g.add(M.itemModel('grenade')); g.scale.setScalar(0.8); break;
      case 'bomb': g.add(M.itemModel('bomb')); h.inner = g.children[0]; break;
      case 'plasma': {
        const core = new THREE.Mesh(M.geo.sphere, new THREE.MeshBasicMaterial({ color: 0xffe0ff }));
        core.scale.setScalar(0.3);
        const glow = new THREE.Mesh(M.geo.sphere, new THREE.MeshBasicMaterial({ color: 0xc040ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
        glow.scale.setScalar(0.62);
        g.add(core, glow);
        h.glow = glow;
        break;
      }
    }
    this.entGroup.add(g);
    return h;
  }

  syncEnt(e, h, dt, game) {
    const g = h.group;
    g.position.set(e.x, e.y || 0, e.z);
    const t = this.time;
    switch (e.kind) {
      case 'player': {
        const hm = h.hum;
        g.rotation.y = -e.ang;
        if (e.dead) {
          const k = Math.min(1, e.deadT * 3);
          hm.group.rotation.z = -k * Math.PI / 2;
          hm.group.position.y = k * 0.15;
          hm.group.visible = !(e.deadT > 1.1 && Math.floor(e.deadT * 12) % 2);
        } else {
          hm.group.rotation.z = 0;
          hm.group.position.y = 0;
          hm.group.visible = true;
          animateHeld(hm, e, t);
          if (!e.held) M.animateWalk(hm, e.walkT, e.moving, t);
        }
        const sh = game.p.shieldT;
        h.bubble.visible = sh > 0 && !e.dead && (sh > 3 || Math.floor(t * 8) % 2 === 0);
        h.bubble.material.opacity = 0.18 + Math.sin(t * 9) * 0.06;
        if (sh > 0) hm.group.position.x = (Math.random() - 0.5) * 0.03;
        break;
      }
      case 'survivor': case 'npc': {
        const hm = h.hum;
        g.rotation.y = -e.ang;
        const moving = e.kind === 'survivor' && e.state === 'free';
        M.animateWalk(hm, e.walkT || t, moving, t);
        if (e.kind === 'survivor' && e.state === 'trapped') {
          hm.armL.rotation.x = 2.6 + Math.sin(t * 7 + e.id) * 0.4;
          hm.armR.rotation.x = -2.6 - Math.sin(t * 7 + e.id) * 0.4;
        } else {
          hm.armL.rotation.x *= 0.8; hm.armR.rotation.x *= 0.8;
        }
        if (e.shakeT > 0) { g.position.x += (Math.random() - 0.5) * 0.1; g.position.z += (Math.random() - 0.5) * 0.1; }
        break;
      }
      case 'cgen': {
        const st = e.state;
        g.rotation.y = -e.ang;
        if (st === 'disguised') {
          h.disguise.visible = true; h.real.group.visible = false;
          if (h.dhum) {
            h.dhum.armL.rotation.x = 2.6 + Math.sin(t * 7) * 0.4;
            h.dhum.armR.rotation.x = -2.6 - Math.sin(t * 7) * 0.4;
          }
        } else if (st === 'reveal') {
          const f = Math.floor(t * 16) % 2 === 0;
          h.disguise.visible = f; h.real.group.visible = !f;
        } else {
          h.disguise.visible = false; h.real.group.visible = true;
          M.animateWalk(h.real, e.walkT || 0, st === 'chase', t);
          h.real.armL.rotation.x = -1.2 + Math.sin(t * 14) * 0.5;
          h.real.armR.rotation.x = 1.2 - Math.sin(t * 14) * 0.5;
        }
        break;
      }
      case 'agen': {
        const a = h.a;
        const hunting = e.state === 'hunt' || e.state === 'smother';
        a.inner.position.y = 0.26 + Math.abs(Math.sin(e.walkT * 5)) * (e.state === 'smother' ? 0.15 : 0.45);
        if (e.state === 'emerge') { const k = 1 - Math.max(0, e.stateT) / 0.6; a.inner.scale.setScalar(k); }
        else a.inner.scale.setScalar(1);
        a.ball.material.opacity += ((hunting ? 0.18 : 1) - a.ball.material.opacity) * Math.min(1, dt * 6);
        a.wire.material.opacity = hunting ? 0.9 : 0;
        a.eye.visible = !hunting;
        if (e.state === 'smother') a.inner.scale.setScalar(1.3 + Math.sin(t * 20) * 0.1);
        break;
      }
      case 'bgen': {
        const b = h.b;
        const st = e.state;
        b.dots.visible = st === 'under';
        b.dots.rotation.y = t * 3;
        if (st === 'bounce') { b.inner.visible = true; b.inner.position.y = Math.abs(Math.sin(e.walkT * 9)) * 0.35; b.inner.scale.set(1, 1, 1); }
        else if (st === 'dive') { b.inner.visible = true; const k = Math.max(0, e.stateT) / 0.45; b.inner.scale.set(1, k, 1); b.inner.position.y = 0; }
        else if (st === 'emerge') { b.inner.visible = true; const k = 1 - Math.max(0, e.stateT) / 0.35; b.inner.scale.set(1, k, 1); b.inner.position.y = 0; }
        else b.inner.visible = false;
        break;
      }
      case 'dgen': {
        const hm = h.hum;
        g.rotation.y = -e.ang;
        M.animateWalk(hm, e.walkT || 0, e.state === 'chase', t);
        const hue = (t * 0.3) % 1;
        hm.group.traverse((m) => { if (m.isMesh && m.material.emissive) m.material.emissive.setHSL(hue, 0.7, 0.25); });
        hm.aura.material.opacity = 0.12 + Math.sin(t * 6) * 0.06;
        hm.group.visible = Math.random() > 0.04;
        break;
      }
      case 'laser':
        g.position.y = 0.5;
        g.rotation.y = -Math.atan2(e.dz, e.dx);
        break;
      case 'tshot':
        g.position.y = 0.58; // out of the tracker's barrel
        break;
      case 'grenade':
        g.position.y = 0.45;
        g.rotation.z += dt * 10;
        break;
      case 'bomb': {
        const k = 1 + Math.max(0, Math.sin((2.6 - e.fuse) * (4 + (2.6 - e.fuse) * 4))) * 0.4;
        g.scale.setScalar(k);
        g.position.y = 0.15;
        break;
      }
      case 'plasma':
        g.position.y = 0.4;
        h.glow.scale.setScalar(0.55 + Math.random() * 0.15);
        break;
    }
  }

  // ------------------------------------------------------------ effects

  burst(x, y, z, n, colors, speed = 3, life = 0.7, size = 0.08, gravity = -9) {
    for (let i = 0; i < n; i++) {
      const c = colors[i % colors.length];
      const m = new THREE.Mesh(M.geo.box, new THREE.MeshBasicMaterial({ color: c, transparent: true }));
      const s = size * (0.6 + Math.random() * 0.8);
      m.scale.setScalar(s);
      m.position.set(x, y, z);
      const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1;
      const sp = speed * (0.4 + Math.random() * 0.6);
      const r = Math.sqrt(1 - u * u);
      this.fxGroup.add(m);
      this.particles.push({ m, vx: Math.cos(a) * r * sp, vy: Math.abs(u) * sp + 1, vz: Math.sin(a) * r * sp, life, max: life, g: gravity });
    }
  }

  flash(x, y, z, color, size, life = 0.35, ring = false) {
    const m = ring
      ? new THREE.Mesh(M.geo.ring, new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }))
      : new THREE.Mesh(M.geo.sphere, new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    if (ring) m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    this.fxGroup.add(m);
    this.flashes.push({ m, size, life, max: life });
  }

  onEvent(ev, game) {
    const pl = game.player;
    switch (ev.type) {
      case 'explode':
        this.flash(ev.x, 0.4, ev.z, 0xffa040, (ev.r || 1) * 2.2, 0.4);
        this.flash(ev.x, 0.4, ev.z, 0xffffc0, (ev.r || 1) * 1.2, 0.2);
        this.burst(ev.x, 0.3, ev.z, ev.small ? 10 : 28, [0xffa020, 0xffe060, 0x888888, 0xff4020], 4.5, 0.8, 0.1);
        this.shake = Math.max(this.shake, ev.bomb ? 0.35 : 0.2);
        break;
      case 'death': {
        const cols = { agen: [0xd02020, 0xff6060], bgen: [0x2050e0, 0x80a0ff], cgen: [0x111111, 0xff2020], survivor: [0xd9786b, 0xff3030], dgen: [0xaaffee, 0xffffff] }[ev.kind] || [0xffffff];
        this.burst(ev.x, 0.4, ev.z, 18, cols, 3.5, 0.8, 0.09);
        this.flash(ev.x, 0.4, ev.z, cols[0], 0.9, 0.25);
        if (ev.kind === 'dgen') { this.burst(ev.x, 0.6, ev.z, 60, [0xff2020, 0xaaffee, 0xffffff, 0x800000], 6, 1.4, 0.12); this.shake = 0.5; }
        break;
      }
      case 'playerDeath':
        this.burst(ev.x, 0.5, ev.z, 22, [0xd9786b, 0xff2020, 0xf0c8a0], 3, 0.9, 0.09);
        this.flash(ev.x, 0.5, ev.z, 0xff2020, 1.2, 0.3);
        this.shake = 0.25;
        break;
      case 'spark': case 'bounce':
        this.burst(ev.x, 0.5, ev.z, ev.type === 'spark' ? 8 : 4, [0xffffff, 0x80ffff], 2.5, 0.3, 0.05, -2);
        break;
      case 'fizzle':
        this.burst(ev.x, 0.5, ev.z, ev.big ? 12 : 5, [0xff80ff, 0xffffff, 0x80ffff], 2, 0.35, 0.05, -2);
        break;
      case 'tele':
        this.flash(ev.x, 0.05, ev.z, 0x60ffff, ev.small ? 0.8 : 1.6, 0.4, true);
        if (!ev.small) this.burst(ev.x, 0.5, ev.z, 10, [0x80ffff, 0xffffff], 1.5, 0.5, 0.05, 2);
        break;
      case 'seal': {
        const o = ev.o;
        this.flash(o.x + 0.5, 0.05, o.z + 0.5, 0x40ff60, 1.6, 0.5, true);
        break;
      }
      case 'ventSpawn':
        this.flash(ev.x, 0.05, ev.z, 0xff4040, 1.2, 0.4, true);
        break;
      case 'zap':
        this.flash(ev.x, 0.3, ev.z, 0xa0e0ff, 1.0, 0.25);
        this.burst(ev.x, 0.3, ev.z, 10, [0xffffff, 0xa0e0ff], 3, 0.4, 0.05);
        break;
      case 'rescued':
        this.burst(ev.x, 0.4, ev.z, 20, [0x40ff60, 0xffffff, 0xffff60], 1.5, 1.0, 0.06, 3);
        this.flash(ev.x, 0.05, ev.z, 0x40ff60, 1.4, 0.6, true);
        break;
      case 'freed':
        this.flash(ev.x, 0.05, ev.z, 0x40ff60, 1.0, 0.5, true);
        break;
      case 'secured':
        if (pl) this.flash(pl.x, 0.05, pl.z, 0x40ff60, 6, 0.8, true);
        break;
      case 'cgenReveal':
        this.flash(ev.x, 0.6, ev.z, 0xff2020, 1.4, 0.4);
        break;
      case 'turretDestroyed': {
        const o = ev.o;
        this.burst(o.x + 0.5, 0.5, o.z + 0.5, 16, [0x3fa04a, 0x888888, 0xffa020], 3.5, 0.8, 0.09);
        break;
      }
      case 'dish':
        this.shake = 0.3;
        break;
    }
  }

  update(game, dt) {
    this.time += dt;
    for (const h of this.objMeshes.values()) h.update(h.o, dt, game);
    if (this.secPanel) {
      const r = game.room;
      this.secPanel.material.color.setHex(r.secured || !r.threat ? 0x33bb55 : Math.floor(this.time * 3) % 2 ? 0xdd1111 : 0x440808);
    }
    if (this.eyes && game.player) {
      for (const e of this.eyes) {
        e.lookAt(game.player.x, 0.6, game.player.z);
        const blink = (this.time + e.userData.phase) % 4 < 0.12;
        e.scale.y = e.scale.x * (blink ? 0.1 : 1);
      }
    }
    const seen = new Set();
    for (const e of game.ents) {
      if (e.remove && e.kind !== 'player') continue;
      let h = this.entMeshes.get(e.id);
      if (!h) { h = this.makeEnt(e, game); this.entMeshes.set(e.id, h); }
      this.syncEnt(e, h, dt, game);
      seen.add(e.id);
    }
    for (const [id, h] of this.entMeshes) {
      if (!seen.has(id)) { this.entGroup.remove(h.group); this.entMeshes.delete(id); }
    }
    // Particles.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.fxGroup.remove(p.m); p.m.material.dispose(); this.particles.splice(i, 1); continue; }
      p.vy += p.g * dt;
      p.m.position.x += p.vx * dt;
      p.m.position.y = Math.max(0.02, p.m.position.y + p.vy * dt);
      p.m.position.z += p.vz * dt;
      if (p.m.position.y <= 0.02) { p.vx *= 0.8; p.vz *= 0.8; p.vy = Math.abs(p.vy) * 0.3; }
      p.m.material.opacity = Math.min(1, p.life / p.max * 2);
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) { this.fxGroup.remove(f.m); f.m.material.dispose(); this.flashes.splice(i, 1); continue; }
      const k = 1 - f.life / f.max;
      f.m.scale.setScalar(f.size * (0.3 + k * 0.7));
      f.m.material.opacity = 1 - k;
    }
    // Screen shake.
    if (this.baseCam) {
      const c = this.camera, b = this.baseCam;
      const s = this.shake > 0 ? this.shake * 0.25 : 0;
      this.shake = Math.max(0, this.shake - dt);
      const ox = (Math.random() - 0.5) * s, oy = (Math.random() - 0.5) * s;
      c.left = b.left + ox; c.right = b.right + ox; c.top = b.top + oy; c.bottom = b.bottom + oy;
      c.updateProjectionMatrix();
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------ title backdrop

  showTitle() {
    this.hideTitle();
    this.room = null;
    this.clearGroup(this.roomGroup);
    this.clearGroup(this.entGroup);
    this.clearGroup(this.fxGroup);
    this.objMeshes.clear();
    this.entMeshes.clear();
    const g = new THREE.Group();
    const winTex = (lit, cols) => canvasTex(64, 256, (c, w, h) => {
      c.fillStyle = '#0a0c1a'; c.fillRect(0, 0, w, h);
      for (let y = 4; y < h; y += 6) for (let x = 3; x < w; x += 6) {
        if (Math.random() < lit) { c.fillStyle = cols[(Math.random() * cols.length) | 0]; c.fillRect(x, y, 3, 3); }
      }
    });
    const towerMat = new THREE.MeshBasicMaterial({ map: winTex(0.45, ['#e8d070', '#7090ff', '#e8e8f0']) });
    const roofMat = M.mat(0x9a9aa6);
    const tower = new THREE.Mesh(M.geo.box, [towerMat, towerMat, roofMat, roofMat, towerMat, towerMat]);
    tower.scale.set(4, 18, 4);
    tower.position.y = 9;
    g.add(tower);
    // The 80th-floor setback and the floors above it.
    const upper = new THREE.Mesh(M.geo.box, [towerMat, towerMat, roofMat, roofMat, towerMat, towerMat]);
    upper.scale.set(2.8, 5, 2.8);
    upper.position.y = 20.5;
    g.add(upper);
    const ant = M.box(0.12, 3, 0.12, 0xc0c0c8);
    ant.position.y = 24.5;
    g.add(ant);
    this.titleBeacon = new THREE.Mesh(M.geo.sphereLo, new THREE.MeshBasicMaterial({ color: 0xff2020 }));
    this.titleBeacon.scale.setScalar(0.3);
    this.titleBeacon.position.y = 26;
    g.add(this.titleBeacon);
    const cityMat = new THREE.MeshBasicMaterial({ map: winTex(0.2, ['#c0a050', '#405090']) });
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2, r = 5 + Math.random() * 14;
      const h = 2 + Math.random() * 9;
      const b = new THREE.Mesh(M.geo.box, [cityMat, cityMat, M.mat(0x303040), M.mat(0x303040), cityMat, cityMat]);
      b.scale.set(1.5 + Math.random() * 2, h, 1.5 + Math.random() * 2);
      b.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
      g.add(b);
    }
    const ground = new THREE.Mesh(M.geo.plane, new THREE.MeshBasicMaterial({ color: 0x05060c }));
    ground.rotation.x = -Math.PI / 2;
    ground.scale.setScalar(600);
    g.add(ground);
    this.scene.add(g);
    this.titleGroup = g;
    this.titleT = 0;
    const target = new THREE.Vector3(0, 12, 0);
    this.camera.position.copy(target).addScaledVector(this.camDir, 80);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
    const w = window.innerWidth, h = window.innerHeight;
    const half = 16;
    this.camera.top = half; this.camera.bottom = -half;
    this.camera.left = -half * w / h; this.camera.right = half * w / h;
    // Push the tower to the right so the menu has room on the left.
    this.camera.left -= half * 0.5; this.camera.right -= half * 0.5;
    this.camera.updateProjectionMatrix();
    this.baseCam = null;
  }

  updateTitle(dt) {
    this.titleT += dt;
    this.titleGroup.rotation.y += dt * 0.12;
    this.titleBeacon.visible = Math.floor(this.titleT * 1.5) % 2 === 0;
  }

  hideTitle() {
    if (this.titleGroup) { this.scene.remove(this.titleGroup); this.titleGroup = null; }
  }
}

function animateHeld(hm, e, t) {
  if (e.held) {
    hm.armL.rotation.x = 2.2 + Math.sin(t * 25) * 0.6;
    hm.armR.rotation.x = -2.2 - Math.sin(t * 25) * 0.6;
    hm.legL.rotation.z = Math.sin(t * 20) * 0.4;
    hm.legR.rotation.z = -Math.sin(t * 20) * 0.4;
  } else {
    hm.armL.rotation.x *= 0.7;
    hm.armR.rotation.x *= 0.7;
  }
}
