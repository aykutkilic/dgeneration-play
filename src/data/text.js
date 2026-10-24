// Story text. Written for this remake; it follows the premise of the 1991 game.

export const INTRO = [
  `Singapore, June 2021. You are a courier — the kind who flies a jetpack over borders with packages nobody wants opened.

At four in the morning a priority job came in: a sealed security package for Dr. Jean-Paul Derrida, head of research at Genoq Biolabs. Deliver in person. Do not open. Do not be late.`,
  `Derrida's last message, an hour old, was nothing but your job number repeated over and over.

You set down on the 80th-floor setback of the Genoq tower. The landing door slides shut behind you and locks. No receptionist. No guards. Just the hum of the building's security system — and something moving in the air ducts.`,
  `Genoq's sales brochure is still lying on the landing pad. It lists the company's "neogenetic" product line: four generations of engineered organisms, A through D.

You were told never to ask what's in the package. Deliver it to Derrida, on the top floor. Get anyone you can out along the way.`,
];

export const ENDINGS = {
  win: {
    title: 'Regeneration',
    pages: [
      `The microwave beam tears through the D/Generation. For a moment the room fills with every shape it ever wore — people, furniture, walls — and then nothing at all.

You strap on the jetpack and step off the roof into the morning air.`,
      `Below you the fighter-bomber banks away; whoever sent it has nothing left to bury.

Derrida's package is still sealed. The job is done — and Genoq, the only client who ever paid on time, no longer exists. You are, as of this morning, unemployed.

THE END`,
    ],
  },
  escape: {
    title: 'Something Walks Out',
    pages: [
      `You strap on the jetpack and drop off the roof. Behind you, the security doors slide open one after another, as if for an honoured guest.

Weeks later, a courier is seen in Paris, Helsinki, Lagos — always in a hurry, always carrying a package, never quite the same face twice.

The D/Generation got out. Maybe next time, finish it first.

THE END`,
    ],
  },
  bomber: {
    title: 'Twenty Minutes',
    pages: [
      `The bomber arrives on schedule. At 0614 local time the Genoq tower folds into its own footprint, taking the 80th through 90th floors and everything in them with it.

The evening news calls it a gas explosion. Genoq's share price barely moves.

GAME OVER`,
    ],
  },
};

export const FLOOR_INTROS = {
  80: { name: 'The Setback', text: `You are locked in on the 80th floor. Somewhere above you is Derrida.

Bump yellow wall triangles to work switches. Run over red vents to seal them. Find a way up to the gravity lift.` },
  81: { name: 'Personnel', text: `The lift drops you among the offices of Genoq's personnel department. Phones ring on empty desks.

B/Generations live here: fast blue cylinders that hide under the floor.` },
  82: { name: 'Security', text: `Floor 82 is the security wing. Half the doors here answer only to keys, and the trackers have been told everyone is an intruder.` },
  83: { name: 'Quarantine', text: `A short floor, sealed off in a hurry. The quarantine log on the wall stops in the middle of a sentence.

Not everyone you meet from here on is a person.` },
  84: { name: 'Laboratories', text: `The first of the labs. Glassware, cold rooms, specimen tanks — most of them empty, some of them broken from the inside.` },
  85: { name: 'Executive', text: `Thick carpet, real wood, a portrait of the company president in every corridor. The executives left in a hurry.` },
  86: { name: 'Maintenance', text: `Ducts, pumps and generators. The ventilation system that carried the Neogens through the building starts here.` },
  87: { name: 'Communications', text: `Floor 87 holds the building's antennas and satellite links — the only part of Genoq still talking to the outside world.` },
  88: { name: 'Research', text: `The research floor. Every door you open, someone seems to have opened before you.` },
  89: { name: 'Derrida', text: `The top floor. The lift doors open onto a white corridor and a voice from the ceiling:

"Visitors must surrender all equipment on arrival."` },
};
