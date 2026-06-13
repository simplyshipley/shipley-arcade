/*
 * SPLAT HAPPENS — pure game logic, no DOM.
 * Loaded by the browser as window.GameCore and by Node tests via require().
 *
 * Owns: round timer (with in-flight payload gating), combo chain (5s
 * window, x1-x5, ground splats NEVER break it), splat resolution scanning
 * ALL overlapping targets, reaction album model, target FSM engine (steps
 * verb+delay sequences as pure state — the shell renders the events),
 * deterministic rng + spawn scheduler (rarity weights 6/3/1), and the
 * Wordle-style share-text generator.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GameCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────────────
  var ROUND_SECONDS = 120;
  var COMBO_WINDOW_SECONDS = 5;
  var COMBO_MAX_MULTIPLIER = 5;
  var GOLDEN_MULTIPLIER = 3;
  var SPEAK_MAX_CHARS = 30;
  var RARITY_WEIGHTS = { common: 6, uncommon: 3, rare: 1 };
  var RARITIES = ['common', 'uncommon', 'rare'];
  var WALK_PATTERNS = ['stroll', 'jog', 'idle', 'patrol'];
  var COUNTERS = ['umbrella', 'dodge', 'catch'];
  var MAX_TRANSFORM_STATES = 2;

  // The buildable comedy alphabet — the shell implements each verb ONCE.
  var VERBS = [
    'hop', 'shake', 'spin', 'flee', 'chase', 'faint', 'launch',
    'splash', 'speak', 'rage', 'slip', 'transform', 'summon', 'freeze'
  ];

  // ── Deterministic RNG (Park–Miller minimal standard) ────────────────
  // Same seed → same sequence, on every platform. Returns [0, 1).
  function createRng(seed) {
    var s = Math.floor(Math.abs(seed || 0)) % 2147483647;
    if (s === 0) s = 1;
    return function () {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  // ── Round timer ─────────────────────────────────────────────────────
  // Engineering rule: resolve in-flight payloads before round end — the
  // clock can hit zero but the round is only OVER once every launched
  // payload has splatted.
  function RoundTimer(durationSec) {
    this.duration = typeof durationSec === 'number' ? durationSec : ROUND_SECONDS;
    this.elapsed = 0;
    this.paused = false;
    this.pendingPayloads = 0;
  }
  RoundTimer.prototype.update = function (dt) {
    if (this.paused) return;
    this.elapsed = Math.min(this.duration, this.elapsed + Math.max(0, dt));
  };
  RoundTimer.prototype.remaining = function () {
    return Math.max(0, this.duration - this.elapsed);
  };
  RoundTimer.prototype.timeUp = function () {
    return this.elapsed >= this.duration;
  };
  RoundTimer.prototype.pause = function () { this.paused = true; };
  RoundTimer.prototype.resume = function () { this.paused = false; };
  RoundTimer.prototype.payloadLaunched = function () {
    this.pendingPayloads += 1;
  };
  RoundTimer.prototype.payloadResolved = function () {
    if (this.pendingPayloads > 0) this.pendingPayloads -= 1;
  };
  RoundTimer.prototype.isOver = function () {
    return this.timeUp() && this.pendingPayloads === 0;
  };

  // ── Combo chain ─────────────────────────────────────────────────────
  // Consecutive TARGET hits within the window chain a multiplier x1→x5.
  // Ground splats never break the chain (decals are joy, not failure) —
  // they simply don't extend the window either. The chain only fades
  // when more than `window` seconds pass between target hits.
  function ComboTracker(windowSec, maxMultiplier) {
    this.window = typeof windowSec === 'number' ? windowSec : COMBO_WINDOW_SECONDS;
    this.max = typeof maxMultiplier === 'number' ? maxMultiplier : COMBO_MAX_MULTIPLIER;
    this.chain = 0;
    this.bestChain = 0;
    this.lastHitAt = -Infinity;
  }
  // Register a target hit at absolute round time `timeSec`; returns the
  // multiplier to apply to THIS hit.
  ComboTracker.prototype.registerHit = function (timeSec) {
    if (timeSec - this.lastHitAt <= this.window) {
      this.chain += 1;
    } else {
      this.chain = 1;
    }
    this.lastHitAt = timeSec;
    if (this.chain > this.bestChain) this.bestChain = this.chain;
    return this.multiplier();
  };
  // Ground splat: explicitly a no-op on the chain. Kept as a method so
  // the shell calls ONE thing per splat outcome and the rule is visible.
  ComboTracker.prototype.registerGroundSplat = function () {
    return this.multiplier();
  };
  ComboTracker.prototype.multiplier = function () {
    return Math.max(1, Math.min(this.chain, this.max));
  };
  ComboTracker.prototype.bestMultiplier = function () {
    return Math.max(1, Math.min(this.bestChain, this.max));
  };
  ComboTracker.prototype.isActive = function (timeSec) {
    return this.chain > 0 && (timeSec - this.lastHitAt) <= this.window;
  };

  // ── Geometry: splat circle vs target box ────────────────────────────
  function circleRectOverlap(cx, cy, r, rx, ry, rw, rh) {
    var nx = Math.max(rx, Math.min(cx, rx + rw));
    var ny = Math.max(ry, Math.min(cy, ry + rh));
    var dx = cx - nx;
    var dy = cy - ny;
    return (dx * dx + dy * dy) <= r * r;
  }

  // ── Splat resolution ────────────────────────────────────────────────
  // Scans ALL overlapping targets — never just the nearest-center one
  // (lesson already paid for). splat = {x, y, r}; each target must carry
  // a box {x, y, w, h}. Returns every overlapped target, in input order.
  function resolveSplat(splat, targets) {
    var hits = [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (circleRectOverlap(splat.x, splat.y, splat.r, t.x, t.y, t.w, t.h)) {
        hits.push(t);
      }
    }
    return hits;
  }

  // ── Reaction param parsing ──────────────────────────────────────────
  // Params are 'key:value,key:value' strings. speak is special: the
  // entire remainder after 'line:' is the line (lines may contain
  // commas). Numeric values are coerced to numbers.
  function parseParams(verb, params) {
    var out = {};
    if (!params) return out;
    if (verb === 'speak') {
      out.line = params.indexOf('line:') === 0 ? params.slice(5) : params;
      return out;
    }
    var parts = params.split(',');
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var idx = part.indexOf(':');
      if (idx === -1) {
        if (part) out[part] = true;
        continue;
      }
      var key = part.slice(0, idx);
      var raw = part.slice(idx + 1);
      var num = Number(raw);
      out[key] = (raw !== '' && !isNaN(num)) ? num : raw;
    }
    return out;
  }

  // ── Target FSM engine ───────────────────────────────────────────────
  // Pure state. hit() picks which reaction plays (first / repeat /
  // golden) and step(dt) emits {verb, params} events as their delays
  // come due — the shell renders them. Persistent transforms accumulate
  // until round end and flip state() (at most 2 states per target).
  function TargetFSM(def) {
    this.def = def;
    this.hits = 0;
    this.transforms = [];
    this.reaction = null; // { kind, steps, elapsed, fired }
  }
  // Current persistent state: 'base' until a transform lands, then the
  // most recent transform state.
  TargetFSM.prototype.state = function () {
    return this.transforms.length
      ? this.transforms[this.transforms.length - 1]
      : 'base';
  };
  // Register a hit. golden=true plays the golden variant when the target
  // defines one (worth 3x); a golden hit on a target with no golden
  // variant still pays 3x but plays the normal reaction.
  // Returns { kind, points, albumKey } — albumKey is null for repeats
  // (album = first + golden variants only).
  TargetFSM.prototype.hit = function (golden) {
    var kind;
    if (golden && this.def.golden) kind = 'golden';
    else if (this.hits === 0) kind = 'first';
    else kind = 'repeat';
    this.hits += 1;
    var steps = this.def[kind] || [];
    var sorted = steps.slice().sort(function (a, b) { return a.delay - b.delay; });
    this.reaction = { kind: kind, steps: sorted, elapsed: 0, fired: 0 };
    return {
      kind: kind,
      points: this.def.points * (golden ? GOLDEN_MULTIPLIER : 1),
      albumKey: kind === 'repeat' ? null : this.def.id + ':' + kind
    };
  };
  // Advance the active reaction by dt seconds; returns the events whose
  // delays came due (possibly several in one step). Applies transform
  // verbs to persistent state as they fire.
  TargetFSM.prototype.step = function (dt) {
    if (!this.reaction) return [];
    var r = this.reaction;
    r.elapsed += Math.max(0, dt);
    var events = [];
    while (r.fired < r.steps.length && r.steps[r.fired].delay <= r.elapsed) {
      var s = r.steps[r.fired];
      if (s.verb === 'transform') {
        var p = parseParams('transform', s.params);
        if (p.state && this.transforms.indexOf(p.state) === -1) {
          this.transforms.push(p.state);
        }
      }
      events.push({ verb: s.verb, params: s.params, delay: s.delay });
      r.fired += 1;
    }
    if (r.fired >= r.steps.length) this.reaction = null;
    return events;
  };
  TargetFSM.prototype.busy = function () {
    return this.reaction !== null;
  };

  // ── Reaction album ──────────────────────────────────────────────────
  // Every distinct reaction discovered is recorded. Entries = one 'first'
  // per target + one 'golden' per target defining a golden variant.
  // Repeats are not album entries and unknown keys are rejected.
  function Album(roster) {
    this.catalog = [];
    this.byKey = {};
    for (var i = 0; i < roster.length; i++) {
      var t = roster[i];
      this._add(t.id + ':first', t.id, 'first', t.name);
      if (t.golden) {
        this._add(
          t.id + ':golden', t.id, 'golden',
          t.goldenName || (t.name + ' (Golden)')
        );
      }
    }
    this.total = this.catalog.length;
    this.discovered = {};
    this.count = 0;
  }
  Album.prototype._add = function (key, targetId, kind, name) {
    var entry = { key: key, targetId: targetId, kind: kind, name: name };
    this.catalog.push(entry);
    this.byKey[key] = entry;
  };
  // Returns true only the FIRST time a real album key is discovered.
  Album.prototype.discover = function (key) {
    if (!key || !this.byKey[key]) return false;
    if (this.discovered[key] === true) return false;
    this.discovered[key] = true;
    this.count += 1;
    return true;
  };
  Album.prototype.isDiscovered = function (key) {
    return this.discovered[key] === true;
  };
  // Full list for the end card: locked entries render as silhouettes.
  Album.prototype.list = function () {
    var out = [];
    for (var i = 0; i < this.catalog.length; i++) {
      var e = this.catalog[i];
      out.push({
        key: e.key,
        targetId: e.targetId,
        kind: e.kind,
        name: e.name,
        discovered: this.isDiscovered(e.key)
      });
    }
    return out;
  };
  // Just the locked ones (the silhouette list).
  Album.prototype.silhouettes = function () {
    var out = [];
    for (var i = 0; i < this.catalog.length; i++) {
      if (!this.isDiscovered(this.catalog[i].key)) out.push(this.catalog[i]);
    }
    return out;
  };

  // ── Deterministic spawn scheduler ───────────────────────────────────
  // Picks targets weighted by rarity (common 6 : uncommon 3 : rare 1,
  // per target). Same rng seed → same spawn sequence. Each next() draws
  // exactly three rng values (pick, golden roll, edge roll) so sequences
  // stay aligned regardless of which target was drawn.
  function Spawner(roster, rng, opts) {
    opts = opts || {};
    this.roster = roster;
    this.rng = rng || createRng(1);
    this.goldenChance = typeof opts.goldenChance === 'number' ? opts.goldenChance : 0.08;
    this.weights = [];
    this.totalWeight = 0;
    for (var i = 0; i < roster.length; i++) {
      var w = RARITY_WEIGHTS[roster[i].rarity] || 0;
      this.weights.push(w);
      this.totalWeight += w;
    }
  }
  Spawner.prototype.next = function () {
    var pickRoll = this.rng() * this.totalWeight;
    var goldenRoll = this.rng();
    var dirRoll = this.rng();
    var idx = 0;
    for (var i = 0; i < this.weights.length; i++) {
      idx = i;
      pickRoll -= this.weights[i];
      if (pickRoll < 0) break;
    }
    var def = this.roster[idx];
    return {
      def: def,
      golden: !!def.golden && goldenRoll < this.goldenChance,
      dir: dirRoll < 0.5 ? 'left' : 'right'
    };
  };

  // ── Share text (Wordle-style emoji summary) ─────────────────────────
  function formatScore(n) {
    var s = String(Math.max(0, Math.floor(n || 0)));
    var out = '';
    while (s.length > 3) {
      out = ',' + s.slice(-3) + out;
      s = s.slice(0, -3);
    }
    return s + out;
  }
  // stats = { score, bestCombo, discovered, total }
  function shareText(stats) {
    stats = stats || {};
    var score = typeof stats.score === 'number' ? stats.score : 0;
    var best = Math.max(1, stats.bestCombo || 1);
    var discovered = stats.discovered || 0;
    var total = stats.total || 0;
    var cells = 10;
    var filled = total > 0 ? Math.round((discovered / total) * cells) : 0;
    if (discovered > 0 && filled < 1) filled = 1;
    if (filled > cells) filled = cells;
    var bar = '';
    for (var i = 0; i < cells; i++) {
      bar += i < filled ? '💩' : '⬜';
    }
    return [
      '💩 SPLAT HAPPENS',
      '🏆 ' + formatScore(score) + ' pts',
      '🔥 Best combo ×' + best,
      '📒 Album ' + discovered + '/' + total,
      bar
    ].join('\n');
  }

  // ── Roster validation ───────────────────────────────────────────────
  // Used by the test suites and handy during shell dev. Returns an array
  // of human-readable problems; empty array = clean.
  function validateTarget(t) {
    var errs = [];
    var where = (t && t.id) ? t.id : '<no id>';
    function bad(msg) { errs.push(where + ': ' + msg); }

    if (!t || typeof t !== 'object') return ['target is not an object'];
    if (!t.id || typeof t.id !== 'string') bad('missing string id');
    if (!t.name || typeof t.name !== 'string') bad('missing string name');
    if (!t.sprite || !t.sprite.body || !t.sprite.head || !t.sprite.accent) {
      bad('sprite needs body/head/accent palette keys');
    }
    if (RARITIES.indexOf(t.rarity) === -1) bad('invalid rarity "' + t.rarity + '"');
    if (!(typeof t.points === 'number' && t.points > 0)) bad('points must be > 0');
    if (!t.walk || WALK_PATTERNS.indexOf(t.walk.pattern) === -1) {
      bad('walk.pattern must be one of ' + WALK_PATTERNS.join('/'));
    }
    if (!t.walk || typeof t.walk.speed !== 'number' || t.walk.speed < 0) {
      bad('walk.speed must be a number >= 0');
    }
    if (!(t.counter === null || t.counter === undefined || COUNTERS.indexOf(t.counter) !== -1)) {
      bad('counter must be null or one of ' + COUNTERS.join('/'));
    }

    var transformStates = [];
    function checkSteps(label, steps, required) {
      if (steps === null || steps === undefined) {
        if (required) bad(label + ' reaction is required');
        return;
      }
      if (!(steps instanceof Array) || steps.length === 0) {
        bad(label + ' must be a non-empty array');
        return;
      }
      for (var i = 0; i < steps.length; i++) {
        var s = steps[i];
        if (VERBS.indexOf(s.verb) === -1) {
          bad(label + '[' + i + '] invalid verb "' + s.verb + '"');
        }
        if (typeof s.delay !== 'number' || s.delay < 0) {
          bad(label + '[' + i + '] delay must be a number >= 0');
        }
        if (typeof s.params !== 'string') {
          bad(label + '[' + i + '] params must be a string');
        }
        if (s.verb === 'speak') {
          if (typeof s.params !== 'string' || s.params.indexOf('line:') !== 0) {
            bad(label + '[' + i + '] speak params must start with "line:"');
          } else {
            var line = s.params.slice(5);
            if (line.length === 0) bad(label + '[' + i + '] empty speak line');
            if (line.length > SPEAK_MAX_CHARS) {
              bad(label + '[' + i + '] speak line over ' + SPEAK_MAX_CHARS + ' chars: "' + line + '"');
            }
          }
        }
        if (s.verb === 'transform' && typeof s.params === 'string') {
          var st = parseParams('transform', s.params).state;
          if (!st) bad(label + '[' + i + '] transform needs a state param');
          else if (transformStates.indexOf(st) === -1) transformStates.push(st);
        }
      }
    }
    checkSteps('first', t.first, true);
    checkSteps('repeat', t.repeat, true);
    checkSteps('golden', t.golden, false);
    if (transformStates.length > MAX_TRANSFORM_STATES) {
      bad('more than ' + MAX_TRANSFORM_STATES + ' transform states: ' + transformStates.join(', '));
    }
    return errs;
  }

  function validateRoster(roster) {
    var errs = [];
    if (!(roster instanceof Array) || roster.length === 0) {
      return ['roster must be a non-empty array'];
    }
    var seen = {};
    for (var i = 0; i < roster.length; i++) {
      var t = roster[i];
      if (t && t.id) {
        if (seen[t.id]) errs.push('duplicate id "' + t.id + '"');
        seen[t.id] = true;
      }
      errs = errs.concat(validateTarget(t));
    }
    return errs;
  }

  return {
    // constants
    ROUND_SECONDS: ROUND_SECONDS,
    COMBO_WINDOW_SECONDS: COMBO_WINDOW_SECONDS,
    COMBO_MAX_MULTIPLIER: COMBO_MAX_MULTIPLIER,
    GOLDEN_MULTIPLIER: GOLDEN_MULTIPLIER,
    SPEAK_MAX_CHARS: SPEAK_MAX_CHARS,
    RARITY_WEIGHTS: RARITY_WEIGHTS,
    RARITIES: RARITIES,
    WALK_PATTERNS: WALK_PATTERNS,
    COUNTERS: COUNTERS,
    MAX_TRANSFORM_STATES: MAX_TRANSFORM_STATES,
    VERBS: VERBS,
    // rng
    createRng: createRng,
    // round
    RoundTimer: RoundTimer,
    // combo
    ComboTracker: ComboTracker,
    // geometry + splat resolution
    circleRectOverlap: circleRectOverlap,
    resolveSplat: resolveSplat,
    // reactions
    parseParams: parseParams,
    TargetFSM: TargetFSM,
    // album
    Album: Album,
    // spawning
    Spawner: Spawner,
    // share card
    formatScore: formatScore,
    shareText: shareText,
    // validation
    validateTarget: validateTarget,
    validateRoster: validateRoster
  };
});
