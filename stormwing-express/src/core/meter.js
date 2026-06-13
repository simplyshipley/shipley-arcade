/*
 * Generic fill/decay meter. Stage 2 configures heat semantics (redline
 * zone 85-99, sputter at 100) in its own file — no stage rules live here.
 * Defaults mirror the spec heat numbers: 0→100 in 4s, cool 12.5/s,
 * brake-cool 25/s.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core.js'));
  } else {
    root.Meter = factory(root.Core);
  }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  function Meter(opts) {
    if (!(this instanceof Meter)) return new Meter(opts);
    opts = opts || {};
    this.max = opts.max == null ? 100 : opts.max;
    this.fillRate = opts.fillRate == null ? 25 : opts.fillRate;
    this.decayRate = opts.decayRate == null ? 12.5 : opts.decayRate;
    this.brakeDecayRate = opts.brakeDecayRate == null ? 25 : opts.brakeDecayRate;
    this.value = 0;
  }

  Meter.prototype.fill = function (dt) {
    this.value = Core.clamp(this.value + this.fillRate * dt, 0, this.max);
    return this.value;
  };

  Meter.prototype.decay = function (dt, braking) {
    var rate = braking ? this.brakeDecayRate : this.decayRate;
    this.value = Core.clamp(this.value - rate * dt, 0, this.max);
    return this.value;
  };

  Meter.prototype.ratio = function () {
    return this.max === 0 ? 0 : this.value / this.max;
  };

  // Half-open band: value in [lo, hi).
  Meter.prototype.zone = function (lo, hi) {
    return this.value >= lo && this.value < hi;
  };

  Meter.prototype.reset = function (v) {
    this.value = Core.clamp(v || 0, 0, this.max);
    return this.value;
  };

  return Meter;
});
