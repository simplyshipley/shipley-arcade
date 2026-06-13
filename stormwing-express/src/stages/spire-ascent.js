/*
 * Stage 3 — THE STORM SPIRE. Vertical Contra x Joust climb: 8 screens up
 * the spire's interior shaft as dusk sinks below. Ratcheting camera (never
 * scrolls down), updraft catch on fall-out, perch burst-recharge,
 * alternating telegraphed wind gusts, camera-height-keyed spawns (no
 * wall-clock starvation), egg-hatch cleanup pressure, the roost-carrier
 * dropship beat, and an airborne-only brazier sling finish.
 * Pure logic in update(); draw() only renders. Spec: design-spec stages[2].
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../core.js'),
      require('../core/physics.js'),
      require('../core/collision.js'),
      require('../core/spawner.js')
    );
  } else {
    (root.Stages = root.Stages || {})['spire-ascent'] =
      factory(root.Core, root.Physics, root.Collision, root.Spawner);
  }
})(typeof self !== 'undefined' ? self : this, function (Core, Physics, Collision, Spawner) {
  'use strict';

  var RAD = Math.PI / 180;

  // ── Spec-pinned numbers (design-spec stages[2] + sharedSystems) ──────
  var SCREENS = 8;
  var SCREEN_H = 600;
  var SHAFT_H = SCREENS * SCREEN_H;     // 4800 px shaft, bottom y=4800 → top y=0
  var CAM_START = SHAFT_H - SCREEN_H;   // 4200 — camera top-of-view at stage start
  var GUST_PERIOD = 6;                  // s per wind direction (alternates)
  var GUST_TELEGRAPH = 1.0;             // s horizontal-streak telegraph
  var GUST_DRIFT = 80;                  // px/s drift while blowing
  var CADENCE = 2.5;                    // held shots/s
  var BURST_CADENCE = 5;                // perch-recharged rapid burst rate
  var BURST_SHOTS = 3;                  // volleys per perch recharge
  var AIM_BASE = -60 * RAD;             // default up-forward shot angle
  var AIM_TILT = 30 * RAD;              // hold left/right while firing: ±30°
  var POD_HP = 2;
  var POD_SHOT_SPEED = 180;             // px/s aimed single shots
  var POD_PERIOD = 2.0;                 // s between pod shots
  var POD_TELEGRAPH = 0.4;              // s glow telegraph (spec-pinned; shot
                                        // travel time supplies the rest of the
                                        // >=0.8s danger budget)
  var CHICK_LUNGE_SPEED = 150;          // px/s horizontal lunge
  var HUNTER_MULT = 1.3;                // hunter chicks: 1.3x speed
  var EGG_HATCH = 6;                    // s on a ledge before hatching
  var CARRIER_HP = 4;
  var CARRIER_DEPOSIT = 2;              // chicks dropped if it crosses alive
  var MASONRY_TELEGRAPH = 1.0;          // s dust puffs at the source
  var EEL_TELEGRAPH = 1.2;              // s glow telegraph
  var EEL_LIVE = 2.0;                   // s the barrier stays live
  var FAN_TIME = 10;                    // s Split Feather 3-way fan
  var FAN_COUNT = 3;
  var CAPSULE_EVERY = 1500;             // px climb ≈ 25s at the ~60 px/s nominal ascent
  var CARRIER_EVERY = 1200;             // px climb ≈ 20s of climb
  var CHECKPOINT_Y = SHAFT_H / 2;       // 2400 — half-height checkpoint ring
  var HITSTOP = 0.04;                   // 40ms on duel kills (shared juice stack)

  // ── Tuned values the spec leaves unpinned ────────────────────────────
  var CAM_ANCHOR = 270;                 // player held ~45% from view top while climbing
  var UPDRAFT_MARGIN = 40;              // px below view bottom before the catch
  var WALL_L = 70;                      // inner shaft faces
  var WALL_R = 890;
  var FLOOR_Y = 4760;                   // start pad at the shaft bottom
  var CEIL_Y = 170;                     // flight cap below the brazier
  var CLOUD_BREAK_CAMY = 1530;          // camera enters screen 6 → deck breaks
  var POD_EVERY = 430;                  // px climb between wall pods
  var CHICK_EVERY = 380;
  var MASONRY_EVERY = 340;
  var EEL_EVERY = 560;
  var CARRIER_SPEED = 110;              // px/s shaft crossing
  var MASONRY_FALL_CAP = 460;           // px/s terminal chunk speed
  var ITEM_GRAV = 600;                  // eggs / masonry / capsule (projectile gravity)
  var CHICK_MIRROR = 1.5;               // s mirroring before the lunge telegraph
  var CHICK_AIM = 0.8;                  // s lunge telegraph (>= 0.8s rule)
  var CHICK_LUNGE_TIME = 1.2;
  var VICTORY_HOLD = 2.0;               // s lit-beacon hold before isDone
  var EEL_HIT = 14;                     // px vertical band of a live eel
  var R_PLAYER = 12, R_SHOT = 6, R_POD = 14, R_PODSHOT = 6, R_CHICK = 10,
      R_EGG = 9, R_MASONRY = 12, R_CARRIER = 22, R_CAPSULE = 12;
  var BRAZIER = { x: 480, y: 110, r: 26 };

  // ── State (module closure; checkpoint survives requestRestart) ──────
  var S = null;
  var restartPending = false;
  var checkpointReached = false;
  var stars = null;                     // draw-only; local rng, spawns untouched

  function climb() { return CAM_START - S.camY; }

  function puff(world, x, y, color, count, speed) {
    var P = world.particles;
    if (P && P.burst) P.burst({ x: x, y: y, count: count || 10, color: color, speed: speed || 120 });
  }
  function preset(world, name, x, y, opts) {
    var P = world.particles;
    if (P && P.preset) P.preset(name, x, y, opts);
  }
  function sfx(world, name, arg) {
    if (world.audio && typeof world.audio.sfx === 'function') world.audio.sfx(name, arg);
  }
  function floater(world, x, y, text, color) {
    if (world.floaters && world.floaters.add) world.floaters.add(x, y, text, color);
  }
  function trauma(world, amount) {
    if (!world.camera) return;
    if (world.camera.addTrauma) world.camera.addTrauma(amount);
    else if (world.camera.shake) world.camera.shake(amount * 10, 0.3);
  }

  // Route ALL player damage through hull + tailwind (contract).
  function damagePlayer(world, opts) {
    opts = opts || {};
    var res = world.hull.damage(1);
    if (res === 'shrugged') return false;
    world.tailwind.damage();
    trauma(world, opts.trauma == null ? 0.4 : opts.trauma);
    var body = world.physics;
    if (opts.knockX != null) body.vx = opts.knockX;
    if (opts.knockY != null) body.vy = opts.knockY;
    puff(world, body.x, body.y, '#ff7a3c', 14, 160);
    if (res === 'gameover') {
      // Hull empty: restart at the half-height checkpoint ring (or base).
      restartPending = true;
      world.requestRestart('spire-ascent:' + (checkpointReached ? 'checkpoint' : 'base'));
    }
    return true;
  }

  // ── Spawn callbacks (deterministic: positions from world.rng in fire order) ──
  function spawnPod() {
    S.podSide = -S.podSide;
    var x = S.podSide < 0 ? WALL_L + 16 : WALL_R - 16;
    var y = S.camY - 40 - S.rngRef() * 60;
    S.pods.push({ x: x, y: y, side: S.podSide, hp: POD_HP, state: 'idle', t: 0.8 + S.rngRef() * 0.8 });
    S.spawnLog.push('pod:' + Math.round(x) + ',' + Math.round(y));
  }
  function spawnChick() {
    var x = 200 + S.rngRef() * 560;
    S.chicks.push({
      x: x, y: S.camY - 30, vx: 0, vy: 0,
      state: 'mirror', t: 0, dir: 1, hunter: false, contactCool: 0,
    });
    S.spawnLog.push('chick:' + Math.round(x));
  }
  function spawnMasonry() {
    var x = WALL_L + 70 + S.rngRef() * (WALL_R - WALL_L - 140);
    S.masonry.push({ x: x, y: S.camY - 20, vy: 0, state: 'tele', t: MASONRY_TELEGRAPH });
    S.spawnLog.push('rock:' + Math.round(x));
  }
  function spawnEel() {
    var y = S.camY + 120;
    S.eels.push({ y: y, state: 'tele', t: EEL_TELEGRAPH });
    S.spawnLog.push('eel:' + Math.round(y));
  }
  function spawnCarrier() {
    if (S.carrier) return;              // one dropship beat at a time
    S.carrierDir = -S.carrierDir;
    var dir = S.carrierDir;
    S.carrier = {
      x: dir > 0 ? WALL_L + 10 : WALL_R - 10,
      y: S.camY + 150, dir: dir, hp: CARRIER_HP,
    };
    S.spawnLog.push('carrier:' + dir);
  }
  function spawnCapsule() {
    if (S.capsule) return;
    var x = 240 + S.rngRef() * 480;
    S.capsule = { x: x, y: S.camY - 30, vy: 45, balloon: true };
    S.spawnLog.push('capsule:' + Math.round(x));
  }

  function spawnHunter(x, y) {
    S.chicks.push({
      x: x, y: y, vx: 0, vy: 0,
      state: 'mirror', t: 0, dir: 1, hunter: true, contactCool: 0,
    });
  }

  // ── init / restart-checkpoint ────────────────────────────────────────
  function init(world) {
    var resume = restartPending && checkpointReached;
    if (!restartPending) checkpointReached = false;
    restartPending = false;

    // Gargoyle ledges: fixed deterministic layout, alternating walls.
    var perches = [];
    var cycle = [170, 790, 480];
    var ci = 0;
    for (var py = 4460; py >= 640; py -= 240) {
      perches.push({ x: cycle[ci % 3], y: py, w: 110 });
      ci++;
    }
    var checkpointLedge = { x: 480, y: CHECKPOINT_Y + 40, w: 130 };
    perches.push(checkpointLedge);

    var startPad = { x: 480, y: FLOOR_Y, w: WALL_R - WALL_L, pad: true };
    var startY = resume ? checkpointLedge.y : FLOOR_Y;
    var startCam = resume ? Math.max(0, checkpointLedge.y - CAM_ANCHOR) : CAM_START;

    S = {
      t: 0,
      camY: startCam,
      prevY: startY,
      hitstopT: 0,
      gust: { dir: 1, state: 'tele', t: GUST_TELEGRAPH },
      burstShots: 0,
      onPerch: resume ? checkpointLedge : null,
      lastPerch: resume ? checkpointLedge : startPad,
      grounded: true,
      perches: perches,
      pods: [], podShots: [], chicks: [], eggs: [], masonry: [], eels: [],
      carrier: null, carrierDir: 1, capsule: null, fanT: 0,
      podSide: 1,
      track: null, spawnLog: [],
      rngRef: world.rng,
      cloudBroken: false,
      lit: false, victoryT: 0,
    };

    var body = world.physics;
    body.x = 480;
    body.y = startY;
    body.vx = 0;
    body.vy = 0;
    body.facing = 1;

    // Camera-height-keyed timeline: same seed + same climb → same waves.
    var base = CAM_START - startCam;
    S.track = new Spawner.Track(world.rng);
    S.track.every(POD_EVERY, spawnPod, { start: base + 360, jitter: 0.2 });
    S.track.every(CHICK_EVERY, spawnChick, { start: base + 300, jitter: 0.25 });
    S.track.every(MASONRY_EVERY, spawnMasonry, { start: base + 260, jitter: 0.3 });
    S.track.every(EEL_EVERY, spawnEel, { start: base + 520, jitter: 0.2 });
    S.track.every(CARRIER_EVERY, spawnCarrier, { start: base + 1050 });
    S.track.every(CAPSULE_EVERY, spawnCapsule, { start: base + 1300 });

    if (!stars) {
      var rng = Core.makeRng(173);
      stars = [];
      for (var i = 0; i < 110; i++) {
        stars.push({ x: rng() * 960, y: rng() * 560, r: 0.5 + rng() * 1.4, tw: rng() * 6.28 });
      }
    }
  }

  // ── Player ───────────────────────────────────────────────────────────
  function markShots(spawned, airborne) {
    for (var i = 0; i < spawned.length; i++) spawned[i].airborne = airborne;
  }

  function landOn(p, world) {
    var body = world.physics;
    body.y = p.y;
    body.vy = 0;
    if (S.onPerch !== p) {
      S.onPerch = p;
      S.lastPerch = p;
      S.burstShots = BURST_SHOTS;       // perch burst-recharge: 3 shots at 5/s
      world.projectiles.configure({ cadenceHeld: BURST_CADENCE });
      floater(world, p.x, p.y - 18, 'BURST +' + BURST_SHOTS, '#6ef0ff');
      preset(world, 'dust', body.x, p.y);
    }
  }

  function updraftCheck(world) {
    if (S.lit) return;                  // no danger after the beacon is lit
    var body = world.physics;
    if (body.y - S.camY <= world.H + UPDRAFT_MARGIN) return;
    // Updraft catch: lose 1 hull, set on the last touched perch — never
    // an instant death (spec). The camera never scrolls down, so if the
    // last perch has scrolled out below, fall back to a perch still in
    // view (else the catch would loop).
    damagePlayer(world, { trauma: 0.4 });
    var spot = S.lastPerch;
    if (!spot || spot.y > S.camY + world.H - 24) {
      spot = null;
      for (var i = 0; i < S.perches.length; i++) {
        var p = S.perches[i];
        if (p.y >= S.camY + 80 && p.y <= S.camY + world.H - 24 &&
            (!spot || p.y > spot.y)) {
          spot = p;
        }
      }
    }
    if (spot) {
      body.x = spot.x;
      body.y = spot.y;
      S.onPerch = spot;                 // a catch is a penalty, not a landing:
      S.lastPerch = spot;               // no burst recharge here
    } else {
      body.x = 480;
      body.y = S.camY + world.H - 80;
    }
    body.vx = 0;
    body.vy = 0;
    S.grounded = !!spot;
    floater(world, body.x, body.y - 24, 'UPDRAFT CATCH', '#6ef0ff');
    preset(world, 'spray', body.x, body.y + 20);
  }

  function updatePlayer(dt, world) {
    var body = world.physics;
    var input = world.input;
    var axis = input.axis();
    Physics.steer(body, axis.x, dt);
    if (input.justPressed(' ') || input.justPressed('z')) {
      Physics.flap(body);
      S.onPerch = null;
      S.grounded = false;
    }

    // Empty-field slings cost nothing — unlimited ammo, no penalties.
    if (input.justPressed('x') && axis.y > 0) {
      markShots([world.projectiles.straightDrop(body)], !S.grounded);
    } else if (input.held('x')) {
      // Aim: default up-forward; holding left/right while firing tilts the
      // shot 30° toward the horizon — ±30° in world space via facing.
      var angle = AIM_BASE + (axis.x !== 0 ? AIM_TILT : 0);
      var spawned = world.projectiles.holdFire(body, dt, {
        angle: angle,
        muzzleBonus: world.tailwind.muzzleBonus(),
      });
      if (spawned.length > 0) {
        markShots(spawned, !S.grounded);
        if (S.burstShots > 0) {
          S.burstShots -= 1;
          if (S.burstShots === 0) world.projectiles.configure({ cadenceHeld: CADENCE });
        }
      }
    }

    var windX = S.gust.state === 'blow' ? S.gust.dir * GUST_DRIFT : 0;
    S.prevY = body.y;
    Physics.integrate(body, dt, { windX: windX });

    // Shaft walls and caps.
    if (body.x < WALL_L + R_PLAYER) { body.x = WALL_L + R_PLAYER; if (body.vx < 0) body.vx = 0; }
    if (body.x > WALL_R - R_PLAYER) { body.x = WALL_R - R_PLAYER; if (body.vx > 0) body.vx = 0; }
    if (body.y < CEIL_Y) { body.y = CEIL_Y; if (body.vy < 0) body.vy = 0; }

    // Leaving the current perch (walked off the edge or lifted away).
    if (S.onPerch) {
      var op = S.onPerch;
      if (Math.abs(body.x - op.x) > op.w / 2 || body.y < op.y - 2) S.onPerch = null;
    }
    S.grounded = false;
    if (body.y >= FLOOR_Y) {
      body.y = FLOOR_Y;
      if (body.vy > 0) body.vy = 0;
      S.grounded = true;
      S.lastPerch = { x: body.x, y: FLOOR_Y, w: WALL_R - WALL_L, pad: true };
    } else if (body.vy > 0) {
      // One-way gargoyle ledges (top side only).
      for (var i = 0; i < S.perches.length; i++) {
        var p = S.perches[i];
        if (S.prevY <= p.y && body.y >= p.y && Math.abs(body.x - p.x) <= p.w / 2) {
          landOn(p, world);
          break;
        }
      }
    }
    if (S.onPerch) S.grounded = true;

    updraftCheck(world);
  }

  function updateCamera(world) {
    // Ratchet: the camera climbs with the player and NEVER scrolls down.
    var target = world.physics.y - CAM_ANCHOR;
    if (target < S.camY) S.camY = target;
    if (S.camY < 0) S.camY = 0;
    if (world.camera) {
      world.camera.x = 0;
      world.camera.y = S.camY;
    }
    if (!S.cloudBroken && S.camY <= CLOUD_BREAK_CAMY) {
      // SIGNATURE MOMENT (screen 6): break above the cloud deck — sky snaps
      // to midnight starfield, rain stops, beacon glow appears above.
      S.cloudBroken = true;
      floater(world, 480, S.camY + 150, 'ABOVE THE CLOUDS', '#c9b8e8');
      sfx(world, 'telegraph');
    }
  }

  function updateGust(dt, world) {
    var g = S.gust;
    g.t -= dt;
    if (g.t <= 0) {
      if (g.state === 'tele') {
        g.state = 'blow';
        g.t = GUST_PERIOD - GUST_TELEGRAPH;
      } else {
        g.dir = -g.dir;                 // alternate left/right every 6s
        g.state = 'tele';
        g.t = GUST_TELEGRAPH;
        sfx(world, 'telegraph');
      }
    }
    if (g.state === 'tele' && Math.random() < 0.4) {
      // Horizontal streak telegraph for the incoming direction (cosmetic).
      puff(world, g.dir > 0 ? WALL_L + 20 : WALL_R - 20,
        S.camY + 80 + Math.random() * 440, '#c9b8e8', 2, GUST_DRIFT * 2);
    }
  }

  function updateProjectiles(dt, world) {
    world.projectiles.update(dt);
    var list = world.projectiles.list;
    for (var i = 0; i < list.length; i++) {
      var pr = list[i];
      if (pr.x < WALL_L + 2 || pr.x > WALL_R - 2 || pr.y < 30 ||
          pr.y > S.camY + world.H + 120) {
        pr.dead = true;                 // shots die on the shaft walls / off-view
      }
    }
  }

  // ── Turret pods (Contra wall guns; stubs become perches) ────────────
  function updatePods(dt, world) {
    var body = world.physics;
    for (var i = S.pods.length - 1; i >= 0; i--) {
      var pod = S.pods[i];
      if (pod.y > S.camY + world.H + 200) { S.pods.splice(i, 1); continue; } // scrolled out forever
      var onScreen = pod.y >= S.camY - 10 && pod.y <= S.camY + world.H + 10;
      if (onScreen) {
        pod.t -= dt;
        if (pod.state === 'idle') {
          if (pod.t <= 0) {
            pod.state = 'tele';         // 0.4s glow telegraph (spec-pinned)
            pod.t = POD_TELEGRAPH;
            sfx(world, 'telegraph');
          }
        } else if (pod.t <= 0) {
          pod.state = 'idle';
          pod.t = POD_PERIOD;
          var dx = body.x - pod.x, dy = body.y - pod.y;
          var d = Math.sqrt(dx * dx + dy * dy) || 1;
          S.podShots.push({
            x: pod.x, y: pod.y,
            vx: dx / d * POD_SHOT_SPEED,
            vy: dy / d * POD_SHOT_SPEED,
          });
        }
      }
      var list = world.projectiles.list;
      for (var j = 0; j < list.length; j++) {
        var pr = list[j];
        if (pr.dead) continue;
        if (Collision.circleHit(pr.x, pr.y, R_SHOT, pod.x, pod.y, R_POD)) {
          pr.dead = true;
          pod.hp -= 1;
          puff(world, pod.x, pod.y, '#ffc14d', 6, 90);
          if (pod.hp <= 0) {
            var pts = world.score.add('kill');
            // A destroyed pod leaves a usable perch stub.
            S.perches.push({ x: pod.x + (pod.side < 0 ? 26 : -26), y: pod.y, w: 46, stub: true });
            floater(world, pod.x, pod.y - 16, '+' + pts + ' PERCH STUB', '#c9b8e8');
            puff(world, pod.x, pod.y, '#1c2241', 14, 150);
            S.pods.splice(i, 1);
          }
          break;
        }
      }
    }
    for (var k = S.podShots.length - 1; k >= 0; k--) {
      var sh = S.podShots[k];
      sh.x += sh.vx * dt;
      sh.y += sh.vy * dt;
      if (sh.x < WALL_L || sh.x > WALL_R ||
          sh.y < S.camY - 60 || sh.y > S.camY + world.H + 60) {
        S.podShots.splice(k, 1);
        continue;
      }
      if (Collision.circleHit(sh.x, sh.y, R_PODSHOT, body.x, body.y, R_PLAYER)) {
        S.podShots.splice(k, 1);
        damagePlayer(world, { trauma: 0.4 });
      }
    }
  }

  // ── Roc chicks + hunter chicks (Joust light-fliers) ─────────────────
  function killChick(world, c, idx) {
    S.hitstopT = HITSTOP;               // 40ms hitstop on duel kills
    var pts = world.score.add('kill');
    if (!c.hunter) {
      // Joust cleanup pressure: only first-generation chicks drop eggs
      // (hunters hatching fresh eggs would loop forever).
      S.eggs.push({ x: c.x, y: c.y, vx: 0, vy: -60, landed: false, hatchT: EGG_HATCH });
    }
    preset(world, 'feathers', c.x, c.y);
    floater(world, c.x, c.y - 16, '+' + pts, '#ffd27a');
    S.chicks.splice(idx, 1);
  }

  function updateChicks(dt, world) {
    var body = world.physics;
    for (var i = S.chicks.length - 1; i >= 0; i--) {
      var c = S.chicks[i];
      var mul = c.hunter ? HUNTER_MULT : 1;
      if (c.contactCool > 0) c.contactCool -= dt;
      if (c.state === 'mirror') {
        // Mirror the player's altitude, drift in.
        c.y += Core.clamp(body.y - c.y, -120 * mul * dt, 120 * mul * dt);
        c.x += (body.x > c.x ? 40 : -40) * mul * dt;
        c.t += dt;
        if (c.t >= CHICK_MIRROR / mul) {
          c.state = 'aim';              // lunge telegraph (>= 0.8s rule)
          c.t = 0;
          var aimX = c.hunter ? body.x + body.vx * 0.5 : body.x; // hunters predict
          c.dir = aimX >= c.x ? 1 : -1;
        }
      } else if (c.state === 'aim') {
        c.t += dt;
        if (c.t >= CHICK_AIM) {
          c.state = 'lunge';
          c.t = 0;
          c.vx = c.dir * CHICK_LUNGE_SPEED * mul;
        }
      } else {
        c.x += c.vx * dt;
        if (c.hunter) c.y += Core.clamp(body.y - c.y, -60 * dt, 60 * dt); // tracks the arc
        c.t += dt;
        if (c.t >= CHICK_LUNGE_TIME) {
          c.state = 'mirror';
          c.t = 0;
          c.vx = 0;
        }
      }
      c.x = Core.clamp(c.x, WALL_L + R_CHICK, WALL_R - R_CHICK);

      // Player shots kill chicks (1 HP).
      var killed = false;
      var list = world.projectiles.list;
      for (var j = 0; j < list.length; j++) {
        var pr = list[j];
        if (pr.dead) continue;
        if (Collision.circleHit(pr.x, pr.y, R_SHOT, c.x, c.y, R_CHICK + 2)) {
          pr.dead = true;
          killChick(world, c, i);
          killed = true;
          break;
        }
      }
      if (killed) continue;

      // ALTITUDE DUEL on contact (shared collision core).
      if (c.contactCool <= 0 &&
          Collision.circleHit(body.x, body.y, R_PLAYER, c.x, c.y, R_CHICK)) {
        var verdict = Collision.altitudeDuel(body, c);
        if (verdict === 'kill') {
          body.vy = -160;               // Joust kill rebound
          killChick(world, c, i);
        } else if (verdict === 'hurt') {
          c.contactCool = 0.6;
          var away = body.x >= c.x ? 1 : -1;
          damagePlayer(world, { trauma: 0.4, knockX: away * 200, knockY: -140 });
        } else {
          Collision.bounce(body, c);
          c.contactCool = 0.3;
        }
      }
    }
  }

  // ── Eggs: catch midair, or they hatch into hunters on a ledge ───────
  function updateEggs(dt, world) {
    var body = world.physics;
    for (var i = S.eggs.length - 1; i >= 0; i--) {
      var e = S.eggs[i];
      if (!e.landed) {
        e.vy += ITEM_GRAV * dt;
        var prevY = e.y;
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        if (e.vy > 0) {
          for (var j = 0; j < S.perches.length; j++) {
            var p = S.perches[j];
            if (prevY <= p.y && e.y >= p.y && Math.abs(e.x - p.x) <= p.w / 2) {
              e.landed = true;          // 6s hatch clock starts (pulse in draw)
              e.y = p.y - 6;
              e.vy = 0;
              break;
            }
          }
          if (!e.landed && e.y >= FLOOR_Y - 6) {
            e.landed = true;            // the start pad counts as a ledge
            e.y = FLOOR_Y - 6;
            e.vy = 0;
          }
        }
      } else {
        e.hatchT -= dt;
        if (e.hatchT <= 0) {
          S.eggs.splice(i, 1);
          spawnHunter(e.x, e.y - 8);    // 1 HP, 1.3x speed, predicts trajectory
          floater(world, e.x, e.y - 14, 'HATCHED!', '#ff7a3c');
          preset(world, 'feathers', e.x, e.y);
          sfx(world, 'telegraph');
          continue;
        }
      }
      if (Collision.circleHit(body.x, body.y, R_PLAYER, e.x, e.y, R_EGG)) {
        var pts = world.score.add('eggCatch');   // +250 and a combo tier
        floater(world, e.x, e.y, '+' + pts, '#ffd27a');
        S.eggs.splice(i, 1);
        continue;
      }
      if (!e.landed && e.y > S.camY + world.H + 250) {
        S.eggs.splice(i, 1);            // a lost egg costs nothing
      }
    }
  }

  // ── Roost carrier (Contra dropship beat) ────────────────────────────
  function updateCarrier(dt, world) {
    var cr = S.carrier;
    if (!cr) return;
    cr.x += cr.dir * CARRIER_SPEED * dt;
    var list = world.projectiles.list;
    for (var i = 0; i < list.length; i++) {
      var pr = list[i];
      if (pr.dead) continue;
      if (Collision.circleHit(pr.x, pr.y, R_SHOT, cr.x, cr.y, R_CARRIER)) {
        pr.dead = true;
        cr.hp -= 1;
        puff(world, pr.x, pr.y, '#ffc14d', 6, 90);
        if (cr.hp <= 0) {
          var pts = world.score.add('kill');
          floater(world, cr.x, cr.y - 24, '+' + pts + ' CARRIER DOWN', '#6ef0ff');
          preset(world, 'feathers', cr.x, cr.y);
          trauma(world, 0.3);
          S.carrier = null;
          return;
        }
      }
    }
    if ((cr.dir > 0 && cr.x >= WALL_R - 30) || (cr.dir < 0 && cr.x <= WALL_L + 30)) {
      // Crossed alive: deposits 2 chicks onto the nearest in-view perches.
      var spots = [];
      for (var j = 0; j < S.perches.length; j++) {
        var p = S.perches[j];
        if (p.y >= S.camY && p.y <= S.camY + world.H) spots.push(p);
      }
      spots.sort(function (a, b) { return Math.abs(a.y - cr.y) - Math.abs(b.y - cr.y); });
      for (var k = 0; k < CARRIER_DEPOSIT; k++) {
        var spot = spots[k];
        if (spot) {
          S.chicks.push({
            x: spot.x, y: spot.y - 12, vx: 0, vy: 0,
            state: 'mirror', t: 0, dir: 1, hunter: false, contactCool: 0,
          });
        } else {
          spawnHunter(cr.x, cr.y);      // no ledge in view: drops them in flight
        }
      }
      floater(world, cr.x, cr.y - 24, 'ROOST DROPPED', '#ff7a3c');
      S.carrier = null;
    }
  }

  // ── Falling masonry ──────────────────────────────────────────────────
  function updateMasonry(dt, world) {
    var body = world.physics;
    for (var i = S.masonry.length - 1; i >= 0; i--) {
      var m = S.masonry[i];
      if (m.state === 'tele') {
        m.t -= dt;
        if (Math.random() < 0.35) preset(world, 'dust', m.x, m.y + 6);
        if (m.t <= 0) m.state = 'fall';
      } else {
        m.vy += ITEM_GRAV * dt;
        if (m.vy > MASONRY_FALL_CAP) m.vy = MASONRY_FALL_CAP;
        m.y += m.vy * dt;
        if (m.y > S.camY + world.H + 80) { S.masonry.splice(i, 1); continue; }
        if (Collision.circleHit(m.x, m.y, R_MASONRY, body.x, body.y, R_PLAYER)) {
          S.masonry.splice(i, 1);
          damagePlayer(world, { trauma: 0.45 });
          continue;
        }
      }
      var list = world.projectiles.list;
      for (var j = 0; j < list.length; j++) {
        var pr = list[j];
        if (pr.dead) continue;
        if (Collision.circleHit(pr.x, pr.y, R_SHOT, m.x, m.y, R_MASONRY)) {
          pr.dead = true;
          // SPEC-DEVIATION: spec awards +50 for a masonry smash; the contract
          // masonry smashes score their own masonrySmash type.
          var pts = world.score.add('masonrySmash');
          floater(world, m.x, m.y, '+' + pts, '#c9b8e8');
          preset(world, 'dust', m.x, m.y);
          S.masonry.splice(i, 1);
          break;
        }
      }
    }
  }

  // ── Storm eels (temporary horizontal barriers) ──────────────────────
  function updateEels(dt, world) {
    var body = world.physics;
    for (var i = S.eels.length - 1; i >= 0; i--) {
      var e = S.eels[i];
      e.t -= dt;
      if (e.state === 'tele') {
        if (e.t <= 0) {
          e.state = 'live';             // 1.2s glow telegraph → live 2s
          e.t = EEL_LIVE;
          sfx(world, 'telegraph');
        }
      } else {
        if (Math.abs(body.y - e.y) < EEL_HIT) {
          damagePlayer(world, { trauma: 0.5, knockY: body.y > e.y ? 180 : -180 });
        }
        if (e.t <= 0) S.eels.splice(i, 1);
      }
    }
  }

  // ── Split Feather capsule (the one pickup in the game) ──────────────
  function updateCapsule(dt, world) {
    var cap = S.capsule;
    if (!cap) return;
    if (cap.balloon) {
      cap.y += cap.vy * dt;             // drifts down on the balloon
      var list = world.projectiles.list;
      for (var i = 0; i < list.length; i++) {
        var pr = list[i];
        if (pr.dead) continue;
        if (Collision.circleHit(pr.x, pr.y, R_SHOT, cap.x, cap.y - 16, R_CAPSULE)) {
          pr.dead = true;
          cap.balloon = false;          // popped: falls, touch to collect
          cap.vy = 0;
          puff(world, cap.x, cap.y - 16, '#6ef0ff', 8, 100);
          break;
        }
      }
    } else {
      cap.vy += ITEM_GRAV * dt;
      cap.y += cap.vy * dt;
    }
    var body = world.physics;
    if (Collision.circleHit(body.x, body.y, R_PLAYER, cap.x, cap.y, R_CAPSULE)) {
      S.fanT = FAN_TIME;                // 3-way 14° fan for 10s
      world.projectiles.configure({ fanCount: FAN_COUNT });
      floater(world, cap.x, cap.y, 'SPLIT FEATHER', '#6ef0ff');
      S.capsule = null;
      return;
    }
    if (cap.y > S.camY + world.H + 60) S.capsule = null; // drifts away, costs nothing
  }

  // ── The brazier: airborne-only sling finish ──────────────────────────
  function updateBrazier(world) {
    if (S.lit) return;
    var list = world.projectiles.list;
    for (var i = 0; i < list.length; i++) {
      var pr = list[i];
      if (pr.dead) continue;
      if (Collision.circleHit(pr.x, pr.y, 8, BRAZIER.x, BRAZIER.y, BRAZIER.r)) {
        pr.dead = true;
        if (pr.airborne === true) {
          // The run's arc-skill exam, passed: WIN — brazier lit.
          S.lit = true;
          S.victoryT = 0;
          world.score.add('stageClear');
          trauma(world, 0.5);
          preset(world, 'embers', BRAZIER.x, BRAZIER.y, { count: 30 });
          floater(world, BRAZIER.x, BRAZIER.y + 34, 'THE SPIRE BEACON IS LIT', '#ff4da6');
          sfx(world, 'delivery');
        } else {
          // The lighting shot MUST be made from the air (spec).
          floater(world, BRAZIER.x, BRAZIER.y + 30, 'FROM THE AIR!', '#ffc14d');
          puff(world, pr.x, pr.y, '#5a6f8c', 4, 60);
        }
        break;
      }
    }
  }

  function updateCheckpoint(world) {
    if (checkpointReached) return;
    if (world.physics.y <= CHECKPOINT_Y) {
      checkpointReached = true;
      floater(world, 480, CHECKPOINT_Y - 20, 'CHECKPOINT RING', '#6ef0ff');
      preset(world, 'confetti', 480, CHECKPOINT_Y, { color: '#6ef0ff' });
      sfx(world, 'delivery');
    }
  }

  // The tailwind decay clock only ticks while scorable targets share the
  // screen (eels are invulnerable — not targets).
  function targetsVisible(world) {
    if (S.lit) return false;
    var lo = S.camY - 40, hi = S.camY + world.H + 40;
    function inView(y) { return y >= lo && y <= hi; }
    var i;
    for (i = 0; i < S.pods.length; i++) if (inView(S.pods[i].y)) return true;
    for (i = 0; i < S.chicks.length; i++) if (inView(S.chicks[i].y)) return true;
    for (i = 0; i < S.masonry.length; i++) if (inView(S.masonry[i].y)) return true;
    for (i = 0; i < S.eggs.length; i++) if (inView(S.eggs[i].y)) return true;
    if (S.carrier && inView(S.carrier.y)) return true;
    return false;
  }

  function publishHud(world) {
    var screen = Core.clamp(Math.ceil((SHAFT_H - world.physics.y) / SCREEN_H), 1, SCREENS);
    world.hud.height = {
      label: 'SPIRE',
      value: screen + '/' + SCREENS,
      ratio: Core.clamp(climb() / CAM_START, 0, 1),
    };
    world.hud.burst = {
      label: 'BURST',
      value: S.burstShots > 0 ? 'x' + S.burstShots : '--',
    };
    if (S.lit) world.hud.beacon = { label: 'BEACON', value: 'LIT' };
  }

  // ── update ───────────────────────────────────────────────────────────
  function update(dt, world) {
    if (S.hitstopT > 0) {               // 40ms world-freeze on duel kills
      S.hitstopT -= dt;
      return;
    }
    var frameS = S;                     // requestRestart re-inits S mid-frame
    S.t += dt;
    // hull.update (i-frame decay) is the shell's per-frame job (game.js).
    world.tailwind.update(dt, targetsVisible(world));
    if (S.fanT > 0) {
      S.fanT -= dt;
      if (S.fanT <= 0) world.projectiles.configure({ fanCount: 1 });
    }

    updateGust(dt, world);
    updatePlayer(dt, world);
    if (S !== frameS) return;
    updateCamera(world);
    updateProjectiles(dt, world);

    if (S.lit) {
      S.victoryT += dt;
      updateEggs(dt, world);            // settle leftovers; no new hazards
      publishHud(world);
      return;
    }

    S.track.poll(climb());              // camera-height-keyed waves
    updatePods(dt, world);
    if (S !== frameS) return;
    updateChicks(dt, world);
    if (S !== frameS) return;
    updateEggs(dt, world);
    updateCarrier(dt, world);
    updateMasonry(dt, world);
    if (S !== frameS) return;
    updateEels(dt, world);
    if (S !== frameS) return;
    updateCapsule(dt, world);
    updateBrazier(world);
    updateCheckpoint(world);

    if (!S.cloudBroken && Math.random() < 0.5) {
      preset(world, 'rain', WALL_L + Math.random() * (WALL_R - WALL_L), S.camY - 8);
    }
    publishHud(world);
  }

  function isDone() {
    return !!(S && S.lit && S.victoryT >= VICTORY_HOLD);
  }

  // ── draw ─────────────────────────────────────────────────────────────
  var PALETTE = {
    skyTop: '#1c2241',                  // indigo stone dusk
    skyBottom: '#11152b',               // slate shaft shadows
    duskCoral: '#ff5e54',               // sinking dusk slot, top stop
    duskAmber: '#ffc14d',               // sinking dusk slot, bottom stop
    stone: '#1c2241',
    stoneDark: '#11152b',
    cyan: '#6ef0ff',                    // storm-cyan lightning
    magenta: '#ff4da6',                 // beacon embers
    lilac: '#c9b8e8',                   // pale cloud wisps
    brass: '#d9b36a',
    teal: '#2aa7a0',
    amber: '#ffd27a',
    ember: '#ff7a3c',
    midnightTop: '#05060f',
    outline: '#141821',
  };

  function drawEel(ctx, e, camY, W, t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = e.state === 'tele'
      ? 0.18 + 0.12 * Math.sin(t * 16)
      : 0.85;
    ctx.strokeStyle = PALETTE.cyan;
    ctx.lineWidth = e.state === 'tele' ? 2 : 4;
    ctx.beginPath();
    for (var x = WALL_L; x <= WALL_R; x += 24) {
      var jit = e.state === 'live' ? (Math.random() - 0.5) * 14 : Math.sin(x * 0.05 + t * 6) * 4;
      var y = e.y + jit;
      if (x === WALL_L) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function draw(ctx, world) {
    var g = world.gfx;
    var W = world.W, H = world.H;
    var body = world.physics;
    var camY = S.camY;
    var t = S.t;
    var climbRatio = Core.clamp(climb() / CAM_START, 0, 1);
    var i, p;

    // ── Sky: dusk sinking beneath you; midnight snap above the deck ──
    if (S.cloudBroken) {
      g.skyGradient(ctx, 0, 0, W, H, [[0, PALETTE.midnightTop], [1, '#101b33']]);
      ctx.save();
      ctx.fillStyle = PALETTE.lilac;
      for (i = 0; i < stars.length; i++) {
        var st = stars[i];
        ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.8 + st.tw));
        ctx.fillRect(st.x, st.y, st.r, st.r);
      }
      ctx.restore();
      g.glowCircle(ctx, W / 2, 26, 150, PALETTE.magenta, S.lit ? 0.8 : 0.22);
    } else {
      g.skyGradient(ctx, 0, 0, W, H, [[0, PALETTE.skyTop], [1, PALETTE.skyBottom]]);
      // The coral-to-amber dusk slot pinned at the bottom, receding as you climb.
      var duskH = H * (0.34 - 0.30 * climbRatio);
      if (duskH > 2) {
        ctx.save();
        ctx.globalAlpha = 0.8;
        g.skyGradient(ctx, 0, H - duskH, W, duskH,
          [[0, PALETTE.duskCoral], [1, PALETTE.duskAmber]]);
        ctx.restore();
      }
      // Parallax 0.05x: slow rotating cloud vortex over the dusk.
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = PALETTE.lilac;
      ctx.lineWidth = 8;
      for (i = 0; i < 4; i++) {
        var va = t * 0.12 + i * 1.6 + camY * 0.0002;
        ctx.beginPath();
        ctx.arc(W / 2, H + 80, 180 + i * 90, va, va + 2.1);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Parallax 0.2x: far spire ring details.
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = PALETTE.stoneDark;
    ctx.lineWidth = 10;
    var farOff = camY * 0.2;
    for (var ry = -(farOff % 220); ry < H + 20; ry += 220) {
      ctx.beginPath();
      ctx.moveTo(WALL_L - 30, ry);
      ctx.lineTo(WALL_R + 30, ry);
      ctx.stroke();
    }
    ctx.restore();

    // ── World space ──
    ctx.save();
    ctx.translate(0, -camY);

    // Shaft walls (with mortar courses every 80 px of world height).
    ctx.fillStyle = PALETTE.stone;
    ctx.fillRect(0, camY - 20, WALL_L, H + 40);
    ctx.fillRect(WALL_R, camY - 20, W - WALL_R, H + 40);
    ctx.save();
    ctx.strokeStyle = PALETTE.stoneDark;
    ctx.lineWidth = 3;
    for (var wy = Math.floor((camY - 20) / 80) * 80; wy < camY + H + 40; wy += 80) {
      ctx.beginPath();
      ctx.moveTo(0, wy); ctx.lineTo(WALL_L, wy);
      ctx.moveTo(WALL_R, wy); ctx.lineTo(W, wy);
      ctx.stroke();
    }
    // Rim light on the storm-lit faces.
    ctx.strokeStyle = 'rgba(201,184,232,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(WALL_L, camY - 20); ctx.lineTo(WALL_L, camY + H + 20);
    ctx.moveTo(WALL_R, camY - 20); ctx.lineTo(WALL_R, camY + H + 20);
    ctx.stroke();
    ctx.restore();

    // Start pad (visible only at the bottom).
    if (camY + H > FLOOR_Y) {
      g.roundRect(ctx, WALL_L, FLOOR_Y + 12, WALL_R - WALL_L, 60, 6, PALETTE.stoneDark);
    }

    // Gargoyle ledges + stubs.
    for (i = 0; i < S.perches.length; i++) {
      p = S.perches[i];
      if (p.y < camY - 30 || p.y > camY + H + 30) continue;
      g.roundRect(ctx, p.x - p.w / 2, p.y, p.w, 12, 5, p.stub ? '#2c3252' : PALETTE.stone);
      ctx.save();
      ctx.strokeStyle = 'rgba(201,184,232,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x - p.w / 2 + 4, p.y + 1);
      ctx.lineTo(p.x + p.w / 2 - 4, p.y + 1);
      ctx.stroke();
      ctx.restore();
    }

    // Half-height checkpoint ring.
    if (CHECKPOINT_Y > camY - 60 && CHECKPOINT_Y < camY + H + 60) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = PALETTE.cyan;
      ctx.globalAlpha = checkpointReached ? 0.25 : 0.5 + 0.25 * Math.sin(t * 4);
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(480, CHECKPOINT_Y, 48, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Spire cap + brazier.
    if (camY < 320) {
      g.roundRect(ctx, WALL_L, 150, WALL_R - WALL_L, 14, 5, PALETTE.stoneDark);
      g.roundRect(ctx, BRAZIER.x - 42, BRAZIER.y + 18, 84, 18, 5, PALETTE.brass);
      g.glowCircle(ctx, BRAZIER.x, BRAZIER.y, S.lit ? 72 : BRAZIER.r,
        PALETTE.magenta, S.lit ? 0.9 : 0.35 + 0.15 * Math.sin(t * 5));
    }

    // Turret pods (tele glow before each aimed shot).
    for (i = 0; i < S.pods.length; i++) {
      var pod = S.pods[i];
      if (pod.y < camY - 40 || pod.y > camY + H + 40) continue;
      if (pod.state === 'tele') g.glowCircle(ctx, pod.x, pod.y, 20, PALETTE.amber, 0.6);
      g.roundRect(ctx, pod.x - 13, pod.y - 11, 26, 22, 6, PALETTE.stoneDark);
      g.roundRect(ctx, pod.x - 6, pod.y - 5, 12, 10, 4, pod.hp > 1 ? PALETTE.amber : PALETTE.ember);
    }
    ctx.fillStyle = PALETTE.amber;
    for (i = 0; i < S.podShots.length; i++) {
      ctx.beginPath();
      ctx.arc(S.podShots[i].x, S.podShots[i].y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Falling masonry (telegraph marker, then the chunk).
    for (i = 0; i < S.masonry.length; i++) {
      var m = S.masonry[i];
      if (m.state === 'tele') {
        g.glowCircle(ctx, m.x, Math.max(m.y, camY + 12), 14, PALETTE.lilac,
          0.3 + 0.2 * Math.sin(t * 12));
      } else {
        g.roundRect(ctx, m.x - 11, m.y - 9, 22, 18, 4, '#3a4060');
      }
    }

    // Storm eels.
    for (i = 0; i < S.eels.length; i++) {
      if (S.eels[i].y > camY - 30 && S.eels[i].y < camY + H + 30) {
        drawEel(ctx, S.eels[i], camY, W, t);
      }
    }

    // Eggs (warm rim pulses faster as hatch nears).
    for (i = 0; i < S.eggs.length; i++) {
      var e = S.eggs[i];
      var rate = e.landed ? 4 + (1 - e.hatchT / EGG_HATCH) * 14 : 3;
      g.glowCircle(ctx, e.x, e.y, 13, PALETTE.ember, 0.25 + 0.25 * Math.abs(Math.sin(t * rate)));
      g.roundRect(ctx, e.x - 6, e.y - 8, 12, 16, 6, PALETTE.amber);
    }

    // Roost carrier.
    if (S.carrier) {
      var cr = S.carrier;
      g.roundRect(ctx, cr.x - 26, cr.y - 34, 52, 16, 7, PALETTE.lilac);   // balloon
      g.roundRect(ctx, cr.x - 22, cr.y - 12, 44, 24, 6, PALETTE.stoneDark);
      g.roundRect(ctx, cr.x - 22, cr.y - 12, 44, 7, 3, PALETTE.teal);
    }

    // Chicks (hunters tinted ember; aim state glows — the lunge telegraph).
    for (i = 0; i < S.chicks.length; i++) {
      var c = S.chicks[i];
      if (c.state === 'aim') g.glowCircle(ctx, c.x, c.y, 16, PALETTE.ember, 0.5);
      g.roundRect(ctx, c.x - 9, c.y - 7, 18, 14, 6, c.hunter ? PALETTE.ember : PALETTE.teal);
    }

    // Split Feather capsule.
    if (S.capsule) {
      var cap = S.capsule;
      if (cap.balloon) g.glowCircle(ctx, cap.x, cap.y - 18, 14, PALETTE.cyan, 0.6);
      g.roundRect(ctx, cap.x - 8, cap.y - 6, 16, 12, 4, PALETTE.teal);
    }

    // Projectiles.
    var list = world.projectiles.list;
    for (i = 0; i < list.length; i++) {
      var pj = list[i];
      ctx.save();
      ctx.globalAlpha = pj.alpha == null ? 1 : pj.alpha;
      ctx.fillStyle = PALETTE.amber;
      ctx.beginPath();
      ctx.arc(pj.x, pj.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // The courier (shared gouache painter when available).
    if (g.craft) {
      g.craft(ctx, body, t, PALETTE);
    } else {
      g.roundRect(ctx, body.x - 14, body.y - 9, 28, 18, 7, PALETTE.brass);
    }

    // Cosmetics emitted in world space (the shell only updates these).
    if (world.particles && world.particles.draw) world.particles.draw(ctx);
    if (world.floaters && world.floaters.draw) world.floaters.draw(ctx);

    ctx.restore();

    // ── Screen-space foreground ──
    if (!S.cloudBroken) {
      // Parallax 0.6x: cloud puffs streaming DOWNWARD (sells ascent speed).
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = PALETTE.lilac;
      var puffOff = (camY * 0.6 + t * 50) % 200;
      for (i = 0; i < 6; i++) {
        var px = 130 + (i * 167) % (W - 220);
        var pyy = ((i * 97 + puffOff) % (H + 80)) - 40;
        ctx.beginPath();
        ctx.ellipse(px, pyy, 56, 16, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      // Parallax 1.4x: near rain streaks.
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = '#9fb4c8';
      ctx.lineWidth = 1.5;
      var rainOff = (camY * 1.4 + t * 560) % 120;
      for (i = 0; i < 18; i++) {
        var rx = (i * 53.7) % W;
        var ryy = ((i * 71 + rainOff * 3) % (H + 40)) - 20;
        ctx.beginPath();
        ctx.moveTo(rx, ryy);
        ctx.lineTo(rx + 4, ryy + 16);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Gust telegraph / blow streaks.
    if (S.gust.state === 'tele' || S.gust.state === 'blow') {
      ctx.save();
      ctx.globalAlpha = S.gust.state === 'tele' ? 0.4 : 0.18;
      ctx.strokeStyle = PALETTE.lilac;
      ctx.lineWidth = 1.5;
      for (i = 0; i < 8; i++) {
        var gy = 70 + ((i * 67 + t * 90) % (H - 120));
        var gx = ((t * 320 * S.gust.dir + i * 130) % W + W) % W;
        ctx.beginPath();
        ctx.moveTo(gx, gy);
        ctx.lineTo(gx + S.gust.dir * 30, gy);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Lit beacon: gold-magenta flood rising into the hold.
    if (S.lit) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.4, S.victoryT * 0.3);
      ctx.fillStyle = PALETTE.magenta;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    g.vignette(ctx, W, H, 0.35);
  }

  return {
    key: 'spire-ascent',
    title: 'The Storm Spire',
    banner: 'CLIMB — ride the gusts, perch to recharge, never look down',
    palette: PALETTE,
    slingConfig: {
      muzzle: 460,
      inherit: 0.5,
      flatTime: 0.22,
      gravity: 600,
      cadenceHeld: 2.5,
      fanCount: 1,
      fanSpreadDeg: 14,
      payloadTag: 'shot',
    },
    init: init,
    update: update,
    draw: draw,
    isDone: isDone,
    // Test/debug hooks — not part of the stage contract; the machine never
    // calls them. Expose live state + module-scope checkpoint persistence.
    _state: function () { return S; },
    _persist: function () {
      return { restartPending: restartPending, checkpointReached: checkpointReached };
    },
  };
});
