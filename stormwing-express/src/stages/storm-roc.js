/*
 * Stage 4 — THE STORM ROC. Midnight boss arena, single screen with
 * horizontal wrap (Joust made literal). A recapitulation exam in three
 * phases: altitude duel, flak-storm iris windows, and the last delivery —
 * a beacon-charge arc-slung into the brazier through a sweeping beam.
 * Pure logic in update(); draw() only renders. Spec: design-spec bossFinale.
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
    (root.Stages = root.Stages || {})['storm-roc'] =
      factory(root.Core, root.Physics, root.Collision, root.Spawner);
  }
})(typeof self !== 'undefined' ? self : this, function (Core, Physics, Collision, Spawner) {
  'use strict';

  // ── Spec-pinned numbers (design-spec bossFinale + shared systems) ────
  var PLATES = 3;             // feather-plates on the head
  var CHARGE_SPEED = 320;     // px/s Roc horizontal charge
  var IRIS_OPEN = 1.5;        // s core window open
  var IRIS_CYCLE = 4.0;       // s full iris rhythm
  var CORE_HITS_NEEDED = 6;   // hits to crack the core
  var FLAK_SHELL_SPEED = 140; // px/s (stage-1 skiff pattern)
  var FRAG_SPEED = 160;       // px/s fragments
  var FRAG_COUNT = 4;
  var CHICK_LUNGE_SPEED = 150;// px/s (stage-3 chick lunge)
  var BEAM_TELEGRAPH = 1.2;   // s beam glow before sweep (spec-pinned)
  var HURT_TRAUMA = 0.6;      // camera trauma on below-contact
  var HITSTOP = 0.04;         // 40ms on duel kills / plate shears
  var FAN_TIME = 10;          // s Split Feather 3-way fan
  var FAN_COUNT = 3;
  var TELEGRAPH = 0.9;        // s generic danger telegraph (rule: >= 0.8s)

  // ── Tuned values the spec leaves unpinned ────────────────────────────
  var WIND_PUSH = 120;        // px/s phase-3 outward spiral shove
  var FLAK_PERIOD = 2.5;      // s between shells (borrowed stage-1 skiff cadence)
  var CHARGE_TIME = 1.4;      // s of horizontal charge
  var ROC_GRAV = 500;         // Roc flap-pulse fake gravity
  var ROC_FLAP = 230;         // Roc flap impulse
  var ROC_FLAP_EVERY = 0.45;  // s between Roc flap pulses
  var CHICK_MIRROR = 1.6;     // s mirroring before the lunge telegraph
  var CHICK_LUNGE_TIME = 1.2; // s lunge duration
  var CHICK_RESPAWN = 6;      // s before a killed chick is replaced
  var BEAM_SWEEP = 1.1;       // s beam sweep duration
  var BEAM_GAP = 1.0;         // s idle between beam cycles
  var BEAM_TOL = 0.13;        // rad beam hit tolerance
  var VICTORY_HOLD = 2.5;     // s gold flood / dawn seep before isDone
  var KIT_SPEED_X = 250;      // repair-kit lob
  var KIT_SPEED_Y = -540;
  var ITEM_GRAV = 600;        // eggs / kit / capsule fall (projectile gravity)
  var CHARGE_RESPAWN = 1.0;   // s after a missed beacon throw

  // Geometry (arena is one 960x600 screen)
  var GROUND = 564;           // gallery deck y (H - 36)
  var CEIL = 16;
  var CX = 480;               // lighthouse / arena center x
  var BRAZIER = { x: 480, y: 348, r: 26 };
  var ROC_LAND = { x: 480, y: 322 };
  var BEAM_ORIGIN = { x: 480, y: 330 };
  var PERCHES = [
    { x: 150, y: 386, w: 120 },
    { x: 480, y: 240, w: 130 },
    { x: 810, y: 386, w: 120 },
  ];
  var R_PLAYER = 12, R_ROC = 26, R_CHICK = 10, R_SHELL = 8, R_FRAG = 7,
      R_EGG = 9, R_KIT = 12, R_CAPSULE = 12, R_CHARGE = 12, R_SHOT = 6,
      R_CORE = 20;

  var PHASE_BANNERS = {
    1: 'LESSON I — ALTITUDE: take the high air, shear the plates',
    2: 'LESSON II — TIMING: dodge the flak, strike the open iris',
    3: 'LESSON III — THE ARC: ride the wind, deliver the dawn',
  };

  // ── State (module closure; checkpoint survives requestRestart) ──────
  var S = null;
  var restartPending = false;
  var checkpointPhase = 1;
  var genSeq = 0;             // bumped per init: re-entrancy guard (see below)
  var stars = null;           // draw-only; local rng so spawns stay untouched

  function wrapVal(x, W) {
    if (x < 0) return x + W;
    if (x >= W) return x - W;
    return x;
  }
  function wrapDx(fromX, toX, W) {
    var dx = toX - fromX;
    if (dx > W / 2) dx -= W;
    if (dx < -W / 2) dx += W;
    return dx;
  }
  // Wrap-aware circle hit on the x axis.
  function hit(ax, ay, ar, bx, by, br, W) {
    var dx = wrapDx(ax, bx, W);
    var dy = by - ay;
    return dx * dx + dy * dy <= (ar + br) * (ar + br);
  }
  function puff(world, x, y, color, count, speed) {
    var P = world.particles;
    if (!P) return;
    if (P.burst) P.burst({ x: x, y: y, count: count || 10, color: color, speed: speed || 120 });
  }
  // Addendum 4: semantic sfx names only; never raw beeps.
  function sfx(world, name, arg) {
    if (world.audio && world.audio.sfx) world.audio.sfx(name, arg);
  }
  function floater(world, x, y, text, color) {
    if (world.floaters && world.floaters.add) world.floaters.add(x, y, text, color);
  }
  function trauma(world, amount) {
    if (!world.camera) return;
    if (world.camera.addTrauma) world.camera.addTrauma(amount);
    else if (world.camera.shake) world.camera.shake(amount * 10, 0.3);
  }

  // Route ALL player damage through hull + tailwind (contract). The shell
  // self-wires hull-damage thud + flash + trauma 0.5 (addendum 4) — the
  // stage adds only knockback, feathers, and trauma ABOVE that base.
  function damagePlayer(world, opts) {
    opts = opts || {};
    var res = world.hull.damage(1);
    if (res === 'shrugged') return false;
    world.tailwind.damage();
    if (opts.extraTrauma) trauma(world, opts.extraTrauma);
    var body = world.physics;
    if (opts.knockX != null) body.vx = opts.knockX;
    if (opts.knockY != null) body.vy = opts.knockY;
    puff(world, body.x, body.y, '#ff7a3c', 14, 160);
    if (res === 'gameover') {
      // Hull empty: phase checkpoint restart (counts as one restart).
      // requestRestart re-runs init() SYNCHRONOUSLY (addendum 6): S is
      // replaced before this call returns — callers must check S.gen.
      restartPending = true;
      world.requestRestart('storm-roc:phase' + S.phase);
    }
    return true;
  }

  function freshRoc() {
    return {
      x: CX, y: 160, vx: 0, vy: 0,
      state: 'pursuit', stateT: 0, flapT: 0,
      chargeDir: 1, contactCool: 0, circleA: 0,
    };
  }
  function freshChick(home) {
    return {
      home: home, x: home === 0 ? 240 : 720, y: 110, vx: 0, vy: 0,
      state: 'mirror', t: home === 0 ? 0 : -0.5,
      dir: 1, dead: false, respawnT: 0, contactCool: 0,
    };
  }

  function enterPhase(n, world) {
    S.phase = n;
    S.phaseT = 0;
    S.sub = 'fight';
    checkpointPhase = n;
    S.bannerText = PHASE_BANNERS[n];
    S.bannerT = 2.5;
    S.shells = [];
    S.frags = [];
    S.capsule = null;   // clear any leftover Split Feather capsule on transition
                        // (an uncollected phase-2 capsule used to freeze into
                        // phase 3 mid-air for the rest of the fight) [#5]
    if (n === 1) {
      S.roc = freshRoc();
      S.plates = PLATES;
    } else if (n === 2) {
      S.roc = freshRoc();
      S.roc.state = 'circle';
      S.coreHits = 0;
      S.irisT = 0;
      S.capsule = null;
      S.capsuleSpawned = false;
      S.chicks = [freshChick(0), freshChick(1)];
      S.flakTrack = new Spawner.Track(world.rng);
      S.flakTrack.every(FLAK_PERIOD, function () { spawnShellTelegraph(world); }, { start: 1.5, jitter: 0.25 });
    } else if (n === 3) {
      S.roc = freshRoc();
      S.roc.state = 'landed';
      S.roc.x = ROC_LAND.x;
      S.roc.y = ROC_LAND.y;
      S.chicks = [];
      S.beam = { state: 'idle', t: BEAM_GAP, angle: 0, from: 0, to: 0, dir: 1 };
      spawnCharge();
    }
    sfx(world, 'telegraph');
  }

  function spawnShellTelegraph(world) {
    S.shells.push({ state: 'tele', t: TELEGRAPH, x: S.roc.x, y: S.roc.y, vx: 0, vy: 0, recY: 0 });
    S.flakLog.push(Math.round(S.phaseT * 1000) / 1000);
    sfx(world, 'telegraph'); // bell rings when the telegraph STARTS
  }

  function spawnCharge() {
    S.charge = { x: PERCHES[0].x, y: PERCHES[0].y - 14 };
    S.carrying = false;
  }

  function startKit(nextPhase, world) {
    S.sub = 'kit';
    S.kitNextPhase = nextPhase;
    S.shells = [];
    S.frags = [];
    var fromLeft = world.physics.x > CX;
    S.kit = {
      x: fromLeft ? 50 : 910,
      y: GROUND - 20,
      vx: fromLeft ? KIT_SPEED_X : -KIT_SPEED_X,
      vy: KIT_SPEED_Y,
    };
    S.roc.state = 'hold';
    sfx(world, 'telegraph'); // watch the incoming arc
  }

  // ── init / restart-checkpoint ────────────────────────────────────────
  function init(world) {
    var startPhase = 1;
    if (restartPending) {
      startPhase = checkpointPhase;
      restartPending = false;
    } else {
      checkpointPhase = 1;
    }
    S = {
      gen: ++genSeq,
      t: 0, phase: 0, sub: 'fight', phaseT: 0,
      bannerText: '', bannerT: 0,
      hitstopT: 0,
      roc: freshRoc(),
      plates: PLATES,
      coreHits: 0, irisT: 0, coreOpen: false,
      shells: [], frags: [], chicks: [], eggs: [],
      capsule: null, capsuleSpawned: false, fanT: 0,
      kit: null, kitNextPhase: 0,
      beam: null,
      charge: null, carrying: false, beaconLive: false,
      beaconThrows: 0, chargeRespawnT: 0,
      victory: false, victoryT: 0,
      flakTrack: null, flakLog: [],
      prevY: world.physics.y,
    };
    var body = world.physics;
    body.x = CX; body.y = 460; body.vx = 0; body.vy = 0;
    enterPhase(startPhase, world);
    if (!stars) {
      var rng = Core.makeRng(99);
      stars = [];
      for (var i = 0; i < 90; i++) {
        stars.push({ x: rng() * 960, y: rng() * 380, r: 0.5 + rng() * 1.4, tw: rng() * 6.28 });
      }
    }
  }

  // ── Player ───────────────────────────────────────────────────────────
  function outwardWind(body) {
    var side = body.x === CX ? body.facing : (body.x > CX ? 1 : -1);
    return side * WIND_PUSH;
  }

  function throwBeacon(world) {
    var prj = world.projectiles;
    var keep = {
      payloadTag: prj.cfg.payloadTag,
      flatTime: prj.cfg.flatTime,
      fanCount: prj.cfg.fanCount,
    };
    // The killing blow is a delivery: full-arc throw (stage-2 loft).
    prj.configure({ payloadTag: 'beaconCharge', flatTime: 0, fanCount: 1 });
    prj.sling(world.physics, { muzzleBonus: world.tailwind.muzzleBonus() });
    prj.configure(keep);
    S.carrying = false;
    S.charge = null;
    S.beaconLive = true;
    S.beaconThrows += 1;
    // No sfx here: the shell self-wires the sling pop on every X press.
  }

  function updatePlayer(dt, world) {
    var body = world.physics;
    var input = world.input;
    var axis = input.axis();
    Physics.steer(body, axis.x, dt);
    if (input.justPressed(' ') || input.justPressed('z')) Physics.flap(body);

    if (S.carrying) {
      if (input.justPressed('x')) throwBeacon(world);
    } else {
      // Empty-field slings cost nothing — unlimited ammo, no penalties.
      if (input.justPressed('x') && axis.y > 0) {
        world.projectiles.straightDrop(body);
      } else if (input.held('x')) {
        world.projectiles.holdFire(body, dt, { muzzleBonus: world.tailwind.muzzleBonus() });
      }
    }

    var windX = (S.phase === 3 && !S.victory) ? outwardWind(body) : 0;
    S.prevY = body.y;
    Physics.integrate(body, dt, { windX: windX });
    body.x = wrapVal(body.x, world.W);

    if (body.y < CEIL) { body.y = CEIL; if (body.vy < 0) body.vy = 0; }
    if (body.y > GROUND) { body.y = GROUND; if (body.vy > 0) body.vy = 0; }
    // Perch landings (one-way platforms, top side only).
    if (body.vy > 0) {
      for (var i = 0; i < PERCHES.length; i++) {
        var p = PERCHES[i];
        if (S.prevY <= p.y && body.y >= p.y &&
            Math.abs(wrapDx(p.x, body.x, world.W)) <= p.w / 2) {
          body.y = p.y;
          body.vy = 0;
          break;
        }
      }
    }
  }

  function updateProjectiles(dt, world) {
    world.projectiles.update(dt);
    var list = world.projectiles.list;
    for (var i = 0; i < list.length; i++) {
      list[i].x = wrapVal(list[i].x, world.W); // wrap is a tool for shots too
    }
  }

  // ── Phase 1 — THE DUEL ───────────────────────────────────────────────
  function rocDuelContact(world) {
    var body = world.physics;
    var roc = S.roc;
    if (roc.contactCool > 0) return;
    if (!hit(body.x, body.y, R_PLAYER, roc.x, roc.y, R_ROC, world.W)) return;
    var verdict = Collision.altitudeDuel(body, roc);
    if (verdict === 'kill' && S.phase === 1 && S.plates > 0) {
      S.plates -= 1;
      S.hitstopT = HITSTOP;          // 40ms hitstop on the shear
      roc.contactCool = 0.5;
      body.vy = -180;                // Joust kill rebound
      roc.vy = 160;
      world.score.add('kill');       // plate shear scores a kill (spec: unpinned)
      puff(world, roc.x, roc.y - 20, '#c9b8e8', 18, 200);
      floater(world, roc.x, roc.y - 30, 'PLATE SHEARED', '#c9b8e8');
      sfx(world, 'hit');             // metallic clang (not hull damage)
      if (S.plates <= 0) startKit(2, world);
    } else if (verdict === 'hurt') {
      roc.contactCool = 0.6;
      var away = wrapDx(roc.x, body.x, world.W) >= 0 ? 1 : -1;
      // Shell adds trauma 0.5 on any hull loss; top up to the spec's 0.6.
      damagePlayer(world, { extraTrauma: HURT_TRAUMA - 0.5, knockX: away * 240, knockY: -160 });
    } else {
      // 'bounce' — and 'kill' in later phases (plates gone: no damage either way)
      Collision.bounce(body, roc);
      roc.contactCool = 0.3;
    }
  }

  function updatePhase1(dt, world) {
    var body = world.physics;
    var roc = S.roc;
    roc.stateT += dt;
    if (roc.contactCool > 0) roc.contactCool -= dt;

    if (roc.state === 'pursuit') {
      // Joust pterodactyl pursuit: flap-pulse climbs to the player's altitude.
      roc.vy += ROC_GRAV * dt;
      roc.flapT -= dt;
      if (roc.flapT <= 0 && roc.y > body.y - 6) {
        roc.vy -= ROC_FLAP;
        roc.flapT = ROC_FLAP_EVERY;
      }
      roc.vy = Core.clamp(roc.vy, -320, 320);
      var dx = wrapDx(roc.x, body.x, world.W);
      roc.vx = Core.clamp(roc.vx + (dx > 0 ? 200 : -200) * dt, -140, 140);
      if (Math.abs(roc.y - body.y) < 24) {
        roc.state = 'aim';           // charge telegraph (>= 0.8s before harm)
        roc.stateT = 0;
        roc.chargeDir = dx >= 0 ? 1 : -1;
        sfx(world, 'telegraph');
      }
    } else if (roc.state === 'aim') {
      roc.vx *= Math.exp(-6 * dt);
      roc.vy *= Math.exp(-6 * dt);
      if (roc.stateT >= TELEGRAPH) {
        roc.state = 'charge';
        roc.stateT = 0;
        roc.vx = roc.chargeDir * CHARGE_SPEED;
        roc.vy = 0;
      }
    } else if (roc.state === 'charge') {
      if (roc.stateT >= CHARGE_TIME) {
        roc.state = 'pursuit';
        roc.stateT = 0;
        roc.vx = 0;
      }
    }
    roc.x = wrapVal(roc.x + roc.vx * dt, world.W);
    roc.y = Core.clamp(roc.y + roc.vy * dt, 60, GROUND - 40);
    rocDuelContact(world);
  }

  // ── Phase 2 — FLAK STORM ─────────────────────────────────────────────
  function killChick(world, chick) {
    chick.dead = true;
    chick.respawnT = CHICK_RESPAWN;
    S.hitstopT = HITSTOP;
    S.eggs.push({ x: chick.x, y: chick.y, vx: 0, vy: -60 });
    world.score.add('kill');
    puff(world, chick.x, chick.y, '#2aa7a0', 12, 150);
    floater(world, chick.x, chick.y - 16, '+100', '#ffd27a');
    sfx(world, 'hit');
  }

  function updateChicks(dt, world) {
    var body = world.physics;
    var gen = S.gen;
    for (var i = 0; i < S.chicks.length; i++) {
      var c = S.chicks[i];
      if (c.dead) {
        c.respawnT -= dt;
        if (c.respawnT <= 0 && S.phase === 2 && S.sub === 'fight') {
          S.chicks[i] = freshChick(c.home);
        }
        continue;
      }
      if (c.contactCool > 0) c.contactCool -= dt;
      c.t += dt;
      if (c.state === 'mirror') {
        var dy = Core.clamp(body.y - c.y, -120 * dt, 120 * dt);
        c.y += dy;
        var dx = wrapDx(c.x, body.x, world.W);
        c.x = wrapVal(c.x + (dx > 0 ? 40 : -40) * dt, world.W);
        if (c.t >= CHICK_MIRROR) {
          c.state = 'aim';           // lunge telegraph (>= 0.8s)
          c.t = 0;
          c.dir = dx >= 0 ? 1 : -1;
          sfx(world, 'telegraph');
        }
      } else if (c.state === 'aim') {
        if (c.t >= 0.8) {
          c.state = 'lunge';
          c.t = 0;
          c.vx = c.dir * CHICK_LUNGE_SPEED;
        }
      } else if (c.state === 'lunge') {
        c.x = wrapVal(c.x + c.vx * dt, world.W);
        if (c.t >= CHICK_LUNGE_TIME) {
          c.state = 'mirror';
          c.t = 0;
          c.vx = 0;
        }
      }
      // Player shots kill chicks (1 HP).
      var list = world.projectiles.list;
      for (var j = 0; j < list.length; j++) {
        var pr = list[j];
        if (pr.dead || pr.tag === 'beaconCharge') continue;
        if (hit(pr.x, pr.y, R_SHOT, c.x, c.y, R_CHICK + 2, world.W)) {
          pr.dead = true;
          killChick(world, c);
          break;
        }
      }
      if (c.dead) continue;
      // Altitude duel on contact.
      if (c.contactCool <= 0 && hit(body.x, body.y, R_PLAYER, c.x, c.y, R_CHICK, world.W)) {
        var verdict = Collision.altitudeDuel(body, c);
        if (verdict === 'kill') {
          body.vy = -160;
          killChick(world, c);
        } else if (verdict === 'hurt') {
          c.contactCool = 0.6;
          var away = wrapDx(c.x, body.x, world.W) >= 0 ? 1 : -1;
          damagePlayer(world, { knockX: away * 200, knockY: -140 });
          if (S.gen !== gen) return; // hull-empty restart replaced the state
        } else {
          Collision.bounce(body, c);
          c.contactCool = 0.3;
        }
      }
    }
  }

  function updateShells(dt, world) {
    var body = world.physics;
    var gen = S.gen;
    for (var i = S.shells.length - 1; i >= 0; i--) {
      var sh = S.shells[i];
      if (sh.state === 'tele') {
        sh.x = S.roc.x;              // glow rides the circling Roc
        sh.y = S.roc.y;
        sh.t -= dt;
        if (sh.t <= 0) {
          sh.state = 'live';
          sh.recY = body.y;          // the P-47 graft: burst at RECORDED altitude
          var dx = wrapDx(sh.x, body.x, world.W);
          var dy = body.y - sh.y;
          var d = Math.sqrt(dx * dx + dy * dy) || 1;
          sh.vx = dx / d * FLAK_SHELL_SPEED;
          sh.vy = dy / d * FLAK_SHELL_SPEED;
          if (sh.vy === 0) sh.vy = FLAK_SHELL_SPEED;
        }
        continue;
      }
      sh.x = wrapVal(sh.x + sh.vx * dt, world.W);
      sh.y += sh.vy * dt;
      var crossed = (sh.vy >= 0 && sh.y >= sh.recY) || (sh.vy < 0 && sh.y <= sh.recY);
      if (crossed) {
        var k = FRAG_SPEED * Math.SQRT1_2;
        for (var fx = -1; fx <= 1; fx += 2) {
          for (var fy = -1; fy <= 1; fy += 2) {
            S.frags.push({ x: sh.x, y: sh.recY, vx: fx * k, vy: fy * k, life: 2.5 });
          }
        }
        puff(world, sh.x, sh.recY, '#ffd27a', 12, 140);
        S.shells.splice(i, 1);
        continue;
      }
      if (sh.y > world.H + 40 || sh.y < -40) {
        S.shells.splice(i, 1);
        continue;
      }
      if (hit(body.x, body.y, R_PLAYER, sh.x, sh.y, R_SHELL, world.W)) {
        S.shells.splice(i, 1);
        damagePlayer(world);
        if (S.gen !== gen) return;
      }
    }
    for (var f = S.frags.length - 1; f >= 0; f--) {
      var fr = S.frags[f];
      fr.life -= dt;
      fr.x = wrapVal(fr.x + fr.vx * dt, world.W);
      fr.y += fr.vy * dt;
      if (fr.life <= 0 || fr.y > world.H + 30 || fr.y < -30) {
        S.frags.splice(f, 1);
        continue;
      }
      if (hit(body.x, body.y, R_PLAYER, fr.x, fr.y, R_FRAG, world.W)) {
        S.frags.splice(f, 1);
        damagePlayer(world);
        if (S.gen !== gen) return;
      }
    }
  }

  function updateCapsule(dt, world) {
    if (S.coreHits >= 3 && !S.capsuleSpawned) {
      S.capsuleSpawned = true;       // one Split Feather capsule, mid-phase
      S.capsule = { x: 700, y: -20, vy: 40, balloon: true };
    }
    var cap = S.capsule;
    if (!cap) return;
    if (!cap.balloon) cap.vy += ITEM_GRAV * dt;
    cap.y += cap.vy * dt;
    if (cap.balloon) {
      var list = world.projectiles.list;
      for (var i = 0; i < list.length; i++) {
        var pr = list[i];
        if (pr.dead || pr.tag === 'beaconCharge') continue;
        if (hit(pr.x, pr.y, R_SHOT, cap.x, cap.y - 16, R_CAPSULE, world.W)) {
          pr.dead = true;
          cap.balloon = false;       // popped: capsule falls, touch to collect
          cap.vy = 0;
          puff(world, cap.x, cap.y - 16, '#6ef0ff', 8, 100);
          break;
        }
      }
    }
    var body = world.physics;
    // Spec: "shoot the balloon to RELEASE, touch to collect" — the capsule
    // is only collectable once the balloon is popped.
    if (!cap.balloon &&
        hit(body.x, body.y, R_PLAYER, cap.x, cap.y, R_CAPSULE, world.W)) {
      S.fanT = FAN_TIME;
      world.projectiles.configure({ fanCount: FAN_COUNT });
      floater(world, cap.x, cap.y, 'SPLIT FEATHER', '#6ef0ff');
      sfx(world, 'delivery');
      S.capsule = null;
      return;
    }
    if (cap.y > world.H + 30) S.capsule = null; // drifts away, costs nothing
  }

  function updatePhase2(dt, world) {
    var gen = S.gen;
    S.irisT += dt;
    var cycleT = S.irisT % IRIS_CYCLE;
    S.coreOpen = cycleT < IRIS_OPEN; // glowing magenta 1.5s every 4s

    var roc = S.roc;
    if (roc.contactCool > 0) roc.contactCool -= dt;
    roc.circleA += 0.8 * dt;
    roc.x = wrapVal(CX + 230 * Math.cos(roc.circleA), world.W);
    roc.y = 170 + 60 * Math.sin(roc.circleA);

    S.flakTrack.poll(S.phaseT);
    updateShells(dt, world);
    if (S.gen !== gen) return;       // hull-empty restart replaced the state
    updateChicks(dt, world);
    if (S.gen !== gen) return;
    updateCapsule(dt, world);
    rocDuelContact(world);           // plates gone: bounce or hurt only
    if (S.gen !== gen) return;

    // Sling hits ONLY count while the iris is open.
    var list = world.projectiles.list;
    for (var i = 0; i < list.length; i++) {
      var pr = list[i];
      if (pr.dead || pr.tag === 'beaconCharge') continue;
      if (hit(pr.x, pr.y, R_SHOT, roc.x, roc.y, R_CORE, world.W)) {
        pr.dead = true;
        if (S.coreOpen) {
          S.coreHits += 1;
          world.score.add('kill');   // counted core hit (spec: unpinned)
          puff(world, roc.x, roc.y, '#ff4da6', 14, 180);
          floater(world, roc.x, roc.y - 24, S.coreHits + '/' + CORE_HITS_NEEDED, '#ff4da6');
          sfx(world, 'hit');
          if (S.coreHits >= CORE_HITS_NEEDED) {
            startKit(3, world);
            return;
          }
        } else {
          puff(world, pr.x, pr.y, '#5a6f8c', 4, 60); // clink — closed iris
        }
      }
    }
  }

  // ── Phase 3 — THE LAST DELIVERY ──────────────────────────────────────
  function resolveBeacon(world, hitBrazier) {
    S.beaconLive = false;
    if (hitBrazier) {
      S.victory = true;
      S.victoryT = 0;
      world.tallies.beaconLit = true;
      if (world.tallies.beaconFirstTry === null) {
        world.tallies.beaconFirstTry = S.beaconThrows === 1;
      }
      world.score.add('delivery');   // the killing blow is a delivery
      world.score.add('stageClear');
      trauma(world, 0.5);
      puff(world, BRAZIER.x, BRAZIER.y, '#ffd27a', 40, 260);
      floater(world, BRAZIER.x, BRAZIER.y - 40, 'THE BEACON IS LIT', '#ffd27a');
      // No sfx: the shell auto-chimes when counts.delivery increments.
    } else {
      if (world.tallies.beaconFirstTry === null) {
        world.tallies.beaconFirstTry = false;
      }
      S.chargeRespawnT = CHARGE_RESPAWN; // miss costs nothing; charge respawns
    }
  }

  function updateBeam(dt, world) {
    var b = S.beam;
    b.t -= dt;
    if (b.state === 'idle') {
      if (b.t <= 0) {
        b.state = 'tele';            // 1.2s glow telegraph per sweep
        b.t = BEAM_TELEGRAPH;
        b.dir = -b.dir;
        b.from = b.dir > 0 ? -2.9 : -0.2;
        b.to = b.dir > 0 ? -0.2 : -2.9;
        b.angle = b.from;
        sfx(world, 'telegraph');
      }
    } else if (b.state === 'tele') {
      b.angle = b.from;
      if (b.t <= 0) {
        b.state = 'sweep';
        b.t = BEAM_SWEEP;
      }
    } else if (b.state === 'sweep') {
      var prog = 1 - Math.max(b.t, 0) / BEAM_SWEEP;
      b.angle = b.from + (b.to - b.from) * prog;
      var body = world.physics;
      var dx = wrapDx(BEAM_ORIGIN.x, body.x, world.W);
      var dy = body.y - BEAM_ORIGIN.y;
      if (dx * dx + dy * dy > 30 * 30) {
        var pa = Math.atan2(dy, dx);
        var da = pa - b.angle;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        if (Math.abs(da) < BEAM_TOL) {
          damagePlayer(world);
          if (S.beam !== b) return;  // hull-empty restart rebuilt the beam
        }
      }
      if (b.t <= 0) {
        b.state = 'idle';
        b.t = BEAM_GAP;
      }
    }
  }

  function updatePhase3(dt, world) {
    var body = world.physics;
    var gen = S.gen;
    updateBeam(dt, world);
    if (S.gen !== gen) return;       // hull-empty restart replaced the state

    // Landed Roc body: a wall, not a hit — push the player out, no damage.
    if (hit(body.x, body.y, R_PLAYER, S.roc.x, S.roc.y, R_ROC, world.W)) {
      var away = wrapDx(S.roc.x, body.x, world.W) >= 0 ? 1 : -1;
      body.x = wrapVal(S.roc.x + away * (R_ROC + R_PLAYER + 2), world.W);
      if (body.vx * away < 0) body.vx = away * 60;
    }

    if (S.charge && !S.carrying &&
        hit(body.x, body.y, R_PLAYER, S.charge.x, S.charge.y, R_CHARGE, world.W)) {
      S.carrying = true;
      floater(world, body.x, body.y - 20, 'BEACON CHARGE', '#ff4da6');
      sfx(world, 'delivery');
    }
    if (S.carrying && S.charge) S.charge = null;

    // Beacon shot in flight: brazier hit wins; ground or cull is a miss.
    if (S.beaconLive) {
      var found = null;
      var list = world.projectiles.list;
      for (var i = 0; i < list.length; i++) {
        if (list[i].tag === 'beaconCharge' && !list[i].dead) { found = list[i]; break; }
      }
      if (!found) {
        resolveBeacon(world, false);
      } else if (hit(found.x, found.y, 10, BRAZIER.x, BRAZIER.y, BRAZIER.r, world.W)) {
        found.dead = true;
        resolveBeacon(world, true);
      } else if (found.y > GROUND) {
        found.dead = true;
        puff(world, found.x, GROUND, '#5a6f8c', 8, 80);
        resolveBeacon(world, false);
      }
    } else if (!S.carrying && !S.charge && !S.victory) {
      S.chargeRespawnT -= dt;
      if (S.chargeRespawnT <= 0) spawnCharge();
    }
  }

  // ── Intermission — the Choplifter mercy beat ─────────────────────────
  function updateKit(dt, world) {
    var kit = S.kit;
    var body = world.physics;
    kit.vy += ITEM_GRAV * dt;
    kit.x += kit.vx * dt;
    kit.y += kit.vy * dt;
    if (hit(body.x, body.y, R_PLAYER, kit.x, kit.y, R_KIT, world.W)) {
      world.hull.heal(1);
      floater(world, kit.x, kit.y, '+1 HULL', '#ff7a3c');
      puff(world, kit.x, kit.y, '#ff7a3c', 10, 120);
      sfx(world, 'delivery');
      S.kit = null;
      enterPhase(S.kitNextPhase, world);
      return;
    }
    if (kit.y > GROUND || kit.x < -30 || kit.x > world.W + 30) {
      S.kit = null;                  // missing it costs nothing
      enterPhase(S.kitNextPhase, world);
    }
  }

  function updateEggs(dt, world) {
    var body = world.physics;
    for (var i = S.eggs.length - 1; i >= 0; i--) {
      var e = S.eggs[i];
      e.vy += ITEM_GRAV * dt;
      e.x = wrapVal(e.x + e.vx * dt, world.W);
      e.y += e.vy * dt;
      if (hit(body.x, body.y, R_PLAYER, e.x, e.y, R_EGG, world.W)) {
        var pts = world.score.add('eggCatch');
        floater(world, e.x, e.y, '+' + pts, '#ffd27a');
        sfx(world, 'delivery');
        S.eggs.splice(i, 1);
        continue;
      }
      if (e.y > world.H + 20) S.eggs.splice(i, 1); // lost egg costs nothing
    }
  }

  function publishHud(world) {
    world.hud.phase = { label: 'PHASE', value: S.phase + '/3' };
    if (S.victory) {
      world.hud.boss = { label: 'BEACON', value: 'LIT' };
    } else if (S.phase === 1) {
      world.hud.boss = { label: 'PLATES', value: String(S.plates), ratio: S.plates / PLATES };
    } else if (S.phase === 2) {
      world.hud.boss = {
        label: 'CORE',
        value: S.coreHits + '/' + CORE_HITS_NEEDED,
        ratio: S.coreHits / CORE_HITS_NEEDED,
      };
    } else {
      world.hud.boss = {
        label: 'BEACON',
        value: S.carrying ? 'CARRIED' : (S.beaconLive ? 'IN FLIGHT' : 'ON THE PERCH'),
      };
    }
  }

  // ── update ───────────────────────────────────────────────────────────
  function update(dt, world) {
    if (S.hitstopT > 0) {            // 40ms world-freeze on shears/duel kills
      S.hitstopT -= dt;
      return;
    }
    S.t += dt;
    S.phaseT += dt;
    if (S.bannerT > 0) S.bannerT -= dt;
    // hull.update (i-frame decay) is the SHELL's per-frame job — ticking it
    // here too would halve the invulnerability window.
    // The boss is a scorable target whenever the fight is live.
    world.tailwind.update(dt, S.sub === 'fight' && !S.victory);
    if (S.fanT > 0) {
      S.fanT -= dt;
      if (S.fanT <= 0) world.projectiles.configure({ fanCount: 1 });
    }

    updatePlayer(dt, world);
    updateProjectiles(dt, world);

    if (S.victory) {
      S.victoryT += dt;
      updateEggs(dt, world);
      publishHud(world);
      return;
    }

    var gen = S.gen;
    if (S.sub === 'kit') {
      updateKit(dt, world);
    } else if (S.phase === 1) {
      updatePhase1(dt, world);
    } else if (S.phase === 2) {
      updatePhase2(dt, world);
    } else {
      updatePhase3(dt, world);
    }
    if (S.gen !== gen) {             // restarted mid-frame: fresh state only
      publishHud(world);
      return;
    }

    updateEggs(dt, world);
    publishHud(world);
  }

  function isDone() {
    return !!(S && S.victory && S.victoryT >= VICTORY_HOLD);
  }

  // ── draw ─────────────────────────────────────────────────────────────
  var PALETTE = {
    skyTop: '#05060f',
    skyBottom: '#101b33',
    aurora: '#6ef0ff',
    auroraDim: '#2aa7a0',
    star: '#c9b8e8',
    stone: '#1c2241',
    stoneDark: '#11152b',
    brass: '#d9b36a',
    teal: '#2aa7a0',
    magenta: '#ff4da6',
    amber: '#ffd27a',
    ember: '#ff7a3c',
    dawnTop: '#1a2238',
    dawnMid: '#5a6f8c',
    outline: '#141821',
  };

  function draw(ctx, world) {
    var g = world.gfx;
    var W = world.W, H = world.H;
    var body = world.physics;

    // Midnight sky + starfield + aurora
    g.skyGradient(ctx, 0, 0, W, H, [[0, PALETTE.skyTop], [1, PALETTE.skyBottom]]);
    ctx.save();
    ctx.fillStyle = PALETTE.star;
    for (var i = 0; i < stars.length; i++) {
      var st = stars[i];
      ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(S.t * 0.8 + st.tw));
      ctx.fillRect(st.x, st.y, st.r, st.r);
    }
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var a = 0; a < 3; a++) {
      ctx.globalAlpha = 0.05 + 0.03 * Math.sin(S.t * 0.5 + a * 2);
      ctx.fillStyle = a === 1 ? PALETTE.auroraDim : PALETTE.aurora;
      ctx.beginPath();
      for (var x = 0; x <= W; x += 32) {
        var y = 70 + a * 36 + Math.sin(x * 0.012 + S.t * 0.6 + a) * 22;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineTo(W, 0);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Gallery deck + cheering keepers (stage-1 callback)
    g.roundRect(ctx, -10, GROUND + 12, W + 20, H - GROUND, 6, PALETTE.stoneDark);
    for (var k = 0; k < 6; k++) {
      var kx = 60 + k * 30 + (k > 2 ? W - 400 : 0);
      var hop = Math.abs(Math.sin(S.t * 3 + k)) * (S.victory ? 8 : 3);
      g.roundRect(ctx, kx, GROUND + 2 - hop, 10, 14, 3, PALETTE.ember);
    }

    // Lighthouse + brazier
    g.roundRect(ctx, CX - 32, 360, 64, GROUND - 360 + 14, 6, PALETTE.stone);
    g.roundRect(ctx, CX - 22, 344, 44, 18, 4, PALETTE.brass);
    if (S.victory || (S.phase === 3 && !S.victory)) {
      g.glowCircle(ctx, BRAZIER.x, BRAZIER.y, S.victory ? 60 : 30, PALETTE.magenta,
        S.victory ? 0.9 : 0.4 + 0.2 * Math.sin(S.t * 5));
    }

    // Perches
    for (var p = 0; p < PERCHES.length; p++) {
      var pc = PERCHES[p];
      g.roundRect(ctx, pc.x - pc.w / 2, pc.y, pc.w, 12, 5, PALETTE.stone);
    }

    // Eggs / capsule / kit / charge
    for (var e = 0; e < S.eggs.length; e++) {
      g.roundRect(ctx, S.eggs[e].x - 6, S.eggs[e].y - 8, 12, 16, 6, PALETTE.amber);
    }
    if (S.capsule) {
      var cap = S.capsule;
      if (cap.balloon) g.glowCircle(ctx, cap.x, cap.y - 18, 14, PALETTE.aurora, 0.6);
      g.roundRect(ctx, cap.x - 8, cap.y - 6, 16, 12, 4, PALETTE.teal);
    }
    if (S.kit) g.roundRect(ctx, S.kit.x - 8, S.kit.y - 6, 16, 12, 3, PALETTE.ember);
    if (S.charge) {
      g.glowCircle(ctx, S.charge.x, S.charge.y, 22, PALETTE.magenta, 0.7);
      g.roundRect(ctx, S.charge.x - 7, S.charge.y - 7, 14, 14, 6, PALETTE.magenta);
    }

    // Beam (telegraph faint, sweep bright)
    if (S.phase === 3 && S.beam && S.beam.state !== 'idle' && !S.victory) {
      var b = S.beam;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = b.state === 'tele' ? 0.18 : 0.7;
      ctx.strokeStyle = PALETTE.amber;
      ctx.lineWidth = b.state === 'tele' ? 3 : 10;
      ctx.beginPath();
      ctx.moveTo(BEAM_ORIGIN.x, BEAM_ORIGIN.y);
      ctx.lineTo(BEAM_ORIGIN.x + Math.cos(b.angle) * 1100,
                 BEAM_ORIGIN.y + Math.sin(b.angle) * 1100);
      ctx.stroke();
      ctx.restore();
    }

    // Spiral wind streaks (phase 3)
    if (S.phase === 3 && !S.victory) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = PALETTE.aurora;
      ctx.lineWidth = 1;
      for (var w = 0; w < 10; w++) {
        var wy = 80 + ((w * 53 + S.t * 140) % (GROUND - 100));
        var side = (w % 2 === 0) ? 1 : -1;
        var wx = CX + side * (40 + ((S.t * 160 + w * 90) % 420));
        ctx.beginPath();
        ctx.moveTo(wx, wy);
        ctx.lineTo(wx + side * 26, wy);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Shells + fragments
    for (var s2 = 0; s2 < S.shells.length; s2++) {
      var sh = S.shells[s2];
      if (sh.state === 'tele') {
        g.glowCircle(ctx, sh.x, sh.y, 18, PALETTE.amber, 0.3 + 0.3 * Math.sin(S.t * 14));
      } else {
        g.glowCircle(ctx, sh.x, sh.y, 10, PALETTE.amber, 0.7);
      }
    }
    ctx.fillStyle = PALETTE.amber;
    for (var f2 = 0; f2 < S.frags.length; f2++) {
      ctx.beginPath();
      ctx.arc(S.frags[f2].x, S.frags[f2].y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Chicks
    for (var c2 = 0; c2 < S.chicks.length; c2++) {
      var ch = S.chicks[c2];
      if (ch.dead) continue;
      if (ch.state === 'aim') g.glowCircle(ctx, ch.x, ch.y, 16, PALETTE.ember, 0.5);
      g.roundRect(ctx, ch.x - 9, ch.y - 7, 18, 14, 6, PALETTE.teal);
    }

    // The Roc
    var roc = S.roc;
    if (roc.state === 'aim') g.glowCircle(ctx, roc.x, roc.y, 44, PALETTE.ember, 0.5);
    g.roundRect(ctx, roc.x - 30, roc.y - 22, 60, 44, 14, PALETTE.stone);
    g.roundRect(ctx, roc.x - 30, roc.y - 22, 60, 10, 5, PALETTE.teal);
    for (var pl = 0; pl < S.plates; pl++) {
      g.roundRect(ctx, roc.x - 24 + pl * 17, roc.y - 30, 14, 8, 3, PALETTE.star);
    }
    if (S.phase === 2 && !S.victory) {
      g.glowCircle(ctx, roc.x, roc.y, S.coreOpen ? 24 : 10, PALETTE.magenta,
        S.coreOpen ? 0.85 : 0.2);
    }

    // Projectiles
    var list = world.projectiles.list;
    for (var pr = 0; pr < list.length; pr++) {
      var pj = list[pr];
      ctx.save();
      ctx.globalAlpha = pj.alpha == null ? 1 : pj.alpha;
      if (pj.tag === 'beaconCharge') {
        g.glowCircle(ctx, pj.x, pj.y, 20, PALETTE.magenta, 0.8);
      }
      ctx.fillStyle = pj.tag === 'beaconCharge' ? PALETTE.magenta : PALETTE.amber;
      ctx.beginPath();
      ctx.arc(pj.x, pj.y, pj.tag === 'beaconCharge' ? 7 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Player craft (shared gouache painter when available)
    if (g.craft) {
      g.craft(ctx, body, S.t, PALETTE);
    } else {
      g.roundRect(ctx, body.x - 14, body.y - 9, 28, 18, 7, PALETTE.brass);
    }
    if (S.carrying) g.glowCircle(ctx, body.x, body.y + 16, 14, PALETTE.magenta, 0.7);

    // Victory: gold flood, then the dawn gradient seeps up the horizon.
    if (S.victory) {
      var vt = S.victoryT;
      ctx.save();
      ctx.globalAlpha = Math.min(0.5, vt * 0.6);
      ctx.fillStyle = PALETTE.amber;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      var seep = Math.min(1, vt / VICTORY_HOLD);
      var dh = H * 0.6 * seep;
      ctx.save();
      ctx.globalAlpha = 0.85 * seep;
      g.skyGradient(ctx, 0, H - dh, W, dh,
        [[0, PALETTE.dawnTop], [0.6, PALETTE.dawnMid], [1, PALETTE.ember]]);
      ctx.restore();
    }

    // Phase lesson banner
    if (S.bannerT > 0 && S.bannerText) {
      g.text(ctx, S.bannerText, W / 2, 120, {
        font: 'bold 22px monospace',
        color: '#fff',
        glow: PALETTE.aurora,
      });
    }

    // FX emitted in screen space — the stage owns rendering them.
    if (world.particles && world.particles.draw) world.particles.draw(ctx);
    if (world.floaters && world.floaters.draw) world.floaters.draw(ctx);
  }

  return {
    key: 'storm-roc',
    title: 'The Storm Roc',
    banner: 'FINAL EXAM — every lesson, one last delivery',
    palette: PALETTE,
    slingConfig: {
      muzzle: 460,
      inherit: 0.5,
      flatTime: 0.22,
      gravity: 600,
      cadenceHeld: 3.5,
      fanCount: 1,
      fanSpreadDeg: 14,
      payloadTag: 'shot',
    },
    init: init,
    update: update,
    draw: draw,
    isDone: isDone,
    // Test/debug hook — not part of the stage contract; the machine never
    // calls it. Exposes live internal state for headless logic tests.
    _state: function () { return S; },
  };
});
