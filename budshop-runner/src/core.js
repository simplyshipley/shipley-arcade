/*
 * BUDSHOP RUNNER — core.js: the pure logic engine. Runner physics, jump/duck
 * state, distance + speed ramp, scoring with a HARVEST COMBO, a deterministic
 * seeded fair-gap spawner, RNG, share text, and the best-score model.
 *
 * Pure logic, NO DOM. Loaded as window.BudCore in a browser and via require()
 * in Node tests (UMD wrapper, pattern: top-goose/src/core.js).
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  THE SEAM (the shell mirrors these shapes exactly; it never re-derives them):
 *
 *  INPUT shape  — what the shell feeds Runner.update each frame:
 *      { jump: boolean, duck: boolean }
 *    `jump` is the raw held state of the JUMP control (Space / tap / ▲).
 *    `duck` is the raw held state of the DUCK control (↓ / swipe / ▼).
 *    Empty/missed actions are NEVER punished — holding nothing is always legal.
 *
 *  RUNNER state — the object the shell reads to draw the budtender:
 *      {
 *        x:        number   horizontal anchor (constant; world scrolls past)
 *        y:        number   height ABOVE the ground line (0 = grounded, + = up)
 *        vy:       number   vertical velocity (world px/s; + = rising)
 *        grounded: boolean  true when standing on the ground line
 *        ducking:  boolean  true while the duck pose is active (grounded only)
 *        w:        number   full sprite width
 *        h:        number   CURRENT sprite height (shrinks while ducking)
 *        fullH:    number   standing height (for the shell's squash/stretch ref)
 *        airtime / apex / etc are derived constants on the prototype.
 *      }
 *    Hurtbox: call Runner.hurtbox() → { x, y, w, h } in world space (y measured
 *    from the ground line, up positive). It is ~70% of the sprite and the duck
 *    pose both shrinks AND lowers it. Collision math lives here, not in the shell.
 *
 *  SPAWNER output — each emitted entity (the shell positions it by `dist`):
 *      {
 *        ref:    the entities.js roster entry (id/kind/lane/action/art/...)
 *        id:     string (convenience copy of ref.id)
 *        kind:   'collectible' | 'hazard'
 *        lane:   'ground' | 'low' | 'high'
 *        action: 'jump' | 'duck' | 'grab'
 *        w, h:   number sprite footprint
 *        points: number (collectibles only)
 *        dist:   number world-distance AHEAD of the runner at spawn time
 *        collected / scored: booleans the shell flips as the player interacts
 *      }
 *    The spawner GUARANTEES FAIR GAPS: consecutive hazards are spaced by at
 *    least minReactionDist(speed) so no jump+duck sequence is ever impossible.
 * ────────────────────────────────────────────────────────────────────────────
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      typeof require === 'function' ? require('./entities.js') : null
    );
  } else {
    // Browser global. The shell (game.js) consumes the core as `root.BRCore`,
    // so expose BOTH the natural name and the BR* alias the shell reads. Accept
    // the roster under either global name (load-order/naming safe).
    // SEAM NOTE: the shell additionally calls Core.loadBest()/saveBest(), but
    // per docs/CONTRACT.md the core is FORMAT-ONLY for best scores (the shell
    // owns localStorage I/O). This core exposes updateBest() + BEST_KEYS for
    // that split; loadBest/saveBest belong in the shell. Orchestrator must
    // reconcile this API expectation — see the structured friction note.
    root.BudCore = root.BRCore = factory(root.BudEntities || root.BREntities);
  }
})(typeof self !== 'undefined' ? self : this, function (Entities) {
  'use strict';

  // ── Pinned world config (read by the shell — never hard-coded there) ────
  var GROUND_Y = 300;        // ground line y on the 800×360 canvas (shell ref)
  var RUNNER_X = 130;        // runner's fixed horizontal anchor

  // Physics constants (tuned so the jump arc clears ground hazards and the
  // duck pose ducks high hazards at the speeds the spawner allows).
  var GRAVITY = 2400;        // world px/s² pulling the runner down
  // Jump tuned for a CONSISTENT, grabbable arc: a bare tap always apexes
  // ~80px (clears ground hazards, reliably sweeps the floating-bud band on
  // the way up AND down), and holding adds up to ~+70px to ~150px. The old
  // jump-cut collapsed taps to a useless ~22px stub while holds rocketed to
  // ~249px (off-screen) — buds were nearly ungrabbable. Variability now comes
  // ONLY from hold-for-higher; the minimum is baked into the impulse.
  var JUMP_VELOCITY = 620;   // fresh-jump impulse → guaranteed apex ~80px
  var MAX_HOLD = 0.20;       // seconds a held JUMP keeps feeding lift, to a cap
  var HOLD_LIFT = 1150;      // extra lift while held → full-hold apex ~150px

  var RUNNER_W = 40;
  var RUNNER_H = 64;         // standing sprite height
  var DUCK_H = 38;           // ducking sprite height (~60% — low silhouette)
  var HURT_FRAC = 0.70;      // hurtbox ≈ 70% of the sprite footprint

  // World speed ramp: starts at BASE, climbs SPEED_GAIN px/s per metre of
  // distance, capped at SPEED_MAX. Distance accrues at the current speed.
  var SPEED_BASE = 240;      // world px/s at distance 0
  var SPEED_GAIN = 0.012;    // px/s added per world-px travelled
  var SPEED_MAX = 560;       // hard cap (keeps the game humanly reactable)

  // Harvest combo: a bud bumps the multiplier ×1→×5; it decays only after a
  // window with no fresh bud. NOTHING else can break it — not a missed grab,
  // not a missed jump, not a water pail. (Reuse of the proven window-decay
  // combo from top-goose/Bullseye; renamed for the harvest theme.)
  var COMBO_WINDOW = 4.5;    // seconds to grab the next bud before the combo decays
  var COMBO_MAX = 5;
  var BUD_BASE = 50;         // base points a bud is worth before the multiplier
  var WATER_BONUS = 60;      // flat streak bonus for watering (no combo bump)
  var DIST_POINTS = 0.1;     // score points accrued per world-px travelled

  // Fair-gap tuning. The minimum reaction distance the player needs between
  // two consecutive hazards at a given speed: a fixed human reaction window
  // plus the airtime distance (so you can land from a jump before the next
  // obstacle arrives). Collectibles do NOT count toward hazard gaps — missing
  // one is free, so they can sit anywhere.
  var REACTION_TIME = 0.42;  // seconds of human reaction allowed per hazard
  var GAP_SLACK = 36;        // px of extra breathing room on top of the minimum
  var SPAWN_AHEAD = 900;     // how far ahead of the runner entities first appear

  // ── Math helpers ────────────────────────────────────────────────────────
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ── Seeded RNG (mulberry32 — deterministic, testable spawns) ────────────
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

  // ── Speed ramp (capped) ──────────────────────────────────────────────────
  // World speed as a function of distance travelled. Monotonic, capped so the
  // run never becomes physically unreactable.
  function speedAt(distance) {
    return Math.min(SPEED_MAX, SPEED_BASE + (distance > 0 ? distance : 0) * SPEED_GAIN);
  }

  // ── Jump arc reference (derived; used by the spawner + exposed for tests) ──
  // A full (un-cut) jump: airtime and apex height from the kinematics. The hold
  // window adds a little lift, so the true apex is a touch higher than the bare
  // impulse; we model the apex conservatively from the impulse for fair-gap math
  // (treating the achievable jump as AT LEAST this high/long).
  function jumpAirtime() {
    // time up + time down for the bare impulse: 2 * v / g
    return (2 * JUMP_VELOCITY) / GRAVITY;
  }
  function jumpApex() {
    // h = v² / (2g) for the bare impulse (hold makes the real apex ≥ this)
    return (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY);
  }

  // Minimum fair gap (world px) between two consecutive HAZARDS at `speed`.
  // = (human reaction window + one airtime) × speed + slack. Airtime is folded
  // in so that after clearing one ground hazard by jumping, the runner has time
  // to land and set up for the next obstacle (which may need a duck instead).
  function minReactionDist(speed) {
    return (REACTION_TIME + jumpAirtime()) * speed + GAP_SLACK;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  RUNNER — physics state object (the seam the shell draws)
  // ════════════════════════════════════════════════════════════════════════
  function Runner(opts) {
    opts = opts || {};
    this.x = opts.x == null ? RUNNER_X : opts.x;
    this.y = 0;            // height above the ground line (0 = grounded)
    this.vy = 0;
    this.grounded = true;
    this.ducking = false;
    this.w = RUNNER_W;
    this.fullH = RUNNER_H;
    this.h = RUNNER_H;
    this._holdTime = 0;    // how long the current jump has been held (for the cap)
    this._jumpLatch = false; // edge-detect: a fresh press, not a held key
  }

  // Update the runner one step. input = { jump, duck }. Returns nothing; the
  // shell reads the mutated fields. Empty input (no jump, no duck) is always
  // legal and never punished — it just keeps running grounded.
  Runner.prototype.update = function (dt, input) {
    input = input || {};
    var jump = !!input.jump;
    var duck = !!input.duck;

    // ── Jump: a single impulse on a FRESH press while grounded. Holding does
    // NOT auto-bounce (you must release and re-press to jump again). Holding
    // the SAME press feeds extra lift up to MAX_HOLD → "hold for higher".
    if (jump && this.grounded && !this._jumpLatch) {
      this.vy = JUMP_VELOCITY;
      this.grounded = false;
      this.ducking = false;
      this._holdTime = 0;
      this._jumpLatch = true;
    }
    if (!jump) {
      this._jumpLatch = false;   // released — next press can jump again
    }

    if (!this.grounded) {
      // Hold-for-higher: while rising, still holding, and within the window,
      // add a little extra lift (variable jump height to a cap).
      if (jump && this.vy > 0 && this._holdTime < MAX_HOLD) {
        this.vy += HOLD_LIFT * dt;
        this._holdTime += dt;
      }
      // No jump-cut: the minimum jump is baked into JUMP_VELOCITY, so a tap is
      // always a usable jump and a hold is higher. (Releasing just stops the
      // extra hold-lift above.)

      // Integrate gravity.
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;

      if (this.y <= 0) {
        // Landed.
        this.y = 0;
        this.vy = 0;
        this.grounded = true;
      }
      // Cannot duck in mid-air.
      this.ducking = false;
    } else {
      // Grounded: ducking shrinks the silhouette. Releasing restores it.
      this.ducking = duck;
    }

    this.h = this.ducking ? DUCK_H : RUNNER_H;
  };

  // Hurtbox in world space: { x, y, w, h }. y is measured from the ground line,
  // up positive (so y = this.y for the box's bottom). ~70% of the sprite,
  // centred horizontally; ducking shrinks AND lowers it (uses the duck height).
  Runner.prototype.hurtbox = function () {
    var hw = this.w * HURT_FRAC;
    var hh = this.h * HURT_FRAC;
    return {
      x: this.x + (this.w - hw) / 2,
      y: this.y,            // bottom of the box sits at the runner's foot height
      w: hw,
      h: hh
    };
  };

  // ── Collision: does the runner's hurtbox overlap an entity's box? ────────
  // The entity carries `dist` (px ahead of the runner) and a lane that maps to
  // a vertical band above the ground line. This is the same AABB the shell uses.
  //
  // Vertical bands (world px above the ground line) are tuned against the
  // runner's hurtbox so the lane→action contract actually holds:
  //   standing hurtbox spans 0 .. RUNNER_H*HURT_FRAC  (≈ 0..45)
  //   ducked   hurtbox spans 0 .. DUCK_H*HURT_FRAC    (≈ 0..27)
  //
  //   ground            → sits on the floor (0). Hits a standing runner; a jump
  //                        lifts the hurtbox above it. (action: jump)
  //   low (collectible) → waist band, grabbable while just running by. (grab)
  //   high HAZARD       → DUCK band: bottom (30) is below the standing hurtbox
  //                        top (≈45) so it hits a standing runner, but above the
  //                        ducked hurtbox top (≈27) so ducking slips under. (duck)
  //   high COLLECTIBLE  → FLOAT band: bottom (50) is ABOVE the standing hurtbox
  //                        top so you must JUMP to reach the floating bud. (grab)
  function laneBottom(lane, kind) {
    if (lane === 'high') {
      // Bud sits in the JUMP-APEX zone (78) so you grab it at the natural top
      // of a jump — the intuitive "leap up to the floating bud" moment. (At 46
      // the apex overshot the bud, leaving a dead zone that made grabs feel
      // broken.) Still well above the standing hurtbox (~45) so a jump is required.
      return kind === 'collectible' ? 78 : 30;
    }
    if (lane === 'low') return 18;     // waist band
    return 0;                          // ground
  }

  // entityBox(ent) — entity's world AABB. The entity's screen x is the runner's
  // x plus its `dist`; the shell uses the same mapping, so collision agrees with
  // what's drawn.
  function entityBox(ent, runnerX) {
    var bottom = laneBottom(ent.lane, ent.kind);
    return {
      x: (runnerX == null ? RUNNER_X : runnerX) + ent.dist,
      y: bottom,
      w: ent.w,
      h: ent.h
    };
  }

  function aabb(a, b) {
    return a.x < b.x + b.w &&
           a.x + a.w > b.x &&
           a.y < b.y + b.h &&
           a.y + a.h > b.y;
  }

  // collides(runner, ent) — true if the runner's hurtbox overlaps the entity.
  function collides(runner, ent) {
    return aabb(runner.hurtbox(), entityBox(ent, runner.x));
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SCORE KEEPER — distance points + the HARVEST COMBO (×1→×5, window decay)
  // ════════════════════════════════════════════════════════════════════════
  function comboMultiplier(combo) {
    if (combo <= 1) return 1;
    return Math.min(combo, COMBO_MAX);
  }

  function ScoreKeeper() {
    this.score = 0;
    this.buds = 0;            // total buds harvested
    this.combo = 1;           // current harvest multiplier level (1 = no streak)
    this.bestCombo = 1;
    this.window = COMBO_WINDOW;
    this.distance = 0;        // world px travelled (also the "metres" we display)
  }

  // Accrue distance + its score. Call every frame with the per-frame travel.
  ScoreKeeper.prototype.travel = function (deltaDist) {
    if (deltaDist <= 0) return;
    this.distance += deltaDist;
    this.score += deltaDist * DIST_POINTS;
  };

  // Harvest a bud: bumps the combo, refreshes the window, banks base × multiplier.
  ScoreKeeper.prototype.harvestBud = function () {
    this.buds += 1;
    this.combo = Math.min(this.combo + 1, COMBO_MAX);
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    this.window = COMBO_WINDOW;
    var pts = Math.round(BUD_BASE * comboMultiplier(this.combo));
    this.score += pts;
    return pts;
  };

  // Water a plant: a flat streak bonus. Does NOT bump the harvest combo (per the
  // contract: only buds drive the combo), and never breaks it either.
  ScoreKeeper.prototype.waterPlant = function () {
    this.score += WATER_BONUS;
    return WATER_BONUS;
  };

  // Tick the combo window. Decay is purely time-based: if no bud is grabbed
  // within COMBO_WINDOW seconds the multiplier resets to ×1. NOTHING ELSE
  // resets it — a missed grab, a missed jump, an empty stretch of track all
  // leave the combo intact (only the clock can decay it).
  ScoreKeeper.prototype.tick = function (dt) {
    if (this.combo <= 1) return;
    this.window -= dt;
    if (this.window <= 0) {
      this.combo = 1;
      this.window = COMBO_WINDOW;
    }
  };

  // ════════════════════════════════════════════════════════════════════════
  //  SPAWNER — deterministic, seeded, FAIR-GAP-guaranteed entity generator
  // ════════════════════════════════════════════════════════════════════════
  // The spawner runs a virtual cursor `headDist` = the world distance at which
  // the NEXT entity will appear, measured ahead of the runner. As the world
  // scrolls, the shell calls pump(distanceTravelled, speed) and the spawner
  // emits any entities whose spawn point has come within SPAWN_AHEAD.
  //
  // FAIR-GAP GUARANTEE: every HAZARD is placed at least minReactionDist(speed)
  // world-px after the previous HAZARD. Collectibles are sprinkled in the gaps
  // and never count toward the hazard spacing (missing one is free). Because
  // the gap is computed from the CURRENT speed, the guarantee holds as the
  // game speeds up — a faster world gets proportionally larger gaps.
  function Spawner(seed, ents) {
    this.rng = makeRng(seed == null ? 1 : seed);
    this.ents = ents || Entities;        // injected roster (entities.js)
    this.headDist = SPAWN_AHEAD;         // distance to the next spawn
    this.lastHazardAt = -Infinity;       // world distance of the last hazard placed
    this.totalDist = 0;                  // virtual world distance the cursor has reached
    this._hazards = this._pool('hazard');
    this._collects = this._pool('collectible');
  }

  Spawner.prototype._pool = function (kind) {
    var src = this.ents.byKind ? this.ents.byKind(kind)
            : (kind === 'hazard' ? this.ents.HAZARDS : this.ents.COLLECTIBLES);
    return src || [];
  };

  // Weighted pick from a pool using the seeded RNG (deterministic per seed).
  Spawner.prototype._pick = function (pool) {
    if (pool.length === 0) return null;
    var total = 0, i;
    for (i = 0; i < pool.length; i++) total += (pool[i].weight || 1);
    var r = this.rng() * total;
    for (i = 0; i < pool.length; i++) {
      r -= (pool[i].weight || 1);
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  };

  // Build a live entity record from a roster ref at a world distance.
  Spawner.prototype._make = function (ref, atDist) {
    return {
      ref: ref,
      id: ref.id,
      kind: ref.kind,
      lane: ref.lane,
      action: ref.action,
      w: ref.w,
      h: ref.h,
      points: ref.points || 0,
      dist: atDist,            // distance ahead of the runner at spawn
      collected: false,
      scored: false
    };
  };

  // Decide the next entity and where it goes, ENFORCING the fair gap. Returns
  // the spawned entity record (relative to the spawn cursor) and advances the
  // internal cursor past it. `speed` is the current world speed (px/s).
  Spawner.prototype._next = function (speed) {
    // Buds are the POINT of the game, so most spawns are collectibles to grab;
    // hazards are the spice, spaced fairly. (Was 0.34 — too hazard-heavy, runs
    // ended before any bud lined up with a jump.)
    var wantCollectible = this.rng() < 0.58;

    if (wantCollectible) {
      var cRef = this._pick(this._collects);
      // Collectibles can sit anywhere — a modest forward step, no gap rule.
      var cStep = lerp(180, 320, this.rng());
      this.totalDist += cStep;
      return cRef ? this._make(cRef, this.totalDist) : null;
    }

    var hRef = this._pick(this._hazards);
    if (!hRef) return null;

    // FAIR GAP: the next hazard must land at least minReactionDist(speed) after
    // the previous hazard. Add a randomized cadence on top so it isn't metronomic.
    var minGap = minReactionDist(speed);
    var extra = lerp(140, 380, this.rng());  // generous breathing room between hazards
    var candidate = this.totalDist + minGap + extra;

    // Hard floor against the last hazard (covers the case where collectibles
    // pushed the cursor only a little since the last hazard).
    var floor = this.lastHazardAt + minGap;
    if (candidate < floor) candidate = floor + extra;

    this.totalDist = candidate;
    this.lastHazardAt = candidate;
    return this._make(hRef, candidate);
  };

  // pump(distanceTravelled, speed) → array of entity records that have entered
  // the SPAWN_AHEAD window since the last pump. Each record's `dist` is the
  // world distance AHEAD of the runner at the moment of emission. The shell
  // tracks them from there (scrolling `dist` down by speed*dt every frame).
  Spawner.prototype.pump = function (distanceTravelled, speed) {
    var out = [];
    var sp = speed == null ? speedAt(distanceTravelled) : speed;
    // The spawn frontier in world coordinates: anything whose absolute spawn
    // distance is within (travelled + SPAWN_AHEAD) gets emitted now.
    var frontier = distanceTravelled + SPAWN_AHEAD;
    var guard = 0;
    while (this.totalDist < frontier && guard < 64) {
      var ent = this._next(sp);
      if (ent) {
        // Convert the absolute spawn distance into "ahead of the runner".
        ent.dist = ent.dist - distanceTravelled;
        if (ent.dist < 0) ent.dist = 0;
        out.push(ent);
      }
      guard++;
    }
    return out;
  };

  // schedule(n, speed) — deterministically generate the next `n` entities as
  // records carrying their ABSOLUTE world spawn distance in `dist`. This MUTATES
  // the spawner's cursor (it advances exactly as the live pump would), so call
  // it on a FRESH Spawner(seed) when you want a clean, reproducible schedule —
  // which is how tests assert spawn order + the fair-gap guarantee for a seed.
  // If `speed` is omitted, the speed is derived from the cursor distance so the
  // gaps reflect the natural ramp.
  Spawner.prototype.schedule = function (n, speed) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var sp = speed == null ? speedAt(this.totalDist) : speed;
      var ent = this._next(sp);
      if (ent) out.push(ent);
    }
    return out;
  };

  // ── Best-score model (FORMAT ONLY — the shell owns localStorage I/O) ────
  // Keys the shell should read/write: 'budshop.runner.bestDist',
  // 'budshop.runner.bestScore'. The core only decides whether a result beats a
  // prior best and formats values for display.
  var BEST_KEYS = {
    dist: 'budshop.runner.bestDist',
    score: 'budshop.runner.bestScore'
  };

  // Given a fresh result and the prior bests, return the new bests + flags.
  // The shell persists the returned values; the core never touches storage.
  function updateBest(result, prior) {
    result = result || {};
    prior = prior || {};
    var dist = Math.max(0, Math.round(result.distance || 0));
    var score = Math.max(0, Math.round(result.score || 0));
    var pDist = Math.max(0, Math.round(prior.distance || 0));
    var pScore = Math.max(0, Math.round(prior.score || 0));
    return {
      distance: Math.max(dist, pDist),
      score: Math.max(score, pScore),
      newBestDistance: dist > pDist,
      newBestScore: score > pScore
    };
  }

  // Distance reads as "metres" — 10 world px ≈ 1 m for a friendly number.
  function formatDistance(distance) {
    var m = Math.max(0, Math.round((distance || 0) / 10));
    return m + 'm';
  }

  // ── Ranks + share text (score card / COPY) ──────────────────────────────
  var RANKS = [
    { name: 'Seedling',     min: 0 },
    { name: 'Trimmer',      min: 800 },
    { name: 'Budtender',    min: 2000 },
    { name: 'Head Grower',  min: 4500 },
    { name: 'Top Shelf',    min: 8000 }
  ];

  function rankForScore(score) {
    var best = RANKS[0];
    for (var i = 0; i < RANKS.length; i++) {
      if (score >= RANKS[i].min) best = RANKS[i];
    }
    return best;
  }

  // shareText(result) → a tweetable summary string. result = { score, distance,
  // buds, bestCombo }. Pure formatting; emoji kept light and brand-safe.
  function shareText(result) {
    result = result || {};
    var lines = ['🌿 BUDSHOP RUNNER'];
    if (result.score != null) {
      var rank = result.rank || rankForScore(Math.round(result.score)).name;
      lines.push('🏆 ' + Math.round(result.score) + ' pts · ' + rank);
    }
    if (result.distance != null) {
      lines.push('🏃 ' + formatDistance(result.distance) + ' run');
    }
    if (result.buds != null) {
      lines.push('🌱 ' + result.buds + ' buds harvested');
    }
    if (result.bestCombo != null && result.bestCombo > 1) {
      lines.push('🔥 best harvest combo ×' + Math.min(result.bestCombo, COMBO_MAX));
    }
    lines.push('Can you out-run the heat? onlinebudshop.com');
    return lines.join('\n');
  }

  return {
    // config (read by the shell — never hard-coded there)
    GROUND_Y: GROUND_Y, RUNNER_X: RUNNER_X,
    GRAVITY: GRAVITY, JUMP_VELOCITY: JUMP_VELOCITY,
    MAX_HOLD: MAX_HOLD, HOLD_LIFT: HOLD_LIFT,
    RUNNER_W: RUNNER_W, RUNNER_H: RUNNER_H, DUCK_H: DUCK_H, HURT_FRAC: HURT_FRAC,
    SPEED_BASE: SPEED_BASE, SPEED_GAIN: SPEED_GAIN, SPEED_MAX: SPEED_MAX,
    COMBO_WINDOW: COMBO_WINDOW, COMBO_MAX: COMBO_MAX, BUD_BASE: BUD_BASE,
    WATER_BONUS: WATER_BONUS, DIST_POINTS: DIST_POINTS,
    REACTION_TIME: REACTION_TIME, GAP_SLACK: GAP_SLACK, SPAWN_AHEAD: SPAWN_AHEAD,
    BEST_KEYS: BEST_KEYS, RANKS: RANKS,
    // math + rng
    clamp: clamp, lerp: lerp, makeRng: makeRng,
    // physics + derived
    speedAt: speedAt, jumpAirtime: jumpAirtime, jumpApex: jumpApex,
    minReactionDist: minReactionDist, laneBottom: laneBottom,
    // runner + collision
    Runner: Runner, entityBox: entityBox, aabb: aabb, collides: collides,
    // scoring
    comboMultiplier: comboMultiplier, ScoreKeeper: ScoreKeeper,
    // spawner
    Spawner: Spawner,
    // best-score model + share
    updateBest: updateBest, formatDistance: formatDistance,
    rankForScore: rankForScore, shareText: shareText
  };
});
