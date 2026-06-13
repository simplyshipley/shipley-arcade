/*
 * HOW BIRDS SEE THE WORLD — terrain (v2 biomes + cars). Pure data/state, no
 * DOM. The shell draws what this file decides; this file owns the biome
 * schedule, the deterministic prop spawner, and the deterministic car spawner
 * + car motion math.
 *
 * v2 world (V2-CONTRACT §Biomes + cars):
 *   - The world alternates PARK and CITY bands as you fly UP — a biome
 *     schedule keyed to scroll DISTANCE, deterministic + alternating. The
 *     FIRST band is PARK (you start in the park, like v1).
 *       PARK: grass, paths, trees, bushes, ponds, fountains, benches.
 *       CITY: roads, sidewalks, crosswalks, buildings, hydrants.
 *   - CARS drive along city road LANES at their OWN speed, moving INDEPENDENT
 *     of the world scroll. They are POOPABLE bonus targets (bullseye on the
 *     roof — see Targets.CAR), NOT dodge hazards (the bird flies above them).
 *     Pooping a moving car is a skill shot: lead it.
 *
 * Everything here is positions / kinds / lanes — no canvas, no Image, no DOM.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      typeof require === 'function' ? require('./core.js') : root.HBCore
    );
  } else {
    root.Terrain = factory(root.HBCore || root.GameCore);
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

  var BIOMES = ['park', 'city'];

  // Length (px of scroll) of one biome band before it flips to the other.
  var DEFAULT_BAND = 1400;

  // Prop catalogs per biome — kinds the shell knows how to paint. Pure labels;
  // the shell maps each kind to a painter. Weighted: heavier kinds appear more.
  var PROPS = {
    park: [
      { kind: 'tree', weight: 3 },
      { kind: 'bush', weight: 3 },
      { kind: 'pond', weight: 1 },
      { kind: 'fountain', weight: 1 },
      { kind: 'bench', weight: 2 },
    ],
    city: [
      { kind: 'building', weight: 3 },
      { kind: 'sidewalk', weight: 2 },
      { kind: 'crosswalk', weight: 1 },
      { kind: 'hydrant', weight: 2 },
    ],
  };

  // ── Biome schedule (deterministic, alternating, by scroll distance) ──
  // Band 0 = PARK, band 1 = CITY, band 2 = PARK … (alternates forever).
  // biomeAt(distance) returns 'park' | 'city'. Negative distance clamps to 0.
  function bandIndexAt(distance, bandLength) {
    bandLength = bandLength || DEFAULT_BAND;
    var d = distance < 0 ? 0 : distance;
    return Math.floor(d / bandLength);
  }

  function biomeForBand(bandIndex) {
    // even band → park, odd band → city (first band is park).
    return BIOMES[((bandIndex % 2) + 2) % 2];
  }

  function biomeAt(distance, bandLength) {
    return biomeForBand(bandIndexAt(distance, bandLength));
  }

  // Fractional progress [0,1) through the CURRENT band at `distance` — handy
  // for the shell's cross-fade when PARK↔CITY changes.
  function bandProgressAt(distance, bandLength) {
    bandLength = bandLength || DEFAULT_BAND;
    var d = distance < 0 ? 0 : distance;
    return (d % bandLength) / bandLength;
  }

  // ── Schedule object (carries the band length + convenience methods) ──
  function BiomeSchedule(opts) {
    opts = opts || {};
    this.bandLength = opts.bandLength || DEFAULT_BAND;
  }
  BiomeSchedule.prototype.bandIndexAt = function (distance) {
    return bandIndexAt(distance, this.bandLength);
  };
  BiomeSchedule.prototype.biomeAt = function (distance) {
    return biomeAt(distance, this.bandLength);
  };
  BiomeSchedule.prototype.progressAt = function (distance) {
    return bandProgressAt(distance, this.bandLength);
  };
  // True if the biome at `b` differs from the biome at `a` (a band flip
  // happened somewhere in (a, b]) — the shell uses this to trigger a crossfade.
  BiomeSchedule.prototype.flipsBetween = function (a, b) {
    return this.biomeAt(a) !== this.biomeAt(b);
  };

  function buildWeightedProps(list) {
    var bag = [];
    for (var i = 0; i < list.length; i++) {
      var w = list[i].weight || 1;
      for (var k = 0; k < w; k++) bag.push(list[i].kind);
    }
    return bag;
  }

  // ── Deterministic prop spawner (distance-keyed) ──────────────────────
  // Emits scenery props at the TOP that scroll DOWN with the world. The kind
  // pool follows the CURRENT biome at the spawn distance. Seeded → identical
  // sequence per seed. Props are pure scenery (no hitbox, no score).
  function PropSpawner(opts) {
    opts = opts || {};
    this.rng = makeRng(opts.seed == null ? 1 : opts.seed);
    this.worldWidth = opts.worldWidth || 540;
    this.scrollSpeed = opts.scrollSpeed || 90;
    this.schedule = opts.schedule || new BiomeSchedule({ bandLength: opts.bandLength });
    this.minGap = opts.minGap == null ? 90 : opts.minGap;  // px between props
    this.maxGap = opts.maxGap == null ? 200 : opts.maxGap;
    this.distance = 0;
    this.nextAt = this._gap();
    this._id = 0;
    this._bags = {
      park: buildWeightedProps(PROPS.park),
      city: buildWeightedProps(PROPS.city),
    };
  }
  PropSpawner.prototype._gap = function () {
    return this.minGap + this.rng() * (this.maxGap - this.minGap);
  };
  PropSpawner.prototype._pick = function (biome) {
    var bag = this._bags[biome] || this._bags.park;
    var idx = Math.floor(this.rng() * bag.length);
    if (idx >= bag.length) idx = bag.length - 1;
    return bag[idx];
  };
  PropSpawner.prototype._spawn = function (kind, biome) {
    var margin = 30;
    var x = margin + this.rng() * (this.worldWidth - margin * 2);
    this._id += 1;
    return {
      id: 'pr-' + this._id,
      kind: kind,
      biome: biome,
      x: x,
      y: -60,
      vy: this.scrollSpeed,
      seed: this.rng(), // a per-prop deterministic variant seed for the shell
    };
  };
  // Advance by scroll distance; returns newly spawned props (possibly empty).
  // The biome is evaluated at the SPAWN distance (nextAt), not the cumulative
  // total, so a prop that appears mid-frame uses the band it actually sits in.
  PropSpawner.prototype.advance = function (distanceDelta) {
    var out = [];
    this.distance += distanceDelta;
    while (this.distance >= this.nextAt) {
      var biome = this.schedule.biomeAt(this.nextAt);
      out.push(this._spawn(this._pick(biome), biome));
      this.nextAt += this._gap();
    }
    return out;
  };
  PropSpawner.prototype.update = function (dt) {
    return this.advance(this.scrollSpeed * dt);
  };

  // ── Cars (city-road moving targets) ──────────────────────────────────
  // Cars only appear in CITY bands. They occupy fixed horizontal LANES and
  // drive along the road at their OWN speed — INDEPENDENT of the world scroll.
  // Motion model: a car carries `driveSpeed` (px/s, the road speed) and rides
  // the scroll too, so its on-screen y advances by (scrollSpeed + driveSpeed)
  // * dt. With scrollSpeed = 0 a car STILL moves (driveSpeed * dt) — that is
  // the "independent of scroll" property the tests pin. Some cars drive UP the
  // road (oncoming) → negative driveSpeed.
  var DEFAULT_LANES = [0.30, 0.46, 0.62, 0.78]; // lane centers as width fractions

  function CarSpawner(opts) {
    opts = opts || {};
    this.rng = makeRng(opts.seed == null ? 1 : opts.seed);
    this.worldWidth = opts.worldWidth || 540;
    this.scrollSpeed = opts.scrollSpeed || 90;
    this.schedule = opts.schedule || new BiomeSchedule({ bandLength: opts.bandLength });
    this.lanes = opts.lanes || DEFAULT_LANES;
    this.minGap = opts.minGap == null ? 260 : opts.minGap; // px between cars
    this.maxGap = opts.maxGap == null ? 520 : opts.maxGap;
    this.minSpeed = opts.minSpeed == null ? 60 : opts.minSpeed;   // own road speed
    this.maxSpeed = opts.maxSpeed == null ? 150 : opts.maxSpeed;
    this.goldenChance = opts.goldenChance == null ? 0.12 : opts.goldenChance;
    this.points = opts.points == null ? 150 : opts.points;
    this.distance = 0;
    this.nextAt = this._gap();
    this._id = 0;
  }
  CarSpawner.prototype._gap = function () {
    return this.minGap + this.rng() * (this.maxGap - this.minGap);
  };
  CarSpawner.prototype._spawn = function () {
    var laneIdx = Math.floor(this.rng() * this.lanes.length);
    if (laneIdx >= this.lanes.length) laneIdx = this.lanes.length - 1;
    var x = this.lanes[laneIdx] * this.worldWidth;
    // direction: most cars drive DOWN the road (same sense as scroll); some
    // oncoming (UP). Oncoming cars also start near the bottom so they climb in.
    var oncoming = this.rng() < 0.4;
    var driveMag = this.minSpeed + this.rng() * (this.maxSpeed - this.minSpeed);
    var driveSpeed = oncoming ? -driveMag : driveMag;
    var golden = this.rng() < this.goldenChance; // convertible
    this._id += 1;
    return {
      id: 'car-' + this._id,
      defId: 'car',
      kind: 'car',
      lane: laneIdx,
      x: x,
      y: oncoming ? 900 : -80, // oncoming starts below, downbound above
      oncoming: oncoming,
      driveSpeed: driveSpeed, // px/s along the road, independent of scroll
      points: this.points,
      golden: golden,
      splatted: false,
      hitCount: 0,
      r: 22, // matches Targets.CAR.radius
    };
  };
  // Advance the spawner by scroll distance; cars spawn ONLY while the current
  // biome is 'city'. Returns newly spawned cars (possibly empty).
  CarSpawner.prototype.advance = function (distanceDelta) {
    var out = [];
    this.distance += distanceDelta;
    while (this.distance >= this.nextAt) {
      // Always consume the same RNG draws so the sequence stays deterministic;
      // only EMIT the car when its SPAWN distance falls in a city band.
      var car = this._spawn();
      if (this.schedule.biomeAt(this.nextAt) === 'city') out.push(car);
      this.nextAt += this._gap();
    }
    return out;
  };
  CarSpawner.prototype.update = function (dt) {
    return this.advance(this.scrollSpeed * dt);
  };

  // Step a single car by dt. The car rides the world scroll AND drives the
  // road at its own speed. driveSpeed is INDEPENDENT of scrollSpeed: pass
  // scrollSpeed = 0 and the car still moves by driveSpeed * dt. Returns the car.
  function stepCar(car, dt, scrollSpeed) {
    if (scrollSpeed == null) scrollSpeed = 0;
    car.y += (scrollSpeed + car.driveSpeed) * dt;
    return car;
  }

  return {
    BIOMES: BIOMES,
    DEFAULT_BAND: DEFAULT_BAND,
    DEFAULT_LANES: DEFAULT_LANES,
    PROPS: PROPS,
    bandIndexAt: bandIndexAt,
    biomeForBand: biomeForBand,
    biomeAt: biomeAt,
    bandProgressAt: bandProgressAt,
    BiomeSchedule: BiomeSchedule,
    buildWeightedProps: buildWeightedProps,
    PropSpawner: PropSpawner,
    CarSpawner: CarSpawner,
    stepCar: stepCar,
    makeRng: makeRng,
  };
});
