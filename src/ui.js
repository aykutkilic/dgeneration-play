// DOM overlays: HUD, menus, dialogs, terminals, story pages.
import { ITEM_NAMES } from './sim/game.js';

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export class UI {
  constructor(app) {
    this.app = app;
    this.root = $('#ui');
    this.hud = $('#hud');
    this.msgEl = $('#hud .msg');
    this.statEl = $('#hud .stats');
    this.sceneEl = $('#scene-label');
    this.overlay = $('#overlay');
    this.msgs = [];
    this.msgT = 0;
    this.curMsg = null;
    this.menu = null; // { items, sel, onPick }
    this.modal = null; // 'title' | 'story' | 'dialog' | 'terminal' | 'pause' | ...
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  get blocking() { return this.modal != null; }

  // ------------------------------------------------------------ HUD

  pushMsg(text, time = 2.6) {
    if (this.curMsg && this.curMsg.text === text) { this.msgT = Math.max(this.msgT, time); return; }
    if (this.msgs.some((m) => m.text === text)) return;
    this.msgs.push({ text, time });
  }

  clearMsgs() { this.msgs = []; this.curMsg = null; this.msgT = 0; this.msgEl.textContent = ''; }

  updateHud(game, dt) {
    if (!game.p) return;
    this.msgT -= dt;
    if (this.msgT <= 0) {
      this.curMsg = this.msgs.shift() || null;
      this.msgT = this.curMsg ? Math.max(1.2, this.curMsg.time / (1 + this.msgs.length * 0.5)) : 0;
    }
    let line = this.curMsg ? this.curMsg.text : '';
    if (!line && game.bomber != null) {
      const s = Math.max(0, Math.ceil(game.bomber));
      line = `Bomber will attack in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    if (this.msgEl.textContent !== line) this.msgEl.textContent = line;
    this.msgEl.classList.toggle('alert', game.bomber != null && !this.curMsg);
    const p = game.p;
    const item = p.sel ? `${ITEM_NAMES[p.sel]} x${p.items[p.sel]}` : '—';
    const flags = [];
    if (p.shieldT > 0) flags.push(`<span class="shield">SHIELD ${Math.ceil(p.shieldT)}</span>`);
    if (game.freezeT > 0) flags.push(`<span class="freeze">FROZEN ${Math.ceil(game.freezeT)}</span>`);
    const html =
      `<span>Lives <b>${p.lives}</b></span>` +
      `<span>Grenades <b>${p.grenades}</b></span>` +
      `<span>Floor <b>${game.floorNum}</b></span>` +
      `<span>Rescued <b>${p.rescued}</b></span>` +
      `<span>Sec Level <b>${p.keyLevel}</b></span>` +
      `<span>Item <b>${esc(item)}</b></span>` +
      (game.room && game.room.threat && !game.room.secured ? '<span class="insecure">INSECURE</span>' : '') +
      flags.join('');
    if (this.statEl.innerHTML !== html) this.statEl.innerHTML = html;
    const r = game.room;
    const label = r ? `Floor ${game.floorNum} · Scene ${r.def.scene ?? '?'}${r.def.name ? ' · ' + esc(r.def.name) : ''}` : '';
    if (this.sceneEl.innerHTML !== label) this.sceneEl.innerHTML = label;
  }

  showHud(on) {
    this.hud.style.display = on ? '' : 'none';
    this.sceneEl.style.display = on ? '' : 'none';
    document.body.classList.toggle('playing', on);
  }

  // ------------------------------------------------------------ generic overlay

  open(kind, html, cls = '') {
    this.modal = kind;
    this.overlay.className = `show ${cls}`;
    this.overlay.innerHTML = html;
    this.app.input.clear();
  }

  close() {
    this.modal = null;
    this.menu = null;
    this.pages = null;
    this.overlay.className = '';
    this.overlay.innerHTML = '';
    this.app.input.clear();
  }

  setMenu(container, items, onPick, sel = 0) {
    this.menu = { container, items, sel, onPick };
    this.renderMenu();
  }

  renderMenu() {
    const m = this.menu;
    m.container.innerHTML = '';
    m.items.forEach((it, i) => {
      const b = el('button', `mi${i === m.sel ? ' sel' : ''}${it.dim ? ' dim' : ''}`, esc(it.label));
      b.addEventListener('click', () => { m.sel = i; this.pickMenu(); });
      b.addEventListener('mouseenter', () => { if (m.sel !== i) { m.sel = i; this.renderMenu(); } });
      m.container.appendChild(b);
    });
  }

  pickMenu() {
    const m = this.menu;
    if (!m) return;
    this.app.sfx.play('menu');
    m.onPick(m.items[m.sel], m.sel);
  }

  // Paged text (story screens, answers). Calls done() after the last page.
  showPages(kind, title, pages, done, cls = 'story') {
    this.open(kind, `<div class="panel ${cls}"><h2>${esc(title || '')}</h2><div class="body"></div><div class="hint">Enter / click to continue</div></div>`, cls);
    const body = $('.body', this.overlay);
    this.pages = { list: pages, i: 0, done, body };
    const show = () => { body.innerHTML = pages[this.pages.i].split('\n\n').map((p) => `<p>${esc(p)}</p>`).join(''); };
    this.pages.show = show;
    show();
    this.overlay.firstChild.addEventListener('click', () => this.nextPage());
  }

  nextPage() {
    const pg = this.pages;
    if (!pg) return;
    this.app.sfx.play('menu');
    pg.i++;
    if (pg.i >= pg.list.length) { this.pages = null; pg.done(); }
    else pg.show();
  }

  // ------------------------------------------------------------ screens

  title(hasSave) {
    this.showHud(false);
    this.open('title', `
      <div class="title">
        <div class="logo">D<span>/</span>GENERATION</div>
        <div class="sub">Genoq Biolabs · Singapore · June 2021</div>
        <div class="menu"></div>
        <div class="foot">A fan remake in three.js of Robert Cook's 1991 classic. Not affiliated with the original publishers.</div>
      </div>`, 'title-screen');
    const items = [{ id: 'new', label: 'New Game' }];
    if (hasSave) items.unshift({ id: 'continue', label: `Continue (Floor ${hasSave.floor})` });
    items.push({ id: 'controls', label: 'Controls' }, { id: 'about', label: 'About' });
    this.setMenu($('.menu', this.overlay), items, (it) => this.app.titlePick(it.id));
  }

  controls(back) {
    const rows = [
      ['Arrows / WASD', 'Move (8 directions)'],
      ['Space / J', 'Fire laser (bounces off walls 4 times)'],
      ['G / T', 'Throw grenade'],
      ['Q / B', 'Use selected item'],
      ['Tab / U', 'Select next item'],
      ['E / Enter', 'Talk to survivors, use terminals'],
      ['K', 'Toggle controls: screen-relative / wall-aligned'],
      ['P', 'Pixel size'],
      ['M', 'Sound on/off'],
      ['Esc', 'Pause menu (abort room, restart floor)'],
    ];
    const tips = [
      'Bump a yellow triangle on a wall — or shoot it — to work a switch.',
      'Run across a red vent to seal it. Kill everything and seal every vent to secure a room.',
      'When a room is secure, red security doors open and survivors head for the red arrow. Each one rescued is an extra life.',
      'White triangles are security keyholes: you need a key of high enough level.',
      'Trackers (turrets) only die to grenades, bombs, plasma — or each other\'s shots.',
      'C/Generations hide as people or furniture. Lasers don\'t hurt them.',
    ];
    this.open('controls', `<div class="panel controls"><h2>Controls</h2>
      <table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
      <h3>How security works</h3><ul>${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <div class="menu"></div></div>`);
    this.setMenu($('.menu', this.overlay), [{ label: 'Back' }], back);
  }

  about(back) {
    this.open('about', `<div class="panel controls"><h2>About</h2>
      <p>This is a from-scratch remake of <b>D/Generation</b> (Robert Cook, Mindscape, 1991; Amiga conversion by Abersoft, 1992), written in JavaScript with three.js.</p>
      <p>The rules follow the original: one-hit deaths, vents that must be sealed, rooms that must be secured, a laser that ricochets four times, trackers, electrified plates, mines, teleporters, shapeshifting C/Generations, survivors to rescue and a bomber on the clock. The rooms, art, sound and writing here are new.</p>
      <p>It grew out of a reverse-engineering study of the Amiga disks (level containers, shape banks, palettes). No original game data ships with this page.</p>
      <div class="menu"></div></div>`);
    this.setMenu($('.menu', this.overlay), [{ label: 'Back' }], back);
  }

  pause(game) {
    this.open('pause', `<div class="panel pause"><h2>Paused</h2><div class="menu"></div></div>`);
    const items = [
      { id: 'resume', label: 'Resume' },
      { id: 'abort', label: 'Abort room (costs a life)' },
      { id: 'restart', label: 'Restart floor' },
      { id: 'controls', label: 'Controls' },
      { id: 'sound', label: `Sound: ${this.app.sfx.enabled ? 'on' : 'off'}` },
      { id: 'pixels', label: `Pixel size: ${['sharp', '2x', '3x'][this.app.view.pixelScale] ?? this.app.view.pixelScale}` },
      { id: 'mode', label: `Controls: ${this.app.input.rotated ? 'wall-aligned' : 'screen-relative'}` },
      { id: 'quit', label: 'Quit to title' },
    ];
    this.setMenu($('.menu', this.overlay), items, (it) => this.app.pausePick(it.id));
  }

  floorIntro(ev, done) {
    const pages = [`${ev.intro || ''}`];
    this.open('floor', `<div class="panel floor"><div class="big">FLOOR ${ev.n}</div><h2>${esc(ev.name || '')}</h2><div class="body"></div><div class="hint">Enter / click to begin</div></div>`);
    $('.body', this.overlay).innerHTML = pages[0].split('\n\n').map((p) => `<p>${esc(p)}</p>`).join('');
    this.pages = { list: pages, i: 0, done, show() {} };
    this.overlay.firstChild.addEventListener('click', () => this.nextPage());
  }

  dialog(ev, game, done) {
    const d = ev.dialog;
    const obj = ev.obj;
    this.open('dialog', `<div class="panel dialog"><div class="who">${esc(d.name || 'Survivor')}</div><div class="said"></div><div class="menu"></div></div>`, 'dialog-wrap');
    const said = $('.said', this.overlay);
    const menuEl = $('.menu', this.overlay);
    const asked = new Set();
    let pending = null;
    const say = (text, who = 'them') => {
      said.innerHTML = `<p class="${who}">${esc(text)}</p>`;
    };
    const topics = () => {
      const items = (d.topics || []).map((t, i) => ({ label: t.q, i, dim: asked.has(i) }));
      items.push({ label: d.byeQ || 'Goodbye.', bye: true });
      this.setMenu(menuEl, items, (it) => {
        if (it.bye) {
          say(d.bye || 'Bye.');
          this.setMenu(menuEl, [{ label: 'Continue ▸' }], () => { this.close(); done(d.onEnd); });
          return;
        }
        const t = d.topics[it.i];
        asked.add(it.i);
        const pages = [].concat(t.a);
        let k = 0;
        const step = () => {
          say(pages[k]);
          const last = k === pages.length - 1;
          this.setMenu(menuEl, [{ label: last ? 'Continue ▸' : 'More ▸' }], () => {
            if (!last) { k++; step(); return; }
            if (t.act && !t.done) { t.done = true; pending = t.act; game.runActions(t.act); }
            if (t.end) { this.close(); done(d.onEnd); return; }
            topics();
          });
        };
        step();
      });
    };
    let greet = obj && obj.talked && d.again ? d.again : d.greet;
    if (ev.ent && ev.ent.kind === 'survivor' && ev.ent.state === 'trapped' && game.room.threat && !game.room.secured) {
      greet = `${greet || ''}`;
      say(greet);
      said.innerHTML += `<p class="note">They won't leave until the room is secured.</p>`;
    } else say(greet || '…');
    topics();
    void pending;
  }

  terminal(ev, game, done) {
    const o = ev.obj;
    const t = ev.text || { title: 'TERMINAL', lines: ['NO DATA'] };
    this.open('terminal', `<div class="panel term"><div class="tt">${esc(t.title || 'GENOQ BIOLABS NETWORK')}</div><div class="screen"></div><div class="tin"></div><div class="hint">Esc to log off</div></div>`, 'term-wrap');
    const screen = $('.screen', this.overlay);
    const tin = $('.tin', this.overlay);
    const print = (lines) => { screen.innerHTML = [].concat(lines).map((l) => `<div>${esc(l) || '&nbsp;'}</div>`).join(''); };
    this.termDone = () => { this.close(); done(); };
    if (o.pass && !o.unlocked) {
      print(t.locked || t.lines || []);
      tin.innerHTML = `<label>${o.user ? 'USER ' : ''}${o.user ? '<input class="u" autocomplete="off" spellcheck="false">' : ''}</label><label>PASSCODE <input class="p" type="password" autocomplete="off" spellcheck="false"></label>`;
      const u = $('.u', tin), p = $('.p', tin);
      (u || p).focus();
      const submit = () => {
        const ok = game.terminalLogin(o, u ? u.value : '', p.value);
        if (ok) {
          tin.innerHTML = '';
          print(t.after || ['ACCESS GRANTED']);
          this.menuForTerm(tin);
        } else {
          screen.insertAdjacentHTML('beforeend', '<div class="deny">ACCESS DENIED</div>');
          p.value = '';
          (u || p).focus();
        }
      };
      for (const inp of tin.querySelectorAll('input')) {
        inp.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { this.termDone(); return; }
          if (e.key === 'Enter') {
            if (inp === u && p) p.focus();
            else submit();
          } else this.app.sfx.play('type');
        });
      }
    } else {
      print(o.unlocked ? (t.after || t.lines) : (t.lines || t.after));
      this.menuForTerm(tin);
    }
  }

  menuForTerm(tin) {
    const m = el('div', 'menu');
    tin.appendChild(m);
    this.setMenu(m, [{ label: 'Log off' }], () => this.termDone());
  }

  gameOver(done) {
    this.open('gameover', `<div class="panel pause"><div class="big red">GAME OVER</div><p>You can restart this floor with the lives you had when you entered it.</p><div class="menu"></div></div>`);
    this.setMenu($('.menu', this.overlay), [{ id: 'restart', label: 'Restart floor' }, { id: 'quit', label: 'Quit to title' }], (it) => done(it.id));
  }

  floorDone(ev, game, done) {
    this.open('done', `<div class="panel pause"><div class="big">FLOOR ${ev.floor}</div><h2>Gravity lift</h2><p>People rescued so far: <b>${game.p.rescued}</b></p><p>Lives: <b>${game.p.lives}</b></p><div class="menu"></div></div>`);
    this.setMenu($('.menu', this.overlay), [{ label: `Ride up to floor ${ev.next}` }], done);
  }

  // ------------------------------------------------------------ keys

  onKey(e) {
    if (!this.modal) return;
    if (this.modal === 'terminal' && e.target.tagName === 'INPUT') return;
    const k = e.code;
    if (this.pages && (k === 'Enter' || k === 'Space' || k === 'KeyE')) {
      e.preventDefault();
      this.nextPage();
      return;
    }
    if (this.modal === 'terminal' && k === 'Escape') { e.preventDefault(); this.termDone(); return; }
    const m = this.menu;
    if (!m) return;
    if (k === 'ArrowUp' || k === 'KeyW') { m.sel = (m.sel + m.items.length - 1) % m.items.length; this.renderMenu(); this.app.sfx.play('menu'); e.preventDefault(); }
    else if (k === 'ArrowDown' || k === 'KeyS' || k === 'Tab') { m.sel = (m.sel + 1) % m.items.length; this.renderMenu(); this.app.sfx.play('menu'); e.preventDefault(); }
    else if (k === 'Enter' || k === 'Space' || k === 'KeyE') { e.preventDefault(); this.pickMenu(); }
    else if (k === 'Escape' && this.modal === 'pause') { e.preventDefault(); this.app.pausePick('resume'); }
    else if (/^Digit[1-9]$/.test(k)) {
      const i = Number(k.slice(5)) - 1;
      if (i < m.items.length) { m.sel = i; this.renderMenu(); this.pickMenu(); }
    }
  }
}
