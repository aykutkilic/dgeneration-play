// Synthesized sound effects (WebAudio, no sample files).
export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.vol = 0.35;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.vol;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggle() {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  tone(type, f0, f1, dur, vol = 0.5, delay = 0) {
    const c = this.ctx;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  hiss(dur, vol = 0.5, f0 = 2000, f1 = 200, delay = 0, q = 0.8) {
    const c = this.ctx;
    const t = c.currentTime + delay;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  play(name) {
    if (!this.enabled || !this.ctx) return;
    switch (name) {
      case 'laser': this.tone('square', 1400, 300, 0.12, 0.18); break;
      case 'bounce': this.tone('square', 900, 600, 0.05, 0.08); break;
      case 'spark': this.tone('triangle', 2200, 1800, 0.06, 0.2); break;
      case 'switch': this.tone('square', 500, 500, 0.05, 0.2); this.tone('square', 750, 750, 0.06, 0.2, 0.06); break;
      case 'door': this.hiss(0.35, 0.35, 900, 200, 0, 4); break;
      case 'deny': this.tone('sawtooth', 160, 120, 0.25, 0.25); break;
      case 'explode': this.hiss(0.9, 0.9, 1800, 60); this.tone('sine', 120, 30, 0.6, 0.6); break;
      case 'death': this.tone('sawtooth', 600, 60, 0.5, 0.25); this.hiss(0.3, 0.3, 3000, 400); break;
      case 'playerDeath': this.tone('square', 440, 40, 1.1, 0.3); this.hiss(0.5, 0.3, 2000, 100); break;
      case 'seal': this.tone('triangle', 500, 1000, 0.12, 0.3); this.tone('triangle', 1000, 1500, 0.12, 0.25, 0.1); break;
      case 'ventSpawn': this.hiss(0.4, 0.2, 400, 1500, 0, 6); break;
      case 'pickup': [660, 880, 1320].forEach((f, i) => this.tone('square', f, f, 0.07, 0.18, i * 0.07)); break;
      case 'secured': [523, 659, 784, 1046].forEach((f, i) => this.tone('triangle', f, f, 0.16, 0.3, i * 0.11)); break;
      case 'rescued': [784, 988, 1175, 1568].forEach((f, i) => this.tone('square', f, f, 0.08, 0.16, i * 0.08)); break;
      case 'tele': this.tone('sine', 300, 2400, 0.25, 0.3); this.tone('sine', 2400, 300, 0.25, 0.2, 0.05); break;
      case 'tshot': this.tone('sawtooth', 300, 120, 0.18, 0.22); break;
      case 'zap': this.hiss(0.2, 0.5, 6000, 3000, 0, 1); this.tone('sawtooth', 80, 60, 0.2, 0.3); break;
      case 'throw': this.hiss(0.15, 0.2, 3000, 800); break;
      case 'bombSet': this.tone('square', 200, 200, 0.06, 0.2); break;
      case 'tick': this.tone('square', 1200, 1200, 0.02, 0.1); break;
      case 'smother': this.tone('sine', 200, 80, 1.5, 0.4); break;
      case 'spotted': this.tone('triangle', 300, 600, 0.15, 0.15); break;
      case 'freeze': this.tone('sine', 1800, 200, 0.8, 0.3); break;
      case 'shield': this.tone('sine', 200, 900, 0.4, 0.3); break;
      case 'alarm': [0, 0.18, 0.36].forEach((d) => this.tone('square', 880, 660, 0.15, 0.2, d)); break;
      case 'cgenReveal': this.tone('sawtooth', 100, 900, 0.5, 0.3); break;
      case 'dive': this.tone('sine', 400, 100, 0.3, 0.2); break;
      case 'emerge': this.tone('sine', 100, 500, 0.25, 0.25); break;
      case 'type': this.tone('square', 1800 + Math.random() * 400, 1800, 0.02, 0.05); break;
      case 'granted': [440, 880].forEach((f, i) => this.tone('square', f, f, 0.12, 0.2, i * 0.12)); break;
      case 'dgenWake': this.tone('sawtooth', 50, 140, 1.4, 0.4); this.tone('sine', 900, 60, 1.4, 0.2); break;
      case 'dish': this.tone('sawtooth', 60, 2000, 1.2, 0.4); this.hiss(1.2, 0.6, 500, 6000); break;
      case 'floor': [392, 523, 659, 784, 1046].forEach((f, i) => this.tone('triangle', f, f * 1.01, 0.22, 0.25, i * 0.12)); break;
      case 'menu': this.tone('square', 900, 900, 0.03, 0.12); break;
      case 'gameover': [392, 330, 262, 196].forEach((f, i) => this.tone('triangle', f, f, 0.35, 0.3, i * 0.3)); break;
    }
  }
}
