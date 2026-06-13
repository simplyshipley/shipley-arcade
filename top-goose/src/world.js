/*
 * TOP GOOSE — world: seeded deterministic course, spawner, biomes, per-mode
 * config/state, and poop ballistics. Pure logic, NO DOM.
 *
 * Loaded by the browser as window.TGWorld and by Node tests via require().
 * Depends on TGCore (makeRng/scoreForDrop/Health/clamp). The course is a
 * z-distance band: entities are spawned AHEAD of the bird and rush toward the
 * camera as camZ advances. Everything is deterministic from a seed so the
 * tests can assert an exact spawn sequence.
 *
 * World axes: X = right, Y = up (ground plane Y=0), Z = forward.
 *
 * Entity kinds (each carries { kind, x, y, z, r, ... }):
 *   ground targets : 'GOER' (park-goer bullseye, Y=0), 'CAR' (moving, bonus)
 *   obstacles      : 'ARCH'/'RING' (fly THROUGH the gap; rim is solid),
 *                    'POLE' (tall thin), 'BUILDING' (wide block, city),
 *                    'BALLOON', 'RIVAL' (rival bird at altitude, drifts)
 *   course markers : 'GATE' (slalom — pass within the gap), 'CHECKPOINT'
 *                    (time trial — fly past)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.TGWorld = factory(root.TGCore);
  }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  var makeRng = (Core && Core.makeRng) || function (seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  var scoreForDrop = (Core && Core.scoreForDrop) || function (d, tr, sr, g, p) {
    var reach = tr + sr; if (d > reach) return 0;
    var base = d <= tr / 3 ? 100 : d <= (tr * 2) / 3 ? 50 : 25;
    var v = base * ((p == null ? 100 : p) / 100); return g ? v * 3 : v;
  };
  var clamp = (Core && Core.clamp) || function (v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  };

  // ── Constants ──────────────────────────────────────────────────────────
  var HALF_WIDTH = 30;        // course half-width (matches bird clamp)
  var GRAVITY = -32;          // poop gravity (u/s²), contract-pinned
  var BIOMES = ['open', 'park', 'city'];
  var BAND_LEN = 600;         // z-units per biome band

  // ── Biome schedule (open -> park -> city, looping) ─────────────────────
  function biomeAt(z) {
    var zz = z < 0 ? 0 : z;
    var idx = Math.floor(zz / BAND_LEN) % BIOMES.length;
    return BIOMES[idx];
  }
  // 0..1 progress through the current band (for shell crossfades).
  function bandProgressAt(z) {
    var zz = z < 0 ? 0 : z;
    return (zz % BAND_LEN) / BAND_LEN;
  }

  // ── Entity catalog (radii / altitudes / point values) ──────────────────
  // Ground targets sit at Y=0. Obstacles sit at flight altitude. RING/ARCH
  // carry a gapHalf: the bird passes if |bird.x - x| < gapHalf AND it's near
  // the ring's z; the rim (outside the gap, within rimHalf) is solid.
  var GROUND_TARGETS = [
    { kind: 'GOER', r: 6, points: 100, golden: false, weight: 3 },
    { kind: 'GOER', r: 7, points: 140, golden: false, weight: 2 },
    { kind: 'GOER', r: 5, points: 170, golden: true, weight: 1 }
  ];
  var OBSTACLES = [
    { kind: 'POLE', r: 2.2, weight: 3, biome: 'both' },
    { kind: 'BUILDING', r: 14, weight: 3, biome: 'city' },
    { kind: 'BALLOON', r: 5, weight: 2, biome: 'open' },
    { kind: 'RIVAL', r: 4, weight: 2, biome: 'both', mover: true },
    { kind: 'ARCH', r: 16, gapHalf: 10, rimHalf: 20, weight: 2, biome: 'park' },
    { kind: 'RING', r: 12, gapHalf: 9, rimHalf: 16, weight: 2, biome: 'both' }
  ];

  function buildBag(list) {
    var bag = [];
    for (var i = 0; i < list.length; i++) {
      var w = list[i].weight || 1;
      for (var k = 0; k < w; k++) bag.push(list[i]);
    }
    return bag;
  }

  // ── Course: the seeded z-distance spawner ──────────────────────────────
  // The course advances by camera z. It keeps a "frontier" z (the farthest z
  // it has spawned to) and, each step(camZ), fills the band [camZ, camZ +
  // lookAhead] with deterministically-placed entities. Because placement is
  // driven purely by the seeded RNG in spawn order, the same seed yields the
  // same course every run (testability).
  function Course(opts) {
    opts = opts || {};
    this.rng = makeRng(opts.seed == null ? 1 : opts.seed);
    this.lookAhead = opts.lookAhead == null ? 240 : opts.lookAhead;
    this.minGap = opts.minGap == null ? 18 : opts.minGap;  // z between spawns
    this.maxGap = opts.maxGap == null ? 42 : opts.maxGap;
    this.targetChance = opts.targetChance == null ? 0.55 : opts.targetChance;
    this.halfWidth = opts.halfWidth == null ? HALF_WIDTH : opts.halfWidth;
    this.startZ = opts.startZ == null ? 40 : opts.startZ; // clear runway ahead
    this.groundBag = buildBag(GROUND_TARGETS);
    this.frontier = this.startZ;
    this.nextZ = this.startZ + this._gap();
    this._id = 0;
    this.cullBehind = opts.cullBehind == null ? 12 : opts.cullBehind;
  }

  Course.prototype._gap = function () {
    return this.minGap + this.rng() * (this.maxGap - this.minGap);
  };

  function eligible(list, biome) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i].biome;
      if (b == null || b === 'both' || b === biome) out.push(list[i]);
    }
    return out.length ? out : list;
  }

  // Spawn one entity at z. Decides target vs obstacle by targetChance and the
  // biome (open sky leans obstacles-light + balloons; city leans buildings).
  Course.prototype._spawnAt = function (z) {
    var biome = biomeAt(z);
    this._id += 1;
    var roll = this.rng();
    var ent;
    if (roll < this.targetChance) {
      // ground target (Y=0). Weighted pick from the ground bag.
      var def = this.groundBag[Math.min(this.groundBag.length - 1,
        Math.floor(this.rng() * this.groundBag.length))];
      // cars only appear in city/park (a road strip); plain goers anywhere.
      var isCar = (biome !== 'open') && (this.rng() < 0.28);
      var x = (this.rng() * 2 - 1) * (this.halfWidth - 2);
      ent = {
        id: 'e' + this._id, kind: isCar ? 'CAR' : 'GOER', biome: biome,
        x: x, y: 0, z: z, r: isCar ? 9 : def.r,
        points: isCar ? 150 : def.points,
        golden: isCar ? (this.rng() < 0.12) : def.golden,
        splatted: false
      };
      if (isCar) {
        // moving car: drives laterally; bonus for leading the shot.
        ent.vx = (this.rng() < 0.5 ? -1 : 1) * (4 + this.rng() * 6);
      }
    } else {
      var obDef = eligible(OBSTACLES, biome);
      var obBag = buildBag(obDef);
      var od = obBag[Math.min(obBag.length - 1, Math.floor(this.rng() * obBag.length))];
      var ox = (this.rng() * 2 - 1) * (this.halfWidth - 2);
      var oy;
      if (od.kind === 'BUILDING' || od.kind === 'POLE') oy = 0; // grounded, tall
      else if (od.kind === 'BALLOON') oy = 14 + this.rng() * 30;
      else oy = 8 + this.rng() * 28;                            // RIVAL/RING/ARCH at altitude
      ent = {
        id: 'e' + this._id, kind: od.kind, biome: biome,
        x: ox, y: oy, z: z, r: od.r, solid: true
      };
      if (od.gapHalf != null) { ent.gapHalf = od.gapHalf; ent.rimHalf = od.rimHalf; }
      if (od.kind === 'BUILDING') ent.h = 24 + this.rng() * 30;
      if (od.kind === 'POLE') ent.h = 16 + this.rng() * 20;
      if (od.mover) {
        ent.vx = (this.rng() < 0.5 ? -1 : 1) * (4 + this.rng() * 8);
        ent.mover = true;
      }
    }
    return ent;
  };

  // Fill the band ahead of camZ. Returns newly spawned entities (deterministic
  // order). Call every frame with the current camera z.
  Course.prototype.step = function (camZ) {
    var spawned = [];
    var limit = camZ + this.lookAhead;
    while (this.nextZ <= limit) {
      var ent = this._spawnAt(this.nextZ);
      spawned.push(ent);
      this.frontier = this.nextZ;
      this.nextZ += this._gap();
    }
    return spawned;
  };

  // ── Poop ballistics (Payload) ──────────────────────────────────────────
  // Spawned at the bird; vy starts ~0; gravity g = -32 u/s²; z advances at the
  // bird's forward speed captured AT DROP TIME; lands when y <= 0. On land we
  // scan ground targets for a ring-scored hit.
  function Payload(opts) {
    opts = opts || {};
    this.x = opts.x || 0;
    this.y = opts.y == null ? 0 : opts.y;
    this.z = opts.z || 0;
    this.vy = opts.vy || 0;                 // starts ~0
    this.vz = opts.vz == null ? 26 : opts.vz; // forward speed at drop time
    this.g = opts.g == null ? GRAVITY : opts.g;
    this.landed = false;
    this.landX = null;
    this.landZ = null;
  }

  // Advance the payload by dt. When it crosses y<=0 it lands; we solve the
  // exact crossing time within the step so the landing (x,z) is precise (not
  // quantized to the frame). Returns true on the frame it lands.
  Payload.prototype.update = function (dt) {
    if (this.landed) return false;
    var y0 = this.y;
    this.vy += this.g * dt;
    var yNew = y0 + this.vy * dt; // (vy already integrated for this step)
    if (yNew > 0) {
      this.y = yNew;
      this.x += 0; // poop keeps the bird's x (no lateral drift)
      this.z += this.vz * dt;
      return false;
    }
    // Crossed the ground this step. Solve the fraction of dt where y hits 0
    // using the pre-step velocity for a stable estimate.
    var vyStart = this.vy - this.g * dt; // velocity at the start of the step
    // y(t) = y0 + vyStart*t + 0.5*g*t^2 = 0, take the first positive root.
    var a = 0.5 * this.g, b = vyStart, cc = y0;
    var frac = dt;
    var disc = b * b - 4 * a * cc;
    if (a !== 0 && disc >= 0) {
      var sq = Math.sqrt(disc);
      var t1 = (-b - sq) / (2 * a);
      var t2 = (-b + sq) / (2 * a);
      var cand = null;
      if (t1 >= 0 && t1 <= dt) cand = t1;
      if (t2 >= 0 && t2 <= dt && (cand == null || t2 < cand)) cand = t2;
      if (cand != null) frac = cand;
    } else if (vyStart < 0 && y0 > 0) {
      frac = y0 / -vyStart; // linear fallback (no gravity term)
    }
    frac = clamp(frac, 0, dt);
    this.z += this.vz * frac;
    this.y = 0;
    this.landed = true;
    this.landX = this.x;
    this.landZ = this.z;
    return true;
  };

  // Scan ground targets for the best ring-scored hit at a landing (x,z) with
  // the given splatRadius. Mirrors the proven resolveSplat shape but in the XZ
  // ground plane. Returns { target, points, dist } or null. `targets` items:
  // { x, z, r, points, golden, splatted, kind }. Only Y=0 ground kinds
  // (GOER/CAR) are scored; obstacles are ignored.
  function resolveLanding(x, z, splatRadius, targets) {
    var best = null;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (!t || t.splatted) continue;
      if (t.kind !== 'GOER' && t.kind !== 'CAR') continue;
      var dx = x - t.x, dz = z - t.z;
      var d = Math.sqrt(dx * dx + dz * dz);
      var pts = scoreForDrop(d, t.r, splatRadius, !!t.golden, t.points);
      if (pts <= 0) continue;
      if (best === null || pts > best.points || (pts === best.points && d < best.dist)) {
        best = { target: t, points: pts, dist: d };
      }
    }
    return best;
  }

  // ── Obstacle collision (XZ proximity + the ring/arch gap-pass) ─────────
  // A collision is true when the bird is at the obstacle's z (within zTol) and
  // close in X/Y. For ARCH/RING the CENTER GAP is safe: passing through the
  // gap (|bird.x - x| < gapHalf and |bird.y - y| < gapHalf) is NOT a hit; only
  // the solid rim (within rimHalf but outside gapHalf) hits. Returns true on
  // collision. birdR is the bird's hurt radius.
  function collides(bird, ent, birdR, zTol) {
    if (!ent || ent.splatted) return false;
    if (ent.kind === 'GOER' || ent.kind === 'CAR') return false; // ground targets never hurt
    if (ent.kind === 'GATE' || ent.kind === 'CHECKPOINT') return false;
    zTol = zTol == null ? 3 : zTol;
    birdR = birdR == null ? 2.2 : birdR;
    var dz = Math.abs(bird.z - ent.z);
    if (dz > zTol + ent.r) return false;       // not at the obstacle's depth yet
    var dx = bird.x - ent.x;
    var dy = bird.y - ent.y;
    if (ent.gapHalf != null) {
      // ring/arch: safe through the gap, solid on the rim.
      var inGap = Math.abs(dx) < ent.gapHalf && Math.abs(dy) < ent.gapHalf;
      if (inGap) return false;
      var planar = Math.sqrt(dx * dx + dy * dy);
      return planar <= ent.rimHalf && dz <= zTol; // hit the rim while at its z
    }
    if (ent.kind === 'BUILDING') {
      // wide block from the ground up to its height; hit if within footprint.
      if (Math.abs(dx) > ent.r) return false;
      if (bird.y > (ent.h || 24)) return false; // flew over the top
      return dz <= zTol + 1;
    }
    if (ent.kind === 'POLE') {
      if (bird.y > (ent.h || 24)) return false; // cleared the top
      return Math.abs(dx) <= ent.r + birdR && dz <= zTol;
    }
    // BALLOON / RIVAL: sphere proximity.
    var d3 = Math.sqrt(dx * dx + dy * dy);
    return d3 <= ent.r + birdR && dz <= zTol + ent.r;
  }

  // ── Slalom gate / time-trial checkpoint ribbon (ordered, seeded) ───────
  // Gates/checkpoints are evenly spaced in z with seeded x/y jitter so the
  // ribbon weaves. Slalom gates carry a gapHalf you must pass within; missing
  // (clipping the rim or skipping) costs +2s. Time-trial checkpoints just need
  // to be flown PAST (z crossed).
  function buildGates(opts) {
    opts = opts || {};
    var rng = makeRng(opts.seed == null ? 1 : opts.seed);
    var count = opts.count == null ? 12 : opts.count;
    var spacing = opts.spacing == null ? 70 : opts.spacing;
    var startZ = opts.startZ == null ? 60 : opts.startZ;
    var half = opts.halfWidth == null ? HALF_WIDTH : opts.halfWidth;
    var gapHalf = opts.gapHalf == null ? 7 : opts.gapHalf;
    var kind = opts.kind || 'GATE';
    var gates = [];
    for (var i = 0; i < count; i++) {
      var z = startZ + i * spacing;
      var x = (rng() * 2 - 1) * (half - gapHalf - 2);
      var y = 10 + rng() * 26;
      gates.push({
        id: kind.toLowerCase() + '-' + i, kind: kind, index: i,
        x: x, y: y, z: z, r: gapHalf + 4, gapHalf: gapHalf,
        passed: false, missed: false, cleared: false
      });
    }
    return gates;
  }

  // Did the bird pass cleanly THROUGH a gate as it crossed the gate's z?
  // Returns 'clean' (within the gap), 'clipped' (crossed but outside the gap),
  // or null (not yet at the gate's z). Call when bird.z transitions past
  // gate.z; uses prevZ to detect the crossing.
  function gateCrossing(gate, prevZ, curZ) {
    if (gate.passed) return null;
    if (!(prevZ < gate.z && curZ >= gate.z)) return null;
    // we can't know the exact x/y at the crossing without interpolation; the
    // caller passes the bird's x/y at curZ which is close enough at game dt.
    return 'crossed';
  }

  // ── Per-mode config + state ────────────────────────────────────────────
  // Three modes share the engine. Each returns a fresh state object the shell
  // mutates each frame via the engine's update helpers.
  var MODES = {
    free: {
      id: 'free', name: 'FREE FLIGHT', hearts: 3, iframes: 1.4,
      timeCap: 90, hasTargets: true, hasObstacles: true,
      gates: false, checkpoints: false
    },
    slalom: {
      id: 'slalom', name: 'SLALOM', hearts: 0, iframes: 0,
      gateCount: 14, gatePenalty: 2, gates: true, checkpoints: false,
      hasTargets: false, hasObstacles: true, bestKey: 'topgoose.slalom.best'
    },
    timetrial: {
      id: 'timetrial', name: 'TIME TRIAL', hearts: 0, iframes: 0,
      checkpointCount: 10, checkpoints: true, gates: false,
      hasTargets: false, hasObstacles: true, bestKey: 'topgoose.timetrial.best'
    }
  };

  function modeConfig(id) { return MODES[id] || MODES.free; }

  // Initialize per-mode runtime state. `Health` is taken from Core (or a
  // passed-in constructor) so the shell doesn't re-implement it.
  function initModeState(modeId, opts) {
    opts = opts || {};
    var cfg = modeConfig(modeId);
    var HealthCtor = opts.Health || (Core && Core.Health);
    var seed = opts.seed == null ? 1 : opts.seed;
    var state = {
      mode: cfg.id,
      name: cfg.name,
      cfg: cfg,
      elapsed: 0,
      penalty: 0,          // accumulated time penalty (slalom)
      finished: false,
      // free-flight hearts
      health: (cfg.hearts > 0 && HealthCtor)
        ? new HealthCtor({ hearts: cfg.hearts, iframes: cfg.iframes })
        : null,
      // race markers
      gates: cfg.gates ? buildGates({
        seed: seed, count: cfg.gateCount, kind: 'GATE',
        halfWidth: opts.halfWidth, gapHalf: opts.gapHalf
      }) : [],
      checkpoints: cfg.checkpoints ? buildGates({
        seed: seed, count: cfg.checkpointCount, kind: 'CHECKPOINT',
        spacing: 80, halfWidth: opts.halfWidth, gapHalf: 12
      }) : [],
      nextGate: 0,
      nextCheckpoint: 0,
      cleared: 0,
      missed: 0
    };
    return state;
  }

  // Free-flight: tick the time cap. Returns true when the run should end
  // (time cap reached). Hearts are handled separately via registerHazard.
  function tickFree(state, dt) {
    state.elapsed += dt;
    if (state.cfg.timeCap && state.elapsed >= state.cfg.timeCap) {
      state.finished = true;
      return true;
    }
    return false;
  }

  // Free-flight: register a hazard collision. Drives Health; returns the
  // Health result ('hit'|'gameover'|'shrugged'|'none'). On 'gameover' the run
  // ends. NEVER touches score.
  function registerHazard(state, dt) {
    if (!state.health) return 'none';
    var res = state.health.hit();
    if (res === 'gameover') state.finished = true;
    return res;
  }

  // Slalom: evaluate gate crossings as the bird advances from prevZ to curZ.
  // For each gate whose z was crossed this step, mark it cleared (clean pass)
  // or missed (+gatePenalty seconds). The clock always runs. Returns a small
  // result { cleared, missed, penaltyAdded } for the frame. The bird's x/y at
  // curZ decide clean vs clipped.
  function tickSlalom(state, dt, bird, prevZ) {
    state.elapsed += dt;
    var out = { cleared: 0, missed: 0, penaltyAdded: 0, events: [] };
    var curZ = bird.z;
    for (var i = 0; i < state.gates.length; i++) {
      var g = state.gates[i];
      if (g.passed) continue;
      if (prevZ < g.z && curZ >= g.z) {
        g.passed = true;
        var dx = Math.abs(bird.x - g.x);
        var dy = Math.abs(bird.y - g.y);
        var clean = dx <= g.gapHalf && dy <= g.gapHalf;
        if (clean) {
          g.cleared = true; state.cleared += 1; out.cleared += 1;
          out.events.push({ gate: g, clean: true });
        } else {
          g.missed = true; state.missed += 1; out.missed += 1;
          state.penalty += state.cfg.gatePenalty;
          out.penaltyAdded += state.cfg.gatePenalty;
          out.events.push({ gate: g, clean: false });
        }
      }
    }
    if (state.cleared + state.missed >= state.gates.length && state.gates.length > 0) {
      state.finished = true;
    }
    return out;
  }

  // Time trial: fly PAST each checkpoint (z crossed). No gap requirement —
  // just progression. Clock runs. Returns { cleared } for the frame.
  function tickTimeTrial(state, dt, bird, prevZ) {
    state.elapsed += dt;
    var out = { cleared: 0, events: [] };
    var curZ = bird.z;
    for (var i = 0; i < state.checkpoints.length; i++) {
      var c = state.checkpoints[i];
      if (c.passed) continue;
      if (prevZ < c.z && curZ >= c.z) {
        c.passed = true; c.cleared = true;
        state.cleared += 1; out.cleared += 1;
        out.events.push({ checkpoint: c });
      }
    }
    if (state.cleared >= state.checkpoints.length && state.checkpoints.length > 0) {
      state.finished = true;
    }
    return out;
  }

  // Final time for a race = elapsed + accumulated penalty.
  function finalTime(state) {
    return state.elapsed + (state.penalty || 0);
  }

  // localStorage-shaped best-time helpers (the shell owns the actual storage;
  // these keep the comparison/format rules in the engine). A lower time wins;
  // returns { best, improved }.
  function evaluateBest(prevBest, newTime) {
    var improved = (prevBest == null) || (newTime < prevBest);
    return { best: improved ? newTime : prevBest, improved: improved };
  }

  return {
    // config
    HALF_WIDTH: HALF_WIDTH, GRAVITY: GRAVITY, BIOMES: BIOMES, BAND_LEN: BAND_LEN,
    GROUND_TARGETS: GROUND_TARGETS, OBSTACLES: OBSTACLES, MODES: MODES,
    // biomes
    biomeAt: biomeAt, bandProgressAt: bandProgressAt,
    // course + entities
    Course: Course, buildBag: buildBag,
    // poop ballistics
    Payload: Payload, resolveLanding: resolveLanding,
    // collision
    collides: collides,
    // race ribbons
    buildGates: buildGates, gateCrossing: gateCrossing,
    // modes
    modeConfig: modeConfig, initModeState: initModeState,
    tickFree: tickFree, registerHazard: registerHazard,
    tickSlalom: tickSlalom, tickTimeTrial: tickTimeTrial,
    finalTime: finalTime, evaluateBest: evaluateBest
  };
});
