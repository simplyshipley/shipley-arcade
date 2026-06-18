/*
 * HOW BIRDS SEE THE WORLD v2 — canvas shell: rendering, input, state machine.
 *
 * Portrait vertical scroller (540x900). The world scrolls DOWNWARD through
 * alternating PARK and CITY biomes; the bird flies up-and-around the lower
 * play area. v2 evolves v1's cel-cartoon poop scorer into a fly-AND-survive
 * game: the bird now has 3 HEARTS and must DODGE hazards (signs, poles, rival
 * birds) while pooping the (now smaller) park-goers + bonus cars.
 *
 * All RULES/data live in the LOGIC builder's files; this shell only renders
 * the world and routes input. It consumes (with thin contract-matching
 * fallbacks so it boots standalone):
 *   window.HBCore     — scoring/combo/birds/spawner + Health (the dodge stakes)
 *   window.Targets    — park-goer + car roster (smaller radii)
 *   window.HBHazards   — HAZARDS data + collide() + a seeded hazard spawner
 *   window.HBTerrain  — PARK/CITY biome schedule + deterministic prop/car state
 *
 * Screens: title (bird circling a park->city skyline) -> play -> rank card,
 * plus paused + crash card. Cel-cartoon: flat fills, 3px #1d1d28 outlines,
 * warm palette, squash-stretch. v2 = MORE polish, same style.
 */
(function () {
  'use strict';

  // ── Logic core + data (from the sibling LOGIC builder) ───────────────
  // Real globals: window.HBCore, window.Targets, window.Hazards, window.Terrain
  // (HBHazards / HBTerrain accepted as aliases). Thin contract-matching
  // fallbacks keep the shell + smoke test runnable if a module is absent.
  var GC = window.HBCore || window.GameCore || makeFallbackCore();
  var TG = window.Targets || makeFallbackTargets();
  var HZ = window.Hazards || window.HBHazards || makeFallbackHazards();
  var TR = window.Terrain || window.HBTerrain || makeFallbackTerrain();

  var W = 540, H = 900;
  var ROUND_SECONDS = 100;
  var OUTLINE = '#1d1d28';
  var MAX_TARGETS = 9;        // on-screen park-goer/car capacity cap
  var MAX_HAZARDS = 6;        // on-screen hazard cap
  var SCROLL_SPEED = 92;      // px/sec the world scrolls DOWN
  var START_HEARTS = 3;

  // Difficulty: scales target size (the thing you aim at) — bigger = easier
  // to splat — and a small scroll-speed/heart nudge. Picked on the title
  // screen with ← →. (Answers "can we change target sizes?")
  var DIFFICULTIES = [
    { id: 'easy',   label: 'CHILL',  targetScale: 1.5, speedScale: 0.85, hearts: 4 },
    { id: 'normal', label: 'NORMAL', targetScale: 1.0, speedScale: 1.0,  hearts: 3 },
    { id: 'hard',   label: 'GNARLY', targetScale: 0.7, speedScale: 1.2,  hearts: 2 }
  ];
  var diffIdx = 1;
  function diff() { return DIFFICULTIES[diffIdx]; }
  var IFRAMES = 1.4;          // seconds of invulnerability after a hit

  var canvas, ctx;
  var keys = {};
  var screen = 'title';
  var game = null;
  var last = 0;
  var titleT = 0;             // title animation clock
  var pointer = { x: W / 2, y: H * 0.66, active: false };
  var crashed = false;

  // Deterministic hash for decoration (no Math.random per frame).
  function hash(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  // ══════════════════════════════════════════════════════════════════
  //  FALLBACK LOGIC (only used if a sibling module is briefly absent).
  //  Each mirrors the contract API so the shell + its smoke test run
  //  identically with or without the real file. Real module ALWAYS wins.
  // ══════════════════════════════════════════════════════════════════
  function makeFallbackCore() {
    var BIRDS = [
      { name: 'Sparrow', emoji: '🐤', minScore: 0, splatRadius: 16, speed: 240, shake: 0 },
      { name: 'Pigeon', emoji: '🐦', minScore: 800, splatRadius: 22, speed: 270, shake: 1 },
      { name: 'Gull', emoji: '🕊️', minScore: 2000, splatRadius: 28, speed: 300, shake: 2 },
      { name: 'Hawk', emoji: '🦅', minScore: 4000, splatRadius: 36, speed: 350, shake: 4 },
      { name: 'The Goose', emoji: '🦆', minScore: 7000, splatRadius: 48, speed: 390, shake: 12 }
    ];
    var RANKS = [
      { name: 'Fledgling', min: 0 },
      { name: 'Branch Hopper', min: 1000 },
      { name: 'Sky Scrapper', min: 2500 },
      { name: 'Park Menace', min: 5000 },
      { name: 'Apex Pooper', min: 8000 }
    ];
    var COMBO_WINDOW = 4, COMBO_MAX = 5;
    function pick(list, score, key) {
      var best = list[0];
      for (var i = 0; i < list.length; i++) if (score >= list[i][key]) best = list[i];
      return best;
    }
    function comboMultiplier(c) { return c <= 1 ? 1 : Math.min(c, COMBO_MAX); }
    function ScoreKeeper() { this.score = 0; this.combo = 1; this.bestCombo = 1; this.window = COMBO_WINDOW; }
    ScoreKeeper.prototype.registerHit = function (base) {
      if (base <= 0) return 0;
      this.combo = Math.min(this.combo + 1, COMBO_MAX);
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      this.window = COMBO_WINDOW;
      var pts = Math.round(base * comboMultiplier(this.combo));
      this.score += pts;
      return pts;
    };
    ScoreKeeper.prototype.tick = function (dt, onScreen) {
      if (this.combo <= 1 || !onScreen) return;
      this.window -= dt;
      if (this.window <= 0) { this.combo = 1; this.window = COMBO_WINDOW; }
    };
    ScoreKeeper.prototype.registerMiss = function () { this.combo = 1; this.window = COMBO_WINDOW; };
    ScoreKeeper.prototype.addBonus = function (pts) { this.score += Math.max(0, pts); };
    function scoreForDrop(dist, tr, sr, golden, points) {
      var reach = tr + sr;
      if (dist > reach) return 0;
      var base = dist <= tr / 3 ? 100 : dist <= (tr * 2) / 3 ? 50 : 25;
      var v = base * ((points == null ? 100 : points) / 100);
      return golden ? v * 3 : v;
    }
    function dist(x1, y1, x2, y2) { var dx = x2 - x1, dy = y2 - y1; return Math.sqrt(dx * dx + dy * dy); }
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
    // Health — the dodge stakes (contract: hearts:3, iframes:1.4).
    function Health(opts) {
      opts = opts || {};
      this.maxHearts = opts.hearts == null ? 3 : opts.hearts;
      this.hearts = this.maxHearts;
      this.iframes = opts.iframes == null ? 1.4 : opts.iframes;
      this.invuln = 0;
    }
    Health.prototype.update = function (dt) {
      if (this.invuln > 0) { this.invuln -= dt; if (this.invuln < 0) this.invuln = 0; }
    };
    // Match the real core API: invulnerable() + alive(). isInvuln() kept as an
    // alias so older call sites stay safe.
    Health.prototype.invulnerable = function () { return this.invuln > 0; };
    Health.prototype.isInvuln = function () { return this.invuln > 0; };
    Health.prototype.alive = function () { return this.hearts > 0; };
    Health.prototype.hit = function () {
      if (this.invuln > 0) return 'shrugged';
      if (this.hearts <= 0) return 'gameover';
      this.hearts -= 1;
      this.invuln = this.iframes;
      return this.hearts <= 0 ? 'gameover' : 'hit';
    };
    function Spawner(opts) {
      opts = opts || {};
      this.roster = opts.roster || (TG.ROSTER || []);
      this.bag = [];
      for (var i = 0; i < this.roster.length; i++) {
        var w = this.roster[i].rarity === 'common' ? 2 : 1;
        for (var k = 0; k < w; k++) this.bag.push(this.roster[i]);
      }
      this.rng = makeRng(opts.seed == null ? 1 : opts.seed);
      this.worldWidth = opts.worldWidth || 540;
      this.scrollSpeed = opts.scrollSpeed || 90;
      this.minGap = opts.minGap == null ? 0.7 : opts.minGap;
      this.maxGap = opts.maxGap == null ? 1.6 : opts.maxGap;
      this.goldenChance = opts.goldenChance == null ? 0.08 : opts.goldenChance;
      this._id = 0;
      this.cooldown = this.minGap + this.rng() * (this.maxGap - this.minGap);
    }
    Spawner.prototype.update = function (dt, onScreen, cap) {
      var out = [];
      cap = cap == null ? 9 : cap;
      this.cooldown -= dt;
      while (this.cooldown <= 0) {
        if (this.bag.length && (onScreen + out.length) < cap) {
          var def = this.bag[Math.min(this.bag.length - 1, Math.floor(this.rng() * this.bag.length))];
          var golden = def.goldenVariant ? this.rng() < this.goldenChance : false;
          var margin = 60;
          this._id += 1;
          out.push({
            id: 'tg-' + this._id, defId: def.id, name: def.name,
            x: margin + this.rng() * (this.worldWidth - margin * 2),
            y: -((def.radius != null ? def.radius : 24) + 10),
            r: def.radius != null ? def.radius : 24, points: def.points,
            rarity: def.rarity, walk: def.walk, path: def.path,
            golden: golden, splatted: false, hitCount: 0, vy: this.scrollSpeed
          });
        }
        this.cooldown += this.minGap + this.rng() * (this.maxGap - this.minGap);
      }
      return out;
    };
    function shareText(result) {
      result = result || {};
      var score = result.score || 0;
      var bird = result.bird || pick(BIRDS, score, 'minScore').name;
      var birdEmoji = result.birdEmoji || pick(BIRDS, score, 'minScore').emoji;
      var rank = result.rank || pick(RANKS, score, 'min').name;
      var lines = ['🦅 HOW BIRDS SEE THE WORLD', '💩 ' + score + ' pts · ' + rank,
        birdEmoji + ' ' + bird + ' · 🔥 best combo x' + Math.min(result.bestCombo || 1, COMBO_MAX)];
      if (result.heartsLeft != null) lines.push('❤️ ' + result.heartsLeft + ' hearts left');
      lines.push('Can you out-poop me?');
      return lines.join('\n');
    }
    return {
      BIRDS: BIRDS, RANKS: RANKS, COMBO_WINDOW: COMBO_WINDOW, COMBO_MAX: COMBO_MAX,
      birdForScore: function (s) { return pick(BIRDS, s, 'minScore'); },
      rankForScore: function (s) { return pick(RANKS, s, 'min'); },
      scoreForDrop: scoreForDrop, comboMultiplier: comboMultiplier,
      ScoreKeeper: ScoreKeeper, Health: Health, dist: dist, makeRng: makeRng,
      Spawner: Spawner, shareText: shareText
    };
  }

  // Roster mirrors src/targets.js v2 shape: 4 SMALLER park-goers (the core
  // Spawner pulls from this) + a separate CAR entry resolvable via byId (cars
  // come from terrain's CarSpawner, not the park-goer Spawner).
  function makeFallbackTargets() {
    var ROSTER = [
      { id: 'bench-reader', name: 'Bench Reader', points: 120, rarity: 'common', radius: 20, walk: 'idle', path: 'bench', first: ['launch', 'hop'], repeat: ['hop'], say: 'Hrmph!' },
      { id: 'briefcase-man', name: 'Briefcase Man', points: 120, rarity: 'common', radius: 18, walk: 'stroll', path: 'mid', first: ['launch', 'shake', 'speak'], repeat: ['shake', 'speak'], say: 'GAH, not again.' },
      { id: 'purse-lady', name: 'Purse Lady', points: 140, rarity: 'uncommon', radius: 20, walk: 'stroll', path: 'upper', first: ['freeze', 'shake', 'speak'], repeat: ['shake', 'speak'], say: 'Why, I never!' },
      { id: 'wiener-dog', name: 'Wiener Dog', points: 170, rarity: 'uncommon', radius: 14, walk: 'trot', path: 'low', first: ['flee', 'spin'], repeat: ['spin'], say: 'Yip!', goldenVariant: true }
    ];
    var CAR = { id: 'car', name: 'City Car', points: 150, rarity: 'uncommon', radius: 22, walk: 'drive', path: 'road', first: ['spin', 'speak'], repeat: ['flee', 'speak'], say: 'HEY!', goldenVariant: true };
    function byId(id) {
      if (id === 'car') return CAR;
      for (var i = 0; i < ROSTER.length; i++) if (ROSTER[i].id === id) return ROSTER[i];
      return undefined;
    }
    return { VERBS: ['launch', 'hop', 'shake', 'freeze', 'flee', 'spin', 'speak'], ROSTER: ROSTER, CAR: CAR, byId: byId };
  }

  // Hazards — must-dodge. Mirrors the real Hazards module API: HAZARDS data
  // (families signs|poles|rival-birds with a `box`), collide(birdHurtbox,
  // hazardInstance) over the instance's .box, a distance-keyed HazardSpawner
  // (.update(dt, biome) -> instances) and stepInstance(inst, dt, scrollSpeed).
  function makeFallbackHazards() {
    var HAZARDS = [
      { id: 'sign-stop', family: 'signs', kind: 'static', label: 'STOP', biome: 'city', box: { kind: 'aabb', hw: 22, hh: 22 }, postH: 40 },
      { id: 'sign-oneway', family: 'signs', kind: 'static', label: 'ONE WAY', biome: 'city', box: { kind: 'aabb', hw: 30, hh: 14 }, postH: 44 },
      { id: 'sign-keepoff', family: 'signs', kind: 'static', label: 'KEEP OFF THE GRASS', biome: 'park', box: { kind: 'aabb', hw: 34, hh: 16 }, postH: 30 },
      { id: 'pole-lamp', family: 'poles', kind: 'static', label: 'lamp post', biome: 'both', box: { kind: 'circle', hr: 16 }, postH: 92, headOffset: 92 },
      { id: 'pole-flag', family: 'poles', kind: 'static', label: 'flag pole', biome: 'park', box: { kind: 'circle', hr: 14 }, postH: 104, headOffset: 104 },
      { id: 'pole-light', family: 'poles', kind: 'static', label: 'traffic light', biome: 'city', box: { kind: 'circle', hr: 18 }, postH: 86, headOffset: 86 },
      { id: 'rival-pigeon', family: 'rival-birds', kind: 'mover', label: 'pigeon flock', biome: 'both', box: { kind: 'circle', hr: 16 }, drift: 60, weave: 26, weaveHz: 1.6 },
      { id: 'rival-goose', family: 'rival-birds', kind: 'mover', label: 'angry goose', biome: 'park', box: { kind: 'circle', hr: 22 }, drift: 48, weave: 18, weaveHz: 1.1 },
      { id: 'rival-hawk', family: 'rival-birds', kind: 'mover', label: 'hawk', biome: 'both', box: { kind: 'circle', hr: 20 }, drift: 96, weave: 34, weaveHz: 2.2 }
    ];
    function byId(id) { for (var i = 0; i < HAZARDS.length; i++) if (HAZARDS[i].id === id) return HAZARDS[i]; return undefined; }
    function familyOf(id) { var h = byId(id); return h ? h.family : undefined; }
    function collide(b, hz) {
      if (!b || !hz || !hz.box) return false;
      var box = hz.box, bx = b.x, by = b.y, br = b.r == null ? 0 : b.r;
      if (box.kind === 'circle') {
        var dx = bx - box.x, dy = by - box.y;
        return Math.sqrt(dx * dx + dy * dy) <= br + (box.hr || 0);
      }
      var nx = bx < box.x - box.hw ? box.x - box.hw : (bx > box.x + box.hw ? box.x + box.hw : bx);
      var ny = by < box.y - box.hh ? box.y - box.hh : (by > box.y + box.hh ? box.y + box.hh : by);
      var ddx = bx - nx, ddy = by - ny;
      return (ddx * ddx + ddy * ddy) <= br * br;
    }
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
    function makeInstance(def, x, y, id) {
      var cx = x, cy = y;
      if (def.family === 'poles') cy = y - (def.headOffset || def.postH || 0);
      var inst = {
        id: id, defId: def.id, family: def.family, kind: def.kind, label: def.label,
        biome: def.biome, x: x, y: y, vy: 0, box: { kind: def.box.kind, x: cx, y: cy }
      };
      if (def.box.kind === 'aabb') { inst.box.hw = def.box.hw; inst.box.hh = def.box.hh; }
      else inst.box.hr = def.box.hr;
      inst.boxOffsetX = inst.box.x - x; inst.boxOffsetY = inst.box.y - y;
      if (def.kind === 'mover') { inst.drift = def.drift || 0; inst.weave = def.weave || 0; inst.weaveHz = def.weaveHz || 0; inst.age = 0; inst.dir = 1; }
      if (def.postH != null) inst.postH = def.postH;
      return inst;
    }
    function syncBox(inst) { inst.box.x = inst.x + inst.boxOffsetX; inst.box.y = inst.y + inst.boxOffsetY; return inst; }
    function stepInstance(inst, dt, scrollSpeed) {
      inst.y += scrollSpeed * dt;
      if (inst.kind === 'mover') {
        inst.age += dt;
        var sway = inst.weave ? Math.cos(inst.age * inst.weaveHz * Math.PI * 2) * inst.weave * inst.weaveHz * Math.PI * 2 * dt : 0;
        inst.x += (inst.drift * inst.dir) * dt + sway;
      }
      syncBox(inst);
      return inst;
    }
    function HazardSpawner(opts) {
      opts = opts || {};
      this.rng = makeRng(opts.seed == null ? 1 : opts.seed);
      this.worldWidth = opts.worldWidth || 540;
      this.scrollSpeed = opts.scrollSpeed || 90;
      this.minGap = opts.minGap == null ? 220 : opts.minGap;
      this.maxGap = opts.maxGap == null ? 420 : opts.maxGap;
      this.pool = opts.pool || HAZARDS;
      this.distance = 0; this.nextAt = this._gap(); this._id = 0;
    }
    HazardSpawner.prototype._gap = function () { return this.minGap + this.rng() * (this.maxGap - this.minGap); };
    HazardSpawner.prototype._eligible = function (biome) {
      if (!biome) return this.pool;
      var out = [];
      for (var i = 0; i < this.pool.length; i++) { var d = this.pool[i]; if (d.biome === biome || d.biome === 'both') out.push(d); }
      return out.length ? out : this.pool;
    };
    HazardSpawner.prototype._pick = function (biome) {
      var list = this._eligible(biome);
      if (!list.length) return null;
      return list[Math.min(list.length - 1, Math.floor(this.rng() * list.length))];
    };
    HazardSpawner.prototype._spawn = function (def) {
      var margin = 50;
      var x = margin + this.rng() * (this.worldWidth - margin * 2);
      var topClear = (def.family === 'poles' ? (def.postH || 0) : 30) + 20;
      this._id += 1;
      var inst = makeInstance(def, x, -topClear, 'hz-' + this._id);
      inst.vy = this.scrollSpeed;
      if (inst.kind === 'mover') {
        var fromLeft = this.rng() < 0.5;
        inst.dir = fromLeft ? 1 : -1;
        inst.x = fromLeft ? margin : (this.worldWidth - margin);
        syncBox(inst);
      }
      return inst;
    };
    HazardSpawner.prototype.advance = function (distanceDelta, biome) {
      var out = [];
      this.distance += distanceDelta;
      while (this.distance >= this.nextAt) {
        var def = this._pick(biome);
        if (def) out.push(this._spawn(def));
        this.nextAt += this._gap();
      }
      return out;
    };
    HazardSpawner.prototype.update = function (dt, biome) { return this.advance(this.scrollSpeed * dt, biome); };
    return {
      HAZARDS: HAZARDS, byId: byId, familyOf: familyOf, collide: collide,
      makeInstance: makeInstance, syncBox: syncBox, stepInstance: stepInstance,
      HazardSpawner: HazardSpawner, makeRng: makeRng
    };
  }

  // Terrain — PARK<->CITY biome schedule + deterministic prop + car spawners.
  // Mirrors the real Terrain module: biomeAt(distance), bandProgressAt(d)
  // (0..1 crossfade), PropSpawner.update(dt) (biome-aware internally), and
  // CarSpawner.update(dt) (cars only in city; move independent of scroll) +
  // stepCar(car, dt, scrollSpeed). First band = PARK.
  function makeFallbackTerrain() {
    var BIOMES = ['park', 'city'];
    var DEFAULT_BAND = 1400;
    var DEFAULT_LANES = [0.30, 0.46, 0.62, 0.78];
    var PROPS = {
      park: [{ kind: 'tree', weight: 3 }, { kind: 'bush', weight: 3 }, { kind: 'pond', weight: 1 }, { kind: 'fountain', weight: 1 }, { kind: 'bench', weight: 2 }],
      city: [{ kind: 'building', weight: 3 }, { kind: 'sidewalk', weight: 2 }, { kind: 'crosswalk', weight: 1 }, { kind: 'hydrant', weight: 2 }]
    };
    function bandIndexAt(d, band) { band = band || DEFAULT_BAND; return Math.floor((d < 0 ? 0 : d) / band); }
    function biomeForBand(i) { return BIOMES[((i % 2) + 2) % 2]; }
    function biomeAt(d, band) { return biomeForBand(bandIndexAt(d, band)); }
    function bandProgressAt(d, band) { band = band || DEFAULT_BAND; d = d < 0 ? 0 : d; return (d % band) / band; }
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
    function BiomeSchedule(opts) { opts = opts || {}; this.bandLength = opts.bandLength || DEFAULT_BAND; }
    BiomeSchedule.prototype.biomeAt = function (d) { return biomeAt(d, this.bandLength); };
    BiomeSchedule.prototype.progressAt = function (d) { return bandProgressAt(d, this.bandLength); };
    function buildBag(list) { var bag = []; for (var i = 0; i < list.length; i++) { var w = list[i].weight || 1; for (var k = 0; k < w; k++) bag.push(list[i].kind); } return bag; }
    function PropSpawner(opts) {
      opts = opts || {};
      this.rng = makeRng(opts.seed == null ? 1 : opts.seed);
      this.worldWidth = opts.worldWidth || 540;
      this.scrollSpeed = opts.scrollSpeed || 90;
      this.schedule = opts.schedule || new BiomeSchedule({ bandLength: opts.bandLength });
      this.minGap = opts.minGap == null ? 90 : opts.minGap;
      this.maxGap = opts.maxGap == null ? 200 : opts.maxGap;
      this.distance = 0; this.nextAt = this._gap(); this._id = 0;
      this._bags = { park: buildBag(PROPS.park), city: buildBag(PROPS.city) };
    }
    PropSpawner.prototype._gap = function () { return this.minGap + this.rng() * (this.maxGap - this.minGap); };
    PropSpawner.prototype._pick = function (biome) { var bag = this._bags[biome] || this._bags.park; return bag[Math.min(bag.length - 1, Math.floor(this.rng() * bag.length))]; };
    PropSpawner.prototype._spawn = function (kind, biome) {
      var margin = 30;
      this._id += 1;
      return { id: 'pr-' + this._id, kind: kind, biome: biome, x: margin + this.rng() * (this.worldWidth - margin * 2), y: -60, vy: this.scrollSpeed, seed: this.rng() };
    };
    PropSpawner.prototype.advance = function (dd) {
      var out = [];
      this.distance += dd;
      while (this.distance >= this.nextAt) { var biome = this.schedule.biomeAt(this.nextAt); out.push(this._spawn(this._pick(biome), biome)); this.nextAt += this._gap(); }
      return out;
    };
    PropSpawner.prototype.update = function (dt) { return this.advance(this.scrollSpeed * dt); };
    function CarSpawner(opts) {
      opts = opts || {};
      this.rng = makeRng(opts.seed == null ? 1 : opts.seed);
      this.worldWidth = opts.worldWidth || 540;
      this.scrollSpeed = opts.scrollSpeed || 90;
      this.schedule = opts.schedule || new BiomeSchedule({ bandLength: opts.bandLength });
      this.lanes = opts.lanes || DEFAULT_LANES;
      this.minGap = opts.minGap == null ? 260 : opts.minGap;
      this.maxGap = opts.maxGap == null ? 520 : opts.maxGap;
      this.minSpeed = opts.minSpeed == null ? 60 : opts.minSpeed;
      this.maxSpeed = opts.maxSpeed == null ? 150 : opts.maxSpeed;
      this.goldenChance = opts.goldenChance == null ? 0.12 : opts.goldenChance;
      this.points = opts.points == null ? 150 : opts.points;
      this.distance = 0; this.nextAt = this._gap(); this._id = 0;
    }
    CarSpawner.prototype._gap = function () { return this.minGap + this.rng() * (this.maxGap - this.minGap); };
    CarSpawner.prototype._spawn = function () {
      var laneIdx = Math.min(this.lanes.length - 1, Math.floor(this.rng() * this.lanes.length));
      var oncoming = this.rng() < 0.4;
      var driveMag = this.minSpeed + this.rng() * (this.maxSpeed - this.minSpeed);
      var golden = this.rng() < this.goldenChance;
      this._id += 1;
      return {
        id: 'car-' + this._id, defId: 'car', kind: 'car', lane: laneIdx,
        x: this.lanes[laneIdx] * this.worldWidth, y: oncoming ? 900 : -80, oncoming: oncoming,
        driveSpeed: oncoming ? -driveMag : driveMag, points: this.points, golden: golden,
        splatted: false, hitCount: 0, r: 22
      };
    };
    CarSpawner.prototype.advance = function (dd) {
      var out = [];
      this.distance += dd;
      while (this.distance >= this.nextAt) { var car = this._spawn(); if (this.schedule.biomeAt(this.nextAt) === 'city') out.push(car); this.nextAt += this._gap(); }
      return out;
    };
    CarSpawner.prototype.update = function (dt) { return this.advance(this.scrollSpeed * dt); };
    function stepCar(car, dt, scrollSpeed) { if (scrollSpeed == null) scrollSpeed = 0; car.y += (scrollSpeed + car.driveSpeed) * dt; return car; }
    return {
      BIOMES: BIOMES, DEFAULT_BAND: DEFAULT_BAND, DEFAULT_LANES: DEFAULT_LANES, PROPS: PROPS,
      bandIndexAt: bandIndexAt, biomeForBand: biomeForBand, biomeAt: biomeAt, bandProgressAt: bandProgressAt,
      BiomeSchedule: BiomeSchedule, PropSpawner: PropSpawner, CarSpawner: CarSpawner, stepCar: stepCar, makeRng: makeRng
    };
  }

  // ── Accessors over the real (or fallback) APIs ───────────────────────
  function birdForScore(s) { return GC.birdForScore(s); }
  function rankForScore(s) { return GC.rankForScore(s); }
  function scoreForDrop(d, tr, sr, golden, points) { return GC.scoreForDrop(d, tr, sr, golden, points); }
  function distOf(x1, y1, x2, y2) { return GC.dist(x1, y1, x2, y2); }
  function rosterById(id) { return TG.byId ? TG.byId(id) : null; }
  function hazardCollide(b, hz) { return HZ.collide ? HZ.collide(b, hz) : false; }
  function biomeAt(scroll) { return TR.biomeAt ? TR.biomeAt(scroll) : 'park'; }
  // Crossfade amount 0..1 toward the NEXT biome, only in the last slice of a
  // band (uses the real Terrain bandProgressAt; falls back to no fade).
  function blendAt(scroll) {
    if (!TR.bandProgressAt) return 0;
    var p = TR.bandProgressAt(scroll); // 0..1 through the current band
    var fadeStart = 0.86;
    if (p <= fadeStart) return 0;
    return (p - fadeStart) / (1 - fadeStart);
  }
  var BAND_LEN = TR.DEFAULT_BAND || 1400;
  function shareTextFor(g) {
    var bird = birdForScore(g.score.score);
    return GC.shareText({
      score: g.score.score, bestCombo: g.score.bestCombo,
      bird: bird.name, birdEmoji: bird.emoji, rank: rankForScore(g.score.score).name,
      heartsLeft: g.health ? g.health.hearts : 0
    });
  }

  // ── Game state ───────────────────────────────────────────────────────
  function newGame() {
    var seed = (Date.now() & 0x7fffffff) || 1;
    // Park-goers come from core's Spawner over the Targets roster (people + dog).
    // Hazards from HazardSpawner, scenery from PropSpawner, cars (poopable bonus
    // targets) from CarSpawner — all distance/time-keyed at the world scroll.
    var spawner = new GC.Spawner({ roster: TG.ROSTER, seed: seed, worldWidth: W, scrollSpeed: SCROLL_SPEED });
    var hazSpawner = HZ.HazardSpawner ? new HZ.HazardSpawner({ seed: (seed * 3 + 11) & 0x7fffffff, worldWidth: W, scrollSpeed: SCROLL_SPEED }) : null;
    var propSpawner = TR.PropSpawner ? new TR.PropSpawner({ seed: (seed * 7 + 5) & 0x7fffffff, worldWidth: W, scrollSpeed: SCROLL_SPEED }) : null;
    var carSpawner = TR.CarSpawner ? new TR.CarSpawner({ seed: (seed * 13 + 3) & 0x7fffffff, worldWidth: W, scrollSpeed: SCROLL_SPEED }) : null;
    var d = diff();
    var health = GC.Health ? new GC.Health({ hearts: d.hearts, iframes: IFRAMES }) : fallbackHealth();
    return {
      score: new GC.ScoreKeeper(),
      health: health,
      targetScale: d.targetScale,
      speedScale: d.speedScale,
      difficulty: d.label,
      spawner: spawner,
      hazSpawner: hazSpawner,
      propSpawner: propSpawner,
      carSpawner: carSpawner,
      t: ROUND_SECONDS,
      scroll: 0,
      biome: biomeAt(0),
      targets: [],
      hazards: [],
      props: [],
      cars: [],
      payloads: [],   // {x, y, t, dur, splatR}
      decals: [],     // persistent splats riding the world down
      particles: [],  // {x,y,vx,vy,t,life,r,color,kind}
      speedLines: [],
      bird: { x: W / 2, y: H * 0.7, flapT: 0, hurtFlash: 0 },
      splats: 0,
      shakeT: 0,
      shakeMag: 0,
      floats: [],
      toasts: [],
      gameOver: false
    };
  }

  // Last-resort Health if even GC.Health is somehow absent.
  function fallbackHealth() {
    return {
      maxHearts: START_HEARTS, hearts: START_HEARTS, iframes: IFRAMES, invuln: 0,
      update: function (dt) { if (this.invuln > 0) { this.invuln -= dt; if (this.invuln < 0) this.invuln = 0; } },
      invulnerable: function () { return this.invuln > 0; },
      isInvuln: function () { return this.invuln > 0; },
      alive: function () { return this.hearts > 0; },
      hit: function () {
        if (this.invuln > 0) return 'shrugged';
        if (this.hearts <= 0) return 'gameover';
        this.hearts -= 1; this.invuln = this.iframes;
        return this.hearts <= 0 ? 'gameover' : 'hit';
      }
    };
  }

  // i-frame query tolerant of either method name (real core: invulnerable();
  // shell fallback also exposes isInvuln()). Falls back to the raw .invuln
  // timer so a minimal Health object still works.
  function healthInvuln(h) {
    if (!h) return false;
    if (typeof h.invulnerable === 'function') return !!h.invulnerable();
    if (typeof h.isInvuln === 'function') return !!h.isInvuln();
    return (h.invuln || 0) > 0;
  }

  function floatText(x, y, text, color) {
    game.floats.push({ x: x, y: y, text: text, t: 1.1, color: color || '#fff' });
  }
  function toast(text) { game.toasts.push({ text: text, t: 2.2 }); }
  function shake(mag) { if (mag > 0 && mag > game.shakeMag - 0.001) { game.shakeT = 0.35; game.shakeMag = mag; } }

  // Particle bursts.
  function burst(x, y, n, color, kind, spread, speed) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = (speed || 90) * (0.4 + Math.random() * 0.8);
      game.particles.push({
        x: x, y: y, vx: Math.cos(a) * sp * (spread || 1), vy: Math.sin(a) * sp - 40,
        t: 0, life: 0.5 + Math.random() * 0.5, r: 2 + Math.random() * 3,
        color: color, kind: kind || 'dot'
      });
    }
  }

  function startPlay() {
    game = newGame();
    screen = 'play';
  }

  // ── Update ─────────────────────────────────────────────────────────
  function update(dt) {
    if (game) {
      if (game.shakeT > 0) game.shakeT -= dt;
      if (game.bird.hurtFlash > 0) game.bird.hurtFlash -= dt;
      var i;
      for (i = game.floats.length - 1; i >= 0; i--) {
        game.floats[i].t -= dt;
        game.floats[i].y -= 32 * dt;
        if (game.floats[i].t <= 0) game.floats.splice(i, 1);
      }
      for (i = game.toasts.length - 1; i >= 0; i--) {
        game.toasts[i].t -= dt;
        if (game.toasts[i].t <= 0) game.toasts.splice(i, 1);
      }
      for (i = game.particles.length - 1; i >= 0; i--) {
        var pa = game.particles[i];
        pa.t += dt;
        pa.x += pa.vx * dt;
        pa.y += pa.vy * dt;
        pa.vy += 220 * dt;       // gravity
        pa.vx *= (1 - 1.6 * dt); // drag
        if (pa.t >= pa.life) game.particles.splice(i, 1);
      }
      for (i = game.speedLines.length - 1; i >= 0; i--) {
        game.speedLines[i].t -= dt;
        game.speedLines[i].y += game.speedLines[i].vy * dt;
        if (game.speedLines[i].t <= 0) game.speedLines.splice(i, 1);
      }
    }
    if (screen === 'title') { titleT += dt; }
    else if (screen === 'play') updatePlay(dt);
    else if (screen === 'rank' || screen === 'paused') { titleT += dt; }
  }

  // Walk drift per behavior (px/sec across the world).
  function walkVx(t) {
    switch (t.walk) {
      case 'idle': return 0;
      case 'stroll': return t.path === 'upper' ? -18 : 16;
      case 'trot': return 46;
      default: return 0;
    }
  }

  function updatePlay(dt) {
    var f = game;
    var bird = birdForScore(f.score.score);
    titleT += dt; // keep wingbeat/title clock advancing for animations

    f.t -= dt;
    if (f.t <= 0) {
      f.t = 0;
      endRound();
      return;
    }

    // ── Movement: arrows/WASD in X AND Y ──
    var sp = bird.speed || 260;
    var moved = false;
    if (keys.arrowleft || keys.a) { f.bird.x -= sp * dt; moved = true; }
    if (keys.arrowright || keys.d) { f.bird.x += sp * dt; moved = true; }
    if (keys.arrowup || keys.w) { f.bird.y -= sp * dt; moved = true; }
    if (keys.arrowdown || keys.s) { f.bird.y += sp * dt; moved = true; }
    if (pointer.active && !moved) {
      var dx = pointer.x - f.bird.x, dy = pointer.y - f.bird.y;
      var dd = Math.sqrt(dx * dx + dy * dy);
      if (dd > 1) {
        var step = Math.min(dd, sp * dt * 1.4);
        f.bird.x += (dx / dd) * step;
        f.bird.y += (dy / dd) * step;
        moved = true;
      }
    }
    f.bird.x = Math.max(24, Math.min(W - 24, f.bird.x));
    f.bird.y = Math.max(70, Math.min(H - 40, f.bird.y));
    f.bird.flapT += dt * (moved ? 22 : 14);

    // Occasional speed lines when flying fast (cosmetic, no logic).
    if (moved && Math.random() < 0.4) {
      f.speedLines.push({ x: f.bird.x + (Math.random() - 0.5) * 40, y: f.bird.y - 30, vy: -180, len: 14 + Math.random() * 16, t: 0.3 });
    }

    // ── World scroll DOWN + biome tracking ──
    var dy2 = SCROLL_SPEED * dt;
    f.scroll += dy2;
    f.biome = biomeAt(f.scroll);

    // ── i-frame timer ──
    f.health.update(dt);

    // ── Spawn park-goers/cars (rules in core) ──
    var live = 0, c;
    for (c = 0; c < f.targets.length; c++) if (!f.targets[c].splatted) live++;
    var spawned = f.spawner.update(dt, live, MAX_TARGETS);
    for (c = 0; c < spawned.length; c++) {
      var nt = spawned[c];
      // Skip city-only / park-only targets that don't match the current biome.
      var tdef = rosterById(nt.defId);
      if (tdef && tdef.biome && tdef.biome !== f.biome) continue;
      nt.react = ''; nt.reactT = 0; nt.bob = Math.random() * 6.28;
      nt.speech = ''; nt.speechT = 0;
      if (nt.hitCount === undefined) nt.hitCount = 0;
      nt.r = nt.r * (f.targetScale || 1);   // difficulty scales the bullseye size
      f.targets.push(nt);
    }

    // ── Spawn hazards (distance-keyed, biome-aware) — gated by a soft cap ──
    if (f.hazSpawner && f.hazards.length < MAX_HAZARDS) {
      var newHz = f.hazSpawner.update(dt, f.biome);
      for (c = 0; c < newHz.length; c++) f.hazards.push(newHz[c]);
    } else if (f.hazSpawner) {
      // keep the spawner's distance clock advancing even when capped (so the
      // cadence stays deterministic), but discard overflow spawns.
      f.hazSpawner.update(dt, f.biome);
    }

    // ── Spawn terrain props (scenery) + cars (poopable, move w/ own speed) ──
    if (f.propSpawner) {
      var newProps = f.propSpawner.update(dt);
      for (c = 0; c < newProps.length; c++) f.props.push(newProps[c]);
    }
    if (f.carSpawner) {
      var newCars = f.carSpawner.update(dt);
      for (c = 0; c < newCars.length; c++) f.cars.push(newCars[c]);
    }

    // Combo decay window (core): decays ONLY while targets are up.
    f.score.tick(dt, f.targets.length > 0);

    var i, tt;
    // Persistent splat decals ride the world scroll downward; cull off-screen.
    for (i = f.decals.length - 1; i >= 0; i--) {
      f.decals[i].y += dy2;
      if (f.decals[i].y > H + 80) f.decals.splice(i, 1);
    }
    // Park-goer/car targets.
    for (i = f.targets.length - 1; i >= 0; i--) {
      tt = f.targets[i];
      tt.y += dy2;
      tt.x += (tt.fleeBoost ? walkVx(tt) + tt.fleeBoost : walkVx(tt)) * dt;
      tt.bob += dt * 4;
      if (tt.reactT > 0) tt.reactT -= dt;
      if (tt.speechT > 0) tt.speechT -= dt;
      if (tt.x < 20) tt.x = 20;
      if (tt.x > W - 20) tt.x = W - 20;
      if (tt.y > H + 60) f.targets.splice(i, 1);
    }
    // Terrain props (scenery only).
    for (i = f.props.length - 1; i >= 0; i--) {
      f.props[i].y += dy2 * 0.92;
      if (f.props[i].y > H + 120) f.props.splice(i, 1);
    }
    // Cars ride the world scroll AND drive their lane at their OWN speed
    // (stepCar handles both → a moving target you lead = a skill shot). Cull
    // when fully off either end. Cars are NOT dodge hazards (fly above them).
    for (i = f.cars.length - 1; i >= 0; i--) {
      var cc = f.cars[i];
      if (TR.stepCar) TR.stepCar(cc, dt, SCROLL_SPEED);
      else cc.y += (SCROLL_SPEED + (cc.driveSpeed || 0)) * dt;
      if (cc.y > H + 140 || cc.y < -160) f.cars.splice(i, 1);
    }

    // ── Hazards move + the DODGE check (the headline feature) ──
    // stepInstance advances the instance (static = straight down; movers also
    // cross-drift + weave) and re-syncs its hitbox. The bird hurtbox is ~60%
    // of the sprite; collide() runs vs the instance's box every frame.
    var hurt = { x: f.bird.x, y: f.bird.y, r: birdSize(bird) * 0.6 };
    var invuln = healthInvuln(f.health);
    for (i = f.hazards.length - 1; i >= 0; i--) {
      var hz = f.hazards[i];
      if (HZ.stepInstance) HZ.stepInstance(hz, dt, SCROLL_SPEED);
      else { hz.y += dy2; if (hz.box) { hz.box.y += dy2; } }
      // keep movers on screen horizontally
      if (hz.kind === 'mover') {
        if (hz.x < 26) hz.x = 26;
        if (hz.x > W - 26) hz.x = W - 26;
        if (HZ.syncBox) HZ.syncBox(hz);
      }
      // Collision vs the bird hurtbox (skip during i-frames so re-hits don't stack).
      if (!invuln && hazardCollide(hurt, hz)) {
        var res = f.health.hit();
        if (res !== 'shrugged') { onHazardHit(hz, res); invuln = true; }
      }
      if (hz.y > H + 160) f.hazards.splice(i, 1);
    }

    // ── Payloads ride the world scroll while the poop falls ──
    for (i = f.payloads.length - 1; i >= 0; i--) {
      var pp = f.payloads[i];
      pp.y += dy2 * 0.4;
      pp.t += dt;
      if (pp.t >= pp.dur) {
        resolveSplat(pp.x, pp.y, pp.splatR);
        f.payloads.splice(i, 1);
      }
    }
  }

  function birdSize(bird) {
    var tier = 0;
    for (var i = 0; i < (GC.BIRDS || []).length; i++) if (GC.BIRDS[i].name === bird.name) tier = i;
    return 14 + tier * 4;
  }

  // Getting hit: -1 heart + flash + shake + OUCH + feather puff. NO score/combo
  // penalty (decision below). 0 hearts -> game over -> rank card.
  function onHazardHit(hz, res) {
    var f = game;
    f.bird.hurtFlash = 0.5;
    shake(8);
    floatText(f.bird.x, f.bird.y - 30, 'OUCH!', '#ff6b6b');
    burst(f.bird.x, f.bird.y, 12, '#f4f1e6', 'feather', 1.2, 120);
    audioHurt();
    // DESIGN DECISION: a hazard hit costs a heart ONLY — it does NOT touch
    // score and does NOT break the combo. Getting hit is its own punishment;
    // pooping is never punished. (Contract calls combo-drop optional; we keep
    // the streak so the player isn't double-penalised.)
    if (res === 'gameover') {
      shake(14);
      endRound();
    }
  }

  function endRound() {
    var f = game;
    // Resolve any in-flight payloads before the round ends (no lost poops).
    while (f.payloads.length) {
      var p = f.payloads.shift();
      resolveSplat(p.x, p.y, p.splatR);
    }
    f.gameOver = true;
    screen = 'rank';
    audioFanfare();
  }

  // Splat scoring scans ALL overlapping targets — every bullseye scores its
  // own ring value. Empty-field poops cost nothing and never break combo.
  function resolveSplat(x, y, splatR) {
    var f = game;
    f.splats += 1;
    f.decals.push({ x: x, y: y, r: splatR });
    audioSplat();
    burst(x, y, 9, '#6f8f44', 'splat', 1, 110);

    var anyHit = false;
    var beforeBird = birdForScore(f.score.score);
    var i, t, bx, by, d, base, pts, lbl;
    // Park-goers (people + dog) from core's spawner.
    for (i = 0; i < f.targets.length; i++) {
      t = f.targets[i];
      if (t.splatted) continue;
      bx = bullseyeX(t); by = bullseyeY(t);
      d = distOf(x, y, bx, by);
      base = scoreForDrop(d, t.r, splatR, !!t.golden, t.points);
      if (base <= 0) continue;
      pts = f.score.registerHit(base);
      if (pts <= 0) continue;
      anyHit = true;
      t.splatted = true;
      applyReaction(t);
      lbl = '+' + pts + (f.score.combo > 1 ? ' x' + f.score.combo : '');
      floatText(bx, by - t.r - 6, lbl, t.golden ? '#ffd23f' : '#fff');
      if (t.golden) { floatText(bx, by - t.r - 26, 'GOLDEN!', '#ffd23f'); burst(bx, by, 10, '#ffd23f', 'spark', 1, 130); }
      shake((birdForScore(f.score.score).shake || 0) + 2);
    }
    // Cars (poopable bonus targets — roof bullseye; golden = convertible).
    for (i = 0; i < f.cars.length; i++) {
      var car = f.cars[i];
      if (car.splatted) continue;
      bx = car.x; by = car.y - car.r * 0.35; // roof/windshield
      d = distOf(x, y, bx, by);
      base = scoreForDrop(d, car.r, splatR, !!car.golden, car.points);
      if (base <= 0) continue;
      pts = f.score.registerHit(base);
      if (pts <= 0) continue;
      anyHit = true;
      car.splatted = true;
      car.hitCount = (car.hitCount || 0) + 1;
      lbl = '+' + pts + (f.score.combo > 1 ? ' x' + f.score.combo : '');
      floatText(bx, by - car.r - 6, lbl, '#7fd4ff');
      floatText(bx, by - car.r - 26, car.golden ? 'GOLDEN CAR!' : 'CAR BONUS!', '#7fd4ff');
      burst(bx, by, 10, '#7fd4ff', 'spark', 1, 130);
      shake((birdForScore(f.score.score).shake || 0) + 3);
    }
    if (!anyHit) return; // ground splat: joy, not failure — no penalty.
    var afterBird = birdForScore(f.score.score);
    if (afterBird.name !== beforeBird.name) {
      toast(afterBird.name.toUpperCase() + ' UNLOCKED!');
      shake((afterBird.shake || 0) + 6);
      burst(f.bird.x, f.bird.y, 16, '#ffd23f', 'spark', 1.3, 150);
      audioTierUp();
    }
  }

  // Single source of truth for the bullseye CENTER (what's scored AND drawn).
  function bullseyeX(t) {
    if (t.defId === 'wiener-dog') return t.x - 12;
    return t.x;
  }
  function bullseyeY(t) {
    if (t.defId === 'wiener-dog') return t.y - 2;
    return t.y - t.r * 0.55;
  }

  function applyReaction(t) {
    var def = rosterById(t.defId);
    var first = (t.hitCount || 0) === 0;
    t.hitCount = (t.hitCount || 0) + 1;
    var list = def ? (first ? def.first : def.repeat) : ['hop'];
    if (!list || !list.length) list = ['hop'];
    var verb = 'hop', wantsSpeak = false, k;
    for (k = 0; k < list.length; k++) {
      if (list[k] === 'speak') wantsSpeak = true;
      else verb = list[k];
    }
    t.react = verb;
    t.reactT = 0.9;
    if (wantsSpeak && def && def.say) speak(t, def.say);
    if (verb === 'flee') t.fleeBoost = (t.fleeBoost || 0) + 30;
  }
  function speak(t, text) { t.speech = text; t.speechT = 1.4; }

  // ══════════════════════════════════════════════════════════════════
  //  CEL-CARTOON PAINTERS
  // ══════════════════════════════════════════════════════════════════
  function outline(w) { ctx.strokeStyle = OUTLINE; ctx.lineWidth = w || 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; }
  function fillCircle(x, y, r, color) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); outline(3); ctx.stroke();
  }
  function fillRoundRect(x, y, w, h, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill(); outline(3); ctx.stroke();
  }

  // Crisp small bullseye reticle.
  function drawBullseye(x, y, r, golden, splatted) {
    var rings = splatted
      ? ['#8a8a92', '#c8c8d0', '#8a8a92']
      : golden
        ? ['#e0a800', '#fff3c0', '#e0a800']
        : ['#e23b3b', '#fff', '#e23b3b'];
    fillCircle(x, y, r, rings[0]);
    fillCircle(x, y, r * 0.62, rings[1]);
    ctx.fillStyle = rings[2]; ctx.beginPath(); ctx.arc(x, y, r * 0.3, 0, Math.PI * 2); ctx.fill();
    // crosshair tick for readability at small sizes
    if (!splatted) {
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - r, y); ctx.lineTo(x - r * 0.5, y);
      ctx.moveTo(x + r * 0.5, y); ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r); ctx.lineTo(x, y - r * 0.5);
      ctx.moveTo(x, y + r * 0.5); ctx.lineTo(x, y + r);
      ctx.stroke();
    }
  }

  function reactionOffset(t) {
    var p = t.reactT > 0 ? t.reactT / 0.9 : 0;
    var amp = p;
    switch (t.react) {
      case 'launch': return { dx: 0, dy: -10 * amp, rot: 0 };
      case 'hop': return { dx: 0, dy: -8 * Math.abs(Math.sin(t.reactT * 18)) * amp, rot: 0 };
      case 'shake': return { dx: Math.sin(t.reactT * 40) * 4 * amp, dy: 0, rot: 0 };
      case 'freeze': return { dx: 0, dy: 0, rot: 0 };
      case 'flee': return { dx: Math.sin(t.reactT * 22) * 3 * amp, dy: 0, rot: 0 };
      case 'spin': return { dx: 0, dy: 0, rot: t.reactT * 18 };
      default: return { dx: 0, dy: 0, rot: 0 };
    }
  }

  function drawSpeech(t) {
    if (!t.speech || t.speechT <= 0) return;
    ctx.save();
    ctx.font = 'bold 12px ui-monospace, monospace';
    var tw = ctx.measureText(t.speech).width;
    var bw = tw + 18, bh = 24, bx = t.x - bw / 2, by = t.y - t.r - 52;
    bx = Math.max(6, Math.min(W - bw - 6, bx));
    fillRoundRect(bx, by, bw, bh, 8, '#fff');
    ctx.beginPath();
    ctx.moveTo(t.x - 6, by + bh); ctx.lineTo(t.x + 6, by + bh); ctx.lineTo(t.x, by + bh + 9);
    ctx.closePath(); ctx.fillStyle = '#fff'; ctx.fill(); outline(3); ctx.stroke();
    ctx.fillStyle = OUTLINE; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t.speech, bx + bw / 2, by + bh / 2);
    ctx.restore();
  }

  // --- bench-reader (scaled down to the smaller radius) -----------------
  function paintBenchReader(t) {
    var off = reactionOffset(t);
    var s = t.r / 26;
    ctx.save();
    ctx.translate(t.x + off.dx, t.y + off.dy); ctx.scale(s, s);
    fillRoundRect(-30, 18, 60, 12, 4, '#8a5a2b');
    fillRoundRect(-26, 28, 6, 16, 2, '#6b4420');
    fillRoundRect(20, 28, 6, 16, 2, '#6b4420');
    fillRoundRect(-16, -2, 32, 26, 8, '#cdb27a');
    fillCircle(0, -16, 12, '#f0c9a0');
    fillRoundRect(-14, -22, 28, 7, 3, '#7a5a30');
    fillRoundRect(-9, -30, 18, 9, 4, '#7a5a30');
    var lift = t.react === 'launch' && t.reactT > 0 ? (0.9 - t.reactT) * 40 : 0;
    fillRoundRect(-18, -4 - lift, 36, 22, 3, '#f3f0e6');
    ctx.strokeStyle = '#9a978c'; ctx.lineWidth = 1;
    for (var li = 0; li < 3; li++) { ctx.beginPath(); ctx.moveTo(-14, 0 - lift + li * 5); ctx.lineTo(14, 0 - lift + li * 5); ctx.stroke(); }
    ctx.restore();
    paintBullseyeFor(t);
  }

  function paintBriefcaseMan(t) {
    var off = reactionOffset(t);
    var s = t.r / 26;
    ctx.save();
    ctx.translate(t.x + off.dx, t.y + off.dy); ctx.scale(s, s);
    fillRoundRect(-9, 14, 7, 18, 3, '#3a4a6b');
    fillRoundRect(2, 14, 7, 18, 3, '#3a4a6b');
    fillRoundRect(-13, -6, 26, 24, 6, '#f2c63a');
    ctx.fillStyle = '#b03030'; ctx.beginPath();
    ctx.moveTo(0, -4); ctx.lineTo(-4, 2); ctx.lineTo(0, 14); ctx.lineTo(4, 2);
    ctx.closePath(); ctx.fill(); outline(2); ctx.stroke();
    fillCircle(0, -16, 11, '#e9bb8e');
    ctx.fillStyle = '#dad0c0'; ctx.fillRect(-13, -18, 4, 3); ctx.fillRect(9, -18, 4, 3);
    var bcY = 6 + (t.react === 'launch' && t.reactT > 0 ? (0.9 - t.reactT) * 18 : 0);
    fillRoundRect(12, bcY, 16, 13, 3, '#7a4a22');
    ctx.restore();
    paintBullseyeFor(t);
  }

  function paintPurseLady(t) {
    var off = reactionOffset(t);
    var s = t.r / 26;
    ctx.save();
    ctx.translate(t.x + off.dx, t.y + off.dy); ctx.scale(s, s);
    ctx.fillStyle = '#7a2a3a'; ctx.beginPath();
    ctx.moveTo(-8, -6); ctx.lineTo(8, -6); ctx.lineTo(20, 30); ctx.lineTo(-20, 30);
    ctx.closePath(); ctx.fill(); outline(3); ctx.stroke();
    fillCircle(0, -16, 11, '#ecbf99');
    fillCircle(-8, -22, 6, '#cfcfd6');
    fillCircle(8, -22, 6, '#cfcfd6');
    fillCircle(0, -27, 7, '#cfcfd6');
    var clutch = t.react === 'freeze' ? 6 : 0;
    fillRoundRect(-24 + clutch, 6, 12, 11, 3, '#1a1a22');
    ctx.restore();
    paintBullseyeFor(t);
  }

  function paintWienerDog(t) {
    var off = reactionOffset(t);
    var s = t.r / 22;
    ctx.save();
    ctx.translate(t.x, t.y); ctx.scale(s, s);
    var dir = walkVx(t) >= 0 ? 1 : -1;
    ctx.scale(dir, 1);
    var bod = '#9a5a28';
    fillRoundRect(-26, -6, 52, 16, 8, bod);
    fillRoundRect(-20, 8, 5, 8, 2, '#7a4420');
    fillRoundRect(14, 8, 5, 8, 2, '#7a4420');
    fillCircle(24, -4, 9, bod);
    fillRoundRect(28, -2, 9, 6, 3, bod);
    fillCircle(20, -10, 4, '#6b3a18');
    ctx.save();
    ctx.translate(-26, -4);
    ctx.rotate(t.react === 'spin' ? off.rot : -0.4);
    fillRoundRect(-12, -2, 12, 4, 2, bod);
    ctx.restore();
    ctx.restore();
    paintBullseyeFor(t);
  }

  function paintBullseyeFor(t) {
    var bx = bullseyeX(t), by = bullseyeY(t);
    drawBullseye(bx, by, t.r, t.golden, t.splatted);
    if (t.splatted) splatGlob(bx, by, t.r * 0.8);
    drawSpeech(t);
  }

  function splatGlob(x, y, r) {
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = '#5e7d3a';
    ctx.beginPath();
    for (var a = 0; a < 7; a++) {
      var ang = (a / 7) * Math.PI * 2;
      var rr = r * (0.7 + hash(a + x) * 0.5);
      var px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr;
      if (a === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function paintTarget(t) {
    switch (t.defId) {
      case 'bench-reader': paintBenchReader(t); break;
      case 'briefcase-man': paintBriefcaseMan(t); break;
      case 'purse-lady': paintPurseLady(t); break;
      case 'wiener-dog': paintWienerDog(t); break;
      default: drawBullseye(t.x, t.y - t.r * 0.2, t.r, t.golden, t.splatted);
    }
  }

  // ── Hazard painters — consume the real instance shape: family is plural
  // ('signs'|'poles'|'rival-birds'), box {kind,x,y,hw/hh|hr} is the hitbox,
  // postH the post height, defId the variant. (x,y) is the sprite anchor: the
  // sign/board sits at y, the pole base at y with the head lifted to box.y. ──
  function paintHazard(hz) {
    if (hz.family === 'signs') paintSign(hz);
    else if (hz.family === 'poles') paintPole(hz);
    else paintRival(hz);
  }

  function paintSign(hz) {
    var post = hz.postH || 40;
    var hw = (hz.box && hz.box.hw) || 22, hh = (hz.box && hz.box.hh) || 22;
    // post hangs DOWN from the board.
    fillRoundRect(hz.x - 3, hz.y, 6, post, 2, '#8a8f99');
    if (hz.defId === 'sign-stop') {
      ctx.fillStyle = '#cf2b2b';
      ctx.beginPath();
      var R = hw;
      for (var i = 0; i < 8; i++) {
        var a = Math.PI / 8 + i * Math.PI / 4;
        var px = hz.x + Math.cos(a) * R, py = hz.y + Math.sin(a) * R;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill(); outline(3); ctx.stroke();
      label(hz.x, hz.y, 'STOP', '#fff', 9);
    } else {
      var col = hz.defId === 'sign-oneway' ? '#2a4a8a' : '#3a7a3a';
      fillRoundRect(hz.x - hw, hz.y - hh, hw * 2, hh * 2, 4, col);
      var txt = hz.defId === 'sign-keepoff' ? 'KEEP OFF' : (hz.label || 'SIGN');
      label(hz.x, hz.y, txt, '#fff', txt.length > 6 ? 7 : 9);
    }
  }

  function paintPole(hz) {
    var post = hz.postH || 92;
    var headX = (hz.box && hz.box.x) || hz.x;
    var headY = (hz.box && hz.box.y) || (hz.y - post);
    var hr = (hz.box && hz.box.hr) || 14;
    // tall thin vertical from base (hz.y) up to the head.
    fillRoundRect(hz.x - 3, headY, 6, hz.y - headY, 2, '#6f7682');
    if (hz.defId === 'pole-light') {
      fillRoundRect(headX - 9, headY - hr, 18, hr * 2 + 6, 5, '#2a2d36');
      fillCircle(headX, headY - hr * 0.5, 4, '#cf2b2b');
      fillCircle(headX, headY + hr * 0.25, 4, '#e0c000');
      fillCircle(headX, headY + hr, 4, '#4caf6a');
    } else if (hz.defId === 'pole-flag') {
      fillCircle(headX, headY, Math.min(hr, 6), '#e0a800'); // finial = solid head
      ctx.fillStyle = '#cf2b2b';
      ctx.beginPath();
      ctx.moveTo(headX, headY + 2); ctx.lineTo(headX + 28, headY + 8); ctx.lineTo(headX, headY + 16);
      ctx.closePath(); ctx.fill(); outline(2); ctx.stroke();
    } else {
      fillCircle(headX, headY, hr, '#fff3b0'); // lamp head = solid hitbox
      fillRoundRect(headX - hr - 2, headY - hr - 6, (hr + 2) * 2, 6, 3, '#6f7682');
    }
  }

  function paintRival(hz) {
    var r = (hz.box && hz.box.hr) || 16;
    var flap = (hz.age || 0) * 9;
    var wingY = Math.sin(flap) * r * 0.6;
    var kind = hz.defId === 'rival-goose' ? 'goose' : hz.defId === 'rival-hawk' ? 'hawk' : 'pigeon';
    var body = kind === 'goose' ? '#cfcfd6' : kind === 'hawk' ? '#6b3f2a' : '#7c7c86';
    var beak = kind === 'goose' ? '#e8a13a' : '#e89a2a';
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(hz.x - r * 0.95, hz.y - wingY, r * 0.85, r * 0.42, -0.5, 0, Math.PI * 2); ctx.fill(); outline(3); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(hz.x + r * 0.95, hz.y - wingY, r * 0.85, r * 0.42, 0.5, 0, Math.PI * 2); ctx.fill(); outline(3); ctx.stroke();
    fillCircle(hz.x, hz.y, r, body);
    fillCircle(hz.x, hz.y + r * 0.7, r * 0.55, body); // head below (facing player)
    ctx.fillStyle = beak; ctx.beginPath();
    ctx.moveTo(hz.x - 4, hz.y + r * 0.9); ctx.lineTo(hz.x + 4, hz.y + r * 0.9); ctx.lineTo(hz.x, hz.y + r * 1.3);
    ctx.closePath(); ctx.fill(); outline(2); ctx.stroke();
    if (kind !== 'pigeon') {
      ctx.strokeStyle = OUTLINE; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hz.x - r * 0.5, hz.y + r * 0.3); ctx.lineTo(hz.x - r * 0.1, hz.y + r * 0.45);
      ctx.moveTo(hz.x + r * 0.5, hz.y + r * 0.3); ctx.lineTo(hz.x + r * 0.1, hz.y + r * 0.45);
      ctx.stroke();
    }
  }

  function label(x, y, text, color, size) {
    ctx.save();
    ctx.font = 'bold ' + (size || 10) + 'px ui-monospace, monospace';
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // ── Terrain prop painters (scenery) ──────────────────────────────────
  // Real props carry { kind, x, y, seed(0..1), biome }. Derive a deterministic
  // scale + int variant from the float seed.
  function paintProp(pr) {
    var sd = pr.seed == null ? 0.5 : pr.seed;
    var sc = pr.scale || (0.85 + sd * 0.5);
    var variant = Math.floor(sd * 1000);
    ctx.save();
    ctx.translate(pr.x, pr.y); ctx.scale(sc, sc);
    switch (pr.kind) {
      case 'tree':
        fillRoundRect(-4, 0, 8, 22, 2, '#7a5230');
        fillCircle(0, -8, 18, '#4f8f3a'); fillCircle(-12, -2, 12, '#458035'); fillCircle(12, -2, 12, '#458035');
        break;
      case 'bush':
        fillCircle(0, 0, 12, '#558f3e'); fillCircle(-9, 2, 9, '#4c8237'); fillCircle(9, 2, 9, '#4c8237');
        break;
      case 'pond':
        ctx.fillStyle = '#4d9fd0'; ctx.beginPath(); ctx.ellipse(0, 0, 34, 18, 0, 0, Math.PI * 2); ctx.fill(); outline(3); ctx.stroke();
        ctx.strokeStyle = '#bfe6f2'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(-6, -3, 12, 5, 0, 0, Math.PI); ctx.stroke();
        break;
      case 'fountain':
        fillCircle(0, 6, 22, '#9aa0aa'); fillCircle(0, 6, 14, '#4d9fd0');
        fillRoundRect(-3, -16, 6, 18, 2, '#cfd3da');
        fillCircle(0, -18, 6, '#bfe6f2');
        break;
      case 'bench':
        fillRoundRect(-22, 0, 44, 8, 3, '#8a5a2b');
        fillRoundRect(-18, 8, 4, 10, 2, '#6b4420'); fillRoundRect(14, 8, 4, 10, 2, '#6b4420');
        break;
      case 'building':
        var bh = 70 + (variant % 4) * 24;
        fillRoundRect(-26, -bh, 52, bh, 3, ['#c98a5a', '#9aa0aa', '#b0728a'][variant % 3]);
        ctx.fillStyle = '#3a4250';
        for (var wy = -bh + 12; wy < -10; wy += 18) {
          for (var wx = -18; wx < 18; wx += 16) ctx.fillRect(wx, wy, 9, 10);
        }
        break;
      case 'hydrant':
        fillRoundRect(-6, -2, 12, 18, 3, '#cf2b2b'); fillCircle(0, -6, 7, '#cf2b2b');
        fillRoundRect(-10, 2, 4, 5, 2, '#a02020'); fillRoundRect(6, 2, 4, 5, 2, '#a02020');
        break;
      case 'crosswalk':
        ctx.fillStyle = '#e8e6df';
        for (var cs = -24; cs < 24; cs += 10) ctx.fillRect(cs, -4, 6, 30);
        break;
      case 'sidewalk':
        fillRoundRect(-30, -6, 60, 12, 2, '#b9bcc4');
        ctx.strokeStyle = '#8a8f99'; ctx.lineWidth = 1.5;
        for (var sw = -20; sw < 30; sw += 18) { ctx.beginPath(); ctx.moveTo(sw, -6); ctx.lineTo(sw, 6); ctx.stroke(); }
        break;
      default: break;
    }
    ctx.restore();
  }

  // Cars are poopable bonus targets: cel-cartoon body + a roof BULLSEYE (golden
  // = convertible w/ a person inside). Facing follows driveSpeed sign.
  function paintCarSprite(car) {
    var s = car.r / 22;
    var facing = (car.driveSpeed || 0) >= 0 ? 1 : -1;
    var color = car.golden ? '#e0a800' : ['#d24b4b', '#3b78d2', '#4caf6a', '#b0728a'][(car.lane || 0) % 4];
    ctx.save();
    ctx.translate(car.x, car.y); ctx.scale(s, 1);
    ctx.save();
    ctx.scale(facing, 1);
    fillCircle(-16, 16, 7, '#23262f'); fillCircle(16, 16, 7, '#23262f');
    fillCircle(-16, 16, 3, '#9a9aa2'); fillCircle(16, 16, 3, '#9a9aa2');
    fillRoundRect(-30, -2, 60, 18, 6, color);
    if (car.golden) {
      fillRoundRect(-14, -10, 26, 10, 4, color);
      fillCircle(0, -12, 6, '#e9bb8e'); // driver
    } else {
      fillRoundRect(-16, -16, 32, 14, 5, '#8fd0e6'); // cabin/windshield
    }
    fillCircle(30, 6, 3, '#fff3c0'); // headlight
    ctx.restore();
    ctx.restore();
    // Roof bullseye (screen-space, what's scored) + splat glob if hit.
    var bx = car.x, by = car.y - car.r * 0.35;
    drawBullseye(bx, by, car.r, car.golden, car.splatted);
    if (car.splatted) splatGlob(bx, by, car.r * 0.8);
  }

  // ── Bird painters (one per tier, cel style) ──────────────────────────
  function paintBird(bird, x, y, flap, hurt) {
    var tier = 0;
    for (var i = 0; i < (GC.BIRDS || []).length; i++) if (GC.BIRDS[i].name === bird.name) tier = i;
    var sz = 14 + tier * 4;
    var body = ['#6b4f33', '#7c7c86', '#dfe3ea', '#6b3f2a', '#e8e6df'][tier] || '#6b4f33';
    var beak = ['#e8a13a', '#e8a13a', '#e8a13a', '#d8d05a', '#e89a2a'][tier] || '#e8a13a';
    if (hurt) body = '#ff8f8f'; // hurt flash tint
    var wingY = Math.sin(flap) * sz * 0.4;
    ctx.save();
    ctx.globalAlpha = 0.22; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(x, y + sz + 14, sz * 0.9, sz * 0.32, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(x - sz * 0.9, y - wingY, sz * 0.8, sz * 0.4, -0.5, 0, Math.PI * 2); ctx.fill(); outline(3); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(x + sz * 0.9, y - wingY, sz * 0.8, sz * 0.4, 0.5, 0, Math.PI * 2); ctx.fill(); outline(3); ctx.stroke();
    fillCircle(x, y, sz, body);
    fillCircle(x, y - sz * 0.8, sz * 0.6, body);
    ctx.fillStyle = beak; ctx.beginPath();
    ctx.moveTo(x - 4, y - sz * 0.8 + sz * 0.4); ctx.lineTo(x + 4, y - sz * 0.8 + sz * 0.4); ctx.lineTo(x, y - sz * 0.8 + sz * 0.4 + 8);
    ctx.closePath(); ctx.fill(); outline(2); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x - sz * 0.25, y - sz * 0.9, 3, 0, Math.PI * 2); ctx.arc(x + sz * 0.25, y - sz * 0.9, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = OUTLINE; ctx.beginPath(); ctx.arc(x - sz * 0.25, y - sz * 0.9, 1.4, 0, Math.PI * 2); ctx.arc(x + sz * 0.25, y - sz * 0.9, 1.4, 0, Math.PI * 2); ctx.fill();
  }

  // ══════════════════════════════════════════════════════════════════
  //  PARALLAX WORLD (≥3 layers scrolling DOWN at different rates) +
  //  PARK<->CITY biome cross-fade.
  // ══════════════════════════════════════════════════════════════════
  // Per-biome palettes for sky/ground.
  function biomePalette(biome) {
    if (biome === 'city') {
      return { sky: '#aeb9cf', ground: '#7c828e', ground2: '#757b87', path: '#5b6068', far: '#6e7894' };
    }
    return { sky: '#bfe6f2', ground: '#6fae4e', ground2: '#67a647', path: '#d8c79a', far: '#3f7a4a' };
  }

  // Lerp two hex colors (#rrggbb) by t in [0,1].
  function lerpHex(a, b, t) {
    var ai = parseInt(a.slice(1), 16), bi = parseInt(b.slice(1), 16);
    var ar = (ai >> 16) & 255, ag = (ai >> 8) & 255, ab = ai & 255;
    var br = (bi >> 16) & 255, bg = (bi >> 8) & 255, bb = bi & 255;
    var r = Math.round(ar + (br - ar) * t);
    var g = Math.round(ag + (bg - ag) * t);
    var bl = Math.round(ab + (bb - ab) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  // Blend current biome palette toward the next biome near a band boundary.
  function blendedPalette(scroll) {
    var cur = biomePalette(biomeAt(scroll));
    var amt = blendAt(scroll);
    if (amt <= 0) return cur;
    var nxt = biomePalette(biomeAt(scroll + BAND_LEN));
    return {
      sky: lerpHex(toHex(cur.sky), toHex(nxt.sky), amt),
      ground: lerpHex(toHex(cur.ground), toHex(nxt.ground), amt),
      ground2: lerpHex(toHex(cur.ground2), toHex(nxt.ground2), amt),
      path: lerpHex(toHex(cur.path), toHex(nxt.path), amt),
      far: lerpHex(toHex(cur.far), toHex(nxt.far), amt)
    };
  }
  function toHex(c) { return c.charAt(0) === '#' ? c : '#6fae4e'; }

  // Layer 1 (far): skyline / treeline silhouettes, slowest scroll.
  function drawFarLayer(scroll, pal, biome) {
    var skyH = 78;
    ctx.fillStyle = pal.sky; ctx.fillRect(0, 0, W, H);
    var rowH = 220;
    var off = (scroll * 0.3) % rowH;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = pal.far;
    for (var base = skyH - rowH; base < H + rowH; base += rowH) {
      var sy = base + off;
      var row = Math.floor((base) / rowH);
      if (biome === 'city') {
        // skyline of distant buildings
        for (var bx = 0; bx < W; bx += 46) {
          var bh = 40 + hash(row * 13 + bx) * 90;
          ctx.fillRect(bx + 4, sy - bh, 38, bh);
        }
      } else {
        // distant treeline
        for (var tx = 0; tx < W + 40; tx += 54) {
          var th = 30 + hash(row * 9 + tx) * 30;
          ctx.beginPath(); ctx.ellipse(tx, sy, 34, th, 0, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // Layer 2 (mid): the ground bands + path ribbon, medium scroll.
  function drawMidLayer(scroll, pal, biome) {
    var skyH = 78;
    ctx.fillStyle = pal.ground; ctx.fillRect(0, skyH, W, H - skyH);
    var rowH = 96;
    var off = scroll % rowH;
    for (var y = skyH - rowH; y < H + rowH; y += rowH) {
      var sy = y + off;
      var row = Math.floor((sy - off + scroll) / rowH);
      ctx.fillStyle = row % 2 === 0 ? pal.ground : pal.ground2;
      if (sy + rowH > skyH) ctx.fillRect(0, Math.max(skyH, sy), W, rowH);
      if (biome === 'park') {
        for (var k = 0; k < 3; k++) {
          if (hash(row * 9 + k) < 0.4) {
            var bx = hash(row * 7 + k * 3) * W;
            var by = sy + hash(row * 5 + k) * rowH;
            if (by < skyH) continue;
            ctx.save(); ctx.globalAlpha = 0.16; ctx.fillStyle = '#1d3a14';
            ctx.beginPath(); ctx.ellipse(bx, by, 26 + hash(row + k) * 18, 18 + hash(row * 2 + k) * 10, 0, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
          }
        }
      }
    }
    // path / road ribbon
    var pw = biome === 'city' ? 90 : 44;
    ctx.fillStyle = pal.path;
    ctx.beginPath();
    var amp = biome === 'city' ? W * 0.08 : W * 0.28;
    var freq = biome === 'city' ? 0.005 : 0.012;
    for (var py = skyH; py <= H; py += 12) {
      var cx = W / 2 + Math.sin((py + scroll) * freq) * amp;
      if (py === skyH) ctx.moveTo(cx - pw, py); else ctx.lineTo(cx - pw, py);
    }
    for (var py2 = H; py2 >= skyH; py2 -= 12) {
      var cx2 = W / 2 + Math.sin((py2 + scroll) * freq) * amp;
      ctx.lineTo(cx2 + pw, py2);
    }
    ctx.closePath(); ctx.fill();
    // road lane dashes in the city
    if (biome === 'city') {
      ctx.strokeStyle = '#e8d24a'; ctx.lineWidth = 3; ctx.setLineDash([16, 14]);
      ctx.lineDashOffset = -(scroll % 30);
      ctx.beginPath();
      for (var ly = skyH; ly <= H; ly += 12) {
        var lcx = W / 2 + Math.sin((ly + scroll) * freq) * amp;
        if (ly === skyH) ctx.moveTo(lcx, ly); else ctx.lineTo(lcx, ly);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // ── HUD (hearts top-left, score, bird, timer, combo ribbon) ──────────
  function drawHearts(x, y) {
    var f = game;
    var hh = f.health || { hearts: 0, maxHearts: START_HEARTS };
    var max = hh.maxHearts || START_HEARTS;
    for (var i = 0; i < max; i++) {
      var hx = x + i * 28, full = i < hh.hearts;
      ctx.save();
      ctx.translate(hx, y);
      ctx.fillStyle = full ? '#ff5b6e' : 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.moveTo(0, 4);
      ctx.bezierCurveTo(-9, -6, -10, 6, 0, 12);
      ctx.bezierCurveTo(10, 6, 9, -6, 0, 4);
      ctx.closePath(); ctx.fill();
      if (full) { outline(2.5); ctx.stroke(); }
      ctx.restore();
    }
  }

  function drawHUD() {
    var f = game;
    var bird = birdForScore(f.score.score);
    ctx.save();
    ctx.fillStyle = 'rgba(20,22,34,0.55)';
    ctx.fillRect(0, 0, W, 48);
    // hearts top-left
    drawHearts(16, 14);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 17px ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('SCORE ' + f.score.score, W / 2, 17);
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.fillText(bird.name + '  ·  ' + (f.biome === 'city' ? 'CITY' : 'PARK'), W / 2, 36);
    ctx.textAlign = 'right';
    ctx.font = 'bold 17px ui-monospace, monospace';
    ctx.fillText('⏱ ' + Math.ceil(f.t), W - 12, 24);
    ctx.restore();

    if (f.score.combo > 1) {
      ctx.save();
      ctx.fillStyle = '#ffd23f';
      ctx.font = 'bold 22px ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('COMBO x' + f.score.combo, W / 2, 70);
      ctx.restore();
    }
  }

  // ── Particles + speed lines ──────────────────────────────────────────
  function drawParticles() {
    if (!game) return;
    var i;
    for (i = 0; i < game.speedLines.length; i++) {
      var sl = game.speedLines[i];
      ctx.save();
      ctx.globalAlpha = Math.min(0.5, sl.t * 1.6);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sl.x, sl.y); ctx.lineTo(sl.x, sl.y + sl.len); ctx.stroke();
      ctx.restore();
    }
    for (i = 0; i < game.particles.length; i++) {
      var p = game.particles[i];
      var a = Math.max(0, 1 - p.t / p.life);
      ctx.save();
      ctx.globalAlpha = a;
      if (p.kind === 'feather') {
        ctx.fillStyle = p.color;
        ctx.translate(p.x, p.y); ctx.rotate(p.t * 6);
        ctx.beginPath(); ctx.ellipse(0, 0, p.r * 1.6, p.r * 0.7, 0, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  // ── Screens ──────────────────────────────────────────────────────────
  function drawTitle() {
    var scroll = titleT * 40;
    var pal = blendedPalette(scroll);
    var biome = biomeAt(scroll);
    drawFarLayer(scroll, pal, biome);
    drawMidLayer(scroll, pal, biome);

    var bird = (GC.BIRDS && GC.BIRDS[0]) || { name: 'Sparrow' };
    var cx = W / 2 + Math.cos(titleT * 1.2) * 130;
    var cy = H * 0.4 + Math.sin(titleT * 1.2) * 70;
    paintBird(bird, cx, cy, titleT * 12, false);

    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    fillRoundRect(W / 2 - 232, 130, 464, 172, 16, 'rgba(20,22,34,0.66)');
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 34px ui-monospace, monospace';
    ctx.fillText('HOW BIRDS', W / 2, 172);
    ctx.fillText('SEE THE WORLD', W / 2, 210);
    ctx.fillStyle = '#fff';
    ctx.font = 'italic 15px serif';
    ctx.fillText('park-goers wear bullseyes · dodge the city', W / 2, 246);

    // Difficulty selector (← → to change target size).
    var d = diff();
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('DIFFICULTY  (← →)', W / 2, 272);
    ctx.font = 'bold 22px ui-monospace, monospace';
    ctx.fillStyle = d.id === 'easy' ? '#7fd47f' : d.id === 'hard' ? '#ff7a6e' : '#ffd23f';
    ctx.fillText('◀  ' + d.label + '  ▶', W / 2, 296);
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('targets ' + (d.targetScale > 1 ? 'bigger' : d.targetScale < 1 ? 'smaller' : 'normal') + ' · ' + d.hearts + ' hearts', W / 2, 314);

    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.fillStyle = '#fff';
    ctx.fillText('— PRESS ENTER —', W / 2, 344);

    ctx.font = '13px ui-monospace, monospace';
    ctx.fillStyle = '#fff';
    ctx.fillText('ARROWS / WASD or DRAG to fly · SPACE to poop', W / 2, H - 120);
    ctx.fillText('❤️❤️❤️ DODGE signs, poles & rival birds', W / 2, H - 98);
    ctx.fillText('closer to center scores more · P pause · R restart', W / 2, H - 76);
    ctx.restore();
  }

  // Shared world draw for play/rank/paused.
  function drawWorld(f) {
    var pal = blendedPalette(f.scroll);
    var biome = biomeAt(f.scroll);
    drawFarLayer(f.scroll, pal, biome);
    drawMidLayer(f.scroll, pal, biome);

    var i;
    // Near props (scenery) UNDER actors.
    for (i = 0; i < f.props.length; i++) paintProp(f.props[i]);
    // Cars (drive on roads; under park-goers but they're a separate plane).
    for (i = 0; i < f.cars.length; i++) paintCarSprite(f.cars[i]);
    // Persistent splat decals (under targets).
    for (i = 0; i < f.decals.length; i++) splatGlob(f.decals[i].x, f.decals[i].y, f.decals[i].r * 0.8);
    // Targets sorted by y so lower ones overlap correctly.
    f.targets.slice().sort(function (a, b) { return a.y - b.y; }).forEach(paintTarget);
    // Hazards (drawn above targets — the dodge layer the player reads).
    for (i = 0; i < f.hazards.length; i++) paintHazard(f.hazards[i]);
    // Payloads (falling poop).
    for (i = 0; i < f.payloads.length; i++) {
      var p = f.payloads[i];
      var s = 1 - (p.t / p.dur) * 0.4;
      fillCircle(p.x, p.y, 6 * s, '#6b5326');
    }
  }

  function drawPlay() {
    var f = game;
    drawWorld(f);
    drawParticles();
    // Bird — blink during i-frames, tint while hurtFlash active.
    var bird = birdForScore(f.score.score);
    var blink = healthInvuln(f.health) ? (Math.floor(titleT * 18) % 2 === 0) : false;
    if (!blink) paintBird(bird, f.bird.x, f.bird.y, f.bird.flapT, f.bird.hurtFlash > 0);
    drawHUD();
  }

  function drawPaused() {
    drawPlay();
    ctx.save();
    ctx.fillStyle = 'rgba(20,22,34,0.55)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 34px ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('PAUSED', W / 2, H / 2 - 20);
    ctx.fillStyle = '#fff';
    ctx.font = '16px ui-monospace, monospace';
    ctx.fillText('press P to resume · R to restart', W / 2, H / 2 + 20);
    ctx.restore();
  }

  // Rank card geometry shared by draw + tap hit-testing.
  function rankButtons() {
    return {
      copy: { x: W / 2 - 120, y: H - 170, w: 110, h: 48 },
      save: { x: W / 2 + 10, y: H - 170, w: 110, h: 48 }
    };
  }

  function drawRank() {
    var f = game;
    drawWorld(f);
    ctx.save();
    ctx.fillStyle = 'rgba(20,22,34,0.8)';
    ctx.fillRect(0, 0, W, H);
    var rank = rankForScore(f.score.score);
    var bird = birdForScore(f.score.score);
    var hearts = f.health ? f.health.hearts : 0;
    var heartBonus = hearts * 250;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 30px ui-monospace, monospace';
    ctx.fillText(hearts > 0 ? 'ROUND COMPLETE' : 'DOWN YOU GO', W / 2, 130);

    paintBird(bird, W / 2, 220, titleT * 14, false);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px ui-monospace, monospace';
    ctx.fillText('SCORE ' + f.score.score, W / 2, 310);
    ctx.font = '17px ui-monospace, monospace';
    ctx.fillText('Best bird: ' + bird.name, W / 2, 348);
    ctx.fillText('Best combo: x' + (f.score.bestCombo || 1) + '   Splats: ' + f.splats, W / 2, 376);
    // hearts-left bonus line (contract)
    ctx.fillStyle = '#ff8f8f';
    ctx.font = 'bold 17px ui-monospace, monospace';
    ctx.fillText('❤️ Hearts left: ' + hearts + '  (+' + heartBonus + ' bonus)', W / 2, 408);
    ctx.fillStyle = '#7fd4ff';
    ctx.font = 'bold 26px ui-monospace, monospace';
    ctx.fillText('RANK: ' + rank.name.toUpperCase(), W / 2, 456);

    var b = rankButtons();
    fillRoundRect(b.copy.x, b.copy.y, b.copy.w, b.copy.h, 10, '#2aa7a0');
    fillRoundRect(b.save.x, b.save.y, b.save.w, b.save.h, 10, '#8c5a9e');
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px ui-monospace, monospace';
    ctx.fillText('📋 COPY', b.copy.x + b.copy.w / 2, b.copy.y + b.copy.h / 2);
    ctx.fillText('💾 SAVE CARD', b.save.x + b.save.w / 2, b.save.y + b.save.h / 2);

    ctx.fillStyle = '#fff';
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillText('— PRESS ENTER TO FLY AGAIN —', W / 2, H - 80);
    ctx.restore();
  }

  function drawCrash() {
    ctx.save();
    ctx.fillStyle = '#20232e'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ff6b6b';
    ctx.font = 'bold 22px ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('— OOPS, THE FLOCK SCATTERED —', W / 2, H / 2 - 20);
    ctx.fillStyle = '#fff';
    ctx.font = '16px ui-monospace, monospace';
    ctx.fillText('Press ENTER / tap OK to restart', W / 2, H / 2 + 20);
    ctx.restore();
  }

  function drawFloatsAndToasts() {
    if (!game) return;
    var i;
    for (i = 0; i < game.floats.length; i++) {
      var ft = game.floats[i];
      ctx.globalAlpha = Math.min(1, ft.t);
      ctx.fillStyle = ft.color;
      ctx.font = 'bold 16px ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ft.text, ft.x, ft.y);
      ctx.globalAlpha = 1;
    }
    for (i = 0; i < game.toasts.length; i++) {
      var to = game.toasts[i];
      ctx.globalAlpha = Math.min(1, to.t);
      ctx.fillStyle = '#ffd23f';
      ctx.font = 'bold 26px ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(to.text, W / 2, 130 + i * 40);
      ctx.globalAlpha = 1;
    }
  }

  function draw() {
    ctx.save();
    if (game && game.shakeT > 0) {
      ctx.translate((Math.random() - 0.5) * game.shakeMag, (Math.random() - 0.5) * game.shakeMag);
    }
    if (crashed) drawCrash();
    else if (screen === 'title') drawTitle();
    else if (screen === 'play') drawPlay();
    else if (screen === 'paused') drawPaused();
    else if (screen === 'rank') drawRank();
    if (!crashed && screen !== 'rank') drawFloatsAndToasts();
    ctx.restore();
  }

  // ── Crash-proof rAF loop ─────────────────────────────────────────────
  function loop(ts) {
    var dt = Math.min(0.05, (ts - last) / 1000 || 0);
    last = ts;
    try {
      if (!crashed) { update(dt); }
      draw();
    } catch (err) {
      crashed = true;
      if (window.console && console.error) console.error('HBSTW loop error:', err);
      try { draw(); } catch (e2) { /* last resort: stay alive */ }
    }
    requestAnimationFrame(loop);
  }

  // ── Audio (WebAudio gags) ────────────────────────────────────────────
  var actx = null;
  function audio() {
    if (actx) return actx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    } catch (e) { actx = null; }
    return actx;
  }
  function tone(freqStart, freqEnd, dur, type, gainV) {
    var a = audio();
    if (!a) return;
    try {
      var o = a.createOscillator(), g = a.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freqStart, a.currentTime);
      o.frequency.linearRampToValueAtTime(freqEnd, a.currentTime + dur);
      g.gain.setValueAtTime(gainV || 0.12, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
      o.connect(g); g.connect(a.destination);
      o.start(); o.stop(a.currentTime + dur);
    } catch (e) { /* audio is best-effort */ }
  }
  function audioPoop() { tone(900, 220, 0.32, 'sine', 0.12); }
  function audioSplat() { tone(160, 60, 0.16, 'square', 0.10); }
  function audioTierUp() { tone(440, 880, 0.18, 'triangle', 0.14); tone(660, 1320, 0.22, 'triangle', 0.1); }
  function audioFanfare() { tone(523, 784, 0.3, 'triangle', 0.12); }
  function audioHurt() { tone(300, 90, 0.22, 'sawtooth', 0.12); }

  function dropPayload() {
    if (screen !== 'play' || !game) return;
    var bird = birdForScore(game.score.score);
    game.payloads.push({ x: game.bird.x, y: game.bird.y, t: 0, dur: 0.42, splatR: bird.splatRadius || 16 });
    audioPoop();
  }

  // ── Input ──────────────────────────────────────────────────────────
  function norm(k) {
    if (k === ' ' || k === 'Spacebar') return ' ';
    return (k || '').toLowerCase();
  }
  function clearKeys() { keys = {}; pointer.active = false; }

  function togglePause() {
    if (screen === 'play') screen = 'paused';
    else if (screen === 'paused') screen = 'play';
  }

  function onKeyDown(e) {
    var k = norm(e.key);
    keys[k] = true;
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].indexOf(k) >= 0 && e.preventDefault) e.preventDefault();
    if (e.repeat) return;

    if (crashed) {
      if (k === 'enter') { crashed = false; game = null; screen = 'title'; }
      return;
    }
    if (screen === 'title' && (k === 'arrowleft' || k === 'a')) {
      diffIdx = (diffIdx + DIFFICULTIES.length - 1) % DIFFICULTIES.length;
    }
    if (screen === 'title' && (k === 'arrowright' || k === 'd')) {
      diffIdx = (diffIdx + 1) % DIFFICULTIES.length;
    }
    if (k === 'enter') {
      if (screen === 'title') startPlay();
      else if (screen === 'rank') { game = null; screen = 'title'; }
    }
    if (k === 'p') togglePause();
    if (k === 'r') {
      if (screen === 'play' || screen === 'paused' || screen === 'rank') startPlay();
    }
    if (k === ' ') dropPayload();
    if (screen === 'rank') {
      if (k === 'c') copyResult();
      if (k === 's') saveCard();
    }
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
    if (screen === 'rank') {
      var b = rankButtons();
      if (inRect(pt, b.copy)) { copyResult(); e.preventDefault(); return; }
      if (inRect(pt, b.save)) { saveCard(); e.preventDefault(); return; }
      game = null; screen = 'title'; e.preventDefault(); return;
    }
    if (crashed) { crashed = false; game = null; screen = 'title'; e.preventDefault(); return; }
    if (screen === 'title') { startPlay(); e.preventDefault(); return; }
    if (screen === 'play') {
      pointer.x = pt.x; pointer.y = pt.y; pointer.active = true;
      if (e.preventDefault) e.preventDefault();
    }
  }
  function onPointerMove(e) {
    if (screen !== 'play') return;
    var pt = canvasPoint(e);
    pointer.x = pt.x; pointer.y = pt.y;
    if (pointer.active && e.preventDefault) e.preventDefault();
  }
  function onPointerUp() { pointer.active = false; }

  // ── Share: COPY RESULT + SAVE CARD ───────────────────────────────────
  function copyResult() {
    if (!game) return;
    var text = shareTextFor(game);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        toast('COPIED!');
      } else {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('COPIED!'); } catch (e) {}
        document.body.removeChild(ta);
      }
    } catch (e) { /* clipboard best-effort */ }
  }
  function saveCard() {
    if (!canvas) return;
    try {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) {
          if (!blob) return;
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = 'how-birds-see-the-world.png';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }, 'image/png');
        toast('CARD SAVED!');
      }
    } catch (e) { /* save best-effort */ }
  }

  // ── Wiring ───────────────────────────────────────────────────────────
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearKeys);
  window.addEventListener('visibilitychange', function () {
    clearKeys();
    if (document.hidden && screen === 'play') screen = 'paused';
  });

  // Test hook for the headless shell smoke test.
  window.__HB = {
    getScreen: function () { return screen; },
    getGame: function () { return game; },
    isCrashed: function () { return crashed; },
    forceCrash: function () { crashed = true; },
    // v2 helpers: force a hazard collision + read hearts (used by shell test).
    // Builds a real-shaped hazard instance whose hitbox sits ON the bird, so
    // the next updatePlay frame registers a collision deterministically.
    spawnHazardUnderBird: function (family) {
      if (!game) return null;
      var fam = family || 'poles';
      var bx = game.bird.x, by = game.bird.y;
      var hz = {
        id: 'hz-test', defId: fam === 'signs' ? 'sign-stop' : (fam === 'rival-birds' ? 'rival-pigeon' : 'pole-lamp'),
        family: fam, kind: fam === 'rival-birds' ? 'mover' : 'static',
        x: bx, y: by, vy: 0, age: 0, drift: 0, weave: 0, weaveHz: 0, dir: 1,
        boxOffsetX: 0, boxOffsetY: 0, postH: 0,
        box: fam === 'signs'
          ? { kind: 'aabb', x: bx, y: by, hw: 22, hh: 22 }
          : { kind: 'circle', x: bx, y: by, hr: fam === 'rival-birds' ? 16 : 16 }
      };
      game.hazards.push(hz);
      return hz;
    },
    getHearts: function () { return game && game.health ? game.health.hearts : null; },
    isInvuln: function () { return game ? healthInvuln(game.health) : false; },
    clearInvuln: function () { if (game && game.health) game.health.invuln = 0; }
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
