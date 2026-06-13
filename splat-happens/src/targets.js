/*
 * SPLAT HAPPENS — target roster. Pure data, no DOM, no logic.
 * Loaded by the browser as window.GameTargets and by Node tests via require().
 *
 * Compiled from the judged comedy roster with punch-up notes applied:
 *   - balloon-vendor reassigned uncommon → common (two-state discovery toy
 *     needs frequent spawns) → rarity mix is exactly 7 common / 3 uncommon /
 *     2 rare.
 *   - Goldens CUT for album budget (contract: first + golden ≈ 16-20):
 *     painter, icecream-kid, hotdog-vendor, dog-walker. 12 first + 8 golden
 *     = 20 album entries.
 *   - icecream-kid mom summon tightened 2.2s → 1.8s (arcade speed).
 *   - duck-mascot flee tightened 2.2s → 1.8s; theater-degree line lands
 *     AFTER the head launch.
 *   - living-statue first hit gains the world's smallest tip (one coin).
 *   - taichi-granny transform flips the visor backwards.
 *   - pigeon-kingpin chase speed 40 — MUST stay the strictly slowest chase
 *     in the game (the menacing shuffle is the joke).
 *   - mime repeat flee = invisible-rope yank offscreen, legs never moving.
 *
 * Format (docs/DESIGN-AND-CONTRACT.md):
 *   { id, name, sprite: {body, head, accent},   // palette keys + shape hints
 *     rarity, points, walk: {speed, pattern},
 *     first: [{verb, params, delay}], repeat: [...],
 *     golden: [...] | null,                     // rare variant worth 3x
 *     counter: null | 'umbrella'|'dodge'|'catch' }
 *
 * params are 'key:value,key:value' strings; speak params are
 * 'line:<text>' with the whole remainder as the line (lines may contain
 * commas). Parse with GameCore.parseParams(verb, params).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GameTargets = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TARGETS = [

    // ── COMMON (7) ──────────────────────────────────────────────────────

    {
      // Golden: face paint washes off — "I'm Kevin, actually." — keeps
      // miming anyway. Counter: a MIMED invisible umbrella that works.
      id: 'mime',
      name: 'The Quiet Man',
      sprite: {
        body: 'shirt-stripe-black-white',
        head: 'facepaint-white-beret-shadow',
        accent: 'beret-red'
      },
      rarity: 'common',
      points: 125,
      walk: { speed: 0, pattern: 'idle' },
      first: [
        { verb: 'freeze', params: 'pose:invisible-box', delay: 0 },
        { verb: 'shake', params: 'intensity:2', delay: 0.8 },
        { verb: 'speak', params: 'line:...', delay: 1.4 }
      ],
      repeat: [
        { verb: 'rage', params: '', delay: 0.2 },
        { verb: 'speak', params: 'line:Okay. WORDS. I have words.', delay: 0.7 },
        // Mimes pulling an invisible rope and YANKS himself offscreen,
        // legs never moving.
        { verb: 'flee', params: 'speed:80,dir:left,style:invisible-rope-yank', delay: 1.5 }
      ],
      golden: [
        { verb: 'transform', params: 'state:face-paint-gone', delay: 0 },
        { verb: 'speak', params: "line:I'm Kevin, actually.", delay: 0.8 },
        { verb: 'freeze', params: 'pose:invisible-box', delay: 1.6 }
      ],
      counter: 'umbrella'
    },

    {
      // First hit: declares the poop a masterpiece — gilt-framed splat
      // stays on the easel all round. Counter: SLIDES the easel under
      // your payload on purpose. Golden cut (album budget).
      id: 'painter',
      name: 'Vincent, Plein-Air Artist',
      sprite: {
        body: 'smock-sage-green',
        head: 'beret-plum-too-small',
        accent: 'easel-walnut-palette-rainbow'
      },
      rarity: 'common',
      points: 125,
      walk: { speed: 0, pattern: 'idle' },
      first: [
        { verb: 'freeze', params: 'pose:brush-raised', delay: 0 },
        { verb: 'speak', params: 'line:...actually, I love it.', delay: 0.8 },
        { verb: 'transform', params: 'state:splat-on-canvas,frame:gilt', delay: 1.4 },
        { verb: 'hop', params: 'height:15', delay: 2 }
      ],
      repeat: [
        { verb: 'rage', params: '', delay: 0 },
        { verb: 'launch', params: 'prop:paintbrushes,count:8', delay: 0.3 },
        { verb: 'splash', params: 'color:rainbow', delay: 0.6 },
        { verb: 'speak', params: "line:EVERYONE'S A CRITIC!", delay: 1.1 },
        { verb: 'chase', params: 'speed:170', delay: 1.7 }
      ],
      golden: null,
      counter: 'catch'
    },

    {
      // Two-act play: first hit summons Mom (persists all round); repeat
      // SHE chases while Petey rides her hip like a tiny artillery
      // spotter. Golden cut — the mom payoff is the whole bit.
      id: 'icecream-kid',
      name: 'Triple-Scoop Petey',
      sprite: {
        body: 'overalls-sky-blue',
        head: 'cap-propeller-cherry',
        accent: 'cone-waffle-triple-scoop-pastel'
      },
      rarity: 'common',
      points: 100,
      walk: { speed: 25, pattern: 'stroll' },
      first: [
        { verb: 'freeze', params: 'pose:staring-at-cone', delay: 0 },
        { verb: 'launch', params: 'prop:ice-cream-scoops,count:3', delay: 0.5 },
        { verb: 'shake', params: 'intensity:2', delay: 1 },
        { verb: 'speak', params: 'line:MOOOOM!', delay: 1.5 },
        { verb: 'summon', params: 'thing:mom,persist:round', delay: 1.8 }
      ],
      repeat: [
        { verb: 'hop', params: 'height:15', delay: 0 },
        { verb: 'speak', params: "line:THAT'S THE ONE, MOM!", delay: 0.4 },
        { verb: 'chase', params: 'speed:150,actor:mom,rider:petey-on-hip', delay: 1 },
        { verb: 'speak', params: 'line:You are in TIMEOUT, bird.', delay: 1.8 }
      ],
      golden: null,
      counter: null
    },

    {
      // Accumulating petting zoo: wiener dog, then seagull. Sal hands
      // out napkins mid-catastrophe. Golden trimmed (album budget) —
      // pigeons stay exclusive to Old Man Crumbs anyway.
      id: 'hotdog-vendor',
      name: "Sal of Sal's Dogs",
      sprite: {
        body: 'apron-white-cart-chrome',
        head: 'hat-paper-white-mustache-umber',
        accent: 'steam-puff-mustard-yellow'
      },
      rarity: 'common',
      points: 125,
      walk: { speed: 35, pattern: 'patrol' },
      first: [
        { verb: 'hop', params: 'height:25', delay: 0 },
        { verb: 'launch', params: 'prop:hotdogs,count:6', delay: 0.2 },
        { verb: 'speak', params: 'line:My dogs! My beautiful dogs!', delay: 0.7 },
        { verb: 'summon', params: 'thing:wiener-dog,persist:round', delay: 1.5 }
      ],
      repeat: [
        { verb: 'rage', params: '', delay: 0 },
        { verb: 'launch', params: 'prop:mustard-bottles,count:3', delay: 0.3 },
        { verb: 'splash', params: 'color:yellow', delay: 0.5 },
        { verb: 'speak', params: 'line:EVERYTHING IS A TOPPING NOW.', delay: 1 },
        { verb: 'summon', params: 'thing:seagull,persist:round', delay: 1.6 }
      ],
      golden: null,
      counter: null
    },

    {
      // Walker becomes cargo: cocooned in leashes for the round, then
      // belly-sledded behind the dogs deadpanning her regret. Golden
      // cut — the sled IS the gag.
      id: 'dog-walker',
      name: 'Deb, Walker of the Five Hounds',
      sprite: {
        body: 'windbreaker-coral',
        head: 'hair-ponytail-umber',
        accent: 'leashes-taut-five-fan'
      },
      rarity: 'common',
      points: 150,
      walk: { speed: 70, pattern: 'jog' },
      first: [
        { verb: 'slip', params: '', delay: 0 },
        { verb: 'launch', params: 'prop:leashes,count:5', delay: 0.3 },
        { verb: 'transform', params: 'state:tangled', delay: 0.8 },
        { verb: 'speak', params: 'line:Heel! HEEL! ANYONE?!', delay: 1.3 }
      ],
      repeat: [
        // Deb fully horizontal, dragged behind the dogs like a sled.
        { verb: 'chase', params: 'speed:240,style:belly-sled', delay: 0 },
        { verb: 'speak', params: 'line:I regret everything.', delay: 0.8 },
        { verb: 'spin', params: 'turns:2', delay: 1.4 }
      ],
      golden: null,
      counter: null
    },

    {
      // Roster-level inversion: the only target who WANTS it. Joy hop
      // (arms up, heels click) must read in one frame at 60px. Her chase
      // is field work — she snaps camera-flash splashes in pursuit.
      id: 'birdwatcher',
      name: 'Binocular Bonnie',
      sprite: {
        body: 'vest-khaki-pockets',
        head: 'binoculars-black-half-face',
        accent: 'journal-moss-neck-string'
      },
      rarity: 'common',
      points: 100,
      walk: { speed: 22, pattern: 'stroll' },
      first: [
        { verb: 'freeze', params: 'pose:binoculars-up', delay: 0 },
        { verb: 'hop', params: 'height:35,style:joy-arms-up-heel-click', delay: 0.5 },
        { verb: 'speak', params: 'line:Confirmed sighting!', delay: 0.8 },
        { verb: 'launch', params: 'prop:journal-pages,count:3', delay: 1.2 }
      ],
      repeat: [
        { verb: 'speak', params: 'line:Same bird. Bold behavior.', delay: 0.4 },
        { verb: 'chase', params: 'speed:55,style:scientific-pursuit', delay: 1 },
        { verb: 'splash', params: 'color:white,style:camera-flash', delay: 1.6 }
      ],
      golden: [
        { verb: 'splash', params: 'color:white,style:camera-flash', delay: 0 },
        { verb: 'speak', params: 'line:Nat Geo, call me.', delay: 0.8 }
      ],
      counter: null
    },

    {
      // REASSIGNED uncommon → common: the two-state mechanic (ground hit
      // → airborne drift → air hit → 'Mommy.' → drop) needs frequent
      // spawns to be discovered. Ground shadow stays visible so he stays
      // targetable aloft. Golden Coyote freeze beat is mandatory —
      // gravity politely waits.
      id: 'balloon-vendor',
      name: 'Up-Top Mort the Balloon Vendor',
      sprite: {
        body: 'vest-stripe-candy-red',
        head: 'cap-flat-slate',
        accent: 'balloons-dozen-rainbow-cluster'
      },
      rarity: 'common',
      points: 150,
      walk: { speed: 28, pattern: 'stroll' },
      first: [
        { verb: 'hop', params: 'height:40', delay: 0 },
        { verb: 'launch', params: 'prop:balloons,count:8', delay: 0.2 },
        { verb: 'speak', params: 'line:My profit margin!', delay: 0.6 },
        { verb: 'transform', params: 'state:airborne,shadow:visible', delay: 1.2 }
      ],
      repeat: [
        { verb: 'splash', params: 'color:confetti', delay: 0 },
        { verb: 'launch', params: 'prop:balloon-scraps,count:4', delay: 0.2 },
        { verb: 'speak', params: 'line:Mommy.', delay: 0.7 },
        { verb: 'faint', params: '', delay: 1.2 }
      ],
      golden: [
        { verb: 'splash', params: 'color:confetti,count:12', delay: 0 },
        // One full Coyote beat — hangs in empty air, THEN drops.
        { verb: 'freeze', params: 'pose:midair,beat:coyote', delay: 0.3 },
        { verb: 'speak', params: 'line:Uh oh.', delay: 1.1 },
        { verb: 'faint', params: '', delay: 1.9 }
      ],
      counter: null
    },

    // ── UNCOMMON (3) ────────────────────────────────────────────────────

    {
      // Bird poops on fake bird. Repeat decapitates the costume into
      // persistent headless-Gary: tiny sad human head, huge duck body.
      // The theater-degree line lands AFTER the head launch, deadpan.
      id: 'duck-mascot',
      name: 'Gary the Park Duck',
      sprite: {
        body: 'foam-duck-lemon-yellow',
        head: 'duck-head-lemon-beak-tangerine',
        accent: 'human-head-tiny-sweaty'
      },
      rarity: 'uncommon',
      points: 200,
      walk: { speed: 30, pattern: 'stroll' },
      first: [
        { verb: 'freeze', params: 'pose:mid-wave', delay: 0 },
        { verb: 'speak', params: "line:I'm one of you!", delay: 0.6 },
        { verb: 'shake', params: 'intensity:3', delay: 1.2 },
        { verb: 'hop', params: 'height:25', delay: 1.5 }
      ],
      repeat: [
        { verb: 'spin', params: 'turns:2', delay: 0 },
        { verb: 'launch', params: 'prop:mascot-head,count:1', delay: 0.4 },
        { verb: 'transform', params: 'state:headless-gary', delay: 0.8 },
        { verb: 'speak', params: 'line:I have a theater degree.', delay: 1.4 },
        { verb: 'flee', params: 'speed:150,dir:left', delay: 1.8 }
      ],
      golden: [
        // Square on the foam beak — Gary stays in character.
        { verb: 'freeze', params: 'pose:in-character', delay: 0 },
        { verb: 'speak', params: 'line:Quack.', delay: 0.7 },
        { verb: 'hop', params: 'height:10', delay: 1.4 }
      ],
      goldenName: 'Method Actor',
      counter: null
    },

    {
      // First hit: tanked with one eye-twitch, a ventriloquist threat,
      // and the world's smallest tip. Repeat: the statue comes ALIVE —
      // bronze cracks, coins erupt, four hours of stillness exits at once.
      id: 'living-statue',
      name: 'The Bronze General',
      sprite: {
        body: 'bronze-patina-green',
        head: 'bronze-cap-officer',
        accent: 'crate-milk-red-tip-hat-coins'
      },
      rarity: 'uncommon',
      points: 250,
      walk: { speed: 0, pattern: 'idle' },
      first: [
        { verb: 'freeze', params: 'pose:salute', delay: 0 },
        { verb: 'shake', params: 'intensity:1', delay: 1 },
        { verb: 'speak', params: 'line:...statues feel pain, kid.', delay: 2 },
        // The world's smallest tip.
        { verb: 'launch', params: 'prop:coins,count:1', delay: 2.6 }
      ],
      repeat: [
        { verb: 'transform', params: 'state:alive,style:bronze-cracks-off', delay: 0 },
        { verb: 'rage', params: '', delay: 0.4 },
        { verb: 'launch', params: 'prop:coins,count:12', delay: 0.7 },
        { verb: 'chase', params: 'speed:200', delay: 1.2 },
        { verb: 'speak', params: 'line:FOUR HOURS OF STILLNESS!', delay: 1.6 }
      ],
      golden: [
        // Gilded head to toe — he poses HARDER, gold for the round.
        { verb: 'transform', params: 'state:gilded', delay: 0 },
        { verb: 'freeze', params: 'pose:salute-harder', delay: 0.4 },
        { verb: 'speak', params: 'line:Finally. The bronze I deserve.', delay: 1 }
      ],
      counter: null
    },

    {
      // Slowest thing on screen hides the fastest chase in the game.
      // Dodge renders as Matrix slow-motion leans, eyes closed. Visor
      // flips backwards on transform — it's on now.
      id: 'taichi-granny',
      name: 'Granny Osprey',
      sprite: {
        body: 'tracksuit-jade-stripe',
        head: 'visor-white-sunglasses-oversize',
        accent: 'sneakers-blaze-orange'
      },
      rarity: 'uncommon',
      points: 250,
      walk: { speed: 0, pattern: 'idle' },
      first: [
        { verb: 'freeze', params: 'pose:crane-stance', delay: 0 },
        { verb: 'speak', params: 'line:Sloppy. No follow-through.', delay: 0.7 },
        { verb: 'shake', params: 'intensity:2', delay: 1.4 },
        { verb: 'hop', params: 'height:30', delay: 1.8 }
      ],
      repeat: [
        { verb: 'transform', params: 'state:tracksuit-mode,visor:backwards', delay: 0 },
        { verb: 'chase', params: 'speed:260', delay: 0.4 },
        { verb: 'speak', params: 'line:I raised six kids, bird.', delay: 1 }
      ],
      golden: [
        // Catches it mid-flow without opening her eyes, sets it on the
        // grass, resumes the form. An anti-reaction.
        { verb: 'freeze', params: 'pose:catch-mid-flow,eyes:closed', delay: 0 },
        { verb: 'speak', params: 'line:Not today.', delay: 1 }
      ],
      counter: 'dodge'
    },

    // ── RARE (2) ────────────────────────────────────────────────────────

    {
      // 'You poop on FAMILY?' — strongest first-hit line in 39 candidates.
      // His chase MUST remain the strictly slowest in the game: the
      // menacing shuffle is the joke. Pre-summon tell: shoulder pigeons
      // rotate their heads in unison to glare at the bird.
      id: 'pigeon-kingpin',
      name: 'Old Man Crumbs',
      sprite: {
        body: 'coat-bench-ash-seed-dust',
        head: 'hat-felt-brown-pigeon-perch',
        accent: 'pigeons-slate-shoulder-pair'
      },
      rarity: 'rare',
      points: 400,
      walk: { speed: 18, pattern: 'stroll' },
      first: [
        { verb: 'freeze', params: 'pose:seed-mid-toss', delay: 0 },
        { verb: 'speak', params: 'line:You poop on FAMILY?', delay: 0.6 },
        { verb: 'summon', params: 'thing:pigeon-mob,tell:shoulder-pigeons-head-turn', delay: 1.2 },
        { verb: 'shake', params: 'intensity:3', delay: 1.8 }
      ],
      repeat: [
        { verb: 'rage', params: '', delay: 0 },
        { verb: 'speak', params: 'line:THE SKY BELONGS TO US.', delay: 0.5 },
        { verb: 'summon', params: 'thing:pigeon-mob,tell:shoulder-pigeons-head-turn', delay: 1 },
        { verb: 'chase', params: 'speed:40,style:menacing-shuffle', delay: 1.5 },
        { verb: 'launch', params: 'prop:breadcrumbs,count:20', delay: 2 }
      ],
      golden: [
        // His pigeons defect to perch on your splat admiringly.
        { verb: 'summon', params: 'thing:admiring-pigeons', delay: 0 },
        { verb: 'speak', params: 'line:Traitors. All of you.', delay: 0.8 },
        { verb: 'freeze', params: 'pose:gasp', delay: 1.6 }
      ],
      counter: null
    },

    {
      // Each hit drags more wedding into the park until the ceremony
      // happens mid-chase. Groom trips, sacrifices his body, CATCHES the
      // cake. The white gown accumulates persistent splat marks.
      id: 'runaway-bride',
      name: 'Donna, Late for the Wedding',
      sprite: {
        body: 'gown-white-splat-stains-persist',
        head: 'veil-white-streaming',
        accent: 'heels-blush-carried-fist'
      },
      rarity: 'rare',
      points: 500,
      walk: { speed: 85, pattern: 'jog' },
      first: [
        { verb: 'freeze', params: 'pose:mid-sprint', delay: 0 },
        { verb: 'speak', params: 'line:Not. The. Dress.', delay: 0.7 },
        { verb: 'launch', params: 'prop:bouquet,count:1', delay: 1.2 },
        { verb: 'summon', params: 'thing:flower-girl,persist:round', delay: 1.8 },
        { verb: 'shake', params: 'intensity:5', delay: 2.2 }
      ],
      repeat: [
        { verb: 'rage', params: '', delay: 0 },
        { verb: 'speak', params: "line:WEDDING'S HERE NOW. SIT.", delay: 0.5 },
        { verb: 'summon', params: 'thing:groom-with-cake,gag:trip-and-catch-cake', delay: 1 },
        { verb: 'transform', params: 'state:veil-warpaint', delay: 1.6 },
        { verb: 'chase', params: 'speed:230', delay: 2 }
      ],
      golden: [
        // Counts as 'something borrowed' — she laughs and dips the groom;
        // the flower girl blasts the sky with petals.
        { verb: 'speak', params: 'line:Something borrowed!', delay: 0 },
        { verb: 'spin', params: 'turns:1,style:dip-the-groom', delay: 0.7 },
        { verb: 'splash', params: 'color:confetti,style:petal-blast', delay: 1.4 }
      ],
      counter: null
    }
  ];

  function byId(id) {
    for (var i = 0; i < TARGETS.length; i++) {
      if (TARGETS[i].id === id) return TARGETS[i];
    }
    return null;
  }

  // Album entries = one 'first' per target + one 'golden' per target that
  // defines a golden variant. Contract budget: 16-20.
  var ALBUM_TOTAL = (function () {
    var n = 0;
    for (var i = 0; i < TARGETS.length; i++) {
      n += 1;
      if (TARGETS[i].golden) n += 1;
    }
    return n;
  })();

  return {
    TARGETS: TARGETS,
    byId: byId,
    ALBUM_TOTAL: ALBUM_TOTAL
  };
});
