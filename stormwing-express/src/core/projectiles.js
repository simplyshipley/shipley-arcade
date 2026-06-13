/*
 * One ballistic system for the whole game — combat shots, mail bundles,
 * the beacon charge. Stages differ by CONFIG, never by code (the Design-2
 * graft). Pure logic: no DOM, no canvas. Unlimited ammo; slinging at
 * nothing must never cost anything — cost lives in score.js, not here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Projectiles = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    muzzle: 460,        // px/s launch speed
    inherit: 0.5,       // fraction of player velocity carried
    flatTime: 0.22,     // s of gravity-free rifled flight (~100 px)
    gravity: 600,       // px/s² after flatTime
    cadenceHeld: 3.5,   // shots/s while held
    fanCount: 1,
    fanSpreadDeg: 14,   // degrees between adjacent fan shots
    payloadTag: 'shot',
  };
  var MAX_AGE = 4;      // s — cull anything older
  var DEG = Math.PI / 180;

  function System(cfg) {
    if (!(this instanceof System)) return new System(cfg);
    this.cfg = {};
    for (var k in DEFAULTS) {
      if (DEFAULTS.hasOwnProperty(k)) this.cfg[k] = DEFAULTS[k];
    }
    this.list = [];
    this._cool = 0;     // holdFire cadence accumulator
    if (cfg) this.configure(cfg);
  }

  // Stage swap: merge a partial config; live projectiles keep their
  // snapshotted flat/gravity so a transition can't bend in-flight arcs.
  System.prototype.configure = function (cfg) {
    if (!cfg) return this;
    for (var k in cfg) {
      if (cfg.hasOwnProperty(k)) this.cfg[k] = cfg[k];
    }
    return this;
  };

  System.prototype._spawn = function (body, vx, vy, flat, tag) {
    var p = {
      x: body.x, y: body.y, vx: vx, vy: vy,
      age: 0, tag: tag, dead: false,
      flat: flat, gravity: this.cfg.gravity,
      fade: 0, fadeT: 0, alpha: 1,
    };
    this.list.push(p);
    return p;
  };

  System.prototype.sling = function (body, opts) {
    opts = opts || {};
    var dir = opts.dirX == null ? body.facing : opts.dirX;
    var base = opts.angle || 0;
    var speed = this.cfg.muzzle + (opts.muzzleBonus || 0);
    var n = this.cfg.fanCount;
    var spread = this.cfg.fanSpreadDeg * DEG;
    var spawned = [];
    for (var i = 0; i < n; i++) {
      var a = base + (i - (n - 1) / 2) * spread; // fan centered on base angle
      spawned.push(this._spawn(
        body,
        dir * speed * Math.cos(a) + this.cfg.inherit * body.vx,
        speed * Math.sin(a) + this.cfg.inherit * body.vy,
        this.cfg.flatTime,
        this.cfg.payloadTag
      ));
    }
    return spawned;
  };

  // Down+X — the Bullseye Bombardier homage. Gravity from frame one.
  System.prototype.straightDrop = function (body) {
    return this._spawn(
      body,
      this.cfg.inherit * body.vx,
      Math.max(body.vy, 0) + 120,
      0,
      'drop'
    );
  };

  // Call every frame X is held; fires at cadenceHeld shots/s. At most one
  // volley per call — long gaps never bank extra shots.
  System.prototype.holdFire = function (body, dt, opts) {
    this._cool -= dt;
    if (this._cool > 0) return [];
    this._cool += 1 / this.cfg.cadenceHeld;
    if (this._cool < 0) this._cool = 0;
    return this.sling(body, opts);
  };

  System.prototype.update = function (dt) {
    for (var i = this.list.length - 1; i >= 0; i--) {
      var p = this.list[i];
      // Exact flat→gravity split at the flatTime boundary so the rifled
      // window is frame-rate independent.
      var tFlat = p.flat - p.age;
      if (tFlat > dt) tFlat = dt;
      if (tFlat < 0) tFlat = 0;
      var tGrav = dt - tFlat;
      if (tFlat > 0) {
        p.x += p.vx * tFlat;
        p.y += p.vy * tFlat;
      }
      if (tGrav > 0) {
        p.vy += p.gravity * tGrav;
        p.x += p.vx * tGrav;
        p.y += p.vy * tGrav;
      }
      p.age += dt;
      if (p.fade > 0) {
        p.fadeT -= dt;
        p.alpha = p.fadeT > 0 ? p.fadeT / p.fade : 0;
        if (p.fadeT <= 0) p.dead = true;
      }
      if (p.dead || p.age > MAX_AGE) this.list.splice(i, 1);
    }
  };

  System.prototype.drained = function () {
    return this.list.length === 0;
  };

  // Transition drain: fade + kill everything live over N seconds.
  // Projectiles spawned afterwards are unaffected.
  System.prototype.fadeAll = function (seconds) {
    for (var i = 0; i < this.list.length; i++) {
      this.list[i].fade = seconds;
      this.list[i].fadeT = seconds;
    }
  };

  return { DEFAULTS: DEFAULTS, System: System };
});
