/*
 * BUDSHOP COURIER — canvas shell. A scrolling diagonal-road Paperboy ride:
 * you auto-roll down a neighborhood street, STEER across the lanes, and TOSS
 * packages onto customers' porches. This file ONLY renders the logic core's
 * state and feeds it input — it never re-derives the projection, ballistics,
 * scoring, route, or collision math. ALL rules live in src/core.js
 * (window.BudCore / window.BCCore) + src/route.js (window.BudRoute /
 * window.BCRoute).
 *
 * Loaded after core.js + route.js, then touch-controls.js. Exposes
 * window.__COURIER for the headless vm test harness (test/shell.test.js).
 *
 * Style: vanilla ES5, no build step, no deps. Browser globals, written
 * defensively so the vm harness can boot it with stubbed window/document.
 * If the logic core / route have not loaded (parallel build / standalone
 * test), a tiny inline FALLBACK mirrors the pinned seam EXACTLY (same globals,
 * method + field names, units, and the TOSS-LANDS-ON-PORCH tuning) so the
 * shell still boots and the shell test runs standalone. The fallback is the
 * seam contract restated, NOT a second implementation.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  THE SEAM the shell consumes (mirrored from core.js + route.js headers):
 *
 *  PROJECTION (matches switchback-post.js):
 *    Core.project(u, v, h, camU) → { x, y }
 *      screen = (ANCHOR_X, ANCHOR_Y) + (u-camU)*(ALONG_X,ALONG_Y)
 *               + v*LANE_PX*(LANE_X,LANE_Y) - (0, h)
 *    Camera trails the scooter: camU = scooter.camU() = scooter.u - CAM_BACK.
 *    Depth-sort FAR→NEAR (DESCENDING u) so near paints over far. Every
 *    airborne thing draws a soft shadow at its TRUE (u, v, 0) road point.
 *
 *  SCOOTER  new Core.Scooter()  .update(dt, { steer:-1|0|1, throttle?, brake? })
 *    fields: u, v, vv (lateral vel), lean (-1..1), speed, lives, tumble, invuln
 *    methods: .camU(), .hit() → true if the hit landed, .isDead()
 *
 *  TOSS  new Core.Toss(scooter)  .update(dt)
 *    fields: u, v, h, du, dv, dh, landed, dead, result
 *    Core.scoreLanding(toss, porchTargets) → { house, ring, points, dist } | null
 *      (a miss returns null and costs NOTHING — combo intact). The lateral dv
 *      is computed by the core so a toss from the cruise lane lands on a porch.
 *
 *  SCORE  new Core.ScoreKeeper()
 *    fields: score, deliveries, bullseyes, combo, bestCombo, window
 *    .deliver(result) → banked pts (base × tip combo); bumps the combo
 *    .tick(dt) → time-window combo decay (one step). The SHELL gates this call
 *      to "while customer houses are on screen" per the combo contract.
 *    Core.comboMultiplier(combo)
 *
 *  ROUTE  Route.generate(seed) → {
 *      seed, routeU, houses, customers, hazards, porchTargets, total
 *    }
 *    HOUSE: { kind, id, u, v, side:'left'|'right', customer, art,
 *             porch?:{ u, v, delivered, house } }   (porch only on customers)
 *    HAZARD: { kind, id, u, v, w, h, rU, rV, moving, art }
 *    Route.hazardHits(hazard, scooterU, scooterV) → boolean
 *    Route.countDelivered(route) → number
 *
 *  Core.updateBest(result, prior) / Core.BEST_KEYS / Core.shareText(result)
 *  Core.rankForScore(score)
 * ───────────────────────────────────────────────────────────────────────────
 */
(function (root) {
  'use strict';

  // ════════════════════════════════════════════════════════════════════
  //  FALLBACK CORE — mirrors window.BudCore EXACTLY (same globals, method +
  //  field names, units, projection shapes, and the toss/porch tuning). Used
  //  ONLY when the real src/core.js has not loaded (parallel build / standalone
  //  shell test). It is the seam contract restated, not a rival implementation.
  // ════════════════════════════════════════════════════════════════════
  function buildFallbackCore() {
    var ANCHOR_X = 270, ANCHOR_Y = 250;
    var ALONG_X = 0.80, ALONG_Y = 0.60;
    var LANE_X = -0.60, LANE_Y = 0.80;
    var LANE_PX = 56, CAM_BACK = 70;
    var V_MIN = 0.0, V_MAX = 3.0, CRUISE_V = 1.5;
    var CRUISE_SPEED = 150;
    var STEER_ACCEL = 16, STEER_MAX_V = 2.4, STEER_DAMP = 12, LEAN_EASE = 8;
    var LIVES = 3, TUMBLE_TIME = 0.9, INVULN_TIME = 1.4;
    var TOSS_G = 900, TOSS_DH = 300, TOSS_DU = 60, TOSS_INHERIT = 1.0;
    var PORCH_V = -0.9, PORCH_LEAD = 0;
    var BULLSEYE_R = 18, PORCH_R = 46, BULLSEYE_PTS = 100, PORCH_PTS = 60;
    var COMBO_WINDOW = 5.0, COMBO_MAX = 5, DELIVERY_BUMP = 1;
    var BEST_KEYS = { score: 'budshop.courier.bestScore', deliveries: 'budshop.courier.bestDeliveries' };

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function lerp(a, b, t) { return a + (b - a) * t; }
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

    function project(u, v, h, camU) {
      var du = u - (camU == null ? 0 : camU);
      return {
        x: ANCHOR_X + du * ALONG_X + v * LANE_PX * LANE_X,
        y: ANCHOR_Y + du * ALONG_Y + v * LANE_PX * LANE_Y - (h || 0)
      };
    }

    function tossAirtime() { return (2 * TOSS_DH) / TOSS_G; }
    function expectedLandingLead(sp) {
      sp = sp == null ? CRUISE_SPEED : sp;
      return (sp * TOSS_INHERIT + TOSS_DU) * tossAirtime();
    }

    function porchDist(pu, pv, tu, tv) {
      var du = pu - tu, dv = (pv - tv) * LANE_PX;
      return Math.sqrt(du * du + dv * dv);
    }
    function ring(d) {
      if (d <= BULLSEYE_R) return 'bullseye';
      if (d <= PORCH_R) return 'porch';
      return null;
    }
    function ringPoints(r) { return r === 'bullseye' ? BULLSEYE_PTS : r === 'porch' ? PORCH_PTS : 0; }

    function Scooter(opts) {
      opts = opts || {};
      this.u = opts.u == null ? 0 : opts.u;
      this.v = opts.v == null ? CRUISE_V : opts.v;
      this.vv = 0; this.lean = 0; this.speed = CRUISE_SPEED;
      this.lives = opts.lives == null ? LIVES : opts.lives;
      this.tumble = 0; this.invuln = 0;
    }
    Scooter.prototype.update = function (dt, input) {
      input = input || {};
      var steer = input.steer || 0;
      if (this.tumble > 0) this.tumble = Math.max(0, this.tumble - dt);
      if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);
      var base = CRUISE_SPEED;
      if (input.throttle) base = CRUISE_SPEED * 1.25;
      else if (input.brake) base = CRUISE_SPEED * 0.7;
      if (this.tumble > 0) base = CRUISE_SPEED * 0.45;
      this.speed = base;
      this.u += this.speed * dt;
      if (this.tumble > 0) steer = 0;
      if (steer !== 0) {
        this.vv += steer * STEER_ACCEL * dt;
        this.vv = clamp(this.vv, -STEER_MAX_V, STEER_MAX_V);
      } else {
        var damp = STEER_DAMP * dt;
        if (this.vv > 0) this.vv = Math.max(0, this.vv - damp);
        else if (this.vv < 0) this.vv = Math.min(0, this.vv + damp);
      }
      this.v += this.vv * dt;
      if (this.v < V_MIN) { this.v = V_MIN; if (this.vv < 0) this.vv = 0; }
      if (this.v > V_MAX) { this.v = V_MAX; if (this.vv > 0) this.vv = 0; }
      var leanTarget = clamp(this.vv / STEER_MAX_V, -1, 1);
      this.lean += (leanTarget - this.lean) * Math.min(1, LEAN_EASE * dt);
    };
    Scooter.prototype.camU = function () { return this.u - CAM_BACK; };
    Scooter.prototype.hit = function () {
      if (this.invuln > 0) return false;
      this.lives = Math.max(0, this.lives - 1);
      this.tumble = TUMBLE_TIME; this.invuln = INVULN_TIME; this.vv = 0;
      return true;
    };
    Scooter.prototype.isDead = function () { return this.lives <= 0; };

    function Toss(scooter) {
      var sp = scooter ? scooter.speed : CRUISE_SPEED;
      var startV = scooter ? scooter.v : CRUISE_V;
      var T = tossAirtime();
      this.u = scooter ? scooter.u : 0;
      this.v = startV;
      this.h = 0;
      this.du = sp * TOSS_INHERIT + TOSS_DU;
      this.dv = (PORCH_V - startV) / T;   // carry from this lane to the porch lane
      this.dh = TOSS_DH;
      this.landed = false; this.dead = false; this.result = null;
    }
    Toss.prototype.update = function (dt) {
      if (this.landed) return;
      this.u += this.du * dt;
      this.v += this.dv * dt;
      this.dh -= TOSS_G * dt;
      this.h += this.dh * dt;
      if (this.h <= 0) { this.h = 0; this.landed = true; }
    };
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
      if (!r) return null;
      best.delivered = true;
      var res = { house: best, ring: r, points: ringPoints(r), dist: bestD };
      toss.result = res;
      return res;
    }

    function comboMultiplier(combo) { return combo <= 1 ? 1 : Math.min(combo, COMBO_MAX); }
    function ScoreKeeper() {
      this.score = 0; this.deliveries = 0; this.bullseyes = 0;
      this.combo = 1; this.bestCombo = 1; this.window = COMBO_WINDOW;
    }
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
    ScoreKeeper.prototype.tick = function (dt) {
      if (this.combo <= 1) return;
      this.window -= dt;
      if (this.window <= 0) { this.combo = Math.max(1, this.combo - 1); this.window = COMBO_WINDOW; }
    };

    function updateBest(result, prior) {
      result = result || {}; prior = prior || {};
      var score = Math.max(0, Math.round(result.score || 0));
      var deliveries = Math.max(0, Math.round(result.deliveries || 0));
      var pScore = Math.max(0, Math.round(prior.score || 0));
      var pDeliveries = Math.max(0, Math.round(prior.deliveries || 0));
      return {
        score: Math.max(score, pScore), deliveries: Math.max(deliveries, pDeliveries),
        newBestScore: score > pScore, newBestDeliveries: deliveries > pDeliveries
      };
    }
    var RANKS = [
      { name: 'Rookie Runner', min: 0 }, { name: 'Block Regular', min: 600 },
      { name: 'Route Pro', min: 1600 }, { name: 'Ace Courier', min: 3500 },
      { name: 'Legend', min: 6500 }
    ];
    function rankForScore(score) {
      var best = RANKS[0];
      for (var i = 0; i < RANKS.length; i++) if (score >= RANKS[i].min) best = RANKS[i];
      return best;
    }
    function shareText(result) {
      result = result || {};
      var lines = ['📦 BUDSHOP COURIER'];
      if (result.score != null) lines.push('🏆 ' + Math.round(result.score) + ' pts · ' + (result.rank || rankForScore(Math.round(result.score)).name));
      if (result.deliveries != null && result.total != null) lines.push('🚪 ' + result.deliveries + '/' + result.total + ' delivered');
      else if (result.deliveries != null) lines.push('🚪 ' + result.deliveries + ' delivered');
      if (result.bestCombo != null && result.bestCombo > 1) lines.push('💸 best tip combo ×' + Math.min(result.bestCombo, COMBO_MAX));
      lines.push('Run the route at onlinebudshop.com');
      return lines.join('\n');
    }

    return {
      ANCHOR_X: ANCHOR_X, ANCHOR_Y: ANCHOR_Y,
      ALONG_X: ALONG_X, ALONG_Y: ALONG_Y, LANE_X: LANE_X, LANE_Y: LANE_Y,
      LANE_PX: LANE_PX, CAM_BACK: CAM_BACK,
      V_MIN: V_MIN, V_MAX: V_MAX, CRUISE_V: CRUISE_V,
      CRUISE_SPEED: CRUISE_SPEED, STEER_ACCEL: STEER_ACCEL, STEER_MAX_V: STEER_MAX_V,
      STEER_DAMP: STEER_DAMP, LEAN_EASE: LEAN_EASE,
      LIVES: LIVES, TUMBLE_TIME: TUMBLE_TIME, INVULN_TIME: INVULN_TIME,
      TOSS_G: TOSS_G, TOSS_DH: TOSS_DH, TOSS_DU: TOSS_DU, TOSS_INHERIT: TOSS_INHERIT,
      PORCH_V: PORCH_V, PORCH_LEAD: PORCH_LEAD,
      BULLSEYE_R: BULLSEYE_R, PORCH_R: PORCH_R, BULLSEYE_PTS: BULLSEYE_PTS, PORCH_PTS: PORCH_PTS,
      COMBO_WINDOW: COMBO_WINDOW, COMBO_MAX: COMBO_MAX, DELIVERY_BUMP: DELIVERY_BUMP,
      BEST_KEYS: BEST_KEYS, RANKS: RANKS,
      clamp: clamp, lerp: lerp, makeRng: makeRng,
      project: project,
      tossAirtime: tossAirtime, expectedLandingLead: expectedLandingLead,
      Toss: Toss, scoreLanding: scoreLanding,
      porchDist: porchDist, ring: ring, ringPoints: ringPoints,
      Scooter: Scooter,
      comboMultiplier: comboMultiplier, ScoreKeeper: ScoreKeeper,
      updateBest: updateBest, rankForScore: rankForScore, shareText: shareText
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  FALLBACK ROUTE — mirrors window.BudRoute EXACTLY (same generate(seed)
  //  output shape, house/porch/hazard fields, and hazardHits signature). Used
  //  ONLY when the real src/route.js has not loaded.
  // ════════════════════════════════════════════════════════════════════
  function buildFallbackRoute(Core) {
    var HOUSE_SPACING = 220, HOUSE_JITTER = 70, N_CUSTOMERS = 10;
    var CUSTOMER_RATIO = 0.5, START_U = 360, END_PAD = 360;
    var PORCH_V = Core.PORCH_V, PORCH_LEAD = Core.PORCH_LEAD;
    var LEFT_CURB_V = -1.4, RIGHT_CURB_V = Core.V_MAX + 1.4;
    var MIN_HAZARD_GAP = 300, HAZARD_GAP_JITTER = 220, FIRST_HAZARD_U = 600;
    var OUTLINE = '#1d1d28';
    var HOUSE_ART = [
      { roof: '#c0473e', body: '#e6cf9a', door: '#5f9450', trim: '#fff3e0' },
      { roof: '#3a6ad0', body: '#cdd7e6', door: '#c0473e', trim: '#f0e6c0' },
      { roof: '#5f9450', body: '#e0c89a', door: '#3a3a44', trim: '#fff3e0' },
      { roof: '#8c5a9e', body: '#e6d2e0', door: '#e0a85a', trim: '#fff3e0' },
      { roof: '#e0a85a', body: '#f0e6c0', door: '#3a6ad0', trim: '#fff3e0' }
    ];
    var HAZARDS_ROSTER = [
      { id: 'parked-car', w: 64, h: 30, rU: 30, rV: 0.55, moving: false, weight: 4, art: { shape: 'car', fill: '#c0473e', accent: '#f0e6c0', glass: '#9fd0f0', outline: OUTLINE } },
      { id: 'hydrant', w: 18, h: 26, rU: 12, rV: 0.30, moving: false, weight: 3, art: { shape: 'hydrant', fill: '#e04a4a', accent: '#f0a0a0', outline: OUTLINE } },
      { id: 'trash-can', w: 22, h: 28, rU: 13, rV: 0.32, moving: false, weight: 3, art: { shape: 'trash', fill: '#5aa0d8', accent: '#9fd0f0', outline: OUTLINE } },
      { id: 'pothole', w: 30, h: 10, rU: 16, rV: 0.40, moving: false, weight: 3, art: { shape: 'pothole', fill: '#2b2b38', accent: '#4a4a5a', outline: OUTLINE } },
      { id: 'dog', w: 26, h: 20, rU: 14, rV: 0.34, moving: true, weight: 3, art: { shape: 'dog', fill: '#e0a85a', accent: '#fff3e0', outline: OUTLINE } },
      { id: 'pedestrian', w: 22, h: 40, rU: 12, rV: 0.32, moving: true, weight: 2, art: { shape: 'pedestrian', fill: '#3a6ad0', accent: '#e6cf9a', outline: OUTLINE } }
    ];
    function pickHazard(rng) {
      var total = 0, i;
      for (i = 0; i < HAZARDS_ROSTER.length; i++) total += HAZARDS_ROSTER[i].weight;
      var r = rng() * total;
      for (i = 0; i < HAZARDS_ROSTER.length; i++) { r -= HAZARDS_ROSTER[i].weight; if (r <= 0) return HAZARDS_ROSTER[i]; }
      return HAZARDS_ROSTER[HAZARDS_ROSTER.length - 1];
    }
    function makePorch(house) { return { u: house.u + PORCH_LEAD, v: PORCH_V, delivered: false, house: house }; }
    function estimateRemainingSlots(slot) { return slot < N_CUSTOMERS * 2 ? Infinity : 0; }
    function generate(seed) {
      var rng = Core.makeRng(seed == null ? 1 : seed);
      var houses = [], customers = [], artIdx = 0, slot = 0, u = START_U;
      while (customers.length < N_CUSTOMERS) {
        var lu = u + (rng() * 2 - 1) * HOUSE_JITTER;
        var isCustomer = customers.length < N_CUSTOMERS &&
          (rng() < CUSTOMER_RATIO || (N_CUSTOMERS - customers.length) >= estimateRemainingSlots(slot));
        var left = { kind: 'house', id: 'house-L' + slot, u: lu, v: LEFT_CURB_V, side: 'left', customer: !!isCustomer, art: HOUSE_ART[artIdx++ % HOUSE_ART.length] };
        if (left.customer) { left.porch = makePorch(left); customers.push(left); }
        houses.push(left);
        var ru = u + (rng() * 2 - 1) * HOUSE_JITTER;
        var right = { kind: 'house', id: 'house-R' + slot, u: ru, v: RIGHT_CURB_V, side: 'right', customer: false, art: HOUSE_ART[artIdx++ % HOUSE_ART.length] };
        houses.push(right);
        slot += 1; u += HOUSE_SPACING;
      }
      var routeU = u + END_PAD;
      var hazards = [], hu = FIRST_HAZARD_U;
      while (hu < routeU - END_PAD * 0.5) {
        var ref = pickHazard(rng);
        var lane = Core.V_MIN + 0.3 + rng() * (Core.V_MAX - Core.V_MIN - 0.6);
        hazards.push({ kind: 'hazard', id: ref.id, u: hu, v: lane, w: ref.w, h: ref.h, rU: ref.rU, rV: ref.rV, moving: ref.moving, art: ref.art });
        hu += MIN_HAZARD_GAP + rng() * HAZARD_GAP_JITTER;
      }
      var porchTargets = [];
      for (var c = 0; c < customers.length; c++) porchTargets.push(customers[c].porch);
      return { seed: seed == null ? 1 : seed, routeU: routeU, houses: houses, customers: customers, hazards: hazards, porchTargets: porchTargets, total: customers.length };
    }
    function hazardHits(hazard, scooterU, scooterV) {
      return Math.abs(hazard.u - scooterU) <= hazard.rU && Math.abs(hazard.v - scooterV) <= hazard.rV;
    }
    function countDelivered(route) {
      var n = 0;
      for (var i = 0; i < route.customers.length; i++) if (route.customers[i].porch.delivered) n += 1;
      return n;
    }
    return {
      HOUSE_ART: HOUSE_ART, HAZARDS_ROSTER: HAZARDS_ROSTER, PORCH_V: PORCH_V, PORCH_LEAD: PORCH_LEAD,
      LEFT_CURB_V: LEFT_CURB_V, RIGHT_CURB_V: RIGHT_CURB_V,
      generate: generate, makePorch: makePorch, hazardHits: hazardHits, countDelivered: countDelivered
    };
  }

  // Consume the real logic globals (dual-alias, load-order safe). Fall back to
  // the inline seam-mirrors only when they have not loaded.
  var Core = root.BudCore || root.BCCore || buildFallbackCore();
  var Route = root.BudRoute || root.BCRoute || buildFallbackRoute(Core);

  // ── Canvas layout + palette ───────────────────────────────────────────
  var W = 540, H = 720;
  var INK = '#1d1d28';

  // Play a named sound if the SFX kit is present (guarded for headless tests).
  function sfx(name) {
    try {
      var S = self.SFX;
      if (S && typeof S[name] === 'function') S[name]();
    } catch (e) { /* audio is best-effort */ }
  }
  var OUTLINE = 3;

  // Cel-cartoon palette (Scooby-Doo × Bob's-Burgers: warm, muted, flat).
  var PAL = {
    skyTop: '#3a5b8c',
    skyBottom: '#e8b27a',
    roadFill: '#7a7488',
    curb: '#c9c2b0',
    laneDash: '#f2ecd8',
    sidewalk: '#b6ad94',
    grass: '#6f9a52',
    roofDefault: '#8c4a3a',
    porch: '#caa86a',
    matRing: '#e0c84a',
    matCenter: '#e04a4a',
    flag: '#5fae3e',
    delivered: '#7fce5a',
    scooter: '#d94f4f',
    scooterDark: '#a83838',
    courierSkin: '#e6b88a',
    courierShirt: '#3a8a6a',
    helmet: '#e0c84a',
    pkg: '#caa86a',
    pkgTape: '#8c6a3a',
    shadow: '#2a2233',
    spark: '#ffe27a',
    tumble: '#e8d8b8'
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function normKey(k) {
    if (!k) return '';
    if (k === ' ' || k === 'Spacebar' || k === 'Space') return ' ';
    return k.toLowerCase();
  }
  function isTossKey(k) { return k === ' ' || k === 'arrowup' || k === 'w'; }

  // ── Cel-cartoon primitives ───────────────────────────────────────────
  function celBox(ctx, x, y, w, h, fill, r) {
    r = r == null ? 8 : r;
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = OUTLINE;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
  function celCircle(ctx, x, y, r, fill) {
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = OUTLINE;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
  function softShadow(ctx, sx, sy, r, h) {
    ctx.save();
    ctx.globalAlpha = clamp(0.36 - h * 0.0018, 0.1, 0.36);
    ctx.fillStyle = PAL.shadow;
    ctx.translate(sx, sy);
    ctx.scale(1, 0.42);
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(3, r), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  function dot(ctx, x, y, r) {
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // ════════════════════════════════════════════════════════════════════
  //  GAME
  // ════════════════════════════════════════════════════════════════════
  function Game(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.screen = 'title';
    this.keys = {};
    this.now = 0;
    this.paused = false;
    this.crashMsg = '';
    this._seed = null;
    this.dragSteer = 0;
    this._tossLatch = false;
    this.storage = null;
    try { this.storage = root.localStorage || null; } catch (e) { this.storage = null; }
    this.best = this.loadBest();
    this.reset(1);
  }

  Game.prototype.loadBest = function () {
    var score = 0, deliveries = 0;
    try {
      if (this.storage) {
        score = parseInt(this.storage.getItem(Core.BEST_KEYS.score), 10) || 0;
        deliveries = parseInt(this.storage.getItem(Core.BEST_KEYS.deliveries), 10) || 0;
      }
    } catch (e) {}
    return { score: score, deliveries: deliveries };
  };
  Game.prototype.saveBest = function (best) {
    try {
      if (this.storage) {
        this.storage.setItem(Core.BEST_KEYS.score, String(Math.round(best.score)));
        this.storage.setItem(Core.BEST_KEYS.deliveries, String(Math.round(best.deliveries)));
      }
    } catch (e) {}
  };

  // Build a fresh ride. seed keeps the route deterministic for tests.
  Game.prototype.reset = function (seed) {
    var s = seed || this._seed || ((Date.now() % 100000) + 1);
    this.scooter = new Core.Scooter({});
    this.score = new Core.ScoreKeeper();
    this.route = Route.generate(s);
    this.packages = [];        // live Core.Toss packages (road-space)
    this.particles = [];       // delivery sparkles + crash tumble
    this.floaters = [];        // +pts / ✓ pop text (road-space anchored)
    this.shareCardData = null;
    this._endButtons = null;
    this.finished = false;
    this.runTime = 0;
    this._tossLatch = false;
  };

  // ── Input ───────────────────────────────────────────────────────────
  Game.prototype.onKeyDown = function (k, repeat) {
    var key = normKey(k);
    if (key === '') return;
    if (!repeat) {
      if (key === 'enter') { this.advance(); return; }
      if (key === 'r' && this.screen !== 'title') { this.restart(); return; }
      if (this.screen === 'play' && key === 'p') { this.togglePause(); return; }
      if (this.screen === 'title' && (isTossKey(key) || key === 'enter')) { this.advance(); return; }
    }
    this.keys[key] = true;
  };
  Game.prototype.onKeyUp = function (k) {
    var key = normKey(k);
    if (key) this.keys[key] = false;
  };
  Game.prototype.clearKeys = function () {
    this.keys = {};
    this.dragSteer = 0;
    if (this.screen === 'play' && !this.paused) this.togglePause();
  };

  // Per-frame input the core consumes: { steer:-1|0|1, toss }.
  Game.prototype.readInput = function () {
    var left = !!(this.keys['arrowleft'] || this.keys['a']);
    var right = !!(this.keys['arrowright'] || this.keys['d']);
    var steer = (right ? 1 : 0) - (left ? 1 : 0);
    if (steer === 0 && this.dragSteer !== 0) steer = this.dragSteer < 0 ? -1 : 1;
    var toss = !!(this.keys[' '] || this.keys['arrowup'] || this.keys['w']);
    return { steer: clamp(steer, -1, 1), toss: toss };
  };

  Game.prototype.advance = function () {
    if (this.screen === 'title') {
      this.reset(this._seed || ((Date.now() % 100000) + 1));
      this.screen = 'play';
      this.paused = false;
      this.keys = {};
    } else if (this.screen === 'score') {
      this.screen = 'title';
    } else if (this.screen === 'crash') {
      this.crashMsg = '';
      this.screen = 'title';
    }
  };
  Game.prototype.restart = function () {
    this.reset((Date.now() % 100000) + 1);
    this.screen = 'play';
    this.paused = false;
    this.keys = {};
  };
  Game.prototype.togglePause = function () { this.paused = !this.paused; };

  // ── Per-frame update ──────────────────────────────────────────────────
  Game.prototype.update = function (dt) {
    this.now += dt;
    this.tickParticles(dt);
    this.tickFloaters(dt);

    if (this.screen !== 'play' || this.paused) return;

    this.runTime += dt;
    var input = this.readInput();

    // TOSS on a fresh press (edge-detect in the shell; the core has no
    // cooldown). An empty/missed toss costs nothing and never breaks combo.
    if (input.toss && !this._tossLatch && this.scooter.tumble <= 0) {
      var pkg = new Core.Toss(this.scooter);
      this.packages.push(pkg);
      this.spawnTossPuff(this.scooter.u, this.scooter.v);
      sfx('toss');
    }
    this._tossLatch = input.toss;

    // Core owns the scooter physics (auto-forward u, steer v, lean, tumble).
    this.scooter.update(dt, input);

    // The tip combo decays ONLY while customer houses are on screen (the
    // contract rule). The shell gates the core's pure-clock tick accordingly.
    if (this.customersOnScreen()) this.score.tick(dt);

    // Step every live package; score landings against the porch targets.
    var livePkgs = [];
    for (var i = 0; i < this.packages.length; i++) {
      var p = this.packages[i];
      p.update(dt);
      if (p.landed && !p._resolved) {
        p._resolved = true;
        var result = Core.scoreLanding(p, this.route.porchTargets);
        if (result) {
          var pts = this.score.deliver(result);
          var porch = result.house.porch || result.house;   // porch target point
          this.spawnDelivery(porch.u, porch.v, pts, result.ring === 'bullseye');
          sfx(result.ring === 'bullseye' ? 'bullseye' : 'deliver');
        } else {
          this.spawnTossPuff(p.u, p.v);   // a miss: a small puff, no penalty
        }
      }
      if (!p.landed) livePkgs.push(p);
      else {
        p._linger = (p._linger || 0) + dt;
        if (p._linger < 0.2) livePkgs.push(p);
      }
    }
    this.packages = livePkgs;

    // Hazards: a collision in the rideable lanes costs a life + a tumble.
    var hz = this.route.hazards;
    for (var j = 0; j < hz.length; j++) {
      var hazard = hz[j];
      if (hazard._cleared) continue;
      if (hazard.u < this.scooter.u - 240) { hazard._cleared = true; continue; }
      if (Route.hazardHits(hazard, this.scooter.u, this.scooter.v)) {
        if (this.scooter.hit()) {
          this.spawnTumble(this.scooter.u, this.scooter.v);
          sfx('thud');
          if (this.scooter.isDead()) { this.endRun(); return; }
        }
      }
    }

    // Reached the end of the route → results card.
    if (!this.finished && this.scooter.u >= this.route.routeU) {
      this.finished = true;
      this.endRun();
    }
  };

  // True if any UNDELIVERED customer porch sits within the visible road window.
  Game.prototype.customersOnScreen = function () {
    var lo = this.scooter.u - 120, hi = this.scooter.u + 900;
    var cs = this.route.customers;
    for (var i = 0; i < cs.length; i++) {
      var h = cs[i];
      if (h.porch && !h.porch.delivered && h.u >= lo && h.u <= hi) return true;
    }
    return false;
  };

  Game.prototype.endRun = function () {
    if (this.screen === 'score') return;
    var result = { score: this.score.score, deliveries: this.score.deliveries };
    var updated = Core.updateBest(result, this.best);
    this.shareCardData = {
      score: this.score.score,
      deliveries: this.score.deliveries,
      total: this.route.total,
      bestCombo: this.score.bestCombo,
      distance: this.scooter.u,
      isBest: updated.newBestScore || updated.newBestDeliveries
    };
    this.best = { score: updated.score, deliveries: updated.deliveries };
    this.saveBest(this.best);
    this.screen = 'score';
  };

  // ── Particles / floaters ──────────────────────────────────────────────
  Game.prototype.spawnDelivery = function (u, v, pts, bullseye) {
    var s = Core.project(u, v, 0, this.camU());
    for (var i = 0; i < 12; i++) {
      var ang = (i / 12) * Math.PI * 2;
      this.particles.push({
        x: s.x, y: s.y,
        vx: Math.cos(ang) * (50 + (i % 4) * 24),
        vy: Math.sin(ang) * (50 + (i % 4) * 24) - 40,
        age: 0, life: 0.55 + (i % 3) * 0.1,
        r: 3 + (i % 3), color: bullseye ? PAL.matCenter : PAL.spark, spark: true
      });
    }
    this.floaters.push({ u: u, v: v, h: 30, text: (bullseye ? '✓ BULLSEYE +' : '✓ +') + pts, age: 0, life: 1.0, color: PAL.delivered });
  };
  Game.prototype.spawnTossPuff = function (u, v) {
    var s = Core.project(u, v, 0, this.camU());
    for (var i = 0; i < 5; i++) {
      var ang = (i / 5) * Math.PI * 2;
      this.particles.push({
        x: s.x, y: s.y,
        vx: Math.cos(ang) * 30, vy: Math.sin(ang) * 30 - 20,
        age: 0, life: 0.35, r: 2 + (i % 2), color: PAL.curb, spark: false
      });
    }
  };
  Game.prototype.spawnTumble = function (u, v) {
    var s = Core.project(u, v, 6, this.camU());
    for (var i = 0; i < 16; i++) {
      var ang = (i / 16) * Math.PI * 2;
      this.particles.push({
        x: s.x, y: s.y,
        vx: Math.cos(ang) * (60 + (i % 5) * 28),
        vy: Math.sin(ang) * (60 + (i % 4) * 30) - 90,
        age: 0, life: 0.6 + (i % 4) * 0.12,
        r: 4 + (i % 4), color: i % 2 ? PAL.tumble : PAL.pkg, spark: false
      });
    }
    this.floaters.push({ u: u, v: v, h: 40, text: '▼', age: 0, life: 0.9, color: PAL.scooter });
  };
  Game.prototype.tickParticles = function (dt) {
    var live = [];
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      p.age += dt; p.vy += 240 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.age < p.life) live.push(p);
    }
    this.particles = live;
  };
  Game.prototype.tickFloaters = function (dt) {
    var live = [];
    for (var i = 0; i < this.floaters.length; i++) {
      var f = this.floaters[i];
      f.age += dt; f.h += 26 * dt;
      if (f.age < f.life) live.push(f);
    }
    this.floaters = live;
  };

  // ── Camera (the projection seam: camU = scooter.u - CAM_BACK) ─────────
  Game.prototype.camU = function () {
    return this.scooter.camU ? this.scooter.camU() : (this.scooter.u - Core.CAM_BACK);
  };

  // ── Share text + card (clipboard + PNG) ──────────────────────────────
  Game.prototype.shareResult = function () {
    return this.shareCardData || {
      score: this.score.score, deliveries: this.score.deliveries,
      total: this.route.total, bestCombo: this.score.bestCombo
    };
  };
  Game.prototype.shareText = function () { return Core.shareText(this.shareResult()); };
  Game.prototype.copyResult = function () {
    var txt = this.shareText();
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      try { root.navigator.clipboard.writeText(txt); } catch (e) {}
    }
    return txt;
  };
  Game.prototype.saveCard = function () {
    var doc = root.document;
    var c = doc && doc.createElement ? doc.createElement('canvas') : null;
    if (!c || !c.getContext) return false;
    c.width = 600; c.height = 600;
    var x = c.getContext('2d');
    this.paintShareCard(x, c.width, c.height);
    if (!c.toBlob) return false;
    c.toBlob(function (blob) {
      if (!blob || !root.URL || !root.URL.createObjectURL) return;
      var url = root.URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url; a.download = 'budshop-courier.png';
      if (doc.body) doc.body.appendChild(a);
      if (a.click) a.click();
      if (a.remove) a.remove();
      if (root.URL.revokeObjectURL) root.URL.revokeObjectURL(url);
    });
    return true;
  };
  Game.prototype.paintShareCard = function (ctx, w, h) {
    var d = this.shareResult();
    ctx.fillStyle = '#15110e'; ctx.fillRect(0, 0, w, h);
    celBox(ctx, 24, 24, w - 48, h - 48, '#23314a', 18);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#9ad8c4';
    ctx.font = 'bold 36px ui-monospace, monospace';
    ctx.fillText('📦 BUDSHOP COURIER', w / 2, 104);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 70px ui-monospace, monospace';
    ctx.fillText(Math.round(d.score) + '', w / 2, 224);
    ctx.fillStyle = '#caa86a';
    ctx.font = '20px ui-monospace, monospace';
    ctx.fillText('POINTS · ' + Core.rankForScore(Math.round(d.score)).name, w / 2, 256);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px ui-monospace, monospace';
    ctx.fillText('🚪 ' + d.deliveries + (d.total != null ? '/' + d.total : '') + ' delivered', w / 2, 330);
    ctx.fillStyle = '#e0a050';
    ctx.font = 'bold 26px ui-monospace, monospace';
    ctx.fillText('💸 best tip ×' + Math.max(1, d.bestCombo || 1), w / 2, 384);
    var bar = this.shareText().split('\n').pop();
    ctx.fillStyle = '#d8c8a8';
    ctx.font = '17px ui-monospace, monospace';
    ctx.fillText(bar, w / 2, 500);
    ctx.textAlign = 'left';
  };

  // ════════════════════════════════════════════════════════════════════
  //  RENDER — diagonal road-space, depth-sorted FAR→NEAR (DESCENDING u)
  // ════════════════════════════════════════════════════════════════════
  Game.prototype.draw = function () {
    var ctx = this.ctx;
    ctx.save();
    this.drawSky(ctx);

    if (this.screen === 'crash') { this.drawCrash(ctx); ctx.restore(); return; }

    this.drawRoad(ctx);
    this.drawScene(ctx);
    this.drawParticles(ctx);
    this.drawFloaters(ctx);
    this.drawHUD(ctx);

    if (this.screen === 'title') this.drawTitle(ctx);
    if (this.paused) this.drawPause(ctx);
    if (this.screen === 'score') this.drawScoreCard(ctx);
    ctx.restore();
  };

  Game.prototype.drawSky = function (ctx) {
    var g = ctx.createLinearGradient(0, 0, 0, H * 0.6);
    g.addColorStop(0, PAL.skyTop);
    g.addColorStop(1, PAL.skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = '#ffe8b0';
    ctx.beginPath(); ctx.arc(W * 0.7, H * 0.16, 46, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };

  // The road + shoulders + lane dashes, all as quads in road-space.
  Game.prototype.drawRoad = function (ctx) {
    var camU = this.camU();
    var lo = this.scooter.u - 120;
    var hi = this.scooter.u + 1000;
    var vMin = Core.V_MIN, vMax = Core.V_MAX;

    // Grass shoulders (wide, behind both curbs) + sidewalks.
    this.roadQuad(ctx, lo, hi, vMin - 3.6, vMin - 0.35, PAL.grass, camU);
    this.roadQuad(ctx, lo, hi, vMax + 0.35, vMax + 3.6, PAL.grass, camU);
    this.roadQuad(ctx, lo, hi, vMin - 0.55, vMin - 0.2, PAL.sidewalk, camU);
    this.roadQuad(ctx, lo, hi, vMax + 0.2, vMax + 0.55, PAL.sidewalk, camU);

    // Roadbed + curbs.
    this.roadQuad(ctx, lo, hi, vMin - 0.18, vMax + 0.18, PAL.roadFill, camU);
    this.roadQuad(ctx, lo, hi, vMin - 0.22, vMin - 0.1, PAL.curb, camU);
    this.roadQuad(ctx, lo, hi, vMax + 0.1, vMax + 0.22, PAL.curb, camU);

    // Lane dashes.
    ctx.save();
    ctx.strokeStyle = PAL.laneDash;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.7;
    var dashU = Math.floor(lo / 90) * 90;
    for (var u = dashU; u < hi; u += 90) {
      for (var lane = Math.ceil(vMin) + 1; lane < vMax; lane++) {
        var d0 = Core.project(u, lane, 0, camU);
        var d1 = Core.project(u + 40, lane, 0, camU);
        ctx.beginPath(); ctx.moveTo(d0.x, d0.y); ctx.lineTo(d1.x, d1.y); ctx.stroke();
      }
    }
    ctx.restore();
  };

  Game.prototype.roadQuad = function (ctx, u0, u1, v0, v1, color, camU) {
    var a = Core.project(u0, v0, 0, camU), b = Core.project(u1, v0, 0, camU);
    var c = Core.project(u1, v1, 0, camU), d = Core.project(u0, v1, 0, camU);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
    ctx.closePath(); ctx.fill();
  };

  // ONE depth-sorted draw list so everything renders FAR→NEAR (DESCENDING u).
  Game.prototype.drawScene = function (ctx) {
    var camU = this.camU();
    var lo = this.scooter.u - 200, hi = this.scooter.u + 1000;
    var items = [];
    var i;

    for (i = 0; i < this.route.houses.length; i++) {
      var hh = this.route.houses[i];
      if (hh.u < lo || hh.u > hi) continue;
      items.push({ sort: hh.u, kind: 'house', ref: hh });
    }
    for (i = 0; i < this.route.hazards.length; i++) {
      var hz = this.route.hazards[i];
      if (hz._cleared || hz.u < lo || hz.u > hi) continue;
      items.push({ sort: hz.u, kind: 'hazard', ref: hz });
    }
    for (i = 0; i < this.packages.length; i++) {
      items.push({ sort: this.packages[i].u, kind: 'pkg', ref: this.packages[i] });
    }
    items.push({ sort: this.scooter.u, kind: 'scooter', ref: this.scooter });

    items.sort(function (a, b) { return b.sort - a.sort; });   // FAR (larger u) first

    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind === 'house') this.drawHouse(ctx, it.ref, camU);
      else if (it.kind === 'hazard') this.drawHazard(ctx, it.ref, camU);
      else if (it.kind === 'pkg') this.drawPackage(ctx, it.ref, camU);
      else if (it.kind === 'scooter') this.drawScooter(ctx, it.ref, camU);
    }
  };

  // A house on a curb (its body lane is hh.v). Customers carry a porch target
  // at hh.porch (v = PORCH_V on the left curb) — the mat the toss lands on.
  Game.prototype.drawHouse = function (ctx, hh, camU) {
    var s = Core.project(hh.u, hh.v, 0, camU);
    var art = hh.art || {};
    var body = art.body || '#d9a066';
    var roof = art.roof || PAL.roofDefault;
    var door = art.door || PAL.pkgTape;

    celBox(ctx, s.x - 34, s.y - 58, 68, 58, body, 5);
    ctx.fillStyle = roof;
    ctx.beginPath();
    ctx.moveTo(s.x - 40, s.y - 56); ctx.lineTo(s.x, s.y - 86); ctx.lineTo(s.x + 40, s.y - 56);
    ctx.closePath(); ctx.fill();
    ctx.lineWidth = OUTLINE; ctx.strokeStyle = INK; ctx.stroke();
    celBox(ctx, s.x - 10, s.y - 34, 20, 34, door, 3);
    // A lit window for customers.
    if (hh.customer) {
      ctx.fillStyle = art.trim || '#fff3e0';
      ctx.fillRect(s.x + 14, s.y - 48, 12, 12);
      ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.strokeRect(s.x + 14, s.y - 48, 12, 12);
    }

    // Customer porch target (the mat the core scores against).
    if (hh.customer && hh.porch) {
      var pr = Core.project(hh.porch.u, hh.porch.v, 0, camU);
      ctx.save();
      ctx.fillStyle = PAL.porch; ctx.globalAlpha = 0.92;
      ctx.beginPath(); ctx.ellipse(pr.x, pr.y, 30, 16, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (!hh.porch.delivered) {
        // Flag pole + flag so customers read at a glance.
        ctx.strokeStyle = INK; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(s.x - 30, s.y - 78); ctx.lineTo(s.x - 30, s.y - 52); ctx.stroke();
        ctx.save();
        ctx.globalAlpha = 0.65 + 0.3 * Math.sin(this.now * 4 + hh.u);
        ctx.fillStyle = PAL.flag;
        ctx.fillRect(s.x - 30, s.y - 78, 16, 11);
        ctx.restore();
        // Mat rings (the delivery target).
        ctx.save();
        ctx.lineWidth = 3; ctx.strokeStyle = PAL.matRing; ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.ellipse(pr.x, pr.y, 22, 11, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = PAL.matCenter;
        ctx.beginPath(); ctx.ellipse(pr.x, pr.y, 7, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = PAL.delivered;
        ctx.font = 'bold 22px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('✓', pr.x, pr.y + 6);
        ctx.textAlign = 'left';
      }
    }
  };

  Game.prototype.drawHazard = function (ctx, hz, camU) {
    var s = Core.project(hz.u, hz.v, 0, camU);
    var art = hz.art || {};
    var shape = art.shape || hz.id;
    var fill = art.fill || '#9a9aa6';
    softShadow(ctx, s.x, s.y + 2, 12, 0);
    switch (shape) {
      case 'car':
        celBox(ctx, s.x - 22, s.y - 20, 44, 20, fill, 6);
        celBox(ctx, s.x - 13, s.y - 30, 26, 12, art.glass || '#cdd8ec', 4);
        celCircle(ctx, s.x - 13, s.y, 5, '#222');
        celCircle(ctx, s.x + 13, s.y, 5, '#222');
        break;
      case 'hydrant':
        celBox(ctx, s.x - 7, s.y - 20, 14, 20, fill, 4);
        celCircle(ctx, s.x, s.y - 22, 7, fill);
        break;
      case 'trash':
        celBox(ctx, s.x - 10, s.y - 22, 20, 22, fill, 4);
        ctx.fillStyle = art.accent || '#5a5a64'; ctx.fillRect(s.x - 12, s.y - 26, 24, 5);
        break;
      case 'dog':
        celBox(ctx, s.x - 12, s.y - 12, 24, 12, fill, 6);
        celCircle(ctx, s.x + 12, s.y - 14, 7, fill);
        ctx.fillStyle = INK; ctx.fillRect(s.x - 12, s.y, 3, 6); ctx.fillRect(s.x + 9, s.y, 3, 6);
        break;
      case 'pedestrian':
        celBox(ctx, s.x - 7, s.y - 26, 14, 22, fill, 5);
        celCircle(ctx, s.x, s.y - 32, 7, art.accent || PAL.courierSkin);
        break;
      default: // pothole
        ctx.fillStyle = fill;
        ctx.beginPath(); ctx.ellipse(s.x, s.y, 18, 9, 0, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = '#15131a'; ctx.stroke();
        break;
    }
  };

  // A thrown package: soft ground shadow at the true (u, v, 0); parcel at h.
  Game.prototype.drawPackage = function (ctx, p, camU) {
    var sh = Core.project(p.u, p.v, 0, camU);
    softShadow(ctx, sh.x, sh.y, 7, p.h);
    if (p.landed) return;
    var s = Core.project(p.u, p.v, p.h, camU);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate((this.now * 8) % (Math.PI * 2));
    celBox(ctx, -7, -6, 14, 12, PAL.pkg, 3);
    ctx.strokeStyle = PAL.pkgTape; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(0, 6); ctx.stroke();
    ctx.restore();
  };

  // The scooter + courier, leaning with the steer. Shadow at the true road pt.
  Game.prototype.drawScooter = function (ctx, sc, camU) {
    var s = Core.project(sc.u, sc.v, 0, camU);
    softShadow(ctx, s.x, s.y, 16, 0);
    var blink = sc.invuln > 0 && (Math.floor(this.now * 12) % 2 === 0);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate((sc.lean || 0) * 0.18);
    if (blink) ctx.globalAlpha = 0.4;
    celBox(ctx, -18, -16, 36, 14, PAL.scooter, 7);
    celCircle(ctx, -12, 0, 6, '#2a2a32');
    celCircle(ctx, 14, 0, 6, '#2a2a32');
    celBox(ctx, 10, -28, 5, 16, PAL.scooterDark, 2);
    celBox(ctx, -8, -38, 18, 24, PAL.courierShirt, 6);
    celCircle(ctx, 1, -46, 9, PAL.courierSkin);
    ctx.fillStyle = PAL.helmet;
    ctx.beginPath(); ctx.arc(1, -48, 9, Math.PI, 0); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.stroke();
    dot(ctx, 5, -46, 2);
    celBox(ctx, -16, -34, 12, 12, PAL.pkg, 3);   // satchel of packages
    ctx.restore();
  };

  Game.prototype.drawParticles = function (ctx) {
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      var a = clamp(1 - p.age / p.life, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      if (p.spark) { ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      ctx.globalAlpha = 1;
    }
  };

  Game.prototype.drawFloaters = function (ctx) {
    var camU = this.camU();
    for (var i = 0; i < this.floaters.length; i++) {
      var f = this.floaters[i];
      var s = Core.project(f.u, f.v, f.h, camU);
      ctx.globalAlpha = clamp(1 - f.age / f.life, 0, 1);
      ctx.fillStyle = f.color;
      ctx.font = 'bold 16px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(f.text, s.x, s.y);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
  };

  // ── HUD: deliveries N/total, score, tip combo, lives, distance ────────
  Game.prototype.drawHUD = function (ctx) {
    ctx.fillStyle = INK;
    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('🚪 ' + this.score.deliveries + '/' + this.route.total, 14, 28);
    ctx.fillText(Math.round(this.scooter.u / 10) + 'm', 14, 50);

    ctx.textAlign = 'right';
    ctx.fillText(Math.round(this.score.score) + ' pts', W - 14, 28);
    var lifeStr = '';
    for (var i = 0; i < Math.max(0, this.scooter.lives); i++) lifeStr += '▮';
    ctx.fillStyle = PAL.scooter;
    ctx.fillText(lifeStr || '—', W - 14, 50);

    var mult = Core.comboMultiplier(this.score.combo);
    if (mult > 1) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#caa040';
      ctx.font = 'bold 22px ui-monospace, monospace';
      ctx.fillText('TIP ×' + mult, W / 2, 28);
      var frac = clamp(this.score.window / Core.COMBO_WINDOW, 0, 1);
      ctx.fillStyle = 'rgba(202,160,64,0.25)';
      ctx.fillRect(W / 2 - 50, 36, 100, 6);
      ctx.fillStyle = '#caa040';
      ctx.fillRect(W / 2 - 50, 36, 100 * frac, 6);
    }

    var prog = clamp(this.scooter.u / this.route.routeU, 0, 1);
    ctx.fillStyle = 'rgba(29,29,40,0.35)';
    ctx.fillRect(14, H - 16, W - 28, 6);
    ctx.fillStyle = PAL.delivered;
    ctx.fillRect(14, H - 16, (W - 28) * prog, 6);
    ctx.textAlign = 'left';
  };

  // ── Screens ─────────────────────────────────────────────────────────
  Game.prototype.drawTitle = function (ctx) {
    ctx.fillStyle = 'rgba(12,10,8,0.42)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#9ad8c4';
    ctx.font = 'bold 44px ui-monospace, monospace';
    ctx.fillText('BUDSHOP', W / 2, H / 2 - 60);
    ctx.fillText('COURIER', W / 2, H / 2 - 14);
    ctx.fillStyle = '#fff';
    ctx.font = '15px ui-monospace, monospace';
    ctx.fillText('STEER ← → · TOSS onto the porch 📦', W / 2, H / 2 + 28);
    ctx.fillStyle = '#e0c84a';
    ctx.font = 'bold 20px ui-monospace, monospace';
    ctx.fillText('press SPACE / tap to ride', W / 2, H / 2 + 70);
    if (this.best.score > 0) {
      ctx.fillStyle = '#d8c8a8';
      ctx.font = '14px ui-monospace, monospace';
      ctx.fillText('best ' + Math.round(this.best.score) + ' pts · ' + this.best.deliveries + ' delivered', W / 2, H / 2 + 104);
    }
    ctx.textAlign = 'left';
  };

  Game.prototype.drawPause = function (ctx) {
    ctx.fillStyle = 'rgba(12,10,8,0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 38px ui-monospace, monospace';
    ctx.fillText('PAUSED', W / 2, H / 2);
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillText('P resume · R restart', W / 2, H / 2 + 30);
    ctx.textAlign = 'left';
  };

  Game.prototype.drawScoreCard = function (ctx) {
    ctx.fillStyle = 'rgba(12,10,8,0.8)';
    ctx.fillRect(0, 0, W, H);
    var cw = 420, ch = 380, cx = (W - cw) / 2, cy = (H - ch) / 2;
    celBox(ctx, cx, cy, cw, ch, '#23314a', 16);
    ctx.textAlign = 'center';
    var d = this.shareResult();
    ctx.fillStyle = '#9ad8c4';
    ctx.font = 'bold 26px ui-monospace, monospace';
    ctx.fillText(this.shareCardData && this.shareCardData.isBest ? '🏆 NEW BEST!' : 'ROUTE DONE', W / 2, cy + 44);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 50px ui-monospace, monospace';
    ctx.fillText(Math.round(d.score) + '', W / 2, cy + 104);
    ctx.fillStyle = '#caa86a';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText('POINTS · ' + Core.rankForScore(Math.round(d.score)).name, W / 2, cy + 124);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.fillText('🚪 ' + d.deliveries + (d.total != null ? '/' + d.total : '') + '   💸 ×' + Math.max(1, d.bestCombo || 1), W / 2, cy + 162);

    this._endButtons = [
      { id: 'copy', label: 'COPY 📋', x: cx + 30, y: cy + 190, w: cw - 60, h: 42, color: '#2a7fa7' },
      { id: 'save', label: 'SAVE PNG 🖼', x: cx + 30, y: cy + 242, w: cw - 60, h: 42, color: '#5fae3e' }
    ];
    for (var b = 0; b < this._endButtons.length; b++) {
      var bt = this._endButtons[b];
      celBox(ctx, bt.x, bt.y, bt.w, bt.h, bt.color, 10);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px ui-monospace, monospace';
      ctx.fillText(bt.label, bt.x + bt.w / 2, bt.y + 27);
    }
    ctx.fillStyle = '#d8c8a8';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText('tap / R to ride again · ENTER for title', W / 2, cy + ch - 16);
    ctx.textAlign = 'left';
  };

  Game.prototype.drawCrash = function (ctx) {
    ctx.fillStyle = '#15110e';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e08a6a';
    ctx.font = 'bold 24px ui-monospace, monospace';
    ctx.fillText('COURIER CRASHED', W / 2, H / 2 - 16);
    ctx.fillStyle = '#d8c8a8';
    ctx.font = '13px ui-monospace, monospace';
    ctx.fillText((this.crashMsg || 'unexpected error').slice(0, 60), W / 2, H / 2 + 12);
    ctx.fillStyle = '#e0c84a';
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.fillText('press ENTER to restart', W / 2, H / 2 + 48);
    ctx.textAlign = 'left';
  };

  // ── Pointer / tap routing ─────────────────────────────────────────────
  Game.prototype.handlePoint = function (px, py) {
    if (this.screen === 'play' && !this.paused) { this.tapToss(); return; }
    if (this.screen === 'title') { this.advance(); return; }
    if (this.screen === 'crash') { this.advance(); return; }
    if (this.screen === 'score' && this._endButtons) {
      for (var i = 0; i < this._endButtons.length; i++) {
        var b = this._endButtons[i];
        if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
          if (b.id === 'copy') this.copyResult();
          else if (b.id === 'save') this.saveCard();
          return;
        }
      }
      this.restart();
    }
  };

  Game.prototype.tapToss = function () {
    this.keys[' '] = true;
    var self = this;
    if (root.setTimeout) root.setTimeout(function () { self.keys[' '] = false; }, 90);
  };

  Game.prototype.setDragSteer = function (s) { this.dragSteer = clamp(s || 0, -1, 1); };

  // ── Boot ────────────────────────────────────────────────────────────
  function boot() {
    var doc = root.document;
    var canvas = doc && doc.getElementById ? doc.getElementById('game') : null;
    if (!canvas) return;
    canvas.width = W; canvas.height = H;
    var game = new Game(canvas);

    root.addEventListener('keydown', function (e) {
      var key = e.key;
      if (key === ' ' || (key && key.indexOf('Arrow') === 0)) { if (e.preventDefault) e.preventDefault(); }
      game.onKeyDown(key, e.repeat);
    });
    root.addEventListener('keyup', function (e) { game.onKeyUp(e.key); });
    root.addEventListener('blur', function () { game.clearKeys(); });
    if (doc && doc.addEventListener) {
      doc.addEventListener('visibilitychange', function () { if (doc.hidden) game.clearKeys(); });
    }

    if (canvas.addEventListener) {
      var pointAt = function (clientX, clientY) {
        var r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: W, height: H };
        var scaleX = W / (r.width || W), scaleY = H / (r.height || H);
        game.handlePoint((clientX - r.left) * scaleX, (clientY - r.top) * scaleY);
      };
      canvas.addEventListener('click', function (e) { pointAt(e.clientX, e.clientY); });

      var tsx = 0, tsy = 0, tst = 0, dragging = false;
      canvas.addEventListener('touchstart', function (e) {
        if (e.touches && e.touches[0]) {
          tsx = e.touches[0].clientX; tsy = e.touches[0].clientY;
          tst = (root.Date ? Date.now() : 0); dragging = false;
        }
      }, { passive: true });
      canvas.addEventListener('touchmove', function (e) {
        var t = e.touches && e.touches[0];
        if (!t) return;
        var dx = t.clientX - tsx;
        if (Math.abs(dx) > 18) {
          dragging = true;
          var r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: W };
          game.setDragSteer(clamp(dx / ((r.width || W) * 0.35), -1, 1));
        }
        if (e.preventDefault) e.preventDefault();
      }, { passive: false });
      canvas.addEventListener('touchend', function (e) {
        game.setDragSteer(0);
        var t = e.changedTouches && e.changedTouches[0];
        var dtMs = (root.Date ? Date.now() : 0) - tst;
        if (t && !dragging && dtMs < 400) {
          var r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: W, height: H };
          var scaleX = W / (r.width || W), scaleY = H / (r.height || H);
          game.handlePoint((t.clientX - r.left) * scaleX, (t.clientY - r.top) * scaleY);
        }
        if (e.preventDefault) e.preventDefault();
      }, { passive: false });
    }

    // rAF loop wrapped in try/catch → crash card, never a freeze.
    var last = 0;
    function frame(ts) {
      var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
      last = ts;
      try {
        game.update(dt);
        game.draw();
      } catch (err) {
        game.screen = 'crash';
        game.crashMsg = (err && err.message) ? err.message : String(err);
        try { game.drawCrash(game.ctx); } catch (e2) {}
      }
      root.requestAnimationFrame(frame);
    }
    root.requestAnimationFrame(frame);

    // Test hook (mirrors the Runner's window.__BUDRUN).
    root.__COURIER = {
      getScreen: function () { return game.screen; },
      getGame: function () { return game; },
      seed: function (s) { game._seed = s; },
      Core: Core,
      Route: Route,
      // Plant a customer house with a porch target (mirrors route.js shapes),
      // returning it, for deterministic shell tests. The porch sits at PORCH_V
      // led from the house anchor exactly like the real route generator.
      plantHouse: function (u, customer) {
        var h = {
          kind: 'house', id: 'planted-' + u, u: u, v: Route.LEFT_CURB_V == null ? -1.4 : Route.LEFT_CURB_V,
          side: 'left', customer: customer !== false, art: (Route.HOUSE_ART && Route.HOUSE_ART[0]) || {}
        };
        if (h.customer) {
          h.porch = { u: u + Core.PORCH_LEAD, v: Core.PORCH_V, delivered: false, house: h };
          game.route.customers.push(h);
          game.route.porchTargets.push(h.porch);
          game.route.total = game.route.customers.length;
        }
        game.route.houses.push(h);
        return h;
      },
      // Plant a hazard in the rideable lanes at (u, v) with default extents.
      plantHazard: function (u, v, id) {
        var hz = {
          kind: 'hazard', id: id || 'parked-car', u: u,
          v: v == null ? game.scooter.v : v,
          w: 64, h: 30, rU: 30, rV: 0.55, moving: false,
          art: { shape: 'car', fill: '#c0473e' }
        };
        game.route.hazards.push(hz);
        return hz;
      }
    };
  }

  if (root.addEventListener) root.addEventListener('load', boot);

  if (typeof module === 'object' && module.exports) {
    module.exports = { Game: Game, normKey: normKey, boot: boot, buildFallbackCore: buildFallbackCore, buildFallbackRoute: buildFallbackRoute };
  }
})(typeof self !== 'undefined' ? self : this);
