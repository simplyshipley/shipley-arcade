/*
 * BUDSHOP COURIER — route.js: the SEEDED, deterministic route generator + the
 * house / hazard roster as data. A route is a finite neighborhood block of
 * length ROUTE_U with N customer houses (deliver here) and non-customer houses
 * on BOTH curbs, plus street hazards (parked car, hydrant, trash can, dog,
 * pedestrian, pothole) at FAIR spacing. The shell draws every entity from its
 * road-space (u, v) + art block; the core scores tosses against the porch
 * targets this module attaches to customer houses.
 *
 * Pure logic + data, NO DOM. UMD wrapper (pattern: budshop-runner). Loaded as
 * window.BudRoute in a browser and via require() in Node tests. Depends on the
 * core ONLY for projection constants + the porch geometry (PORCH_V, PORCH_LEAD,
 * expectedLandingLead) so the route's porch targets line up with where the
 * natural toss lands — the two MUST be tuned together.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  ROUTE ENTITY shapes (the shell mirrors these EXACTLY):
 *
 *  HOUSE:
 *    {
 *      kind:     'house'
 *      id:       string  unique slug
 *      u:        number  road-space distance along the route (house anchor)
 *      v:        number  curb lane the house body sits at (side = sign of v)
 *      side:     'left' | 'right'   (left = -LANE / curb side; porches here)
 *      customer: boolean  true = deliver here (lit/flagged); false = skip
 *      art:      { ... }  cel-cartoon flat-fill hints (palette, roof, door)
 *      porch?:   { u, v, delivered:false, house } PRESENT ONLY on customers —
 *                the porch TARGET the core scores tosses against. v === PORCH_V,
 *                u === house.u + PORCH_LEAD. `house` back-references the house.
 *    }
 *
 *  HAZARD:
 *    {
 *      kind:    'hazard'
 *      id:      string   roster id (parked-car, hydrant, trash-can, dog, ...)
 *      u:       number   road-space distance along the route
 *      v:       number   lane the hazard occupies (in the rideable street)
 *      w, h:    number   road-space footprint (collision half-extents via R_U/R_V)
 *      moving:  boolean   dog / pedestrian drift across lanes (shell animates)
 *      art:     { ... }   cel-cartoon flat-fill hints
 *    }
 *
 *  A generated ROUTE:
 *    {
 *      seed:        number
 *      routeU:      number   total length (reach this u → results card)
 *      houses:      House[]  ALL houses (customers + non-customers, both curbs)
 *      customers:   House[]  the customer subset (convenience; same objects)
 *      hazards:     Hazard[] all street hazards, fairly spaced
 *      porchTargets: porch[] the porch targets the core scores against
 *                            (customers[i].porch, same objects)
 *      total:       number   customer count (deliveries denominator)
 *    }
 * ────────────────────────────────────────────────────────────────────────────
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.BudRoute = root.BCRoute = factory(root.BudCore || root.BCCore);
  }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  // ── Route shape (deterministic per seed) ─────────────────────────────────
  var HOUSE_SPACING = 220;     // u between consecutive house slots (per side)
  var HOUSE_JITTER = 70;       // +/- u jitter on a house's slot (seeded)
  var N_CUSTOMERS = 10;        // customer houses on the route (deliver targets)
  var CUSTOMER_RATIO = 0.5;    // fraction of houses that are customers (~half)
  var START_U = 360;           // first house slot (clear runway before deliveries)
  var END_PAD = 360;           // runway after the last house before the finish

  // Porch geometry (mirrors core — the porch sits where the natural toss lands).
  var PORCH_V = Core ? Core.PORCH_V : -0.9;
  var PORCH_LEAD = Core ? Core.PORCH_LEAD : 0;

  // House curb lanes: porches/customers on the LEFT curb (-LANE side, matching
  // PORCH_V); right-curb houses are non-customer set dressing only. The porch
  // band is the -LANE side so the toss (which lofts toward the curb) reaches it.
  var LEFT_CURB_V = -1.4;      // left curb house body lane (behind the porch)
  var RIGHT_CURB_V = Core ? Core.V_MAX + 1.4 : 4.4;  // right curb house body lane

  // ── Hazard spacing (fair) ────────────────────────────────────────────────
  // Hazards live in the rideable street [V_MIN, V_MAX]. Consecutive hazards are
  // spaced at least MIN_HAZARD_GAP apart in u so the rider always has room to
  // steer around one before the next — the Paperboy analogue of Runner's fair
  // gap. Hazards never sit in the porch lane and never block ALL lanes at once.
  var MIN_HAZARD_GAP = 300;    // minimum u between consecutive hazards
  var HAZARD_GAP_JITTER = 220; // extra random spacing on top (seeded)
  var FIRST_HAZARD_U = 600;    // no hazards in the opening runway

  // ── House roster (art only; geometry is generated) ───────────────────────
  var HOUSE_ART = [
    { roof: '#c0473e', body: '#e6cf9a', door: '#5f9450', trim: '#fff3e0' },
    { roof: '#3a6ad0', body: '#cdd7e6', door: '#c0473e', trim: '#f0e6c0' },
    { roof: '#5f9450', body: '#e0c89a', door: '#3a3a44', trim: '#fff3e0' },
    { roof: '#8c5a9e', body: '#e6d2e0', door: '#e0a85a', trim: '#fff3e0' },
    { roof: '#e0a85a', body: '#f0e6c0', door: '#3a6ad0', trim: '#fff3e0' }
  ];
  var OUTLINE = '#1d1d28';

  // ── Hazard roster (data — shell draws each from art) ──────────────────────
  // R_U / R_V are collision half-extents in road-space (u px, lane units). The
  // shell uses the SAME extents so collision agrees with what's drawn.
  var HAZARDS_ROSTER = [
    { id: 'parked-car',  w: 64, h: 30, rU: 30, rV: 0.55, moving: false, weight: 4,
      art: { shape: 'car',    fill: '#c0473e', accent: '#f0e6c0', glass: '#9fd0f0', outline: OUTLINE } },
    { id: 'hydrant',     w: 18, h: 26, rU: 12, rV: 0.30, moving: false, weight: 3,
      art: { shape: 'hydrant',fill: '#e04a4a', accent: '#f0a0a0', outline: OUTLINE } },
    { id: 'trash-can',   w: 22, h: 28, rU: 13, rV: 0.32, moving: false, weight: 3,
      art: { shape: 'trash',  fill: '#5aa0d8', accent: '#9fd0f0', outline: OUTLINE } },
    { id: 'pothole',     w: 30, h: 10, rU: 16, rV: 0.40, moving: false, weight: 3,
      art: { shape: 'pothole',fill: '#2b2b38', accent: '#4a4a5a', outline: OUTLINE } },
    { id: 'dog',         w: 26, h: 20, rU: 14, rV: 0.34, moving: true,  weight: 3,
      art: { shape: 'dog',    fill: '#e0a85a', accent: '#fff3e0', outline: OUTLINE } },
    { id: 'pedestrian',  w: 22, h: 40, rU: 12, rV: 0.32, moving: true,  weight: 2,
      art: { shape: 'pedestrian', fill: '#3a6ad0', accent: '#e6cf9a', outline: OUTLINE } }
  ];

  function hazardById(id) {
    for (var i = 0; i < HAZARDS_ROSTER.length; i++) {
      if (HAZARDS_ROSTER[i].id === id) return HAZARDS_ROSTER[i];
    }
    return null;
  }

  // Weighted seeded pick from the hazard roster.
  function pickHazard(rng) {
    var total = 0, i;
    for (i = 0; i < HAZARDS_ROSTER.length; i++) total += HAZARDS_ROSTER[i].weight;
    var r = rng() * total;
    for (i = 0; i < HAZARDS_ROSTER.length; i++) {
      r -= HAZARDS_ROSTER[i].weight;
      if (r <= 0) return HAZARDS_ROSTER[i];
    }
    return HAZARDS_ROSTER[HAZARDS_ROSTER.length - 1];
  }

  // Build a customer's porch TARGET. v === PORCH_V (the curb porch lane), u is
  // the house anchor + PORCH_LEAD so the natural toss (computed from airtime in
  // the core) lands on it. `delivered` flips true when the core scores it.
  function makePorch(house) {
    return {
      u: house.u + PORCH_LEAD,
      v: PORCH_V,
      delivered: false,
      house: house
    };
  }

  // ── The generator ─────────────────────────────────────────────────────────
  // generate(seed) → a deterministic route. Same seed → identical route. Houses
  // fill alternating slots on both curbs; exactly N_CUSTOMERS of them (left
  // curb, where the porch lane is reachable) are flagged as customers and get a
  // porch target. Hazards are sprinkled in the street at fair spacing.
  function generate(seed) {
    var rng = Core.makeRng(seed == null ? 1 : seed);
    var houses = [];
    var customers = [];
    var artIdx = 0;

    // Lay down house slots until we have enough customers, alternating curbs.
    // Customers live on the LEFT curb (porch-reachable). Right-curb houses are
    // always non-customer set dressing. We place a left+right pair per slot.
    var slot = 0;
    var u = START_U;
    while (customers.length < N_CUSTOMERS) {
      // Left-curb house at this slot.
      var lu = u + (rng() * 2 - 1) * HOUSE_JITTER;
      var isCustomer = customers.length < N_CUSTOMERS &&
        (rng() < CUSTOMER_RATIO || (N_CUSTOMERS - customers.length) >=
          // force-fill late slots so we always hit exactly N_CUSTOMERS
          (estimateRemainingSlots(slot)));
      var left = {
        kind: 'house',
        id: 'house-L' + slot,
        u: lu,
        v: LEFT_CURB_V,
        side: 'left',
        customer: !!isCustomer,
        art: HOUSE_ART[artIdx++ % HOUSE_ART.length]
      };
      if (left.customer) {
        left.porch = makePorch(left);
        customers.push(left);
      }
      houses.push(left);

      // Right-curb house at this slot (always non-customer set dressing).
      var ru = u + (rng() * 2 - 1) * HOUSE_JITTER;
      var right = {
        kind: 'house',
        id: 'house-R' + slot,
        u: ru,
        v: RIGHT_CURB_V,
        side: 'right',
        customer: false,
        art: HOUSE_ART[artIdx++ % HOUSE_ART.length]
      };
      houses.push(right);

      slot += 1;
      u += HOUSE_SPACING;
    }

    var lastHouseU = u;  // u after the final slot
    var routeU = lastHouseU + END_PAD;

    // Hazards: fair-spaced down the street, never in the porch lane, never on
    // top of a customer porch's u (so a porch is always approachable).
    var hazards = [];
    var hu = FIRST_HAZARD_U;
    while (hu < routeU - END_PAD * 0.5) {
      var ref = pickHazard(rng);
      // Lane within the rideable street, biased away from the dead center so
      // the rider can always pick a clear line. Keep a clear lane on each side.
      var lane = Core.V_MIN + 0.3 + rng() * (Core.V_MAX - Core.V_MIN - 0.6);
      hazards.push({
        kind: 'hazard',
        id: ref.id,
        u: hu,
        v: lane,
        w: ref.w,
        h: ref.h,
        rU: ref.rU,
        rV: ref.rV,
        moving: ref.moving,
        art: ref.art
      });
      hu += MIN_HAZARD_GAP + rng() * HAZARD_GAP_JITTER;
    }

    var porchTargets = [];
    for (var c = 0; c < customers.length; c++) porchTargets.push(customers[c].porch);

    return {
      seed: seed == null ? 1 : seed,
      routeU: routeU,
      houses: houses,
      customers: customers,
      hazards: hazards,
      porchTargets: porchTargets,
      total: customers.length
    };
  }

  // Helper: a rough estimate of how many more slots remain in the loop so we can
  // force-fill late customers. Kept intentionally simple/deterministic — it just
  // pulls the customer ratio up as we approach the loop's natural end.
  function estimateRemainingSlots(slot) {
    // The loop runs until N_CUSTOMERS customers exist. With CUSTOMER_RATIO ~0.5,
    // it takes ~2*N_CUSTOMERS slots. Once we're past that many slots, force every
    // remaining left house to be a customer so the count lands exactly on N.
    return slot < N_CUSTOMERS * 2 ? Infinity : 0;
  }

  // ── Hazard collision (road-space AABB; same extents the shell draws) ──────
  // A hazard hits the scooter when the scooter's (u, v) is within the hazard's
  // half-extents (rU in u px, rV in lane units). The shell uses the SAME test.
  function hazardHits(hazard, scooterU, scooterV) {
    return Math.abs(hazard.u - scooterU) <= hazard.rU &&
           Math.abs(hazard.v - scooterV) <= hazard.rV;
  }

  // countDelivered(route) → how many customer porches are delivered.
  function countDelivered(route) {
    var n = 0;
    for (var i = 0; i < route.customers.length; i++) {
      if (route.customers[i].porch.delivered) n += 1;
    }
    return n;
  }

  return {
    // config (read by the shell — never hard-coded there)
    HOUSE_SPACING: HOUSE_SPACING, HOUSE_JITTER: HOUSE_JITTER,
    N_CUSTOMERS: N_CUSTOMERS, CUSTOMER_RATIO: CUSTOMER_RATIO,
    START_U: START_U, END_PAD: END_PAD,
    LEFT_CURB_V: LEFT_CURB_V, RIGHT_CURB_V: RIGHT_CURB_V,
    PORCH_V: PORCH_V, PORCH_LEAD: PORCH_LEAD,
    MIN_HAZARD_GAP: MIN_HAZARD_GAP, HAZARD_GAP_JITTER: HAZARD_GAP_JITTER,
    FIRST_HAZARD_U: FIRST_HAZARD_U,
    // roster
    HOUSE_ART: HOUSE_ART, HAZARDS_ROSTER: HAZARDS_ROSTER,
    hazardById: hazardById, pickHazard: pickHazard,
    // generator + helpers
    generate: generate, makePorch: makePorch,
    hazardHits: hazardHits, countDelivered: countDelivered
  };
});
