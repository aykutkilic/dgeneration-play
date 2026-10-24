// Low-poly mesh builders for every object and creature in the game.
import * as THREE from '../../vendor/three.module.min.js';

const matCache = new Map();
export function mat(color, opts) {
  opts = opts || {};
  const key = `${color}|${JSON.stringify(opts)}`;
  if (!matCache.has(key)) {
    const m = opts.basic
      ? new THREE.MeshBasicMaterial({ color, transparent: !!opts.transparent, opacity: opts.opacity ?? 1, depthWrite: opts.depthWrite ?? !opts.transparent, side: opts.side ?? THREE.FrontSide, blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending, wireframe: !!opts.wireframe })
      : new THREE.MeshLambertMaterial({ color, emissive: opts.emissive ?? 0x000000, emissiveIntensity: opts.ei ?? 1, transparent: !!opts.transparent, opacity: opts.opacity ?? 1, flatShading: true, side: opts.side ?? THREE.FrontSide });
    matCache.set(key, m);
  }
  return matCache.get(key);
}

const geo = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(0.5, 12, 8),
  sphereLo: new THREE.SphereGeometry(0.5, 8, 6),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
  cylLo: new THREE.CylinderGeometry(0.5, 0.5, 1, 6),
  cone4: new THREE.ConeGeometry(0.5, 1, 4),
  cone: new THREE.ConeGeometry(0.5, 1, 10),
  ring: new THREE.RingGeometry(0.32, 0.45, 24),
  torus: new THREE.TorusGeometry(0.35, 0.06, 6, 20),
  tri: (() => {
    const s = new THREE.Shape();
    s.moveTo(-0.5, -0.43); s.lineTo(0.5, -0.43); s.lineTo(0, 0.43); s.lineTo(-0.5, -0.43);
    return new THREE.ShapeGeometry(s);
  })(),
  plane: new THREE.PlaneGeometry(1, 1),
};
export { geo };

// Geometries and cached materials reused by every room; never dispose these.
export function sharedResources() {
  return new Set([...Object.values(geo), ...matCache.values()]);
}

function rot(m, axis, a) {
  m.rotation[axis] = a;
  return m;
}

export function box(w, h, d, color, opts) {
  const m = new THREE.Mesh(geo.box, mat(color, opts));
  m.scale.set(w, h, d);
  return m;
}

function part(g, color, opts, sx, sy, sz, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(g, mat(color, opts));
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  return m;
}

// ---------------------------------------------------------------- humanoids

// Builds a figure facing +x. Returns { group, parts } so it can be animated.
export function humanoid(c) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const legL = new THREE.Group(), legR = new THREE.Group();
  legL.position.set(0, 0.42, -0.08);
  legR.position.set(0, 0.42, 0.08);
  legL.add(part(geo.box, c.legs, null, 0.11, 0.42, 0.11, 0, -0.21, 0));
  legR.add(part(geo.box, c.legs, null, 0.11, 0.42, 0.11, 0, -0.21, 0));
  legL.add(part(geo.box, c.shoes ?? 0x222222, null, 0.17, 0.06, 0.12, 0.03, -0.42, 0));
  legR.add(part(geo.box, c.shoes ?? 0x222222, null, 0.17, 0.06, 0.12, 0.03, -0.42, 0));
  const torso = part(geo.box, c.torso, null, 0.17, 0.34, 0.3, 0, 0.6, 0);
  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(0, 0.74, -0.2);
  armR.position.set(0, 0.74, 0.2);
  armL.add(part(geo.box, c.arms ?? c.torso, null, 0.09, 0.34, 0.09, 0, -0.16, 0));
  armR.add(part(geo.box, c.arms ?? c.torso, null, 0.09, 0.34, 0.09, 0, -0.16, 0));
  armL.add(part(geo.box, c.skin, null, 0.08, 0.07, 0.08, 0, -0.35, 0));
  armR.add(part(geo.box, c.skin, null, 0.08, 0.07, 0.08, 0, -0.35, 0));
  const head = new THREE.Group();
  head.position.set(0, 0.88, 0);
  head.add(part(geo.box, c.skin, null, 0.17, 0.17, 0.17, 0, 0.0, 0));
  head.add(part(geo.box, c.hair ?? 0x3a2a1a, null, 0.19, 0.07, 0.19, -0.01, 0.09, 0));
  if (c.visor) head.add(part(geo.box, c.visor, { emissive: c.visor, ei: 0.4 }, 0.04, 0.05, 0.15, 0.08, 0.01, 0));
  body.add(legL, legR, torso, armL, armR, head);
  if (c.coat) body.add(part(geo.box, c.coat, null, 0.2, 0.3, 0.33, -0.01, 0.42, 0));
  if (c.pack) body.add(part(geo.box, c.pack, null, 0.12, 0.22, 0.22, -0.13, 0.62, 0));
  return { group: g, body, legL, legR, armL, armR, head, torso };
}

export function animateWalk(h, walkT, moving, t) {
  if (moving) {
    const s = Math.sin(walkT * 11);
    h.legL.rotation.z = s * 0.6;
    h.legR.rotation.z = -s * 0.6;
    h.armL.rotation.z = -s * 0.5;
    h.armR.rotation.z = s * 0.5;
    h.body.position.y = Math.abs(Math.cos(walkT * 11)) * 0.035;
  } else {
    h.legL.rotation.z *= 0.7;
    h.legR.rotation.z *= 0.7;
    h.armL.rotation.z *= 0.7;
    h.armR.rotation.z *= 0.7;
    h.body.position.y = Math.sin(t * 2) * 0.006;
  }
}

export const PLAYER_COLORS = { torso: 0xd9786b, legs: 0xb85a52, arms: 0xd9786b, skin: 0xf0c8a0, hair: 0xe0c060, shoes: 0x333333, visor: 0x66ddff, pack: 0x777788 };

const SURVIVOR_PALETTES = [
  { torso: 0x3f7fd0, legs: 0x2b3555, skin: 0xe8c09a, hair: 0x2a1a10 },
  { torso: 0xe0e0e0, legs: 0x404040, skin: 0xc89870, hair: 0x101010, coat: 0xf2f2f2 },
  { torso: 0x55a050, legs: 0x5a4a30, skin: 0xf0d0b0, hair: 0x803010 },
  { torso: 0xd0b040, legs: 0x303060, skin: 0x9a6a48, hair: 0x1a1a1a },
  { torso: 0x9a50b0, legs: 0x302030, skin: 0xe8c8a8, hair: 0xa0a0a0 },
  { torso: 0xd06030, legs: 0x404850, skin: 0xd8a888, hair: 0x504030 },
];
export function survivorColors(seed, override) {
  return { ...SURVIVOR_PALETTES[Math.abs(seed) % SURVIVOR_PALETTES.length], ...(override || {}) };
}

export const DERRIDA_COLORS = { torso: 0xf4f4f4, legs: 0x505060, skin: 0xe8c8a8, hair: 0xcccccc, coat: 0xffffff, arms: 0xf4f4f4 };

// ---------------------------------------------------------------- creatures

export function agenModel() {
  const g = new THREE.Group();
  const ball = new THREE.Mesh(geo.sphere, mat(0xd02020, { emissive: 0x400000 }).clone());
  ball.material.transparent = true;
  ball.scale.setScalar(0.52);
  const eye = part(geo.sphereLo, 0xffff60, { basic: true }, 0.12, 0.12, 0.12, 0.22, 0.05, 0);
  const wire = new THREE.Mesh(geo.sphereLo, new THREE.MeshBasicMaterial({ color: 0x40ff60, wireframe: true, transparent: true, opacity: 0 }));
  wire.scale.setScalar(0.56);
  const inner = new THREE.Group();
  inner.add(ball, eye, wire);
  g.add(inner);
  return { group: g, inner, ball, eye, wire };
}

export function bgenModel() {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  const body = part(geo.cyl, 0x2050e0, { emissive: 0x081840 }, 0.42, 0.5, 0.42, 0, 0.25, 0);
  const cap = part(geo.cyl, 0x80a0ff, null, 0.44, 0.06, 0.44, 0, 0.52, 0);
  const band = part(geo.cyl, 0x102060, null, 0.45, 0.06, 0.45, 0, 0.12, 0);
  inner.add(body, cap, band);
  g.add(inner);
  // Dotted ring that shows where it hides under the floor.
  const dots = new THREE.Group();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    dots.add(part(geo.box, 0x30ff60, { basic: true }, 0.06, 0.02, 0.06, Math.cos(a) * 0.3, 0.03, Math.sin(a) * 0.3));
  }
  g.add(dots);
  return { group: g, inner, dots };
}

export function cgenRevealed() {
  const h = humanoid({ torso: 0x111111, legs: 0x111111, skin: 0x220000, hair: 0x660000, shoes: 0x000000, arms: 0x111111 });
  const glow = mat(0xff2020, { emissive: 0xff0000 });
  const eyes = part(geo.box, 0xff0000, { emissive: 0xff2020 }, 0.03, 0.04, 0.14, 0.09, 0.0, 0);
  h.head.add(eyes);
  for (let i = 0; i < 4; i++) {
    const spike = new THREE.Mesh(geo.cone4, glow);
    spike.scale.set(0.06, 0.18, 0.06);
    spike.position.set(-0.05, 0.5 + i * 0.1, (i % 2 ? 1 : -1) * 0.17);
    spike.rotation.x = (i % 2 ? 1 : -1) * 0.9;
    h.body.add(spike);
  }
  // Blades on the arms.
  h.armL.add(part(geo.box, 0xdddddd, null, 0.3, 0.03, 0.03, 0.12, -0.36, 0));
  h.armR.add(part(geo.box, 0xdddddd, null, 0.3, 0.03, 0.03, 0.12, -0.36, 0));
  return h;
}

export function dgenModel() {
  const h = humanoid({ torso: 0xaaffee, legs: 0x88ddcc, skin: 0xccffee, hair: 0xffffff, arms: 0xaaffee, shoes: 0x66aa99 });
  h.group.scale.setScalar(1.35);
  h.group.traverse((m) => {
    if (m.isMesh) {
      m.material = m.material.clone();
      m.material.emissive = new THREE.Color(0x30a090);
      m.material.transparent = true;
      m.material.opacity = 0.85;
    }
  });
  const aura = new THREE.Mesh(geo.sphereLo, new THREE.MeshBasicMaterial({ color: 0x60ffd0, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
  aura.scale.set(0.9, 1.6, 0.9);
  aura.position.y = 0.6;
  h.group.add(aura);
  h.aura = aura;
  return h;
}

// ---------------------------------------------------------------- props and objects

export function propModel(kind) {
  const g = new THREE.Group();
  switch (kind) {
    case 'desk':
      g.add(part(geo.box, 0x6a6a72, null, 0.8, 0.36, 0.62, 0, 0.18, 0));
      g.add(part(geo.box, 0x8a8a94, null, 0.84, 0.05, 0.66, 0, 0.38, 0));
      g.add(part(geo.box, 0x222230, null, 0.08, 0.24, 0.3, -0.12, 0.53, 0.05));
      g.add(part(geo.box, 0x30c070, { emissive: 0x106030 }, 0.01, 0.18, 0.24, -0.075, 0.54, 0.05));
      g.add(part(geo.box, 0xd0d0c0, null, 0.2, 0.02, 0.14, 0.18, 0.41, -0.15));
      break;
    case 'plant':
      g.add(part(geo.cyl, 0x8a4a2a, null, 0.36, 0.28, 0.36, 0, 0.14, 0));
      g.add(part(geo.cone, 0x2f8a3a, null, 0.5, 0.55, 0.5, 0, 0.55, 0));
      g.add(part(geo.cone, 0x3faa4a, null, 0.36, 0.42, 0.36, 0, 0.82, 0));
      break;
    case 'cabinet':
      g.add(part(geo.box, 0x50607a, null, 0.72, 0.62, 0.72, 0, 0.31, 0));
      g.add(part(geo.box, 0x70809a, null, 0.74, 0.04, 0.74, 0, 0.63, 0));
      g.add(part(geo.box, 0x303848, null, 0.01, 0.04, 0.3, 0.365, 0.45, 0));
      g.add(part(geo.box, 0x303848, null, 0.01, 0.04, 0.3, 0.365, 0.25, 0));
      break;
    case 'crate':
      g.add(part(geo.box, 0xa07038, null, 0.7, 0.55, 0.7, 0, 0.275, 0));
      g.add(part(geo.box, 0x704818, null, 0.72, 0.06, 0.72, 0, 0.5, 0));
      break;
    case 'sofa':
      g.add(part(geo.box, 0x903030, null, 0.8, 0.25, 0.7, 0, 0.125, 0));
      g.add(part(geo.box, 0x903030, null, 0.2, 0.5, 0.7, -0.3, 0.25, 0));
      break;
    case 'barrel':
      g.add(part(geo.cyl, 0xe08020, null, 0.5, 0.6, 0.5, 0, 0.3, 0));
      g.add(part(geo.cyl, 0x804010, null, 0.52, 0.05, 0.52, 0, 0.45, 0));
      break;
    case 'pillar':
      g.add(part(geo.box, 0x888890, null, 0.6, 1.3, 0.6, 0, 0.65, 0));
      break;
    case 'server':
      g.add(part(geo.box, 0x202028, null, 0.7, 0.9, 0.7, 0, 0.45, 0));
      for (let i = 0; i < 5; i++) g.add(part(geo.box, i % 2 ? 0x30ff60 : 0xff4040, { emissive: i % 2 ? 0x20a040 : 0xa02020 }, 0.01, 0.03, 0.4, 0.355, 0.2 + i * 0.13, 0));
      break;
    case 'tree': // Christmas tree, just in case it is December 25th.
      g.add(part(geo.cone, 0x1f7a2a, null, 0.7, 0.9, 0.7, 0, 0.55, 0));
      g.add(part(geo.sphereLo, 0xffee00, { emissive: 0x888800 }, 0.12, 0.12, 0.12, 0, 1.05, 0));
      break;
    default:
      g.add(part(geo.box, 0x777777, null, 0.7, 0.5, 0.7, 0, 0.25, 0));
  }
  return g;
}

export function terminalModel() {
  const g = new THREE.Group();
  g.add(part(geo.box, 0x55555e, null, 0.7, 0.38, 0.55, 0, 0.19, 0));
  g.add(part(geo.box, 0x2a2a34, null, 0.32, 0.36, 0.42, -0.05, 0.56, 0));
  const scr = part(geo.box, 0x40ff80, { emissive: 0x20c050 }, 0.01, 0.26, 0.34, 0.115, 0.58, 0);
  scr.material = scr.material.clone(); // blinks per terminal
  g.add(scr);
  g.add(part(geo.box, 0x99999f, null, 0.2, 0.03, 0.4, 0.22, 0.4, 0));
  return { group: g, screen: scr };
}

export function turretModel() {
  const g = new THREE.Group();
  g.add(part(geo.cyl, 0x2f7a3a, null, 0.5, 0.18, 0.5, 0, 0.09, 0));
  const neck = part(geo.cyl, 0x3fa04a, null, 0.16, 0.45, 0.16, 0, 0.38, 0);
  g.add(neck);
  const head = new THREE.Group();
  head.position.y = 0.62;
  head.add(part(geo.sphere, 0x3fa04a, null, 0.32, 0.26, 0.32, 0, 0, 0));
  head.add(rot(part(geo.cyl, 0x2a6a32, null, 0.1, 0.32, 0.1, 0.2, 0, 0), 'z', Math.PI / 2));
  const eye = part(geo.sphereLo, 0xff2020, { emissive: 0xff0000 }, 0.1, 0.1, 0.1, 0.15, 0.08, 0);
  eye.material = eye.material.clone(); // recoloured per turret
  head.add(eye);
  g.add(head);
  return { group: g, head, eye, neck };
}

export function tubeModel() {
  const g = new THREE.Group();
  g.add(part(geo.cyl, 0x808088, null, 0.92, 0.08, 0.92, 0, 0.04, 0));
  const glass = new THREE.Mesh(geo.cyl, new THREE.MeshLambertMaterial({ color: 0x80ff60, emissive: 0x206010, transparent: true, opacity: 0.35, depthWrite: false }));
  glass.scale.set(0.8, 1.9, 0.8);
  glass.position.y = 0.95;
  g.add(glass);
  const rings = [];
  for (let i = 0; i < 4; i++) {
    const r = part(geo.cyl, i % 2 ? 0xe0c020 : 0x40d040, { emissive: i % 2 ? 0x605000 : 0x105010 }, 0.86, 0.1, 0.86, 0, 0.3 + i * 0.45, 0);
    g.add(r);
    rings.push(r);
  }
  g.add(part(geo.cyl, 0x808088, null, 0.92, 0.1, 0.92, 0, 1.92, 0));
  return { group: g, rings, glass };
}

export function ventModel() {
  const g = new THREE.Group();
  g.add(part(geo.box, 0x1a1a1a, null, 0.72, 0.03, 0.72, 0, 0.015, 0));
  const rim = new THREE.Mesh(geo.box, new THREE.MeshLambertMaterial({ color: 0xd02020, emissive: 0x801010 }));
  rim.scale.set(0.8, 0.02, 0.8);
  rim.position.y = 0.01;
  g.add(rim);
  for (let i = 0; i < 4; i++) g.add(part(geo.box, 0x555555, null, 0.62, 0.04, 0.05, 0, 0.04, -0.24 + i * 0.16));
  return { group: g, rim };
}

export function plateModel() {
  const g = new THREE.Group();
  g.add(part(geo.box, 0x50505a, null, 0.9, 0.03, 0.9, 0, 0.015, 0));
  const glow = new THREE.Mesh(geo.box, new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.scale.set(0.9, 0.06, 0.9);
  glow.position.y = 0.04;
  g.add(glow);
  for (let i = 0; i < 3; i++) g.add(part(geo.box, 0x7a7a88, null, 0.84, 0.035, 0.04, 0, 0.02, -0.3 + i * 0.3));
  return { group: g, glow };
}

export function mineModel() {
  const g = new THREE.Group();
  g.add(part(geo.box, 0x0a0a0a, null, 0.7, 0.05, 0.7, 0, 0.025, 0));
  const light = part(geo.sphereLo, 0xff2020, { basic: true }, 0.09, 0.09, 0.09, 0.3, 0.07, 0.3);
  g.add(light);
  return { group: g, light };
}

export function teleModel() {
  const g = new THREE.Group();
  g.add(part(geo.cyl, 0x303050, null, 0.9, 0.05, 0.9, 0, 0.025, 0));
  const disc = new THREE.Mesh(geo.cyl, new THREE.MeshBasicMaterial({ color: 0x40e0ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  disc.scale.set(0.7, 0.02, 0.7);
  disc.position.y = 0.06;
  g.add(disc);
  const ring = new THREE.Mesh(geo.torus, new THREE.MeshBasicMaterial({ color: 0x80ffff }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.08;
  g.add(ring);
  return { group: g, disc, ring };
}

export function arrowDecal() {
  const g = new THREE.Group();
  const s = new THREE.Shape();
  s.moveTo(0, 0.38); s.lineTo(0.3, 0.02); s.lineTo(0.12, 0.02); s.lineTo(0.12, -0.36);
  s.lineTo(-0.12, -0.36); s.lineTo(-0.12, 0.02); s.lineTo(-0.3, 0.02); s.lineTo(0, 0.38);
  const m = new THREE.Mesh(new THREE.ShapeGeometry(s), new THREE.MeshBasicMaterial({ color: 0xe02020 }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.012;
  g.add(m);
  return g;
}

export function dishModel() {
  const g = new THREE.Group();
  g.add(part(geo.cyl, 0x707078, null, 0.5, 0.2, 0.5, 0, 0.1, 0));
  g.add(part(geo.cyl, 0x9090a0, null, 0.12, 0.7, 0.12, 0, 0.5, 0));
  const dishGeo = new THREE.SphereGeometry(0.7, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3.2);
  const dish = new THREE.Mesh(dishGeo, mat(0xd0d0d8, { side: THREE.DoubleSide }));
  dish.rotation.z = Math.PI / 2;
  dish.position.set(0.25, 0.95, 0);
  g.add(dish);
  g.add(rot(part(geo.cyl, 0xe0e0e0, null, 0.05, 0.6, 0.05, -0.05, 0.95, 0), 'z', Math.PI / 2));
  return { group: g };
}

export function itemModel(item) {
  const g = new THREE.Group();
  switch (item) {
    case 'laser':
      g.add(part(geo.box, 0x404048, null, 0.4, 0.1, 0.1));
      g.add(part(geo.box, 0x303038, null, 0.1, 0.16, 0.08, -0.12, -0.1, 0));
      g.add(rot(part(geo.cyl, 0x60e0ff, { emissive: 0x2080a0 }, 0.07, 0.12, 0.07, 0.22, 0, 0), 'z', Math.PI / 2));
      break;
    case 'grenade':
      g.add(part(geo.sphereLo, 0x2f6a2a, null, 0.22, 0.26, 0.22));
      g.add(part(geo.box, 0x999999, null, 0.06, 0.08, 0.06, 0, 0.15, 0));
      break;
    case 'bomb':
      g.add(part(geo.cone4, 0xff60c0, { emissive: 0x501030 }, 0.32, 0.3, 0.32));
      break;
    case 'shield':
      g.add(rot(part(geo.cylLo, 0x40a0ff, { emissive: 0x103060 }, 0.34, 0.06, 0.34), 'x', Math.PI / 2));
      break;
    case 'freezer':
      g.add(rot(part(geo.cyl, 0xeeeeee, null, 0.3, 0.07, 0.3), 'x', Math.PI / 2));
      g.add(part(geo.box, 0x222222, null, 0.02, 0.1, 0.02, 0, 0.02, 0.04));
      g.add(part(geo.box, 0xbbbbbb, null, 0.05, 0.06, 0.05, 0, 0.18, 0));
      break;
    case 'barrier':
      g.add(part(geo.sphereLo, 0xc060ff, { emissive: 0x6020a0 }, 0.26, 0.26, 0.26));
      break;
    case 'key':
      g.add(new THREE.Mesh(geo.torus, mat(0xf0f0f0)));
      g.children[0].scale.setScalar(0.3);
      g.add(part(geo.box, 0xf0f0f0, null, 0.28, 0.05, 0.05, 0.22, 0, 0));
      g.add(part(geo.box, 0xf0f0f0, null, 0.05, 0.08, 0.05, 0.3, -0.05, 0));
      break;
    case 'life':
      g.add(part(geo.sphereLo, 0xff4060, { emissive: 0x601020 }, 0.16, 0.16, 0.16, -0.06, 0.04, 0));
      g.add(part(geo.sphereLo, 0xff4060, { emissive: 0x601020 }, 0.16, 0.16, 0.16, 0.06, 0.04, 0));
      g.add(rot(part(geo.cone4, 0xff4060, { emissive: 0x601020 }, 0.26, 0.2, 0.2, 0, -0.08, 0), 'z', Math.PI));
      break;
    case 'jetpack':
      g.add(part(geo.box, 0x808090, null, 0.2, 0.36, 0.34));
      g.add(part(geo.cyl, 0xc0c0d0, null, 0.14, 0.42, 0.14, 0, 0, -0.12));
      g.add(part(geo.cyl, 0xc0c0d0, null, 0.14, 0.42, 0.14, 0, 0, 0.12));
      g.add(rot(part(geo.cone, 0xff8020, { emissive: 0xff4000 }, 0.12, 0.2, 0.12, 0, -0.3, -0.12), 'z', Math.PI));
      g.add(rot(part(geo.cone, 0xff8020, { emissive: 0xff4000 }, 0.12, 0.2, 0.12, 0, -0.3, 0.12), 'z', Math.PI));
      break;
    default:
      g.add(part(geo.box, 0xffffff, null, 0.2, 0.2, 0.2));
  }
  return g;
}
