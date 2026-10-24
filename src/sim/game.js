// The game simulation. Pure logic: no rendering, no DOM, no audio.
// The renderer, HUD and audio read `game` state and consume `game.events`.

import {
  parseRoom, boxesAt, isSolidPoint, lineOfSight, flowField, flowStep, tileAt,
  FLOOR, VOID, DOOR,
} from './room.js';
import {
  DIR_NAMES, dirIndex, unitDir, dist, angleDiff, mulberry32, deepCopy, pushOut,
} from './util.js';

// Object fields that survive leaving and re-entering a room.
const PERSIST = ['open', 'broken', 'on', 'found', 'sealed', 'taken', 'destroyed', 'enabled',
  'exploded', 'rescued', 'dead', 'talked', 'unlocked', 'used', 'gave'];

const SPEED = {
  player: 3.3, agenWander: 1.2, agenHunt: 2.25, bgen: 3.8, bgenUnder: 2.8,
  cgen: 2.9, dgen: 1.75, survivor: 2.0, laser: 13, tshot: 5.2, grenade: 7.5, plasma: 2.6,
};

const DEATH_MSG = {
  agen: 'Smothered by an A/Generation.',
  bgen: 'Crushed by a B/Generation.',
  cgen: 'Decapitated by a C/Generation.',
  dgen: 'The D/Generation caught you.',
  turret: 'Shot by a tracker.',
  plate: 'Electrocuted.',
  explosion: 'Caught in the blast.',
  plasma: 'Disintegrated by a plasma barrier.',
  dish: 'Cooked by the microwave beam.',
  eye: 'The trip-laser fired.',
  abort: 'Scene aborted.',
};

export const ITEM_ORDER = ['bomb', 'shield', 'freezer', 'barrier'];
export const ITEM_NAMES = { bomb: 'Bomb', shield: 'Shield', freezer: 'Freezer', barrier: 'Barrier' };

export class Game {
  constructor(data, opts = {}) {
    this.data = data;
    this.events = [];
    this.rng = mulberry32(opts.seed ?? ((Math.random() * 1e9) | 0));
    this.nextId = 1;
    this.mode = 'idle';
    this.room = null;
    this.ents = [];
    this.flags = {};
    this.bomber = null;
    this.freezeT = 0;
  }

  emit(type, data = {}) { this.events.push({ type, ...data }); }
  msg(text, time = 2.6) { this.emit('msg', { text, time }); }
  rand() { return this.rng(); }

  // ---------------------------------------------------------------- session

  newGame() {
    this.p = {
      lives: 5, grenades: 0, hasLaser: false, keyLevel: 0, rescued: 0, package: true,
      items: { bomb: 0, shield: 0, freezer: 0, barrier: 0 }, sel: null, shieldT: 0,
    };
    this.bomber = null;
    this.flags = {};
    this.startFloor(this.data.firstFloor ?? 80);
  }

  saveData() {
    return deepCopy({ floor: this.floorNum, p: this.floorSnap.p, bomber: this.floorSnap.bomber, flags: this.floorSnap.flags });
  }

  loadSave(s) {
    this.p = deepCopy(s.p);
    this.bomber = s.bomber ?? null;
    this.flags = deepCopy(s.flags || {});
    this.startFloor(s.floor);
  }

  startFloor(n) {
    const fd = this.data.floors[n];
    if (!fd) throw new Error(`no floor ${n}`);
    this.floorNum = n;
    this.floor = fd;
    this.roomStates = {};
    this.parseCache = {};
    this.room = null;
    this.p.keyLevel = 0;
    this.p.shieldT = 0;
    this.freezeT = 0;
    if (fd.confiscate) {
      this.p.grenades = 0;
      for (const k of ITEM_ORDER) this.p.items[k] = 0;
      this.p.sel = null;
    }
    this.floorSnap = deepCopy({ p: this.p, bomber: this.bomber, flags: this.flags });
    this.enterRoom(fd.start, null);
    this.mode = 'intro';
    this.emit('floor', { n, name: fd.name, intro: fd.intro, confiscate: !!fd.confiscate });
    this.emit('save', { data: this.saveData() });
  }

  restartFloor() {
    this.p = deepCopy(this.floorSnap.p);
    this.bomber = this.floorSnap.bomber;
    this.flags = deepCopy(this.floorSnap.flags);
    this.startFloor(this.floorNum);
  }

  // ---------------------------------------------------------------- rooms

  parsed(id) {
    if (!this.parseCache[id]) this.parseCache[id] = parseRoom(this.floor.rooms[id], id);
    return this.parseCache[id];
  }

  stateOf(id) {
    return this.roomStates[id] || (this.roomStates[id] = { secured: false, objs: {} });
  }

  storeRoom() {
    const r = this.room;
    if (!r) return;
    const st = this.stateOf(r.id);
    st.secured = r.secured;
    for (const o of r.objs) {
      const s = {};
      for (const k of PERSIST) if (k in o) s[k] = o[k];
      st.objs[o.id] = s;
    }
  }

  enterRoom(id, at) {
    this.storeRoom();
    const def = this.floor.rooms[id];
    if (!def) throw new Error(`floor ${this.floorNum}: no room '${id}'`);
    const room = parseRoom(def, id);
    const st = this.stateOf(id);
    for (const o of room.objs) if (st.objs[o.id]) Object.assign(o, st.objs[o.id]);
    room.secured = st.secured;
    room.t = 0;
    this.room = room;
    this.ents = [];
    this.freezeT = 0;
    this.entry = { id, at, states: deepCopy(this.roomStates), p: deepCopy(this.p) };

    // Place the player.
    let px, pz, facing = def.facing ?? 2;
    if (at != null) {
      const ex = room.exits.find((e) => e.n === String(at));
      if (!ex) throw new Error(`room ${id} has no exit ${at}`);
      px = ex.x + 0.5; pz = ex.z + 0.5;
      facing = this.inwardFacing(room, ex);
    } else if (room.start) {
      px = room.start.x + 0.5; pz = room.start.z + 0.5;
    } else {
      throw new Error(`room ${id}: no entry point`);
    }
    this.player = this.spawn('player', px, pz, {
      r: 0.27, facing, ang: Math.atan2(unitDir(facing)[1], unitDir(facing)[0]),
      exitArmed: at == null, fireCd: 0, grenCd: 0, walkT: 0, touching: new Set(),
    });

    // Bring objects to life.
    let threat = false;
    let ventIdx = 0;
    for (const o of room.objs) {
      switch (o.t) {
        case 'survivor':
          if (!o.rescued && !o.dead) this.spawn('survivor', o.x + 0.5, o.z + 0.5, { obj: o, r: 0.26, state: 'trapped', ang: Math.PI / 2 + 0.6, shakeT: 0 });
          break;
        case 'npc':
          if (!o.dead) this.spawn('npc', o.x + 0.5, o.z + 0.5, { obj: o, r: 0.26, ang: o.ang ?? Math.PI * 0.75 });
          break;
        case 'agen': case 'bgen': case 'cgen': case 'dgen':
          if (!o.dead) { this.spawnCreature(o.t[0].toUpperCase(), o.x + 0.5, o.z + 0.5, { obj: o, look: o.look }); threat = true; }
          break;
        case 'plasma': {
          const [dx, dz] = DIR_NAMES[o.dir || 'ne'];
          const l = Math.hypot(dx, dz);
          this.spawn('plasma', o.x + 0.5, o.z + 0.5, { r: 0.3, dx: dx / l, dz: dz / l, speed: o.speed ?? SPEED.plasma, life: Infinity });
          break;
        }
        case 'vent':
          threat = true;
          o.ent = null;
          o.timer = 0.9 + ventIdx++ * 0.5;
          break;
        case 'turret':
          o.cd = 1.0 + this.rand();
          o.angle = o.angle ?? 0;
          break;
      }
    }
    room.threat = threat;
    if (!room.secured && !threat) room.secured = true;
    if (room.secured) for (const o of room.objs) if (o.t === 'door' && o.sec) o.open = true;

    this.plField = null;
    this.plFieldT = 0;
    this.arrowField = null;
    this.arrowFieldT = 0;
    this.emit('room', { id, scene: def.scene, name: def.name });
    if (def.onEnter && !this.flags[`enter:${this.floorNum}:${id}`]) {
      this.flags[`enter:${this.floorNum}:${id}`] = true;
      this.runActions(def.onEnter);
    }
  }

  inwardFacing(room, ex) {
    for (const [name, [dx, dz]] of Object.entries(DIR_NAMES)) {
      if (name.length > 1) continue;
      const nx = ex.x + dx, nz = ex.z + dz;
      if (tileAt(room, nx, nz) === FLOOR && !room.exitAt.has(nz * room.W + nx)) return dirIndex(dx, dz);
      if (tileAt(room, nx, nz) === DOOR) return dirIndex(dx, dz);
    }
    return 2;
  }

  spawn(kind, x, z, props = {}) {
    const e = { id: this.nextId++, kind, x, z, y: 0, r: 0.3, dead: false, remove: false, t: 0, ...props };
    this.ents.push(e);
    return e;
  }

  spawnCreature(gen, x, z, extra = {}) {
    const a = this.rand() * Math.PI * 2;
    const base = { hostile: true, dx: Math.cos(a), dz: Math.sin(a), ang: a, walkT: 0, ...extra };
    if (gen === 'A') return this.spawn('agen', x, z, { r: 0.3, state: extra.vent ? 'emerge' : 'wander', stateT: 0.6, turnT: 0, ...base });
    if (gen === 'B') {
      const d = [[1, 1], [1, -1], [-1, 1], [-1, -1]][(this.rand() * 4) | 0];
      return this.spawn('bgen', x, z, { r: 0.27, state: extra.vent ? 'emerge' : 'bounce', stateT: 0.5, diveT: 2.5 + this.rand() * 2.5, ...base, dx: d[0] / Math.SQRT2, dz: d[1] / Math.SQRT2 });
    }
    if (gen === 'C') {
      const disguised = !extra.vent;
      return this.spawn('cgen', x, z, { r: 0.28, state: disguised ? 'disguised' : 'chase', stateT: 0, ang: Math.PI / 2 + 0.6, shakeT: 0, ...base, ang0: 0 });
    }
    if (gen === 'D') return this.spawn('dgen', x, z, { r: 0.34, state: 'idle', stateT: 1.2, ...base });
    throw new Error(`bad creature ${gen}`);
  }

  // ---------------------------------------------------------------- update

  update(dt, inp) {
    if (this.mode !== 'play') return;
    const room = this.room;
    room.t += dt;
    const frozen = this.freezeT > 0;
    if (frozen) {
      this.freezeT -= dt;
      if (this.freezeT <= 0) this.emit('unfreeze');
    }
    if (this.p.shieldT > 0) {
      this.p.shieldT -= dt;
      if (this.p.shieldT <= 0) { this.p.shieldT = 0; this.msg('Shield expired.'); }
    }
    if (this.bomber != null) this.tickBomber(dt);
    if (this.mode !== 'play') return;

    this.updatePlayer(dt, inp);
    if (this.mode !== 'play' || this.room !== room) return;

    this.plFieldT -= dt;
    if (this.plFieldT <= 0 || !this.plField) {
      this.plField = flowField(room, [[Math.floor(this.player.x), Math.floor(this.player.z)]]);
      this.plFieldT = 0.25;
    }

    for (const e of this.ents.slice()) {
      if (e.kind === 'player' || e.remove) continue;
      if (frozen && !e.unfrozen) continue;
      e.t += dt;
      this.updateEnt(e, dt);
      if (this.mode !== 'play' || this.room !== room) return;
    }
    if (!frozen) this.updateObjects(dt);
    this.updateVents(dt, frozen);
    this.updateSecurity();
    this.ents = this.ents.filter((e) => !e.remove);
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.enterRoom(p.room, p.at);
    }
  }

  tickBomber(dt) {
    this.bomber -= dt;
    const m = Math.ceil(this.bomber / 60);
    if (m !== this.bomberMin) {
      this.bomberMin = m;
      if (m > 0) this.msg(`Bomber will attack in ${m} minute${m > 1 ? 's' : ''}`, 4);
    }
    if (this.bomber <= 0) {
      this.bomber = 0;
      this.ending('bomber');
    }
  }

  // Move an entity with collision. Returns a Map of touched tile index -> how squarely
  // the entity ran into it (1 = head-on, 0 = sliding along it).
  move(e, dx, dz, mode) {
    const room = this.room;
    const touched = new Map();
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / 0.08));
    for (let i = 0; i < steps; i++) {
      e.x += dx / steps;
      e.z += dz / steps;
      for (let iter = 0; iter < 2; iter++) {
        const tx = Math.floor(e.x), tz = Math.floor(e.z);
        for (let oz = -1; oz <= 1; oz++) {
          for (let ox = -1; ox <= 1; ox++) {
            const bs = boxesAt(room, tx + ox, tz + oz, mode);
            if (!bs) continue;
            for (const b of bs) {
              const bx = e.x, bz = e.z;
              if (!pushOut(e, b)) continue;
              const nx = e.x - bx, nz = e.z - bz;
              const nl = Math.hypot(nx, nz);
              const head = nl > 1e-9 && len > 1e-9 ? Math.max(0, -(nx * dx + nz * dz) / (nl * len)) : 0;
              const idx = (tz + oz) * room.W + tx + ox;
              touched.set(idx, Math.max(touched.get(idx) ?? 0, head));
            }
          }
        }
      }
    }
    return touched;
  }

  updatePlayer(dt, inp) {
    const pl = this.player;
    const p = this.p;
    pl.t += dt;
    if (pl.dead) {
      pl.deadT += dt;
      if (pl.deadT > 1.7) this.afterDeath();
      return;
    }
    pl.fireCd -= dt;
    pl.grenCd -= dt;
    pl.moving = false;
    const [mx0, mz0] = inp.move || [0, 0];
    const l = Math.hypot(mx0, mz0);
    if (l > 0.15 && !pl.held) {
      const mx = mx0 / l, mz = mz0 / l;
      pl.facing = dirIndex(mx, mz);
      const [fx, fz] = unitDir(pl.facing);
      pl.ang = Math.atan2(fz, fx);
      const ox = pl.x, oz = pl.z;
      const touched = this.move(pl, mx * SPEED.player * dt, mz * SPEED.player * dt, 'move');
      pl.moving = Math.hypot(pl.x - ox, pl.z - oz) > 0.002;
      if (pl.moving) pl.walkT += dt;
      for (const [idx, head] of touched) {
        if (pl.touching.has(idx)) continue;
        const o = this.room.objAt.get(idx);
        // Switches need a deliberate push; hidden ones give themselves away to anyone brushing past.
        if (head > 0.55 || (o && o.secret && !o.found)) this.bump(idx, pl);
      }
      pl.touching = new Set(touched.keys());
    } else {
      pl.touching = new Set();
    }
    if (pl.held) return;

    if (inp.fire && p.hasLaser && pl.fireCd <= 0 && this.ents.filter((e) => e.kind === 'laser').length < 2) {
      const [fx, fz] = unitDir(pl.facing);
      this.spawn('laser', pl.x + fx * 0.25, pl.z + fz * 0.25, { r: 0.05, dx: fx, dz: fz, bounces: 0, life: 2.6, y: 0.5, unfrozen: false });
      pl.fireCd = 0.28;
      this.emit('laser');
    } else if (inp.fire && !p.hasLaser && inp.firePressed) {
      this.msg('You have no weapon.');
    }
    if (inp.grenade && pl.grenCd <= 0) {
      if (p.grenades > 0) {
        const [fx, fz] = unitDir(pl.facing);
        this.spawn('grenade', pl.x + fx * 0.3, pl.z + fz * 0.3, { r: 0.1, dx: fx, dz: fz, range: 9, y: 0.45 });
        p.grenades--;
        pl.grenCd = 0.6;
        this.emit('throw');
      } else {
        this.msg('No grenades.');
        pl.grenCd = 0.6;
      }
    }
    if (inp.use) this.useItem();
    if (inp.cycle) this.cycleItem();
    if (inp.talk) this.interact();
    if (this.mode !== 'play') return;
    this.checkPlayerTile();
  }

  checkPlayerTile() {
    const pl = this.player;
    const room = this.room;
    const tx = Math.floor(pl.x), tz = Math.floor(pl.z);
    const ex = room.exitAt.get(tz * room.W + tx);
    if (ex) {
      if (pl.exitArmed) { this.pending = { room: ex.room, at: ex.at }; return; }
    } else {
      pl.exitArmed = true;
    }
    for (const o of room.objs) {
      const d = Math.hypot(pl.x - o.x - 0.5, pl.z - o.z - 0.5);
      if (o.t === 'item' && !o.taken && d < 0.55) this.pickup(o);
      else if (o.t === 'tube' && d < 0.45) { this.floorDone(o); return; }
      else if (o.t === 'vent' && !o.sealed && d < 0.45) {
        o.sealed = true;
        this.emit('seal', { o });
      }
    }
    this.teleCheck(pl);
  }

  bump(idx, who) {
    const o = this.room.objAt.get(idx);
    if (!o) return;
    if (o.t === 'switch') this.activateSwitch(o, who);
    else if (o.t === 'keyhole' && who.kind === 'player') {
      if (this.p.keyLevel >= (o.level ?? 1)) {
        o.on = !o.on;
        this.emit('switch', { o });
        this.toggleTargets(o.targets, o.remote);
      } else {
        this.msg(`Security Key Level ${o.level ?? 1} required.`);
        this.emit('deny');
      }
    }
  }

  activateSwitch(o, src) {
    if (o.secret && !o.found) {
      o.found = true;
      if (src.kind === 'player') this.msg('A hidden switch!');
    }
    o.on = !o.on;
    this.emit('switch', { o });
    this.toggleTargets(o.targets, o.remote);
  }

  toggleTargets(targets, remote) {
    for (const ch of targets || '') {
      for (const t of this.room.byChar.get(ch) || []) this.toggleObj(t);
    }
    if (remote) for (const [rid, chars] of Object.entries(remote)) this.toggleRemote(rid, chars);
  }

  toggleObj(o) {
    switch (o.t) {
      case 'door':
        if (o.broken) return;
        o.open = !o.open;
        this.emit('door', { o });
        break;
      case 'turret': if (!o.destroyed) { o.on = !o.on; this.emit('turretToggle', { o }); } break;
      case 'plate': o.enabled = !o.enabled; break;
      case 'tele': o.on = !o.on; break;
      case 'eye': o.on = !o.on; break;
      case 'switch': o.on = !o.on; break;
      case 'dish': this.fireDish(o); break;
    }
  }

  toggleRemote(rid, chars) {
    if (rid === this.room.id) { this.toggleTargets(chars); return; }
    const r = this.parsed(rid);
    const st = this.stateOf(rid);
    for (const o of r.objs) {
      if (!chars.includes(o.ch)) continue;
      const s = st.objs[o.id] || (st.objs[o.id] = {});
      if (o.t === 'door') { if (!(s.broken)) s.open = !(s.open ?? o.open); }
      else if (o.t === 'turret') s.on = !(s.on ?? o.on);
      else if (o.t === 'plate') s.enabled = !(s.enabled ?? o.enabled);
      else if (o.t === 'tele' || o.t === 'eye') s.on = !(s.on ?? o.on);
    }
    this.emit('remote');
  }

  pickup(o) {
    o.taken = true;
    this.giveItem(o.item, o.n ?? 1, o.level);
  }

  giveItem(item, n = 1, level) {
    const p = this.p;
    switch (item) {
      case 'laser': p.hasLaser = true; this.msg('Laser pulse gun! (Space to fire)', 3.5); break;
      case 'grenade': p.grenades += n; this.msg(`${n} Grenade${n > 1 ? 's' : ''}!`); break;
      case 'key': p.keyLevel = Math.max(p.keyLevel, level ?? n); this.msg(`Security Key Level ${level ?? n}!`); break;
      case 'life': p.lives += n; this.msg(`${n} Life!`); break;
      case 'jetpack': this.emit('pickup', { item }); this.ending(this.flags.dgenDead ? 'win' : 'escape'); return;
      default:
        if (!(item in p.items)) throw new Error(`unknown item ${item}`);
        p.items[item] += n;
        if (!p.sel || !p.items[p.sel]) p.sel = item;
        this.msg(`${n} ${ITEM_NAMES[item]}!`);
    }
    this.emit('pickup', { item });
  }

  useItem() {
    const p = this.p;
    const k = p.sel;
    if (!k || !p.items[k]) { this.msg('Empty!'); return; }
    const pl = this.player;
    const [fx, fz] = unitDir(pl.facing);
    switch (k) {
      case 'bomb':
        this.spawn('bomb', pl.x + fx * 0.2, pl.z + fz * 0.2, { r: 0.18, fuse: 2.6 });
        this.emit('bombSet');
        break;
      case 'shield':
        p.shieldT = 30;
        this.emit('shield');
        this.msg('Personal shield active.');
        break;
      case 'freezer':
        this.freezeT = 8;
        this.emit('freeze');
        this.msg('Time frozen!');
        break;
      case 'barrier': {
        let d = pl.facing;
        if (d % 2 === 0) d = (d + 1) % 8; // barriers travel diagonally so they rebound around the room
        const [dx, dz] = unitDir(d);
        this.spawn('plasma', pl.x + dx * 0.7, pl.z + dz * 0.7, { r: 0.3, dx, dz, speed: SPEED.plasma, life: 7, owned: true });
        this.emit('barrier');
        break;
      }
    }
    p.items[k]--;
    if (!p.items[k]) {
      p.sel = ITEM_ORDER.find((i) => p.items[i] > 0) || null;
    }
  }

  cycleItem() {
    const p = this.p;
    const have = ITEM_ORDER.filter((i) => p.items[i] > 0);
    if (!have.length) { p.sel = null; this.msg('Empty!'); return; }
    const i = have.indexOf(p.sel);
    p.sel = have[(i + 1) % have.length];
    this.emit('select');
  }

  interact() {
    const pl = this.player;
    let best = null, bd = 1.55;
    for (const e of this.ents) {
      if (e.dead) continue;
      if (e.kind === 'survivor' || e.kind === 'npc' || (e.kind === 'cgen' && e.state === 'disguised')) {
        const d = dist(e, pl);
        if (d < bd) { bd = d; best = { ent: e }; }
      }
    }
    for (const o of this.room.objs) {
      if (o.t !== 'terminal') continue;
      const d = Math.hypot(pl.x - o.x - 0.5, pl.z - o.z - 0.5);
      if (d < bd) { bd = d; best = { obj: o }; }
    }
    if (!best) return;
    if (best.ent) {
      const e = best.ent;
      if (e.kind === 'cgen') { this.revealCgen(e); return; }
      e.ang = Math.atan2(pl.z - e.z, pl.x - e.x);
      const dlg = this.data.dialogs[e.obj.dialog] || { name: e.obj.name || 'Survivor', greet: e.obj.greet || 'Hi.', topics: [] };
      this.mode = 'dialog';
      this.emit('dialog', { ent: e, obj: e.obj, dialog: dlg });
    } else {
      this.mode = 'terminal';
      this.emit('terminal', { obj: best.obj, text: this.data.terminals[best.obj.text] });
    }
  }

  // Called by the UI when a dialog closes. `actions` come from the dialog script.
  endDialog(obj, actions) {
    if (obj) obj.talked = true;
    if (actions && obj && !obj.used) {
      obj.used = true;
      this.runActions(actions);
    }
    if (this.mode === 'dialog') this.mode = 'play';
  }

  terminalLogin(obj, user, pass) {
    const ok = (!obj.user || user.trim().toLowerCase() === obj.user.toLowerCase())
      && (!obj.pass || pass.trim().toLowerCase() === obj.pass.toLowerCase());
    if (ok && !obj.unlocked) {
      obj.unlocked = true;
      this.toggleTargets(obj.targets, obj.remote);
      if (obj.onUnlock) this.runActions(obj.onUnlock);
      this.emit('granted');
    } else if (!ok) {
      this.emit('deny');
    }
    return ok;
  }

  endTerminal(obj) {
    if (obj && !obj.pass && !obj.used) {
      obj.used = true;
      if (obj.targets || obj.remote) this.toggleTargets(obj.targets, obj.remote);
      if (obj.onRead) this.runActions(obj.onRead);
    }
    if (this.mode === 'terminal') this.mode = 'play';
  }

  runActions(acts) {
    for (const a of [].concat(acts || [])) {
      if (a.give) this.giveItem(a.give, a.n ?? 1, a.level);
      if (a.targets || a.remote) this.toggleTargets(a.targets, a.remote);
      if (a.flag) this.flags[a.flag] = true;
      if (a.msg) this.msg(a.msg, a.time ?? 3);
      if (a.timer && this.bomber == null) { this.bomber = a.timer; this.bomberMin = null; }
      if (a.takePackage) this.p.package = false;
      if (a.goto) { const [room, at] = a.goto.split(':'); this.pending = { room, at: at ?? null }; }
      if (a.ending) this.ending(a.ending);
      if (a.text) this.emit('story', { text: a.text });
    }
  }

  floorDone(o) {
    this.storeRoom();
    this.mode = 'transition';
    const next = o.floor ?? this.floorNum + 1;
    this.emit('floorDone', { floor: this.floorNum, next });
  }

  ending(kind) {
    this.mode = 'ending';
    this.emit('ending', { kind });
  }

  // ---------------------------------------------------------------- death

  killPlayer(cause) {
    const pl = this.player;
    if (pl.dead || this.mode !== 'play') return false;
    if (this.god && cause !== 'abort') return false; // test harness only
    if (cause !== 'abort' && this.p.shieldT > 0) {
      if (cause === 'turret') {
        this.p.shieldT = 0;
        this.msg('Shield destroyed!');
        this.emit('shieldLost');
      }
      return false;
    }
    pl.dead = true;
    pl.deadT = 0;
    pl.cause = cause;
    if (pl.held) pl.held = null;
    this.emit('playerDeath', { cause, x: pl.x, z: pl.z });
    if (DEATH_MSG[cause]) this.msg(DEATH_MSG[cause], 2.5);
    return true;
  }

  abortRoom() {
    if (this.mode === 'play') this.killPlayer('abort');
  }

  afterDeath() {
    const lives = this.entry.p.lives - 1;
    if (lives <= 0) {
      this.p.lives = 0;
      this.mode = 'gameover';
      this.emit('gameover');
      return;
    }
    this.roomStates = deepCopy(this.entry.states);
    this.p = deepCopy(this.entry.p);
    this.p.lives = lives;
    this.room = null;
    this.enterRoom(this.entry.id, this.entry.at);
    this.emit('respawn');
  }

  kill(t, cause) {
    if (t.dead) return;
    if (t.kind === 'player') { this.killPlayer(cause); return; }
    if (t.kind === 'dgen' && cause !== 'dish') return;
    if (t.kind === 'npc') return;
    t.dead = true;
    t.remove = true;
    if (t.obj) t.obj.dead = true;
    if (t.vent) t.vent.timer = 1.8;
    if (t.kind === 'agen' && this.player.held === t) this.player.held = null;
    this.emit('death', { kind: t.kind, x: t.x, z: t.z, cause, look: t.look });
    if (t.kind === 'survivor') this.msg('A survivor was killed!');
    if (t.kind === 'dgen') {
      this.flags.dgenDead = true;
      this.msg('D/Generation destroyed!', 4);
      if (this.room.def.onDgenDead) this.runActions(this.room.def.onDgenDead);
    }
  }

  explode(x, z, r, opts = {}) {
    this.emit('explode', { x, z, r, bomb: !!opts.bomb });
    for (const t of this.ents) {
      if (t.dead || t.remove) continue;
      if (t.kind === 'laser' || t.kind === 'tshot' || t.kind === 'plasma' || t.kind === 'grenade' || t.kind === 'bomb') continue;
      if (t.kind === 'bgen' && (t.state === 'under' || t.state === 'dive')) continue;
      if (Math.hypot(t.x - x, t.z - z) < r + t.r * 0.5) this.kill(t, 'explosion');
    }
    for (const o of this.room.objs) {
      const d = Math.hypot(o.x + 0.5 - x, o.z + 0.5 - z);
      if (o.t === 'turret' && !o.destroyed && d < r + 0.35) { o.destroyed = true; this.emit('turretDestroyed', { o }); }
      if (o.t === 'eye' && !o.destroyed && d < r + 0.3) { o.destroyed = true; this.msg('Electric Eye Destroyed.'); }
      if (o.t === 'mine' && !o.exploded && d < r + 0.3) { o.exploded = true; this.explode(o.x + 0.5, o.z + 0.5, 0.9); }
      if (o.t === 'door' && opts.bomb && !o.broken && d < r + 0.25) {
        o.broken = true;
        o.open = true;
        this.emit('door', { o, blown: true });
      }
    }
    for (const e of this.ents) if (e.kind === 'survivor' && !e.dead) e.shakeT = 1.2;
  }

  // ---------------------------------------------------------------- entities

  updateEnt(e, dt) {
    switch (e.kind) {
      case 'laser': this.updateLaser(e, dt); break;
      case 'tshot': this.updateShot(e, dt); break;
      case 'grenade': this.updateGrenade(e, dt); break;
      case 'bomb':
        e.fuse -= dt;
        if (e.fuse <= 0) { e.remove = true; e.dead = true; this.explode(e.x, e.z, 1.6, { bomb: true }); }
        break;
      case 'plasma': this.updatePlasma(e, dt); break;
      case 'agen': this.updateAgen(e, dt); break;
      case 'bgen': this.updateBgen(e, dt); break;
      case 'cgen': this.updateCgen(e, dt); break;
      case 'dgen': this.updateDgen(e, dt); break;
      case 'survivor': this.updateSurvivor(e, dt); break;
    }
  }

  // Step a projectile; returns { box, obj, tile } on a solid hit, or null.
  projectileTile(e, nx, nz, mode) {
    const room = this.room;
    const tx = Math.floor(nx), tz = Math.floor(nz);
    if (tileAt(room, tx, tz) === VOID) return { void: true };
    const b = isSolidPoint(room, nx, nz, mode);
    if (!b) return null;
    return { box: b, obj: room.objAt.get(tz * room.W + tx) };
  }

  projectileTele(e, nx, nz) {
    const room = this.room;
    const tx = Math.floor(nx), tz = Math.floor(nz);
    if (e.teleLock && (e.teleLock.x !== tx || e.teleLock.z !== tz)) e.teleLock = null;
    const o = room.objAt.get(tz * room.W + tx);
    if (o && o.t === 'tele' && o.on && e.teleLock !== o) {
      const dst = this.telePartner(o);
      if (dst) {
        e.x = dst.x + 0.5;
        e.z = dst.z + 0.5;
        e.teleLock = dst;
        this.emit('tele', { x: e.x, z: e.z, small: true });
        return true;
      }
    }
    return false;
  }

  reflect(e, b) {
    let fx = e.x <= b[0] || e.x >= b[2];
    let fz = e.z <= b[1] || e.z >= b[3];
    if (!fx && !fz) fx = fz = true;
    if (fx) e.dx = -e.dx;
    if (fz) e.dz = -e.dz;
  }

  updateLaser(e, dt) {
    e.life -= dt;
    if (e.life <= 0) { e.remove = true; return; }
    const total = SPEED.laser * dt;
    const n = Math.ceil(total / 0.05);
    const s = total / n;
    for (let i = 0; i < n; i++) {
      const nx = e.x + e.dx * s, nz = e.z + e.dz * s;
      if (this.projectileTele(e, nx, nz)) continue;
      const hit = this.projectileTile(e, nx, nz, 'laser');
      if (hit) {
        if (hit.void) { e.remove = true; this.emit('fizzle', { x: e.x, z: e.z }); return; }
        const o = hit.obj;
        if (o && o.t === 'switch') { this.activateSwitch(o, e); e.remove = true; this.emit('spark', { x: e.x, z: e.z }); return; }
        if (o && o.t === 'eye' && !o.destroyed) {
          o.destroyed = true;
          this.msg('Electric Eye Destroyed.');
          this.emit('spark', { x: e.x, z: e.z, big: true });
          e.remove = true;
          return;
        }
        if (o && (o.t === 'turret' || o.t === 'dish')) { e.remove = true; this.emit('spark', { x: e.x, z: e.z }); return; }
        this.reflect(e, hit.box);
        e.bounces++;
        this.emit('bounce', { x: e.x, z: e.z });
        if (e.bounces > 4) { e.remove = true; return; }
        continue;
      }
      e.x = nx; e.z = nz;
      for (const t of this.ents) {
        if (t === e || t.dead || t.remove) continue;
        let hittable = false;
        if (t.kind === 'agen' || t.kind === 'survivor') hittable = true;
        else if (t.kind === 'bgen') hittable = t.state === 'bounce' || t.state === 'emerge';
        if (!hittable) continue;
        if (Math.hypot(t.x - e.x, t.z - e.z) < t.r + 0.08) {
          this.kill(t, 'laser');
          e.remove = true;
          return;
        }
      }
    }
  }

  updateShot(e, dt) {
    e.life -= dt;
    if (e.life <= 0) { e.remove = true; return; }
    const total = SPEED.tshot * dt;
    const n = Math.ceil(total / 0.06);
    const s = total / n;
    for (let i = 0; i < n; i++) {
      const nx = e.x + e.dx * s, nz = e.z + e.dz * s;
      if (this.projectileTele(e, nx, nz)) continue;
      const hit = this.projectileTile(e, nx, nz, 'laser');
      if (hit) {
        e.remove = true;
        const o = hit.obj;
        if (o && o.t === 'turret' && !o.destroyed && (o !== e.src || e.t > 0.4)) {
          o.destroyed = true;
          this.emit('turretDestroyed', { o });
          this.emit('explode', { x: o.x + 0.5, z: o.z + 0.5, r: 0.6 });
        } else {
          this.emit('fizzle', { x: e.x, z: e.z });
        }
        return;
      }
      e.x = nx; e.z = nz;
      for (const t of this.ents) {
        if (t === e || t.dead || t.remove) continue;
        if (!['player', 'survivor', 'agen', 'bgen', 'cgen'].includes(t.kind)) continue;
        if (t.kind === 'bgen' && t.state !== 'bounce') continue;
        if (Math.hypot(t.x - e.x, t.z - e.z) < t.r + 0.1) {
          e.remove = true;
          if (t.kind === 'player') this.killPlayer('turret');
          else this.kill(t, 'turret');
          return;
        }
      }
    }
  }

  updateGrenade(e, dt) {
    const total = SPEED.grenade * dt;
    const n = Math.ceil(total / 0.06);
    const s = total / n;
    for (let i = 0; i < n; i++) {
      const nx = e.x + e.dx * s, nz = e.z + e.dz * s;
      e.range -= s;
      if (this.projectileTele(e, nx, nz)) continue;
      const hit = this.projectileTile(e, nx, nz, 'laser');
      if (hit || e.range <= 0) {
        e.remove = true;
        if (hit && hit.obj && hit.obj.t === 'turret') this.explode(hit.obj.x + 0.5, hit.obj.z + 0.5, 0.9);
        else this.explode(e.x, e.z, 1.1);
        return;
      }
      e.x = nx; e.z = nz;
      for (const t of this.ents) {
        if (t === e || t.dead || t.remove) continue;
        if (!['survivor', 'agen', 'bgen', 'cgen', 'dgen', 'npc'].includes(t.kind)) continue;
        if (t.kind === 'bgen' && t.state === 'under') continue;
        if (Math.hypot(t.x - e.x, t.z - e.z) < t.r + 0.12) {
          e.remove = true;
          this.explode(e.x, e.z, 1.1);
          return;
        }
      }
    }
  }

  updatePlasma(e, dt) {
    if (e.owned) {
      e.life -= dt;
      if (e.life <= 0) { e.remove = true; this.emit('fizzle', { x: e.x, z: e.z, big: true }); return; }
    }
    const total = e.speed * dt;
    const n = Math.ceil(total / 0.05);
    const s = total / n;
    for (let i = 0; i < n; i++) {
      const nx = e.x + e.dx * s, nz = e.z + e.dz * s;
      if (this.projectileTele(e, nx, nz)) continue;
      // Plasma rebounds from anything solid, including the void at the room's edge.
      const room = this.room;
      const tx = Math.floor(nx), tz = Math.floor(nz);
      let b = null;
      if (tileAt(room, tx, tz) === VOID) b = [tx, tz, tx + 1, tz + 1];
      else b = isSolidPoint(room, nx, nz, 'walker');
      if (b) {
        const o = room.objAt.get(tz * room.W + tx);
        if (o && o.t === 'turret' && !o.destroyed) {
          o.destroyed = true;
          this.emit('turretDestroyed', { o });
          this.emit('explode', { x: o.x + 0.5, z: o.z + 0.5, r: 0.6 });
        }
        this.reflect(e, b);
        continue;
      }
      e.x = nx; e.z = nz;
    }
    for (const t of this.ents) {
      if (t === e || t.dead || t.remove) continue;
      if (!['player', 'survivor', 'agen', 'bgen', 'cgen'].includes(t.kind)) continue;
      if (t.kind === 'bgen' && t.state === 'under') continue;
      if (Math.hypot(t.x - e.x, t.z - e.z) < t.r + e.r * 0.8) {
        if (t.kind === 'player') this.killPlayer('plasma');
        else this.kill(t, 'plasma');
      }
    }
  }

  canSeePlayer(e, range) {
    const pl = this.player;
    if (pl.dead) return false;
    if (Math.hypot(pl.x - e.x, pl.z - e.z) > range) return false;
    return lineOfSight(this.room, e.x, e.z, pl.x, pl.z);
  }

  chase(e, speed, dt, mode = 'walker') {
    const pl = this.player;
    const tx = Math.floor(e.x), tz = Math.floor(e.z);
    let gx, gz;
    if (tx === Math.floor(pl.x) && tz === Math.floor(pl.z)) { gx = pl.x; gz = pl.z; }
    else {
      const step = this.plField && flowStep(this.room, this.plField, e.x, e.z);
      if (step) [gx, gz] = step;
      else { gx = pl.x; gz = pl.z; }
    }
    const dx = gx - e.x, dz = gz - e.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) return;
    e.ang = Math.atan2(dz, dx);
    const m = Math.min(l, speed * dt);
    this.move(e, (dx / l) * m, (dz / l) * m, mode);
    e.walkT = (e.walkT || 0) + dt;
  }

  touchPlayer(e, extra = 0) {
    const pl = this.player;
    if (pl.dead) return false;
    return Math.hypot(pl.x - e.x, pl.z - e.z) < pl.r + e.r + extra;
  }

  updateAgen(e, dt) {
    const pl = this.player;
    e.walkT += dt;
    switch (e.state) {
      case 'emerge':
        e.stateT -= dt;
        if (e.stateT <= 0) e.state = 'wander';
        return;
      case 'wander': {
        e.turnT -= dt;
        if (e.turnT <= 0) {
          const a = this.rand() * Math.PI * 2;
          e.dx = Math.cos(a); e.dz = Math.sin(a);
          e.turnT = 0.8 + this.rand() * 1.5;
        }
        const ox = e.x, oz = e.z;
        this.move(e, e.dx * SPEED.agenWander * dt, e.dz * SPEED.agenWander * dt, 'walker');
        if (Math.hypot(e.x - ox, e.z - oz) < SPEED.agenWander * dt * 0.4) e.turnT = 0;
        e.ang = Math.atan2(e.dz, e.dx);
        if (this.canSeePlayer(e, 7)) { e.state = 'hunt'; e.lostT = 0; this.emit('spotted', { kind: 'agen' }); }
        break;
      }
      case 'hunt':
        if (this.canSeePlayer(e, 9)) e.lostT = 0;
        else if ((e.lostT += dt) > 3) { e.state = 'wander'; break; }
        this.chase(e, SPEED.agenHunt, dt);
        break;
      case 'smother':
        e.x = pl.x; e.z = pl.z;
        e.stateT -= dt;
        if (e.stateT <= 0) {
          this.killPlayer('agen');
          this.kill(e, 'self');
          this.emit('explode', { x: e.x, z: e.z, r: 0.5, small: true });
        }
        return;
    }
    if (e.state !== 'smother' && this.touchPlayer(e)) {
      if (this.p.shieldT > 0) { this.kill(e, 'shield'); return; }
      if (!pl.held) {
        e.state = 'smother';
        e.stateT = 1.6;
        pl.held = e;
        this.emit('smother');
      }
    }
  }

  updateBgen(e, dt) {
    const pl = this.player;
    e.walkT += dt;
    switch (e.state) {
      case 'emerge':
        e.stateT -= dt;
        if (e.stateT <= 0) {
          e.state = 'bounce';
          if (!pl.dead) {
            const a = Math.atan2(pl.z - e.z, pl.x - e.x);
            e.dx = Math.cos(a); e.dz = Math.sin(a);
          }
        }
        return;
      case 'bounce': {
        const ox = e.x, oz = e.z;
        const mx = e.dx * SPEED.bgen * dt, mz = e.dz * SPEED.bgen * dt;
        const touched = this.move(e, mx, mz, 'walker');
        if (Math.abs(e.x - ox) < Math.abs(mx) * 0.5) e.dx = -e.dx;
        if (Math.abs(e.z - oz) < Math.abs(mz) * 0.5) e.dz = -e.dz;
        e.ang = Math.atan2(e.dz, e.dx);
        e.bumpCd = (e.bumpCd || 0) - dt;
        if (e.bumpCd <= 0) {
          for (const idx of touched.keys()) {
            const o = this.room.objAt.get(idx);
            if (o && o.t === 'switch') { this.activateSwitch(o, e); e.bumpCd = 1.2; break; }
          }
        }
        e.diveT -= dt;
        if (e.diveT <= 0) { e.state = 'dive'; e.stateT = 0.45; this.emit('dive'); }
        break;
      }
      case 'dive':
        e.stateT -= dt;
        if (e.stateT <= 0) { e.state = 'under'; e.stateT = 1.4 + this.rand() * 1.2; }
        return;
      case 'under':
        e.stateT -= dt;
        this.chase(e, SPEED.bgenUnder, dt);
        if (e.stateT <= 0 || Math.hypot(pl.x - e.x, pl.z - e.z) < 0.9) {
          e.state = 'emerge';
          e.stateT = 0.35;
          e.diveT = 2.5 + this.rand() * 2.5;
          this.emit('emerge');
        }
        return;
    }
    if (e.state === 'bounce' && this.touchPlayer(e)) {
      if (this.p.shieldT > 0) { this.kill(e, 'shield'); return; }
      this.killPlayer('bgen');
    }
  }

  revealCgen(e) {
    if (e.state !== 'disguised') return;
    e.state = 'reveal';
    e.stateT = 0.7;
    this.emit('cgenReveal', { x: e.x, z: e.z });
  }

  updateCgen(e, dt) {
    const pl = this.player;
    switch (e.state) {
      case 'disguised':
        if (!pl.dead && Math.hypot(pl.x - e.x, pl.z - e.z) < 1.45) this.revealCgen(e);
        return;
      case 'reveal':
        e.stateT -= dt;
        e.ang = Math.atan2(pl.z - e.z, pl.x - e.x);
        if (e.stateT <= 0) e.state = 'chase';
        return;
      case 'chase':
        this.chase(e, SPEED.cgen, dt);
        if (this.touchPlayer(e)) {
          if (this.p.shieldT > 0) return;
          if (this.killPlayer('cgen')) e.state = 'feast';
        }
        break;
    }
  }

  updateDgen(e, dt) {
    const pl = this.player;
    if (e.state === 'idle') {
      e.stateT -= dt;
      if (e.stateT <= 0) { e.state = 'chase'; this.emit('dgenWake'); }
      return;
    }
    if (pl.dead) return;
    this.chase(e, SPEED.dgen, dt);
    if (this.touchPlayer(e)) this.killPlayer('dgen');
  }

  updateSurvivor(e, dt) {
    if (e.shakeT > 0) e.shakeT -= dt;
    if (e.state === 'trapped') {
      if (this.room.secured) {
        e.state = 'free';
        this.emit('freed', { x: e.x, z: e.z });
      }
      return;
    }
    const room = this.room;
    if (!room.arrows.length) return;
    this.arrowFieldT -= dt;
    if (!this.arrowField || this.arrowFieldT <= 0) {
      this.arrowField = flowField(room, room.arrows.map((a) => [a.x, a.z]));
      this.arrowFieldT = 0.5;
    }
    const tx = Math.floor(e.x), tz = Math.floor(e.z);
    const onArrow = room.arrows.some((a) => a.x === tx && a.z === tz);
    let gx, gz;
    if (onArrow) { gx = tx + 0.5; gz = tz + 0.5; }
    else {
      const st = flowStep(room, this.arrowField, e.x, e.z);
      if (!st) return;
      [gx, gz] = st;
    }
    const dx = gx - e.x, dz = gz - e.z;
    const l = Math.hypot(dx, dz);
    if (onArrow && l < 0.12) { this.rescue(e); return; }
    if (l > 1e-4) {
      const m = Math.min(l, SPEED.survivor * dt);
      e.ang = Math.atan2(dz, dx);
      this.move(e, (dx / l) * m, (dz / l) * m, 'walker');
      e.walkT = (e.walkT || 0) + dt;
    }
  }

  rescue(e) {
    e.dead = true;
    e.remove = true;
    e.obj.rescued = true;
    this.p.rescued++;
    this.p.lives++;
    this.emit('rescued', { x: e.x, z: e.z });
    this.msg(`1 Person Rescued! (${this.p.rescued} total)`);
    if (e.obj.gives && !e.obj.gave) {
      e.obj.gave = true;
      this.giveItem(e.obj.gives, e.obj.n ?? 1);
    }
  }

  // ---------------------------------------------------------------- static objects

  telePartner(o) {
    const list = this.room.byChar.get(o.to) || [];
    return list.find((p) => p !== o) || null;
  }

  teleCheck(e) {
    const room = this.room;
    if (e.teleLock) {
      if (Math.hypot(e.x - e.teleLock.x - 0.5, e.z - e.teleLock.z - 0.5) > 0.62) e.teleLock = null;
      else return;
    }
    const o = room.objAt.get(Math.floor(e.z) * room.W + Math.floor(e.x));
    if (!o || o.t !== 'tele' || !o.on) return;
    if (Math.hypot(e.x - o.x - 0.5, e.z - o.z - 0.5) > 0.36) return;
    const dst = this.telePartner(o);
    if (!dst) return;
    e.x = dst.x + 0.5;
    e.z = dst.z + 0.5;
    e.teleLock = dst;
    this.emit('tele', { x: e.x, z: e.z });
  }

  plateOn(o) {
    if (!o.enabled) return false;
    const per = o.onT + o.offT;
    return ((this.room.t + o.phase) % per) < o.onT;
  }

  eyeBeam(o) {
    const room = this.room;
    const [dx, dz] = DIR_NAMES[o.dir];
    let x = o.x + dx, z = o.z + dz;
    let n = 0;
    while (tileAt(room, x, z) === FLOOR || (tileAt(room, x, z) === DOOR && room.objAt.get(z * room.W + x).open)) {
      const ob = room.objAt.get(z * room.W + x);
      if (ob && (ob.t === 'prop' || ob.t === 'turret' || ob.t === 'terminal')) break;
      x += dx; z += dz; n++;
      if (n > 40) break;
    }
    return { x0: o.x + 0.5 + dx * 0.5, z0: o.z + 0.5 + dz * 0.5, len: n, dx, dz };
  }

  inBeam(e, beam) {
    const rx = e.x - beam.x0, rz = e.z - beam.z0;
    const along = rx * beam.dx + rz * beam.dz;
    if (along < 0 || along > beam.len) return false;
    const perp = Math.abs(rx * beam.dz - rz * beam.dx);
    return perp < e.r + 0.05;
  }

  fireDish(o) {
    if (o.beamT > 0) return;
    o.beamT = 1.3;
    const [dx, dz] = DIR_NAMES[o.dir || 'w'];
    o.beam = { x0: o.x + 0.5, z0: o.z + 0.5, dx, dz, len: 0 };
    let x = o.x + dx, z = o.z + dz, n = 0;
    while (tileAt(this.room, x, z) === FLOOR && n < 40) { x += dx; z += dz; n++; }
    o.beam.len = n + 0.5;
    this.emit('dish', { o });
  }

  updateObjects(dt) {
    const room = this.room;
    const pl = this.player;
    const walkers = this.ents.filter((e) => !e.dead && !e.remove &&
      ['player', 'survivor', 'agen', 'bgen', 'cgen', 'dgen'].includes(e.kind) &&
      !(e.kind === 'bgen' && (e.state === 'under' || e.state === 'dive')));
    for (const o of room.objs) {
      switch (o.t) {
        case 'turret': {
          if (o.destroyed || !o.on) break;
          o.cd -= dt;
          const cx = o.x + 0.5, cz = o.z + 0.5;
          let target = null;
          if (!pl.dead && Math.hypot(pl.x - cx, pl.z - cz) < 11 && lineOfSight(room, cx, cz, pl.x, pl.z)) target = pl;
          if (target) {
            const a = Math.atan2(target.z - cz, target.x - cx);
            const d = angleDiff(o.angle, a);
            const turn = (o.track ?? 1.5) * dt;
            o.angle += Math.max(-turn, Math.min(turn, d));
            if (Math.abs(d) < 0.12 && o.cd <= 0) {
              this.spawn('tshot', cx + Math.cos(o.angle) * 0.45, cz + Math.sin(o.angle) * 0.45, {
                r: 0.1, dx: Math.cos(o.angle), dz: Math.sin(o.angle), life: 4, src: o, y: 0.55,
              });
              o.cd = o.rate ?? 1.4;
              this.emit('tshot', { x: cx, z: cz });
            }
          } else {
            o.angle += o.rot * dt;
          }
          break;
        }
        case 'plate':
          if (this.plateOn(o)) {
            for (const e of walkers) {
              if (e.kind === 'survivor' || e.kind === 'dgen') continue;
              if (Math.abs(e.x - o.x - 0.5) < 0.5 && Math.abs(e.z - o.z - 0.5) < 0.5) {
                this.emit('zap', { x: e.x, z: e.z });
                if (e.kind === 'player') this.killPlayer('plate');
                else this.kill(e, 'plate');
              }
            }
          }
          break;
        case 'mine':
          if (o.exploded) break;
          for (const e of walkers) {
            if (e.kind === 'survivor' || e.kind === 'dgen') continue;
            if (Math.abs(e.x - o.x - 0.5) < 0.44 && Math.abs(e.z - o.z - 0.5) < 0.44) {
              o.exploded = true;
              this.explode(o.x + 0.5, o.z + 0.5, 0.9);
              break;
            }
          }
          break;
        case 'eye': {
          if (o.destroyed || !o.on) { o.tripped = false; break; }
          const beam = this.eyeBeam(o);
          let hit = false;
          for (const e of walkers) {
            if (e.kind !== 'player' && e.kind !== 'survivor') continue;
            if (this.inBeam(e, beam)) hit = true;
          }
          if (hit && !o.tripped) {
            this.emit('alarm');
            this.toggleTargets(o.targets, o.remote);
            if (o.kill) this.killPlayer('eye');
          }
          o.tripped = hit;
          break;
        }
        case 'dish':
          if (o.beamT > 0) {
            o.beamT -= dt;
            for (const e of walkers) if (this.inBeam(e, o.beam)) this.kill(e, 'dish');
          }
          break;
      }
    }
    for (const e of walkers) if (e.kind !== 'player') this.teleCheck(e);
  }

  updateVents(dt, frozen) {
    const pl = this.player;
    for (const v of this.room.objs) {
      if (v.t !== 'vent' || v.sealed) continue;
      if (frozen) continue;
      if (v.ent && (v.ent.dead || v.ent.remove)) v.ent = null;
      if (v.ent) continue;
      v.timer -= dt;
      if (v.timer <= 0 && Math.hypot(pl.x - v.x - 0.5, pl.z - v.z - 0.5) > 1.1) {
        v.ent = this.spawnCreature(v.gen, v.x + 0.5, v.z + 0.5, { vent: v });
        v.timer = 1.8;
        this.emit('ventSpawn', { x: v.x + 0.5, z: v.z + 0.5 });
      }
    }
  }

  updateSecurity() {
    const room = this.room;
    if (room.secured || !room.threat) return;
    if (this.ents.some((e) => e.hostile && !e.dead && !e.remove)) return;
    if (room.objs.some((o) => o.t === 'vent' && !o.sealed)) return;
    room.secured = true;
    this.emit('secured');
    this.msg('Room Secured');
    let opened = false;
    for (const o of room.objs) {
      if (o.t === 'door' && o.sec && !o.open) { o.open = true; opened = true; this.emit('door', { o }); }
    }
    if (opened) this.msg('Security Door Opened!');
  }
}
