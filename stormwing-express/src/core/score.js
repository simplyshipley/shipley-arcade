/*
 * Scoring: base points table, the Tailwind ribbon multiplier (tier x1-x5),
 * the run Tally, and end-of-run ranks. Replaces the game-1 ScoreKeeper.
 * Spec-mandated lessons kept verbatim: empty-field actions NEVER decay the
 * tier; damage drops exactly one tier (never to x1); transitions freeze the
 * clock and carry the tier across.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Score = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BASE = {
    kill: 100,
    tetherCut: 150,
    cleanLanding: 150,
    redlineVent: 50,
    clotheslineCut: 50,
    masonrySmash: 50,
    eggCatch: 250,
    delivery: 300,
    rescue: 400,
    rivalPegged: 500,
    bullseye: 600,
    stageClear: 1500,
  };

  var TIER_MAX = 5;
  var DECAY_WINDOW = 4; // s

  // ── Tailwind: the ribbon-trail multiplier ───────────────────────────
  function Tailwind() {
    if (!(this instanceof Tailwind)) return new Tailwind();
    this.tier = 1;
    this.best = 1;            // best tier reached (rank card)
    this.clock = DECAY_WINDOW;
    this.frozen = false;
  }

  Tailwind.prototype.bump = function () {
    if (this.tier < TIER_MAX) this.tier += 1;
    if (this.tier > this.best) this.best = this.tier;
    this.clock = DECAY_WINDOW;
    return this.tier;
  };

  // The decay clock ONLY ticks while scorable targets are on-screen —
  // empty-field flying or slinging never decays the tier (game-1 lesson).
  // Expiry drops ONE tier (not to 1) and restarts the clock.
  Tailwind.prototype.update = function (dt, targetsOnScreen) {
    if (this.frozen || targetsOnScreen !== true) return;
    this.clock -= dt;
    // epsilon: accumulated float dts must still expire at exactly 4s
    if (this.clock <= 1e-9) {
      if (this.tier > 1) this.tier -= 1;
      this.clock = DECAY_WINDOW;
    }
  };

  // Hull damage drops EXACTLY one tier; the clock restarts so a
  // near-expired decay can't stack a second drop onto the same hit.
  Tailwind.prototype.damage = function () {
    if (this.tier > 1) this.tier -= 1;
    this.clock = DECAY_WINDOW;
    return this.tier;
  };

  Tailwind.prototype.freeze = function () { this.frozen = true; };
  Tailwind.prototype.thaw = function () { this.frozen = false; };

  // Felt progression: at tier x3+ sling shots leave +40 px/s hotter.
  Tailwind.prototype.muzzleBonus = function () {
    return this.tier >= 3 ? 40 : 0;
  };

  // ── Tally: run score, per-type counts, per-stage subtotals ──────────
  function Tally(tailwind) {
    if (!(this instanceof Tally)) return new Tally(tailwind);
    this.tailwind = tailwind || null;
    this.score = 0;
    this.counts = {};
    this.stageTotals = {};
    this.stage = 'run';
  }

  Tally.prototype.beginStage = function (key) {
    this.stage = key;
    if (this.stageTotals[key] == null) this.stageTotals[key] = 0;
    return this;
  };

  // Awards BASE[type] * tailwind.tier, then bumps the tier — scoring
  // actions chain the multiplier (spec: every scoring action within 4s of
  // the previous bumps +1). Unknown types score nothing and bump nothing.
  Tally.prototype.add = function (type, opts) {
    opts = opts || {};
    var base = BASE[type];
    if (!base) return 0;
    var tier = this.tailwind ? this.tailwind.tier : 1;
    var pts = base * tier;
    this.score += pts;
    this.counts[type] = (this.counts[type] || 0) + 1;
    var stage = opts.stage || this.stage;
    this.stageTotals[stage] = (this.stageTotals[stage] || 0) + pts;
    if (this.tailwind) this.tailwind.bump();
    return pts;
  };

  // Flat deduction (e.g. -500 restart). Never routed through add() so it
  // can't touch counts or the tailwind.
  Tally.prototype.penalty = function (pts) {
    this.score -= pts;
    this.stageTotals[this.stage] = (this.stageTotals[this.stage] || 0) - pts;
    return this.score;
  };

  // ── End-of-run rank (thresholds: design-spec scoring section) ───────
  var RANKS = ['BRONZE PIGEON', 'SILVER SWIFT', 'GOLD FALCON', 'STORM ROC'];

  function rankForRun(run) {
    run = run || {};
    var completeness = run.completeness || 0; // 0..1
    var restarts = run.restarts || 0;
    var index = 0;                                        // finish = BRONZE PIGEON
    if (completeness >= 0.5) index = 1;                   // SILVER SWIFT
    if (completeness >= 0.7 && restarts <= 2) index = 2;  // GOLD FALCON
    if (completeness >= 0.9 && restarts === 0 && run.beaconFirstTry === true) {
      index = 3;                                          // STORM ROC
    }
    return {
      name: RANKS[index],
      index: index,
      score: run.score || 0,
      completeness: completeness,
      restarts: restarts,
    };
  }

  return {
    BASE: BASE,
    Tailwind: Tailwind,
    Tally: Tally,
    rankForRun: rankForRun,
  };
});
