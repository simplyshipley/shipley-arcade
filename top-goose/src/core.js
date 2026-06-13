/*
 * TOP GOOSE — core engine: pseudo-3D projection, camera, scoring, combo,
 * health, RNG. Pure logic, NO DOM.
 *
 * Loaded by the browser as window.TGCore and by Node tests via require().
 * This file owns THE SEAM between engine and shell: project(p, cam, view).
 * The shell consumes project() exactly as pinned in docs/CONTRACT.md — it
 * never re-derives the math. Banking/roll is a shell-side canvas rotate; it
 * does NOT change project()'s output (project works in the un-rolled frame).
 *
 * Reuses the proven Bullseye / How-Birds-See-The-World shapes:
 *   scoreForDrop ring math, ScoreKeeper window-decay combo, Health i-frames,
 *   makeRng (mulberry32). Adds the pseudo-3D pieces TOP GOOSE needs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TGCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Pinned config (read from the engine — the shell never hard-codes) ──
  var W = 480;          // canvas width (portrait)
  var H = 800;          // canvas height
  var F = 420;          // focal length in px (pseudo-3D projection)
  var NEAR = 0.5;       // cull anything with depth < near
  var HORIZON_FRAC = 0.42; // horizonY = H * 0.42 at zero pitch

  // Camera view presets (chaseDist behind bird, heightOff above bird).
  // POV sits AT the bird (chase 0). The pitchOff nudges the horizon when a
  // chase camera tilts to look slightly down on the bird.
  var VIEWS = [
    { id: 'pov', name: 'COCKPIT', chaseDist: 0, heightOff: 0.6, pitchOff: 0 },
    { id: 'chase-near', name: 'CHASE', chaseDist: 7, heightOff: 3, pitchOff: 0.04 },
    { id: 'chase-far', name: 'CHASE FAR', chaseDist: 14, heightOff: 6, pitchOff: 0.07 },
    // Top-down bombsight — the aiming view for the poop mechanic. Uses the
    // separate projectTop() overhead projection, NOT the forward project().
    { id: 'bombardier', name: 'BOMBSIGHT', chaseDist: 0, heightOff: 0, pitchOff: 0, topDown: true }
  ];

  // Meters→px for the top-down bombsight (tuned so ~18 world-units of road
  // read well on the 480-wide canvas).
  var MZ = 7;

  function viewCount() { return VIEWS.length; }
  function viewByIndex(i) {
    if (VIEWS.length === 0) return null;
    var n = ((i % VIEWS.length) + VIEWS.length) % VIEWS.length;
    return VIEWS[n];
  }

  // ── Math helpers ──────────────────────────────────────────────────────
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  // Frame-rate-independent smoothing toward a target. `rate` is how quickly
  // (per second) the value chases the target; bigger = snappier. Returns the
  // new value. Used by the flight model so banking feels like a plane.
  function damp(current, target, rate, dt) {
    var t = 1 - Math.exp(-rate * dt);
    return current + (target - current) * t;
  }
  function dist2d(x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function vec(x, y, z) { return { x: x || 0, y: y || 0, z: z || 0 }; }

  // ══════════════════════════════════════════════════════════════════════
  //  THE SEAM — pseudo-3D projection (PINNED, both agents obey exactly)
  // ══════════════════════════════════════════════════════════════════════
  // Build the camera from the bird + a view preset. The camera trails the
  // bird by chaseDist along +Z and rides heightOff above it; its bank is the
  // NEGATIVE of the bird's bank (the world rolls opposite the bird's lean).
  // horizonY shifts up/down with the bird's pitch + the view's pitchOff so
  // the ground tilts toward/away as the nose moves.
  //   bird: { x, y, z, bankAngle, pitch }
  //   view: a VIEWS entry (or anything with chaseDist/heightOff/pitchOff)
  function buildCamera(bird, view) {
    if (!view) view = VIEWS[0];
    var pitch = (bird.pitch || 0) + (view.pitchOff || 0);
    // Pitch tilts the horizon: nose up (positive pitch) lifts the horizon on
    // screen (smaller y). Scale keeps it gentle and bounded.
    var horizonY = H * HORIZON_FRAC - pitch * F * 0.5;
    return {
      x: bird.x,
      y: bird.y + (view.heightOff || 0),
      z: bird.z - (view.chaseDist || 0),
      yaw: 0,
      pitch: pitch,
      pitchOff: view.pitchOff || 0,
      bank: -(bird.bankAngle || 0),
      horizonY: horizonY,
      F: F,
      near: NEAR,
      W: W,
      H: H
    };
  }

  // project(p, cam, view) -> { sx, sy, scale, depth, visible }
  // p is a world-space point { x, y, z }. cam comes from buildCamera. The
  // `view` arg is accepted for signature parity with the contract but is not
  // needed here (the camera already folded in the view's offsets) — passing
  // it is harmless. Banking is NOT applied here; the shell rotates the canvas.
  //
  //   depth = (p.z - cam.z)                 // forward distance to the point
  //   if depth < near -> { visible:false }
  //   k = F / depth                         // perspective scale
  //   sx = W/2 + (p.x - cam.x) * k
  //   sy = cam.horizonY - (p.y - cam.y) * k
  //   scale = k                             // sprite px-per-world-unit
  function project(p, cam, view) {
    var near = cam.near == null ? NEAR : cam.near;
    var focal = cam.F == null ? F : cam.F;
    var halfW = (cam.W == null ? W : cam.W) / 2;
    var depth = p.z - cam.z;
    if (depth < near) {
      return { sx: 0, sy: 0, scale: 0, depth: depth, visible: false };
    }
    var k = focal / depth;
    return {
      sx: halfW + (p.x - cam.x) * k,
      sy: cam.horizonY - (p.y - cam.y) * k,
      scale: k,
      depth: depth,
      visible: true
    };
  }

  // Top-down bombsight projection (the BOMBARDIER view). Looks straight DOWN:
  // the bird sits at screen (W/2, H*0.72) and the ground maps orthographically
  // — forward (+Z) runs UP the screen, +X runs right. cam.x/cam.z are the
  // bird's ground position (bombardier view has chaseDist 0). No horizon, no
  // banking. scale is constant (MZ) since it's an overhead map.
  //   sx = W/2 + (p.x - cam.x) * MZ
  //   sy = H*0.72 - (p.z - cam.z) * MZ
  function projectTop(p, cam) {
    var fullW = (cam.W == null ? W : cam.W);
    var fullH = (cam.H == null ? H : cam.H);
    var sx = fullW / 2 + (p.x - cam.x) * MZ;
    var sy = fullH * 0.72 - (p.z - cam.z) * MZ;
    return {
      sx: sx,
      sy: sy,
      scale: MZ,
      depth: (p.z - cam.z),
      visible: sy > -40 && sy < fullH + 40 && sx > -40 && sx < fullW + 40
    };
  }

  // depthSort — order an array of items FAR→NEAR (descending depth) so the
  // shell can paint back-to-front (painter's algorithm). Items must carry a
  // numeric `depth` (e.g. the projection result, or {depth, ...}). Stable-ish:
  // returns a NEW sorted array, leaves the input untouched.
  function depthSort(items) {
    var copy = items.slice();
    copy.sort(function (a, b) {
      var da = (a && a.depth != null) ? a.depth : 0;
      var db = (b && b.depth != null) ? b.depth : 0;
      return db - da; // far (large depth) first
    });
    return copy;
  }

  // ── Drop scoring (reuse the proven ring shape) ─────────────────────────
  // Bullseye rings on a ground target: inner third = 100, middle third = 50,
  // outer (incl. the splat-edge graze) = 25 — then scaled by the target's
  // point value (points / 100) and tripled for golden targets. splatRadius
  // extends total reach beyond the target's own radius.
  function scoreForDrop(dist, targetRadius, splatRadius, golden, points) {
    var reach = targetRadius + splatRadius;
    if (dist > reach) return 0;
    var base;
    if (dist <= targetRadius / 3) base = 100;
    else if (dist <= (targetRadius * 2) / 3) base = 50;
    else base = 25;
    var scale = (points == null ? 100 : points) / 100;
    var value = base * scale;
    return golden ? value * 3 : value;
  }

  // ── Combo (window-decay; never broken by empty-ground poops) ───────────
  var COMBO_WINDOW = 4;   // seconds to land the next hit before decay
  var COMBO_MAX = 5;

  function comboMultiplier(combo) {
    if (combo <= 1) return 1;
    return Math.min(combo, COMBO_MAX);
  }

  function ScoreKeeper() {
    this.score = 0;
    this.combo = 1;        // current multiplier level (1 = no streak yet)
    this.bestCombo = 1;
    this.window = COMBO_WINDOW;
  }

  // A successful splat. `base` is the ring/value points (already scaled).
  // Bumps the combo level, refreshes the window, banks base × multiplier.
  ScoreKeeper.prototype.registerHit = function (base) {
    if (base <= 0) return 0;
    this.combo = Math.min(this.combo + 1, COMBO_MAX);
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    this.window = COMBO_WINDOW;
    var pts = Math.round(base * comboMultiplier(this.combo));
    this.score += pts;
    return pts;
  };

  // Tick the combo window. Decay only happens while ≥1 target is on screen —
  // an empty field never breaks a combo (the proven HBSTW rule).
  ScoreKeeper.prototype.tick = function (dt, targetsOnScreen) {
    if (this.combo <= 1) return;
    if (!targetsOnScreen) return;
    this.window -= dt;
    if (this.window <= 0) {
      this.combo = 1;
      this.window = COMBO_WINDOW;
    }
  };

  // Resets the streak immediately. Empty-field poops must NOT call this.
  ScoreKeeper.prototype.registerMiss = function () {
    this.combo = 1;
    this.window = COMBO_WINDOW;
  };

  ScoreKeeper.prototype.addBonus = function (pts) {
    this.score += Math.max(0, pts);
  };

  // ── Seeded RNG (mulberry32 — deterministic, testable spawns) ───────────
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

  // ── Health (3 hearts + i-frames — Free Flight dodge stakes) ────────────
  // A hazard collision costs ONE heart and grants brief invulnerability so a
  // single overlap can't drain the pool in consecutive frames. Getting hit is
  // its own punishment: it NEVER touches score or combo. Pooping is never
  // punished by Health.
  //   .hit()   -> 'hit' | 'gameover' | 'shrugged'
  //   .update(dt), .invulnerable(), .alive()
  var DEFAULT_HEARTS = 3;
  var DEFAULT_IFRAMES = 1.4;

  function Health(opts) {
    opts = opts || {};
    this.maxHearts = opts.hearts == null ? DEFAULT_HEARTS : opts.hearts;
    this.hearts = this.maxHearts;
    this.iframes = opts.iframes == null ? DEFAULT_IFRAMES : opts.iframes;
    this.invuln = 0;
  }

  Health.prototype.invulnerable = function () { return this.invuln > 0; };
  Health.prototype.alive = function () { return this.hearts > 0; };

  Health.prototype.update = function (dt) {
    if (this.invuln > 0) {
      this.invuln -= dt;
      if (this.invuln < 0) this.invuln = 0;
    }
  };

  Health.prototype.hit = function () {
    if (this.invuln > 0) return 'shrugged';
    if (this.hearts <= 0) return 'gameover';
    this.hearts -= 1;
    this.invuln = this.iframes;
    return this.hearts <= 0 ? 'gameover' : 'hit';
  };

  // ── Ranks + share text (rank card / COPY RESULT) ───────────────────────
  var RANKS = [
    { name: 'Fledgling',  min: 0 },
    { name: 'Wing Cadet', min: 1000 },
    { name: 'Sky Ace',    min: 2500 },
    { name: 'Top Goose',  min: 5000 },
    { name: 'Maverick',   min: 8000 }
  ];

  function rankForScore(score) {
    var best = RANKS[0];
    for (var i = 0; i < RANKS.length; i++) {
      if (score >= RANKS[i].min) best = RANKS[i];
    }
    return best;
  }

  // Format a time (seconds) as M:SS.mmm for race result lines.
  function formatTime(seconds) {
    if (seconds == null || seconds < 0 || !isFinite(seconds)) return '--:--';
    var total = Math.max(0, seconds);
    var m = Math.floor(total / 60);
    var s = total - m * 60;
    var sFixed = s.toFixed(2);
    if (s < 10) sFixed = '0' + sFixed;
    return m + ':' + sFixed;
  }

  function shareText(result) {
    result = result || {};
    var mode = result.mode || 'FREE FLIGHT';
    var lines = ['🪿 TOP GOOSE — ' + mode];
    if (result.score != null) {
      var rank = result.rank || rankForScore(result.score).name;
      lines.push('💩 ' + result.score + ' pts · ' + rank);
    }
    if (result.bestCombo != null) {
      lines.push('🔥 best combo x' + Math.min(result.bestCombo, COMBO_MAX));
    }
    if (result.time != null) {
      lines.push('⏱️ ' + formatTime(result.time));
    }
    if (result.distance != null) {
      lines.push('📏 ' + Math.round(result.distance) + ' m flown');
    }
    lines.push('Think you can fly cleaner?');
    return lines.join('\n');
  }

  return {
    // config (read by the shell — never hard-coded there)
    W: W, H: H, F: F, NEAR: NEAR, HORIZON_FRAC: HORIZON_FRAC, MZ: MZ,
    VIEWS: VIEWS, viewCount: viewCount, viewByIndex: viewByIndex,
    // math
    clamp: clamp, lerp: lerp, damp: damp, dist2d: dist2d, vec: vec,
    // the seam
    buildCamera: buildCamera, project: project, projectTop: projectTop, depthSort: depthSort,
    // scoring
    scoreForDrop: scoreForDrop, comboMultiplier: comboMultiplier,
    ScoreKeeper: ScoreKeeper, COMBO_WINDOW: COMBO_WINDOW, COMBO_MAX: COMBO_MAX,
    // rng + health
    makeRng: makeRng, Health: Health,
    // ranks + share
    RANKS: RANKS, rankForScore: rankForScore, formatTime: formatTime,
    shareText: shareText
  };
});
