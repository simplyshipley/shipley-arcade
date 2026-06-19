/*
 * Stage 1 — GALE RUN. Side-scroll P-47 gunplay + Choplifter rescue over a
 * 6-screen coastal level at storm dawn. Free-scroll camera follows the
 * player in world-x. Teaching ramp (calm corridor + dotted sling hint),
 * flak kites with cuttable tethers, gale gull flocks (altitude duel),
 * patrol skiffs with altitude-recorded fragmenting flak, invulnerable
 * sea-spout sweeps, perch-landing rescue with a 3-keeper hold, harbor
 * unload, 120s fail-soft timer. Pure logic in update(); draw() only
 * renders. Spec: design-spec stages[0].
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
    (root.Stages = root.Stages || {})['gale-run'] =
      factory(root.Core, root.Physics, root.Collision, root.Spawner);
  }
})(typeof self !== 'undefined' ? self : this, function (Core, Physics, Collision, Spawner) {
  'use strict';

  // ── Spec-pinned numbers (design-spec stages[0] + sharedSystems) ──────
  var LEVEL_W = 5760;          // 6 screens × 960
  var STAGE_TIME = 120;        // s — stage timer
  var CALM_TIME = 12;          // s calm corridor: no shooters
  var HINT_TIME = 10;          // s dotted trajectory hint on sling shots
  var SOFT_LANDING = 120;      // px/s |vy| perch threshold
  var BOARD_TIME = 1.2;        // s per keeper boarding
  var CAPACITY = 3;            // keepers aboard max
  var KEEPER_TOTAL = 6;
  var KITE_COUNT = 4;          // kites total in the level
  var KITE_HP = 2;
  var KITE_RANGE = 380;        // px engagement radius
  var KITE_PERIOD = 2.5;       // s between 3-shot bursts
  var KITE_BURST = 3;
  var KITE_SHELL_SPEED = 140;  // px/s
  var SKIFF_HP = 3;
  var SKIFF_TELEGRAPH = 0.7;   // s blinking shell glow (spec-pinned; the
                               // shell then flies >=0.35s more before any
                               // fragment exists, so total danger lead
                               // stays >= 0.8s — only fragments hurt)
  var FRAG_COUNT = 4;
  var FRAG_SPEED = 160;        // px/s fragments at the recorded altitude
  var SPOUT_TELEGRAPH = 1.5;   // s spray telegraph at the spout base
  var FLOCK_EVERY = 9;         // s gull flock cadence after the corridor
  var FLOCK_SIZE = 3;
  var LIGHTNING_EVERY = 12;    // ~s between silhouette flashes (pure mood)
  var FLASH_FRAMES = 3;
  var HITSTOP = 0.04;          // 40ms world-freeze on duel kills (shared juice stack, #10)

  // ── Tuned values the spec leaves unpinned ────────────────────────────
  var AIM_TELEGRAPH = 0.85;    // s glow before kite bursts / gull dives (>= 0.8s rule)
  var UNLOAD_TIME = 0.4;       // s per keeper at the harbor (unpinned)
  var HARD_BOUNCE = 0.45;      // restitution on hard landings
  var KITE_SHELL_GRAV = 60;    // px/s² gentle arc on kite shells
  var KITE_FLOAT_RISE = 60;    // px/s cut balloon drift
  var SKIFF_RANGE = 460;       // px skiff engagement radius
  var SKIFF_COOL = 3.2;        // s between skiff lobs
  var SKIFF_SPEED = 30;        // px/s patrol drift
  var SHELL_RISE = 300;        // px/s skiff shell climb
  var SHELL_MIN_FLIGHT = 0.35; // s before a shell may burst
  var SHELL_TIMEOUT = 1.6;     // s fallback burst
  var SHELL_DRIFT_MAX = 130;   // px/s max shell horizontal lead
  var SPOUT_EVERY = 22;        // s spout cadence
  var SPOUT_FIRST = 20;        // s first spout
  var SPOUT_RISE = 0.8;        // s column climb
  var SPOUT_SWEEP = 3.5;       // s live sweep
  var SPOUT_FADE = 0.6;        // s harmless dissipation
  var SPOUT_SPEED = 70;        // px/s sweep drift
  var SPOUT_HALF_W = 30;       // px column half width
  var SPOUT_TOP = 90;          // px full-rise column top y
  var GULL_SPEED = 120;        // px/s flock gulls
  var CORRIDOR_GULL_SPEED = 50;// px/s teaching gulls (slow, never dive)
  var DIVE_SPEED = 240;        // px/s gull dive
  var DIVE_TRIGGER_DX = 170;
  var DIVE_TRIGGER_DY = 40;
  var DIVE_COOL = 2;           // s between dives per gull
  var CAM_ANCHOR = 0.45;       // player sits 45% across the screen
  var CEIL = 46;               // just under the HUD bar
  var SEA = 540;               // water line y

  // Geometry: harbor pad far West, three wrecked platforms East.
  var HARBOR = { id: 'harbor', cx: 230, y: 470, w: 200 };
  var PLATFORMS = [
    { id: 0, cx: 2980, y: 430, w: 130 },
    { id: 1, cx: 4150, y: 380, w: 120 },
    { id: 2, cx: 5350, y: 440, w: 130 },
  ];
  var KITE_X = [2300, 3350, 4500, 5100];
  // SPEC-DEVIATION: 5 skiffs, not 6 — "one skiff per screen" but the harbor
  // screen is kept shooter-free so the teaching corridor/home pad stay safe.
  var SKIFF_X = [1700, 2650, 3600, 4550, 5480];

  var R_PLAYER = 12, R_GULL = 10, R_BALLOON = 22, R_SKIFF = 20,
      R_SHELL = 7, R_FRAG = 7, R_SHOT = 6;
  var TETHER_HALF_W = 4;       // px — the separate 1 HP tether hitbox
  var TETHER_TOP_GAP = 20;     // tether starts below the balloon center
  var KITE_Y = 240;

  // ── State (module closure; checkpoint survives requestRestart) ──────
  var S = null;
  var restartPending = false;
  var checkpointKeepers = null; // delivered keepers stay credited
  var stageClearAwarded = false; // persists across hull-empty restart (#4)
  var scenery = null;           // draw-only; local rng, never world.rng

  function sfx(world, name, arg) {
    if (world.audio && world.audio.sfx) world.audio.sfx(name, arg);
  }
  function puff(world, x, y, color, count, speed) {
    var P = world.particles;
    if (P && P.burst) P.burst({ x: x, y: y, count: count || 10, color: color, speed: speed || 120 });
  }
  function preset(world, name, x, y, opts) {
    var P = world.particles;
    if (P && P.preset) P.preset(name, x, y, opts);
  }
  function floater(world, x, y, text, color) {
    if (world.floaters && world.floaters.add) world.floaters.add(x, y, text, color);
  }
  function shotHits(pr, x, y, r) {
    return !pr.dead && Collision.circleHit(pr.x, pr.y, R_SHOT, x, y, r);
  }
  function countKeepers(status) {
    var n = 0;
    for (var i = 0; i < S.keepers.length; i++) {
      if (S.keepers[i].status === status) n += 1;
    }
    return n;
  }
  function waitingOn(platform) {
    var n = 0;
    for (var i = 0; i < S.keepers.length; i++) {
      if (S.keepers[i].status === 'waiting' && S.keepers[i].platform === platform) n += 1;
    }
    return n;
  }

  // Route ALL player damage through hull + tailwind (contract). The shell
  // self-wires the hull-damage thud/flash/trauma — never double-fire here.
  function damagePlayer(world, opts) {
    // Stage already won/timed-out: the machine still ticks update for ~1.5s of
    // drain-grace with shells/frags/gulls live. A hit here must NOT route into
    // gameover -> requestRestart — that restarted a finished stage and re-awarded
    // stageClear (#4). Guard on the isDone condition, NOT S.over: S.over is
    // recomputed at the TOP of update (line ~726) while the win is set later the
    // same frame in updateHarbor, so S.over lags a frame and a same-frame gull
    // hit would slip through. win||timeUp is true the instant the stage ends.
    if (S && (S.win || S.timeUp)) return false;
    opts = opts || {};
    var res = world.hull.damage(1);
    if (res === 'shrugged') return false;
    world.tailwind.damage();
    var body = world.physics;
    if (opts.knockX != null) body.vx = opts.knockX;
    if (opts.knockY != null) body.vy = opts.knockY;
    puff(world, body.x, body.y, '#ff7a3c', 12, 150);
    if (res === 'gameover') {
      // Hull empty: keepers already delivered stay credited on restart.
      checkpointKeepers = [];
      for (var i = 0; i < S.keepers.length; i++) {
        checkpointKeepers.push(S.keepers[i].status === 'delivered' ? 'delivered' : 'waiting');
      }
      restartPending = true;
      world.requestRestart('gale-run:hull-empty');
    }
    return true;
  }

  // ── Spawns (deterministic: world.rng draws only in spawn order) ─────
  function spawnFlock(world, key) {
    var baseY = 140 + world.rng() * 180;
    var sx = S.camX + 960 + 60;
    for (var i = 0; i < FLOCK_SIZE; i++) {
      S.gulls.push({
        x: sx + i * 46, y: baseY, baseY: baseY, amp: 34, freq: 2.0, phase: i * 1.3,
        vx: -GULL_SPEED, t: 0, st: 0, dvx: 0,
        state: 'fly', dives: true, dead: false, contactCool: 0, diveCool: 0,
      });
    }
    S.spawnLog.push(['flock', Math.round(key * 1000) / 1000, Math.round(baseY)]);
  }

  function spawnSpout(world, key) {
    var x = S.camX + 240 + world.rng() * 480;
    S.spouts.push({
      x: x, state: 'tele', t: SPOUT_TELEGRAPH, topY: SEA,
      dir: world.physics.x >= x ? 1 : -1,
    });
    S.spawnLog.push(['spout', Math.round(key * 1000) / 1000, Math.round(x)]);
    sfx(world, 'telegraph');
  }

  // ── init / restart-checkpoint ────────────────────────────────────────
  function init(world) {
    var saved = null;
    if (restartPending) {
      saved = checkpointKeepers;
      restartPending = false;
    } else {
      checkpointKeepers = null;
      stageClearAwarded = false; // fresh entry only; a restart keeps the flag
    }
    S = {
      t: 0, timeLeft: STAGE_TIME, showHint: true,
      win: false, timeUp: false, over: false, hitstopT: 0,
      camX: 0,
      keepers: [], delivered: 0,
      boardT: 0, unloadT: 0, perched: null,
      gulls: [], kites: [], skiffs: [],
      kshells: [], sshells: [], frags: [], spouts: [],
      track: null, spawnLog: [],
      arrow: null,
      boltT: LIGHTNING_EVERY, flashN: 0,
      smokeT: 0, sprayT: 0,
      prevY: world.physics.y,
    };
    var i;
    for (i = 0; i < KEEPER_TOTAL; i++) {
      S.keepers.push({
        platform: Math.floor(i / 2),
        status: saved && saved[i] === 'delivered' ? 'delivered' : 'waiting',
      });
    }
    S.delivered = countKeepers('delivered');

    var body = world.physics;
    body.x = 320; body.y = 380; body.vx = 0; body.vy = 0; body.facing = 1;
    S.camX = Core.clamp(body.x - 960 * CAM_ANCHOR, 0, LEVEL_W - 960);
    if (world.camera) world.camera.x = S.camX;

    // Calm corridor: 3 slow teaching gulls — scoreable, never dive.
    for (i = 0; i < 3; i++) {
      S.gulls.push({
        x: 640 + i * 180, y: 220 + i * 40, baseY: 220 + i * 40,
        amp: 18, freq: 1.2, phase: i * 2.1,
        vx: -CORRIDOR_GULL_SPEED, t: 0, st: 0, dvx: 0,
        state: 'fly', dives: false, dead: false, contactCool: 0, diveCool: 0,
      });
    }
    for (i = 0; i < KITE_COUNT; i++) {
      S.kites.push({ x: KITE_X[i], y: KITE_Y, hp: KITE_HP, state: 'idle', t: 0, tether: true });
    }
    for (i = 0; i < SKIFF_X.length; i++) {
      S.skiffs.push({
        home: SKIFF_X[i], x: SKIFF_X[i], y: SEA - 14, dir: 1,
        hp: SKIFF_HP, dead: false, state: 'patrol', t: 0, cool: 0,
      });
    }

    S.track = new Spawner.Track(world.rng);
    S.track.every(FLOCK_EVERY, function (key) { spawnFlock(world, key); }, { start: CALM_TIME });
    S.track.every(SPOUT_EVERY, function (key) { spawnSpout(world, key); }, { start: SPOUT_FIRST, jitter: 0.25 });

    if (!scenery) buildScenery();
  }

  // ── Player: flap/sling, level bounds, perch landings, board/unload ──
  function updatePlayer(dt, world) {
    var body = world.physics;
    var input = world.input;
    var axis = input.axis();
    Physics.steer(body, axis.x, dt);
    if (input.justPressed(' ') || input.justPressed('z')) Physics.flap(body);

    // Empty-field slings cost nothing — unlimited ammo, no penalties.
    if (input.justPressed('x') && axis.y > 0) {
      world.projectiles.straightDrop(body);
    } else if (input.held('x')) {
      world.projectiles.holdFire(body, dt, { muzzleBonus: world.tailwind.muzzleBonus() });
    }

    S.prevY = body.y;
    Physics.integrate(body, dt);

    if (body.x < 16) { body.x = 16; if (body.vx < 0) body.vx = 0; }
    if (body.x > LEVEL_W - 16) { body.x = LEVEL_W - 16; if (body.vx > 0) body.vx = 0; }
    if (body.y < CEIL) { body.y = CEIL; if (body.vy < 0) body.vy = 0; }
    if (body.y > SEA - 12) {                 // wave skim — never costs hull
      body.y = SEA - 12;
      if (body.vy > 0) body.vy = 0;
      S.sprayT += dt;
      if (S.sprayT > 0.15) { S.sprayT = 0; preset(world, 'spray', body.x, SEA - 6); }
    }

    // Perch landings: flat decks, top side only, |vy| < 120 to stick.
    S.perched = null;
    var decks = [HARBOR].concat(PLATFORMS);
    for (var i = 0; i < decks.length; i++) {
      var d = decks[i];
      if (Math.abs(body.x - d.cx) <= d.w / 2 &&
          S.prevY <= d.y && body.y >= d.y && body.vy >= 0) {
        if (body.vy <= SOFT_LANDING) {
          body.y = d.y;
          body.vy = 0;
          S.perched = d.id;
        } else {                             // hard landing: bounce, no damage
          body.y = d.y;
          body.vy = -body.vy * HARD_BOUNCE;
          preset(world, 'dust', body.x, d.y);
        }
        break;
      }
    }

    // Choplifter beat: keepers board at 1.2s each, max 3 clinging.
    var aboard = countKeepers('aboard');
    if (!S.over && typeof S.perched === 'number' &&
        aboard < CAPACITY && waitingOn(S.perched) > 0) {
      S.boardT += dt;
      while (S.boardT >= BOARD_TIME && aboard < CAPACITY && waitingOn(S.perched) > 0) {
        S.boardT -= BOARD_TIME;
        for (var k = 0; k < S.keepers.length; k++) {
          var kp = S.keepers[k];
          if (kp.status === 'waiting' && kp.platform === S.perched) {
            kp.status = 'aboard';
            aboard += 1;
            floater(world, body.x, body.y - 22, 'KEEPER ABOARD', '#ff7a3c');
            sfx(world, 'delivery');
            break;
          }
        }
      }
    } else if (typeof S.perched !== 'number') {
      S.boardT = 0;
    }

    // Harbor unload: each keeper home scores a rescue.
    if (!S.over && S.perched === 'harbor' && aboard > 0) {
      S.unloadT += dt;
      while (S.unloadT >= UNLOAD_TIME && aboard > 0) {
        S.unloadT -= UNLOAD_TIME;
        for (var u = 0; u < S.keepers.length; u++) {
          var kp2 = S.keepers[u];
          if (kp2.status === 'aboard') {
            kp2.status = 'delivered';
            S.delivered += 1;
            aboard -= 1;
            world.tallies.rescues += 1;
            var pts = world.score.add('rescue');
            floater(world, HARBOR.cx, HARBOR.y - 30, '+' + pts + ' RESCUED', '#ff7a3c');
            break;
          }
        }
      }
    } else if (S.perched !== 'harbor') {
      S.unloadT = 0;
    }

    if (!S.win && S.delivered >= KEEPER_TOTAL) {
      S.win = true;                          // all 6 home ends the stage early
      if (!stageClearAwarded) {              // award exactly once per playthrough (#4)
        stageClearAwarded = true;
        world.score.add('stageClear');
        floater(world, HARBOR.cx, HARBOR.y - 56, 'ALL KEEPERS HOME', '#ffd27a');
        sfx(world, 'delivery');
      }
    }
  }

  // ── Gale gulls: sine flocks, telegraphed dives, the altitude duel ───
  function killGull(world, g) {
    g.dead = true;
    var pts = world.score.add('kill');
    preset(world, 'feathers', g.x, g.y);
    floater(world, g.x, g.y - 14, '+' + pts, '#ffd27a');
  }

  function updateGulls(dt, world) {
    var body = world.physics;
    for (var i = S.gulls.length - 1; i >= 0; i--) {
      var g = S.gulls[i];
      if (g.contactCool > 0) g.contactCool -= dt;
      if (g.diveCool > 0) g.diveCool -= dt;
      g.t += dt;

      if (g.state === 'fly') {
        g.x += g.vx * dt;
        g.y = g.baseY + g.amp * Math.sin(g.freq * g.t + g.phase);
        if (g.dives && g.diveCool <= 0 &&
            Math.abs(body.x - g.x) < DIVE_TRIGGER_DX && body.y > g.y + DIVE_TRIGGER_DY) {
          g.state = 'aim';                   // wing-flare telegraph (>= 0.8s)
          g.st = 0;
          sfx(world, 'telegraph');
        }
      } else if (g.state === 'aim') {
        g.st += dt;
        g.x += g.vx * 0.3 * dt;              // hover, wings flared
        if (g.st >= AIM_TELEGRAPH) {
          g.state = 'dive';
          g.st = 0;
          g.dvx = Core.clamp(body.x - g.x, -80, 80);
        }
      } else {                               // dive
        g.x += g.dvx * dt;
        g.y += DIVE_SPEED * dt;
        if (g.y > body.y + 60 || g.y > SEA - 40) {
          g.state = 'fly';
          g.baseY = Math.min(g.y, SEA - 80);
          g.t = 0;
          g.diveCool = DIVE_COOL;
        }
      }

      // 1 HP: any sling shot drops a gull.
      var list = world.projectiles.list;
      for (var j = 0; j < list.length; j++) {
        if (shotHits(list[j], g.x, g.y, R_GULL + 2)) {
          list[j].dead = true;
          killGull(world, g);
          break;
        }
      }

      // ALTITUDE DUEL on contact (light-flier tag).
      if (!g.dead && g.contactCool <= 0 &&
          Collision.circleHit(body.x, body.y, R_PLAYER, g.x, g.y, R_GULL)) {
        var verdict = Collision.altitudeDuel(body, g);
        if (verdict === 'kill') {
          body.vy = -160;                    // Joust kill rebound, no hull loss
          S.hitstopT = HITSTOP;              // 40ms hitstop — duel kills only, not sling kills (#10)
          killGull(world, g);
        } else if (verdict === 'hurt') {
          g.contactCool = 0.6;
          damagePlayer(world, { knockX: (body.x >= g.x ? 1 : -1) * 200, knockY: -140 });
        } else {
          Collision.bounce(body, g);
          g.contactCool = 0.3;
        }
      }

      if (g.dead || g.x < S.camX - 280 || g.x < -160 || g.x > S.camX + 960 + 720) {
        S.gulls.splice(i, 1);
      }
    }
  }

  // ── Flak kites: tethered turrets, cuttable 1 HP tether ──────────────
  function fireKiteBurst(world, k) {
    var body = world.physics;
    var base = Math.atan2(body.y - k.y, body.x - k.x);
    var spread = 12 * Math.PI / 180;
    for (var j = -1; j <= 1; j++) {
      var a = base + j * spread;
      S.kshells.push({
        x: k.x, y: k.y,
        vx: Math.cos(a) * KITE_SHELL_SPEED,
        vy: Math.sin(a) * KITE_SHELL_SPEED,
        age: 0,
      });
    }
  }

  function tetherHit(pr, k) {
    return !pr.dead &&
      Math.abs(pr.x - k.x) <= TETHER_HALF_W + R_SHOT / 2 &&
      pr.y >= k.y + TETHER_TOP_GAP && pr.y <= SEA;
  }

  function updateKites(dt, world) {
    var body = world.physics;
    var i, j, list;
    for (i = 0; i < S.kites.length; i++) {
      var k = S.kites[i];
      if (k.state === 'dead') continue;
      if (k.state === 'floating') {          // cut balloon drifts away, harmless
        k.y -= KITE_FLOAT_RISE * dt;
        if (k.y < -80) k.state = 'dead';
        continue;
      }

      list = world.projectiles.list;
      for (j = 0; j < list.length; j++) {
        var pr = list[j];
        if (k.tether && tetherHit(pr, k)) {  // separate 1 HP tether hitbox
          pr.dead = true;
          k.tether = false;
          k.state = 'floating';
          var pts = world.score.add('tetherCut');
          floater(world, k.x, k.y + 60, '+' + pts + ' TETHER CUT', '#ffd27a');
          puff(world, k.x, (k.y + SEA) / 2, '#ffd27a', 8, 90);
          break;
        }
        if (shotHits(pr, k.x, k.y, R_BALLOON)) {
          pr.dead = true;
          k.hp -= 1;
          puff(world, pr.x, pr.y, '#ffd27a', 6, 80);
          if (k.hp <= 0) {
            k.state = 'dead';
            var pts2 = world.score.add('kill');
            preset(world, 'feathers', k.x, k.y);
            floater(world, k.x, k.y - 20, '+' + pts2, '#ffd27a');
          }
          break;
        }
      }
      if (k.state !== 'idle' && k.state !== 'cool' && k.state !== 'aim') continue;

      // Fire control: in range, never during the calm corridor.
      var engaged = !S.over && S.t >= CALM_TIME &&
        Core.dist(body.x, body.y, k.x, k.y) <= KITE_RANGE;
      if (k.state === 'idle') {
        if (engaged) { k.state = 'cool'; k.t = KITE_PERIOD - AIM_TELEGRAPH; }
      } else if (k.state === 'cool') {
        if (!engaged) {
          k.state = 'idle';
        } else {
          k.t -= dt;
          if (k.t <= 0) { k.state = 'aim'; k.t = AIM_TELEGRAPH; sfx(world, 'telegraph'); }
        }
      } else if (k.state === 'aim') {        // committed: glow >= 0.8s, then burst
        k.t -= dt;
        if (k.t <= 0) {
          fireKiteBurst(world, k);
          k.state = 'cool';
          k.t = KITE_PERIOD - AIM_TELEGRAPH;
        }
      }
    }

    for (i = S.kshells.length - 1; i >= 0; i--) {
      var sh = S.kshells[i];
      sh.age += dt;
      sh.vy += KITE_SHELL_GRAV * dt;         // the arcing burst
      sh.x += sh.vx * dt;
      sh.y += sh.vy * dt;
      if (sh.y > SEA || sh.age > 5) {
        if (sh.y > SEA) preset(world, 'spray', sh.x, SEA);
        S.kshells.splice(i, 1);
        continue;
      }
      if (Collision.circleHit(body.x, body.y, R_PLAYER, sh.x, sh.y, R_SHELL)) {
        S.kshells.splice(i, 1);
        damagePlayer(world, { knockX: sh.vx, knockY: -120 });
      }
    }
  }

  // ── Patrol skiffs: altitude-recorded fragmenting flak ────────────────
  function launchSkiffShell(world, s) {
    var body = world.physics;
    var recY = body.y;                       // the P-47 graft: burst at RECORDED altitude
    var y0 = s.y - 16;
    var flight = Math.max(0.4, (y0 - recY) / SHELL_RISE);
    S.sshells.push({
      x: s.x, y: y0,
      vx: Core.clamp((body.x - s.x) / flight, -SHELL_DRIFT_MAX, SHELL_DRIFT_MAX),
      vy: -SHELL_RISE,
      recY: recY, age: 0,
    });
  }

  function updateSkiffs(dt, world) {
    var body = world.physics;
    var i, j;
    for (i = 0; i < S.skiffs.length; i++) {
      var s = S.skiffs[i];
      if (s.dead) continue;
      s.x += s.dir * SKIFF_SPEED * dt;
      if (Math.abs(s.x - s.home) > 80) s.dir = -s.dir;
      if (s.cool > 0) s.cool -= dt;

      var list = world.projectiles.list;
      for (j = 0; j < list.length; j++) {
        if (shotHits(list[j], s.x, s.y - 6, R_SKIFF)) {
          list[j].dead = true;
          s.hp -= 1;
          preset(world, 'spray', s.x, s.y - 10);
          if (s.hp <= 0) {
            s.dead = true;
            var pts = world.score.add('kill');
            floater(world, s.x, s.y - 26, '+' + pts, '#ffd27a');
            puff(world, s.x, s.y, '#e8f4f4', 16, 170);
          }
          break;
        }
      }
      if (s.dead) continue;

      if (s.state === 'patrol') {
        if (!S.over && S.t >= CALM_TIME && s.cool <= 0 &&
            Core.dist(body.x, body.y, s.x, s.y) <= SKIFF_RANGE) {
          s.state = 'tele';                  // 0.7s blinking shell glow
          s.t = SKIFF_TELEGRAPH;
          sfx(world, 'telegraph');
        }
      } else if (s.state === 'tele') {
        s.t -= dt;
        if (s.t <= 0) {
          launchSkiffShell(world, s);
          s.state = 'patrol';
          s.cool = SKIFF_COOL;
        }
      }
    }

    // Shells climb, then burst into 4 fragments at the recorded altitude.
    // The shell itself never hurts — only the fragments do.
    for (i = S.sshells.length - 1; i >= 0; i--) {
      var sh = S.sshells[i];
      sh.age += dt;
      sh.x += sh.vx * dt;
      sh.y += sh.vy * dt;
      if (sh.age >= SHELL_MIN_FLIGHT && (sh.y <= sh.recY || sh.age >= SHELL_TIMEOUT)) {
        var kk = FRAG_SPEED * Math.SQRT1_2;
        for (var fx = -1; fx <= 1; fx += 2) {
          for (var fy = -1; fy <= 1; fy += 2) {
            S.frags.push({ x: sh.x, y: sh.y, vx: fx * kk, vy: fy * kk, life: 2.2 });
          }
        }
        puff(world, sh.x, sh.y, '#ffd27a', 12, 140);
        S.sshells.splice(i, 1);
      }
    }

    for (i = S.frags.length - 1; i >= 0; i--) {
      var fr = S.frags[i];
      fr.life -= dt;
      fr.x += fr.vx * dt;
      fr.y += fr.vy * dt;
      if (fr.life <= 0 || fr.y > SEA || fr.y < -30) {
        S.frags.splice(i, 1);
        continue;
      }
      if (Collision.circleHit(body.x, body.y, R_PLAYER, fr.x, fr.y, R_FRAG)) {
        S.frags.splice(i, 1);
        damagePlayer(world, { knockX: fr.vx, knockY: -120 });
      }
    }
  }

  // ── Sea-spouts: invulnerable, telegraphed, dodge only ────────────────
  function updateSpouts(dt, world) {
    var body = world.physics;
    for (var i = S.spouts.length - 1; i >= 0; i--) {
      var sp = S.spouts[i];
      sp.t -= dt;
      if (sp.state === 'tele') {             // 1.5s spray at the base
        preset(world, 'spray', sp.x, SEA);
        if (sp.t <= 0) { sp.state = 'rise'; sp.t = SPOUT_RISE; }
      } else if (sp.state === 'rise') {
        sp.topY = SEA - (SEA - SPOUT_TOP) * (1 - Math.max(sp.t, 0) / SPOUT_RISE);
        if (sp.t <= 0) { sp.state = 'sweep'; sp.t = SPOUT_SWEEP; sp.topY = SPOUT_TOP; }
      } else if (sp.state === 'sweep') {
        sp.x += sp.dir * SPOUT_SPEED * dt;
        if (sp.t <= 0) { sp.state = 'fade'; sp.t = SPOUT_FADE; }
      } else if (sp.t <= 0) {                // fade: harmless dissipation
        S.spouts.splice(i, 1);
        continue;
      }
      if ((sp.state === 'rise' || sp.state === 'sweep') &&
          Math.abs(body.x - sp.x) < SPOUT_HALF_W && body.y > sp.topY) {
        damagePlayer(world, {
          knockX: (body.x >= sp.x ? 1 : -1) * 320,
          knockY: -120,
        });
      }
      // Invulnerable: sling shots are never checked against spouts.
    }
  }

  // ── Tailwind wiring: decay only while scorable targets are on-screen ─
  function hasTargets() {
    var lo = S.camX - 40, hi = S.camX + 960 + 40;
    var i;
    for (i = 0; i < S.gulls.length; i++) {
      if (!S.gulls[i].dead && S.gulls[i].x >= lo && S.gulls[i].x <= hi) return true;
    }
    for (i = 0; i < S.kites.length; i++) {
      var st = S.kites[i].state;
      if ((st === 'idle' || st === 'cool' || st === 'aim') &&
          S.kites[i].x >= lo && S.kites[i].x <= hi) return true;
    }
    for (i = 0; i < S.skiffs.length; i++) {
      if (!S.skiffs[i].dead && S.skiffs[i].x >= lo && S.skiffs[i].x <= hi) return true;
    }
    return false;
  }

  // ── HUD: arrows to the nearest keeper / harbor, timer, hold ─────────
  function computeArrow(world) {
    if (S.over) { S.arrow = null; return; }
    var body = world.physics;
    var aboard = countKeepers('aboard');
    var nearest = null;
    for (var i = 0; i < PLATFORMS.length; i++) {
      if (waitingOn(i) > 0) {
        if (nearest === null ||
            Math.abs(PLATFORMS[i].cx - body.x) < Math.abs(nearest.cx - body.x)) {
          nearest = PLATFORMS[i];
        }
      }
    }
    if (aboard > 0 && (aboard >= CAPACITY || nearest === null)) {
      S.arrow = { target: 'harbor', x: HARBOR.cx, dx: HARBOR.cx - body.x };
    } else if (nearest !== null && aboard < CAPACITY) {
      S.arrow = { target: 'keeper', x: nearest.cx, dx: nearest.cx - body.x };
    } else if (aboard > 0) {
      S.arrow = { target: 'harbor', x: HARBOR.cx, dx: HARBOR.cx - body.x };
    } else {
      S.arrow = null;
    }
  }

  function publishHud(world) {
    var aboard = countKeepers('aboard');
    world.hud.saved = {
      label: 'KEEPERS',
      value: S.delivered + '/' + KEEPER_TOTAL,
      ratio: S.delivered / KEEPER_TOTAL,
    };
    world.hud.aboard = { label: 'ABOARD', value: aboard + '/' + CAPACITY, ratio: aboard / CAPACITY };
    world.hud.time = {
      label: 'TIME',
      value: Math.ceil(S.timeLeft) + 's',
      ratio: S.timeLeft / STAGE_TIME,
      danger: 'low',   // red when time is nearly gone, not when it's full
    };
  }

  // ── update ───────────────────────────────────────────────────────────
  function update(dt, world) {
    if (S.hitstopT > 0) {                    // 40ms world-freeze on duel kills (#10)
      S.hitstopT -= dt;
      return;
    }
    S.t += dt;
    S.timeLeft = Math.max(0, STAGE_TIME - S.t);
    S.showHint = S.t < HINT_TIME;            // dotted arc: first 10s only
    if (!S.win && S.t >= STAGE_TIME) S.timeUp = true; // fail-soft: timer always ends it
    S.over = S.win || S.timeUp;

    if (S.flashN > 0) S.flashN -= 1;         // 3-frame lightning white-out
    S.boltT -= dt;
    if (S.boltT <= 0) { S.flashN = FLASH_FRAMES; S.boltT = LIGHTNING_EVERY; }

    world.tailwind.update(dt, hasTargets());

    updatePlayer(dt, world);
    world.projectiles.update(dt);            // stages drive projectiles (contract)
    if (!S.over) S.track.poll(S.t);          // no new hazards after isDone

    updateGulls(dt, world);
    updateKites(dt, world);
    updateSkiffs(dt, world);
    updateSpouts(dt, world);

    // Rescue sites breathe orange flare-smoke while keepers wait.
    S.smokeT += dt;
    if (S.smokeT >= 0.12) {
      S.smokeT = 0;
      for (var i = 0; i < PLATFORMS.length; i++) {
        if (waitingOn(i) > 0) {
          preset(world, 'embers', PLATFORMS[i].cx + (Math.random() * 30 - 15), PLATFORMS[i].y - 6);
        }
      }
    }

    computeArrow(world);
    publishHud(world);

    // Free-scroll camera follows the player across the 6 screens.
    var target = Core.clamp(world.physics.x - 960 * CAM_ANCHOR, 0, LEVEL_W - 960);
    S.camX += (target - S.camX) * Math.min(1, 6 * dt);
    if (world.camera) world.camera.x = S.camX;
  }

  function isDone() {
    return !!(S && (S.win || S.timeUp));
  }

  // ── draw ─────────────────────────────────────────────────────────────
  var PALETTE = {
    skyTop: '#1a2238',
    skyBottom: '#5a6f8c',
    ember: '#ff7a3c',
    sea: '#0b3d3a',
    seaDeep: '#072724',
    brass: '#d9b36a',
    teal: '#2aa7a0',
    keeper: '#ff7a3c',
    amber: '#ffd27a',
    spray: '#e8f4f4',
    silhouette: '#0d1117',
    deck: '#3a4458',
    deckDark: '#252c3d',
    outline: '#141821',
  };

  function buildScenery() {
    var rng = Core.makeRng(31);
    var i;
    scenery = { clouds: [], islands: [], crests: [] };
    for (i = 0; i < 26; i++) {
      scenery.clouds.push({
        x: rng() * (LEVEL_W * 0.1 + 1100), y: 40 + rng() * 140,
        w: 120 + rng() * 160, h: 18 + rng() * 26,
      });
    }
    for (i = 0; i < 12; i++) {
      scenery.islands.push({
        x: rng() * (LEVEL_W * 0.25 + 1100), w: 180 + rng() * 260, h: 40 + rng() * 90,
      });
    }
    for (i = 0; i < 90; i++) {
      scenery.crests.push({
        x: rng() * (LEVEL_W * 1.2 + 1100), w: 40 + rng() * 70,
        h: 8 + rng() * 14, phase: rng() * 6.28,
      });
    }
  }

  function drawBackdrop(ctx, world, mono) {
    var g = world.gfx;
    var W = world.W, H = world.H;
    var i, c;
    if (mono) {
      ctx.fillStyle = '#eaf4ff';
      ctx.fillRect(0, 0, W, H);
    } else {
      g.skyGradient(ctx, 0, 0, W, H, [[0, PALETTE.skyTop], [1, PALETTE.skyBottom]]);
      // Burnt-ember dawn band pinned at the horizon behind the storm wall.
      g.skyGradient(ctx, 0, SEA - 110, W, 110,
        [[0, 'rgba(255,122,60,0)'], [1, 'rgba(255,122,60,0.55)']]);
    }
    var ink = mono ? PALETTE.silhouette : null;

    // Layer 1: far storm clouds, 0.1x.
    ctx.fillStyle = ink || 'rgba(20,26,44,0.85)';
    for (i = 0; i < scenery.clouds.length; i++) {
      c = scenery.clouds[i];
      var cx1 = c.x - S.camX * 0.1;
      if (cx1 < -c.w || cx1 > W + c.w) continue;
      ctx.beginPath();
      ctx.ellipse(cx1, c.y, c.w / 2, c.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Layer 2: island silhouettes against the ember band, 0.25x.
    ctx.fillStyle = ink || '#10182b';
    for (i = 0; i < scenery.islands.length; i++) {
      c = scenery.islands[i];
      var cx2 = c.x - S.camX * 0.25;
      if (cx2 < -c.w || cx2 > W + c.w) continue;
      ctx.beginPath();
      ctx.moveTo(cx2 - c.w / 2, SEA);
      ctx.quadraticCurveTo(cx2, SEA - c.h, cx2 + c.w / 2, SEA);
      ctx.closePath();
      ctx.fill();
    }

    // Layer 3: rolling mid waves, 0.5x sine-displaced band.
    ctx.fillStyle = ink || PALETTE.sea;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (var x = 0; x <= W; x += 24) {
      var wy = SEA - 8 + Math.sin((x + S.camX * 0.5) * 0.02 + S.t * 1.4) * 6;
      ctx.lineTo(x, wy);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
    if (!mono) {
      g.skyGradient(ctx, 0, SEA, W, H - SEA, [[0, PALETTE.sea], [1, PALETTE.seaDeep]]);
    }
  }

  function drawForeground(ctx, world, mono) {
    // Layer 4: foreground spray crests, 1.2x — overlaps the player.
    var W = world.W;
    ctx.save();
    ctx.fillStyle = mono ? PALETTE.silhouette : 'rgba(232,244,244,0.5)';
    for (var i = 0; i < scenery.crests.length; i++) {
      var c = scenery.crests[i];
      var cx = c.x - S.camX * 1.2;
      if (cx < -c.w || cx > W + c.w) continue;
      var lift = Math.sin(S.t * 2.2 + c.phase) * 4;
      ctx.beginPath();
      ctx.ellipse(cx, SEA + 26 + lift, c.w / 2, c.h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawRain(ctx, world) {
    // Wind-angled rain streaks (draw-only).
    var W = world.W;
    ctx.save();
    ctx.strokeStyle = 'rgba(159,180,200,0.4)';
    ctx.lineWidth = 1;
    for (var i = 0; i < 50; i++) {
      var rx = ((i * 97 + S.t * 420 + S.camX * 0.3) % (W + 80)) - 40;
      var ry = ((i * 211 + S.t * 560) % (SEA + 60)) - 30;
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx - 7, ry + 16);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawDeck(ctx, world, d, wrecked) {
    var g = world.gfx;
    g.roundRect(ctx, d.cx - d.w / 2, d.y, d.w, 14, 4, PALETTE.deck);
    g.roundRect(ctx, d.cx - d.w / 2 + 6, d.y + 14, d.w - 12, SEA - d.y - 8, 4, PALETTE.deckDark);
    if (wrecked) {
      g.roundRect(ctx, d.cx - d.w / 2 - 14, d.y + 4, 22, 8, 3, PALETTE.deckDark);
    }
  }

  function drawHintArc(ctx, world) {
    // Dotted trajectory hint on sling shots — first 10s only.
    var body = world.physics;
    var cfg = world.projectiles.cfg;
    var speed = cfg.muzzle + world.tailwind.muzzleBonus();
    var vx = body.facing * speed + cfg.inherit * body.vx;
    var vy = cfg.inherit * body.vy;
    var px = body.x, py = body.y, t = 0, step = 0.06;
    ctx.save();
    ctx.fillStyle = 'rgba(255,210,122,0.7)';
    for (var i = 0; i < 15; i++) {
      t += step;
      var g = t > cfg.flatTime ? cfg.gravity : 0;
      vy += g * step;
      px += vx * step;
      py += vy * step;
      if (py > SEA) break;
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function draw(ctx, world) {
    var g = world.gfx;
    var W = world.W, H = world.H;
    var body = world.physics;
    var mono = S.flashN > 0;                 // lightning silhouette flash
    var i, j;

    drawBackdrop(ctx, world, mono);

    ctx.save();
    // Screenshake is centralized in StageMachine.draw (#1); apply only the
    // camera scroll here so the two transforms never compound into double-shake.
    ctx.translate(-Math.round(S.camX), 0);

    // Harbor + wrecked platforms (+ waiting keepers and flare glow).
    drawDeck(ctx, world, HARBOR, false);
    g.text(ctx, 'HARBOR', HARBOR.cx, HARBOR.y + 26, { font: 'bold 11px monospace', color: PALETTE.amber });
    for (i = 0; i < PLATFORMS.length; i++) {
      var p = PLATFORMS[i];
      drawDeck(ctx, world, p, true);
      var waiting = waitingOn(i);
      for (j = 0; j < waiting; j++) {
        g.roundRect(ctx, p.cx - 18 + j * 14, p.y - 13, 9, 13, 3, PALETTE.keeper);
      }
      if (waiting > 0 && !mono) {
        g.glowCircle(ctx, p.cx, p.y - 30, 26, PALETTE.ember, 0.25 + 0.1 * Math.sin(S.t * 3));
      }
    }

    // Sea-spouts (telegraph spray, then the live column).
    for (i = 0; i < S.spouts.length; i++) {
      var sp = S.spouts[i];
      if (sp.state === 'tele') {
        if (!mono) g.glowCircle(ctx, sp.x, SEA, 30, PALETTE.spray, 0.3 + 0.2 * Math.sin(S.t * 12));
      } else {
        var alpha = sp.state === 'fade' ? Math.max(sp.t, 0) / SPOUT_FADE : 0.75;
        ctx.save();
        ctx.globalAlpha = alpha * 0.7;
        g.roundRect(ctx, sp.x - SPOUT_HALF_W, sp.topY, SPOUT_HALF_W * 2, SEA - sp.topY, 14,
          mono ? PALETTE.silhouette : 'rgba(232,244,244,0.8)');
        ctx.restore();
      }
    }

    // Skiffs (blink glow while the lob telegraphs).
    for (i = 0; i < S.skiffs.length; i++) {
      var s = S.skiffs[i];
      if (s.dead) continue;
      if (s.state === 'tele' && !mono) {
        g.glowCircle(ctx, s.x, s.y - 16, 16, PALETTE.amber, 0.3 + 0.4 * Math.abs(Math.sin(S.t * 16)));
      }
      g.roundRect(ctx, s.x - 24, s.y - 8, 48, 12, 5, mono ? PALETTE.silhouette : PALETTE.deckDark);
      g.roundRect(ctx, s.x - 8, s.y - 16, 16, 9, 3, mono ? PALETTE.silhouette : PALETTE.brass);
    }

    // Kites: tether line + balloon turret (aim glow while telegraphing).
    for (i = 0; i < S.kites.length; i++) {
      var k = S.kites[i];
      if (k.state === 'dead') continue;
      var swayX = k.x + Math.sin(S.t * 1.1 + i) * 4; // sway is draw-only
      if (k.tether) {
        ctx.save();
        ctx.strokeStyle = mono ? PALETTE.silhouette : 'rgba(217,179,106,0.7)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(swayX, k.y + TETHER_TOP_GAP);
        ctx.lineTo(k.x, SEA);
        ctx.stroke();
        ctx.restore();
      }
      if (k.state === 'aim' && !mono) {
        g.glowCircle(ctx, swayX, k.y, 34, PALETTE.ember, 0.5);
      }
      g.roundRect(ctx, swayX - 22, k.y - 16, 44, 32, 14, mono ? PALETTE.silhouette : PALETTE.amber);
      g.roundRect(ctx, swayX - 22, k.y - 16, 44, 9, 5, mono ? PALETTE.silhouette : PALETTE.teal);
    }

    // Gale gulls (wing-flare glow during the dive telegraph).
    for (i = 0; i < S.gulls.length; i++) {
      var gl = S.gulls[i];
      if (gl.dead) continue;
      if (gl.state === 'aim' && !mono) g.glowCircle(ctx, gl.x, gl.y, 16, PALETTE.ember, 0.5);
      g.roundRect(ctx, gl.x - 9, gl.y - 5, 18, 10, 5, mono ? PALETTE.silhouette : PALETTE.spray);
      g.roundRect(ctx, gl.x - 2, gl.y - 8, 10, 5, 2, mono ? PALETTE.silhouette : PALETTE.teal);
    }

    // Enemy shells + fragments (additive amber rings).
    for (i = 0; i < S.kshells.length; i++) {
      if (!mono) g.glowCircle(ctx, S.kshells[i].x, S.kshells[i].y, 9, PALETTE.amber, 0.6);
      ctx.fillStyle = PALETTE.amber;
      ctx.beginPath();
      ctx.arc(S.kshells[i].x, S.kshells[i].y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    for (i = 0; i < S.sshells.length; i++) {
      if (!mono) g.glowCircle(ctx, S.sshells[i].x, S.sshells[i].y, 11, PALETTE.amber, 0.7);
      ctx.fillStyle = PALETTE.amber;
      ctx.beginPath();
      ctx.arc(S.sshells[i].x, S.sshells[i].y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = PALETTE.amber;
    for (i = 0; i < S.frags.length; i++) {
      ctx.beginPath();
      ctx.arc(S.frags[i].x, S.frags[i].y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Player shots (+ teaching-ramp dotted arc).
    if (S.showHint) drawHintArc(ctx, world);
    var list = world.projectiles.list;
    for (i = 0; i < list.length; i++) {
      ctx.save();
      ctx.globalAlpha = list[i].alpha == null ? 1 : list[i].alpha;
      ctx.fillStyle = PALETTE.amber;
      ctx.beginPath();
      ctx.arc(list[i].x, list[i].y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // The courier (+ keepers clinging to the hull).
    if (g.craft) {
      g.craft(ctx, body, S.t, PALETTE);
    } else {
      g.roundRect(ctx, body.x - 14, body.y - 9, 28, 18, 7, PALETTE.brass);
    }
    var aboard = countKeepers('aboard');
    for (i = 0; i < aboard; i++) {
      g.roundRect(ctx, body.x - 12 + i * 9, body.y + 9, 7, 10, 3, PALETTE.keeper);
    }

    if (world.particles && world.particles.draw) world.particles.draw(ctx);
    if (world.floaters && world.floaters.draw) world.floaters.draw(ctx);

    drawForeground(ctx, world, mono);
    ctx.restore();

    drawRain(ctx, world);

    if (mono) {                              // 3-frame white-out overlay
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // HUD arrow to the nearest keeper / the harbor (screen space).
    if (S.arrow) {
      var tx = S.arrow.x - S.camX;
      var label = S.arrow.target === 'harbor' ? 'HARBOR' : 'KEEPER';
      var bob = Math.sin(S.t * 5) * 4;
      ctx.save();
      ctx.fillStyle = PALETTE.ember;
      if (tx >= 50 && tx <= W - 50) {        // on screen: bobbing chevron above
        ctx.beginPath();
        ctx.moveTo(tx, 86 + bob);
        ctx.lineTo(tx - 8, 72 + bob);
        ctx.lineTo(tx + 8, 72 + bob);
        ctx.closePath();
        ctx.fill();
        g.text(ctx, label, tx, 62, { font: 'bold 11px monospace', color: PALETTE.ember });
      } else {                               // off screen: edge arrow
        var ex = S.arrow.dx > 0 ? W - 26 : 26;
        var dir = S.arrow.dx > 0 ? 1 : -1;
        ctx.beginPath();
        ctx.moveTo(ex + dir * 10, 78);
        ctx.lineTo(ex - dir * 6, 70);
        ctx.lineTo(ex - dir * 6, 86);
        ctx.closePath();
        ctx.fill();
        g.text(ctx, label, ex - dir * 30, 78, { font: 'bold 11px monospace', color: PALETTE.ember });
      }
      ctx.restore();
    }
  }

  return {
    key: 'gale-run',
    title: 'Gale Run',
    banner: 'LESSON — THE ARC: lead your shots, land soft, ferry the keepers home',
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
