/*
 * HOW BIRDS SEE THE WORLD — hazards (v2 dodge layer). Pure data + a small
 * collide() helper + a seeded, distance-keyed hazard spawner. No DOM.
 *
 * v2 turns the pure scoring game into fly-and-survive: the bird must DODGE
 * three hazard families. All hazards scroll DOWN with the world; a collision
 * with the bird's hurtbox (≈60% of the sprite) costs one heart (see
 * core.Health) — never score or combo. The shell draws them; this file owns
 * the data shapes, the math, and the deterministic spawn cadence.
 *
 * The three families (V2-CONTRACT §Hazards):
 *   - signs       — street/park signs on a short post (STOP, ONE WAY, KEEP OFF
 *                   THE GRASS): STATIC, occupy a lane, tall enough to fly
 *                   around not over. Hitbox: AABB (the sign board).
 *   - poles       — lamp posts, flag poles, traffic lights: tall thin
 *                   verticals. STATIC. The lamp head / light is the solid
 *                   hitbox. Hitbox: CIRCLE (the head), centered above the post.
 *   - rival-birds — other birds (pigeon flock, an angry goose, a hawk) that
 *                   MOVE: cross-drift / weave toward the player. Hitbox:
 *                   CIRCLE. A moving hazard the player reads and dodges.
 *
 * Hitbox kinds:
 *   'aabb'   — { hw, hh } half-width/half-height box centered on (x, y)
 *   'circle' — { hr } hit radius centered on (x, y) (poles: head sits at a
 *              fixed offset above the post; that offset is baked into the
 *              instance's hitbox center on spawn)
 *
 * collide(birdHurtbox, hazard): birdHurtbox is a CIRCLE { x, y, r } (the shell
 * passes ≈60% of the sprite radius). hazard is an instance carrying a `box`
 * { kind, x, y, ... }. Returns true on overlap.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      typeof require === 'function' ? require('./core.js') : root.HBCore
    );
  } else {
    root.Hazards = factory(root.HBCore || root.GameCore);
  }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  // makeRng: reuse core's mulberry32 when present so the whole game shares one
  // deterministic RNG family; fall back to an identical local copy otherwise.
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

  // ── HAZARD families (data) ───────────────────────────────────────────
  // `box` describes the hitbox geometry per family. For poles the circular
  // head sits `headOffset` px ABOVE the post anchor (y) — baked into the
  // instance box center at spawn time. `biome` hints where it fits (the shell
  // + terrain decide actual placement); 'both' = either band.
  var HAZARDS = [
    {
      id: 'sign-stop',
      family: 'signs',
      kind: 'static',
      label: 'STOP',
      biome: 'city',
      box: { kind: 'aabb', hw: 22, hh: 22 }, // octagon board, boxed
      postH: 40,
    },
    {
      id: 'sign-oneway',
      family: 'signs',
      kind: 'static',
      label: 'ONE WAY',
      biome: 'city',
      box: { kind: 'aabb', hw: 30, hh: 14 }, // wide rectangle board
      postH: 44,
    },
    {
      id: 'sign-keepoff',
      family: 'signs',
      kind: 'static',
      label: 'KEEP OFF THE GRASS',
      biome: 'park',
      box: { kind: 'aabb', hw: 34, hh: 16 },
      postH: 30,
    },
    {
      id: 'pole-lamp',
      family: 'poles',
      kind: 'static',
      label: 'lamp post',
      biome: 'both',
      // tall thin vertical; the lamp HEAD (a circle) is the solid hitbox.
      box: { kind: 'circle', hr: 16 },
      postH: 92,
      headOffset: 92, // head sits this far above the post base anchor (y)
    },
    {
      id: 'pole-flag',
      family: 'poles',
      kind: 'static',
      label: 'flag pole',
      biome: 'park',
      box: { kind: 'circle', hr: 14 },
      postH: 104,
      headOffset: 104,
    },
    {
      id: 'pole-light',
      family: 'poles',
      kind: 'static',
      label: 'traffic light',
      biome: 'city',
      box: { kind: 'circle', hr: 18 },
      postH: 86,
      headOffset: 86,
    },
    {
      id: 'rival-pigeon',
      family: 'rival-birds',
      kind: 'mover',
      label: 'pigeon flock',
      biome: 'both',
      box: { kind: 'circle', hr: 16 },
      // movers cross-drift / weave; `drift` = base horizontal speed (px/s),
      // `weave` = sinusoidal sway amplitude (px), `weaveHz` = sway frequency.
      drift: 60,
      weave: 26,
      weaveHz: 1.6,
    },
    {
      id: 'rival-goose',
      family: 'rival-birds',
      kind: 'mover',
      label: 'angry goose',
      biome: 'park',
      box: { kind: 'circle', hr: 22 },
      drift: 48,
      weave: 18,
      weaveHz: 1.1,
    },
    {
      id: 'rival-hawk',
      family: 'rival-birds',
      kind: 'mover',
      label: 'hawk',
      biome: 'both',
      box: { kind: 'circle', hr: 20 },
      drift: 96, // fastest — reads as a real threat
      weave: 34,
      weaveHz: 2.2,
    },
  ];

  function byId(id) {
    for (var i = 0; i < HAZARDS.length; i++) {
      if (HAZARDS[i].id === id) return HAZARDS[i];
    }
    return undefined;
  }

  function familyOf(id) {
    var h = byId(id);
    return h ? h.family : undefined;
  }

  // ── collide(birdHurtbox, hazard) → bool ──────────────────────────────
  // birdHurtbox: a CIRCLE { x, y, r }. hazard: an instance with a `box`
  // { kind, x, y, ... } (kind 'aabb' uses hw/hh; 'circle' uses hr). AABB↔circle
  // uses the nearest-point-on-box distance; circle↔circle is center distance.
  // Touching counts as a hit (<=), matching circlesOverlap in core.
  function collide(birdHurtbox, hazard) {
    if (!birdHurtbox || !hazard || !hazard.box) return false;
    var box = hazard.box;
    var bx = birdHurtbox.x, by = birdHurtbox.y, br = birdHurtbox.r;
    if (br == null) br = 0;
    if (box.kind === 'circle') {
      var dx = bx - box.x, dy = by - box.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      return d <= br + (box.hr || 0);
    }
    // AABB: clamp the bird center to the box, measure to the nearest point.
    var minX = box.x - box.hw, maxX = box.x + box.hw;
    var minY = box.y - box.hh, maxY = box.y + box.hh;
    var nx = bx < minX ? minX : (bx > maxX ? maxX : bx);
    var ny = by < minY ? minY : (by > maxY ? maxY : by);
    var ddx = bx - nx, ddy = by - ny;
    return (ddx * ddx + ddy * ddy) <= br * br;
  }

  // Build a hazard INSTANCE from a def at world position (x, y). For poles the
  // hitbox center is lifted to the head (headOffset above the post base). The
  // instance carries enough state for the shell to draw + the sim to move.
  function makeInstance(def, x, y, id) {
    var box = def.box;
    var cx = x;
    var cy = y;
    if (def.family === 'poles') {
      // y is the post BASE anchor; the head/light hitbox sits above it.
      cy = y - (def.headOffset || def.postH || 0);
    }
    var inst = {
      id: id,
      defId: def.id,
      family: def.family,
      kind: def.kind,
      label: def.label,
      biome: def.biome,
      x: x,
      y: y,
      vy: 0, // scroll velocity assigned by the spawner
      box: { kind: box.kind, x: cx, y: cy },
    };
    if (box.kind === 'aabb') { inst.box.hw = box.hw; inst.box.hh = box.hh; }
    else { inst.box.hr = box.hr; }
    inst.boxOffsetX = inst.box.x - x; // keep hitbox glued to the sprite anchor
    inst.boxOffsetY = inst.box.y - y;
    if (def.kind === 'mover') {
      inst.drift = def.drift || 0;
      inst.weave = def.weave || 0;
      inst.weaveHz = def.weaveHz || 0;
      inst.age = 0;
      inst.dir = 1; // set per-spawn by the spawner (cross-drift direction)
    }
    if (def.postH != null) inst.postH = def.postH;
    if (def.label != null) inst.label = def.label;
    return inst;
  }

  // Re-glue a hazard instance's hitbox to its current (x, y) after motion.
  // Movers also weave horizontally; call after advancing position.
  function syncBox(inst) {
    inst.box.x = inst.x + inst.boxOffsetX;
    inst.box.y = inst.y + inst.boxOffsetY;
    return inst;
  }

  // Advance a single hazard instance by dt at world scroll speed. Static
  // hazards scroll straight down; movers also cross-drift + weave. Returns the
  // instance (mutated). Pure: no DOM, deterministic given inputs.
  function stepInstance(inst, dt, scrollSpeed) {
    inst.y += scrollSpeed * dt;
    if (inst.kind === 'mover') {
      inst.age += dt;
      // cross-drift in inst.dir; weave is a sinusoidal sway on top of it.
      var sway = inst.weave
        ? Math.cos(inst.age * inst.weaveHz * Math.PI * 2) * inst.weave * inst.weaveHz * Math.PI * 2 * dt
        : 0;
      inst.x += (inst.drift * inst.dir) * dt + sway;
    }
    syncBox(inst);
    return inst;
  }

  // ── Seeded, distance-keyed spawner ───────────────────────────────────
  // Hazards spawn at the TOP and scroll DOWN. Cadence is keyed to scroll
  // DISTANCE (not wall time) so difficulty tracks how far you've flown and the
  // sequence is reproducible for a seed. Family choice is weighted; movers get
  // a deterministic cross-drift direction + lane. Biome (from terrain.js) can
  // be passed to filter which families fit the current band.
  function HazardSpawner(opts) {
    opts = opts || {};
    this.rng = makeRng(opts.seed == null ? 1 : opts.seed);
    this.worldWidth = opts.worldWidth || 540;
    this.scrollSpeed = opts.scrollSpeed || 90;
    // distance (px) between hazard spawns — randomized in [minGap, maxGap]
    this.minGap = opts.minGap == null ? 220 : opts.minGap;
    this.maxGap = opts.maxGap == null ? 420 : opts.maxGap;
    this.pool = opts.pool || HAZARDS;
    this.distance = 0;            // total scroll distance seen
    this.nextAt = this._gap();    // distance at which the next hazard spawns
    this._id = 0;
  }

  HazardSpawner.prototype._gap = function () {
    return this.minGap + this.rng() * (this.maxGap - this.minGap);
  };

  // Pick a hazard def from the pool, optionally constrained to a biome.
  // 'both' defs are eligible in any biome; if no biome is given, all are.
  HazardSpawner.prototype._eligible = function (biome) {
    if (!biome) return this.pool;
    var out = [];
    for (var i = 0; i < this.pool.length; i++) {
      var d = this.pool[i];
      if (d.biome === biome || d.biome === 'both') out.push(d);
    }
    return out.length ? out : this.pool;
  };

  HazardSpawner.prototype._pick = function (biome) {
    var list = this._eligible(biome);
    if (!list.length) return null;
    var idx = Math.floor(this.rng() * list.length);
    if (idx >= list.length) idx = list.length - 1;
    return list[idx];
  };

  HazardSpawner.prototype._spawn = function (def) {
    var margin = 50;
    var x = margin + this.rng() * (this.worldWidth - margin * 2);
    // Spawn just above the top edge. Poles anchor by their base, so they need
    // extra clearance equal to their height so the head also starts off-screen.
    var topClear = (def.family === 'poles' ? (def.postH || 0) : 30) + 20;
    var y = -topClear;
    this._id += 1;
    var inst = makeInstance(def, x, y, 'hz-' + this._id);
    inst.vy = this.scrollSpeed;
    if (inst.kind === 'mover') {
      // deterministic cross-drift: start near an edge and drift across.
      var fromLeft = this.rng() < 0.5;
      inst.dir = fromLeft ? 1 : -1;
      inst.x = fromLeft ? margin : (this.worldWidth - margin);
      syncBox(inst);
    }
    return inst;
  };

  // Advance the spawner by a scroll DISTANCE delta (px moved this frame).
  // Returns an array of newly spawned hazard instances (possibly empty).
  // `biome` (optional) filters which families are eligible this band.
  HazardSpawner.prototype.advance = function (distanceDelta, biome) {
    var spawned = [];
    this.distance += distanceDelta;
    while (this.distance >= this.nextAt) {
      var def = this._pick(biome);
      if (def) spawned.push(this._spawn(def));
      this.nextAt += this._gap();
    }
    return spawned;
  };

  // Convenience: advance by dt at the spawner's scroll speed (distance = speed
  // * dt). Mirrors the time-keyed API of core.Spawner for callers that prefer
  // a dt-driven loop. Still distance-keyed under the hood.
  HazardSpawner.prototype.update = function (dt, biome) {
    return this.advance(this.scrollSpeed * dt, biome);
  };

  return {
    HAZARDS: HAZARDS,
    byId: byId,
    familyOf: familyOf,
    collide: collide,
    makeInstance: makeInstance,
    syncBox: syncBox,
    stepInstance: stepInstance,
    HazardSpawner: HazardSpawner,
    makeRng: makeRng,
  };
});
