// three.js view of the simulation: builds a room's static geometry on every flip,
// mirrors dynamic entities into meshes, and plays particle effects for game events.
import * as THREE from '../../vendor/three.module.min.js';
import * as M from './models.js';
import { tileAt, VOID, FLOOR, WALL, DOOR, doorBox } from '../sim/room.js';
import { DIR_NAMES } from '../sim/util.js';

export const THEMES = {
  navy: { floor: '#16236a', line: '#3a56d0', hatch: '#1d2d80', wallTop: 0xa0a0aa, wall: 0x2b3fa6, facade: '#14205a', window: '#3a56d0' },
  steel: { floor: '#203048', line: '#5a7aa0', hatch: '#26384f', wallTop: 0xb0b0b8, wall: 0x4a5a70, facade: '#1a2638', window: '#6a8ab0' },
  teal: { floor: '#0f3a40', line: '#2a9a90', hatch: '#14474e', wallTop: 0xa8b0b0, wall: 0x206a70, facade: '#0c2c30', window: '#40c0b0' },
  maroon: { floor: '#4a1622', line: '#a03a4a', hatch: '#561a28', wallTop: 0xa09898, wall: 0x7a2a38, facade: '#3a1018', window: '#c04a5a' },
  plum: { floor: '#2e1840', line: '#7a4aa0', hatch: '#381e4e', wallTop: 0xa8a0b0, wall: 0x5a3a7a, facade: '#22102e', window: '#9a6ac0' },
  olive: { floor: '#24301a', line: '#6a8a3a', hatch: '#2c3a20', wallTop: 0xaab0a0, wall: 0x4a6030, facade: '#1a2412', window: '#8ab050' },
  dream: { floor: '#1a0828', line: '#e040e0', hatch: '#260a3a', wallTop: 0xe0a0ff, wall: 0x6020a0, facade: '#100018', window: '#ff60ff' },
  white: { floor: '#3a3a44', line: '#9a9aa8', hatch: '#44444f', wallTop: 0xd0d0d8, wall: 0x70707c, facade: '#22222a', window: '#c0c0d0' },
};

const TALL = 1.35, LOW = 0.42;

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

function floorTexture(th) {
  return canvasTex(32, 32, (g, w, h) => {
    g.fillStyle = th.floor; g.fillRect(0, 0, w, h);
    g.fillStyle = th.hatch;
    for (let i = 0; i < w; i += 4) g.fillRect(i, 0, 1, h);
    g.fillStyle = th.line;
    g.fillRect(0, 0, w, 1); g.fillRect(0, 0, 1, h);
  });
}

function facadeTexture(th) {
  return canvasTex(32, 64, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, th.facade); grd.addColorStop(1, '#000000');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.fillStyle = th.window;
    for (let y = 6; y < h; y += 8) for (let x = 2; x < w; x += 6) {
      g.globalAlpha = Math.max(0, 0.55 - y / h * 0.6) * (Math.random() < 0.8 ? 1 : 0.3);
      g.fillRect(x, y, 3, 4);
    }
    g.globalAlpha = 1;
    g.fillStyle = '#9a9aa6'; g.fillRect(0, 0, w, 2);
  });
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
    g.traverse((o) => {
      if (!o.isMesh) return;
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
    const { W, H } = room;

    // Floor: one quad per walkable tile (and under walls, so thin walls leave no gaps).
    const pos = [], uv = [], idx = [];
    const quad = (x0, z0, x1, z1, y = 0) => {
      const b = pos.length / 3;
      pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
      uv.push(0, 1, 1, 1, 1, 0, 0, 0);
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    };
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) if (tileAt(room, x, z) !== VOID) quad(x, z, x + 1, z + 1);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    fg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    fg.setIndex(idx);
    fg.computeVertexNormals();
    const floorTex = this.tex('floor', th, floorTexture);
    this.roomGroup.add(new THREE.Mesh(fg, new THREE.MeshLambertMaterial({ map: floorTex })));

    // Facade: the skyscraper falls away below the visible edges of the room.
    const fpos = [], fuv = [], fidx = [];
    const vquad = (ax, az, bx, bz, depth) => {
      const b = fpos.length / 3;
      fpos.push(ax, 0, az, bx, 0, bz, bx, -depth, bz, ax, -depth, az);
      const len = Math.hypot(bx - ax, bz - az);
      fuv.push(0, 1, len, 1, len, 0, 0, 0);
      fidx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      if (tileAt(room, x, z) === VOID) continue;
      if (tileAt(room, x + 1, z) === VOID) vquad(x + 1, z + 1, x + 1, z, 4);
      if (tileAt(room, x, z + 1) === VOID) vquad(x, z + 1, x + 1, z + 1, 4);
    }
    if (fpos.length) {
      const fgeo = new THREE.BufferGeometry();
      fgeo.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
      fgeo.setAttribute('uv', new THREE.Float32BufferAttribute(fuv, 2));
      fgeo.setIndex(fidx);
      const ft = this.tex('facade', th, facadeTexture);
      ft.wrapS = THREE.RepeatWrapping;
      this.roomGroup.add(new THREE.Mesh(fgeo, new THREE.MeshBasicMaterial({ map: ft, side: THREE.DoubleSide })));
    }

    // Walls with the cutaway rule: anything that would hide floor behind it is drawn low.
    const wallMats = [];
    const sideMat = M.mat(th.wall);
    const topMat = M.mat(th.wallTop);
    for (let i = 0; i < 6; i++) wallMats.push(i === 2 ? topMat : sideMat);
    this.wallH = new Float32Array(W * H);
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      if (tileAt(room, x, z) !== WALL) continue;
      const behind = [[-1, 0], [0, -1], [-1, -1]].some(([dx, dz]) => {
        const t = tileAt(room, x + dx, z + dz);
        return t === FLOOR || t === DOOR;
      });
      const h = behind ? LOW : TALL;
      this.wallH[z * W + x] = h;
      const b = room.wallBox[z * W + x];
      const m = new THREE.Mesh(M.geo.box, wallMats);
      m.scale.set(b[2] - b[0], h, b[3] - b[1]);
      m.position.set((b[0] + b[2]) / 2, h / 2, (b[1] + b[3]) / 2);
      this.roomGroup.add(m);
    }

    // Exit corridors: a dim strip of floor leading off-screen.
    for (const ex of room.exits) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (tileAt(room, ex.x + dx, ex.z + dz) !== VOID) continue;
        for (let k = 1; k <= 2; k++) {
          const m = new THREE.Mesh(M.geo.plane, new THREE.MeshBasicMaterial({ color: new THREE.Color(th.floor).multiplyScalar(k === 1 ? 0.8 : 0.45) }));
          m.rotation.x = -Math.PI / 2;
          m.position.set(ex.x + 0.5 + dx * k, -0.001, ex.z + 0.5 + dz * k);
          this.roomGroup.add(m);
        }
        const arrow = M.arrowDecal();
        arrow.children[0].material = new THREE.MeshBasicMaterial({ color: 0xf0d040 });
        arrow.scale.setScalar(0.6);
        arrow.position.set(ex.x + 0.5, 0, ex.z + 0.5);
        arrow.rotation.y = Math.atan2(-dx, -dz);
        this.roomGroup.add(arrow);
      }
    }
    for (const a of room.arrows) {
      const g = M.arrowDecal();
      g.position.set(a.x + 0.5, 0, a.z + 0.5);
      // Point the arrow out of the room, toward the nearest void/edge.
      let best = [0, -1];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
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

  wallFaceMarker(o, color, opts = {}) {
    const g = new THREE.Group();
    const b = this.room.wallBox[o.z * this.room.W + o.x];
    const h = this.wallH[o.z * this.room.W + o.x];
    const cx = (b[0] + b[2]) / 2, cz = (b[1] + b[3]) / 2;
    const make = () => new THREE.Mesh(opts.geo || M.geo.tri, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    // Flat marker on top of the wall, always visible from the camera.
    const top = make();
    top.rotation.x = -Math.PI / 2;
    top.scale.setScalar(0.42);
    top.position.set(cx, h + 0.005, cz);
    const face = o.faces[0];
    if (face) top.rotation.z = { n: 0, s: Math.PI, w: Math.PI / 2, e: -Math.PI / 2 }[face];
    g.add(top);
    for (const f of o.faces) {
      const [dx, dz] = DIR_NAMES[f];
      const m = make();
      m.scale.setScalar(Math.min(0.38, h * 0.8));
      const y = Math.min(h * 0.55, 0.75);
      m.position.set(dx > 0 ? b[2] + 0.01 : dx < 0 ? b[0] - 0.01 : cx, y, dz > 0 ? b[3] + 0.01 : dz < 0 ? b[1] - 0.01 : cz);
      m.rotation.y = Math.atan2(dx, dz);
      g.add(m);
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
        const b = doorBox(o);
        const nearTall = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dz]) => this.wallH[(o.z + dz) * this.room.W + o.x + dx] === TALL);
        const h = nearTall ? 1.15 : 0.72;
        const colors = { blue: 0x3a7aff, pink: 0xff6ac8, red: 0xe02828, grey: 0x9a9aa8, green: 0x30c050, yellow: 0xe0c020, purple: 0xa040e0 };
        const c = colors[o.color] ?? 0x3a7aff;
        const g = new THREE.Group();
        const panel = M.box(b[2] - b[0], h, b[3] - b[1], c, { emissive: new THREE.Color(c).multiplyScalar(0.25).getHex() });
        panel.position.set((b[0] + b[2]) / 2, h / 2, (b[1] + b[3]) / 2);
        const stripe = M.box((b[2] - b[0]) * 1.02, 0.05, (b[3] - b[1]) * 1.02, 0xffffff, { emissive: 0x444444 });
        stripe.position.set(panel.position.x, h * 0.75, panel.position.z);
        const frame = M.box(o.axis === 'x' ? 1 : 0.5, 0.02, o.axis === 'x' ? 0.5 : 1, 0x111111);
        frame.position.set(cx, 0.01, cz);
        g.add(frame, panel, stripe);
        let y = o.open ? -h : 0;
        add(g, (o2, dt) => {
          const target = o2.broken ? -h - 0.1 : o2.open ? -h + 0.02 : 0;
          y += (target - y) * Math.min(1, dt * 10);
          panel.position.y = h / 2 + y;
          stripe.position.y = h * 0.75 + y;
          panel.visible = stripe.visible = y > -h + 0.03;
        });
        break;
      }
      case 'switch': {
        const g = this.wallFaceMarker(o, 0xffd020);
        add(g, (o2) => {
          g.visible = o2.found !== false;
          const c = o2.on ? 0xff8a20 : 0xffd020;
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
        add(g, () => {});
        break;
      }
      case 'eye': {
        const g = new THREE.Group();
        const [dx, dz] = DIR_NAMES[o.dir];
        const b = this.room.wallBox[o.z * this.room.W + o.x];
        const ex = dx > 0 ? b[2] : dx < 0 ? b[0] : cx, ez = dz > 0 ? b[3] : dz < 0 ? b[1] : cz;
        const bulb = M.box(0.12, 0.12, 0.12, 0xff40c0, { emissive: 0xc02080 });
        bulb.position.set(ex, 0.35, ez);
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
            beam.position.set(bm.x0 + dx * len / 2, 0.35, bm.z0 + dz * len / 2);
            beam.material.opacity = o2.tripped ? 1 : 0.55 + Math.sin(this.time * 20) * 0.2;
          }
        });
        break;
      }
      case 'vent': {
        const v = M.ventModel();
        v.group.position.set(cx, 0, cz);
        add(v.group, (o2) => {
          const c = o2.sealed ? 0x20d040 : 0xd02020;
          v.rim.material.color.setHex(c);
          v.rim.material.emissive.setHex(o2.sealed ? 0x106020 : (Math.sin(this.time * 6) > 0 ? 0xa01010 : 0x400808));
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
        add(t.group, (o2) => {
          const alive = !o2.destroyed;
          t.head.visible = t.neck.visible = alive;
          rubble.visible = !alive;
          t.head.rotation.y = -o2.angle;
          t.head.position.y = o2.on ? 0.62 : 0.4;
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
          const blink = o2.pass && !o2.unlocked ? (Math.sin(this.time * 4) > 0 ? 0x20c050 : 0x105020) : 0x20c050;
          t.screen.material.emissive.setHex(blink);
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
        g.position.y = 0.55;
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
