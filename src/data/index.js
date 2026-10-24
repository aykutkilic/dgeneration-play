// All game content in one object for the simulation.
// Each floor file carries its own rooms, dialogs and terminal texts.
import { INTRO, ENDINGS, FLOOR_INTROS } from './text.js';
import f80 from './f80.js';
import f81 from './f81.js';
import f82 from './f82.js';
import f83 from './f83.js';
import f84 from './f84.js';
import f85 from './f85.js';
import f86 from './f86.js';
import f87 from './f87.js';
import f88 from './f88.js';
import f89 from './f89.js';

const FLOORS = [f80, f81, f82, f83, f84, f85, f86, f87, f88, f89];

// Like the original, the game reads the calendar: a tree appears on the landing on Christmas Day.
const today = new Date();
if (today.getMonth() === 11 && today.getDate() === 25) {
  const A = f80.rooms.A;
  A.map = A.map.slice();
  A.map[3] = '#........X.#';
  A.defs = { ...A.defs, X: { t: 'prop', kind: 'tree' } };
}

const floors = {};
const dialogs = {};
const terminals = {};
for (const f of FLOORS) {
  const intro = FLOOR_INTROS[f.n] || {};
  f.name = f.name || intro.name;
  f.intro = f.intro || intro.text;
  floors[f.n] = f;
  for (const [k, v] of Object.entries(f.dialogs || {})) {
    if (dialogs[k]) throw new Error(`duplicate dialog id ${k}`);
    dialogs[k] = v;
  }
  for (const [k, v] of Object.entries(f.terminals || {})) {
    if (terminals[k]) throw new Error(`duplicate terminal id ${k}`);
    terminals[k] = v;
  }
}

export const DATA = {
  firstFloor: 80,
  floors,
  dialogs,
  terminals,
  intro: INTRO,
  endings: ENDINGS,
};
