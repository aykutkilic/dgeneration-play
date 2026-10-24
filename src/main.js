// Entry point: wires simulation, renderer, UI, input and audio together.
import { Game } from './sim/game.js';
import { View } from './render/view.js';
import { UI } from './ui.js';
import { Input } from './input.js';
import { Sfx } from './audio.js';
import { DATA } from './data/index.js';

const SAVE_KEY = 'dgeneration-save-v1';
const PREF_KEY = 'dgeneration-prefs-v1';

const SFX_EVENTS = new Set(['laser', 'bounce', 'spark', 'switch', 'door', 'deny', 'explode', 'death', 'playerDeath',
  'seal', 'ventSpawn', 'pickup', 'secured', 'rescued', 'tele', 'tshot', 'zap', 'throw', 'bombSet', 'smother',
  'spotted', 'freeze', 'shield', 'alarm', 'cgenReveal', 'dive', 'emerge', 'granted', 'dish', 'gameover', 'dgenWake']);

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function saveJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ }
}

class App {
  constructor() {
    this.input = new Input();
    this.sfx = new Sfx();
    this.view = new View(document.getElementById('game'));
    this.ui = new UI(this);
    this.game = new Game(DATA);
    const prefs = loadJSON(PREF_KEY) || {};
    if (prefs.pixel != null) this.view.setPixelScale(prefs.pixel);
    if (prefs.rotated) this.input.rotated = true;
    if (prefs.sound === false) this.sfx.enabled = false;
    this.last = performance.now();
    window.addEventListener('resize', () => this.view.resize());
    window.addEventListener('keydown', (e) => this.globalKey(e));
    const unlock = () => this.sfx.unlock();
    window.addEventListener('keydown', unlock);
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('touchstart', unlock);
    // ...and on Halloween everything turns black and white.
    const now = new Date();
    if (now.getMonth() === 9 && now.getDate() === 31) document.body.classList.add('halloween');
    if (matchMedia('(pointer: coarse)').matches) {
      document.body.classList.add('touch');
      this.input.bindTouch(document.getElementById('touch'));
      document.querySelector('#touch [data-menu]').addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (!this.ui.blocking && this.game.mode === 'play') this.ui.pause(this.game);
      }, { passive: false });
    }
    const warp = new URLSearchParams(location.search).get('warp');
    if (warp) this.warp(warp);
    else this.toTitle();
    requestAnimationFrame((t) => this.frame(t));
  }

  // Development shortcut: ?warp=FLOOR or ?warp=FLOOR:ROOM[:EXIT] starts there directly.
  warp(spec) {
    const [floor, room, at] = spec.split(':');
    this.game.newGame();
    this.game.startFloor(Number(floor));
    if (room) {
      const def = this.game.floor.rooms[room];
      this.game.room = null;
      this.game.enterRoom(room, at ?? (def.map.some((l) => l.includes('@')) ? null : Object.keys(def.exits || {})[0]));
    }
    this.game.p.hasLaser = true;
    this.game.mode = 'play';
    this.game.events = this.game.events.filter((e) => e.type === 'room' || e.type === 'msg');
    this.ui.showHud(true);
    this.drain();
  }

  savePrefs() {
    saveJSON(PREF_KEY, { pixel: this.view.pixelScale, rotated: this.input.rotated, sound: this.sfx.enabled });
  }

  toTitle() {
    this.game.mode = 'idle';
    this.view.showTitle();
    this.ui.clearMsgs();
    this.ui.title(loadJSON(SAVE_KEY));
  }

  titlePick(id) {
    if (id === 'new') {
      this.ui.showPages('story', 'June 2021', DATA.intro, () => {
        this.ui.close();
        this.view.hideTitle();
        this.game.newGame();
        this.drain();
      });
    } else if (id === 'continue') {
      const s = loadJSON(SAVE_KEY);
      this.ui.close();
      this.view.hideTitle();
      this.game.loadSave(s);
      this.drain();
    } else if (id === 'controls') {
      this.ui.controls(() => this.toTitle());
    } else if (id === 'about') {
      this.ui.about(() => this.toTitle());
    }
  }

  pausePick(id) {
    const g = this.game;
    switch (id) {
      case 'resume': this.ui.close(); break;
      case 'abort': this.ui.close(); g.abortRoom(); break;
      case 'restart': this.ui.close(); g.restartFloor(); this.drain(); break;
      case 'controls': this.ui.controls(() => this.ui.pause(g)); break;
      case 'sound': this.sfx.toggle(); this.savePrefs(); this.ui.pause(g); break;
      case 'pixels': this.view.setPixelScale((this.view.pixelScale + 1) % 3); this.savePrefs(); this.ui.pause(g); break;
      case 'mode': this.input.rotated = !this.input.rotated; this.savePrefs(); this.ui.pause(g); break;
      case 'quit': this.ui.close(); this.toTitle(); break;
    }
  }

  globalKey(e) {
    const playing = this.game.mode === 'play' && !this.ui.blocking;
    if (e.code === 'Escape' && playing) { e.preventDefault(); this.ui.pause(this.game); return; }
    if (this.ui.modal === 'terminal') return;
    if (e.code === 'KeyM') { const on = this.sfx.toggle(); this.savePrefs(); if (playing) this.ui.pushMsg(`Sound ${on ? 'on' : 'off'}`, 1.5); }
    if (e.code === 'KeyP') { this.view.setPixelScale((this.view.pixelScale + 1) % 3); this.savePrefs(); }
    if (e.code === 'KeyK' && playing) {
      this.input.rotated = !this.input.rotated;
      this.savePrefs();
      this.ui.pushMsg(this.input.rotated ? 'Controls: wall-aligned' : 'Controls: screen-relative', 2);
    }
    if (e.code === 'KeyA' && e.ctrlKey && playing) { e.preventDefault(); this.game.abortRoom(); }
  }

  // Handle every event the simulation produced since the last call.
  drain() {
    const g = this.game;
    const evs = g.events;
    g.events = [];
    for (const ev of evs) {
      if (SFX_EVENTS.has(ev.type)) this.sfx.play(ev.type);
      switch (ev.type) {
        case 'room': this.view.buildRoom(g); this.ui.msgs = []; break;
        case 'msg': this.ui.pushMsg(ev.text, ev.time); break;
        case 'save': saveJSON(SAVE_KEY, ev.data); break;
        case 'floor':
          this.ui.showHud(true);
          this.sfx.play('floor');
          this.ui.floorIntro(ev, () => {
            this.ui.close();
            g.mode = 'play';
            if (ev.confiscate) this.ui.pushMsg('Your weapons have been confiscated!', 4);
          });
          break;
        case 'dialog':
          this.ui.dialog(ev, g, (onEnd) => { g.endDialog(ev.obj, onEnd); this.drain(); });
          break;
        case 'terminal':
          this.ui.terminal(ev, g, () => { g.endTerminal(ev.obj); this.drain(); });
          break;
        case 'story':
          this.ui.showPages('story', '', [ev.text], () => this.ui.close());
          break;
        case 'floorDone':
          this.ui.floorDone(ev, g, () => { this.ui.close(); g.startFloor(ev.next); this.drain(); });
          break;
        case 'gameover':
          this.ui.gameOver((id) => {
            this.ui.close();
            if (id === 'restart') { g.restartFloor(); this.drain(); } else this.toTitle();
          });
          break;
        case 'ending': {
          const end = DATA.endings[ev.kind];
          if (ev.kind === 'win') try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
          this.ui.showPages('ending', end.title, end.pages, () => { this.ui.close(); this.toTitle(); }, 'story ending');
          break;
        }
      }
      if (this.view.room && ev.type !== 'room') this.view.onEvent(ev, g);
    }
  }

  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const g = this.game;
    if (g.mode === 'play' && !this.ui.blocking) {
      const inp = this.input.snapshot();
      const n = Math.max(1, Math.ceil(dt / (1 / 60)));
      for (let i = 0; i < n; i++) {
        g.update(dt / n, i === 0 ? inp : { ...inp, firePressed: false, grenade: false, use: false, cycle: false, talk: false });
        if (g.mode !== 'play') break;
      }
    }
    this.drain();
    if (this.view.titleGroup) this.view.updateTitle(dt);
    else if (this.view.room) this.view.update(g, this.ui.blocking ? 0 : dt);
    this.ui.updateHud(g, this.ui.blocking ? 0 : dt);
    this.view.render();
    requestAnimationFrame((t) => this.frame(t));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  try {
    window.app = new App();
  } catch (err) {
    document.getElementById('overlay').className = 'show';
    document.getElementById('overlay').innerHTML = `<div class="panel"><h2>Could not start</h2><p>${String(err.message || err)}</p><p>This game needs WebGL.</p></div>`;
    throw err;
  }
});
