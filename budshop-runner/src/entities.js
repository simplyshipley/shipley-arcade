/*
 * BUDSHOP RUNNER — entities.js: the collectible + hazard ROSTER as pure data.
 *
 * Pure data, NO DOM, NO logic. The core's spawner picks from this roster; the
 * shell draws each entry from its `art` block. Keeping the roster as data means
 * tuning, swapping, or extending the cast is a one-line edit — never a code change.
 *
 * UMD wrapper (pattern: top-goose/src/core.js): loads as window.BudEntities in a
 * browser and via require() in Node tests.
 *
 * Each entry is:
 *   {
 *     id:     string, unique slug
 *     kind:   'collectible' | 'hazard'
 *     lane:   'ground' | 'low' | 'high'   (where it sits relative to the runner)
 *     w, h:   number, sprite footprint in world px (the shell scales these)
 *     action: 'jump' | 'duck' | 'grab'    (the player input that clears/collects it)
 *     points: number   (collectibles only — score awarded on grab)
 *     combo:  bool      (collectibles only — does grabbing it bump the harvest combo?)
 *     weight: number    (relative spawn frequency within its pool)
 *     art:    { ... }   (flat-fill cel-cartoon hints for the shell renderer)
 *   }
 *
 * LANES & ACTIONS (the fair-gap contract the spawner enforces):
 *   - ground hazards  → action 'jump' (leap over). Live on the ground line.
 *   - low hazards     → action 'jump' (low enough that a jump clears them).
 *   - high hazards    → action 'duck' (swoop at head height; duck under them).
 *   - collectibles    → action 'grab' (touching collects; missing costs NOTHING).
 *
 * BRAND-SAFE DEFAULT: the shipped roster is genre-classic and storefront-safe
 * (pests, gnomes, crows, a comedic "the heat"). The original brainstorm floated
 * political-figure / thief hazards — those are NOT shipped. A commented stub at
 * the bottom shows how an owner can opt one in later; it is the owner's call.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    // Register under BOTH the natural name and the BR* name the shell consumes
    // (game.js reads root.BREntities). Dual-aliasing wires the parallel build
    // together without forcing either side to rename. See the seam note.
    root.BudEntities = root.BREntities = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Collectibles (good — grab for points; missing one is free) ──────────
  var COLLECTIBLES = [
    {
      id: 'bud',
      kind: 'collectible',
      lane: 'high',          // floats at jump height — leap to grab
      w: 30, h: 34,          // generous grab band (taller) so a normal jump
                             // reliably sweeps it on the way up/down
      action: 'grab',
      points: 50,
      combo: true,           // bumps the harvest combo ×1→×5
      weight: 7,
      art: {
        shape: 'bud',
        fill: '#5fae57',     // leafy green
        accent: '#7fce77',   // sugar-leaf highlight
        outline: '#1d1d28',
        sparkle: '#d7f5b8'
      }
    },
    {
      id: 'water-pail',
      kind: 'collectible',
      lane: 'low',           // waist/air height — hit to water a plant
      w: 30, h: 30,
      action: 'grab',
      points: 30,
      combo: false,          // streak bonus, does NOT bump the harvest combo
      weight: 3,
      art: {
        shape: 'pail',
        fill: '#5aa0d8',     // galvanized blue
        accent: '#9fd0f0',   // water shine
        outline: '#1d1d28',
        splash: '#cdeaf3'
      }
    }
  ];

  // ── Hazards (bad — collision ends the run) ──────────────────────────────
  var HAZARDS = [
    {
      id: 'gnome',
      kind: 'hazard',
      lane: 'ground',
      w: 34, h: 44,
      action: 'jump',
      weight: 4,
      art: {
        shape: 'gnome',
        fill: '#c0473e',     // red cap
        accent: '#e6cf9a',   // beard
        body: '#5f9450',     // green coat
        outline: '#1d1d28'
      }
    },
    {
      id: 'bucket',
      kind: 'hazard',
      lane: 'ground',
      w: 38, h: 30,
      action: 'jump',
      weight: 4,
      art: {
        shape: 'bucket',
        fill: '#9a9aa6',     // tipped-over tin
        accent: '#c8c8d2',
        outline: '#1d1d28'
      }
    },
    {
      id: 'sleepy-cat',
      kind: 'hazard',
      lane: 'ground',
      w: 46, h: 26,
      action: 'jump',
      weight: 3,
      art: {
        shape: 'cat',
        fill: '#e0a85a',     // ginger loaf
        accent: '#fff3e0',   // belly
        outline: '#1d1d28',
        zzz: '#9aa0b0'
      }
    },
    {
      id: 'pest-swarm',
      kind: 'hazard',
      lane: 'ground',
      w: 42, h: 34,
      action: 'jump',
      weight: 3,
      art: {
        shape: 'swarm',
        fill: '#4a5a3a',     // aphid/beetle cluster
        accent: '#7a8a5a',
        outline: '#1d1d28'
      }
    },
    {
      id: 'crow',
      kind: 'hazard',
      lane: 'high',
      w: 40, h: 30,
      action: 'duck',
      weight: 4,
      art: {
        shape: 'crow',
        fill: '#2b2b38',     // glossy black
        accent: '#4a4a5a',
        beak: '#e0b34c',
        outline: '#1d1d28'
      }
    },
    {
      id: 'banner',
      kind: 'hazard',
      lane: 'high',
      w: 56, h: 24,
      action: 'duck',
      weight: 3,
      art: {
        shape: 'banner',
        fill: '#c0473e',     // low clothesline / sale banner
        accent: '#f0e6c0',
        outline: '#1d1d28'
      }
    },
    {
      // "the heat" — comedic patrol siren at head height. Light, not graphic.
      // (A cruising patrol car can ALSO sit in the far backdrop as set
      // dressing; that is the shell's call. This entry is the dodgeable one.)
      id: 'the-heat',
      kind: 'hazard',
      lane: 'high',
      w: 48, h: 28,
      action: 'duck',
      weight: 2,
      art: {
        shape: 'siren',
        fill: '#3a6ad0',     // bubble-light blue
        accent: '#e04a4a',   // red flash
        outline: '#1d1d28'
      }
    }
  ];

  // ── Roster index helpers ────────────────────────────────────────────────
  var ALL = COLLECTIBLES.concat(HAZARDS);

  function byId(id) {
    for (var i = 0; i < ALL.length; i++) {
      if (ALL[i].id === id) return ALL[i];
    }
    return null;
  }

  // Entries filtered to a pool ('collectible' | 'hazard'), or the lane subset.
  function byKind(kind) {
    var out = [];
    for (var i = 0; i < ALL.length; i++) {
      if (ALL[i].kind === kind) out.push(ALL[i]);
    }
    return out;
  }
  function byLane(lane) {
    var out = [];
    for (var i = 0; i < ALL.length; i++) {
      if (ALL[i].lane === lane) out.push(ALL[i]);
    }
    return out;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  OPTIONAL / NOT SHIPPED — owner opt-in hazards (kept commented on purpose)
  // ════════════════════════════════════════════════════════════════════════
  // The original brainstorm listed "thieves / politicians / police" as enemies.
  // For a public commercial storefront demo we ship ONLY brand-safe hazards.
  // If the owner explicitly wants an edgier cast, push ONE of these into HAZARDS
  // (and add it to the spawn pool). This is intentionally inert by default.
  //
  // var OPTIONAL_HAZARDS = [
  //   {
  //     id: 'thief',
  //     kind: 'hazard',
  //     lane: 'ground',
  //     w: 36, h: 50,
  //     action: 'jump',
  //     weight: 2,
  //     art: { shape: 'thief', fill: '#3a3a44', accent: '#c0473e', outline: '#1d1d28' }
  //   }
  //   // A 'politician' caricature could go here as well — owner's call, NOT default.
  // ];

  return {
    COLLECTIBLES: COLLECTIBLES,
    HAZARDS: HAZARDS,
    ALL: ALL,
    byId: byId,
    byKind: byKind,
    byLane: byLane
  };
});
