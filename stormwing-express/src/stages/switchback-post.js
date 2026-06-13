/*
 * Stage 2 — SWITCHBACK POST. Diagonal Paperboy x Excitebike leg in
 * explicit road space (u = distance along road, v = lane 0.0-3.5,
 * h = altitude). Throttle/heat with the redline vent window, ramps with
 * airborne pitch, lofted lantern-ring deliveries, drop-boxes, cart dogs,
 * market carts, clotheslines, and the rival courier. Pure logic in
 * update(); draw() only renders. Spec: design-spec stages[1].
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../core.js'),
      require('../core/physics.js'),
      require('../core/collision.js'),
      require('../core/meter.js'),
      require('../core/spawner.js')
    );
  } else {
    (root.Stages = root.Stages || {})['switchback-post'] =
      factory(root.Core, root.Physics, root.Collision, root.Meter, root.Spawner);
  }
})(typeof self !== 'undefined' ? self : this, function (Core, Physics, Collision, Meter, Spawner) {
  'use strict';

  // ── Spec-pinned numbers (design-spec stages[1]) ──────────────────────
  var ROUTE_LEN = 9000;       // px route (~75s)
  var LANE_PX = 56;           // px per lane unit (spec: v * 56 * LANE)
  var LANE_MAX = 3.5;         // v range 0.0..3.5 continuous
  var ALONG_X = 0.80, ALONG_Y = 0.60;   // ALONG unit vector
  var LANE_X = -0.60, LANE_Y = 0.80;    // LANE unit vector
  var CAM_BACK = 180;         // camera locks to player u minus 180
  var SPEED_FULL = 210;       // hold Up
  var SPEED_NEUTRAL = 140;
  var SPEED_BRAKE = 90;
  var HEAT_FILL = 25;         // 0→100 in 4s at full throttle
  var HEAT_COOL = 12.5;       // release cools 12.5/s
  var HEAT_BRAKE_COOL = 25;   // brake cools 25/s
  var REDLINE_LO = 85;        // vent window is [85, 100): the 85-99 band
  var VENT_TIME = 0.6;        // 0.6s at +15% speed
  var VENT_HEAT = 40;         // heat drops to 40 on vent
  var SPEED_MULT = 1.15;      // vent / clean-landing boost
  var SPUTTER_TIME = 1.5;     // hitting 100 = 1.5s sputter
  var SPUTTER_SPEED = 90;
  var DOWNDRAFT_H = 90;       // above h=90 the storm shoves down
  var DOWNDRAFT = 350;        // px/s² shove
  var RAMP_MIN = 160;         // launch only if u-speed >= 160
  var LAND_TOL = 20 * Math.PI / 180; // clean landing within ±20° of slope
  var STUMBLE_TIME = 0.8;     // bad landing / dog lunge
  var CART_SPEED = 110;       // px/s across lanes
  var CART_TELE = 1.2;        // bell bleep + dust puff telegraph
  var DOG_CHASE = 3;          // dogs chase in 3s bursts then quit
  var LINE_SLOW = 1;          // clothesline snag = 1s slow
  var LINE_H_LO = 50, LINE_H_HI = 90; // webs strung at air height
  var RIVAL_MIN = 300, RIVAL_MAX = 500; // rival weaves 300-500 px ahead
  var RIVAL_RESPAWN = 10;     // pegged rival respawns 10s later
  var HOUSES = 12;            // lantern houses on the route
  var FULL_CLEAR_AT = 8;      // >=8 delivered earns +1500
  var DOG_TELE = 0.8;         // generic telegraph floor (rule: >= 0.8s)

  // ── Tuned values the spec leaves unpinned ────────────────────────────
  var AX = 200, AY = 90;      // projection anchor on the 960x600 canvas
  var THROW_LOFT = 1.25;      // rad above horizontal for the up-left loft
  var RING_V = -1.5;          // lantern rings sit off-road on the -LANE side
  var RING_LAT = RING_V * LANE_PX; // -84 px lateral
  var RING_R = 38;            // ring outer radius (road px)
  var BULLSEYE_R = 12;        // dead-center radius
  var THROW_CADENCE = 1.6;    // deliberate throws (sharedSystems cadence list)
  var DOG_SPEED = 235, DOG_AHEAD = 240, DOG_QUIT_DRIFT = 60;
  var STUMBLE_SPEED = 70;
  var SLOW_MULT = 0.5;        // clothesline snag halves speed
  var PITCH_RATE = 1.6;       // rad/s airborne pitch input
  var PITCH_DRIFT = 0.55;     // rad/s natural nose-up drift in air
  var RAMP_ANGLE = 0.34;      // rad (~19.5°) ramp slope = initial pitch
  var RAMP_LAUNCH = 1.8;      // launch vy = -uSpeed * RAMP_LAUNCH (vy clamp caps it)
  var BOOST_TIME = 0.6;       // clean-landing brief boost
  var CART_LEAD = 320;        // telegraph fires this far before the crossing
  var CART_CLEAR_H = 34;      // flap above this and carts pass under you
  var CART_R_U = 26, CART_R_V = 0.6;
  var DOG_HIT_U = 18, DOG_HIT_V = 0.55, DOG_HIT_H = 22;
  var BOX_R = 22;             // drop-box catch radius
  var PEG_U = 22, PEG_LAT = 24, PEG_H = 40; // rival peg window
  var LINE_CUT_U = 14, SNAG_U = 12;
  var MID_U = ROUTE_LEN / 2;  // route-midpoint checkpoint
  var RIVAL_START = 420, RIVAL_TARGET = 400, RIVAL_AHEAD_ON_RESPAWN = 450;
  var GODRAY_LO = 4300, GODRAY_HI = 5700; // mid-route god-ray window (~6s)
  var VIEW_BEHIND = 320, VIEW_AHEAD = 1000;

  var PALETTE = {
    skyTop: '#2e6fd8',        // cobalt zenith
    skyBottom: '#fff3d6',     // bleached gold horizon
    terracotta: '#c4543a',
    sandstone: '#d9a066',
    shadow: '#3a2e3f',        // crisp plum shadows
    lantern: '#ffc04d',
    dust: '#b8a47e',
    brass: '#d9b36a',
    teal: '#2aa7a0',
    outline: '#141821',
    sea: '#4f9bd9',
    road: '#b09a80',
    grey: '#6b6b70',          // claimed (lost) lantern
    white: '#ffffff',
    rival: '#8c2f3f',
  };

  // ── State (module closure; checkpoint survives requestRestart) ──────
  var S = null;
  var CP = null;              // checkpoint snapshot (layout refs + counters)
  var restartPending = false;

  // Road-space → screen. The spec-pinned projection:
  //   screenPos = anchor + (u - camU) * ALONG + v * 56 * LANE, minus (0, h).
  function projectAt(u, v, h, camU) {
    var du = u - camU;
    return {
      x: AX + du * ALONG_X + v * LANE_PX * LANE_X,
      y: AY + du * ALONG_Y + v * LANE_PX * LANE_Y - h,
    };
  }
  function project(u, v, h) { return projectAt(u, v, h, S.camU); }

  function playerH(body) { return -body.y; } // body.y = -h; ground at 0
  function playerV(body) { return body.x / LANE_PX; }

  function puff(world, u, v, h, color, count, speed) {
    var P = world.particles;
    if (!P || !P.burst) return;
    var s = project(u, v, h);
    P.burst({ x: s.x, y: s.y, count: count || 8, color: color, speed: speed || 100 });
  }
  function preset(world, name, u, v, h, opts) {
    var P = world.particles;
    if (!P || !P.preset) return;
    var s = project(u, v, h);
    P.preset(name, s.x, s.y, opts);
  }
  function floater(world, u, v, h, text, color) {
    if (!world.floaters || !world.floaters.add) return;
    var s = project(u, v, h);
    world.floaters.add(s.x, s.y, text, color || '#fff');
  }
  function sfx(world, name, arg) {
    if (world.audio && world.audio.sfx) world.audio.sfx(name, arg);
  }
  function round3(x) { return Math.round(x * 1000) / 1000; }

  // Route ALL hull damage through hull + tailwind (contract). Market carts
  // are the ONLY caller in this stage. The shell self-wires the hull-damage
  // thud/flash/trauma, so none of that fires here (integration addendum 4).
  function damagePlayer(world) {
    var res = world.hull.damage(1);
    if (res === 'shrugged') return false;
    world.tailwind.damage();
    puff(world, S.u, playerV(world.physics), playerH(world.physics), PALETTE.dust, 14, 150);
    if (res === 'gameover') {
      saveCheckpoint();
      restartPending = true;
      world.requestRestart('switchback-post:' + (CP.u > 0 ? 'midpoint' : 'start'));
    }
    return true;
  }

  // Deliveries are kept across the restart: the checkpoint holds the SAME
  // layout objects, so delivered/lost/cut flags ride along for free.
  function saveCheckpoint() {
    CP = {
      u: S.maxU >= MID_U ? MID_U : 0,
      houses: S.houses, boxes: S.boxes, ramps: S.ramps,
      lines: S.lines, sections: S.sections,
      fullClearAwarded: S.fullClearAwarded,
      dropsDelivered: S.dropsDelivered,
      rivalClaims: S.rivalClaims,
    };
  }

  function countDelivered(houses) {
    var n = 0;
    for (var i = 0; i < houses.length; i++) if (houses[i].delivered) n += 1;
    return n;
  }

  // ── init / restart-checkpoint ────────────────────────────────────────
  function init(world) {
    var startU = 0;
    var keep = null;
    if (restartPending && CP) {
      keep = CP;
      startU = CP.u;
    }
    restartPending = false;
    if (!keep) CP = null;

    var houses, boxes, ramps, lines, sections, i;
    if (keep) {
      houses = keep.houses; boxes = keep.boxes; ramps = keep.ramps;
      lines = keep.lines; sections = keep.sections;
    } else {
      // Deterministic layout: same rng seed → identical route.
      var rng = world.rng;
      houses = [];
      for (i = 0; i < HOUSES; i++) {
        houses.push({ u: 700 + i * 640 + rng() * 160, delivered: false, lost: false });
      }
      boxes = [];
      for (i = 0; i < 6; i++) {
        boxes.push({ u: 1000 + i * 1250 + rng() * 200, v: 0.5 + Math.floor(rng() * 3), delivered: false });
      }
      ramps = [];
      for (i = 0; i < 4; i++) {
        ramps.push({ u: 1500 + i * 1800 + rng() * 240, angle: RAMP_ANGLE });
      }
      lines = [];
      for (i = 0; i < 4; i++) {
        lines.push({ u: 1200 + i * 1900 + rng() * 300, cut: false });
      }
      sections = [];
      for (i = 0; i < 8; i++) {
        sections.push({ u: 900 + i * 1000 + rng() * 180, dir: rng() < 0.5 ? 1 : -1 });
      }
    }

    S = {
      t: 0, u: startU, prevU: startU, maxU: startU, camU: startU - CAM_BACK,
      uSpeed: 0, airSpeed: 0,
      grounded: true, air: null, prevThrottle: false,
      heat: new Meter({ max: 100, fillRate: HEAT_FILL, decayRate: HEAT_COOL, brakeDecayRate: HEAT_BRAKE_COOL }),
      ventT: 0, sputterT: 0, stumbleT: 0, slowT: 0, boostT: 0,
      throwCool: 0,
      houses: houses, boxes: boxes, ramps: ramps, lines: lines, sections: sections,
      dogs: [], carts: [],
      rival: {
        u: startU + RIVAL_START, prevU: startU + RIVAL_START,
        v: 1.75, state: 'ride', respawnT: 0, weaveT: 0,
      },
      housesDelivered: countDelivered(houses),
      dropsDelivered: keep ? keep.dropsDelivered : 0,
      fullClearAwarded: keep ? keep.fullClearAwarded : false,
      rivalClaims: keep ? keep.rivalClaims : 0,
      reachedDepot: false,
      track: new Spawner.Track(world.rng),
      cartLog: [], dogLog: [],
      dustT: 0, redlineSfxT: 0,
    };

    // Progress-keyed spawn timelines (deterministic per seed + inputs).
    S.track.every(1400, function (key) { spawnDog(world, key); },
      { start: Math.max(1100, startU + 700), jitter: 0.3, until: 8000 });
    for (i = 0; i < sections.length; i++) {
      (function (sec) {
        var key = sec.u - CART_LEAD;
        if (key > startU + 1) {
          S.track.at(key, function (k) { spawnCart(world, sec, k); });
        }
      })(sections[i]);
    }

    var body = world.physics;
    body.x = 1.75 * LANE_PX; // mid-road lane, lateral px
    body.y = 0;              // ground (y = -h)
    body.vx = 0; body.vy = 0;
    body.facing = 1;
  }

  function spawnDog(world, key) {
    // Spawns 240px ahead with a 0.8s bark/dust telegraph: even at max boost
    // speed (~241 px/s) the player needs ~1s to close, so the telegraph
    // always completes before contact is possible.
    S.dogs.push({
      u: S.u + DOG_AHEAD, v: playerV(world.physics),
      state: 'tele', t: DOG_TELE, chaseT: 0,
    });
    S.dogLog.push(round3(key));
    sfx(world, 'telegraph');
    puff(world, S.u + DOG_AHEAD, playerV(world.physics), 0, PALETTE.dust, 6, 60);
  }

  function spawnCart(world, sec, key) {
    S.carts.push({
      u: sec.u, v: sec.dir > 0 ? -1.2 : LANE_MAX + 1.2,
      dir: sec.dir, state: 'tele', t: CART_TELE,
    });
    S.cartLog.push(round3(key));
    sfx(world, 'telegraph'); // the bell bleep
    puff(world, sec.u, sec.dir > 0 ? -1 : LANE_MAX + 1, 0, PALETTE.dust, 8, 80);
  }

  // ── Throttle / heat / redline (the Excitebike graft) ─────────────────
  function updateThrottleHeat(dt, world, axis) {
    var heat = S.heat;
    var throttle = S.grounded && axis.y < 0 && S.sputterT <= 0 && S.stumbleT <= 0;
    var brake = S.grounded && axis.y > 0;

    // REDLINE VENT: release inside the 85-99 window.
    if (S.grounded && S.prevThrottle && !throttle && heat.zone(REDLINE_LO, heat.max)) {
      S.ventT = VENT_TIME;
      heat.reset(VENT_HEAT);
      world.score.add('redlineVent'); // genuine redline vent
      preset(world, 'steam', S.u, playerV(world.physics), 10);
      floater(world, S.u, playerV(world.physics), 30, 'VENT!', PALETTE.lantern);
    }

    if (throttle) {
      heat.fill(dt);
      if (heat.value >= heat.max) {
        // Sputter: 1.5s at speed 90, heat resets, no damage.
        S.sputterT = SPUTTER_TIME;
        heat.reset(0);
        preset(world, 'steam', S.u, playerV(world.physics), 6);
        throttle = false;
      }
    } else {
      heat.decay(dt, brake);
    }
    S.prevThrottle = throttle;

    // Meter flashes + engine pitch rise at 85+ (telegraphs the sputter).
    if (heat.value >= REDLINE_LO) {
      S.redlineSfxT -= dt;
      if (S.redlineSfxT <= 0) {
        S.redlineSfxT = 0.15;
        sfx(world, 'redline', heat.ratio());
      }
    }

    var base;
    if (S.sputterT > 0) base = SPUTTER_SPEED;
    else if (S.stumbleT > 0) base = STUMBLE_SPEED;
    else if (throttle) base = SPEED_FULL;
    else if (brake) base = SPEED_BRAKE;
    else base = SPEED_NEUTRAL;

    var sp = S.grounded ? base : S.airSpeed; // throttle is moot in air
    var mult = 1;
    if (S.ventT > 0 || S.boostT > 0) mult *= SPEED_MULT;
    if (S.slowT > 0) mult *= SLOW_MULT;
    S.uSpeed = sp * mult;

    S.prevU = S.u;
    S.u += S.uSpeed * dt;
    if (S.u > S.maxU) S.maxU = S.u;
  }

  // ── Player body: steer, flap, ramps, pitch, landings ─────────────────
  function launchOffRamp(world, ramp) {
    S.grounded = false;
    S.air = { fromRamp: true, pitch: ramp.angle };
    S.airSpeed = S.uSpeed;
    var body = world.physics;
    body.vy = -Math.min(-Physics.PHYS.vyMin, S.uSpeed * RAMP_LAUNCH);
    preset(world, 'dust', S.u, playerV(world.physics), 0, { count: 10 });
  }

  function landFromAir(world) {
    var body = world.physics;
    body.y = 0;
    body.vy = 0;
    S.grounded = true;
    if (S.air && S.air.fromRamp) {
      // Land within ±20° of the road slope (flat: 0 rad) = clean landing.
      if (Math.abs(S.air.pitch) <= LAND_TOL) {
        world.score.add('cleanLanding'); // +150, combo tier up (add() bumps)
        S.boostT = BOOST_TIME;
        preset(world, 'dust', S.u, playerV(body), 0, { count: 14 }); // twin rings
        floater(world, S.u, playerV(body), 24, 'CLEAN LANDING', PALETTE.white);
      } else {
        S.stumbleT = STUMBLE_TIME; // never hull damage
        puff(world, S.u, playerV(body), 0, PALETTE.dust, 10, 90);
      }
    }
    S.air = null;
  }

  function updatePlayerBody(dt, world, axis) {
    var body = world.physics;
    var input = world.input;

    Physics.steer(body, axis.x, dt);

    if (input.justPressed(' ') || input.justPressed('z')) {
      Physics.flap(body); // FLAP works on h with the standard constants
      if (S.grounded) {
        S.grounded = false;
        S.airSpeed = S.uSpeed;
        S.air = S.air || { fromRamp: false, pitch: 0 };
      }
    }

    // Ramps: launch only at u-speed >= 160 (slow rolls pass over).
    if (S.grounded) {
      for (var r = 0; r < S.ramps.length; r++) {
        var ramp = S.ramps[r];
        if (S.prevU < ramp.u && S.u >= ramp.u && S.uSpeed >= RAMP_MIN) {
          launchOffRamp(world, ramp);
          break;
        }
      }
    }

    if (S.grounded) {
      body.x += body.vx * dt; // lateral only; u motion lives in S.u
      body.y = 0;
      body.vy = 0;
    } else {
      // Airborne: Up/Down repurpose to PITCH on ramp flights.
      if (S.air && S.air.fromRamp) {
        var pin = axis.y < 0 ? PITCH_RATE : axis.y > 0 ? -PITCH_RATE : 0;
        S.air.pitch += (pin + PITCH_DRIFT) * dt;
      }
      Physics.integrate(body, dt, {});
      if (playerH(body) > DOWNDRAFT_H) {
        // Visible storm downdraft enforces the low band above h=90.
        body.vy = Core.clamp(body.vy + DOWNDRAFT * dt, Physics.PHYS.vyMin, Physics.PHYS.vyMax);
        preset(world, 'spray', S.u, playerV(body), playerH(body) + 20, { count: 2 });
      }
      if (body.y >= 0 && body.vy >= 0) landFromAir(world);
    }

    // Lane clamp: v stays in 0.0..3.5.
    var latMax = LANE_MAX * LANE_PX;
    if (body.x < 0) { body.x = 0; if (body.vx < 0) body.vx = 0; }
    if (body.x > latMax) { body.x = latMax; if (body.vx > 0) body.vx = 0; }

    // Dust rooster-tail scales with throttle (cosmetic emit only).
    if (S.grounded) {
      S.dustT -= dt;
      if (S.dustT <= 0) {
        S.dustT = 0.08;
        preset(world, 'dust', S.u - 14, playerV(body), 0,
          { count: 1 + Math.round(S.uSpeed / 90) });
      }
    }
  }

  // ── Throws: lofted ring bundles + Down+X drop-boxes ──────────────────
  function tagBundle(p) {
    // Bundles ride the courier's full forward momentum along u (Paperboy:
    // the paper travels with the bike). The contract's 0.5x inherit applies
    // to the (lateral, vertical) sling plane, which Projectiles handles;
    // the u axis is this stage's road-space mapping and carries full speed
    // so the rival (300-500 px ahead) stays peggable at full throttle.
    p.u = S.u;
    p.du = S.uSpeed;
  }

  function updateThrows(dt, world, axis) {
    var body = world.physics;
    var input = world.input;
    S.throwCool -= dt;
    if (input.justPressed('x') && axis.y > 0) {
      // Down+X: the straight drop, into in-lane drop-boxes.
      tagBundle(world.projectiles.straightDrop(body));
      S.throwCool = 1 / THROW_CADENCE;
    } else if (input.held('x') && S.throwCool <= 0) {
      // Single deliberate lofts up-left (-LANE side) toward the lanterns.
      var arr = world.projectiles.sling(body, {
        dirX: -1,
        angle: -THROW_LOFT,
        muzzleBonus: world.tailwind.muzzleBonus(),
      });
      for (var i = 0; i < arr.length; i++) tagBundle(arr[i]);
      S.throwCool = 1 / THROW_CADENCE;
    }
  }

  function deliverHouse(world, house, bullseye, u, lat) {
    house.delivered = true;
    S.housesDelivered += 1;
    world.tallies.deliveries += 1;
    var pts = world.score.add(bullseye ? 'bullseye' : 'delivery');
    preset(world, 'embers', house.u, RING_V, 20, { count: 12 }); // lantern bloom
    floater(world, u, lat / LANE_PX, 16,
      bullseye ? 'BULLSEYE +' + pts : '+' + pts, PALETTE.lantern);
    if (S.housesDelivered >= FULL_CLEAR_AT && !S.fullClearAwarded) {
      S.fullClearAwarded = true;
      var bonus = world.score.add('stageClear'); // the full-clear bonus
      floater(world, S.u, playerV(world.physics), 60, 'FULL CLEAR +' + bonus, PALETTE.lantern);
    }
  }

  // A landed bundle: lantern ring (bullseye dead-center), then drop-boxes.
  // Houses delivered count toward the 12-house tally; drop-boxes score the
  // same 300 'delivery' but are bonus targets, not lantern houses.
  function resolveGround(world, p) {
    var lat = p.x, i;
    for (i = 0; i < S.houses.length; i++) {
      var hh = S.houses[i];
      if (hh.delivered || hh.lost) continue;
      var du = p.u - hh.u, dv = lat - RING_LAT;
      var d = Math.sqrt(du * du + dv * dv);
      if (d <= BULLSEYE_R) { deliverHouse(world, hh, true, p.u, lat); return; }
      if (d <= RING_R) { deliverHouse(world, hh, false, p.u, lat); return; }
    }
    for (i = 0; i < S.boxes.length; i++) {
      var b = S.boxes[i];
      if (b.delivered) continue;
      if (Math.abs(p.u - b.u) <= BOX_R && Math.abs(lat - b.v * LANE_PX) <= BOX_R) {
        b.delivered = true;
        S.dropsDelivered += 1;
        var pts = world.score.add('delivery');
        floater(world, b.u, b.v, 16, '+' + pts, PALETTE.lantern);
        return;
      }
    }
    // Missed throws cost nothing — ever.
    puff(world, p.u, lat / LANE_PX, 0, PALETTE.dust, 4, 50);
  }

  function updateBundles(dt, world) {
    var list = world.projectiles.list;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.dead || p.u == null) continue;
      p.u += p.du * dt;
      var h = -p.y;
      // Sling cuts clothesline webs (+50).
      for (var L = 0; L < S.lines.length; L++) {
        var line = S.lines[L];
        if (!line.cut && h >= LINE_H_LO && h <= LINE_H_HI &&
            Math.abs(p.u - line.u) <= LINE_CUT_U &&
            p.x > -30 && p.x < LANE_MAX * LANE_PX + 30) {
          line.cut = true;
          // SPEC-DEVIATION: Score.BASE has no clothesline-cut type; the
          // spec's +50 award is routed through its own clotheslineCut type.
          var pts = world.score.add('clotheslineCut');
          floater(world, line.u, 1.5, 70, 'SNIP +' + pts, PALETTE.white);
          break;
        }
      }
      // Peg the rival with a bundle = +500; he respawns further down.
      var rv = S.rival;
      if (!p.dead && rv.state === 'ride' && h < PEG_H &&
          Math.abs(p.u - rv.u) <= PEG_U && Math.abs(p.x - rv.v * LANE_PX) <= PEG_LAT) {
        p.dead = true;
        rv.state = 'gone';
        rv.respawnT = RIVAL_RESPAWN;
        world.score.add('rivalPegged');
        puff(world, rv.u, rv.v, 20, PALETTE.rival, 14, 160);
        floater(world, rv.u, rv.v, 36, 'PEGGED +500', PALETTE.white);
        continue;
      }
      if (p.y >= 0) { // bundle hits the road plane
        resolveGround(world, p);
        p.dead = true;
      }
    }
  }

  // ── Hazards ──────────────────────────────────────────────────────────
  function updateDogs(dt, world) {
    var body = world.physics;
    for (var i = S.dogs.length - 1; i >= 0; i--) {
      var d = S.dogs[i];
      if (d.state === 'tele') {
        d.t -= dt;
        if (d.t <= 0) { d.state = 'chase'; d.chaseT = DOG_CHASE; }
      } else if (d.state === 'chase') {
        d.chaseT -= dt;
        var du = S.u - d.u;
        var step = DOG_SPEED * dt;
        d.u += Math.abs(du) <= step ? du : (du > 0 ? step : -step);
        if (d.chaseT <= 0) d.state = 'quit';
        // Lunge contact = stumble only (no hull, no tier).
        if (d.state === 'chase' && S.stumbleT <= 0 &&
            Math.abs(d.u - S.u) <= DOG_HIT_U &&
            Math.abs(d.v - playerV(body)) <= DOG_HIT_V &&
            playerH(body) <= DOG_HIT_H) {
          S.stumbleT = STUMBLE_TIME;
          d.state = 'quit';
          puff(world, d.u, d.v, 10, PALETTE.dust, 8, 90);
        }
      } else { // quit: falls behind, despawns
        d.u -= DOG_QUIT_DRIFT * dt;
        if (d.u < S.u - 500) S.dogs.splice(i, 1);
      }
    }
  }

  function updateCarts(dt, world) {
    var body = world.physics;
    for (var i = S.carts.length - 1; i >= 0; i--) {
      var c = S.carts[i];
      if (c.state === 'tele') {
        c.t -= dt;
        if (c.t <= 0) c.state = 'rolling';
        continue; // telegraphing carts cannot hurt
      }
      c.v += c.dir * (CART_SPEED / LANE_PX) * dt;
      if (c.v < -1.4 || c.v > LANE_MAX + 1.4) {
        S.carts.splice(i, 1);
        continue;
      }
      // The ONLY hull damage in this stage. Flap over it (h > 34) to dodge.
      if (Math.abs(c.u - S.u) <= CART_R_U &&
          Math.abs(c.v - playerV(body)) <= CART_R_V &&
          playerH(body) < CART_CLEAR_H) {
        damagePlayer(world);
      }
    }
  }

  function updateLines(world) {
    var body = world.physics;
    var h = playerH(body);
    for (var i = 0; i < S.lines.length; i++) {
      var line = S.lines[i];
      if (line.cut) continue;
      if (Math.abs(S.u - line.u) <= SNAG_U && h >= LINE_H_LO && h <= LINE_H_HI) {
        S.slowT = LINE_SLOW; // snag = 1s slow; never damage
      }
    }
  }

  function updateRival(dt, world) {
    var rv = S.rival;
    if (rv.state === 'gone') {
      rv.respawnT -= dt;
      if (rv.respawnT <= 0) {
        rv.state = 'ride';
        rv.u = S.u + RIVAL_AHEAD_ON_RESPAWN; // further down the route
        rv.prevU = rv.u;
        rv.weaveT = 0;
      }
      return;
    }
    rv.weaveT += dt;
    rv.v = 1.75 + 1.6 * Math.sin(rv.weaveT * 1.1); // weaving lanes
    rv.prevU = rv.u;
    var dist = rv.u - S.u;
    var speed = Core.clamp(S.uSpeed + (RIVAL_TARGET - dist) * 0.8, 60, 380);
    rv.u += speed * dt;
    if (rv.u < S.u + RIVAL_MIN) rv.u = S.u + RIVAL_MIN;
    if (rv.u > S.u + RIVAL_MAX) rv.u = S.u + RIVAL_MAX;
    // He claims any lantern house he passes first — peg him to stop it.
    for (var i = 0; i < S.houses.length; i++) {
      var hh = S.houses[i];
      if (hh.delivered || hh.lost) continue;
      if (rv.prevU < hh.u && rv.u >= hh.u) {
        hh.lost = true;
        S.rivalClaims += 1;
        floater(world, hh.u, RING_V, 30, 'CLAIMED!', PALETTE.grey);
      }
    }
  }

  // The 4s tailwind decay clock only ticks while scorable targets are on
  // screen; empty-field flying or slinging never decays the tier.
  function targetsOnScreen() {
    var lo = S.u - VIEW_BEHIND, hi = S.u + VIEW_AHEAD;
    var i;
    if (S.rival.state === 'ride') return true; // always in the 300-500 band
    for (i = 0; i < S.houses.length; i++) {
      var hh = S.houses[i];
      if (!hh.delivered && !hh.lost && hh.u >= lo && hh.u <= hi) return true;
    }
    for (i = 0; i < S.boxes.length; i++) {
      if (!S.boxes[i].delivered && S.boxes[i].u >= lo && S.boxes[i].u <= hi) return true;
    }
    for (i = 0; i < S.lines.length; i++) {
      if (!S.lines[i].cut && S.lines[i].u >= lo && S.lines[i].u <= hi) return true;
    }
    if (S.dogs.length > 0 || S.carts.length > 0) return true;
    return false;
  }

  function publishHud(world) {
    world.hud.heat = {
      label: 'HEAT',
      value: String(Math.round(S.heat.value)),
      ratio: S.heat.ratio(),
    };
    world.hud.post = {
      label: 'POST',
      value: S.housesDelivered + '/' + HOUSES,
      ratio: S.housesDelivered / HOUSES,
    };
    world.hud.route = {
      label: 'ROUTE',
      value: Math.min(100, Math.round(S.u / ROUTE_LEN * 100)) + '%',
      ratio: Math.min(1, S.u / ROUTE_LEN),
    };
  }

  // ── update ───────────────────────────────────────────────────────────
  function update(dt, world) {
    S.t += dt;
    var input = world.input;
    var axis = input.axis();

    world.tailwind.update(dt, targetsOnScreen());

    if (S.ventT > 0) S.ventT -= dt;
    if (S.boostT > 0) S.boostT -= dt;
    if (S.sputterT > 0) S.sputterT -= dt;
    if (S.stumbleT > 0) S.stumbleT -= dt;
    if (S.slowT > 0) S.slowT -= dt;

    updateThrottleHeat(dt, world, axis);
    updatePlayerBody(dt, world, axis);
    updateThrows(dt, world, axis);

    world.projectiles.update(dt); // stages drive projectiles (addendum 1)
    updateBundles(dt, world);

    // No new hazards once the depot is reached (addendum 9).
    if (!S.reachedDepot) S.track.poll(S.u);
    updateDogs(dt, world);
    updateCarts(dt, world);
    updateLines(world);
    updateRival(dt, world);

    if (!S.reachedDepot && S.u >= ROUTE_LEN) {
      S.reachedDepot = true;
      preset(world, 'confetti', S.u, 1.75, 40, { count: 24 });
      floater(world, S.u, 1.75, 60, 'THE DEPOT!', PALETTE.lantern);
    }

    S.camU = S.u - CAM_BACK;
    publishHud(world);
  }

  // WIN: reach the depot (always reachable — deliveries drive score only).
  // Airborne bundles resolve their arcs before isDone returns true.
  function isDone(world) {
    return !!(S && S.reachedDepot && world.projectiles.drained());
  }

  // ── draw ─────────────────────────────────────────────────────────────
  function shadowBlob(ctx, u, v, h) {
    // The Paperboy graft: every airborne thing drops a soft shadow at its
    // TRUE (u,v) road point, decoupling altitude from lane.
    var s = project(u, v, 0);
    var r = Math.max(4, 14 - h * 0.05);
    ctx.save();
    ctx.globalAlpha = Math.max(0.12, 0.4 - h * 0.002);
    ctx.fillStyle = PALETTE.shadow;
    ctx.translate(s.x, s.y);
    ctx.scale(1, 0.45);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function roadQuad(ctx, u0, u1, v0, v1, color) {
    var a = project(u0, v0, 0), b = project(u1, v0, 0);
    var c = project(u1, v1, 0), d = project(u0, v1, 0);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.fill();
  }

  function draw(ctx, world) {
    var g = world.gfx;
    var W = world.W, H = world.H;
    var body = world.physics;
    var pv = playerV(body), ph = playerH(body);
    var lo = S.camU - 120, hi = S.camU + VIEW_AHEAD + 200;
    var i, s, p;

    // HARD NOON sky.
    g.skyGradient(ctx, 0, 0, W, H, [[0, PALETTE.skyTop], [1, PALETTE.skyBottom]]);

    // Parallax 1 (0.15x): distant sea with sun glare.
    ctx.save();
    ctx.fillStyle = PALETTE.sea;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(0, 56, W, 60);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = PALETTE.skyBottom;
    var seaOff = (S.camU * 0.15) % 64;
    for (i = 0; i < 16; i++) {
      ctx.fillRect(((i * 64 - seaOff) % (W + 64)), 74 + (i % 3) * 12, 26, 3);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35;
    g.glowCircle(ctx, W - 180, 64, 60, PALETTE.skyBottom, 0.5);
    ctx.restore();

    // Parallax 2 (0.4x): cliff terraces.
    ctx.save();
    var terOff = (S.camU * 0.4) % 240;
    for (i = -1; i < 6; i++) {
      var tx = i * 240 - terOff;
      g.roundRect(ctx, tx, 118, 200, 38, 6, PALETTE.sandstone);
      g.roundRect(ctx, tx + 24, 100, 130, 24, 5, PALETTE.terracotta);
    }
    ctx.restore();

    // Parallax 3 (1.0x): the road in road space.
    roadQuad(ctx, lo, hi, -0.25, LANE_MAX + 0.25, PALETTE.road);
    roadQuad(ctx, lo, hi, -0.32, -0.18, PALETTE.shadow);
    roadQuad(ctx, lo, hi, LANE_MAX + 0.18, LANE_MAX + 0.32, PALETTE.shadow);
    ctx.save();
    ctx.fillStyle = PALETTE.white;
    ctx.globalAlpha = 0.4;
    var dashU = Math.floor(lo / 80) * 80;
    for (var du = dashU; du < hi; du += 80) {
      for (var lk = 1; lk < 4; lk++) {
        var v = lk * (LANE_MAX / 4) + 0.4;
        var d0 = project(du, v, 0), d1 = project(du + 34, v, 0);
        ctx.beginPath();
        ctx.moveTo(d0.x, d0.y);
        ctx.lineTo(d1.x, d1.y);
        ctx.lineWidth = 3;
        ctx.strokeStyle = PALETTE.white;
        ctx.stroke();
      }
    }
    ctx.restore();

    // Cross-street intersections.
    for (i = 0; i < S.sections.length; i++) {
      var sec = S.sections[i];
      if (sec.u < lo || sec.u > hi) continue;
      roadQuad(ctx, sec.u - 26, sec.u + 26, -1.6, LANE_MAX + 1.6, PALETTE.dust);
    }

    // Houses + lantern rings (the -LANE side).
    for (i = 0; i < S.houses.length; i++) {
      var hh = S.houses[i];
      if (hh.u < lo || hh.u > hi) continue;
      s = project(hh.u, RING_V - 0.9, 0);
      g.roundRect(ctx, s.x - 26, s.y - 44, 52, 44, 4, PALETTE.sandstone);
      g.roundRect(ctx, s.x - 30, s.y - 58, 60, 18, 4, PALETTE.terracotta);
      var lantColor = hh.lost ? PALETTE.grey : PALETTE.lantern;
      var ring = project(hh.u, RING_V, 0);
      if (!hh.delivered && !hh.lost) {
        ctx.save();
        ctx.strokeStyle = PALETTE.lantern;
        ctx.globalAlpha = 0.5 + 0.3 * Math.sin(S.t * 4 + i);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, RING_R * 0.62, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, BULLSEYE_R * 0.62, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      g.glowCircle(ctx, s.x + 20, s.y - 30, hh.delivered ? 16 : 9, lantColor,
        hh.delivered ? 0.85 : hh.lost ? 0.1 : 0.45);
    }

    // Drop-boxes, ramps, clotheslines, depot.
    for (i = 0; i < S.boxes.length; i++) {
      var bx = S.boxes[i];
      if (bx.u < lo || bx.u > hi) continue;
      s = project(bx.u, bx.v, 0);
      g.roundRect(ctx, s.x - 9, s.y - 12, 18, 12, 3,
        bx.delivered ? PALETTE.grey : PALETTE.brass);
    }
    for (i = 0; i < S.ramps.length; i++) {
      var rp = S.ramps[i];
      if (rp.u < lo || rp.u > hi) continue;
      var r0 = project(rp.u - 46, 0.1, 0), r1 = project(rp.u, 0.1, 26);
      var r2 = project(rp.u, LANE_MAX - 0.1, 26), r3 = project(rp.u - 46, LANE_MAX - 0.1, 0);
      ctx.fillStyle = PALETTE.terracotta;
      ctx.beginPath();
      ctx.moveTo(r0.x, r0.y);
      ctx.lineTo(r1.x, r1.y);
      ctx.lineTo(r2.x, r2.y);
      ctx.lineTo(r3.x, r3.y);
      ctx.closePath();
      ctx.fill();
    }
    for (i = 0; i < S.lines.length; i++) {
      var ln = S.lines[i];
      if (ln.cut || ln.u < lo || ln.u > hi) continue;
      var l0 = project(ln.u, -0.4, 70), l1 = project(ln.u, LANE_MAX + 0.4, 70);
      ctx.save();
      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(l0.x, l0.y);
      var mid = project(ln.u, LANE_MAX / 2, 58);
      ctx.quadraticCurveTo(mid.x, mid.y, l1.x, l1.y);
      ctx.stroke();
      for (var lf = 0; lf < 4; lf++) {
        var lp = project(ln.u, 0.4 + lf * 0.9, 62);
        g.roundRect(ctx, lp.x - 5, lp.y, 10, 12, 2,
          lf % 2 ? PALETTE.white : PALETTE.teal);
      }
      ctx.restore();
    }
    if (ROUTE_LEN >= lo && ROUTE_LEN <= hi) {
      var dp = project(ROUTE_LEN, 1.75, 0);
      g.roundRect(ctx, dp.x - 60, dp.y - 90, 120, 90, 8, PALETTE.terracotta);
      g.roundRect(ctx, dp.x - 44, dp.y - 64, 88, 64, 6, PALETTE.shadow);
      g.glowCircle(ctx, dp.x, dp.y - 76, 14, PALETTE.lantern, 0.8);
    }

    // Hazards.
    for (i = 0; i < S.carts.length; i++) {
      var ct = S.carts[i];
      s = project(ct.u, ct.v, 0);
      if (ct.state === 'tele') {
        g.glowCircle(ctx, s.x, s.y, 18, PALETTE.lantern, 0.3 + 0.3 * Math.sin(S.t * 12));
      } else {
        g.roundRect(ctx, s.x - 16, s.y - 22, 32, 22, 4, PALETTE.sandstone);
        g.roundRect(ctx, s.x - 14, s.y - 6, 8, 8, 4, PALETTE.outline);
        g.roundRect(ctx, s.x + 6, s.y - 6, 8, 8, 4, PALETTE.outline);
      }
    }
    for (i = 0; i < S.dogs.length; i++) {
      var dg = S.dogs[i];
      s = project(dg.u, dg.v, 0);
      if (dg.state === 'tele') {
        g.glowCircle(ctx, s.x, s.y - 8, 12, PALETTE.lantern, 0.5);
        g.text(ctx, '!', s.x, s.y - 22, { font: 'bold 14px monospace', color: PALETTE.terracotta });
      }
      g.roundRect(ctx, s.x - 10, s.y - 10, 20, 10, 4, PALETTE.outline);
      g.roundRect(ctx, s.x + (dg.u < S.u ? 8 : -12), s.y - 15, 6, 7, 2, PALETTE.outline);
    }
    var rv = S.rival;
    if (rv.state === 'ride' && rv.u >= lo && rv.u <= hi) {
      shadowBlob(ctx, rv.u, rv.v, 0);
      s = project(rv.u, rv.v, 8);
      g.roundRect(ctx, s.x - 13, s.y - 12, 26, 12, 5, PALETTE.rival);
      g.roundRect(ctx, s.x - 5, s.y - 20, 10, 9, 3, PALETTE.outline);
    }

    // Bundles in flight + their landing shadows.
    var list = world.projectiles.list;
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (p.dead || p.u == null) continue;
      shadowBlob(ctx, p.u, p.x / LANE_PX, -p.y);
      s = project(p.u, p.x / LANE_PX, -p.y);
      ctx.save();
      ctx.globalAlpha = p.alpha == null ? 1 : p.alpha;
      g.roundRect(ctx, s.x - 5, s.y - 4, 10, 8, 2, PALETTE.brass);
      ctx.restore();
    }

    // Dotted arc + landing-shadow throw preview (sling config mandates it).
    if (!S.reachedDepot) {
      var speed = 460 + world.tailwind.muzzleBonus();
      var simX = body.x, simY = body.y;
      var simVX = -speed * Math.cos(THROW_LOFT) + 0.5 * body.vx;
      var simVY = -speed * Math.sin(THROW_LOFT) + 0.5 * body.vy;
      var simU = S.u;
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = PALETTE.white;
      for (var st = 0; st < 22; st++) {
        simVY += 600 * 0.09;
        simX += simVX * 0.09;
        simY += simVY * 0.09;
        simU += S.uSpeed * 0.09;
        if (simY >= 0) break;
        if (st % 2 === 0) {
          var ds = project(simU, simX / LANE_PX, -simY);
          ctx.beginPath();
          ctx.arc(ds.x, ds.y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
      shadowBlob(ctx, simU, simX / LANE_PX, 0);
    }

    // Player: shadow blob at the true road point, craft lifted by h.
    shadowBlob(ctx, S.u, pv, ph);
    s = project(S.u, pv, ph);
    ctx.save();
    ctx.translate(s.x, s.y);
    if (S.air && S.air.fromRamp) ctx.rotate(-S.air.pitch);
    var proxy = { x: 0, y: 0, vx: body.vx, vy: body.vy, facing: body.facing, ribbon: body.ribbon };
    if (g.craft) g.craft(ctx, proxy, S.t, PALETTE);
    else g.roundRect(ctx, -14, -9, 28, 18, 7, PALETTE.brass);
    ctx.restore();

    // Heat-haze ripple above 70 heat + redline flash.
    if (S.heat.value > 70) {
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = PALETTE.white;
      for (i = 0; i < 4; i++) {
        ctx.fillRect(s.x - 22 + Math.sin(S.t * 18 + i * 2) * 4, s.y + 4 + i * 3, 44, 2);
      }
      ctx.restore();
    }
    if (S.heat.value >= REDLINE_LO) {
      g.glowCircle(ctx, s.x, s.y, 22, PALETTE.terracotta, 0.3 + 0.3 * Math.sin(S.t * 16));
    }

    // SIGNATURE MOMENT: mid-route the clouds break — god-rays sweep the road.
    if (S.u >= GODRAY_LO && S.u <= GODRAY_HI) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (i = 0; i < 5; i++) {
        ctx.globalAlpha = 0.07 + 0.03 * Math.sin(S.t * 0.9 + i);
        ctx.fillStyle = PALETTE.lantern;
        var gx = ((i * 230 + S.t * 40) % (W + 300)) - 150;
        ctx.beginPath();
        ctx.moveTo(gx, -20);
        ctx.lineTo(gx + 90, -20);
        ctx.lineTo(gx - 210, H + 20);
        ctx.lineTo(gx - 300, H + 20);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = PALETTE.lantern;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // Parallax 4 (1.3x): foreground railing posts whipping past.
    ctx.save();
    var postOff = (S.camU * 1.3) % 130;
    for (i = -1; i < 10; i++) {
      var px = i * 130 - postOff;
      var py = 430 + i * 14;
      g.roundRect(ctx, px, py, 10, 64, 3, PALETTE.shadow);
      g.roundRect(ctx, px - 8, py, 26, 8, 3, PALETTE.shadow);
    }
    ctx.restore();

    // FX are projected to screen space at emit time — render them here.
    if (world.particles && world.particles.draw) world.particles.draw(ctx);
    if (world.floaters && world.floaters.draw) world.floaters.draw(ctx);
  }

  return {
    key: 'switchback-post',
    title: 'Switchback Post',
    banner: 'LEG II — loft the bundle, ride the redline',
    palette: PALETTE,
    slingConfig: {
      muzzle: 460,
      inherit: 0.5,
      flatTime: 0,        // deliberate full-arc lofts — no rifled window
      gravity: 600,
      cadenceHeld: 1.6,
      fanCount: 1,
      fanSpreadDeg: 14,
      payloadTag: 'bundle',
    },
    init: init,
    update: update,
    draw: draw,
    isDone: isDone,
    // Test/debug hooks — not part of the stage contract; the machine never
    // calls them. Expose live state + the pure projection for headless tests.
    _state: function () { return S; },
    _project: projectAt,
  };
});
