/*
 * HOW BIRDS SEE THE WORLD — target roster (pure data, no DOM).
 *
 * The four homage park-goers PLUS the v2 city car. Each is ORIGINAL homage art
 * (loose cartoon style); the bullseye-on-targets GAG is the property, the
 * drawings are ours. Compiled here as pure data; the shell (game.js) renders
 * them and plays the reaction verbs.
 *
 * v2 changes (per V2-CONTRACT):
 *   - "smaller targets" ask: every park-goer radius shrinks ~30-40%
 *       bench-reader 30→20, briefcase-man 28→18, purse-lady 30→20,
 *       wiener-dog 22→14. Points bumped slightly to reward the harder aim.
 *   - a new `car` roster target: moving (drives city road lanes), bullseye on
 *     the roof/windshield, ~150 pts, golden = convertible (person inside).
 *     Verbs: flee (speed up) / spin (swerve) / speak ("HEY!").
 *
 * Reaction verbs the shell knows how to render:
 *   launch — fling an object (newspaper, briefcase papers) up/off
 *   hop    — startle-jump in place
 *   shake  — angry shake / fist / swat
 *   freeze — gasp + clutch, stop in place a beat
 *   flee   — bolt faster off the screen
 *   spin   — tail/body spin / swerve
 *   speak  — show a speech bubble (the `say` string)
 *
 * Each target carries a `first` reaction (the first time it's splatted) and
 * a `repeat` reaction (every splat after). Every verb in those lists must be
 * a member of VERBS. Loaded as window.Targets in the browser and via
 * require() in Node tests.
 *
 * IMPORTANT — roster scope: ROSTER is the PARK-GOER spawn pool ONLY (the four
 * pedestrians the vertical Spawner pulls from). The car is intentionally NOT
 * in ROSTER — cars are spawned by terrain.js along city road lanes, not by the
 * park-goer Spawner, and the seeded Spawner determinism depends on ROSTER
 * staying the four homage figures. The car is exported separately as CAR and
 * is reachable (with the four) via byId() and the ALL list.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Targets = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The closed verb set the shell renders. Roster reactions must use these.
  var VERBS = ['launch', 'hop', 'shake', 'freeze', 'flee', 'spin', 'speak'];

  // walk: how the figure tracks across the scrolling park.
  //   'idle'   — sits, only the world scroll carries it (bench)
  //   'stroll' — slow drift along its path
  //   'trot'   — quick movement, lowest/closest path (the dog)
  //   'drive'  — a car: moves along its own road lane, independent of scroll
  // path: a hint for the shell's lane placement (0 = near top of band …).
  var ROSTER = [
    {
      id: 'bench-reader',
      name: 'Bench Reader',
      desc: 'older man in a hat + tan coat on a park bench, newspaper spread; bullseye on his bald crown.',
      points: 110,
      rarity: 'common',
      radius: 20, // v2: shrunk 30→20 (harder aim)
      walk: 'idle',
      path: 'bench',
      golden: false,
      first: ['launch', 'hop'],
      repeat: ['hop'],
      say: 'Hrmph!',
    },
    {
      id: 'briefcase-man',
      name: 'Briefcase Man',
      desc: 'glum businessman, yellow short-sleeve shirt, tie, slacks, brown briefcase, glasses; head-down.',
      points: 110,
      rarity: 'common',
      radius: 18, // v2: shrunk 28→18
      walk: 'stroll',
      path: 'mid',
      golden: false,
      first: ['launch', 'shake', 'speak'],
      repeat: ['shake', 'speak'],
      say: 'GAH, not again.',
    },
    {
      id: 'purse-lady',
      name: 'Purse Lady',
      desc: 'heavyset woman, maroon dress, small black purse, curly grey hair; bullseye on her head.',
      points: 130,
      rarity: 'uncommon',
      radius: 20, // v2: shrunk 30→20
      walk: 'stroll',
      path: 'upper',
      golden: false,
      first: ['freeze', 'shake', 'speak'],
      repeat: ['shake', 'speak'],
      say: 'Why, I never!',
    },
    {
      id: 'wiener-dog',
      name: 'Wiener Dog',
      desc: 'long brown dachshund trotting; bullseye on its RUMP (the punchline).',
      points: 160,
      rarity: 'uncommon',
      radius: 14, // v2: shrunk 22→14
      walk: 'trot',
      path: 'low',
      golden: false,
      first: ['flee', 'spin'],
      repeat: ['spin'],
      say: 'Yip!',
      // GOLDEN variant: it was chasing a squirrel — pays a combo bonus.
      // The spawner flips this on randomly; scoreForDrop applies golden ×3.
      goldenVariant: true,
    },
  ];

  // ── v2 CAR (city-road target) ──────────────────────────────────────────
  // NOT a park-goer; NOT in ROSTER (keeps the Spawner bag deterministic). The
  // car drives along a city road lane at its own speed (terrain.js owns
  // spawning + motion). Bullseye sits on the roof/windshield. A skill shot:
  // you must lead a moving car. golden = convertible (person inside, top down).
  // It can flee (floor it), spin (swerve in its lane), or speak ("HEY!").
  var CAR = {
    id: 'car',
    name: 'City Car',
    desc: 'a boxy cartoon sedan rolling down a city road lane; bullseye on the roof. Golden = a red convertible with a driver yelling up at the sky.',
    points: 150,
    rarity: 'uncommon',
    radius: 22, // a touch bigger than a person — but it is MOVING, so still hard
    walk: 'drive',
    path: 'road',
    golden: false,
    first: ['spin', 'speak'],
    repeat: ['flee', 'speak'],
    say: 'HEY!',
    goldenVariant: true, // convertible
  };

  // Every authored target (park-goers + car) for lookups + roster-integrity.
  var ALL = ROSTER.concat([CAR]);

  // Lookup by id across ALL authored targets (park-goers + car).
  function byId(id) {
    for (var i = 0; i < ALL.length; i++) {
      if (ALL[i].id === id) return ALL[i];
    }
    return undefined;
  }

  return {
    VERBS: VERBS,
    ROSTER: ROSTER, // park-goer spawn pool ONLY (the four homage figures)
    CAR: CAR,
    ALL: ALL,       // park-goers + car (for byId / roster integrity)
    byId: byId,
  };
});
