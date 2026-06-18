/*
 * TOP GOOSE — bird flight model. Pure logic, NO DOM.
 *
 * Loaded by the browser as window.TGBird and by Node tests via require().
 * Depends on TGCore (clamp/damp) — required in Node, read off window in the
 * browser. The contract's pseudo-3D model is on-rails-forward: the bird flies
 * along +Z automatically; steering moves it in X (left/right) and Y (altitude)
 * and visually banks/pitches. Smoothing (exponential damp) makes it feel like
 * banking a plane, not teleporting.
 *
 * World axes: X = right, Y = up (ground plane Y=0), Z = forward (into screen).
 *
 * Bird { x, y, z, vx, vy, speed, bankAngle, pitch, flapPhase }
 *   update(dt, input) — input = { x: -1..1 steer L/R, y: -1..1 steer down/up }
 *   - auto-forward: z += speed * dt
 *   - steer X -> target bankAngle (±MAX_BANK) -> lateral accel; x clamps to
 *     the course half-width
 *   - steer Y -> pitch -> altitude change; y clamps [groundClear, ceiling]
 *   - flapPhase advances on a flap cycle (faster while climbing)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.TGBird = factory(root.TGCore);
  }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  // Tolerant helpers so the file still loads if Core is briefly absent.
  var clamp = (Core && Core.clamp) || function (v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  };
  var damp = (Core && Core.damp) || function (current, target, rate, dt) {
    var t = 1 - Math.exp(-rate * dt);
    return current + (target - current) * t;
  };

  // ── Flight tuning (world units; ≈ meters) ──────────────────────────────
  // Tuned for RESPONSIVE arcade control (v1.0.1): the original constants
  // moved the bird ~9 u/s laterally — 6+ seconds to cross the field, which
  // felt like no control. These ~2.5× the lateral/vertical authority and
  // snap the bank/pitch faster so steering is immediate and obvious.
  var DEFAULTS = {
    speed: 26,          // forward cruise (u/s) — contract mild-throttle base
    minSpeed: 20,
    maxSpeed: 34,
    maxBank: 0.6,       // ±rad target bank at full steer (a touch more lean)
    bankRate: 14,       // snap into the bank fast (was 8)
    lateralAccel: 160,  // u/s² sideways at full bank — ~25 u/s terminal (was 60)
    lateralDrag: 3.2,   // damping on vx so it settles, doesn't drift forever
    maxPitch: 0.5,      // ±rad pitch at full vertical steer
    pitchRate: 12,      // snap pitch fast (was 7)
    climbAccel: 150,    // u/s² vertical at full pitch — matched to lateral
                        // authority so climbing feels as responsive as steering
                        // (measured: climb was ~half the lateral rate)
    verticalDrag: 3.0,  // damping on vy
    halfWidth: 30,      // course half-width: x clamps to ±halfWidth
    groundClear: 4,     // min altitude (never below this)
    ceiling: 60,        // max altitude
    flapBase: 6.0,      // base flap cycles/sec (rad/s = flapBase)
    flapClimbBoost: 5.0 // extra rad/s while climbing hard
  };

  // Bird is a plain state holder; update() advances it from input + dt.
  function Bird(opts) {
    opts = opts || {};
    var cfg = {};
    for (var key in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
        cfg[key] = opts[key] == null ? DEFAULTS[key] : opts[key];
      }
    }
    this.cfg = cfg;

    this.x = opts.x == null ? 0 : opts.x;
    this.y = opts.y == null ? 24 : opts.y;     // start at a comfortable altitude
    this.z = opts.z == null ? 0 : opts.z;
    this.vx = 0;
    this.vy = 0;
    this.speed = cfg.speed;
    this.bankAngle = 0;   // radians; + = banking right
    this.pitch = 0;       // radians; + = nose up
    this.flapPhase = 0;   // radians; the shell maps this to wing position
  }

  // Advance the bird by dt seconds. `input` carries normalized steering:
  //   input.x in [-1, 1] : -1 hard left, +1 hard right
  //   input.y in [-1, 1] : -1 dive (nose down), +1 climb (nose up)
  // (Optional input.throttle in [-1,1] nudges forward speed.) Missing fields
  // are treated as 0. Returns the bird for chaining/testing.
  Bird.prototype.update = function (dt, input) {
    if (!(dt > 0)) return this;            // guard against 0 / negative dt
    input = input || {};
    var c = this.cfg;
    var sx = clamp(input.x || 0, -1, 1);
    var sy = clamp(input.y || 0, -1, 1);

    // ── Throttle (mild) ──
    if (input.throttle != null) {
      var tSpeed = c.speed + clamp(input.throttle, -1, 1) * (c.maxSpeed - c.speed);
      this.speed = damp(this.speed, clamp(tSpeed, c.minSpeed, c.maxSpeed), 3, dt);
    }

    // ── Auto-forward along +Z ──
    this.z += this.speed * dt;

    // ── Steer X: target bank -> lateral accel -> integrate vx -> x ──
    var targetBank = sx * c.maxBank;
    this.bankAngle = damp(this.bankAngle, targetBank, c.bankRate, dt);
    // Lateral acceleration follows the bank (banking right pushes right). Use
    // sin(bank) so it tracks the visual lean; drag settles vx when level.
    var lat = Math.sin(this.bankAngle) * c.lateralAccel;
    this.vx += lat * dt;
    this.vx -= this.vx * Math.min(1, c.lateralDrag * dt);
    this.x += this.vx * dt;
    if (this.x < -c.halfWidth) { this.x = -c.halfWidth; if (this.vx < 0) this.vx = 0; }
    if (this.x > c.halfWidth) { this.x = c.halfWidth; if (this.vx > 0) this.vx = 0; }

    // ── Steer Y: target pitch -> vertical accel -> integrate vy -> y ──
    var targetPitch = sy * c.maxPitch;
    this.pitch = damp(this.pitch, targetPitch, c.pitchRate, dt);
    var climb = Math.sin(this.pitch) * c.climbAccel;
    this.vy += climb * dt;
    this.vy -= this.vy * Math.min(1, c.verticalDrag * dt);
    this.y += this.vy * dt;
    if (this.y < c.groundClear) { this.y = c.groundClear; if (this.vy < 0) this.vy = 0; }
    if (this.y > c.ceiling) { this.y = c.ceiling; if (this.vy > 0) this.vy = 0; }

    // ── Wing flap: faster while climbing (more effort to gain altitude) ──
    var climbing = this.pitch > 0 ? this.pitch / c.maxPitch : 0; // 0..1
    var flapRate = c.flapBase + climbing * c.flapClimbBoost;
    this.flapPhase += flapRate * dt;
    // Keep flapPhase bounded so it never overflows in a long run.
    if (this.flapPhase > Math.PI * 2) {
      this.flapPhase -= Math.PI * 2 * Math.floor(this.flapPhase / (Math.PI * 2));
    }

    return this;
  };

  // Convenience: the bird's current world position as a point for project().
  Bird.prototype.point = function () {
    return { x: this.x, y: this.y, z: this.z };
  };

  return { Bird: Bird, DEFAULTS: DEFAULTS };
});
