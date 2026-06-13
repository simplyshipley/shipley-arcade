/*
 * BULLSEYE BOMBARDIER — pure game logic, no DOM.
 * Loaded by the browser as window.GameCore and by Node tests via require().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GameCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Bird progression ────────────────────────────────────────────────
  // Bigger bird = bigger splat radius (easier hits) + faster + more shake.
  var BIRDS = [
    { name: 'Sparrow',     emoji: '🐤', minScore: 0,    splatRadius: 18, speed: 240, shake: 0  },
    { name: 'Pigeon',      emoji: '🐦', minScore: 600,  splatRadius: 24, speed: 270, shake: 0  },
    { name: 'Seagull',     emoji: '🕊️', minScore: 1500, splatRadius: 30, speed: 300, shake: 2  },
    { name: 'Hawk',        emoji: '🦅', minScore: 3000, splatRadius: 38, speed: 340, shake: 4  },
    { name: 'Pterodactyl', emoji: '🦖', minScore: 6000, splatRadius: 64, speed: 380, shake: 12 },
  ];

  var RANKS = [
    { name: 'Fledgling',        min: 0    },
    { name: 'Branch Hopper',    min: 1000 },
    { name: 'Sky Scrapper',     min: 2500 },
    { name: 'Raptor Elite',     min: 5000 },
    { name: 'Apex Pterodactyl', min: 8000 },
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
  // Bullseye rings: inner third = 100, middle third = 50, outer (incl.
  // splat-edge graze) = 25. Golden targets pay triple. Splat radius from
  // the current bird extends total reach beyond the target's own radius.
  function scoreForDrop(dist, targetRadius, splatRadius, golden) {
    var reach = targetRadius + splatRadius;
    if (dist > reach) return 0;
    var base;
    if (dist <= targetRadius / 3) base = 100;
    else if (dist <= (targetRadius * 2) / 3) base = 50;
    else base = 25;
    return golden ? base * 3 : base;
  }

  // combo = consecutive hits so far, including the current one.
  // 1 → x1.0, 2 → x1.25, ... capped at x3.
  function comboMultiplier(combo) {
    if (combo <= 1) return 1;
    return Math.min(1 + (combo - 1) * 0.25, 3);
  }

  function ScoreKeeper() {
    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
  }
  // Returns points awarded for this drop (0 on a miss; misses reset combo).
  ScoreKeeper.prototype.registerDrop = function (base) {
    if (base <= 0) {
      this.combo = 0;
      return 0;
    }
    this.combo += 1;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    var pts = Math.round(base * comboMultiplier(this.combo));
    this.score += pts;
    return pts;
  };
  ScoreKeeper.prototype.addBonus = function (pts) {
    this.score += Math.max(0, pts);
  };

  // ── Bird Vision meter ───────────────────────────────────────────────
  // Toggle on: time slows + golden targets revealed. Drains while active,
  // recharges while off. Needs a minimum charge to re-activate.
  function VisionMeter() {
    this.max = 100;
    this.value = 100;
    this.drainRate = 40;     // per second while active
    this.rechargeRate = 14;  // per second while inactive
    this.minToActivate = 25;
    this.active = false;
  }
  VisionMeter.prototype.activate = function () {
    if (!this.active && this.value >= this.minToActivate) this.active = true;
    return this.active;
  };
  VisionMeter.prototype.deactivate = function () {
    this.active = false;
  };
  VisionMeter.prototype.update = function (dt) {
    if (this.active) {
      this.value -= this.drainRate * dt;
      if (this.value <= 0) {
        this.value = 0;
        this.active = false;
      }
    } else {
      this.value = Math.min(this.max, this.value + this.rechargeRate * dt);
    }
  };
  VisionMeter.prototype.timeScale = function () {
    return this.active ? 0.35 : 1;
  };

  // ── Rescue interlude (Choplifter-style) ─────────────────────────────
  function RescueState(goal) {
    this.goal = goal || 3;
    this.rescued = 0;
    this.hits = 0;
    this.carrying = false;
  }
  RescueState.prototype.pickup = function () {
    if (this.carrying) return false;
    this.carrying = true;
    return true;
  };
  // Returns true when the rescue goal is complete.
  RescueState.prototype.deliver = function () {
    if (!this.carrying) return false;
    this.carrying = false;
    this.rescued += 1;
    return this.rescued >= this.goal;
  };
  // Returns 'dropped' if a carried chick was lost, else 'hit'.
  RescueState.prototype.hitHazard = function () {
    this.hits += 1;
    if (this.carrying) {
      this.carrying = false;
      return 'dropped';
    }
    return 'hit';
  };
  RescueState.prototype.complete = function () {
    return this.rescued >= this.goal;
  };

  function rescueBonus(rescued, hits) {
    return Math.max(0, rescued * 500 - hits * 100);
  }

  // ── Geometry helpers ────────────────────────────────────────────────
  function dist(x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function circlesOverlap(x1, y1, r1, x2, y2, r2) {
    return dist(x1, y1, x2, y2) <= r1 + r2;
  }

  return {
    BIRDS: BIRDS,
    RANKS: RANKS,
    birdForScore: birdForScore,
    rankForScore: rankForScore,
    scoreForDrop: scoreForDrop,
    comboMultiplier: comboMultiplier,
    ScoreKeeper: ScoreKeeper,
    VisionMeter: VisionMeter,
    RescueState: RescueState,
    rescueBonus: rescueBonus,
    dist: dist,
    circlesOverlap: circlesOverlap,
  };
});
