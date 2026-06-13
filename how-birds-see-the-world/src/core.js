/*
 * HOW BIRDS SEE THE WORLD — pure game logic, no DOM.
 *
 * Loaded by the browser as window.HBCore and by Node tests via require().
 * Vertical-scroll poop game: birds see a bullseye on every park-goer; drop
 * closer to center to score more. Reuses the proven Bullseye Bombardier
 * shapes (scoreForDrop ring math, bird tiers, deterministic spawner) and
 * adapts the combo to the contract's window-decay rule.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      typeof require === 'function' ? require('./targets.js') : root.Targets
    );
  } else {
    root.HBCore = factory(root.Targets);
  }
})(typeof self !== 'undefined' ? self : this, function (Targets) {
  'use strict';

  // ── Bird progression (contract table — fly UP a scrolling park) ──────
  // Bigger bird = bigger splat radius (easier hits) + faster + more shake.
  var BIRDS = [
    { name: 'Sparrow',   emoji: '🐤',  minScore: 0,    splatRadius: 16, speed: 240, shake: 0  },
    { name: 'Pigeon',    emoji: '🐦',  minScore: 800,  splatRadius: 22, speed: 270, shake: 1  },
    { name: 'Gull',      emoji: '🕊️', minScore: 2000, splatRadius: 28, speed: 300, shake: 2  },
    { name: 'Hawk',      emoji: '🦅',  minScore: 4000, splatRadius: 36, speed: 350, shake: 4  },
    { name: 'The Goose', emoji: '🦆',  minScore: 7000, splatRadius: 48, speed: 390, shake: 12 },
  ];

  var RANKS = [
    { name: 'Fledgling',     min: 0    },
    { name: 'Branch Hopper', min: 1000 },
    { name: 'Sky Scrapper',  min: 2500 },
    { name: 'Park Menace',   min: 5000 },
    { name: 'Apex Pooper',   min: 8000 },
  ];

  function birdForScore(score) {
    var best = BIRDS[0];
    for (var i = 0; i < BIRDS.length; i++) {
      if (score >= BIRDS[i].minScore) best = BIRDS[i];
    }
    return best;
  }

  function rankForScore(score) {
    var best = RANKS[0];
    for (var i = 0; i < RANKS.length; i++) {
      if (score >= RANKS[i].min) best = RANKS[i];
    }
    return best;
  }

  // ── Drop scoring ────────────────────────────────────────────────────
  // Bullseye rings: inner third = 100, middle third = 50, outer (incl. the
  // splat-edge graze) = 25 — then scaled by the target's point value
  // (points / 100) and tripled for golden targets. splatRadius from the
  // current bird extends total reach beyond the target's own radius.
  function scoreForDrop(dist, targetRadius, splatRadius, golden, points) {
    var reach = targetRadius + splatRadius;
    if (dist > reach) return 0;
    var base;
    if (dist <= targetRadius / 3) base = 100;
    else if (dist <= (targetRadius * 2) / 3) base = 50;
    else base = 25;
    var scale = (points == null ? 100 : points) / 100;
    var value = base * scale;
    return golden ? value * 3 : value;
  }

  // ── Combo (window-decay) ────────────────────────────────────────────
  // Contract: combo ×1→×5 on consecutive hits within a 4s window; decays
  // ONLY while targets are on screen. Empty-field poops cost nothing and
  // never break the combo. The multiplier is the combo level itself,
  // capped at 5 (×1, ×2, ×3, ×4, ×5).
  var COMBO_WINDOW = 4;   // seconds to land the next hit before decay
  var COMBO_MAX = 5;

  function comboMultiplier(combo) {
    if (combo <= 1) return 1;
    return Math.min(combo, COMBO_MAX);
  }

  function ScoreKeeper() {
    this.score = 0;
    this.combo = 1;        // current multiplier level (1 = no streak yet)
    this.bestCombo = 1;
    this.window = COMBO_WINDOW; // time left in the current combo window
  }

  // A successful splat. `base` is the ring/value points (already scaled by
  // target value + golden). Bumps the combo level, refreshes the window,
  // banks base × multiplier. Returns the points awarded.
  ScoreKeeper.prototype.registerHit = function (base) {
    if (base <= 0) return 0;
    this.combo = Math.min(this.combo + 1, COMBO_MAX);
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    this.window = COMBO_WINDOW;
    var pts = Math.round(base * comboMultiplier(this.combo));
    this.score += pts;
    return pts;
  };

  // Tick the combo window. Decay (lose the streak) only happens while at
  // least one target is on screen — an empty field never breaks a combo.
  // Pass targetsOnScreen=true when ≥1 target is visible.
  ScoreKeeper.prototype.tick = function (dt, targetsOnScreen) {
    if (this.combo <= 1) return;
    if (!targetsOnScreen) return;
    this.window -= dt;
    if (this.window <= 0) {
      this.combo = 1;
      this.window = COMBO_WINDOW;
    }
  };

  // A whiff on a poop that COULD have hit (telegraphs nothing-special:
  // empty-field poops must not call this). Resets the streak immediately.
  ScoreKeeper.prototype.registerMiss = function () {
    this.combo = 1;
    this.window = COMBO_WINDOW;
  };

  ScoreKeeper.prototype.addBonus = function (pts) {
    this.score += Math.max(0, pts);
  };

  // ── Geometry helpers ────────────────────────────────────────────────
  function dist(x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function circlesOverlap(x1, y1, r1, x2, y2, r2) {
    return dist(x1, y1, x2, y2) <= r1 + r2;
  }

  // ── Splat resolution (scan ALL overlapping targets) ─────────────────
  // Given a splat at (x,y) with the current bird's splatRadius, scan EVERY
  // un-splatted target. Score each one it can reach; pick the single best
  // (highest points) so a wide splat over a crowd still resolves to one
  // honest hit. Returns { target, points, dist } or null if nothing reached.
  // `targets` items: { x, y, r (or radius), points, golden, splatted }.
  function resolveSplat(x, y, splatRadius, targets) {
    var best = null;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (!t || t.splatted) continue;
      var tr = (t.r != null ? t.r : t.radius);
      var d = dist(x, y, t.x, t.y);
      var pts = scoreForDrop(d, tr, splatRadius, !!t.golden, t.points);
      if (pts <= 0) continue;
      if (best === null || pts > best.points || (pts === best.points && d < best.dist)) {
        best = { target: t, points: pts, dist: d };
      }
    }
    return best;
  }

  // ── Seeded RNG (deterministic, testable spawns) ─────────────────────
  // Mulberry32: fast, well-distributed, fully reproducible from a seed.
  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Vertical spawner ────────────────────────────────────────────────
  // Park-goers spawn at the TOP and scroll DOWN at the world scroll speed,
  // exiting the bottom. Rarity weights the pick: common counts 2, uncommon
  // counts 1 (so commons are roughly twice as likely). Seeded → the spawn
  // order for a given seed is identical every run (testability lesson from
  // Bullseye). Targets pulled from the Targets roster.
  function buildWeightedBag(roster) {
    var bag = [];
    for (var i = 0; i < roster.length; i++) {
      var weight = roster[i].rarity === 'common' ? 2 : 1;
      for (var w = 0; w < weight; w++) bag.push(roster[i]);
    }
    return bag;
  }

  function Spawner(opts) {
    opts = opts || {};
    this.roster = opts.roster || (Targets && Targets.ROSTER) || [];
    this.bag = buildWeightedBag(this.roster);
    this.rng = makeRng(opts.seed == null ? 1 : opts.seed);
    this.worldWidth = opts.worldWidth || 540;
    this.scrollSpeed = opts.scrollSpeed || 90;   // px/sec the park scrolls down
    this.minGap = opts.minGap == null ? 0.7 : opts.minGap;  // sec between spawns
    this.maxGap = opts.maxGap == null ? 1.6 : opts.maxGap;
    this.goldenChance = opts.goldenChance == null ? 0.08 : opts.goldenChance;
    this.cooldown = this._gap();
    this._id = 0;
  }

  Spawner.prototype._gap = function () {
    return this.minGap + this.rng() * (this.maxGap - this.minGap);
  };

  // Pick the next roster entry from the weighted bag (deterministic).
  Spawner.prototype._pick = function () {
    if (this.bag.length === 0) return null;
    var idx = Math.floor(this.rng() * this.bag.length);
    if (idx >= this.bag.length) idx = this.bag.length - 1;
    return this.bag[idx];
  };

  // Spawn one target instance from a roster entry, positioned at the top.
  Spawner.prototype._spawn = function (def) {
    var golden = false;
    if (def.goldenVariant) golden = this.rng() < this.goldenChance;
    var margin = 60;
    var x = margin + this.rng() * (this.worldWidth - margin * 2);
    this._id += 1;
    return {
      id: 'tg-' + this._id,
      defId: def.id,
      name: def.name,
      x: x,
      y: -((def.radius != null ? def.radius : 24) + 10), // just above the top
      r: def.radius != null ? def.radius : 24,
      points: def.points,
      rarity: def.rarity,
      walk: def.walk,
      path: def.path,
      golden: golden,
      splatted: false,
      hitCount: 0,
      vy: this.scrollSpeed,
    };
  };

  // Advance the spawner by dt seconds; returns an array of newly spawned
  // target instances (possibly empty). Capacity gates the on-screen count
  // (6–9 target soft cap from the contract).
  Spawner.prototype.update = function (dt, onScreenCount, cap) {
    var spawned = [];
    cap = cap == null ? 9 : cap;
    this.cooldown -= dt;
    while (this.cooldown <= 0) {
      if ((onScreenCount + spawned.length) < cap) {
        var def = this._pick();
        if (def) spawned.push(this._spawn(def));
      }
      this.cooldown += this._gap();
    }
    return spawned;
  };

  // ── Health (v2 dodge stakes) ─────────────────────────────────────────
  // The bird has a small pool of hearts. A hazard collision (signs, poles,
  // rival birds — see hazards.js) costs ONE heart and grants a brief window
  // of invulnerability ("i-frames") so a single overlap can't drain the whole
  // pool in consecutive frames. Getting hit is its own punishment: it does
  // NOT touch score or combo (the ScoreKeeper is never told about a hit).
  //
  // Pooping — empty-field or otherwise — is NEVER punished by Health.
  //
  // Contract API:
  //   new Health({ hearts: 3, iframes: 1.4 })
  //   .hit()      → 'hit' | 'gameover' | 'shrugged'
  //                 'shrugged'  — currently invulnerable (i-frames), no damage
  //                 'hit'       — lost a heart, hearts remain, i-frames started
  //                 'gameover'  — lost the last heart, hearts == 0
  //   .update(dt) — ticks the i-frame timer down toward 0
  //   .invulnerable() → bool (true while i-frames are active)
  //   .alive()        → bool (hearts > 0)
  var DEFAULT_HEARTS = 3;
  var DEFAULT_IFRAMES = 1.4; // seconds of invulnerability after a hit

  function Health(opts) {
    opts = opts || {};
    this.maxHearts = opts.hearts == null ? DEFAULT_HEARTS : opts.hearts;
    this.hearts = this.maxHearts;
    this.iframes = opts.iframes == null ? DEFAULT_IFRAMES : opts.iframes;
    this.invuln = 0; // remaining i-frame time; > 0 means currently invulnerable
  }

  Health.prototype.invulnerable = function () {
    return this.invuln > 0;
  };

  Health.prototype.alive = function () {
    return this.hearts > 0;
  };

  // Tick the i-frame timer. Clamp at 0 so it never goes negative.
  Health.prototype.update = function (dt) {
    if (this.invuln > 0) {
      this.invuln -= dt;
      if (this.invuln < 0) this.invuln = 0;
    }
  };

  // Take a hit. Shrugs off damage during i-frames; otherwise drops a heart and
  // starts the i-frame window. Returns 'gameover' when the last heart is gone.
  Health.prototype.hit = function () {
    if (this.invuln > 0) return 'shrugged';
    if (this.hearts <= 0) return 'gameover'; // already dead — stay dead
    this.hearts -= 1;
    this.invuln = this.iframes;
    return this.hearts <= 0 ? 'gameover' : 'hit';
  };

  // ── Share text (emoji summary for COPY RESULT) ──────────────────────
  // A compact, paste-anywhere brag: title, score, best combo, best bird,
  // and the game URL. Keeps to the cartoon/emoji voice of the rank card.
  function shareText(result) {
    result = result || {};
    var score = result.score || 0;
    var bestCombo = result.bestCombo || 1;
    var bird = result.bird || birdForScore(score).name;
    var birdEmoji = result.birdEmoji || birdForScore(score).emoji;
    var rank = result.rank || rankForScore(score).name;
    var lines = [
      '🦅 HOW BIRDS SEE THE WORLD',
      '💩 ' + score + ' pts · ' + rank,
      birdEmoji + ' ' + bird + ' · 🔥 best combo x' + Math.min(bestCombo, COMBO_MAX),
      'Can you out-poop me?',
    ];
    return lines.join('\n');
  }

  return {
    BIRDS: BIRDS,
    RANKS: RANKS,
    COMBO_WINDOW: COMBO_WINDOW,
    COMBO_MAX: COMBO_MAX,
    birdForScore: birdForScore,
    rankForScore: rankForScore,
    scoreForDrop: scoreForDrop,
    comboMultiplier: comboMultiplier,
    ScoreKeeper: ScoreKeeper,
    dist: dist,
    circlesOverlap: circlesOverlap,
    resolveSplat: resolveSplat,
    makeRng: makeRng,
    buildWeightedBag: buildWeightedBag,
    Spawner: Spawner,
    Health: Health,
    shareText: shareText,
  };
});
