/*
 * Shell: screens (title → controls → StageMachine → rank card), world
 * construction per CONTRACT.md, HUD, pause, restart, audio event wiring.
 * Browser-only — loaded last; in tests it runs inside a vm sandbox with a
 * stubbed window/document/canvas. All game rules live in core/ + stages/.
 */
(function (root) {
  'use strict';
  if (!root || !root.addEventListener) return; // shell needs a window-ish root

  var W = 960;
  var H = 600;
  var HUD_H = 36;
  var FLASH_TIME = 0.08;        // s — spec hit-flash
  var BANNER_TIME = 2.5;        // s — matches stageMachine banner window
  var RESTART_PENALTY = 500;
  var RESTART_SEGMENTS = 3;
  var DAWN_RETURN_TIME = 3;     // s for the dawn to seep back up the rank card
  var STAGE_ORDER = ['gale-run', 'switchback-post', 'spire-ascent', 'storm-roc'];
  // Spec objectives used for rank completeness: 6 keepers, 12 lanterns, beacon.
  var GOALS = { rescues: 6, deliveries: 12 };
  var TIER_COLORS = [null, '#8b93a7', '#7fd1c8', '#2aa7a0', '#ffd27a', '#ff7a3c'];
  // Emoji are allowed ONLY as rank-card medal accents (spec graphicsDirection).
  var MEDALS = ['🥉', '🥈', '🥇', '🏆'];
  var TITLE_PALETTE = {
    brass: '#d9b36a', teal: '#2aa7a0',
    skyTop: '#1a2238', skyBottom: '#5a6f8c', ember: '#ff7a3c',
  };

  function boot() {
    var Core = root.Core;
    var Physics = root.Physics;
    var Projectiles = root.Projectiles;
    var Score = root.Score;
    var StageMachine = root.StageMachine;
    var Engine = root.Engine;
    var gfx = Engine.gfx;

    var canvas = document.getElementById('game');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');

    var input = new Engine.Input(root);
    var audio = makeAudio(Engine);

    var state = {
      screen: 'title',
      t: 0,
      world: null,
      machine: null,
      lastIndex: -1,
      flash: 0,
      dawnT: 0,
      fanfared: false,
      boltT: 6,                 // title lightning timer
      trail: [],
      titleFx: new Engine.Particles(220),
      titleBody: { x: W * 0.5, y: H * 0.46, vx: 0, vy: 0, facing: 1 },
    };

    input.onAutoPause = function () {
      if (state.screen === 'play' && state.world) state.world.paused = true;
    };

    // ── Audio event wiring: one semantic layer over Engine.Audio ───────
    function makeAudio(E) {
      var a = new E.Audio();
      a.sfx = function (name, arg) {
        switch (name) {
          case 'flap':       // wing whoosh
            a.noise(0.07, 0.045);
            break;
          case 'sling':      // pop
            a.beep(700, 0.06, 'square', 0.06);
            break;
          case 'delivery':   // chime
            a.beep(880, 0.1, 'sine', 0.07);
            a.beep(1318, 0.16, 'sine', 0.06);
            break;
          case 'hit':        // thud
            a.beep(98, 0.16, 'sawtooth', 0.1);
            a.noise(0.1, 0.07);
            break;
          case 'telegraph':  // bell
            a.beep(1320, 0.05, 'triangle', 0.05);
            break;
          case 'redline':    // rising pitch; arg = heat ratio 0..1
            a.beep(380 + 620 * Math.max(0, Math.min(1, arg || 0)), 0.05, 'sawtooth', 0.045);
            break;
          case 'fanfare':    // 4-note rank fanfare
            var notes = [523, 659, 784, 1047];
            for (var i = 0; i < notes.length; i++) {
              (function (freq, delay) {
                if (typeof setTimeout === 'function') {
                  setTimeout(function () { a.beep(freq, 0.2, 'square', 0.08); }, delay);
                } else {
                  a.beep(freq, 0.2, 'square', 0.08);
                }
              })(notes[i], i * 150);
            }
            break;
        }
      };
      return a;
    }

    // ── World construction (CONTRACT.md `world`) ───────────────────────
    function stageList() {
      var Stages = root.Stages || {};
      var list = [];
      for (var i = 0; i < STAGE_ORDER.length; i++) {
        if (Stages[STAGE_ORDER[i]]) list.push(Stages[STAGE_ORDER[i]]);
      }
      return list;
    }

    function makeWorld() {
      var tailwind = new Score.Tailwind();
      var world = {
        W: W,
        H: H,
        input: input,
        camera: new Engine.Camera(),
        particles: new Engine.Particles(600),
        floaters: new Engine.Floaters(),
        audio: audio,
        gfx: gfx,
        physics: Physics.makeBody(W * 0.5, H * 0.5),
        projectiles: new Projectiles.System(),
        hull: new Core.Health({ maxHp: 5, lives: 1 }),
        score: null,
        tailwind: tailwind,
        rng: Core.makeRng(0xC0FFEE),
        hud: {},
        tallies: { rescues: 0, deliveries: 0, beaconLit: false, beaconFirstTry: null },
        restarts: 0,
        paused: false,
        // Hull-empty: -500, restart the current stage/checkpoint with 3
        // segments. A stage calls this from INSIDE its own update() — often
        // mid entity-loop — so we must NOT re-init synchronously (that would
        // swap the stage's state object out from under its live iterators and
        // throw). Queue it; the frame boundary drains it before the next
        // machine.update(). Checkpoint state is the stage's to keep on init.
        requestRestart: function (reason) {
          world._restartQueued = reason || true;
        },
      };
      world.score = new Score.Tally(tailwind);
      return world;
    }

    function startRun() {
      state.world = makeWorld();
      state.machine = new StageMachine.Machine(stageList(), state.world);
      state.lastIndex = state.machine.index;
      state.trail = [];
      state.flash = 0;
      state.fanfared = false;
      if (state.machine.current) {
        state.world.score.beginStage(state.machine.current.key);
      }
      state.screen = 'play';
      audio.sfx('telegraph');
    }

    // Apply a queued hull-empty restart between frames (safe re-init point).
    function drainRestart(world, machine) {
      world.score.penalty(RESTART_PENALTY);
      world.restarts += 1;
      world.hull.hp = RESTART_SEGMENTS;
      world.hull.lives = 1;
      world.hull.invuln = world.hull.invulnTime;
      world.projectiles.list.length = 0;
      world.paused = false;
      state.trail = [];                      // drop stale cross-stage trail
      var k;
      for (k in world.hud) {
        if (Object.prototype.hasOwnProperty.call(world.hud, k)) delete world.hud[k];
      }
      var m = machine || state.machine;
      if (m && m.current) {
        if (m.current.slingConfig) world.projectiles.configure(m.current.slingConfig);
        m.current.init(world);
        m.banner = m.current.banner;         // re-show the lesson line
        m.bannerT = BANNER_TIME;
      }
      audio.sfx('hit');
    }

    // ── Update ──────────────────────────────────────────────────────────
    function update(dt) {
      state.t += dt;
      if (state.screen === 'title') {
        updateTitle(dt);
        if (input.justPressed('Enter')) {
          state.screen = 'controls';
          audio.sfx('telegraph');
        }
      } else if (state.screen === 'controls') {
        if (input.justPressed('Enter')) startRun();
      } else if (state.screen === 'play') {
        updatePlay(dt);
      } else if (state.screen === 'rank') {
        state.dawnT += dt;
        if (input.justPressed('Enter')) {
          state.screen = 'title';
          state.world = null;
          state.machine = null;
        }
      }
    }

    function updateTitle(dt) {
      state.titleBody.y = H * 0.46 + Math.sin(state.t * 1.7) * 10;
      state.boltT -= dt;
      if (state.boltT <= -0.1) state.boltT = 9 + Math.random() * 6;
      for (var i = 0; i < 3; i++) {
        state.titleFx.preset('rain', Math.random() * W, -8);
      }
      state.titleFx.update(dt);
    }

    function updatePlay(dt) {
      var world = state.world;
      var machine = state.machine;

      if (input.justPressed('p')) {
        world.paused = !world.paused;
        audio.sfx('telegraph');
      }
      if (state.flash > 0) state.flash = Math.max(0, state.flash - dt);
      if (world.paused) return;

      // Shell-observable verb audio (stages own their own event audio too).
      if (input.justPressed(' ') || input.justPressed('z')) audio.sfx('flap');
      if (input.justPressed('x')) audio.sfx('sling');

      // Drain a queued restart at the frame boundary — never re-init a stage
      // synchronously from inside its own update (see requestRestart).
      if (world._restartQueued) {
        world._restartQueued = false;
        drainRestart(world, machine);
      }

      var prevHp = world.hull.hp;
      var prevDrops = (world.score.counts.delivery || 0) +
                      (world.score.counts.bullseye || 0) +
                      (world.score.counts.rescue || 0);

      machine.update(dt);

      // Per-stage tallies follow the machine.
      if (!machine.finished() && machine.current && machine.index !== state.lastIndex) {
        state.lastIndex = machine.index;
        world.score.beginStage(machine.current.key);
        state.trail = [];   // drop the ribbon trail's stale cross-stage coords
        audio.sfx('telegraph');
      }

      // Shell-observed juice: hull damage → flash + trauma + thud.
      if (world.hull.hp < prevHp) {
        state.flash = FLASH_TIME;
        world.camera.addTrauma(0.5);
        audio.sfx('hit');
      }
      if ((world.score.counts.delivery || 0) +
          (world.score.counts.bullseye || 0) +
          (world.score.counts.rescue || 0) > prevDrops) {
        audio.sfx('delivery');
      }

      // Stages drive world.projectiles inside their update; the shell only
      // drains them through the crossfade veil (stage updates are frozen).
      if (machine.fadeT >= 0) world.projectiles.update(dt);

      world.hull.update(dt);
      world.camera.update(dt);
      world.particles.update(dt);
      world.floaters.update(dt);

      // Ribbon-trail hook: gfx.craft draws body.trail in the tier color.
      var body = world.physics;
      state.trail.push({ x: body.x, y: body.y });
      if (state.trail.length > 16) state.trail.shift();
      body.trail = state.trail;
      body.ribbon = { color: TIER_COLORS[world.tailwind.tier] || TIER_COLORS[1] };

      if (machine.finished()) {
        state.screen = 'rank';
        state.dawnT = 0;
        if (!state.fanfared) {
          state.fanfared = true;
          audio.sfx('fanfare');
        }
      }
    }

    // ── Draw ────────────────────────────────────────────────────────────
    function draw() {
      ctx.save();
      ctx.fillStyle = '#06070d';
      ctx.fillRect(0, 0, W, H);
      if (state.screen === 'title') drawTitle();
      else if (state.screen === 'controls') drawControls();
      else if (state.screen === 'play') drawPlay();
      else if (state.screen === 'rank') drawRank();
      ctx.restore();
    }

    function drawTitle() {
      gfx.skyGradient(ctx, 0, 0, W, H, [
        [0, TITLE_PALETTE.skyTop], [0.62, TITLE_PALETTE.skyBottom],
        [0.78, '#b65a35'], [1, '#0b3d3a'],
      ]);
      gfx.glowCircle(ctx, W * 0.5, H * 0.74, 180, 'rgba(255,122,60,0.5)', 0.5);
      gfx.poly(ctx, [0, H * 0.78, 150, H * 0.7, 280, H * 0.78,
        620, H * 0.78, 760, H * 0.72, W, H * 0.78, W, H, 0, H], '#0e1526');
      state.titleFx.draw(ctx);
      if (state.boltT <= 0) { // lightning silhouette flash — pure mood
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = '#eaf4ff';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      gfx.craft(ctx, state.titleBody, state.t, TITLE_PALETTE);
      gfx.text(ctx, 'STORMWING EXPRESS', W / 2, H * 0.24,
        { font: 'bold 52px monospace', color: '#ffd27a', glow: '#ff7a3c', glowBlur: 22 });
      gfx.text(ctx, 'Flap hard, sling true — from dawn to midnight, the mail goes through.',
        W / 2, H * 0.31, { font: '15px monospace', color: '#9fb4c8' });
      if (Math.sin(state.t * 4) > -0.2) {
        gfx.text(ctx, 'PRESS ENTER', W / 2, H * 0.64,
          { font: 'bold 20px monospace', color: '#e8f4f4', glow: '#2aa7a0', glowBlur: 10 });
      }
      gfx.vignette(ctx, W, H, 0.4);
    }

    function drawControlLines(y0) {
      var lines = [
        'FLAP ........ SPACE / Z',
        'STEER ....... ARROWS / WASD',
        'SLING ....... X',
        'DROP ........ DOWN + X',
        'PAUSE ....... P',
      ];
      for (var i = 0; i < lines.length; i++) {
        gfx.text(ctx, lines[i], W / 2, y0 + i * 28,
          { font: 'bold 16px monospace', color: '#cfd6e4' });
      }
    }

    function drawControls() {
      gfx.skyGradient(ctx, 0, 0, W, H, [[0, '#1a2238'], [1, '#10182b']]);
      gfx.text(ctx, 'THE MAIL ROUTE', W / 2, H * 0.18,
        { font: 'bold 30px monospace', color: '#ffd27a', glow: '#ff7a3c', glowBlur: 14 });
      drawControlLines(H * 0.3);
      gfx.text(ctx, 'Empty-field throws cost nothing. Lead your arcs.',
        W / 2, H * 0.72, { font: '14px monospace', color: '#9fb4c8' });
      gfx.text(ctx, 'PRESS ENTER TO FLY', W / 2, H * 0.8,
        { font: 'bold 20px monospace', color: '#e8f4f4', glow: '#2aa7a0', glowBlur: 10 });
      gfx.vignette(ctx, W, H, 0.4);
    }

    function drawPlay() {
      var world = state.world;
      var machine = state.machine;
      machine.draw(ctx);
      drawBanner();
      drawHUD();
      if (state.flash > 0) gfx.hitFlash(ctx, W, H, (state.flash / FLASH_TIME) * 0.85);
      if (world.paused) drawPause();
    }

    function drawBanner() {
      var machine = state.machine;
      if (!machine.banner || !machine.current) return;
      var a = Math.min(1, machine.bannerT / 0.5); // fade out over the last 0.5s
      ctx.save();
      ctx.globalAlpha = 0.75 * a;
      ctx.fillStyle = '#06070d';
      ctx.fillRect(0, H * 0.36, W, 86);
      ctx.globalAlpha = a;
      gfx.text(ctx, String(machine.current.title).toUpperCase(), W / 2, H * 0.36 + 32,
        { font: 'bold 30px monospace', color: '#ffd27a', glow: '#ff7a3c', glowBlur: 14 });
      gfx.text(ctx, machine.banner, W / 2, H * 0.36 + 62,
        { font: '15px monospace', color: '#cfd6e4' });
      ctx.restore();
    }

    function drawHUD() {
      var world = state.world;
      ctx.save();
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = '#0a0d1b';
      ctx.fillRect(0, 0, W, HUD_H);
      ctx.restore();
      // Brass hull chevrons
      var hull = world.hull;
      for (var i = 0; i < hull.maxHp; i++) {
        var cx = 14 + i * 19;
        var lit = i < hull.hp;
        gfx.poly(ctx, [cx, 9, cx + 9, 9, cx + 14, 18, cx + 9, 27, cx, 27, cx + 5, 18],
          lit ? '#d9b36a' : '#272d3c');
      }
      // Ribbon tier
      var tier = world.tailwind.tier;
      gfx.text(ctx, '×' + tier, 132, 19, {
        font: 'bold 18px monospace', align: 'left',
        color: TIER_COLORS[tier] || '#8b93a7',
        glow: TIER_COLORS[tier], glowBlur: 8,
      });
      // Stage HUD rows ({label, value, ratio?})
      var x = 195;
      for (var k in world.hud) {
        if (!world.hud.hasOwnProperty(k)) continue;
        var row = world.hud[k];
        if (!row) continue;
        gfx.text(ctx, row.label + ' ' + row.value, x, 14,
          { font: 'bold 13px monospace', color: '#cfd6e4', align: 'left' });
        if (row.ratio != null) {
          var r = Math.max(0, Math.min(1, row.ratio));
          ctx.fillStyle = '#272d3c';
          ctx.fillRect(x, 22, 90, 6);
          // Red only signals DANGER, per the row's semantics: danger:'high'
          // reddens when the bar is near full (heat → redline); danger:'low'
          // reddens when it's nearly empty (time/progress running out).
          // Progress bars (no danger flag) stay calm teal — they were glowing
          // red when the player was WINNING, and TIME reddened with the MOST
          // time left (inverted). [#11]
          var danger = (row.danger === 'high' && r >= 0.85) ||
                       (row.danger === 'low' && r <= 0.18);
          ctx.fillStyle = danger ? '#ff5e54' : '#2aa7a0';
          ctx.fillRect(x, 22, 90 * r, 6);
        }
        x += 130;
      }
      // Score
      gfx.text(ctx, String(world.score.score), W - 14, 19,
        { font: 'bold 20px monospace', color: '#e8f4f4', align: 'right' });
    }

    function drawPause() {
      ctx.save();
      ctx.globalAlpha = 0.62;
      ctx.fillStyle = '#04050a';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      gfx.text(ctx, 'PAUSED', W / 2, H * 0.3,
        { font: 'bold 34px monospace', color: '#ffd27a', glow: '#ff7a3c', glowBlur: 14 });
      drawControlLines(H * 0.42);
      gfx.text(ctx, 'P — RESUME', W / 2, H * 0.76,
        { font: 'bold 16px monospace', color: '#e8f4f4', glow: '#2aa7a0', glowBlur: 10 });
    }

    function blend(a, b, t) {
      function ch(s, i) { return parseInt(s.substr(i, 2), 16); }
      var r = Math.round(ch(a, 1) + (ch(b, 1) - ch(a, 1)) * t);
      var g = Math.round(ch(a, 3) + (ch(b, 3) - ch(a, 3)) * t);
      var bl = Math.round(ch(a, 5) + (ch(b, 5) - ch(a, 5)) * t);
      return 'rgb(' + r + ',' + g + ',' + bl + ')';
    }

    // Completeness for rank: rescues + deliveries + beacon, equal thirds
    // (spec scoring: "completeness (rescues + deliveries + beacon)").
    function completeness(world) {
      var t = world.tallies;
      // Stage-1 fail-soft (design-spec stages[0].objective): ">=4 delivered
      // keeps full rank credit, fewer just costs rank." Without this, 4
      // rescues hard-locks STORM ROC out even on an otherwise perfect run.
      var r = t.rescues >= 4 ? 1 : t.rescues / GOALS.rescues;
      var d = Math.min(t.deliveries, GOALS.deliveries) / GOALS.deliveries;
      var b = t.beaconLit ? 1 : 0;
      return (r + d + b) / 3;
    }

    function drawRank() {
      var dawn = Math.min(1, state.dawnT / DAWN_RETURN_TIME);
      // Returning dawn: midnight lifting back into the stage-1 dawn sky.
      gfx.skyGradient(ctx, 0, 0, W, H, [
        [0, blend('#0a0d1f', '#1a2238', dawn)],
        [0.7, blend('#11152b', '#5a6f8c', dawn)],
        [1, blend('#1c2241', '#ff7a3c', dawn)],
      ]);
      var world = state.world;
      if (!world) return;
      var rank = Score.rankForRun({
        score: world.score.score,
        completeness: completeness(world),
        restarts: world.restarts,
        beaconFirstTry: world.tallies.beaconFirstTry === true,
      });
      gfx.text(ctx, MEDALS[rank.index] + '  ' + rank.name + '  ' + MEDALS[rank.index],
        W / 2, H * 0.16,
        { font: 'bold 36px monospace', color: '#ffd27a', glow: '#ff7a3c', glowBlur: 18 });
      gfx.text(ctx, 'SCORE ' + world.score.score, W / 2, H * 0.26,
        { font: 'bold 22px monospace', color: '#e8f4f4' });
      // Per-stage tallies
      var Stages = root.Stages || {};
      var y = H * 0.36;
      for (var i = 0; i < STAGE_ORDER.length; i++) {
        var key = STAGE_ORDER[i];
        if (world.score.stageTotals[key] == null) continue;
        var title = Stages[key] && Stages[key].title ? Stages[key].title : key;
        gfx.text(ctx, title, W * 0.32, y,
          { align: 'left', font: '16px monospace', color: '#9fb4c8' });
        gfx.text(ctx, String(world.score.stageTotals[key]), W * 0.68, y,
          { align: 'right', font: 'bold 16px monospace', color: '#e8f4f4' });
        y += 26;
      }
      y += 14;
      gfx.text(ctx, 'RESCUES ' + world.tallies.rescues + '/' + GOALS.rescues +
        '   DELIVERIES ' + world.tallies.deliveries + '/' + GOALS.deliveries +
        '   BEACON ' + (world.tallies.beaconLit ? 'LIT' : '—'),
        W / 2, y, { font: '14px monospace', color: '#9fb4c8' });
      y += 26;
      gfx.text(ctx, 'BEST RIBBON ×' + world.tailwind.best +
        '   RESTARTS ' + world.restarts, W / 2, y,
        { font: '14px monospace', color: TIER_COLORS[world.tailwind.best] || '#9fb4c8' });
      gfx.text(ctx, 'PRESS ENTER', W / 2, H * 0.86,
        { font: 'bold 18px monospace', color: '#e8f4f4', glow: '#2aa7a0', glowBlur: 10 });
    }

    // ── Loop ────────────────────────────────────────────────────────────
    // An uncaught exception must never kill the rAF chain (a dead chain
    // reads as a frozen game with no recovery). On error: keep looping,
    // show a crash card, and let Enter restart from the title.
    var last = 0;
    var crashed = null;
    function frame(now) {
      var dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      if (crashed) {
        drawCrash();
        if (input.justPressed('Enter')) {
          crashed = null;
          state.screen = 'title';
          state.world = null;
          state.machine = null;
        }
      } else {
        try {
          update(dt);
          draw();
        } catch (e) {
          crashed = e;
          if (typeof console !== 'undefined' && console.error) console.error(e);
        }
      }
      input.endFrame();
      requestAnimationFrame(frame);
    }
    function drawCrash() {
      ctx.fillStyle = '#0b0e1a';
      ctx.fillRect(0, 0, W, H);
      gfx.text(ctx, 'THE STORM ATE A GEAR', W / 2, H / 2 - 50,
        { font: 'bold 30px monospace', color: '#ff7a3c', glow: '#ff7a3c' });
      gfx.text(ctx, String(crashed && crashed.message || crashed).slice(0, 80), W / 2, H / 2,
        { font: '14px monospace', color: '#9fb4d8' });
      gfx.text(ctx, '— PRESS ENTER TO RESTART —', W / 2, H / 2 + 60,
        { font: 'bold 20px monospace', color: '#fff' });
    }
    requestAnimationFrame(frame);

    // Test hook (vm-harness; pattern from bullseye-bombardier __BB).
    root.__SW = {
      getScreen: function () { return state.screen; },
      getWorld: function () { return state.world; },
      getMachine: function () { return state.machine; },
      getState: function () { return state; },
    };
  }

  root.addEventListener('load', boot);
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
