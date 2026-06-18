/*
 * BUDSHOP COURIER — core.js: the pure logic engine for a Paperboy-style
 * delivery ride. Diagonal road-space projection (mirrors stormwing-express's
 * switchback-post.js), Scooter physics (auto-forward u at cruise, steer v with
 * clamp + lean, lives), Package ballistics in road-space (arc in h, advances in
 * u and toward the curb in v, lands at h<=0 and scores by ring vs the nearest
 * porch target within a FORGIVING radius), a ScoreKeeper with a tip combo
 * ×1→×5 window-decay (never broken by missed tosses), share text + best model.
 *
 * Pure logic, NO DOM. Loaded as window.BudCore in a browser and via require()
 * in Node tests (UMD wrapper, pattern: budshop-runner/src/core.js).
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  THE SEAM (the shell + route mirror these shapes EXACTLY; never re-derive).
 *
 *  PROJECTION — road-space (u,v,h) → screen (x,y):
 *      screen = ANCHOR + (u - camU)*ALONG + v*LANE_PX*LANE - (0, h)
 *    with ALONG = (ALONG_X, ALONG_Y) = (0.80, 0.60),
 *         LANE  = (LANE_X,  LANE_Y)  = (-0.60, 0.80),
 *         LANE_PX = 56, ANCHOR = (ANCHOR_X, ANCHOR_Y).
 *    camU = playerU - CAM_BACK (camera trails the scooter by CAM_BACK).
 *    API:  Core.project(u, v, h, camU) -> { x, y }.
 *    A point at u === camU, v === 0, h === 0 projects to ANCHOR exactly.
 *    Larger u draws FURTHER (greater screen y / depth) — the shell depth-sorts
 *    far→near (DESCENDING u) so near things paint over far things.
 *
 *  SCOOTER state — what the shell reads to draw the rider:
 *      {
 *        u:    number  distance ALONG the road (auto-increases at cruise)
 *        v:    number  lateral lane position, clamped to [V_MIN, V_MAX]
 *        vv:   number  lateral velocity (lane units/s) — for inheritance + lean
 *        lean: number  -1..1 visual lean (sign of steer, eased) for the shell
 *        lives:number  starts at LIVES; a hazard hit costs one + a tumble
 *        tumble:number  seconds of post-hit stun (steering frozen, no toss)
 *      }
 *    Camera: Scooter.camU() === u - CAM_BACK.
 *
 *  PACKAGE (toss) — Core.Toss(scooter) launches a package; the shell draws each
 *    live package + its ground shadow (project at h=0). A package is:
 *      {
 *        u, v, h:  road-space position (h = height above road; 0 = landed)
 *        du, dv, dh: per-second velocities in (u, v, h)
 *        landed:   boolean  set true the frame it touches h<=0
 *        dead:     boolean  the shell may cull dead packages
 *        result:   null | { house, ring, points } once it lands + scores
 *      }
 *    Empty/missed tosses NEVER cost anything and NEVER break combo.
 *
 *  PORCH TARGET geometry (also re-exported from route.js):
 *      a porch target is a road-space point (u, v) on the curb with concentric
 *      ring radii. A landed package scores by its distance d (road-space px,
 *      with v scaled by LANE_PX) to the nearest UNDELIVERED customer porch:
 *        d <= BULLSEYE_R  → bullseye (most points)
 *        d <= PORCH_R     → porch    (good points)
 *        else             → miss (no score, no penalty, combo intact)
 *      PORCH_V is the curb lane the porches sit at; PORCH_LEAD is how far ahead
 *      of the house anchor the porch center sits (so the natural toss lands on
 *      it). These are TUNED TOGETHER with the toss arc — see TOSS_TUNING below.
 * ────────────────────────────────────────────────────────────────────────────
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    // Browser global. Expose both the natural name and the BC* alias the shell
    // reads (load-order/naming safe, mirrors the Runner core's dual-alias).
    root.BudCore = root.BCCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Projection constants (mirror switchback-post.js shapes) ──────────────
  var ANCHOR_X = 270;        // projection anchor on the 540×720 portrait canvas
  var ANCHOR_Y = 250;        // (shell reference — never hard-code there)
  var ALONG_X = 0.80, ALONG_Y = 0.60;   // ALONG unit vector (along the road)
  var LANE_X = -0.60, LANE_Y = 0.80;    // LANE unit vector (across the lanes)
  var LANE_PX = 56;          // px per lane unit (v * 56 * LANE)
  var CAM_BACK = 70;         // camera trails the scooter by this many u

  // ── Street geometry (lanes the scooter rides between) ────────────────────
  var V_MIN = 0.0;           // left edge of the rideable street
  var V_MAX = 3.0;           // right edge (3 lanes wide)
  var CRUISE_V = 1.5;        // the natural "cruising" lane (mid-street)

  // ── Scooter motion ───────────────────────────────────────────────────────
  var CRUISE_SPEED = 150;    // u px/s auto-forward (the cruise)
  // STEER: lateral acceleration + a max lateral speed tuned so crossing the
  // full street (V_MIN→V_MAX = 3 lanes) takes ~1.5s — responsive, not floaty.
  var STEER_ACCEL = 16;      // lane-units/s² applied while holding a steer
  var STEER_MAX_V = 2.4;     // max lateral speed (lane-units/s)
  var STEER_DAMP = 12;       // lateral velocity damping/s when not steering
  var LEAN_EASE = 8;         // how fast the visual lean eases toward the target
  var LIVES = 3;             // starting lives
  var TUMBLE_TIME = 0.9;     // seconds of stun after a hazard hit
  var INVULN_TIME = 1.4;     // i-frames after a hit (>= tumble) so one car ≠ two hits

  // ── Toss ballistics + porch target (TUNED TOGETHER — see TOSS_TUNING) ────
  // A toss launches a package UP (dh > 0) and OUT toward the curb (dv toward
  // PORCH_V), inheriting the scooter's forward motion in u. Gravity TOSS_G
  // pulls h down; it lands when h <= 0. The flight time and the lateral/forward
  // travel are tuned so a toss from CRUISE_V at the moment a porch is PORCH_LEAD
  // ahead LANDS on that porch. PROVE in core.test.js (the fairness test).
  var TOSS_G = 900;          // h gravity (px/s²)
  var TOSS_DH = 300;         // initial upward velocity (px/s) → airtime 2*DH/G
  var TOSS_DU = 60;          // extra forward velocity added to the inherited u
  var TOSS_INHERIT = 1.0;    // fraction of scooter u-speed the package inherits
  // Lateral toss speed is COMPUTED per-throw to carry the package from the
  // scooter's current v to the porch lane over the airtime (so aiming is about
  // WHEN you throw + your lane, not a twitchy lateral). See Toss().
  var PORCH_V = -0.9;        // porch lane: just off the LEFT curb (-LANE side)
  var PORCH_LEAD = 0;        // porch center u offset from the house anchor
                             // (0 = porch sits AT the house's u; the lead is
                             //  baked into when the player throws, computed
                             //  from the airtime — see expectedLandingLead()).
  var BULLSEYE_R = 18;       // dead-center radius (road-space px) — bullseye
  var PORCH_R = 46;          // outer porch radius — FORGIVING so it feels good
  var BULLSEYE_PTS = 100;    // bullseye base points (before tip multiplier)
  var PORCH_PTS = 60;        // porch base points (before tip multiplier)

  // ── Tip combo (×1→×5, window-decay; mirrors the Runner harvest combo) ────
  var COMBO_WINDOW = 5.0;    // seconds before the tip combo decays one step
  var COMBO_MAX = 5;
  var DELIVERY_BUMP = 1;     // each delivery bumps the combo by one step

  // ════════════════════════════════════════════════════════════════════════
  //  Math helpers
  // ════════════════════════════════════════════════════════════════════════
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ── Seeded RNG (mulberry32 — deterministic, testable; same as Runner) ────
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

  // ════════════════════════════════════════════════════════════════════════
  //  PROJECTION — road-space (u,v,h) → screen (x,y). THE SEAM.
  // ════════════════════════════════════════════════════════════════════════
  //  screen = ANCHOR + (u - camU)*ALONG + v*LANE_PX*LANE - (0, h)
  function project(u, v, h, camU) {
    var du = u - (camU == null ? 0 : camU);
    return {
      x: ANCHOR_X + du * ALONG_X + v * LANE_PX * LANE_X,
      y: ANCHOR_Y + du * ALONG_Y + v * LANE_PX * LANE_Y - (h || 0)
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TOSS BALLISTICS — derived constants + the fairness landing model.
  // ════════════════════════════════════════════════════════════════════════
  // Airtime of a toss: up then down for the bare impulse, 2*DH/G.
  function tossAirtime() { return (2 * TOSS_DH) / TOSS_G; }

  // How far AHEAD in u a package travels during its flight when thrown at a
  // given scooter u-speed. = (inherited speed + extra) * airtime. The porch the
  // player wants to hit must be ~this far ahead at the moment of the throw — so
  // a toss thrown when a porch is `expectedLandingLead()` ahead lands on it.
  function expectedLandingLead(scooterUSpeed) {
    var sp = scooterUSpeed == null ? CRUISE_SPEED : scooterUSpeed;
    return (sp * TOSS_INHERIT + TOSS_DU) * tossAirtime();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  PORCH TARGET — ring scoring (forgiving). Shared by route.js + the shell.
  // ════════════════════════════════════════════════════════════════════════
  // Road-space distance from a landed package (pu, pv) to a porch target at
  // (tu, tv). v is scaled to px by LANE_PX so the radius is in consistent px.
  function porchDist(pu, pv, tu, tv) {
    var du = pu - tu;
    var dv = (pv - tv) * LANE_PX;
    return Math.sqrt(du * du + dv * dv);
  }

  // ring(d) → 'bullseye' | 'porch' | null  (null = a miss; no penalty).
  function ring(d) {
    if (d <= BULLSEYE_R) return 'bullseye';
    if (d <= PORCH_R) return 'porch';
    return null;
  }

  function ringPoints(r) {
    if (r === 'bullseye') return BULLSEYE_PTS;
    if (r === 'porch') return PORCH_PTS;
    return 0;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SCOOTER — the rider's physics state (auto-forward u, steer v, lives).
  // ════════════════════════════════════════════════════════════════════════
  function Scooter(opts) {
    opts = opts || {};
    this.u = opts.u == null ? 0 : opts.u;
    this.v = opts.v == null ? CRUISE_V : opts.v;
    this.vv = 0;            // lateral velocity (lane-units/s)
    this.lean = 0;          // -1..1 eased visual lean
    this.speed = CRUISE_SPEED;
    this.lives = opts.lives == null ? LIVES : opts.lives;
    this.tumble = 0;        // post-hit stun timer (steering frozen)
    this.invuln = 0;        // i-frames timer
  }

  // Update the scooter one step. input = { steer: -1|0|1, throttle?, brake? }.
  // steer < 0 = toward V_MIN (left curb), steer > 0 = toward V_MAX. Auto-forward
  // u at cruise (mild throttle/brake optional). Returns nothing; shell reads the
  // mutated fields. Empty input (no steer) is always legal — it eases to a stop
  // laterally and keeps cruising forward.
  Scooter.prototype.update = function (dt, input) {
    input = input || {};
    var steer = input.steer || 0;

    // Timers.
    if (this.tumble > 0) this.tumble = Math.max(0, this.tumble - dt);
    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);

    // Auto-forward u. Optional mild throttle/brake; tumble cuts forward speed.
    var base = CRUISE_SPEED;
    if (input.throttle) base = CRUISE_SPEED * 1.25;
    else if (input.brake) base = CRUISE_SPEED * 0.7;
    if (this.tumble > 0) base = CRUISE_SPEED * 0.45;  // stumble, never a full stop
    this.speed = base;
    this.u += this.speed * dt;

    // STEER: during a tumble the rider can't steer (frozen), and lateral velocity
    // damps out. Otherwise accelerate v toward the held direction, capped.
    if (this.tumble > 0) {
      steer = 0;
    }
    if (steer !== 0) {
      this.vv += steer * STEER_ACCEL * dt;
      this.vv = clamp(this.vv, -STEER_MAX_V, STEER_MAX_V);
    } else {
      // Damp toward zero (responsive, no floaty drift).
      var damp = STEER_DAMP * dt;
      if (this.vv > 0) this.vv = Math.max(0, this.vv - damp);
      else if (this.vv < 0) this.vv = Math.min(0, this.vv + damp);
    }
    this.v += this.vv * dt;

    // Lane clamp: v stays in [V_MIN, V_MAX]; kill lateral velocity at the edge.
    if (this.v < V_MIN) { this.v = V_MIN; if (this.vv < 0) this.vv = 0; }
    if (this.v > V_MAX) { this.v = V_MAX; if (this.vv > 0) this.vv = 0; }

    // Visual lean eases toward the steer direction (or back to upright).
    var leanTarget = clamp(this.vv / STEER_MAX_V, -1, 1);
    this.lean += (leanTarget - this.lean) * Math.min(1, LEAN_EASE * dt);
  };

  Scooter.prototype.camU = function () { return this.u - CAM_BACK; };

  // Take a hazard hit: costs a life + starts a tumble + i-frames. Returns true
  // if the hit landed (not in i-frames), false if shrugged off. 'gameover' is
  // signalled by lives reaching 0 — the shell checks scooter.lives.
  Scooter.prototype.hit = function () {
    if (this.invuln > 0) return false;  // i-frames: ignore repeat contact
    this.lives = Math.max(0, this.lives - 1);
    this.tumble = TUMBLE_TIME;
    this.invuln = INVULN_TIME;
    this.vv = 0;
    return true;
  };

  Scooter.prototype.isDead = function () { return this.lives <= 0; };

  // ════════════════════════════════════════════════════════════════════════
  //  TOSS — a thrown package in road-space. Arc in h, advance in u + toward
  //  the curb in v, land at h<=0, score by ring vs the nearest porch target.
  // ════════════════════════════════════════════════════════════════════════
  // Construct a package launched from the scooter NOW. The lateral toss speed
  // (dv) is COMPUTED so the package travels from the scooter's current v to the
  // porch lane PORCH_V over exactly the airtime — so aiming is WHEN you throw +
  // your lane, never a twitchy lateral flick. Forward (du) inherits the scooter
  // u-speed plus a small extra. Up (dh) is the fixed loft.
  function Toss(scooter) {
    var sp = scooter ? scooter.speed : CRUISE_SPEED;
    var startV = scooter ? scooter.v : CRUISE_V;
    var T = tossAirtime();
    this.u = scooter ? scooter.u : 0;
    this.v = startV;
    this.h = 0;
    this.du = sp * TOSS_INHERIT + TOSS_DU;
    // Carry from startV to the porch lane over the airtime.
    this.dv = (PORCH_V - startV) / T;
    this.dh = TOSS_DH;
    this.landed = false;
    this.dead = false;
    this.result = null;
  }

  // Step the package. On the frame it lands (h crosses 0) it pins h=0 and the
  // caller should call scoreLanding(); update() leaves scoring to the caller so
  // the toss model stays independent of the route's porch set.
  Toss.prototype.update = function (dt) {
    if (this.landed) return;
    this.u += this.du * dt;
    this.v += this.dv * dt;
    this.dh -= TOSS_G * dt;
    this.h += this.dh * dt;
    if (this.h <= 0) {
      this.h = 0;
      this.landed = true;
    }
  };

  // Score a landed package against a list of porch targets. Each target is
  // { u, v, delivered, house? }. Picks the NEAREST undelivered target within
  // PORCH_R, marks it delivered, returns { house, ring, points } (points are
  // BASE points — the caller applies the tip multiplier). A miss returns null
  // and costs NOTHING (combo intact). Safe to call only on a landed package.
  function scoreLanding(toss, targets) {
    if (!toss || !toss.landed) return null;
    var best = null, bestD = Infinity, i;
    for (i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (t.delivered) continue;
      var d = porchDist(toss.u, toss.v, t.u, t.v);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (!best) return null;
    var r = ring(bestD);
    if (!r) return null;                 // landed, but outside any porch — a miss
    best.delivered = true;
    var res = { house: best, ring: r, points: ringPoints(r), dist: bestD };
    toss.result = res;
    return res;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SCORE KEEPER — tip combo (×1→×5, window-decay). Mirrors the Runner combo.
  // ════════════════════════════════════════════════════════════════════════
  function comboMultiplier(combo) {
    if (combo <= 1) return 1;
    return Math.min(combo, COMBO_MAX);
  }

  function ScoreKeeper() {
    this.score = 0;
    this.deliveries = 0;     // total porches hit
    this.bullseyes = 0;      // deliveries that were dead-center
    this.combo = 1;          // current tip multiplier level (1 = no streak)
    this.bestCombo = 1;
    this.window = COMBO_WINDOW;
  }

  // Bank a delivery: bumps the tip combo, refreshes the window, banks
  // base × multiplier. `result` is the object from scoreLanding(). Returns the
  // points actually banked.
  ScoreKeeper.prototype.deliver = function (result) {
    if (!result) return 0;
    this.deliveries += 1;
    if (result.ring === 'bullseye') this.bullseyes += 1;
    this.combo = Math.min(this.combo + DELIVERY_BUMP, COMBO_MAX);
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    this.window = COMBO_WINDOW;
    var pts = Math.round(result.points * comboMultiplier(this.combo));
    this.score += pts;
    return pts;
  };

  // Tick the combo window. Decay is purely time-based: if no delivery lands
  // within COMBO_WINDOW seconds the multiplier drops ONE step (toward ×1) and
  // the window resets. NOTHING ELSE resets it — a missed toss, an empty stretch,
  // a hazard hit all leave the combo intact (only the clock decays it).
  ScoreKeeper.prototype.tick = function (dt) {
    if (this.combo <= 1) return;
    this.window -= dt;
    if (this.window <= 0) {
      this.combo = Math.max(1, this.combo - 1);
      this.window = COMBO_WINDOW;
    }
  };

  // ── Best-score model (FORMAT ONLY — the shell owns localStorage I/O) ─────
  var BEST_KEYS = {
    score: 'budshop.courier.bestScore',
    deliveries: 'budshop.courier.bestDeliveries'
  };

  function updateBest(result, prior) {
    result = result || {};
    prior = prior || {};
    var score = Math.max(0, Math.round(result.score || 0));
    var deliveries = Math.max(0, Math.round(result.deliveries || 0));
    var pScore = Math.max(0, Math.round(prior.score || 0));
    var pDeliveries = Math.max(0, Math.round(prior.deliveries || 0));
    return {
      score: Math.max(score, pScore),
      deliveries: Math.max(deliveries, pDeliveries),
      newBestScore: score > pScore,
      newBestDeliveries: deliveries > pDeliveries
    };
  }

  // ── Ranks + share text (results card / COPY) ─────────────────────────────
  var RANKS = [
    { name: 'Rookie Runner', min: 0 },
    { name: 'Block Regular', min: 600 },
    { name: 'Route Pro',     min: 1600 },
    { name: 'Ace Courier',   min: 3500 },
    { name: 'Legend',        min: 6500 }
  ];

  function rankForScore(score) {
    var best = RANKS[0];
    for (var i = 0; i < RANKS.length; i++) {
      if (score >= RANKS[i].min) best = RANKS[i];
    }
    return best;
  }

  // shareText(result) → a tweetable summary. result =
  // { score, deliveries, total, bestCombo, rank? }. Pure formatting.
  function shareText(result) {
    result = result || {};
    var lines = ['📦 BUDSHOP COURIER'];
    if (result.score != null) {
      var rank = result.rank || rankForScore(Math.round(result.score)).name;
      lines.push('🏆 ' + Math.round(result.score) + ' pts · ' + rank);
    }
    if (result.deliveries != null && result.total != null) {
      lines.push('🚪 ' + result.deliveries + '/' + result.total + ' delivered');
    } else if (result.deliveries != null) {
      lines.push('🚪 ' + result.deliveries + ' delivered');
    }
    if (result.bestCombo != null && result.bestCombo > 1) {
      lines.push('💸 best tip combo ×' + Math.min(result.bestCombo, COMBO_MAX));
    }
    lines.push('Run the route at onlinebudshop.com');
    return lines.join('\n');
  }

  return {
    // ── projection constants (read by the shell — never hard-coded there) ──
    ANCHOR_X: ANCHOR_X, ANCHOR_Y: ANCHOR_Y,
    ALONG_X: ALONG_X, ALONG_Y: ALONG_Y, LANE_X: LANE_X, LANE_Y: LANE_Y,
    LANE_PX: LANE_PX, CAM_BACK: CAM_BACK,
    // ── street + motion config ──
    V_MIN: V_MIN, V_MAX: V_MAX, CRUISE_V: CRUISE_V,
    CRUISE_SPEED: CRUISE_SPEED, STEER_ACCEL: STEER_ACCEL,
    STEER_MAX_V: STEER_MAX_V, STEER_DAMP: STEER_DAMP, LEAN_EASE: LEAN_EASE,
    LIVES: LIVES, TUMBLE_TIME: TUMBLE_TIME, INVULN_TIME: INVULN_TIME,
    // ── toss + porch config ──
    TOSS_G: TOSS_G, TOSS_DH: TOSS_DH, TOSS_DU: TOSS_DU, TOSS_INHERIT: TOSS_INHERIT,
    PORCH_V: PORCH_V, PORCH_LEAD: PORCH_LEAD,
    BULLSEYE_R: BULLSEYE_R, PORCH_R: PORCH_R,
    BULLSEYE_PTS: BULLSEYE_PTS, PORCH_PTS: PORCH_PTS,
    // ── combo config ──
    COMBO_WINDOW: COMBO_WINDOW, COMBO_MAX: COMBO_MAX, DELIVERY_BUMP: DELIVERY_BUMP,
    BEST_KEYS: BEST_KEYS, RANKS: RANKS,
    // ── math + rng ──
    clamp: clamp, lerp: lerp, makeRng: makeRng,
    // ── projection (THE SEAM) ──
    project: project,
    // ── toss model ──
    tossAirtime: tossAirtime, expectedLandingLead: expectedLandingLead,
    Toss: Toss, scoreLanding: scoreLanding,
    // ── porch scoring ──
    porchDist: porchDist, ring: ring, ringPoints: ringPoints,
    // ── scooter + collision ──
    Scooter: Scooter,
    // ── scoring ──
    comboMultiplier: comboMultiplier, ScoreKeeper: ScoreKeeper,
    // ── best-score model + share ──
    updateBest: updateBest, rankForScore: rankForScore, shareText: shareText
  };
});
