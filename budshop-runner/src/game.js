/*
 * BUDSHOP RUNNER — canvas shell. Renders the cel-cartoon bud-farm/town,
 * routes input, drives screens, the HUD, the share card, and the particle
 * gags. ALL game rules live in src/core.js (window.BudCore) + src/entities.js
 * (window.BudEntities) — this file only renders the core's state and feeds it
 * input. It NEVER re-derives physics, scoring, collision, or spawn math.
 *
 * Loaded by the browser after core.js + entities.js, then touch-controls.js.
 * Exposes window.__BUDRUN for the headless vm test harness (test/shell.test.js).
 *
 * Style: vanilla ES5, no build step, no dependencies. Browser globals
 * (BudCore / BudEntities), but written defensively so the vm harness can boot
 * it with stubbed window/document/canvas. If the logic core has not loaded yet
 * (parallel build / standalone test), a tiny inline FALLBACK mirrors the
 * pinned seam EXACTLY (same globals, methods, fields, units) so the shell
 * still boots and the shell test runs standalone — the fallback is the seam
 * contract restated, not a second implementation.
 *
 * THE SEAM the shell consumes (mirrored from core.js's header):
 *   Core.GROUND_Y / RUNNER_X / RUNNER_W / RUNNER_H / DUCK_H        (config)
 *   Core.speedAt(distance) / Core.formatDistance(distance)         (ramp + fmt)
 *   new Core.Runner({x}); runner.update(dt, {jump, duck}); .hurtbox()
 *     runner fields: x, y (height above ground), vy, grounded, ducking, h, fullH
 *   new Core.ScoreKeeper(); .travel(px) .harvestBud() .waterPlant() .tick(dt)
 *     fields: score, buds, combo, bestCombo, window, distance
 *   new Core.Spawner(seed, ents); .pump(distanceTravelled, speed) → [records]
 *     record: { ref, id, kind, lane, action, w, h, points, dist, collected, scored }
 *   Core.collides(runner, ent)  (ent carries .dist ahead of runner)
 *   Core.updateBest(result, prior) / Core.BEST_KEYS / Core.shareText(result)
 *
 * Art: Scooby-Doo x Bob's-Burgers cel-cartoon — flat fills, 3px #1d1d28
 * outlines, big expressive characters, squash-stretch.
 */
(function (root) {
  'use strict';

  // ════════════════════════════════════════════════════════════════════
  //  FALLBACK LOGIC CORE — mirrors window.BudCore EXACTLY. Used ONLY when
  //  the real src/core.js has not defined window.BudCore (parallel build /
  //  standalone shell test). Same globals, method names, field names, units.
  // ════════════════════════════════════════════════════════════════════
  function buildFallbackCore() {
    var GROUND_Y = 300, RUNNER_X = 130;
    var GRAVITY = 2400, JUMP_VELOCITY = 620, MAX_HOLD = 0.20, HOLD_LIFT = 1150;
    var RUNNER_W = 40, RUNNER_H = 64, DUCK_H = 38, HURT_FRAC = 0.70;
    var SPEED_BASE = 240, SPEED_GAIN = 0.012, SPEED_MAX = 560;
    var COMBO_WINDOW = 4.5, COMBO_MAX = 5, BUD_BASE = 50, WATER_BONUS = 60, DIST_POINTS = 0.1;
    var REACTION_TIME = 0.42, GAP_SLACK = 36, SPAWN_AHEAD = 900;
    var BEST_KEYS = { dist: 'budshop.runner.bestDist', score: 'budshop.runner.bestScore' };

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function lerp(a, b, t) { return a + (b - a) * t; }
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
    function speedAt(distance) { return Math.min(SPEED_MAX, SPEED_BASE + (distance > 0 ? distance : 0) * SPEED_GAIN); }
    function jumpAirtime() { return (2 * JUMP_VELOCITY) / GRAVITY; }
    function minReactionDist(speed) { return (REACTION_TIME + jumpAirtime()) * speed + GAP_SLACK; }

    function Runner(opts) {
      opts = opts || {};
      this.x = opts.x == null ? RUNNER_X : opts.x;
      this.y = 0; this.vy = 0; this.grounded = true; this.ducking = false;
      this.w = RUNNER_W; this.fullH = RUNNER_H; this.h = RUNNER_H;
      this._holdTime = 0; this._jumpLatch = false;
    }
    Runner.prototype.update = function (dt, input) {
      input = input || {};
      var jump = !!input.jump, duck = !!input.duck;
      if (jump && this.grounded && !this._jumpLatch) {
        this.vy = JUMP_VELOCITY; this.grounded = false; this.ducking = false;
        this._holdTime = 0; this._jumpLatch = true;
      }
      if (!jump) this._jumpLatch = false;
      if (!this.grounded) {
        if (jump && this.vy > 0 && this._holdTime < MAX_HOLD) { this.vy += HOLD_LIFT * dt; this._holdTime += dt; }
        // no jump-cut: minimum jump baked into JUMP_VELOCITY (mirrors core.js)
        this.vy -= GRAVITY * dt;
        this.y += this.vy * dt;
        if (this.y <= 0) { this.y = 0; this.vy = 0; this.grounded = true; }
        this.ducking = false;
      } else {
        this.ducking = duck;
      }
      this.h = this.ducking ? DUCK_H : RUNNER_H;
    };
    Runner.prototype.hurtbox = function () {
      var hw = this.w * HURT_FRAC, hh = this.h * HURT_FRAC;
      return { x: this.x + (this.w - hw) / 2, y: this.y, w: hw, h: hh };
    };

    function laneBottom(lane, kind) {
      if (lane === 'high') return kind === "collectible" ? 78 : 30;
      if (lane === 'low') return 18;
      return 0;
    }
    function entityBox(ent, runnerX) {
      return { x: (runnerX == null ? RUNNER_X : runnerX) + ent.dist, y: laneBottom(ent.lane, ent.kind), w: ent.w, h: ent.h };
    }
    function aabb(a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }
    function collides(runner, ent) { return aabb(runner.hurtbox(), entityBox(ent, runner.x)); }
    var MAGNET_DX = 52, MAGNET_MIN_Y = 18;
    function magnetReaches(runner, ent) {
      if (!ent || ent.kind !== 'collectible' || ent.collected) return false;
      if (runner.grounded || runner.y < MAGNET_MIN_Y) return false;
      return Math.abs(ent.dist + (ent.w || 0) / 2) <= MAGNET_DX;
    }

    function comboMultiplier(combo) { return combo <= 1 ? 1 : Math.min(combo, COMBO_MAX); }
    function ScoreKeeper() {
      this.score = 0; this.buds = 0; this.combo = 1; this.bestCombo = 1;
      this.window = COMBO_WINDOW; this.distance = 0;
    }
    ScoreKeeper.prototype.travel = function (deltaDist) {
      if (deltaDist <= 0) return;
      this.distance += deltaDist; this.score += deltaDist * DIST_POINTS;
    };
    ScoreKeeper.prototype.harvestBud = function () {
      this.buds += 1; this.combo = Math.min(this.combo + 1, COMBO_MAX);
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      this.window = COMBO_WINDOW;
      var pts = Math.round(BUD_BASE * comboMultiplier(this.combo));
      this.score += pts; return pts;
    };
    ScoreKeeper.prototype.waterPlant = function () { this.score += WATER_BONUS; return WATER_BONUS; };
    ScoreKeeper.prototype.tick = function (dt) {
      if (this.combo <= 1) return;
      this.window -= dt;
      if (this.window <= 0) { this.combo = 1; this.window = COMBO_WINDOW; }
    };

    function Spawner(seed, ents) {
      this.rng = makeRng(seed == null ? 1 : seed);
      this.ents = ents;
      this.headDist = SPAWN_AHEAD; this.lastHazardAt = -Infinity; this.totalDist = SPAWN_AHEAD;
      this._hazards = (ents && ents.byKind) ? ents.byKind('hazard') : ((ents && ents.HAZARDS) || []);
      this._collects = (ents && ents.byKind) ? ents.byKind('collectible') : ((ents && ents.COLLECTIBLES) || []);
    }
    Spawner.prototype._pick = function (pool) {
      if (!pool || pool.length === 0) return null;
      var total = 0, i;
      for (i = 0; i < pool.length; i++) total += (pool[i].weight || 1);
      var r = this.rng() * total;
      for (i = 0; i < pool.length; i++) { r -= (pool[i].weight || 1); if (r <= 0) return pool[i]; }
      return pool[pool.length - 1];
    };
    Spawner.prototype._make = function (ref, atDist) {
      return { ref: ref, id: ref.id, kind: ref.kind, lane: ref.lane, action: ref.action,
        w: ref.w, h: ref.h, points: ref.points || 0, dist: atDist, collected: false, scored: false };
    };
    Spawner.prototype._next = function (speed) {
      if (this.rng() < 0.58) {   // mirrors core: bud-rich, hazards spaced fairly
        var cRef = this._pick(this._collects);
        this.totalDist += lerp(180, 320, this.rng());
        return cRef ? this._make(cRef, this.totalDist) : null;
      }
      var hRef = this._pick(this._hazards);
      if (!hRef) return null;
      var minGap = minReactionDist(speed), extra = lerp(140, 380, this.rng());
      var candidate = this.totalDist + minGap + extra;
      var floor = this.lastHazardAt + minGap;
      if (candidate < floor) candidate = floor + extra;
      this.totalDist = candidate; this.lastHazardAt = candidate;
      return this._make(hRef, candidate);
    };
    Spawner.prototype.pump = function (distanceTravelled, speed) {
      var out = [], sp = speed == null ? speedAt(distanceTravelled) : speed;
      var frontier = distanceTravelled + SPAWN_AHEAD, guard = 0;
      while (this.totalDist < frontier && guard < 64) {
        var ent = this._next(sp);
        if (ent) { ent.dist = ent.dist - distanceTravelled; if (ent.dist < 0) ent.dist = 0; out.push(ent); }
        guard++;
      }
      return out;
    };

    function updateBest(result, prior) {
      result = result || {}; prior = prior || {};
      var dist = Math.max(0, Math.round(result.distance || 0));
      var score = Math.max(0, Math.round(result.score || 0));
      var pDist = Math.max(0, Math.round(prior.distance || 0));
      var pScore = Math.max(0, Math.round(prior.score || 0));
      return { distance: Math.max(dist, pDist), score: Math.max(score, pScore),
        newBestDistance: dist > pDist, newBestScore: score > pScore };
    }
    function formatDistance(distance) { return Math.max(0, Math.round((distance || 0) / 10)) + 'm'; }
    var RANKS = [
      { name: 'Seedling', min: 0 }, { name: 'Trimmer', min: 800 }, { name: 'Budtender', min: 2000 },
      { name: 'Head Grower', min: 4500 }, { name: 'Top Shelf', min: 8000 }
    ];
    function rankForScore(score) {
      var best = RANKS[0];
      for (var i = 0; i < RANKS.length; i++) if (score >= RANKS[i].min) best = RANKS[i];
      return best;
    }
    function shareText(result) {
      result = result || {};
      var lines = ['🌿 BUDSHOP RUNNER'];
      if (result.score != null) lines.push('🏆 ' + Math.round(result.score) + ' pts · ' + (result.rank || rankForScore(Math.round(result.score)).name));
      if (result.distance != null) lines.push('🏃 ' + formatDistance(result.distance) + ' run');
      if (result.buds != null) lines.push('🌱 ' + result.buds + ' buds harvested');
      if (result.bestCombo != null && result.bestCombo > 1) lines.push('🔥 best harvest combo ×' + Math.min(result.bestCombo, COMBO_MAX));
      lines.push('Can you out-run the heat? onlinebudshop.com');
      return lines.join('\n');
    }

    return {
      GROUND_Y: GROUND_Y, RUNNER_X: RUNNER_X,
      RUNNER_W: RUNNER_W, RUNNER_H: RUNNER_H, DUCK_H: DUCK_H, HURT_FRAC: HURT_FRAC,
      SPEED_BASE: SPEED_BASE, SPEED_MAX: SPEED_MAX, COMBO_WINDOW: COMBO_WINDOW, COMBO_MAX: COMBO_MAX,
      BEST_KEYS: BEST_KEYS, RANKS: RANKS,
      clamp: clamp, lerp: lerp, makeRng: makeRng,
      speedAt: speedAt, jumpAirtime: jumpAirtime, minReactionDist: minReactionDist,
      Runner: Runner, entityBox: entityBox, aabb: aabb, collides: collides, laneBottom: laneBottom,
      magnetReaches: magnetReaches, MAGNET_DX: MAGNET_DX, MAGNET_MIN_Y: MAGNET_MIN_Y,
      comboMultiplier: comboMultiplier, ScoreKeeper: ScoreKeeper, Spawner: Spawner,
      updateBest: updateBest, formatDistance: formatDistance, rankForScore: rankForScore, shareText: shareText
    };
  }

  // Tiny brand-safe fallback roster (mirrors window.BudEntities). Used only if
  // entities.js has not loaded. The real roster lives in src/entities.js.
  function buildFallbackEntities() {
    var COLLECTIBLES = [
      { id: 'bud', kind: 'collectible', lane: 'high', w: 30, h: 34, action: 'grab', points: 50, combo: true, weight: 7,
        art: { shape: 'bud', fill: '#5fae57', accent: '#7fce77', outline: '#1d1d28', sparkle: '#d7f5b8' } },
      { id: 'water-pail', kind: 'collectible', lane: 'low', w: 30, h: 30, action: 'grab', points: 30, combo: false, weight: 3,
        art: { shape: 'pail', fill: '#5aa0d8', accent: '#9fd0f0', outline: '#1d1d28', splash: '#cdeaf3' } }
    ];
    var HAZARDS = [
      { id: 'gnome', kind: 'hazard', lane: 'ground', w: 34, h: 44, action: 'jump', weight: 4,
        art: { shape: 'gnome', fill: '#c0473e', accent: '#e6cf9a', body: '#5f9450', outline: '#1d1d28' } },
      { id: 'bucket', kind: 'hazard', lane: 'ground', w: 38, h: 30, action: 'jump', weight: 4,
        art: { shape: 'bucket', fill: '#9a9aa6', accent: '#c8c8d2', outline: '#1d1d28' } },
      { id: 'sleepy-cat', kind: 'hazard', lane: 'ground', w: 46, h: 26, action: 'jump', weight: 3,
        art: { shape: 'cat', fill: '#e0a85a', accent: '#fff3e0', outline: '#1d1d28', zzz: '#9aa0b0' } },
      { id: 'pest-swarm', kind: 'hazard', lane: 'ground', w: 42, h: 34, action: 'jump', weight: 3,
        art: { shape: 'swarm', fill: '#4a5a3a', accent: '#7a8a5a', outline: '#1d1d28' } },
      { id: 'crow', kind: 'hazard', lane: 'high', w: 40, h: 30, action: 'duck', weight: 4,
        art: { shape: 'crow', fill: '#2b2b38', accent: '#4a4a5a', beak: '#e0b34c', outline: '#1d1d28' } },
      { id: 'banner', kind: 'hazard', lane: 'high', w: 56, h: 24, action: 'duck', weight: 3,
        art: { shape: 'banner', fill: '#c0473e', accent: '#f0e6c0', outline: '#1d1d28' } },
      { id: 'the-heat', kind: 'hazard', lane: 'high', w: 48, h: 28, action: 'duck', weight: 2,
        art: { shape: 'siren', fill: '#3a6ad0', accent: '#e04a4a', outline: '#1d1d28' } }
    ];
    var ALL = COLLECTIBLES.concat(HAZARDS);
    return {
      COLLECTIBLES: COLLECTIBLES, HAZARDS: HAZARDS, ALL: ALL,
      byId: function (id) { for (var i = 0; i < ALL.length; i++) if (ALL[i].id === id) return ALL[i]; return null; },
      byKind: function (k) { var o = []; for (var i = 0; i < ALL.length; i++) if (ALL[i].kind === k) o.push(ALL[i]); return o; },
      byLane: function (l) { var o = []; for (var i = 0; i < ALL.length; i++) if (ALL[i].lane === l) o.push(ALL[i]); return o; }
    };
  }

  var Core = root.BudCore || buildFallbackCore();
  var Entities = root.BudEntities || buildFallbackEntities();

  // ── Canvas layout (read from the core — never hard-coded here) ───────
  var W = 800, H = 360;                  // canvas footprint (index.html pins it)
  var GROUND_Y = Core.GROUND_Y;          // ground line on the canvas
  var RUNNER_X = Core.RUNNER_X;          // runner's fixed horizontal anchor

  // ── Palette (cel-cartoon: flat fills, one ink colour) ────────────────
  var INK = '#1d1d28';
  var OUTLINE = 3;
  var SKY_TOP = '#bfe3f2';
  var SKY_BOTTOM = '#e6f4d6';
  var HILL_FAR = '#8bbf6a';
  var HILL_NEAR = '#6fa84f';
  var TOWN_FAR = '#7fae8a';
  var BUSH = '#5f9a44';
  var BUSH_DARK = '#4d8338';
  var GROUND = '#caa86a';
  var GROUND_DARK = '#b8965a';
  var GROUND_LINE = '#a8854a';
  var SKIN = '#e6b88a';
  var SHIRT = '#5fae3e';
  var SHIRT_DARK = '#4d9230';
  var PANTS = '#7a5230';
  var APRON = '#caa86a';
  var CAP = '#3a8a4a';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Normalize a KeyboardEvent.key to a stable lowercase token.
  function normKey(k) {
    if (!k) return '';
    if (k === ' ' || k === 'Spacebar' || k === 'Space') return ' ';
    return k.toLowerCase();   // ArrowDown → 'arrowdown', Enter → 'enter'
  }
  function isJumpKey(k) { return k === ' ' || k === 'arrowup' || k === 'w'; }
  function isDuckKey(k) { return k === 'arrowdown' || k === 's'; }

  // ── Cel-cartoon primitives ───────────────────────────────────────────
  function celBox(ctx, x, y, w, h, fill, r) {
    r = r == null ? 8 : r;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = OUTLINE;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
  function celCircle(ctx, x, y, r, fill) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = OUTLINE;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
  function blob(ctx, x, y, w, h, fill) {
    ctx.beginPath();
    ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  function dot(ctx, x, y, r) {
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // ── Game ──────────────────────────────────────────────────────────────
  function Game(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.screen = 'title';
    this.keys = {};
    this.scroll = 0;          // px the world texture has scrolled (visual only)
    this.now = 0;
    this.paused = false;
    this.crashMsg = '';
    this._seed = null;
    this._swipeDuckUntil = 0;  // a swipe-down sets a brief duck window
    this.storage = null;
    try { this.storage = root.localStorage || null; } catch (e) { this.storage = null; }
    this.best = this.loadBest();
    this.reset(1);
  }

  // Best-score I/O lives in the shell; the core only formats / compares.
  Game.prototype.loadBest = function () {
    var dist = 0, score = 0;
    try {
      if (this.storage) {
        dist = parseInt(this.storage.getItem(Core.BEST_KEYS.dist), 10) || 0;
        score = parseInt(this.storage.getItem(Core.BEST_KEYS.score), 10) || 0;
      }
    } catch (e) {}
    return { distance: dist, score: score };
  };
  Game.prototype.saveBest = function (best) {
    try {
      if (this.storage) {
        this.storage.setItem(Core.BEST_KEYS.dist, String(Math.round(best.distance)));
        this.storage.setItem(Core.BEST_KEYS.score, String(Math.round(best.score)));
      }
    } catch (e) {}
  };

  // Build a fresh round. seed keeps spawns deterministic for tests.
  Game.prototype.reset = function (seed) {
    var s = seed || this._seed || ((Date.now() % 100000) + 1);
    this.runner = new Core.Runner({ x: RUNNER_X });
    this.score = new Core.ScoreKeeper();
    this.spawner = new Core.Spawner(s, Entities);
    this.entities = [];          // live spawner records (carry .dist ahead of runner)
    this.particles = [];         // grab sparkles / crash puff + tumble
    this.plantPops = [];         // watered-plant growth-pops
    this.speed = Core.SPEED_BASE;
    this.runTime = 0;
    this.shareCardData = null;
    this._endButtons = null;
  };

  // ── Input ───────────────────────────────────────────────────────────
  // The shell tracks raw held key state in this.keys and feeds {jump, duck}
  // to the core each frame. The core does its own edge-detect + hold logic.
  Game.prototype.onKeyDown = function (k, repeat) {
    var key = normKey(k);
    if (key === '') return;
    if (!repeat) {
      if (key === 'enter') { this.advance(); return; }
      if (key === 'r' && this.screen !== 'title') { this.restart(); return; }
      if (this.screen === 'play' && key === 'p') { this.togglePause(); return; }
      if (this.screen === 'title' && (key === ' ' || isJumpKey(key))) { this.advance(); return; }
    }
    this.keys[key] = true;
  };
  Game.prototype.onKeyUp = function (k) {
    var key = normKey(k);
    if (key) this.keys[key] = false;
  };
  Game.prototype.clearKeys = function () {
    this.keys = {};
    this._swipeDuckUntil = 0;
    if (this.screen === 'play' && !this.paused) this.togglePause();
  };

  // Build the per-frame input the core consumes: {jump, duck}.
  Game.prototype.readInput = function () {
    var jump = !!(this.keys[' '] || this.keys['arrowup'] || this.keys['w']);
    var duck = !!(this.keys['arrowdown'] || this.keys['s']) || (this.now < this._swipeDuckUntil);
    return { jump: jump, duck: duck };
  };

  Game.prototype.advance = function () {
    if (this.screen === 'title') {
      this.reset(this._seed || ((Date.now() % 100000) + 1));
      this.screen = 'play';
      this.paused = false;
      this.keys = {};
    } else if (this.screen === 'score') {
      this.screen = 'title';
    } else if (this.screen === 'crash') {
      this.crashMsg = '';
      this.screen = 'title';
    }
  };
  Game.prototype.restart = function () {
    this.reset((Date.now() % 100000) + 1);
    this.screen = 'play';
    this.paused = false;
    this.keys = {};
  };
  Game.prototype.togglePause = function () { this.paused = !this.paused; };

  // ── Per-frame update ──────────────────────────────────────────────────
  Game.prototype.update = function (dt) {
    this.now += dt;
    var visualSpeed = this.screen === 'play' ? this.speed : Core.SPEED_BASE * 0.5;
    this.scroll += visualSpeed * dt;
    this.tickParticles(dt);

    if (this.screen !== 'play' || this.paused) return;

    this.runTime += dt;

    // Core owns physics. Feed it the held input each frame.
    this.runner.update(dt, this.readInput());

    // Speed ramps with distance (capped, in core). Accrue distance + score.
    this.speed = Core.speedAt(this.score.distance);
    var travel = this.speed * dt;
    this.score.travel(travel);
    this.score.tick(dt);

    // Spawn new entities ahead, then scroll all live entities toward the runner.
    var spawned = this.spawner.pump(this.score.distance, this.speed);
    for (var s = 0; s < spawned.length; s++) this.entities.push(spawned[s]);

    var live = [];
    for (var i = 0; i < this.entities.length; i++) {
      var e = this.entities[i];
      e.dist -= travel;                      // scroll left toward the runner
      if (e.dist + e.w < -RUNNER_X - 40) continue;   // fully past the left edge
      // Bud magnet: a collectible within reach while airborne flies in — makes
      // grabbing feel forgiving instead of frame-perfect (still needs a jump).
      if (!e.collected && Core.magnetReaches && Core.magnetReaches(this.runner, e)) {
        e._magnet = true;
        this.collect(e);
      } else if (!e.collected && Core.collides(this.runner, e)) {
        if (e.kind === 'collectible') { this.collect(e); }
        else { this.crash(e); }
      }
      if (!e.collected || e.kind === 'collectible') live.push(e);
    }
    this.entities = live;

    // Tick plant-pops.
    var pops = [];
    for (var p = 0; p < this.plantPops.length; p++) {
      this.plantPops[p].age += dt;
      this.plantPops[p].x -= travel;          // move with the world
      if (this.plantPops[p].age < this.plantPops[p].life) pops.push(this.plantPops[p]);
    }
    this.plantPops = pops;
  };

  // Grab a collectible: bud bumps the harvest combo, pail waters a plant.
  Game.prototype.collect = function (e) {
    if (e.collected) return;
    e.collected = true;
    e.scored = true;
    var sx = RUNNER_X + e.dist + e.w / 2;
    var sy = GROUND_Y - Core.laneBottom(e.lane, e.kind) - e.h / 2;
    var combo = e.ref && e.ref.combo;
    if (combo) {
      var pts = this.score.harvestBud();
      this.spawnGrabParticles(sx, sy, (e.ref && e.ref.art && e.ref.art.fill) || '#6fc24a', '+' + pts, true);
    } else {
      var bonus = this.score.waterPlant();
      this.spawnPlantPop(RUNNER_X + e.dist + e.w / 2);
      this.spawnGrabParticles(sx, sy, (e.ref && e.ref.art && e.ref.art.splash) || '#7fc4e0', '+' + bonus, false);
    }
  };

  Game.prototype.crash = function (e) {
    var cx = RUNNER_X, cy = GROUND_Y - 28;
    for (var i = 0; i < 18; i++) {
      var ang = (i / 18) * Math.PI * 2;
      this.particles.push({
        x: cx, y: cy,
        vx: Math.cos(ang) * (60 + (i % 5) * 26),
        vy: Math.sin(ang) * (60 + (i % 4) * 30) - 80,
        age: 0, life: 0.6 + (i % 4) * 0.12,
        r: 4 + (i % 4), color: i % 2 ? '#e8d8b8' : '#caa86a', puff: true, rot: ang
      });
    }
    this.endRun();
  };

  Game.prototype.endRun = function () {
    var result = { distance: this.score.distance, score: this.score.score };
    var updated = Core.updateBest(result, this.best);
    this.shareCardData = {
      distance: this.score.distance,
      score: this.score.score,
      buds: this.score.buds,
      bestCombo: this.score.bestCombo,
      isBest: updated.newBestDistance || updated.newBestScore
    };
    this.best = { distance: updated.distance, score: updated.score };
    this.saveBest(this.best);
    this.screen = 'score';
  };

  // ── Particles & pops ──────────────────────────────────────────────────
  Game.prototype.spawnGrabParticles = function (x, y, color, label, leaf) {
    for (var i = 0; i < 8; i++) {
      var ang = (i / 8) * Math.PI * 2;
      this.particles.push({
        x: x, y: y,
        vx: Math.cos(ang) * (40 + (i % 5) * 16),
        vy: Math.sin(ang) * (40 + (i % 5) * 16) - 30,
        age: 0, life: 0.5 + (i % 3) * 0.12,
        r: 3 + (i % 3), color: color, leaf: !!leaf
      });
    }
    this.particles.push({ x: x, y: y, vx: 0, vy: -50, age: 0, life: 0.8, text: label, color: color });
  };
  Game.prototype.spawnPlantPop = function (x) {
    this.plantPops.push({ x: x, y: GROUND_Y, age: 0, life: 0.7 });
  };
  Game.prototype.tickParticles = function (dt) {
    var live = [];
    var visualSpeed = this.screen === 'play' ? this.speed : Core.SPEED_BASE * 0.5;
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      p.age += dt;
      p.vy += 220 * dt;
      p.x += p.vx * dt - visualSpeed * dt * 0.3;
      p.y += p.vy * dt;
      if (p.age < p.life) live.push(p);
    }
    this.particles = live;
  };

  // ── Share text + card (clipboard + PNG) ──────────────────────────────
  Game.prototype.shareResult = function () {
    return this.shareCardData || {
      distance: this.score.distance, score: this.score.score,
      buds: this.score.buds, bestCombo: this.score.bestCombo
    };
  };
  Game.prototype.shareText = function () { return Core.shareText(this.shareResult()); };
  Game.prototype.copyResult = function () {
    var txt = this.shareText();
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      try { root.navigator.clipboard.writeText(txt); } catch (e) {}
    }
    return txt;
  };
  Game.prototype.saveCard = function () {
    var doc = root.document;
    var c = doc && doc.createElement ? doc.createElement('canvas') : null;
    if (!c || !c.getContext) return false;
    c.width = 600; c.height = 600;
    var x = c.getContext('2d');
    this.paintShareCard(x, c.width, c.height);
    if (!c.toBlob) return false;
    c.toBlob(function (blob) {
      if (!blob || !root.URL || !root.URL.createObjectURL) return;
      var url = root.URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url; a.download = 'budshop-runner.png';
      if (doc.body) doc.body.appendChild(a);
      if (a.click) a.click();
      if (a.remove) a.remove();
      if (root.URL.revokeObjectURL) root.URL.revokeObjectURL(url);
    });
    return true;
  };
  Game.prototype.paintShareCard = function (ctx, w, h) {
    var d = this.shareResult();
    ctx.fillStyle = '#15110e'; ctx.fillRect(0, 0, w, h);
    celBox(ctx, 24, 24, w - 48, h - 48, '#2a3320', 18);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#9ad86a';
    ctx.font = 'bold 38px ui-monospace, monospace';
    ctx.fillText('🌿 BUDSHOP RUNNER', w / 2, 110);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 70px ui-monospace, monospace';
    ctx.fillText(Core.formatDistance(d.distance), w / 2, 232);
    ctx.fillStyle = '#caa86a';
    ctx.font = '20px ui-monospace, monospace';
    ctx.fillText('DISTANCE', w / 2, 264);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 34px ui-monospace, monospace';
    ctx.fillText(Math.round(d.score) + ' pts', w / 2, 330);
    ctx.fillStyle = '#6fc24a';
    ctx.font = 'bold 26px ui-monospace, monospace';
    ctx.fillText('🌱 ' + d.buds + ' buds', w / 2, 388);
    ctx.fillStyle = '#e0a050';
    ctx.fillText('🔥 best combo ×' + Math.max(1, d.bestCombo), w / 2, 432);
    var bar = this.shareText().split('\n').pop();
    ctx.fillStyle = '#d8c8a8';
    ctx.font = '17px ui-monospace, monospace';
    ctx.fillText(bar, w / 2, 500);
    ctx.textAlign = 'left';
  };

  // ════════════════════════════════════════════════════════════════════
  //  RENDER
  // ════════════════════════════════════════════════════════════════════
  Game.prototype.draw = function () {
    var ctx = this.ctx;
    ctx.save();
    this.drawBackground(ctx);

    if (this.screen === 'title') { this.drawForeground(ctx); this.drawRunner(ctx); this.drawTitle(ctx); ctx.restore(); return; }
    if (this.screen === 'crash') { this.drawCrash(ctx); ctx.restore(); return; }

    this.drawForeground(ctx);
    this.drawEntities(ctx);
    this.drawPlantPops(ctx);
    this.drawRunner(ctx);
    this.drawParticles(ctx);
    this.drawHUD(ctx);

    if (this.paused) this.drawPause(ctx);
    if (this.screen === 'score') this.drawScoreCard(ctx);
    ctx.restore();
  };

  // Parallax backdrop: sky, distant hills/skyline, mid bushes/plants.
  Game.prototype.drawBackground = function (ctx) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, SKY_TOP);
    g.addColorStop(1, SKY_BOTTOM);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    blob(ctx, W - 110, 66, 70, 70, '#fce98a');   // sun

    ctx.fillStyle = HILL_FAR;
    var fx = -((this.scroll * 0.08) % 300);
    for (var i = -1; i < W / 300 + 2; i++) blob(ctx, fx + i * 300 + 150, 220, 360, 200, HILL_FAR);

    // Distant town skyline + a cruising patrol car as set dressing ("the heat").
    ctx.fillStyle = TOWN_FAR;
    var tx = -((this.scroll * 0.12) % 200);
    for (var t = -1; t < W / 200 + 2; t++) {
      var bx = tx + t * 200;
      ctx.fillRect(bx + 20, 150, 26, 60);
      ctx.fillRect(bx + 60, 128, 22, 82);
      ctx.fillRect(bx + 96, 160, 30, 50);
    }
    this.drawPatrolCar(ctx);

    ctx.fillStyle = HILL_NEAR;
    var nx = -((this.scroll * 0.2) % 280);
    for (var j = -1; j < W / 280 + 2; j++) blob(ctx, nx + j * 280 + 140, 250, 340, 170, HILL_NEAR);

    var gx = -((this.scroll * 0.4) % 120);
    for (var k = -1; k < W / 120 + 2; k++) {
      var px = gx + k * 120;
      blob(ctx, px + 30, GROUND_Y - 28, 70, 50, BUSH);
      blob(ctx, px + 70, GROUND_Y - 22, 56, 40, BUSH_DARK);
    }
  };

  // Background "the heat": a tiny patrol car drifting along the skyline. Pure
  // comedic set dressing — the dodgeable hazard version is the roster 'the-heat'.
  Game.prototype.drawPatrolCar = function (ctx) {
    var period = 1600;
    var pos = (this.scroll * 0.5) % period;
    var x = W - pos;
    var y = 196;
    ctx.save();
    celBox(ctx, x, y, 40, 12, '#dfe4ea', 4);
    celBox(ctx, x + 8, y - 8, 20, 9, '#cdd4dc', 3);
    var blink = Math.floor(this.now * 4) % 2 === 0;
    ctx.fillStyle = blink ? '#e04a4a' : '#3a6ad0';
    ctx.fillRect(x + 16, y - 12, 8, 4);
    celCircle(ctx, x + 10, y + 12, 4, '#2a2a32');
    celCircle(ctx, x + 30, y + 12, 4, '#2a2a32');
    ctx.restore();
  };

  // Foreground ground band with a scrolling furrow texture.
  Game.prototype.drawForeground = function (ctx) {
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    ctx.fillStyle = GROUND_DARK;
    ctx.fillRect(0, GROUND_Y, W, 5);
    ctx.strokeStyle = GROUND_LINE;
    ctx.lineWidth = 2;
    var sx = -((this.scroll) % 48);
    for (var k = 0; k < W / 48 + 2; k++) {
      var lx = sx + k * 48;
      ctx.beginPath(); ctx.moveTo(lx, GROUND_Y + 14); ctx.lineTo(lx + 18, GROUND_Y + 14); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lx + 24, GROUND_Y + 34); ctx.lineTo(lx + 42, GROUND_Y + 34); ctx.stroke();
    }
  };

  // ── Entities from the roster ──────────────────────────────────────────
  Game.prototype.drawEntities = function (ctx) {
    for (var i = 0; i < this.entities.length; i++) {
      var e = this.entities[i];
      if (e.collected) continue;
      var screenX = RUNNER_X + e.dist;        // SAME mapping core uses for collision
      if (screenX > W + 40 || screenX + e.w < -40) continue;
      var bottom = Core.laneBottom(e.lane, e.kind);
      var baseY = GROUND_Y - bottom;            // bottom of the entity on screen
      var cx = screenX + e.w / 2;
      var art = (e.ref && e.ref.art) || { shape: e.id };
      this.drawArt(ctx, art.shape || e.id, art, cx, baseY, e.w, e.h);
    }
  };

  // One procedural painter per art shape. Unknown shape → labelled box, never throws.
  Game.prototype.drawArt = function (ctx, shape, art, cx, baseY, w, h) {
    var topY = baseY - h;
    var fill = art.fill || '#b06a6a';
    var accent = art.accent || '#fff';
    switch (shape) {
      case 'bud': {
        var bob = Math.sin(this.now * 4) * 2;
        var cy = baseY - h / 2 + bob;
        ctx.save();
        ctx.fillStyle = 'rgba(124,196,92,0.4)';
        ctx.beginPath(); ctx.arc(cx, cy, w * 0.9, 0, Math.PI * 2); ctx.fill();
        celCircle(ctx, cx, cy, w * 0.32, fill);
        celCircle(ctx, cx - w * 0.22, cy + h * 0.12, w * 0.24, accent);
        celCircle(ctx, cx + w * 0.22, cy + h * 0.12, w * 0.24, accent);
        celCircle(ctx, cx, cy - h * 0.22, w * 0.22, accent);
        // sparkle
        if (art.sparkle) { ctx.fillStyle = art.sparkle; dotStar(ctx, cx + w * 0.3, cy - h * 0.3, 3); }
        ctx.restore();
        break;
      }
      case 'pail': {
        celBox(ctx, cx - w / 2, topY, w * 0.9, h, fill, 4);
        ctx.fillStyle = accent;
        ctx.fillRect(cx - w / 2 + 3, topY + 4, w * 0.9 - 6, 5);
        ctx.strokeStyle = INK; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx - w * 0.05, topY, w / 2 - 3, Math.PI, 0); ctx.stroke();
        if (art.splash) { ctx.fillStyle = art.splash; celCircle(ctx, cx - w * 0.18, topY + 7, 2.4, art.splash); }
        break;
      }
      case 'gnome': {
        celBox(ctx, cx - w / 2, baseY - h * 0.55, w, h * 0.55, art.body || '#5f9450', 6);
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.42, baseY - h * 0.55); ctx.lineTo(cx, topY); ctx.lineTo(cx + w * 0.42, baseY - h * 0.55);
        ctx.closePath(); ctx.fill(); ctx.lineWidth = OUTLINE; ctx.strokeStyle = INK; ctx.stroke();
        celCircle(ctx, cx, baseY - h * 0.5, w * 0.26, SKIN);
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.22, baseY - h * 0.5); ctx.lineTo(cx, baseY - h * 0.2); ctx.lineTo(cx + w * 0.22, baseY - h * 0.5);
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'bucket': {
        ctx.save();
        ctx.translate(cx, baseY - h / 2);
        ctx.rotate(0.5);
        celBox(ctx, -w / 2, -h / 2, w, h, fill, 4);
        ctx.fillStyle = accent;
        ctx.fillRect(-w / 2 + 2, -h / 2 + 2, w - 4, 4);
        ctx.restore();
        break;
      }
      case 'cat': {
        blob(ctx, cx, baseY - h * 0.42, w * 1.0, h * 0.85, fill);
        ctx.lineWidth = OUTLINE; ctx.strokeStyle = INK;
        ctx.beginPath(); ctx.ellipse(cx, baseY - h * 0.42, w * 0.5, h * 0.42, 0, 0, Math.PI * 2); ctx.stroke();
        celCircle(ctx, cx - w * 0.38, baseY - h * 0.55, w * 0.24, fill);
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.5, baseY - h * 0.7); ctx.lineTo(cx - w * 0.44, baseY - h * 0.95); ctx.lineTo(cx - w * 0.34, baseY - h * 0.72);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = INK; ctx.fillRect(cx - w * 0.42, baseY - h * 0.58, 5, 2);
        if (art.zzz) { ctx.fillStyle = art.zzz; ctx.font = 'bold 11px ui-monospace, monospace'; ctx.fillText('z', cx + w * 0.2, topY + 2); }
        break;
      }
      case 'swarm': {
        for (var p = 0; p < 7; p++) {
          var ox = (p - 3) * (w / 7);
          var oy = Math.sin(this.now * 12 + p) * 4;
          celCircle(ctx, cx + ox, baseY - h * 0.4 + oy, 4, fill);
        }
        break;
      }
      case 'crow': {
        var flp = Math.sin(this.now * 12) * 8;
        ctx.save();
        ctx.translate(cx, baseY - h / 2);
        celCircle(ctx, 0, 0, h * 0.42, fill);
        ctx.fillStyle = art.beak || '#e0b34c';
        ctx.beginPath(); ctx.moveTo(-h * 0.42, 0); ctx.lineTo(-h * 0.72, 2); ctx.lineTo(-h * 0.42, 5); ctx.closePath(); ctx.fill();
        ctx.fillStyle = accent;
        ctx.beginPath(); ctx.ellipse(w * 0.1, -flp, w * 0.4, h * 0.22, -0.4, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.stroke();
        celCircle(ctx, -h * 0.16, -h * 0.1, 3, '#fff'); dot(ctx, -h * 0.16, -h * 0.1, 1.5);
        ctx.restore();
        break;
      }
      case 'banner': {
        ctx.strokeStyle = INK; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx - w / 2 - 10, topY); ctx.lineTo(cx + w / 2 + 10, topY + 2); ctx.stroke();
        celBox(ctx, cx - w / 2, topY, w, h, fill, 4);
        ctx.fillStyle = accent;
        ctx.font = 'bold 12px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('SALE', cx, topY + h * 0.72);
        ctx.textAlign = 'left';
        break;
      }
      case 'siren': {
        celBox(ctx, cx - w / 2, topY + h * 0.4, w, h * 0.6, fill, 4);
        var blink = Math.floor(this.now * 6) % 2 === 0;
        celCircle(ctx, cx - w * 0.22, topY + h * 0.28, h * 0.28, blink ? (art.accent || '#e04a4a') : '#a03028');
        celCircle(ctx, cx + w * 0.22, topY + h * 0.28, h * 0.28, blink ? '#3050e8' : (fill));
        break;
      }
      default: {
        celBox(ctx, cx - w / 2, topY, w, h, fill, 4);
        break;
      }
    }
  };

  function dotStar(ctx, x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.4, y - r * 0.4); ctx.lineTo(x + r, y);
    ctx.lineTo(x + r * 0.4, y + r * 0.4); ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.4, y + r * 0.4);
    ctx.lineTo(x - r, y); ctx.lineTo(x - r * 0.4, y - r * 0.4); ctx.closePath(); ctx.fill();
  }

  Game.prototype.drawPlantPops = function (ctx) {
    for (var i = 0; i < this.plantPops.length; i++) {
      var pp = this.plantPops[i];
      var t = pp.age / pp.life;
      var grow = Math.sin(Math.min(1, t) * Math.PI * 0.5);
      var x = pp.x, base = pp.y;
      ctx.globalAlpha = clamp(1 - (t - 0.6) / 0.4, 0, 1);
      ctx.strokeStyle = '#4d8338'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x, base - 30 * grow); ctx.stroke();
      celCircle(ctx, x - 8 * grow, base - 18 * grow, 6 * grow + 1, '#7fce5a');
      celCircle(ctx, x + 8 * grow, base - 24 * grow, 6 * grow + 1, '#7fce5a');
      celCircle(ctx, x, base - 32 * grow, 7 * grow + 1, '#8fd86a');
      ctx.globalAlpha = 1;
    }
  };

  // ── The animated running budtender ────────────────────────────────────
  Game.prototype.drawRunner = function (ctx) {
    var r = this.runner;
    var x = r ? r.x : RUNNER_X;
    var ducking = r ? r.ducking : false;
    var airY = r ? r.y : 0;
    var grounded = r ? r.grounded : true;
    var vy = r ? r.vy : 0;
    var feetY = GROUND_Y - airY;

    // Squash-stretch: squash on takeoff/land, stretch in air, big squash duck.
    var sx = 1, sy = 1;
    if (!grounded) { var rising = vy > 0; sy = rising ? 1.14 : 1.06; sx = rising ? 0.9 : 0.95; }
    if (ducking) { sx = 1.18; sy = 0.72; }

    // Ground shadow (shrinks as the runner rises).
    var shadowScale = clamp(1 - airY / 160, 0.3, 1);
    ctx.fillStyle = 'rgba(40,30,20,0.22)';
    ctx.beginPath();
    ctx.ellipse(x, GROUND_Y + 2, 22 * shadowScale, 6 * shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(x, feetY);
    ctx.scale(sx, sy);
    if (ducking) this.drawBudtenderDuck(ctx);
    else this.drawBudtenderRun(ctx, grounded);
    ctx.restore();
  };

  // Standing/running pose: feet at y=0, body grows up.
  Game.prototype.drawBudtenderRun = function (ctx, grounded) {
    var w = (Core.RUNNER_W || 40), bodyH = (Core.RUNNER_H || 64);
    var l1 = grounded ? Math.sin(this.scroll * 0.06) : 0;
    var l2 = grounded ? Math.sin(this.scroll * 0.06 + Math.PI) : 0;
    var legH = bodyH * 0.34, torsoY = -bodyH, torsoH = bodyH * 0.5;

    // Legs (cycle while grounded; tucked while airborne).
    drawLeg(ctx, -w * 0.18, legH, grounded ? l1 * 6 : 4);
    drawLeg(ctx, w * 0.18, legH, grounded ? l2 * 6 : -4);
    // Torso + apron
    celBox(ctx, -w / 2, torsoY + legH, w, torsoH, SHIRT, 8);
    ctx.fillStyle = APRON;
    ctx.fillRect(-w * 0.32, torsoY + legH + torsoH * 0.3, w * 0.64, torsoH * 0.6);
    // Arms swing
    ctx.strokeStyle = INK; ctx.lineWidth = OUTLINE; ctx.fillStyle = SHIRT_DARK;
    var armSwing = grounded ? l1 * 8 : 6;
    ctx.beginPath(); ctx.moveTo(-w * 0.4, torsoY + legH + 6); ctx.lineTo(-w * 0.55, torsoY + legH + 18 + armSwing); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w * 0.4, torsoY + legH + 6); ctx.lineTo(w * 0.55, torsoY + legH + 18 - armSwing); ctx.stroke();
    // Head + cap + face
    var headR = w * 0.42, headY = torsoY + legH - headR * 0.3;
    celCircle(ctx, 0, headY, headR, SKIN);
    ctx.fillStyle = CAP;
    ctx.beginPath(); ctx.arc(0, headY - headR * 0.2, headR, Math.PI, 0); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.stroke();
    celCircle(ctx, headR * 0.35, headY - headR * 0.1, headR * 0.32, '#fff');
    dot(ctx, headR * 0.42, headY - headR * 0.05, 3);
    ctx.strokeStyle = INK; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(headR * 0.2, headY + headR * 0.35, headR * 0.4, 0.1, Math.PI - 0.6); ctx.stroke();
  };

  // Ducking crouch pose.
  Game.prototype.drawBudtenderDuck = function (ctx) {
    var w = (Core.RUNNER_W || 40) * 1.2, bodyH = (Core.DUCK_H || 38);
    celBox(ctx, -w / 2, -bodyH, w, bodyH, SHIRT, 8);
    ctx.fillStyle = APRON;
    ctx.fillRect(-w * 0.3, -bodyH * 0.6, w * 0.6, bodyH * 0.5);
    var headR = w * 0.3, hx = w * 0.3, hy = -bodyH - headR * 0.2;
    celCircle(ctx, hx, hy, headR, SKIN);
    ctx.fillStyle = CAP;
    ctx.beginPath(); ctx.arc(hx, hy - headR * 0.3, headR, Math.PI, 0); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.stroke();
    dot(ctx, hx + headR * 0.4, hy, 3);
    ctx.fillStyle = PANTS;
    celBox(ctx, -w * 0.42, -bodyH * 0.4, w * 0.34, bodyH * 0.4, PANTS, 4);
  };

  function drawLeg(ctx, x, len, lift) {
    celBox(ctx, x - 5, -len + (lift || 0), 10, len, PANTS, 3);
    celBox(ctx, x - 7, -2 + (lift || 0), 16, 7, '#3a2a1a', 3);
  }

  Game.prototype.drawParticles = function (ctx) {
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      var a = clamp(1 - p.age / p.life, 0, 1);
      ctx.globalAlpha = a;
      if (p.text) {
        ctx.fillStyle = p.color || '#fff';
        ctx.font = 'bold 16px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(p.text, p.x, p.y);
        ctx.textAlign = 'left';
      } else if (p.leaf) {
        celCircle(ctx, p.x, p.y, p.r, p.color);
      } else {
        blob(ctx, p.x, p.y, p.r * 2, p.r * 2, p.color);
      }
      ctx.globalAlpha = 1;
    }
  };

  // ── HUD ───────────────────────────────────────────────────────────────
  Game.prototype.drawHUD = function (ctx) {
    ctx.fillStyle = INK;
    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(Core.formatDistance(this.score.distance), 16, 28);
    ctx.fillText('🌱 ' + this.score.buds, 16, 50);

    ctx.textAlign = 'right';
    ctx.fillText(Math.round(this.score.score) + ' pts', W - 16, 28);
    ctx.fillText('BEST ' + Core.formatDistance(this.best.distance), W - 16, 50);

    var mult = Core.comboMultiplier(this.score.combo);
    if (mult > 1) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#c0473e';
      ctx.font = 'bold 22px ui-monospace, monospace';
      ctx.fillText('HARVEST ×' + mult, W / 2, 28);
      var frac = clamp(this.score.window / Core.COMBO_WINDOW, 0, 1);
      ctx.fillStyle = 'rgba(192,71,62,0.25)';
      ctx.fillRect(W / 2 - 60, 36, 120, 8);
      ctx.fillStyle = '#c0473e';
      ctx.fillRect(W / 2 - 60, 36, 120 * frac, 8);
    }
    ctx.textAlign = 'left';
  };

  // ── Screens ─────────────────────────────────────────────────────────
  Game.prototype.drawTitle = function (ctx) {
    ctx.fillStyle = 'rgba(21,17,14,0.32)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#9ad86a';
    ctx.font = 'bold 50px ui-monospace, monospace';
    ctx.fillText('BUDSHOP RUNNER', W / 2, H / 2 - 28);
    ctx.fillStyle = '#fff';
    ctx.font = '16px ui-monospace, monospace';
    ctx.fillText('JUMP for buds 🌱 · DUCK under the heat', W / 2, H / 2 + 6);
    ctx.fillStyle = '#e0c84a';
    ctx.font = 'bold 20px ui-monospace, monospace';
    ctx.fillText('press SPACE / tap to run', W / 2, H / 2 + 48);
    if (this.best.distance > 0) {
      ctx.fillStyle = '#d8c8a8';
      ctx.font = '14px ui-monospace, monospace';
      ctx.fillText('best ' + Core.formatDistance(this.best.distance) + ' · ' + Math.round(this.best.score) + ' pts', W / 2, H / 2 + 78);
    }
    ctx.textAlign = 'left';
  };

  Game.prototype.drawPause = function (ctx) {
    ctx.fillStyle = 'rgba(21,17,14,0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 40px ui-monospace, monospace';
    ctx.fillText('PAUSED', W / 2, H / 2);
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillText('P resume · R restart', W / 2, H / 2 + 30);
    ctx.textAlign = 'left';
  };

  Game.prototype.drawScoreCard = function (ctx) {
    ctx.fillStyle = 'rgba(21,17,14,0.78)';
    ctx.fillRect(0, 0, W, H);
    var cw = 380, ch = 300, cx = (W - cw) / 2, cy = (H - ch) / 2;
    celBox(ctx, cx, cy, cw, ch, '#2a3320', 16);
    ctx.textAlign = 'center';
    var d = this.shareResult();
    ctx.fillStyle = '#9ad86a';
    ctx.font = 'bold 26px ui-monospace, monospace';
    ctx.fillText(this.shareCardData && this.shareCardData.isBest ? '🏆 NEW BEST!' : 'WIPED OUT', W / 2, cy + 42);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 44px ui-monospace, monospace';
    ctx.fillText(Core.formatDistance(d.distance), W / 2, cy + 92);
    ctx.fillStyle = '#caa86a';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText('DISTANCE', W / 2, cy + 110);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.fillText(Math.round(d.score) + ' pts  ·  🌱 ' + d.buds + '  ·  🔥×' + Math.max(1, d.bestCombo), W / 2, cy + 142);

    this._endButtons = [
      { id: 'copy', label: 'COPY 📋', x: cx + 28, y: cy + 166, w: cw - 56, h: 38, color: '#2a7fa7' },
      { id: 'save', label: 'SAVE PNG 🖼', x: cx + 28, y: cy + 212, w: cw - 56, h: 38, color: '#5fae3e' }
    ];
    for (var b = 0; b < this._endButtons.length; b++) {
      var bt = this._endButtons[b];
      celBox(ctx, bt.x, bt.y, bt.w, bt.h, bt.color, 10);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px ui-monospace, monospace';
      ctx.fillText(bt.label, bt.x + bt.w / 2, bt.y + 25);
    }
    ctx.fillStyle = '#d8c8a8';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText('tap / R to run again · ENTER for title', W / 2, cy + ch - 14);
    ctx.textAlign = 'left';
  };

  Game.prototype.drawCrash = function (ctx) {
    ctx.fillStyle = '#15110e';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e08a6a';
    ctx.font = 'bold 26px ui-monospace, monospace';
    ctx.fillText('BUDSHOP RUNNER CRASHED', W / 2, H / 2 - 16);
    ctx.fillStyle = '#d8c8a8';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText((this.crashMsg || 'unexpected error').slice(0, 70), W / 2, H / 2 + 12);
    ctx.fillStyle = '#e0c84a';
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.fillText('press ENTER to restart', W / 2, H / 2 + 48);
    ctx.textAlign = 'left';
  };

  // Pointer / tap. Tapping the play area JUMPS (runner convention); tapping a
  // score-card button fires its action; tapping title/crash advances.
  Game.prototype.handlePoint = function (px, py) {
    if (this.screen === 'play' && !this.paused) { this.tapJump(); return; }
    if (this.screen === 'title') { this.advance(); return; }
    if (this.screen === 'crash') { this.advance(); return; }
    if (this.screen === 'score' && this._endButtons) {
      for (var i = 0; i < this._endButtons.length; i++) {
        var b = this._endButtons[i];
        if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
          if (b.id === 'copy') this.copyResult();
          else if (b.id === 'save') this.saveCard();
          return;
        }
      }
      this.restart();
    }
  };

  // A tap = a brief synthetic JUMP press: set the key, the core edge-detects
  // it next frame, and a short auto-release lets the jump-cut make it a hop.
  Game.prototype.tapJump = function () {
    this.keys[' '] = true;
    var self = this;
    if (root.setTimeout) root.setTimeout(function () { self.keys[' '] = false; }, 140);
  };

  // Swipe-down anywhere on the play surface = a brief duck.
  Game.prototype.handleSwipeDown = function () {
    if (this.screen === 'play' && !this.paused) this._swipeDuckUntil = this.now + 0.42;
  };

  // ── Boot ────────────────────────────────────────────────────────────
  function boot() {
    var doc = root.document;
    var canvas = doc && doc.getElementById ? doc.getElementById('game') : null;
    if (!canvas) return;
    canvas.width = W; canvas.height = H;
    var game = new Game(canvas);

    root.addEventListener('keydown', function (e) {
      var key = e.key;
      if (key === ' ' || (key && key.indexOf('Arrow') === 0)) { if (e.preventDefault) e.preventDefault(); }
      game.onKeyDown(key, e.repeat);
    });
    root.addEventListener('keyup', function (e) { game.onKeyUp(e.key); });
    root.addEventListener('blur', function () { game.clearKeys(); });
    if (doc && doc.addEventListener) {
      doc.addEventListener('visibilitychange', function () { if (doc.hidden) game.clearKeys(); });
    }

    if (canvas.addEventListener) {
      var pointAt = function (clientX, clientY) {
        var r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: W, height: H };
        var scaleX = W / (r.width || W), scaleY = H / (r.height || H);
        game.handlePoint((clientX - r.left) * scaleX, (clientY - r.top) * scaleY);
      };
      canvas.addEventListener('click', function (e) { pointAt(e.clientX, e.clientY); });
      var tsy = 0, tsx = 0, tst = 0;
      canvas.addEventListener('touchstart', function (e) {
        if (e.touches && e.touches[0]) { tsy = e.touches[0].clientY; tsx = e.touches[0].clientX; tst = (root.Date ? Date.now() : 0); }
      }, { passive: true });
      canvas.addEventListener('touchend', function (e) {
        var t = e.changedTouches && e.changedTouches[0];
        if (t) {
          var dy = t.clientY - tsy, dx = Math.abs(t.clientX - tsx), dtMs = (root.Date ? Date.now() : 0) - tst;
          if (dy > 40 && dy > dx && dtMs < 500) { game.handleSwipeDown(); }
          else {
            var r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: W, height: H };
            var scaleX = W / (r.width || W), scaleY = H / (r.height || H);
            game.handlePoint((t.clientX - r.left) * scaleX, (t.clientY - r.top) * scaleY);
          }
        }
        if (e.preventDefault) e.preventDefault();
      }, { passive: false });
    }

    // rAF loop wrapped in try/catch → crash card, never a freeze.
    var last = 0;
    function frame(ts) {
      var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
      last = ts;
      try {
        game.update(dt);
        game.draw();
      } catch (err) {
        game.screen = 'crash';
        game.crashMsg = (err && err.message) ? err.message : String(err);
        try { game.drawCrash(game.ctx); } catch (e2) {}
      }
      root.requestAnimationFrame(frame);
    }
    root.requestAnimationFrame(frame);

    // Test hook (mirrors splat's window.__SPLAT).
    root.__BUDRUN = {
      getScreen: function () { return game.screen; },
      getGame: function () { return game; },
      seed: function (s) { game._seed = s; },
      // Plant a roster entry at a given distance AHEAD of the runner (the same
      // unit spawner records use), for deterministic shell tests.
      plant: function (ref, dist) {
        game.entities.push({
          ref: ref, id: ref.id, kind: ref.kind, lane: ref.lane, action: ref.action,
          w: ref.w, h: ref.h, points: ref.points || 0,
          dist: dist == null ? 0 : dist, collected: false, scored: false
        });
      },
      Core: Core,
      Entities: Entities
    };
  }

  if (root.addEventListener) root.addEventListener('load', boot);

  if (typeof module === 'object' && module.exports) {
    module.exports = { Game: Game, normKey: normKey, boot: boot, buildFallbackCore: buildFallbackCore, buildFallbackEntities: buildFallbackEntities };
  }
})(typeof self !== 'undefined' ? self : this);
