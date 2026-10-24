// Keyboard + touch input, turned into one per-frame snapshot for the simulation.

const KEYMAP = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  Space: 'fire', KeyJ: 'fire', KeyG: 'grenade', KeyT: 'grenade',
  KeyQ: 'use', KeyB: 'use', Tab: 'cycle', KeyU: 'cycle',
  KeyE: 'talk', Enter: 'talk',
};

export class Input {
  constructor() {
    this.down = new Set();
    this.pressed = new Set();
    this.rotated = false; // false: arrows follow the screen; true: arrows follow the walls
    this.touchVec = null;
    this.touchButtons = new Set();
    this.enabled = true;
    window.addEventListener('keydown', (e) => {
      if (e.target && e.target.tagName === 'INPUT') return; // typing into a terminal
      const a = KEYMAP[e.code];
      if (a && this.enabled) {
        if (!this.down.has(a)) this.pressed.add(a);
        this.down.add(a);
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      const a = KEYMAP[e.code];
      if (a) this.down.delete(a);
    });
    window.addEventListener('blur', () => this.down.clear());
  }

  clear() {
    this.down.clear();
    this.pressed.clear();
    this.touchButtons.clear();
  }

  // Screen-space intent (x right, y up) -> world-space (x, z) movement.
  snapshot() {
    let sx = 0, sy = 0;
    if (this.down.has('left')) sx -= 1;
    if (this.down.has('right')) sx += 1;
    if (this.down.has('up')) sy += 1;
    if (this.down.has('down')) sy -= 1;
    if (this.touchVec) { sx = this.touchVec[0]; sy = this.touchVec[1]; }
    let mx, mz;
    if (this.rotated) { mx = sx; mz = -sy; }
    else { mx = sx - sy; mz = -sx - sy; }
    const has = (a) => this.down.has(a) || this.touchButtons.has(a);
    const s = {
      move: [mx, mz],
      fire: has('fire'),
      firePressed: this.pressed.has('fire'),
      grenade: this.pressed.has('grenade'),
      use: this.pressed.has('use'),
      cycle: this.pressed.has('cycle'),
      talk: this.pressed.has('talk'),
    };
    this.pressed.clear();
    return s;
  }

  tap(action) { this.pressed.add(action); }

  bindTouch(root) {
    const stick = root.querySelector('.stick');
    const knob = root.querySelector('.knob');
    let id = null, cx = 0, cy = 0;
    const R = 46;
    const move = (t) => {
      let dx = t.clientX - cx, dy = t.clientY - cy;
      const l = Math.hypot(dx, dy);
      if (l > R) { dx = (dx / l) * R; dy = (dy / l) * R; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      if (l < 10) { this.touchVec = [0, 0]; return; }
      // Snap to 8 directions like a joystick.
      const a = Math.round(Math.atan2(-dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      this.touchVec = [Math.round(Math.cos(a) * 100) / 100, Math.round(Math.sin(a) * 100) / 100];
    };
    stick.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      id = t.identifier;
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      move(t);
      e.preventDefault();
    }, { passive: false });
    stick.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) if (t.identifier === id) move(t);
      e.preventDefault();
    }, { passive: false });
    const end = (e) => {
      for (const t of e.changedTouches) if (t.identifier === id) {
        id = null; this.touchVec = null; knob.style.transform = '';
      }
    };
    stick.addEventListener('touchend', end);
    stick.addEventListener('touchcancel', end);
    for (const b of root.querySelectorAll('[data-act]')) {
      const act = b.dataset.act;
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        b.classList.add('on');
        if (act === 'fire') { this.touchButtons.add('fire'); this.pressed.add('fire'); }
        else this.pressed.add(act);
      }, { passive: false });
      const up = () => { b.classList.remove('on'); if (act === 'fire') this.touchButtons.delete('fire'); };
      b.addEventListener('touchend', up);
      b.addEventListener('touchcancel', up);
    }
  }
}
