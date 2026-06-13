/*
 * TOP GOOSE — canvas shell: pseudo-3D renderer, input, state machine.
 *
 * Portrait flight-sim (480x800). The bird flies on-rails forward (+Z) with
 * free lateral (X) + vertical (Y) movement; the world rushes toward the
 * camera as camZ advances. Three switchable cameras (POV -> chase-near ->
 * chase-far) and three modes (Free Flight / Slalom / Time Trial) share ONE
 * engine. The shell ONLY draws + routes input — ALL math/rules live in the
 * engine. Projection is the seam: the shell calls core.project() for every
 * object every frame and NEVER reimplements it.
 *
 * Consumes the real engine globals (with thin contract-matching fallbacks so
 * it boots standalone):
 *   window.TGCore   — config + buildCamera/project/depthSort, scoreForDrop/
 *                     ScoreKeeper/Health/makeRng, VIEWS/viewByIndex,
 *                     rankForScore/formatTime/shareText
 *   window.TGBird   — Bird flight model (banking-plane feel)
 *   window.TGWorld  — Course (step), Payload, resolveLanding, collides,
 *                     initModeState + tickFree/tickSlalom/tickTimeTrial,
 *                     registerHazard, finalTime, evaluateBest, biomeAt, MODES
 *
 * Semi-realistic procedural art: a gradient sky+horizon that BANKS (canvas
 * rotate around (W/2, horizonY) by cam.bank) and pitches; a projected ground
 * grid / road with scrolling lane stripes; billboard sprites depth-sorted
 * FAR->NEAR with gradient shading + soft ground shadows; a wing-flapping
 * bird; an arcing poop payload + ground splat. Crash-proof rAF loop.
 */
(function () {
  'use strict';

  // ── Engine (from the sibling ENGINE builder) ─────────────────────────
  // Real globals win; thin fallbacks keep the shell + smoke test runnable if
  // a module is briefly absent. The fallbacks MIRROR the real engine's API
  // shape (same function names + return contracts).
  var CORE = window.TGCore || makeFallbackCore();
  var BIRD = window.TGBird || makeFallbackBird(CORE);
  var WORLD = window.TGWorld || makeFallbackWorld(CORE);

  // Config is OWNED by the engine; read it (never hard-code the seam).
  var W = CORE.W || 480, H = CORE.H || 800;
  var HORIZON_FRAC = CORE.HORIZON_FRAC != null ? CORE.HORIZON_FRAC : 0.42;
  var HALF_WIDTH = WORLD.HALF_WIDTH != null ? WORLD.HALF_WIDTH : 30;

  // Title-screen mode carousel: ordered ids, names read from the engine.
  var MODE_ORDER = ['free', 'slalom', 'timetrial'];
  function modeName(id) {
    var m = WORLD.MODES && WORLD.MODES[id];
    return m && m.name ? m.name : (id || 'RUN').toUpperCase();
  }

  // Views: count + lookup come from the engine.
  function viewCount() { return CORE.viewCount ? CORE.viewCount() : (CORE.VIEWS ? CORE.VIEWS.length : 3); }
  function viewAt(i) {
    if (CORE.viewByIndex) return CORE.viewByIndex(i);
    var v = CORE.VIEWS || [];
    var n = ((i % v.length) + v.length) % v.length;
    return v[n];
  }

  var canvas, ctx;
  var keys = {};
  var screen = 'title';     // title | play | paused | rank (crash via flag)
  var game = null;
  var last = 0;
  var titleT = 0;           // title / animation clock
  var viewIdx = 1;          // start in chase-near (best first impression)
  var modeIdx = 0;          // index into MODE_ORDER on the title screen
  var pointer = { x: W / 2, y: H * 0.62, active: false, baseX: 0, baseY: 0 };
  var crashed = false;
  var shakeT = 0, shakeMag = 0;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ══════════════════════════════════════════════════════════════════
  //  FALLBACK ENGINE (only used if a sibling module is briefly absent).
  //  The projection math is COPIED VERBATIM from CONTRACT.md so a fallback
  //  render is pixel-identical to the engine's. The fallbacks mirror the
  //  REAL engine's API names/return shapes. Real modules ALWAYS win.
  // ══════════════════════════════════════════════════════════════════
  function makeFallbackCore() {
    var W = 480, H = 800, F = 420, NEAR = 0.5, HF = 0.42;
    var VIEWS = [
      { id: 'pov', name: 'COCKPIT', chaseDist: 0, heightOff: 0.6, pitchOff: 0 },
      { id: 'chase-near', name: 'CHASE', chaseDist: 7, heightOff: 3, pitchOff: 0.04 },
      { id: 'chase-far', name: 'CHASE FAR', chaseDist: 14, heightOff: 6, pitchOff: 0.07 }
    ];
    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function damp(c, t, rate, dt) { return c + (t - c) * (1 - Math.exp(-rate * dt)); }
    function viewByIndex(i) { var n = ((i % VIEWS.length) + VIEWS.length) % VIEWS.length; return VIEWS[n]; }

    function buildCamera(bird, view) {
      if (!view) view = VIEWS[0];
      var pitch = (bird.pitch || 0) + (view.pitchOff || 0);
      return {
        x: bird.x, y: bird.y + (view.heightOff || 0), z: bird.z - (view.chaseDist || 0),
        yaw: 0, pitch: pitch, pitchOff: view.pitchOff || 0, bank: -(bird.bankAngle || 0),
        horizonY: H * HF - pitch * F * 0.5, F: F, near: NEAR, W: W, H: H
      };
    }
    function project(p, cam) {
      var near = cam.near == null ? NEAR : cam.near;
      var focal = cam.F == null ? F : cam.F;
      var halfW = (cam.W == null ? W : cam.W) / 2;
      var depth = p.z - cam.z;
      if (depth < near) return { sx: 0, sy: 0, scale: 0, depth: depth, visible: false };
      var k = focal / depth;
      return { sx: halfW + (p.x - cam.x) * k, sy: cam.horizonY - (p.y - cam.y) * k, scale: k, depth: depth, visible: true };
    }
    function depthSort(items) {
      return items.slice().sort(function (a, b) {
        return ((b && b.depth != null) ? b.depth : 0) - ((a && a.depth != null) ? a.depth : 0);
      });
    }
    function scoreForDrop(dist, tr, sr, golden, points) {
      var reach = tr + sr; if (dist > reach) return 0;
      var base = dist <= tr / 3 ? 100 : dist <= (tr * 2) / 3 ? 50 : 25;
      var v = base * ((points == null ? 100 : points) / 100); return golden ? v * 3 : v;
    }
    var COMBO_MAX = 5, COMBO_WINDOW = 4;
    function comboMultiplier(c) { return c <= 1 ? 1 : Math.min(c, COMBO_MAX); }
    function ScoreKeeper() { this.score = 0; this.combo = 1; this.bestCombo = 1; this.window = COMBO_WINDOW; }
    ScoreKeeper.prototype.registerHit = function (base) {
      if (base <= 0) return 0;
      this.combo = Math.min(this.combo + 1, COMBO_MAX);
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      this.window = COMBO_WINDOW;
      var pts = Math.round(base * comboMultiplier(this.combo)); this.score += pts; return pts;
    };
    ScoreKeeper.prototype.tick = function (dt, on) { if (this.combo <= 1 || !on) return; this.window -= dt; if (this.window <= 0) { this.combo = 1; this.window = COMBO_WINDOW; } };
    ScoreKeeper.prototype.registerMiss = function () { this.combo = 1; this.window = COMBO_WINDOW; };
    ScoreKeeper.prototype.addBonus = function (pts) { this.score += Math.max(0, pts); };
    function makeRng(seed) {
      var s = (seed == null ? 1 : seed) >>> 0;
      return function () { s = (s + 0x6d2b79f5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    }
    function Health(opts) { opts = opts || {}; this.maxHearts = opts.hearts == null ? 3 : opts.hearts; this.hearts = this.maxHearts; this.iframes = opts.iframes == null ? 1.4 : opts.iframes; this.invuln = 0; }
    Health.prototype.invulnerable = function () { return this.invuln > 0; };
    Health.prototype.alive = function () { return this.hearts > 0; };
    Health.prototype.update = function (dt) { if (this.invuln > 0) { this.invuln -= dt; if (this.invuln < 0) this.invuln = 0; } };
    Health.prototype.hit = function () { if (this.invuln > 0) return 'shrugged'; if (this.hearts <= 0) return 'gameover'; this.hearts -= 1; this.invuln = this.iframes; return this.hearts <= 0 ? 'gameover' : 'hit'; };
    var RANKS = [{ name: 'Fledgling', min: 0 }, { name: 'Wing Cadet', min: 1000 }, { name: 'Sky Ace', min: 2500 }, { name: 'Top Goose', min: 5000 }, { name: 'Maverick', min: 8000 }];
    function rankForScore(s) { var b = RANKS[0]; for (var i = 0; i < RANKS.length; i++) if (s >= RANKS[i].min) b = RANKS[i]; return b; }
    function formatTime(s) { if (s == null || s < 0 || !isFinite(s)) return '--:--'; var m = Math.floor(s / 60), sec = s - m * 60; var ss = sec.toFixed(2); if (sec < 10) ss = '0' + ss; return m + ':' + ss; }
    function shareText(r) {
      r = r || {}; var lines = ['🪿 TOP GOOSE — ' + (r.mode || 'FREE FLIGHT')];
      if (r.score != null) lines.push('💩 ' + r.score + ' pts · ' + (r.rank || rankForScore(r.score).name));
      if (r.bestCombo != null) lines.push('🔥 best combo x' + Math.min(r.bestCombo, COMBO_MAX));
      if (r.time != null) lines.push('⏱️ ' + formatTime(r.time));
      lines.push('Think you can fly cleaner?'); return lines.join('\n');
    }
    return {
      W: W, H: H, F: F, NEAR: NEAR, HORIZON_FRAC: HF, VIEWS: VIEWS,
      viewCount: function () { return VIEWS.length; }, viewByIndex: viewByIndex,
      clamp: clamp, lerp: lerp, damp: damp,
      buildCamera: buildCamera, project: project, depthSort: depthSort,
      scoreForDrop: scoreForDrop, comboMultiplier: comboMultiplier, ScoreKeeper: ScoreKeeper,
      COMBO_MAX: COMBO_MAX, COMBO_WINDOW: COMBO_WINDOW, makeRng: makeRng, Health: Health,
      RANKS: RANKS, rankForScore: rankForScore, formatTime: formatTime, shareText: shareText
    };
  }

  function makeFallbackBird(core) {
    var clamp = core.clamp, damp = core.damp;
    function Bird(opts) {
      opts = opts || {};
      this.cfg = { speed: 26, maxBank: 0.6, bankRate: 14, lateralAccel: 160, lateralDrag: 3.2, maxPitch: 0.5, pitchRate: 12, climbAccel: 90, verticalDrag: 3.0, halfWidth: 30, groundClear: 4, ceiling: 60, flapBase: 6, flapClimbBoost: 5 };
      this.x = opts.x == null ? 0 : opts.x; this.y = opts.y == null ? 24 : opts.y; this.z = opts.z == null ? 0 : opts.z;
      this.vx = 0; this.vy = 0; this.speed = this.cfg.speed; this.bankAngle = 0; this.pitch = 0; this.flapPhase = 0;
    }
    Bird.prototype.update = function (dt, input) {
      if (!(dt > 0)) return this; input = input || {}; var c = this.cfg;
      var sx = clamp(input.x || 0, -1, 1), sy = clamp(input.y || 0, -1, 1);
      this.z += this.speed * dt;
      this.bankAngle = damp(this.bankAngle, sx * c.maxBank, c.bankRate, dt);
      this.vx += Math.sin(this.bankAngle) * c.lateralAccel * dt;
      this.vx -= this.vx * Math.min(1, c.lateralDrag * dt);
      this.x += this.vx * dt;
      if (this.x < -c.halfWidth) { this.x = -c.halfWidth; if (this.vx < 0) this.vx = 0; }
      if (this.x > c.halfWidth) { this.x = c.halfWidth; if (this.vx > 0) this.vx = 0; }
      this.pitch = damp(this.pitch, sy * c.maxPitch, c.pitchRate, dt);
      this.vy += Math.sin(this.pitch) * c.climbAccel * dt;
      this.vy -= this.vy * Math.min(1, c.verticalDrag * dt);
      this.y += this.vy * dt;
      if (this.y < c.groundClear) { this.y = c.groundClear; if (this.vy < 0) this.vy = 0; }
      if (this.y > c.ceiling) { this.y = c.ceiling; if (this.vy > 0) this.vy = 0; }
      var climbing = this.pitch > 0 ? this.pitch / c.maxPitch : 0;
      this.flapPhase += (c.flapBase + climbing * c.flapClimbBoost) * dt;
      if (this.flapPhase > Math.PI * 2) this.flapPhase -= Math.PI * 2 * Math.floor(this.flapPhase / (Math.PI * 2));
      return this;
    };
    Bird.prototype.point = function () { return { x: this.x, y: this.y, z: this.z }; };
    return { Bird: Bird };
  }

  function makeFallbackWorld(core) {
    var makeRng = core.makeRng, scoreForDrop = core.scoreForDrop, clamp = core.clamp;
    var HALF_WIDTH = 30, GRAVITY = -32, BIOMES = ['open', 'park', 'city'], BAND_LEN = 600;
    function biomeAt(z) { var zz = z < 0 ? 0 : z; return BIOMES[Math.floor(zz / BAND_LEN) % BIOMES.length]; }
    function bandProgressAt(z) { var zz = z < 0 ? 0 : z; return (zz % BAND_LEN) / BAND_LEN; }
    var GROUND = [{ kind: 'GOER', r: 6, points: 100, golden: false, weight: 3 }, { kind: 'GOER', r: 7, points: 140, golden: false, weight: 2 }, { kind: 'GOER', r: 5, points: 170, golden: true, weight: 1 }];
    var OBST = [{ kind: 'POLE', r: 2.2, weight: 3, biome: 'both' }, { kind: 'BUILDING', r: 14, weight: 3, biome: 'city' }, { kind: 'BALLOON', r: 5, weight: 2, biome: 'open' }, { kind: 'RIVAL', r: 4, weight: 2, biome: 'both', mover: true }, { kind: 'ARCH', r: 16, gapHalf: 10, rimHalf: 20, weight: 2, biome: 'park' }, { kind: 'RING', r: 12, gapHalf: 9, rimHalf: 16, weight: 2, biome: 'both' }];
    function buildBag(list) { var bag = []; for (var i = 0; i < list.length; i++) { var w = list[i].weight || 1; for (var k = 0; k < w; k++) bag.push(list[i]); } return bag; }
    function eligible(list, biome) { var out = []; for (var i = 0; i < list.length; i++) { var b = list[i].biome; if (b == null || b === 'both' || b === biome) out.push(list[i]); } return out.length ? out : list; }
    function Course(opts) {
      opts = opts || {}; this.rng = makeRng(opts.seed == null ? 1 : opts.seed);
      this.lookAhead = 240; this.minGap = 18; this.maxGap = 42; this.targetChance = 0.55;
      this.halfWidth = HALF_WIDTH; this.startZ = 40; this.groundBag = buildBag(GROUND);
      this.frontier = this.startZ; this._id = 0; this.nextZ = this.startZ + this._gap();
    }
    Course.prototype._gap = function () { return this.minGap + this.rng() * (this.maxGap - this.minGap); };
    Course.prototype._spawnAt = function (z) {
      var biome = biomeAt(z); this._id += 1; var roll = this.rng(); var ent;
      if (roll < this.targetChance) {
        var def = this.groundBag[Math.min(this.groundBag.length - 1, Math.floor(this.rng() * this.groundBag.length))];
        var isCar = (biome !== 'open') && (this.rng() < 0.28);
        var x = (this.rng() * 2 - 1) * (this.halfWidth - 2);
        ent = { id: 'e' + this._id, kind: isCar ? 'CAR' : 'GOER', biome: biome, x: x, y: 0, z: z, r: isCar ? 9 : def.r, points: isCar ? 150 : def.points, golden: isCar ? (this.rng() < 0.12) : def.golden, splatted: false };
        if (isCar) ent.vx = (this.rng() < 0.5 ? -1 : 1) * (4 + this.rng() * 6);
      } else {
        var obBag = buildBag(eligible(OBST, biome));
        var od = obBag[Math.min(obBag.length - 1, Math.floor(this.rng() * obBag.length))];
        var ox = (this.rng() * 2 - 1) * (this.halfWidth - 2);
        var oy = (od.kind === 'BUILDING' || od.kind === 'POLE') ? 0 : (od.kind === 'BALLOON' ? 14 + this.rng() * 30 : 8 + this.rng() * 28);
        ent = { id: 'e' + this._id, kind: od.kind, biome: biome, x: ox, y: oy, z: z, r: od.r, solid: true };
        if (od.gapHalf != null) { ent.gapHalf = od.gapHalf; ent.rimHalf = od.rimHalf; }
        if (od.kind === 'BUILDING') ent.h = 24 + this.rng() * 30;
        if (od.kind === 'POLE') ent.h = 16 + this.rng() * 20;
        if (od.mover) { ent.vx = (this.rng() < 0.5 ? -1 : 1) * (4 + this.rng() * 8); ent.mover = true; }
      }
      return ent;
    };
    Course.prototype.step = function (camZ) {
      var spawned = [], limit = camZ + this.lookAhead;
      while (this.nextZ <= limit) { spawned.push(this._spawnAt(this.nextZ)); this.frontier = this.nextZ; this.nextZ += this._gap(); }
      return spawned;
    };
    function Payload(opts) { opts = opts || {}; this.x = opts.x || 0; this.y = opts.y == null ? 0 : opts.y; this.z = opts.z || 0; this.vy = opts.vy || 0; this.vz = opts.vz == null ? 26 : opts.vz; this.g = opts.g == null ? GRAVITY : opts.g; this.landed = false; this.landX = null; this.landZ = null; }
    Payload.prototype.update = function (dt) {
      if (this.landed) return false; var y0 = this.y; this.vy += this.g * dt; var yNew = y0 + this.vy * dt;
      if (yNew > 0) { this.y = yNew; this.z += this.vz * dt; return false; }
      var vyStart = this.vy - this.g * dt; var a = 0.5 * this.g, b = vyStart, cc = y0; var frac = dt; var disc = b * b - 4 * a * cc;
      if (a !== 0 && disc >= 0) { var sq = Math.sqrt(disc); var t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a); var cand = null; if (t1 >= 0 && t1 <= dt) cand = t1; if (t2 >= 0 && t2 <= dt && (cand == null || t2 < cand)) cand = t2; if (cand != null) frac = cand; }
      else if (vyStart < 0 && y0 > 0) frac = y0 / -vyStart;
      frac = clamp(frac, 0, dt); this.z += this.vz * frac; this.y = 0; this.landed = true; this.landX = this.x; this.landZ = this.z; return true;
    };
    function resolveLanding(x, z, splatRadius, targets) {
      var best = null;
      for (var i = 0; i < targets.length; i++) {
        var t = targets[i]; if (!t || t.splatted) continue; if (t.kind !== 'GOER' && t.kind !== 'CAR') continue;
        var dx = x - t.x, dz = z - t.z; var d = Math.sqrt(dx * dx + dz * dz);
        var pts = scoreForDrop(d, t.r, splatRadius, !!t.golden, t.points); if (pts <= 0) continue;
        if (best === null || pts > best.points || (pts === best.points && d < best.dist)) best = { target: t, points: pts, dist: d };
      }
      return best;
    }
    function collides(bird, ent, birdR, zTol) {
      if (!ent || ent.splatted) return false;
      if (ent.kind === 'GOER' || ent.kind === 'CAR' || ent.kind === 'GATE' || ent.kind === 'CHECKPOINT') return false;
      zTol = zTol == null ? 3 : zTol; birdR = birdR == null ? 2.2 : birdR;
      var dz = Math.abs(bird.z - ent.z); if (dz > zTol + ent.r) return false;
      var dx = bird.x - ent.x, dy = bird.y - ent.y;
      if (ent.gapHalf != null) { if (Math.abs(dx) < ent.gapHalf && Math.abs(dy) < ent.gapHalf) return false; var planar = Math.sqrt(dx * dx + dy * dy); return planar <= ent.rimHalf && dz <= zTol; }
      if (ent.kind === 'BUILDING') { if (Math.abs(dx) > ent.r) return false; if (bird.y > (ent.h || 24)) return false; return dz <= zTol + 1; }
      if (ent.kind === 'POLE') { if (bird.y > (ent.h || 24)) return false; return Math.abs(dx) <= ent.r + birdR && dz <= zTol; }
      var d3 = Math.sqrt(dx * dx + dy * dy); return d3 <= ent.r + birdR && dz <= zTol + ent.r;
    }
    function buildGates(opts) {
      opts = opts || {}; var rng = makeRng(opts.seed == null ? 1 : opts.seed);
      var count = opts.count == null ? 12 : opts.count, spacing = opts.spacing == null ? 70 : opts.spacing, startZ = opts.startZ == null ? 60 : opts.startZ;
      var half = opts.halfWidth == null ? HALF_WIDTH : opts.halfWidth, gapHalf = opts.gapHalf == null ? 7 : opts.gapHalf, kind = opts.kind || 'GATE'; var gates = [];
      for (var i = 0; i < count; i++) { var z = startZ + i * spacing; gates.push({ id: kind.toLowerCase() + '-' + i, kind: kind, index: i, x: (rng() * 2 - 1) * (half - gapHalf - 2), y: 10 + rng() * 26, z: z, r: gapHalf + 4, gapHalf: gapHalf, passed: false, missed: false, cleared: false }); }
      return gates;
    }
    var MODES = {
      free: { id: 'free', name: 'FREE FLIGHT', hearts: 3, iframes: 1.4, timeCap: 90, hasTargets: true, hasObstacles: true, gates: false, checkpoints: false },
      slalom: { id: 'slalom', name: 'SLALOM', hearts: 0, iframes: 0, gateCount: 14, gatePenalty: 2, gates: true, checkpoints: false, hasTargets: false, hasObstacles: true, bestKey: 'topgoose.slalom.best' },
      timetrial: { id: 'timetrial', name: 'TIME TRIAL', hearts: 0, iframes: 0, checkpointCount: 10, checkpoints: true, gates: false, hasTargets: false, hasObstacles: true, bestKey: 'topgoose.timetrial.best' }
    };
    function modeConfig(id) { return MODES[id] || MODES.free; }
    function initModeState(modeId, opts) {
      opts = opts || {}; var cfg = modeConfig(modeId); var HealthCtor = opts.Health || core.Health; var seed = opts.seed == null ? 1 : opts.seed;
      return {
        mode: cfg.id, name: cfg.name, cfg: cfg, elapsed: 0, penalty: 0, finished: false,
        health: (cfg.hearts > 0 && HealthCtor) ? new HealthCtor({ hearts: cfg.hearts, iframes: cfg.iframes }) : null,
        gates: cfg.gates ? buildGates({ seed: seed, count: cfg.gateCount, kind: 'GATE', halfWidth: opts.halfWidth, gapHalf: opts.gapHalf }) : [],
        checkpoints: cfg.checkpoints ? buildGates({ seed: seed, count: cfg.checkpointCount, kind: 'CHECKPOINT', spacing: 80, halfWidth: opts.halfWidth, gapHalf: 12 }) : [],
        nextGate: 0, nextCheckpoint: 0, cleared: 0, missed: 0
      };
    }
    function tickFree(state, dt) { state.elapsed += dt; if (state.cfg.timeCap && state.elapsed >= state.cfg.timeCap) { state.finished = true; return true; } return false; }
    function registerHazard(state) { if (!state.health) return 'none'; var res = state.health.hit(); if (res === 'gameover') state.finished = true; return res; }
    function tickSlalom(state, dt, bird, prevZ) {
      state.elapsed += dt; var out = { cleared: 0, missed: 0, penaltyAdded: 0, events: [] }; var curZ = bird.z;
      for (var i = 0; i < state.gates.length; i++) { var g = state.gates[i]; if (g.passed) continue; if (prevZ < g.z && curZ >= g.z) { g.passed = true; var clean = Math.abs(bird.x - g.x) <= g.gapHalf && Math.abs(bird.y - g.y) <= g.gapHalf; if (clean) { g.cleared = true; state.cleared += 1; out.cleared += 1; out.events.push({ gate: g, clean: true }); } else { g.missed = true; state.missed += 1; out.missed += 1; state.penalty += state.cfg.gatePenalty; out.penaltyAdded += state.cfg.gatePenalty; out.events.push({ gate: g, clean: false }); } } }
      if (state.cleared + state.missed >= state.gates.length && state.gates.length > 0) state.finished = true; return out;
    }
    function tickTimeTrial(state, dt, bird, prevZ) {
      state.elapsed += dt; var out = { cleared: 0, events: [] }; var curZ = bird.z;
      for (var i = 0; i < state.checkpoints.length; i++) { var c = state.checkpoints[i]; if (c.passed) continue; if (prevZ < c.z && curZ >= c.z) { c.passed = true; c.cleared = true; state.cleared += 1; out.cleared += 1; out.events.push({ checkpoint: c }); } }
      if (state.cleared >= state.checkpoints.length && state.checkpoints.length > 0) state.finished = true; return out;
    }
    function finalTime(state) { return state.elapsed + (state.penalty || 0); }
    function evaluateBest(prevBest, newTime) { var improved = (prevBest == null) || (newTime < prevBest); return { best: improved ? newTime : prevBest, improved: improved }; }
    return {
      HALF_WIDTH: HALF_WIDTH, GRAVITY: GRAVITY, BIOMES: BIOMES, BAND_LEN: BAND_LEN, MODES: MODES,
      biomeAt: biomeAt, bandProgressAt: bandProgressAt, Course: Course, buildBag: buildBag,
      Payload: Payload, resolveLanding: resolveLanding, collides: collides, buildGates: buildGates,
      modeConfig: modeConfig, initModeState: initModeState, tickFree: tickFree, registerHazard: registerHazard,
      tickSlalom: tickSlalom, tickTimeTrial: tickTimeTrial, finalTime: finalTime, evaluateBest: evaluateBest
    };
  }

  // ── Convenience handles (engine-or-fallback) ─────────────────────────
  function project(p, cam, view) { return CORE.project(p, cam, view); }
  function buildCamera(bird, view) { return CORE.buildCamera(bird, view); }
  function depthSort(items) { return CORE.depthSort ? CORE.depthSort(items) : items.slice().sort(function (a, b) { return b.depth - a.depth; }); }
  function biomeAt(z) { return WORLD.biomeAt ? WORLD.biomeAt(z) : 'open'; }
  function bandProgress(z) { return WORLD.bandProgressAt ? WORLD.bandProgressAt(z) : 0; }
  function formatTime(s) { return CORE.formatTime ? CORE.formatTime(s) : ('' + (Math.round(s * 100) / 100)); }
  function rankForScore(s) { return CORE.rankForScore ? CORE.rankForScore(s) : { name: 'Goose' }; }

  function biomeTint(b) {
    if (b === 'park') return { ground: '#2f6b3a', far: '#264d2b' };
    if (b === 'city') return { ground: '#3a3f4a', far: '#262a33' };
    return { ground: '#4a6a4d', far: '#36513a' };
  }
  function skyCols(b) {
    if (b === 'city') return { top: '#2a3550', mid: '#5a6e8c' };
    if (b === 'park') return { top: '#2f5e8c', mid: '#86c9e6' };
    return { top: '#3a6ea5', mid: '#7ec8e3' };
  }
  // Cross-fade two hex colors by t (0..1).
  function mixHex(a, b, t) {
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    var ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
    var br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
    var r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  // ══════════════════════════════════════════════════════════════════
  //  GAME STATE
  // ══════════════════════════════════════════════════════════════════
  function newGame(modeId) {
    modeId = modeId || MODE_ORDER[modeIdx];
    var seed = 1337;
    var modeState = WORLD.initModeState(modeId, { seed: seed, Health: CORE.Health, halfWidth: HALF_WIDTH });
    var bird = new BIRD.Bird({ x: 0, y: 24, z: 0 });
    var course = new WORLD.Course({ seed: seed, halfWidth: HALF_WIDTH });
    return {
      mode: modeId,
      modeName: modeState.name || modeName(modeId),
      cfg: modeState.cfg,
      ms: modeState,             // engine mode state (elapsed/penalty/health/gates...)
      bird: bird,
      course: course,
      prevZ: bird.z,
      entities: [],
      payloads: [],
      decals: [],
      particles: [],
      speedLines: [],
      floats: [],
      toasts: [],
      score: new CORE.ScoreKeeper(),
      biome: 'open',
      result: null,
      birdR: 2.4                 // bird's hurt radius for collisions
    };
  }

  function startPlay() { game = newGame(MODE_ORDER[modeIdx]); screen = 'play'; }

  function toast(text) { if (game) game.toasts.push({ text: text, t: 2.0 }); }
  function floatText(sx, sy, text, color) { if (game) game.floats.push({ x: sx, y: sy, text: text, color: color || '#fff', t: 1.1 }); }
  function shakeNow(mag) { if (mag > 0 && mag > shakeMag - 0.001) { shakeT = 0.35; shakeMag = mag; } }
  function burstAt(sx, sy, n, color) {
    if (!game) return;
    for (var i = 0; i < n; i++) { var a = Math.random() * Math.PI * 2, sp = 60 * (0.4 + Math.random()); game.particles.push({ x: sx, y: sy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30, t: 0, life: 0.4 + Math.random() * 0.5, r: 2 + Math.random() * 3, color: color || '#fff' }); }
  }

  // ── input -> steering vector (normalized [-1,1]) ──
  function steerInput() {
    var ix = 0, iy = 0;
    if (keys.arrowleft || keys.a) ix -= 1;
    if (keys.arrowright || keys.d) ix += 1;
    if (keys.arrowup || keys.w) iy += 1;     // up = climb (+Y)
    if (keys.arrowdown || keys.s) iy -= 1;
    if (pointer.active && ix === 0 && iy === 0) {
      ix = clamp((pointer.x - pointer.baseX) / (W * 0.3), -1, 1);
      iy = clamp((pointer.baseY - pointer.y) / (H * 0.3), -1, 1);
    }
    return { x: ix, y: iy };
  }

  // ══════════════════════════════════════════════════════════════════
  //  UPDATE
  // ══════════════════════════════════════════════════════════════════
  function update(dt) {
    titleT += dt;
    if (shakeT > 0) shakeT -= dt;
    if (game) tickEphemeral(dt);
    if (screen === 'play') updatePlay(dt);
  }

  function tickEphemeral(dt) {
    var i;
    for (i = game.floats.length - 1; i >= 0; i--) { game.floats[i].t -= dt; game.floats[i].y -= 26 * dt; if (game.floats[i].t <= 0) game.floats.splice(i, 1); }
    for (i = game.toasts.length - 1; i >= 0; i--) { game.toasts[i].t -= dt; if (game.toasts[i].t <= 0) game.toasts.splice(i, 1); }
    for (i = game.particles.length - 1; i >= 0; i--) { var pa = game.particles[i]; pa.t += dt; pa.x += pa.vx * dt; pa.y += pa.vy * dt; pa.vy += 180 * dt; pa.vx *= (1 - 1.4 * dt); if (pa.t >= pa.life) game.particles.splice(i, 1); }
    for (i = game.speedLines.length - 1; i >= 0; i--) { game.speedLines[i].t -= dt; if (game.speedLines[i].t <= 0) game.speedLines.splice(i, 1); }
    for (i = game.decals.length - 1; i >= 0; i--) { if (game.decals[i].z < game.bird.z - 30) game.decals.splice(i, 1); }
  }

  function updatePlay(dt) {
    var g = game;
    g.prevZ = g.bird.z;

    // ── Flight ──
    g.bird.update(dt, steerInput());
    g.biome = biomeAt(g.bird.z);
    if (g.ms.health) g.ms.health.update(dt);

    // ── Mode clock / markers (engine owns the rules) ──
    if (g.cfg.id === 'free') {
      if (WORLD.tickFree(g.ms, dt)) { endRound('timecap'); return; }
    } else if (g.cfg.id === 'slalom') {
      var so = WORLD.tickSlalom(g.ms, dt, g.bird, g.prevZ);
      reportGateEvents(so);
      if (g.ms.finished) { endRound('finish'); return; }
    } else if (g.cfg.id === 'timetrial') {
      var to = WORLD.tickTimeTrial(g.ms, dt, g.bird, g.prevZ);
      if (to && to.cleared) toast('CHECKPOINT');
      if (g.ms.finished) { endRound('finish'); return; }
    }

    // Cosmetic speed lines while steering hard.
    var input = steerInput();
    if ((Math.abs(input.x) > 0.3 || Math.abs(input.y) > 0.3) && Math.random() < 0.5) {
      g.speedLines.push({ side: input.x >= 0 ? 1 : -1, y: (H * HORIZON_FRAC) + Math.random() * (H * 0.5), t: 0.25 });
    }

    // ── Spawn course entities ahead (camZ = bird.z) ──
    var fresh = g.course.step(g.bird.z);
    for (var s = 0; s < fresh.length; s++) g.entities.push(fresh[s]);

    // ── Advance movers + cull entities well behind the camera ──
    for (var e = g.entities.length - 1; e >= 0; e--) {
      var ent = g.entities[e];
      if (ent.vx) ent.x += ent.vx * dt;
      if (ent.z < g.bird.z - 14) g.entities.splice(e, 1);
    }

    // ── Obstacle collisions (engine collides()) ──
    resolveCollisions();

    // ── Payloads (poop ballistics) ──
    updatePayloads(dt);

    // ── Combo decay (only while a target is on screen ahead) ──
    g.score.tick(dt, anyTargetAhead());

    // ── Survival end ──
    if (g.ms.finished && g.cfg.id === 'free') { endRound('dead'); return; }
  }

  function reportGateEvents(so) {
    if (!so || !so.events) return;
    for (var i = 0; i < so.events.length; i++) {
      var ev = so.events[i];
      if (ev.clean) toast('GATE ' + (ev.gate.index + 1));
      else { toast('MISS! +' + (game.cfg.gatePenalty || 2) + 's'); shakeNow(6); }
    }
  }

  function anyTargetAhead() {
    if (!game) return false;
    for (var i = 0; i < game.entities.length; i++) { var e = game.entities[i]; if ((e.kind === 'GOER' || e.kind === 'CAR') && !e.splatted && e.z > game.bird.z) return true; }
    return false;
  }

  // Obstacle collisions via the engine's collides(). Free Flight: lose a heart.
  // Races: +time penalty. Either way: i-frames + flash + shake, never score.
  function resolveCollisions() {
    var g = game;
    var invuln = g.ms.health ? g.ms.health.invulnerable() : (g._raceInvuln > 0);
    if (invuln) return;
    for (var i = 0; i < g.entities.length; i++) {
      var e = g.entities[i];
      if (e.hit) continue;
      if (WORLD.collides(g.bird, e, g.birdR)) { e.hit = true; takeHit(); return; }
    }
  }

  function takeHit() {
    var g = game; var res;
    if (g.cfg.id === 'free') {
      res = WORLD.registerHazard(g.ms);
      if (res === 'shrugged') return;
      g.bird.flapPhase += 0;
    } else {
      // Races: no hearts — clipping costs time. Manual i-frame window.
      g._raceInvuln = 1.0;
      g.ms.penalty += 1.5;
      res = 'penalty';
    }
    g.hurtFlash = 0.4;
    shakeNow(8);
    if (g.cfg.id === 'free') toast(res === 'gameover' ? 'DOWN!' : 'HIT! -1 heart');
    else toast('CLIP! +1.5s');
  }

  // ── Poop ballistics (engine Payload + resolveLanding) ──
  function dropPayload() {
    if (screen !== 'play' || !game) return;
    var g = game;
    var p = new WORLD.Payload({ x: g.bird.x, y: g.bird.y, z: g.bird.z, vy: 0, vz: g.bird.speed });
    p.splatR = 2.6;
    g.payloads.push(p);
  }

  function updatePayloads(dt) {
    var g = game;
    if (g._raceInvuln > 0) g._raceInvuln -= dt;
    for (var i = g.payloads.length - 1; i >= 0; i--) {
      var p = g.payloads[i];
      var landed = p.update(dt);
      if (landed || p.landed) { landPayload(p); g.payloads.splice(i, 1); }
    }
  }

  // On land: engine scans ground targets via resolveLanding. Empty ground =
  // free (no miss, combo intact). Always a decal.
  function landPayload(p) {
    var g = game;
    var splatR = p.splatR || 2.6;
    var lx = p.landX != null ? p.landX : p.x;
    var lz = p.landZ != null ? p.landZ : p.z;
    var best = WORLD.resolveLanding(lx, lz, splatR, g.entities);
    g.decals.push({ x: lx, z: lz, r: splatR, t: 0, golden: best && best.target.golden });
    if (best) {
      best.target.splatted = true;
      var awarded = g.score.registerHit(best.points);
      if (best.target.kind === 'CAR') { g.score.addBonus(50); awarded += 50; }
      var cam = buildCamera(g.bird, viewAt(viewIdx));
      var sp = project({ x: best.target.x, y: 0, z: best.target.z }, cam, viewAt(viewIdx));
      if (sp && sp.visible) { floatText(sp.sx, sp.sy, '+' + awarded, best.target.golden ? '#ffd34d' : '#9fe6ff'); burstAt(sp.sx, sp.sy, 10, '#caa15a'); }
      toast('SPLAT +' + awarded + (g.score.combo > 1 ? '  x' + g.score.combo : ''));
    }
    // No registerMiss for empty ground — the contract's free-poop rule.
  }

  function endRound(reason) {
    if (!game) return;
    var g = game;
    // Resolve any in-flight payloads before the run ends.
    while (g.payloads.length) { var p = g.payloads[0]; if (!p.landed) { p.y = 0; p.landed = true; p.landX = p.x; p.landZ = p.z; } landPayload(p); g.payloads.shift(); }

    var result = { mode: g.modeName, modeName: g.modeName, reason: reason, score: g.score.score, bestCombo: g.score.bestCombo, rank: rankForScore(g.score.score).name, distance: g.bird.z };
    if (g.cfg.id !== 'free') {
      var time = WORLD.finalTime(g.ms);
      result.time = time;
      var key = g.cfg.bestKey || ('topgoose.' + g.cfg.id + '.best');
      var prev = loadBest(key);
      var ev = WORLD.evaluateBest(prev, time);
      result.bestTime = ev.best;
      result.newBest = ev.improved;
      if (ev.improved) saveBest(key, time);
      result.cleared = g.ms.cleared;
      result.missed = g.ms.missed;
    }
    g.result = result;
    screen = 'rank';
  }

  function loadBest(key) { try { if (!window.localStorage) return null; var v = window.localStorage.getItem(key); return v == null ? null : parseFloat(v); } catch (e) { return null; } }
  function saveBest(key, v) { try { if (window.localStorage) window.localStorage.setItem(key, '' + v); } catch (e) {} }

  // ══════════════════════════════════════════════════════════════════
  //  RENDER
  // ══════════════════════════════════════════════════════════════════
  function draw() {
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    if (crashed) { drawCrash(); ctx.restore(); return; }
    if (screen === 'title') drawTitle();
    else if (screen === 'play' || screen === 'paused') { drawPlay(); if (screen === 'paused') drawPaused(); }
    else if (screen === 'rank') drawRank();
    ctx.restore();
  }

  function drawPlay() {
    var g = game;
    var view = viewAt(viewIdx);
    var cam = buildCamera(g.bird, view);

    var ox = 0, oy = 0;
    if (shakeT > 0) { var m = shakeMag * (shakeT / 0.35); ox = (Math.random() - 0.5) * m; oy = (Math.random() - 0.5) * m; }

    // BOMBARDIER: top-down bombsight — its own overhead render path.
    if (view.topDown && CORE.projectTop) {
      ctx.save();
      ctx.translate(ox, oy);
      drawPlayTopDown(g, cam, view);
      ctx.restore();
      drawHUD(g, view);
      drawFloatsAndToasts(g);
      return;
    }

    ctx.save();
    ctx.translate(ox, oy);

    // Whole scene BANKS: rotate around (W/2, horizonY) by cam.bank.
    ctx.save();
    ctx.translate(W / 2, cam.horizonY);
    ctx.rotate(cam.bank);
    ctx.translate(-W / 2, -cam.horizonY);

    drawSky(cam, g.biome, g.bird.z);
    drawGround(cam, view, g);
    drawSceneEntities(cam, view, g);
    drawDecals(cam, view, g);
    drawAimReticle(cam, view, g);   // where a poop dropped NOW would land
    drawPayloads(cam, view, g);
    if (view.id !== 'pov') drawBird(g, cam, view);

    ctx.restore(); // end bank rotate

    drawSpeedLines(g);
    if (view.id === 'pov') drawCockpit(g);
    drawParticles(g);

    ctx.restore(); // end shake

    drawHUD(g, view);
    drawFloatsAndToasts(g);
  }

  // ── BOMBARDIER (top-down bombsight) render path ───────────────────────
  function drawPlayTopDown(g, cam, view) {
    var MZ = CORE.MZ || 7;
    var bx = W / 2, by = H * 0.72;   // bird's fixed screen spot (overhead)

    var tint = biomeTint(g.biome);
    ctx.fillStyle = tint.ground;
    ctx.fillRect(0, 0, W, H);

    // Course band down the middle (the flyable width).
    var roadL = bx - HALF_WIDTH * MZ, roadR = bx + HALF_WIDTH * MZ;
    ctx.fillStyle = mixHex(tint.ground, '#ffffff', 0.06);
    ctx.fillRect(roadL, 0, roadR - roadL, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(roadL, 0); ctx.lineTo(roadL, H);
    ctx.moveTo(roadR, 0); ctx.lineTo(roadR, H); ctx.stroke();

    // Scrolling cross-grid (forward = up the screen) for speed sense.
    var phase = ((g.bird.z % 6) * MZ);
    ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = 1;
    for (var gy = (by % (6 * MZ)) + phase; gy < H; gy += 6 * MZ) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }

    // Ground splat decals.
    var d, dp;
    for (d = 0; d < g.decals.length; d++) {
      dp = CORE.projectTop({ x: g.decals[d].x, y: 0, z: g.decals[d].z }, cam);
      if (!dp.visible) continue;
      ctx.fillStyle = 'rgba(92,70,40,0.5)';
      ctx.beginPath(); ctx.arc(dp.sx, dp.sy, Math.max(3, (g.decals[d].r || 2) * MZ * 0.6), 0, Math.PI * 2); ctx.fill();
    }

    // Entities + race markers as overhead footprints, far-first.
    var draws = [], i, e, pr;
    for (i = 0; i < g.entities.length; i++) {
      e = g.entities[i];
      pr = CORE.projectTop({ x: e.x, y: 0, z: e.z }, cam);
      if (!pr.visible) continue;
      draws.push({ ent: e, pr: pr, depth: pr.depth });
    }
    var markers = g.cfg.id === 'slalom' ? g.ms.gates : (g.cfg.id === 'timetrial' ? g.ms.checkpoints : []);
    for (i = 0; i < markers.length; i++) {
      pr = CORE.projectTop({ x: markers[i].x, y: 0, z: markers[i].z }, cam);
      if (!pr.visible) continue;
      draws.push({ ent: markers[i], pr: pr, depth: pr.depth });
    }
    draws.sort(function (a, b) { return b.depth - a.depth; });
    for (i = 0; i < draws.length; i++) paintEntityTop(draws[i].ent, draws[i].pr, MZ);

    drawAimReticle(cam, view, g);   // predicted landing crosshair (top-down)

    // Poop reticle — the live payload's ground position, so you lead the drop.
    for (i = 0; i < g.payloads.length; i++) {
      pr = CORE.projectTop({ x: g.payloads[i].x, y: 0, z: g.payloads[i].z }, cam);
      if (!pr.visible) continue;
      var fall = g.payloads[i].y > 0.3;
      ctx.fillStyle = '#6b4f2a';
      ctx.beginPath(); ctx.arc(pr.sx, pr.sy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = fall ? 'rgba(255,255,255,0.5)' : 'rgba(255,90,90,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(pr.sx, pr.sy, 11, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pr.sx - 15, pr.sy); ctx.lineTo(pr.sx + 15, pr.sy);
      ctx.moveTo(pr.sx, pr.sy - 15); ctx.lineTo(pr.sx, pr.sy + 15); ctx.stroke();
    }

    drawBirdTop(g, bx, by);
  }

  // Flat bullseye / footprint per entity kind, seen from above.
  function paintEntityTop(e, pr, MZ) {
    var x = pr.sx, y = pr.sy, r = (e.r || 6) * MZ, k = e.kind;
    if (k === 'GOER' || k === 'CAR') {
      var rings = e.splatted ? ['#8a8a8a', '#bbb', '#8a8a8a'] : (e.golden ? ['#e0a93f', '#fff4d0', '#e0a93f'] : ['#d33', '#fff', '#d33']);
      var rr = Math.max(7, r);
      var radii = [rr, rr * 0.66, rr * 0.33], ci;
      for (ci = 0; ci < 3; ci++) { ctx.fillStyle = rings[ci]; ctx.beginPath(); ctx.arc(x, y, radii[ci], 0, Math.PI * 2); ctx.fill(); }
      if (e.splatted) { ctx.fillStyle = '#6b4f2a'; ctx.beginPath(); ctx.arc(x + rr * 0.3, y - rr * 0.3, rr * 0.4, 0, Math.PI * 2); ctx.fill(); }
    } else if (k === 'RING' || k === 'ARCH' || k === 'GATE' || k === 'CHECKPOINT') {
      ctx.strokeStyle = e.passed ? 'rgba(120,220,120,0.85)' : (k === 'GATE' || k === 'CHECKPOINT' ? '#ffd23f' : '#9fd0ff');
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(x, y, Math.max(10, (e.gapHalf != null ? e.gapHalf : (e.r || 8)) * MZ), 0, Math.PI * 2); ctx.stroke();
    } else if (k === 'BUILDING') {
      ctx.fillStyle = '#6b6f7a'; ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.strokeStyle = '#1d1d28'; ctx.lineWidth = 2; ctx.strokeRect(x - r, y - r, r * 2, r * 2);
    } else if (k === 'POLE') {
      ctx.fillStyle = '#3a3d46'; ctx.beginPath(); ctx.arc(x, y, Math.max(3, r * 0.5), 0, Math.PI * 2); ctx.fill();
    } else { // BALLOON / RIVAL — airborne; show with a soft shadow + body
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.arc(x, y + 4, Math.max(6, r * 0.7), 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = k === 'RIVAL' ? '#4a4a52' : '#d05a6e';
      ctx.beginPath(); ctx.arc(x, y, Math.max(5, r * 0.65), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#1d1d28'; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  // The player bird from directly above: body + two flapping wings, banked.
  function drawBirdTop(g, bx, by) {
    var flap = Math.sin(g.bird.flapPhase || 0);
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate((g.bird.bankAngle || 0) * 0.6);
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(0, 8, 14, 7, 0, 0, Math.PI * 2); ctx.fill();
    // wings (flap = vertical spread seen as length from above)
    var wl = 16 + flap * 8;
    ctx.fillStyle = '#e9eef2'; ctx.strokeStyle = '#1d1d28'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(-12, 0, 7, wl, -0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(12, 0, 7, wl, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // body
    ctx.fillStyle = '#cfd6db';
    ctx.beginPath(); ctx.ellipse(0, 0, 8, 13, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // beak (points forward = up)
    ctx.fillStyle = '#f2a33c';
    ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(-3, -19); ctx.lineTo(3, -19); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawSky(cam, biome, z) {
    var cur = skyCols(biome);
    // cross-fade toward the NEXT biome's sky as we approach the band edge.
    var prog = bandProgress(z);
    var nextBiome = biome === 'open' ? 'park' : biome === 'park' ? 'city' : 'open';
    var nxt = skyCols(nextBiome);
    var f = prog > 0.8 ? (prog - 0.8) / 0.2 : 0;
    var top = mixHex(cur.top, nxt.top, f), mid = mixHex(cur.mid, nxt.mid, f);

    var grad = ctx.createLinearGradient(0, -H, 0, cam.horizonY);
    grad.addColorStop(0, top); grad.addColorStop(1, mid);
    ctx.fillStyle = grad;
    ctx.fillRect(-W, -H, W * 3, cam.horizonY + H);

    var sun = ctx.createRadialGradient(W * 0.66, cam.horizonY - 60, 8, W * 0.66, cam.horizonY - 60, 160);
    sun.addColorStop(0, 'rgba(255,244,210,0.55)'); sun.addColorStop(1, 'rgba(255,244,210,0)');
    ctx.fillStyle = sun; ctx.fillRect(-W, -H, W * 3, cam.horizonY + 120);

    var haze = ctx.createLinearGradient(0, cam.horizonY - 40, 0, cam.horizonY);
    haze.addColorStop(0, 'rgba(255,255,255,0)'); haze.addColorStop(1, 'rgba(255,255,255,0.28)');
    ctx.fillStyle = haze; ctx.fillRect(-W, cam.horizonY - 40, W * 3, 40);
  }

  function drawGround(cam, view, g) {
    var cur = biomeTint(g.biome);
    var prog = bandProgress(g.bird.z);
    var nextBiome = g.biome === 'open' ? 'park' : g.biome === 'park' ? 'city' : 'open';
    var nxt = biomeTint(nextBiome);
    var f = prog > 0.8 ? (prog - 0.8) / 0.2 : 0;
    var farCol = mixHex(cur.far, nxt.far, f), groundCol = mixHex(cur.ground, nxt.ground, f);

    var grad = ctx.createLinearGradient(0, cam.horizonY, 0, H + 100);
    grad.addColorStop(0, farCol); grad.addColorStop(1, groundCol);
    ctx.fillStyle = grad;
    ctx.fillRect(-W, cam.horizonY, W * 3, H + 100 - cam.horizonY);

    // Perspective cross-lines (world Z lines) scrolling toward the camera.
    var baseZ = Math.floor(g.bird.z);
    for (var i = 1; i <= 22; i++) {
      var wz = baseZ + i * 6 - (g.bird.z - baseZ);
      var pr = project({ x: 0, y: 0, z: wz }, cam, view);
      if (!pr.visible) continue;
      ctx.strokeStyle = 'rgba(255,255,255,' + (clamp(1 - (i / 22), 0.08, 0.5) * 0.4).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-W, pr.sy); ctx.lineTo(W * 2, pr.sy); ctx.stroke();
    }
    // Converging road edges.
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 2;
    for (var s = -1; s <= 1; s += 2) {
      ctx.beginPath(); var moved = false;
      for (var j = 0; j <= 18; j++) {
        var pr2 = project({ x: s * HALF_WIDTH, y: 0, z: g.bird.z + 2 + j * 7 }, cam, view);
        if (!pr2.visible) continue;
        if (!moved) { ctx.moveTo(pr2.sx, pr2.sy); moved = true; } else ctx.lineTo(pr2.sx, pr2.sy);
      }
      if (moved) ctx.stroke();
    }
    // Center dashed lane stripe scrolling.
    var stripePhase = (g.bird.z % 12);
    for (var d = 0; d < 14; d++) {
      var a = project({ x: 0, y: 0, z: g.bird.z + 4 + d * 12 - stripePhase }, cam, view);
      var b = project({ x: 0, y: 0, z: g.bird.z + 9 + d * 12 - stripePhase }, cam, view);
      if (!a.visible || !b.visible) continue;
      ctx.strokeStyle = 'rgba(255,235,150,' + clamp(0.5 - d * 0.03, 0.05, 0.5).toFixed(3) + ')';
      ctx.lineWidth = Math.max(1, a.scale * 0.3);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
    }
  }

  function drawSceneEntities(cam, view, g) {
    var draws = [];
    var i, e, pr;
    for (i = 0; i < g.entities.length; i++) {
      e = g.entities[i];
      pr = project({ x: e.x, y: e.y, z: e.z }, cam, view);
      if (!pr.visible || pr.sx < -160 || pr.sx > W + 160) continue;
      draws.push({ ent: e, pr: pr, depth: pr.depth });
    }
    // Race markers (gates/checkpoints) from the engine's mode state.
    var markers = g.cfg.id === 'slalom' ? g.ms.gates : (g.cfg.id === 'timetrial' ? g.ms.checkpoints : []);
    for (i = 0; i < markers.length; i++) {
      var m = markers[i];
      pr = project({ x: m.x, y: m.y, z: m.z }, cam, view);
      if (!pr.visible || pr.sx < -160 || pr.sx > W + 160) continue;
      draws.push({ ent: m, pr: pr, depth: pr.depth });
    }
    var sorted = depthSort(draws);
    for (var k = 0; k < sorted.length; k++) paintEntity(sorted[k].ent, sorted[k].pr, cam, view, g);
  }

  function groundShadow(x, z, r, cam, view) {
    var sp = project({ x: x, y: 0, z: z }, cam, view);
    if (!sp || !sp.visible) return;
    var rr = Math.max(2, r * sp.scale * 0.5);
    ctx.save(); ctx.globalAlpha = 0.28; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(sp.sx, sp.sy, rr, rr * 0.4, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }

  function paintEntity(e, pr, cam, view, g) {
    var sc = pr.scale;
    switch (e.kind) {
      case 'GOER': case 'CAR': groundShadow(e.x, e.z, e.r, cam, view); paintTarget(e, pr, sc); break;
      case 'POLE': paintPole(e, pr, cam, view, sc); break;
      case 'BUILDING': paintBuilding(e, pr, cam, view, sc); break;
      case 'ARCH': case 'RING': paintRing(e, pr, sc, false); break;
      case 'GATE': paintRing(e, pr, sc, true); break;
      case 'CHECKPOINT': paintRing(e, pr, sc, true); break;
      case 'BALLOON': paintBalloon(e, pr, sc); break;
      case 'RIVAL': paintRival(e, pr, sc); break;
      default: break;
    }
  }

  function paintTarget(e, pr, sc) {
    var R = Math.max(3, e.r * sc);
    if (e.kind === 'CAR') {
      // Car: a rounded body with a windshield sheen.
      var cg = ctx.createLinearGradient(pr.sx - R, pr.sy - R, pr.sx + R, pr.sy + R);
      cg.addColorStop(0, e.splatted ? '#5a4a3a' : '#d24b4b'); cg.addColorStop(1, e.splatted ? '#3a2f22' : '#7a2424');
      ctx.fillStyle = cg;
      roundRect(pr.sx - R, pr.sy - R * 0.5, R * 2, R, Math.max(2, R * 0.3)); ctx.fill();
      ctx.fillStyle = 'rgba(180,220,255,0.6)'; roundRect(pr.sx - R * 0.5, pr.sy - R * 0.4, R, R * 0.4, 2); ctx.fill();
      return;
    }
    var grad = ctx.createRadialGradient(pr.sx - R * 0.3, pr.sy - R * 0.3, R * 0.1, pr.sx, pr.sy, R);
    if (e.splatted) { grad.addColorStop(0, '#6b5a3a'); grad.addColorStop(1, '#3c3322'); }
    else if (e.golden) { grad.addColorStop(0, '#fff0b0'); grad.addColorStop(1, '#d9a31f'); }
    else { grad.addColorStop(0, '#ff8a8a'); grad.addColorStop(1, '#b13a3a'); }
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(pr.sx, pr.sy, R, 0, Math.PI * 2); ctx.fill();
    if (!e.splatted) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = Math.max(1, R * 0.12);
      ctx.beginPath(); ctx.arc(pr.sx, pr.sy, R * 0.6, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(pr.sx, pr.sy, R * 0.22, 0, Math.PI * 2); ctx.fill();
    }
  }

  function paintPole(e, pr, cam, view, sc) {
    var base = project({ x: e.x, y: 0, z: e.z }, cam, view);
    var top = project({ x: e.x, y: e.h || 16, z: e.z }, cam, view);
    if (!base.visible || !top.visible) return;
    var wpx = Math.max(2, (e.r || 2.2) * sc);
    var grad = ctx.createLinearGradient(base.sx - wpx, 0, base.sx + wpx, 0);
    grad.addColorStop(0, '#555a66'); grad.addColorStop(0.5, '#8a909c'); grad.addColorStop(1, '#3e424c');
    ctx.fillStyle = e.hit ? '#7a3a3a' : grad;
    ctx.fillRect(base.sx - wpx / 2, top.sy, wpx, base.sy - top.sy);
    ctx.fillStyle = '#ffe9a0'; ctx.beginPath(); ctx.arc(top.sx, top.sy, wpx * 1.2, 0, Math.PI * 2); ctx.fill();
  }

  function paintBuilding(e, pr, cam, view, sc) {
    var base = project({ x: e.x, y: 0, z: e.z }, cam, view);
    var top = project({ x: e.x, y: e.h || 24, z: e.z }, cam, view);
    if (!base.visible || !top.visible) return;
    var wpx = Math.max(6, (e.r || 14) * sc * 1.4);
    var hpx = base.sy - top.sy;
    var grad = ctx.createLinearGradient(base.sx - wpx / 2, 0, base.sx + wpx / 2, 0);
    grad.addColorStop(0, '#4a5160'); grad.addColorStop(0.5, '#6b7384'); grad.addColorStop(1, '#363b46');
    ctx.fillStyle = e.hit ? '#7a3a3a' : grad;
    ctx.fillRect(base.sx - wpx / 2, top.sy, wpx, hpx);
    ctx.fillStyle = 'rgba(255,235,150,0.45)';
    var cols = Math.max(2, Math.floor(wpx / 12)), rows = Math.max(2, Math.floor(hpx / 16));
    for (var c = 0; c < cols; c++) for (var r = 0; r < rows; r++) {
      if ((c + r + (e.id ? e.id.length : 0)) % 3 === 0) continue;
      ctx.fillRect(base.sx - wpx / 2 + 4 + c * (wpx / cols), top.sy + 4 + r * (hpx / rows), Math.max(2, wpx / cols - 5), Math.max(2, hpx / rows - 6));
    }
  }

  function paintRing(e, pr, sc, isMarker) {
    var R = Math.max(8, (e.rimHalf || e.r || 12) * sc);
    var gap = (e.gapHalf || 6) * sc;
    var col = e.cleared || e.passed && !e.missed ? '#5bd66b' : (e.missed || e.hit ? '#d65b5b' : (isMarker ? '#ffd34d' : '#cfd6e0'));
    ctx.save();
    ctx.lineWidth = Math.max(3, R - gap);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.arc(pr.sx + 2, pr.sy + 2, (R + gap) / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = col;
    ctx.beginPath(); ctx.arc(pr.sx, pr.sy, (R + gap) / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = Math.max(1, R * 0.06); ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath(); ctx.arc(pr.sx, pr.sy, gap, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  function paintBalloon(e, pr, sc) {
    var R = Math.max(4, e.r * sc);
    var grad = ctx.createRadialGradient(pr.sx - R * 0.35, pr.sy - R * 0.4, R * 0.1, pr.sx, pr.sy, R);
    grad.addColorStop(0, '#ff9ad1'); grad.addColorStop(1, e.hit ? '#7a3a5a' : '#c2417f');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.ellipse(pr.sx, pr.sy, R * 0.86, R, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pr.sx, pr.sy + R); ctx.lineTo(pr.sx, pr.sy + R * 1.8); ctx.stroke();
  }

  function paintRival(e, pr, sc) {
    var R = Math.max(3, e.r * sc);
    var flap = Math.sin(titleT * 9 + (e.z || 0));
    ctx.fillStyle = e.hit ? '#7a3a3a' : '#43484f';
    ctx.beginPath(); ctx.ellipse(pr.sx, pr.sy, R * 0.7, R * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = e.hit ? '#7a3a3a' : '#2a2e34'; ctx.lineWidth = Math.max(1.5, R * 0.2);
    ctx.beginPath();
    ctx.moveTo(pr.sx - R * 1.4, pr.sy - flap * R * 0.6); ctx.lineTo(pr.sx, pr.sy); ctx.lineTo(pr.sx + R * 1.4, pr.sy - flap * R * 0.6);
    ctx.stroke();
  }

  function drawDecals(cam, view, g) {
    for (var i = 0; i < g.decals.length; i++) {
      var d = g.decals[i];
      var pr = project({ x: d.x, y: 0, z: d.z }, cam, view);
      if (!pr.visible) continue;
      var R = Math.max(2, d.r * pr.scale * 0.6);
      ctx.save(); ctx.globalAlpha = 0.8; ctx.fillStyle = d.golden ? '#b08a2a' : '#5a4a2a';
      ctx.beginPath(); ctx.ellipse(pr.sx, pr.sy, R, R * 0.4, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
  }

  function drawPayloads(cam, view, g) {
    for (var i = 0; i < g.payloads.length; i++) {
      var p = g.payloads[i];
      var air = project({ x: p.x, y: p.y, z: p.z }, cam, view);
      var gnd = project({ x: p.x, y: 0, z: p.z }, cam, view);
      if (gnd && gnd.visible) { ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = '#000'; var sr = Math.max(1, (p.splatR || 2.6) * gnd.scale * 0.3); ctx.beginPath(); ctx.ellipse(gnd.sx, gnd.sy, sr, sr * 0.4, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
      if (air && air.visible) {
        var R = Math.max(2, (p.splatR || 2.6) * air.scale * 0.4);
        var grad = ctx.createRadialGradient(air.sx - R * 0.3, air.sy - R * 0.3, R * 0.1, air.sx, air.sy, R);
        grad.addColorStop(0, '#cdbb8a'); grad.addColorStop(1, '#6b5a32');
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(air.sx, air.sy, R, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function drawBird(g, cam, view) {
    var pr = project({ x: g.bird.x, y: g.bird.y, z: g.bird.z + 0.01 }, cam, view);
    var sx = pr.visible ? pr.sx : W / 2;
    var sy = pr.visible ? pr.sy : (cam.horizonY + 80);
    var sc = view.id === 'chase-far' ? 24 : 34;

    var gnd = project({ x: g.bird.x, y: 0, z: g.bird.z + 0.01 }, cam, view);
    if (gnd && gnd.visible) { ctx.save(); ctx.globalAlpha = 0.3; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(gnd.sx, gnd.sy, sc * 0.7, sc * 0.22, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }

    var flap = Math.sin(g.bird.flapPhase) * 0.9;
    var hurt = (g.hurtFlash > 0) && (Math.floor(g.hurtFlash * 20) % 2 === 0);

    ctx.save();
    ctx.translate(sx, sy);
    var body = ctx.createLinearGradient(0, -sc * 0.5, 0, sc * 0.5);
    if (hurt) { body.addColorStop(0, '#ffb0b0'); body.addColorStop(1, '#cc5a5a'); }
    else { body.addColorStop(0, '#f4f6f8'); body.addColorStop(1, '#b8c0c8'); }
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(0, 0, sc * 0.55, sc * 0.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = hurt ? '#cc5a5a' : '#e8edf0';
    ctx.beginPath(); ctx.arc(0, -sc * 0.32, sc * 0.26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f4a01e';
    ctx.beginPath(); ctx.moveTo(-sc * 0.06, -sc * 0.34); ctx.lineTo(sc * 0.06, -sc * 0.34); ctx.lineTo(0, -sc * 0.5); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = hurt ? '#cc5a5a' : '#9aa3ad'; ctx.lineWidth = Math.max(2, sc * 0.12); ctx.lineCap = 'round';
    var wy = -flap * sc * 0.5;
    ctx.beginPath(); ctx.moveTo(-sc * 0.5, 0); ctx.quadraticCurveTo(-sc * 0.95, wy, -sc * 1.2, wy * 0.6 + sc * 0.05); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sc * 0.5, 0); ctx.quadraticCurveTo(sc * 0.95, wy, sc * 1.2, wy * 0.6 + sc * 0.05); ctx.stroke();
    ctx.fillStyle = hurt ? '#cc5a5a' : '#cdd4da';
    ctx.beginPath(); ctx.moveTo(sc * 0.5, sc * 0.1); ctx.lineTo(sc * 0.85, sc * 0.05); ctx.lineTo(sc * 0.5, sc * 0.3); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawCockpit(g) {
    var flap = Math.sin(g.bird.flapPhase) * 18;
    var hurt = (g.hurtFlash > 0) && (Math.floor(g.hurtFlash * 20) % 2 === 0);
    ctx.save();
    var bg = ctx.createLinearGradient(0, H, 0, H - 120);
    bg.addColorStop(0, '#e89a1c'); bg.addColorStop(1, 'rgba(232,154,28,0)');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.moveTo(W * 0.5 - 60, H); ctx.lineTo(W * 0.5, H - 110); ctx.lineTo(W * 0.5 + 60, H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = hurt ? 'rgba(255,140,140,0.85)' : 'rgba(220,226,232,0.85)';
    ctx.beginPath(); ctx.moveTo(0, H - 40 + flap); ctx.quadraticCurveTo(W * 0.22, H - 120 + flap, W * 0.36, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(W, H - 40 + flap); ctx.quadraticCurveTo(W * 0.78, H - 120 + flap, W * 0.64, H); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    var vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function drawSpeedLines(g) {
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 2;
    for (var i = 0; i < g.speedLines.length; i++) {
      var s = g.speedLines[i];
      var x = s.side > 0 ? W - 30 - (1 - s.t / 0.25) * 40 : 30 + (1 - s.t / 0.25) * 40;
      ctx.globalAlpha = clamp(s.t / 0.25, 0, 1) * 0.5;
      ctx.beginPath(); ctx.moveTo(x, s.y); ctx.lineTo(x + s.side * 30, s.y + 6); ctx.stroke();
    }
    ctx.restore();
  }

  function drawParticles(g) {
    for (var i = 0; i < g.particles.length; i++) { var p = g.particles[i]; ctx.globalAlpha = clamp(1 - p.t / p.life, 0, 1); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
  }

  // ── HUD ──
  // Where a poop dropped RIGHT NOW would hit the ground. The poop falls from
  // the bird's altitude (g = -32 → fall time t = sqrt(y/16)) while it keeps
  // drifting forward at the bird's speed, so it lands AHEAD by speed*t.
  // Climbing pushes the landing further forward — this is what makes altitude
  // matter and visible, and it's the aiming aid for timing/placement.
  function aimLanding(g) {
    var b = g.bird;
    var t = Math.sqrt(Math.max(0, b.y) / 16);
    return { x: b.x, z: b.z + b.speed * t, t: t };
  }

  function drawAimReticle(cam, view, g) {
    if (g.bird.y <= 0.1) return;
    var L = aimLanding(g);
    var pr = view.topDown ? CORE.projectTop({ x: L.x, y: 0, z: L.z }, cam)
                          : project({ x: L.x, y: 0, z: L.z }, cam, view);
    if (!pr || !pr.visible) return;
    var rad = view.topDown ? 14 : clamp(pr.scale * 1.4, 7, 60);
    var pulse = 0.55 + 0.45 * Math.sin(titleT * 7);
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = '#ffe14d';
    ctx.lineWidth = view.topDown ? 2 : Math.max(2, pr.scale * 0.4);
    ctx.beginPath(); ctx.arc(pr.sx, pr.sy, rad, 0, Math.PI * 2); ctx.stroke();
    // crosshair ticks
    ctx.beginPath();
    ctx.moveTo(pr.sx - rad * 1.6, pr.sy); ctx.lineTo(pr.sx - rad * 0.6, pr.sy);
    ctx.moveTo(pr.sx + rad * 0.6, pr.sy); ctx.lineTo(pr.sx + rad * 1.6, pr.sy);
    ctx.moveTo(pr.sx, pr.sy - rad * 1.6); ctx.lineTo(pr.sx, pr.sy - rad * 0.6);
    ctx.moveTo(pr.sx, pr.sy + rad * 0.6); ctx.lineTo(pr.sx, pr.sy + rad * 1.6);
    ctx.stroke();
    ctx.restore();
  }

  function drawHUD(g, view) {
    ctx.save();
    ctx.textBaseline = 'top';
    drawAltGauge(g);
    drawControlHints(g, view);
    if (g.ms.health) {
      for (var i = 0; i < g.ms.health.maxHearts; i++) drawHeart(16 + i * 26, 16, 9, i < g.ms.health.hearts);
    }
    ctx.textAlign = 'right';
    ctx.font = '700 22px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#fff';
    ctx.fillText('' + g.score.score, W - 14, 14);
    if (g.score.combo > 1) { ctx.font = '700 14px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#ffd34d'; ctx.fillText('x' + g.score.combo, W - 14, 40); }
    ctx.textAlign = 'center';
    ctx.font = '700 18px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#cfe8ff';
    if (g.cfg.id === 'free') ctx.fillText(formatTime(Math.max(0, (g.cfg.timeCap || 90) - g.ms.elapsed)), W / 2, 16);
    else ctx.fillText(formatTime(WORLD.finalTime(g.ms)), W / 2, 16);
    ctx.textAlign = 'left';
    ctx.font = '700 11px ui-monospace, Menlo, monospace'; ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(g.modeName, 14, H - 30);
    ctx.fillStyle = '#7fd6ff'; ctx.fillText('VIEW: ' + (view.name || view.id), 14, H - 16);
    if (g.cfg.id === 'slalom') { ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillText('GATES ' + g.ms.cleared + '/' + g.ms.gates.length, W - 14, H - 16); }
    else if (g.cfg.id === 'timetrial') { ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillText('CP ' + g.ms.cleared + '/' + g.ms.checkpoints.length, W - 14, H - 16); }
    ctx.restore();
  }

  // Altitude gauge on the left edge — makes climb/dive visible (the bird
  // barely moves on screen, so without this you can't tell altitude changes).
  function drawAltGauge(g) {
    var x = 16, y0 = 70, h = H * 0.34;
    var lo = 4, hi = 60; // groundClear .. ceiling
    var frac = clamp((g.bird.y - lo) / (hi - lo), 0, 1);
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(x, y0, 7, h);
    ctx.fillStyle = '#7fd6ff'; ctx.fillRect(x, y0 + h * (1 - frac), 7, h * frac);
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '700 9px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('ALT', x - 2, y0 - 3);
    ctx.textBaseline = 'top'; ctx.fillText('↑↓', x - 1, y0 + h + 4);
    ctx.restore();
  }

  // Discoverability: a prominent control banner for the first ~7s of a run,
  // then a small persistent reminder that C switches views (→ BOMBSIGHT for
  // aiming). Solves "I didn't know how to change altitude / cameras."
  function drawControlHints(g, view) {
    ctx.save();
    ctx.textAlign = 'center';
    var early = g.ms.elapsed < 7;
    if (early) {
      var a = g.ms.elapsed < 6 ? 1 : (7 - g.ms.elapsed);
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.fillStyle = 'rgba(10,14,24,0.55)';
      ctx.fillRect(W / 2 - 168, H - 96, 336, 58);
      ctx.fillStyle = '#fff'; ctx.font = '700 12px ui-monospace, Menlo, monospace';
      ctx.fillText('←→ STEER   ↑↓ ALTITUDE   SPACE POOP', W / 2, H - 88);
      ctx.fillStyle = '#ffe14d';
      ctx.fillText('press  C  to change camera', W / 2, H - 70);
      ctx.fillStyle = '#7fd6ff';
      ctx.fillText('try BOMBSIGHT to see your targets ↓', W / 2, H - 54);
    } else if (view.id !== 'bombardier') {
      ctx.globalAlpha = 0.7; ctx.fillStyle = '#ffe14d';
      ctx.font = '700 10px ui-monospace, Menlo, monospace';
      ctx.fillText('C: camera — try BOMBSIGHT to aim', W / 2, H - 44);
    }
    ctx.restore();
  }

  function drawHeart(x, y, r, filled) {
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = filled ? '#ff5a6e' : 'rgba(255,90,110,0.25)';
    ctx.beginPath();
    ctx.moveTo(0, r * 0.3);
    ctx.bezierCurveTo(-r, -r * 0.6, -r * 0.4, -r * 1.2, 0, -r * 0.4);
    ctx.bezierCurveTo(r * 0.4, -r * 1.2, r, -r * 0.6, 0, r * 0.3);
    ctx.fill(); ctx.restore();
  }

  function drawFloatsAndToasts(g) {
    ctx.save(); ctx.textAlign = 'center';
    for (var i = 0; i < g.floats.length; i++) { var f = g.floats[i]; ctx.globalAlpha = clamp(f.t, 0, 1); ctx.font = '700 18px ui-monospace, Menlo, monospace'; ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y); }
    ctx.globalAlpha = 1;
    for (var j = 0; j < g.toasts.length; j++) { var t = g.toasts[j]; ctx.globalAlpha = clamp(t.t, 0, 1); ctx.font = '700 15px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#fff'; ctx.fillText(t.text, W / 2, 120 + j * 22); }
    ctx.globalAlpha = 1; ctx.restore();
  }

  // ══════════════════════════════════════════════════════════════════
  //  SCREENS
  // ══════════════════════════════════════════════════════════════════
  function drawTitle() {
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#1a2f55'); grad.addColorStop(0.5, '#3a6ea5'); grad.addColorStop(1, '#7ec8e3');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    var sun = ctx.createRadialGradient(W * 0.7, H * 0.3, 10, W * 0.7, H * 0.3, 180);
    sun.addColorStop(0, 'rgba(255,244,210,0.7)'); sun.addColorStop(1, 'rgba(255,244,210,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 0, W, H * 0.6);
    ctx.fillStyle = '#3a6b3f'; ctx.fillRect(0, H * 0.7, W, H * 0.3);

    var bx = W / 2 + Math.sin(titleT * 0.8) * 90;
    var by = H * 0.4 + Math.cos(titleT * 1.1) * 24;
    ctx.save(); ctx.translate(bx, by); ctx.rotate(Math.sin(titleT * 0.8) * 0.3);
    var flap = Math.sin(titleT * 8);
    ctx.fillStyle = '#f4f6f8'; ctx.beginPath(); ctx.ellipse(0, 0, 22, 15, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e8edf0'; ctx.beginPath(); ctx.arc(0, -12, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f4a01e'; ctx.beginPath(); ctx.moveTo(-3, -14); ctx.lineTo(3, -14); ctx.lineTo(0, -22); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#9aa3ad'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-18, 0); ctx.quadraticCurveTo(-40, -flap * 16, -52, -flap * 8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(18, 0); ctx.quadraticCurveTo(40, -flap * 16, 52, -flap * 8); ctx.stroke();
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff'; ctx.font = '800 46px ui-monospace, Menlo, monospace'; ctx.fillText('TOP', W / 2, H * 0.12);
    ctx.fillStyle = '#ffd34d'; ctx.fillText('GOOSE', W / 2, H * 0.12 + 46);
    ctx.font = '700 13px ui-monospace, Menlo, monospace'; ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('fly · bank · poop · dodge', W / 2, H * 0.12 + 96);

    ctx.font = '700 13px ui-monospace, Menlo, monospace'; ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('SELECT MODE  (← →)', W / 2, H * 0.56);
    for (var i = 0; i < MODE_ORDER.length; i++) {
      var y = H * 0.56 + 30 + i * 40; var sel = i === modeIdx;
      ctx.fillStyle = sel ? '#ffd34d' : 'rgba(255,255,255,0.18)'; roundRect(W / 2 - 120, y - 14, 240, 32, 8); ctx.fill();
      ctx.fillStyle = sel ? '#1a1a22' : 'rgba(255,255,255,0.85)'; ctx.font = '700 16px ui-monospace, Menlo, monospace';
      ctx.fillText(modeName(MODE_ORDER[i]), W / 2, y - 8);
    }

    ctx.fillStyle = '#fff'; ctx.font = '700 15px ui-monospace, Menlo, monospace';
    if (Math.floor(titleT * 2) % 2 === 0) ctx.fillText('TAP / ENTER TO FLY', W / 2, H * 0.9);
    ctx.font = '700 10px ui-monospace, Menlo, monospace'; ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('C = camera · SPACE = poop · P = pause', W / 2, H * 0.95);
  }

  function drawPaused() {
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = '800 32px ui-monospace, Menlo, monospace';
    ctx.fillText('PAUSED', W / 2, H * 0.42);
    ctx.font = '700 13px ui-monospace, Menlo, monospace'; ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('P resume · R restart', W / 2, H * 0.42 + 40); ctx.restore();
  }

  function drawRank() {
    var g = game; var r = g.result || endResultFallback();
    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#1a2f55'); grad.addColorStop(1, '#0c1018'); ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center'; ctx.fillStyle = '#ffd34d'; ctx.font = '800 30px ui-monospace, Menlo, monospace';
    ctx.fillText(r.modeName, W / 2, H * 0.12);

    if (g.cfg.id !== 'free') {
      ctx.fillStyle = '#fff'; ctx.font = '800 44px ui-monospace, Menlo, monospace'; ctx.fillText(formatTime(r.time), W / 2, H * 0.26);
      ctx.font = '700 14px ui-monospace, Menlo, monospace'; ctx.fillStyle = r.newBest ? '#5bd66b' : 'rgba(255,255,255,0.8)';
      ctx.fillText(r.newBest ? 'NEW BEST!' : 'BEST ' + formatTime(r.bestTime), W / 2, H * 0.26 + 44);
      if (g.cfg.id === 'slalom') { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillText('gates ' + r.cleared + ' · missed ' + r.missed, W / 2, H * 0.26 + 70); }
      else { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillText('checkpoints ' + r.cleared, W / 2, H * 0.26 + 70); }
    } else {
      ctx.fillStyle = '#fff'; ctx.font = '800 52px ui-monospace, Menlo, monospace'; ctx.fillText('' + r.score, W / 2, H * 0.26);
      ctx.font = '700 18px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#9fe6ff'; ctx.fillText(r.rank, W / 2, H * 0.26 + 50);
      ctx.font = '700 14px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#ffd34d'; ctx.fillText('best combo x' + Math.min(r.bestCombo, 5), W / 2, H * 0.26 + 76);
    }

    var b = rankButtons();
    drawButton(b.copy, 'COPY', '#2a7fa7'); drawButton(b.save, 'SAVE', '#2aa77a');

    ctx.fillStyle = '#fff'; ctx.font = '700 14px ui-monospace, Menlo, monospace';
    if (Math.floor(titleT * 2) % 2 === 0) ctx.fillText('TAP / ENTER FOR TITLE', W / 2, H * 0.9);
    ctx.font = '700 10px ui-monospace, Menlo, monospace'; ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('R = fly again · C copy · S save', W / 2, H * 0.95);
  }

  function endResultFallback() { return { modeName: 'RUN', score: game ? game.score.score : 0, bestCombo: 1, rank: 'Goose', time: 0, bestTime: 0, cleared: 0, missed: 0 }; }

  function rankButtons() {
    var bw = 130, bh = 42, gap = 16, y = H * 0.62;
    return { copy: { x: W / 2 - bw - gap / 2, y: y, w: bw, h: bh }, save: { x: W / 2 + gap / 2, y: y, w: bw, h: bh } };
  }

  function drawButton(r, label, color) {
    ctx.fillStyle = color; roundRect(r.x, r.y, r.w, r.h, 10); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '700 16px ui-monospace, Menlo, monospace';
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 - 8);
  }

  function drawCrash() {
    ctx.fillStyle = '#1a1020'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.fillStyle = '#ff6e6e'; ctx.font = '800 28px ui-monospace, Menlo, monospace';
    ctx.fillText('⚠ SPLAT!', W / 2, H * 0.4);
    ctx.fillStyle = '#fff'; ctx.font = '700 14px ui-monospace, Menlo, monospace'; ctx.fillText('the goose hit a snag', W / 2, H * 0.4 + 34);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    if (Math.floor(titleT * 2) % 2 === 0) ctx.fillText('TAP / ENTER TO RESTART', W / 2, H * 0.4 + 70);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ── Share ──
  function shareTextFor(g) {
    var r = g.result || endResultFallback();
    if (CORE.shareText) return CORE.shareText({ mode: r.modeName, score: g.cfg.id === 'free' ? r.score : null, bestCombo: g.cfg.id === 'free' ? r.bestCombo : null, rank: r.rank, time: g.cfg.id === 'free' ? null : r.time, distance: r.distance });
    return 'TOP GOOSE — ' + (g.cfg.id === 'free' ? (r.score + ' pts') : formatTime(r.time));
  }
  function copyResult() {
    if (!game) return; var text = shareTextFor(game);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); toast('COPIED!'); }
      else { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('COPIED!'); } catch (e) {} document.body.removeChild(ta); }
    } catch (e) {}
  }
  function saveCard() {
    if (!canvas) return;
    try { if (canvas.toBlob) { canvas.toBlob(function (blob) { if (!blob) return; var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url; a.download = 'top-goose.png'; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); }, 'image/png'); toast('CARD SAVED!'); } } catch (e) {}
  }

  // ══════════════════════════════════════════════════════════════════
  //  CRASH-PROOF rAF LOOP
  // ══════════════════════════════════════════════════════════════════
  function loop(ts) {
    var dt = Math.min(0.05, (ts - last) / 1000 || 0);
    last = ts;
    try { if (!crashed) update(dt); draw(); }
    catch (err) { crashed = true; if (window.console && console.error) console.error('TOP GOOSE loop error:', err); try { draw(); } catch (e2) {} }
    requestAnimationFrame(loop);
  }

  // ══════════════════════════════════════════════════════════════════
  //  INPUT
  // ══════════════════════════════════════════════════════════════════
  function norm(k) { if (k === ' ' || k === 'Spacebar') return ' '; return (k || '').toLowerCase(); }
  function clearKeys() { keys = {}; pointer.active = false; }
  function togglePause() { if (screen === 'play') screen = 'paused'; else if (screen === 'paused') screen = 'play'; }
  function cycleView() { viewIdx = (viewIdx + 1) % viewCount(); }

  function onKeyDown(e) {
    var k = norm(e.key);
    keys[k] = true;
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].indexOf(k) >= 0 && e.preventDefault) e.preventDefault();
    if (e.repeat) return;

    if (crashed) { if (k === 'enter') { crashed = false; game = null; screen = 'title'; } return; }
    if (screen === 'title') {
      if (k === 'arrowleft' || k === 'a') modeIdx = (modeIdx + MODE_ORDER.length - 1) % MODE_ORDER.length;
      if (k === 'arrowright' || k === 'd') modeIdx = (modeIdx + 1) % MODE_ORDER.length;
      if (k === 'enter') startPlay();
      return;
    }
    if (k === 'enter') { if (screen === 'rank') { game = null; screen = 'title'; } }
    if (k === 'p') togglePause();
    if (k === 'r') { if (screen === 'play' || screen === 'paused' || screen === 'rank') startPlay(); }
    if (k === 'c') cycleView();
    if (k === ' ') dropPayload();
    if (screen === 'rank' && k === 's') saveCard();
  }
  function onKeyUp(e) { keys[norm(e.key)] = false; }

  function canvasPoint(e) {
    var rect = canvas.getBoundingClientRect();
    var cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX) - rect.left;
    var cy = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY) - rect.top;
    return { x: cx * (W / rect.width), y: cy * (H / rect.height) };
  }
  function inRect(pt, r) { return pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h; }

  function onPointerDown(e) {
    var pt = canvasPoint(e);
    if (crashed) { crashed = false; game = null; screen = 'title'; if (e.preventDefault) e.preventDefault(); return; }
    if (screen === 'title') {
      for (var i = 0; i < MODE_ORDER.length; i++) { var y = H * 0.56 + 30 + i * 40; if (inRect(pt, { x: W / 2 - 120, y: y - 14, w: 240, h: 32 })) { modeIdx = i; if (e.preventDefault) e.preventDefault(); return; } }
      startPlay(); if (e.preventDefault) e.preventDefault(); return;
    }
    if (screen === 'rank') {
      var b = rankButtons();
      if (inRect(pt, b.copy)) { copyResult(); if (e.preventDefault) e.preventDefault(); return; }
      if (inRect(pt, b.save)) { saveCard(); if (e.preventDefault) e.preventDefault(); return; }
      game = null; screen = 'title'; if (e.preventDefault) e.preventDefault(); return;
    }
    if (screen === 'play') { pointer.x = pt.x; pointer.y = pt.y; pointer.baseX = pt.x; pointer.baseY = pt.y; pointer.active = true; if (e.preventDefault) e.preventDefault(); }
  }
  function onPointerMove(e) { if (screen !== 'play') return; var pt = canvasPoint(e); pointer.x = pt.x; pointer.y = pt.y; if (pointer.active && e.preventDefault) e.preventDefault(); }
  function onPointerUp() { pointer.active = false; }

  // ══════════════════════════════════════════════════════════════════
  //  WIRING
  // ══════════════════════════════════════════════════════════════════
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearKeys);
  window.addEventListener('visibilitychange', function () { clearKeys(); if (document.hidden && screen === 'play') screen = 'paused'; });

  // Test hook for the headless shell smoke test.
  window.__TG = {
    getScreen: function () { return crashed ? 'crash' : screen; },
    getGame: function () { return game; },
    getView: function () { return viewAt(viewIdx).id; },
    getViewIndex: function () { return viewIdx; },
    cycleView: cycleView,
    selectMode: function (id) { for (var i = 0; i < MODE_ORDER.length; i++) if (MODE_ORDER[i] === id) modeIdx = i; },
    getMode: function () { return MODE_ORDER[modeIdx]; },
    isCrashed: function () { return crashed; },
    forceCrash: function () { crashed = true; },
    getHearts: function () { return game && game.ms && game.ms.health ? game.ms.health.hearts : null; },
    isInvuln: function () { return game && game.ms && game.ms.health ? game.ms.health.invulnerable() : false; },
    clearInvuln: function () { if (game && game.ms && game.ms.health) game.ms.health.invuln = 0; game && (game._raceInvuln = 0); },
    // Force exactly one obstacle collision on the bird (a POLE right on it).
    // The next updatePlay frame registers it deterministically.
    spawnObstacleUnderBird: function (kind) {
      if (!game) return null;
      var b = game.bird;
      var k = (kind || 'POLE').toUpperCase();
      var o = { id: 'test-o', kind: k, biome: 'open', x: b.x, y: 0, z: b.z, r: 4, h: 60, hit: false, solid: true };
      if (k === 'BALLOON' || k === 'RIVAL') { o.y = b.y; } // airborne hitbox on the bird
      game.entities.push(o);
      return o;
    },
    forceEndRound: function (reason) { endRound(reason || 'test'); }
  };

  window.addEventListener('load', function () {
    canvas = document.getElementById('game');
    if (!canvas) return;
    canvas.width = W; canvas.height = H;
    ctx = canvas.getContext('2d');
    canvas.addEventListener('mousedown', onPointerDown);
    canvas.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    canvas.addEventListener('touchstart', onPointerDown, { passive: false });
    canvas.addEventListener('touchmove', onPointerMove, { passive: false });
    canvas.addEventListener('touchend', onPointerUp);
    canvas.addEventListener('touchcancel', onPointerUp);
    requestAnimationFrame(loop);
  });
})();
