/*
 * BULLSEYE BOMBARDIER — canvas shell: rendering, input, state machine.
 * All scoring/progression rules live in game-core.js (GameCore).
 *
 * Screens: title → controls → flight (top-down, SpyHunter-style scroll)
 *          → rescue (side-view, Choplifter-style) → summary.
 */
(function () {
  'use strict';
  var GC = window.GameCore;

  var W = 900, H = 600;
  var FLIGHT_SECONDS = 60;
  var RESCUE_SECONDS = 45;
  var GOLDEN_CHANCE = 0.15;

  var canvas, ctx;
  var keys = {};
  var screen = 'title';
  var game = null;
  var last = 0;

  // Deterministic per-row hash for background decoration (no Math.random per frame).
  function hash(n) {
    var x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  // ── Game state ──────────────────────────────────────────────────────
  function newGame() {
    return {
      score: new GC.ScoreKeeper(),
      vision: new GC.VisionMeter(),
      flight: null,
      rescue: null,
      rescuedTotal: 0,
      hazardHits: 0,
      shakeT: 0,
      shakeMag: 0,
      toasts: [],   // {text, t}
      floats: [],   // {x, y, text, t, color}
    };
  }

  function toast(text) {
    game.toasts.push({ text: text, t: 2.2 });
  }
  function floatText(x, y, text, color) {
    game.floats.push({ x: x, y: y, text: text, t: 1.2, color: color || '#fff' });
  }
  function shake(mag) {
    if (mag > 0) { game.shakeT = 0.35; game.shakeMag = mag; }
  }

  // ── FLIGHT mode (top-down scroller) ─────────────────────────────────
  var TARGET_KINDS = [
    { emoji: '🧍', r: 26 },
    { emoji: '🚗', r: 30 },
    { emoji: '🏠', r: 36 },
    { emoji: '🗽', r: 32 },
    { emoji: '🧺', r: 28 },
    { emoji: '⛲', r: 34 },
    { emoji: '🐄', r: 28 },
    { emoji: '⛵', r: 30 },
  ];

  function startFlight() {
    game.flight = {
      t: FLIGHT_SECONDS,
      scroll: 0,           // total world distance scrolled (for background rows)
      targets: [],         // {x, y, r, emoji, golden, splatted}
      payloads: [],        // {x, y, t, dur}
      decals: [],          // {x, y, r, t}
      bird: { x: W / 2, y: H - 130 },
      spawnIn: 0.3,
    };
    screen = 'flight';
  }

  function spawnTarget(f) {
    var kind = TARGET_KINDS[Math.floor(Math.random() * TARGET_KINDS.length)];
    f.targets.push({
      x: 60 + Math.random() * (W - 120),
      y: -50,
      r: kind.r,
      emoji: kind.emoji,
      golden: Math.random() < GOLDEN_CHANCE,
      splatted: false,
    });
  }

  function updateFlight(dt) {
    var f = game.flight;
    var bird = GC.birdForScore(game.score.score);
    game.vision.update(dt);
    var ts = game.vision.timeScale(); // world slows during Bird Vision
    var wdt = dt * ts;

    f.t -= dt;
    if (f.t <= 0) { startRescue(); return; }

    // Bird moves in real time — vision makes you feel fast.
    var sp = bird.speed;
    if (keys.ArrowLeft || keys.a) f.bird.x -= sp * dt;
    if (keys.ArrowRight || keys.d) f.bird.x += sp * dt;
    if (keys.ArrowUp || keys.w) f.bird.y -= sp * dt;
    if (keys.ArrowDown || keys.s) f.bird.y += sp * dt;
    f.bird.x = Math.max(30, Math.min(W - 30, f.bird.x));
    f.bird.y = Math.max(60, Math.min(H - 40, f.bird.y));

    // World scroll
    var scrollSpeed = 130 + bird.speed * 0.25;
    var dy = scrollSpeed * wdt;
    f.scroll += dy;

    f.spawnIn -= wdt;
    if (f.spawnIn <= 0) {
      spawnTarget(f);
      f.spawnIn = 0.55 + Math.random() * 0.7;
    }

    var i;
    for (i = f.targets.length - 1; i >= 0; i--) {
      f.targets[i].y += dy;
      if (f.targets[i].y > H + 60) f.targets.splice(i, 1);
    }
    for (i = f.decals.length - 1; i >= 0; i--) {
      f.decals[i].y += dy;
      f.decals[i].t -= dt;
      if (f.decals[i].y > H + 80 || f.decals[i].t <= 0) f.decals.splice(i, 1);
    }

    // Payloads fall (shrink) then splat; they drift with the world.
    for (i = f.payloads.length - 1; i >= 0; i--) {
      var p = f.payloads[i];
      p.y += dy;
      p.t += dt;
      if (p.t >= p.dur) {
        resolveSplat(p.x, p.y, bird);
        f.payloads.splice(i, 1);
      }
    }
  }

  function resolveSplat(x, y, bird) {
    var f = game.flight;
    // Score against the nearest scoreable target.
    var best = null, bestDist = Infinity;
    for (var i = 0; i < f.targets.length; i++) {
      var t = f.targets[i];
      if (t.splatted) continue;
      var d = GC.dist(x, y, t.x, t.y);
      if (d < bestDist) { bestDist = d; best = t; }
    }
    var base = 0;
    if (best) base = GC.scoreForDrop(bestDist, best.r, bird.splatRadius, best.golden);
    var beforeBird = GC.birdForScore(game.score.score);
    var pts = game.score.registerDrop(base);
    f.decals.push({ x: x, y: y, r: bird.splatRadius, t: 6 });

    if (pts > 0) {
      best.splatted = true;
      var label = '+' + pts + (game.score.combo > 1 ? '  x' + game.score.combo : '');
      floatText(x, y - 20, label, best.golden ? '#ffd700' : '#fff');
      if (best.golden) floatText(x, y - 44, 'GOLDEN!', '#ffd700');
      shake(bird.shake);
      var afterBird = GC.birdForScore(game.score.score);
      if (afterBird !== beforeBird) {
        toast(afterBird.emoji + ' ' + afterBird.name.toUpperCase() + ' UNLOCKED!');
        shake(8);
      }
    } else {
      floatText(x, y - 20, 'MISS', '#f66');
    }
  }

  function dropPayload() {
    var f = game.flight;
    f.payloads.push({ x: f.bird.x, y: f.bird.y, t: 0, dur: 0.45 });
  }

  // ── RESCUE mode (side-view interlude) ───────────────────────────────
  var HAZARD_KINDS = ['jet', 'balloon', 'lightning', 'skycat', 'drone'];
  var HAZARD_EMOJI = { jet: '✈️', balloon: '🎈', lightning: '⚡', skycat: '🐱', drone: '🛸' };

  function startRescue() {
    var chicks = [];
    for (var i = 0; i < 3; i++) {
      chicks.push({ x: 480 + i * 150 + Math.random() * 60, y: H - 70, taken: false });
    }
    game.rescue = {
      t: RESCUE_SECONDS,
      state: new GC.RescueState(3),
      bird: { x: 110, y: 300 },
      nest: { x: 70, y: H - 90, r: 42 },
      chicks: chicks,
      hazards: [],   // {kind, x, y, vx, vy, t, baseY}
      spawnIn: 1.2,
      stun: 0,
    };
    screen = 'rescue';
    toast('RESCUE! Carry 3 chicks 🐣 to the nest 🪹');
  }

  function spawnHazard(r) {
    var kind = HAZARD_KINDS[Math.floor(Math.random() * HAZARD_KINDS.length)];
    var h = { kind: kind, x: W + 40, y: 80 + Math.random() * (H - 220), vx: 0, vy: 0, t: 0 };
    h.baseY = h.y;
    if (kind === 'jet') h.vx = -340;
    if (kind === 'balloon') { h.vx = -70; h.vy = -22; h.y = H - 120; }
    if (kind === 'skycat') h.vx = -150;
    if (kind === 'drone') h.vx = -120;
    if (kind === 'lightning') { h.x = 200 + Math.random() * (W - 280); h.t = -0.9; } // warn phase
    r.hazards.push(h);
  }

  function updateRescue(dt) {
    var r = game.rescue;
    r.t -= dt;
    if (r.t <= 0) { endRescue(); return; }

    if (r.stun > 0) r.stun -= dt;

    var sp = 260;
    if (r.stun <= 0) {
      if (keys.ArrowLeft || keys.a) r.bird.x -= sp * dt;
      if (keys.ArrowRight || keys.d) r.bird.x += sp * dt;
      if (keys.ArrowUp || keys.w) r.bird.y -= sp * dt;
      if (keys.ArrowDown || keys.s) r.bird.y += sp * dt;
    }
    r.bird.x = Math.max(25, Math.min(W - 25, r.bird.x));
    r.bird.y = Math.max(50, Math.min(H - 60, r.bird.y));

    r.spawnIn -= dt;
    if (r.spawnIn <= 0) {
      spawnHazard(r);
      r.spawnIn = 0.9 + Math.random() * 0.9;
    }

    var i, h;
    for (i = r.hazards.length - 1; i >= 0; i--) {
      h = r.hazards[i];
      h.t += dt;
      h.x += h.vx * dt;
      if (h.kind === 'balloon') h.y += h.vy * dt;
      if (h.kind === 'skycat') h.y = h.baseY + Math.sin(h.t * 3) * 60;
      if (h.kind === 'drone') h.y += Math.sign(r.bird.y - h.y) * 60 * dt;
      if (h.x < -60 || h.y < -60 || (h.kind === 'lightning' && h.t > 0.5)) {
        r.hazards.splice(i, 1);
        continue;
      }
      // Lightning only deadly during strike phase (t in 0..0.5); others always.
      var deadly = h.kind !== 'lightning' ? true : h.t >= 0;
      if (deadly && r.stun <= 0) {
        var hit = h.kind === 'lightning'
          ? Math.abs(r.bird.x - h.x) < 26                      // full-height bolt column
          : GC.circlesOverlap(r.bird.x, r.bird.y, 20, h.x, h.y, 22);
        if (hit) {
          r.stun = 0.9;
          game.hazardHits += 1;
          var res = r.state.hitHazard();
          shake(5);
          if (res === 'dropped') {
            r.chicks.push({ x: r.bird.x, y: H - 70, taken: false });
            floatText(r.bird.x, r.bird.y - 30, 'CHICK DROPPED!', '#f66');
          } else {
            floatText(r.bird.x, r.bird.y - 30, 'OUCH! -100', '#f66');
          }
        }
      }
    }

    // Pick up a chick
    if (!r.state.carrying && r.stun <= 0) {
      for (i = 0; i < r.chicks.length; i++) {
        var c = r.chicks[i];
        if (!c.taken && GC.circlesOverlap(r.bird.x, r.bird.y, 22, c.x, c.y, 18)) {
          c.taken = true;
          r.state.pickup();
          floatText(c.x, c.y - 24, 'GOT ONE! 🐣', '#9f9');
          break;
        }
      }
    }

    // Deliver to nest
    if (r.state.carrying &&
        GC.circlesOverlap(r.bird.x, r.bird.y, 22, r.nest.x, r.nest.y, r.nest.r)) {
      var done = r.state.deliver();
      game.rescuedTotal += 1;
      floatText(r.nest.x + 30, r.nest.y - 40, 'RESCUED ' + r.state.rescued + '/3', '#9f9');
      if (done) endRescue();
    }
  }

  function endRescue() {
    var r = game.rescue;
    var bonus = GC.rescueBonus(r.state.rescued, r.state.hits);
    game.score.addBonus(bonus);
    screen = 'summary';
    game.summaryBonus = bonus;
  }

  // ── Update / draw loop ──────────────────────────────────────────────
  function update(dt) {
    if (game) {
      if (game.shakeT > 0) game.shakeT -= dt;
      var i;
      for (i = game.toasts.length - 1; i >= 0; i--) {
        game.toasts[i].t -= dt;
        if (game.toasts[i].t <= 0) game.toasts.splice(i, 1);
      }
      for (i = game.floats.length - 1; i >= 0; i--) {
        game.floats[i].t -= dt;
        game.floats[i].y -= 36 * dt;
        if (game.floats[i].t <= 0) game.floats.splice(i, 1);
      }
    }
    if (screen === 'flight') updateFlight(dt);
    else if (screen === 'rescue') updateRescue(dt);
  }

  function emoji(e, x, y, size) {
    ctx.font = size + 'px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(e, x, y);
  }

  function drawBullseye(t, visionActive) {
    if (t.golden && !visionActive && !t.splatted) {
      // Hidden golden target: faint shimmer only.
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = '#ffd700';
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      emoji(t.emoji, t.x, t.y, t.r * 1.2);
      return;
    }
    var rings = [t.r, (t.r * 2) / 3, t.r / 3];
    var colors = t.splatted
      ? ['#777', '#999', '#777']
      : t.golden
        ? ['#ffd700', '#fff7c0', '#ffd700']
        : ['#e33', '#fff', '#e33'];
    for (var i = 0; i < rings.length; i++) {
      ctx.fillStyle = colors[i];
      ctx.beginPath();
      ctx.arc(t.x, t.y, rings[i], 0, Math.PI * 2);
      ctx.fill();
    }
    emoji(t.emoji, t.x, t.y, t.r * 1.2);
    if (t.splatted) emoji('💩', t.x + t.r * 0.4, t.y - t.r * 0.4, t.r * 0.9);
  }

  function drawFlight() {
    var f = game.flight;
    var bird = GC.birdForScore(game.score.score);
    var vis = game.vision.active;

    // Scrolling ground: banded grass + deterministic decorations.
    var rowH = 60;
    var off = f.scroll % rowH;
    for (var y = -rowH; y < H + rowH; y += rowH) {
      var row = Math.floor((y - off + f.scroll) / rowH);
      ctx.fillStyle = row % 2 === 0 ? '#3f8f3f' : '#4a9d4a';
      if (hash(row) < 0.12) ctx.fillStyle = '#3a7ec2'; // river row
      ctx.fillRect(0, y + off, W, rowH);
      // flowers/rocks
      for (var k = 0; k < 4; k++) {
        var hx = hash(row * 7 + k) * W;
        if (hash(row * 13 + k) < 0.4) {
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.beginPath();
          ctx.arc(hx, y + off + hash(row + k) * rowH, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    var i;
    for (i = 0; i < f.decals.length; i++) {
      var d = f.decals[i];
      ctx.globalAlpha = Math.min(1, d.t / 2) * 0.85;
      ctx.fillStyle = '#6b4f2a';
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      emoji('💩', d.x, d.y, d.r);
    }

    for (i = 0; i < f.targets.length; i++) drawBullseye(f.targets[i], vis);

    for (i = 0; i < f.payloads.length; i++) {
      var p = f.payloads[i];
      var s = 1 - (p.t / p.dur) * 0.6;
      emoji('💩', p.x, p.y, 30 * s);
    }

    // Bird shadow + bird
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(f.bird.x, f.bird.y + 26, 20, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    emoji(bird.emoji, f.bird.x, f.bird.y, bird.name === 'Pterodactyl' ? 64 : 44);

    // Bird Vision overlay
    if (vis) {
      ctx.fillStyle = 'rgba(40,70,180,0.18)';
      ctx.fillRect(0, 0, W, H);
    }

    drawFlightHUD(bird);
  }

  function drawFlightHUD(bird) {
    var f = game.flight;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, 46);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('SCORE ' + game.score.score, 14, 23);
    ctx.fillText(bird.emoji + ' ' + bird.name, 220, 23);
    if (game.score.combo > 1) {
      ctx.fillStyle = '#ffd700';
      ctx.fillText('COMBO x' + game.score.combo, 420, 23);
    }
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'right';
    ctx.fillText('⏱ ' + Math.ceil(f.t), W - 14, 23);

    // Vision meter
    var vw = 140, vx = W - 320;
    ctx.fillStyle = '#333';
    ctx.fillRect(vx, 14, vw, 18);
    ctx.fillStyle = game.vision.active ? '#7fd4ff' : '#3a9ad9';
    ctx.fillRect(vx, 14, vw * (game.vision.value / game.vision.max), 18);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(vx, 14, vw, 18);
    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('VISION [V]', vx + vw / 2, 23);
  }

  function drawRescue() {
    var r = game.rescue;
    var bird = GC.birdForScore(game.score.score);

    // Sky gradient
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1c3a6e');
    g.addColorStop(1, '#79a8d8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Ground
    ctx.fillStyle = '#4a7c3a';
    ctx.fillRect(0, H - 50, W, 50);
    // Nest platform
    ctx.fillStyle = '#7a5a30';
    ctx.fillRect(r.nest.x - 55, H - 56, 110, 12);
    emoji('🪹', r.nest.x, r.nest.y, 56);

    var i;
    for (i = 0; i < r.chicks.length; i++) {
      if (!r.chicks[i].taken) emoji('🐣', r.chicks[i].x, r.chicks[i].y, 32);
    }

    for (i = 0; i < r.hazards.length; i++) {
      var h = r.hazards[i];
      if (h.kind === 'lightning') {
        if (h.t < 0) {
          ctx.globalAlpha = 0.25; // warning column
          ctx.fillStyle = '#ff0';
          ctx.fillRect(h.x - 20, 0, 40, H - 50);
          ctx.globalAlpha = 1;
          emoji('⚡', h.x, 40, 36);
        } else {
          ctx.globalAlpha = 0.8;
          ctx.fillStyle = '#fff66e';
          ctx.fillRect(h.x - 14, 0, 28, H - 50);
          ctx.globalAlpha = 1;
          emoji('⚡', h.x, 40, 44);
        }
      } else {
        emoji(HAZARD_EMOJI[h.kind], h.x, h.y, 40);
      }
    }

    // Bird (flash while stunned)
    if (r.stun <= 0 || Math.floor(r.stun * 12) % 2 === 0) {
      emoji(bird.emoji, r.bird.x, r.bird.y, 44);
      if (r.state.carrying) emoji('🐣', r.bird.x, r.bird.y + 30, 24);
    }

    // HUD
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, 46);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('RESCUED ' + r.state.rescued + '/3', 14, 23);
    ctx.fillText('HITS ' + r.state.hits, 220, 23);
    ctx.textAlign = 'right';
    ctx.fillText('⏱ ' + Math.ceil(r.t), W - 14, 23);
    ctx.textAlign = 'center';
    ctx.fillText('Carry 🐣 to the nest 🪹 — dodge hazards!', W / 2, 23);
  }

  function centerText(lines, startY, opts) {
    opts = opts || {};
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var y = startY;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      ctx.font = l.font || '20px monospace';
      ctx.fillStyle = l.color || '#fff';
      ctx.fillText(l.text, W / 2, y);
      y += l.gap || 36;
    }
  }

  function drawTitle() {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b1d3a');
    g.addColorStop(1, '#1c4a8e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    emoji('🦅', W / 2 - 200, 150, 64);
    emoji('🎯', W / 2, 150, 80);
    emoji('🦖', W / 2 + 200, 150, 64);
    centerText([
      { text: 'BULLSEYE BOMBARDIER', font: 'bold 52px monospace', color: '#ffd700', gap: 50 },
      { text: 'how birds see the world', font: 'italic 20px serif', color: '#9fc4ff', gap: 70 },
      { text: 'Fly. See the bullseyes. Drop the payload. 💩', gap: 40 },
      { text: 'Climb from Sparrow 🐤 to PTERODACTYL 🦖', gap: 70 },
      { text: '— PRESS ENTER —', font: 'bold 26px monospace', color: '#fff', gap: 0 },
    ], 250);
  }

  function drawControls() {
    ctx.fillStyle = '#0b1d3a';
    ctx.fillRect(0, 0, W, H);
    centerText([
      { text: 'HOW TO FLY', font: 'bold 36px monospace', color: '#ffd700', gap: 60 },
      { text: 'ARROWS / WASD ........ steer your bird', gap: 34 },
      { text: 'SPACE ................ drop payload 💩', gap: 34 },
      { text: 'V .................... BIRD VISION: slow time,', gap: 28 },
      { text: 'reveal hidden GOLDEN bullseyes (3x points)', color: '#ffd700', gap: 50 },
      { text: 'Closer to center = more points (100 / 50 / 25)', gap: 30 },
      { text: 'Consecutive hits build a combo multiplier (up to x3)', gap: 30 },
      { text: 'Score upgrades your bird — bigger bird, bigger splat', gap: 50 },
      { text: 'Then: RESCUE INTERLUDE — carry 3 chicks 🐣 home,', gap: 28 },
      { text: 'dodge Jet ✈️  Balloon 🎈  Lightning ⚡  Sky-Cat 🐱  Drone 🛸', gap: 60 },
      { text: '— PRESS ENTER TO TAKE OFF —', font: 'bold 24px monospace', gap: 0 },
    ], 80);
  }

  function drawSummary() {
    ctx.fillStyle = '#0b1d3a';
    ctx.fillRect(0, 0, W, H);
    var rank = GC.rankForScore(game.score.score);
    var bird = GC.birdForScore(game.score.score);
    emoji(bird.emoji, W / 2, 110, 90);
    centerText([
      { text: 'FLIGHT COMPLETE', font: 'bold 40px monospace', color: '#ffd700', gap: 60 },
      { text: 'FINAL SCORE: ' + game.score.score, font: 'bold 28px monospace', gap: 40 },
      { text: 'Best combo: x' + game.score.bestCombo, gap: 32 },
      { text: 'Chicks rescued: ' + game.rescuedTotal + '/3   (bonus +' + (game.summaryBonus || 0) + ')', gap: 32 },
      { text: 'Hazard hits: ' + game.hazardHits, gap: 50 },
      { text: 'RANK: ' + rank.name.toUpperCase(), font: 'bold 34px monospace', color: '#7fd4ff', gap: 70 },
      { text: '— PRESS ENTER TO FLY AGAIN —', font: 'bold 22px monospace', gap: 0 },
    ], 190);
  }

  function draw() {
    ctx.save();
    if (game && game.shakeT > 0) {
      ctx.translate((Math.random() - 0.5) * game.shakeMag, (Math.random() - 0.5) * game.shakeMag);
    }
    if (screen === 'title') drawTitle();
    else if (screen === 'controls') drawControls();
    else if (screen === 'flight') drawFlight();
    else if (screen === 'rescue') drawRescue();
    else if (screen === 'summary') drawSummary();

    if (game) {
      var i;
      for (i = 0; i < game.floats.length; i++) {
        var ft = game.floats[i];
        ctx.globalAlpha = Math.min(1, ft.t);
        ctx.fillStyle = ft.color;
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(ft.text, ft.x, ft.y);
        ctx.globalAlpha = 1;
      }
      for (i = 0; i < game.toasts.length; i++) {
        var to = game.toasts[i];
        ctx.globalAlpha = Math.min(1, to.t);
        ctx.fillStyle = '#ffd700';
        ctx.font = 'bold 34px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(to.text, W / 2, 120 + i * 44);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  function loop(ts) {
    var dt = Math.min(0.05, (ts - last) / 1000 || 0);
    last = ts;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  // ── Input ───────────────────────────────────────────────────────────
  function onKeyDown(e) {
    keys[e.key] = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].indexOf(e.key) >= 0) {
      e.preventDefault();
    }
    if (e.repeat) return;

    if (e.key === 'Enter') {
      if (screen === 'title') screen = 'controls';
      else if (screen === 'controls') { game = newGame(); startFlight(); }
      else if (screen === 'summary') { game = null; screen = 'title'; }
    }
    if (screen === 'flight') {
      if (e.key === ' ') dropPayload();
      if (e.key === 'v' || e.key === 'V') {
        if (game.vision.active) game.vision.deactivate();
        else game.vision.activate();
      }
    }
  }
  function onKeyUp(e) { keys[e.key] = false; }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // Test hook: lets the headless shell smoke test inspect state.
  window.__BB = {
    getScreen: function () { return screen; },
    getGame: function () { return game; },
  };

  window.addEventListener('load', function () {
    canvas = document.getElementById('game');
    canvas.width = W;
    canvas.height = H;
    ctx = canvas.getContext('2d');
    requestAnimationFrame(loop);
  });
})();
