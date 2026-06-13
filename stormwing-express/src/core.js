/*
 * Pure game logic — no DOM, no canvas. Loaded in the browser as
 * window.Core and by Node tests via require().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Core = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Math / geometry ─────────────────────────────────────────────────
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist(x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function circlesOverlap(x1, y1, r1, x2, y2, r2) {
    return dist(x1, y1, x2, y2) <= r1 + r2;
  }
  function aabbOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ── Input normalization (game-1 lesson: issue #1) ───────────────────
  // Single-character keys are lowercased so Shift/CapsLock can never
  // desync keydown/keyup pairs. Named keys pass through unchanged.
  function normalizeKey(key) {
    if (typeof key !== 'string' || key.length === 0) return '';
    return key.length === 1 ? key.toLowerCase() : key;
  }

  // ── Deterministic RNG (mulberry32) — injectable for testable spawns ─
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

  // Scoring lives in core/score.js (Tailwind + Tally + rankForRun) —
  // the game-1 ScoreKeeper/rank table was removed, never duplicated.

  // ── Health / lives ──────────────────────────────────────────────────
  function Health(opts) {
    opts = opts || {};
    this.maxHp = opts.maxHp || 3;
    this.hp = this.maxHp;
    this.lives = opts.lives || 3;
    this.invuln = 0;          // seconds of post-hit invulnerability
    this.invulnTime = opts.invulnTime || 1.5;
  }
  // Returns 'hit', 'died', 'gameover', or 'shrugged' (invulnerable).
  Health.prototype.damage = function (amount) {
    if (this.invuln > 0) return 'shrugged';
    this.hp -= amount || 1;
    this.invuln = this.invulnTime;
    if (this.hp > 0) return 'hit';
    this.lives -= 1;
    if (this.lives <= 0) return 'gameover';
    this.hp = this.maxHp;
    return 'died';
  };
  Health.prototype.heal = function (amount) {
    this.hp = Math.min(this.maxHp, this.hp + (amount || 1));
  };
  Health.prototype.update = function (dt) {
    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);
  };

  // ── Cooldown helper ─────────────────────────────────────────────────
  function Cooldown(duration) {
    this.duration = duration;
    this.t = 0;
  }
  Cooldown.prototype.ready = function () { return this.t <= 0; };
  Cooldown.prototype.fire = function () {
    if (this.t > 0) return false;
    this.t = this.duration;
    return true;
  };
  Cooldown.prototype.update = function (dt) {
    if (this.t > 0) this.t = Math.max(0, this.t - dt);
  };

  return {
    clamp: clamp,
    lerp: lerp,
    dist: dist,
    circlesOverlap: circlesOverlap,
    aabbOverlap: aabbOverlap,
    normalizeKey: normalizeKey,
    makeRng: makeRng,
    Health: Health,
    Cooldown: Cooldown,
  };
});
