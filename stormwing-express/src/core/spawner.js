/*
 * Progress-keyed deterministic spawn timelines. Progress is stage-defined
 * (camera height, road distance, elapsed time) and must be monotonic.
 * Same rng seed + same progress sequence → identical fire order, so spawn
 * waves are testable headless.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Spawner = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function Track(rng) {
    if (!(this instanceof Track)) return new Track(rng);
    this.rng = rng || function () { return 0.5; };
    this.triggers = [];
    this._order = 0;
  }

  // Repeating trigger every `interval` progress units.
  // opts: { start: first fire key (default interval),
  //         jitter: 0..1 fraction of interval randomized via rng,
  //         until: stop firing past this key }
  Track.prototype.every = function (interval, fn, opts) {
    opts = opts || {};
    this.triggers.push({
      fn: fn,
      interval: interval,
      jitter: opts.jitter || 0,
      until: opts.until == null ? Infinity : opts.until,
      next: opts.start == null ? interval : opts.start,
      once: false,
      order: this._order++,
    });
    return this;
  };

  // One-shot at progress key.
  Track.prototype.at = function (key, fn) {
    this.triggers.push({
      fn: fn,
      next: key,
      once: true,
      order: this._order++,
    });
    return this;
  };

  // Fire everything due <= progress, in ascending key order (ties break by
  // registration order). Repeating triggers reschedule as they fire, so a
  // big progress jump fires each missed beat in sequence — and rng draws
  // happen in fire order, keeping jittered timelines deterministic.
  Track.prototype.poll = function (progress) {
    var fired = [];
    for (;;) {
      var best = null;
      for (var i = 0; i < this.triggers.length; i++) {
        var t = this.triggers[i];
        if (t.next > progress) continue;
        if (best === null || t.next < best.next ||
            (t.next === best.next && t.order < best.order)) {
          best = t;
        }
      }
      if (best === null) break;
      var key = best.next;
      if (best.once) {
        best.next = Infinity;
      } else {
        var step = best.interval;
        if (best.jitter > 0) {
          step *= 1 + (this.rng() * 2 - 1) * best.jitter;
          if (step < best.interval * 0.05) step = best.interval * 0.05; // never stall
        }
        best.next = key + step;
        if (best.next > best.until) best.next = Infinity;
      }
      best.fn(key, progress);
      fired.push(key);
    }
    return fired;
  };

  return { Track: Track };
});
