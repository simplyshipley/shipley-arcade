/*
 * SPLAT HAPPENS — canvas shell. Renders the cel-cartoon park, routes input,
 * drives screens, the HUD, the share card, and the audio gags. ALL game
 * rules live in src/core.js + src/targets.js — this file only renders the
 * core's state and feeds it input.
 *
 * Loaded by the browser after core.js + targets.js. Exposes window.__SPLAT
 * for the headless vm test harness (test/shell.test.js).
 *
 * Style: vanilla ES5, no build step, no dependencies. UMD-free (browser
 * globals GameCore / GameTargets), but written defensively so the vm
 * harness can boot it with stubbed window/document/canvas.
 */
(function (root) {
  'use strict';

  var Core = root.GameCore;
  var Roster = root.GameTargets;

  // ── Palette (cel-cartoon: flat fills, one ink colour) ───────────────
  var INK = '#1d1d28';        // the single 3px outline colour
  var OUTLINE = 3;
  var SKY_TOP = '#a9dcf0';
  var SKY_BOTTOM = '#cdeaf3';
  var TREE_FAR = '#7fae6b';
  var TREE_NEAR = '#5f9450';
  var GRASS = '#86c46a';
  var GRASS_DARK = '#6fae57';
  var SIDEWALK = '#cdbfae';
  var SIDEWALK_LINE = '#b3a591';
  var POOP = '#7a5230';
  var POOP_HI = '#9a6a40';
  var BIRD_BODY = '#f0f0f4';
  var BIRD_WING = '#d8d8e2';
  var BIRD_BEAK = '#e0b34c';

  // Palette keys used by target sprites resolve to flat fills. Unknown
  // keys fall back to a warm muted default — never throw on render.
  var SWATCH = {
    'shirt-stripe-black-white': '#e8e8ee', 'facepaint-white-beret-shadow': '#f4f4f8', 'beret-red': '#c0473e',
    'smock-sage-green': '#a8c69a', 'beret-plum-too-small': '#7e5d86', 'easel-walnut-palette-rainbow': '#8a6a4a',
    'overalls-sky-blue': '#6fa8d8', 'cap-propeller-cherry': '#c0473e', 'cone-waffle-triple-scoop-pastel': '#e6c79a',
    'apron-white-cart-chrome': '#eef0f2', 'hat-paper-white-mustache-umber': '#f0f0f0', 'steam-puff-mustard-yellow': '#e0b34c',
    'windbreaker-coral': '#e08a6a', 'hair-ponytail-umber': '#7a5230', 'leashes-taut-five-fan': '#b89a6a',
    'vest-khaki-pockets': '#b8a878', 'binoculars-black-half-face': '#3a3a44', 'journal-moss-neck-string': '#7fae6b',
    'vest-stripe-candy-red': '#c0473e', 'cap-flat-slate': '#6a6a78', 'balloons-dozen-rainbow-cluster': '#d96a8a',
    'foam-duck-lemon-yellow': '#e6cf5a', 'duck-head-lemon-beak-tangerine': '#e6cf5a', 'human-head-tiny-sweaty': '#e6b89a',
    'bronze-patina-green': '#6f9a7a', 'bronze-cap-officer': '#5f8a6a', 'crate-milk-red-tip-hat-coins': '#c0473e',
    'tracksuit-jade-stripe': '#5aa88a', 'visor-white-sunglasses-oversize': '#f0f0f0', 'sneakers-blaze-orange': '#e08030',
    'coat-bench-ash-seed-dust': '#9a9488', 'hat-felt-brown-pigeon-perch': '#7a5230', 'pigeons-slate-shoulder-pair': '#8a8a96',
    'gown-white-splat-stains-persist': '#f2f2f6', 'veil-white-streaming': '#f6f6fa', 'heels-blush-carried-fist': '#e0a8b8'
  };
  function swatch(key, fallback) {
    return (key && SWATCH[key]) || fallback || '#c8b8a8';
  }

  // ── Layout constants ────────────────────────────────────────────────
  var W = 960, H = 540;
  var GROUND_Y = 430;          // sidewalk top (targets stand here)
  var SKY_BAND = 0.62;         // fraction of height that is sky
  var TARGET_W = 44, TARGET_H = 86;
  var BIRD_SPEED = 290;
  var PAYLOAD_SPEED = 360;     // downward base
  var SPLAT_R = 26;
  var MAX_TARGETS = 9, MIN_TARGETS = 6;

  // ── Tiny helpers ────────────────────────────────────────────────────
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function rand(a, b) { return a + Math.random() * (b - a); }

  // Normalize a KeyboardEvent.key to a stable lowercase token. Arrows and
  // space are preserved as their canonical names; letters lowercased.
  function normKey(k) {
    if (!k) return '';
    if (k === ' ' || k === 'Spacebar' || k === 'Space') return ' ';
    return k.toLowerCase();   // ArrowRight → 'arrowright', Enter → 'enter'
  }

  // ── Audio gags (WebAudio, lazily created, silent if unavailable) ────
  function Audio2() {
    this.ctx = null;
    this.ok = false;
  }
  Audio2.prototype._ensure = function () {
    if (this.ctx || this.ok === 'dead') return this.ctx;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) { this.ok = 'dead'; return null; }
    try { this.ctx = new AC(); this.ok = true; } catch (e) { this.ok = 'dead'; }
    return this.ctx;
  };
  // Descending slide whistle on poop drop.
  Audio2.prototype.slideWhistle = function () {
    var c = this._ensure();
    if (!c) return;
    try {
      var o = c.createOscillator();
      var g = c.createGain();
      o.type = 'sine';
      var t = c.currentTime;
      o.frequency.setValueAtTime(1400, t);
      o.frequency.exponentialRampToValueAtTime(300, t + 0.45);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + 0.5);
    } catch (e) {}
  };
  // One-shot blip family for verb reactions (boing/honk/splat).
  Audio2.prototype.blip = function (kind) {
    var c = this._ensure();
    if (!c) return;
    try {
      var o = c.createOscillator();
      var g = c.createGain();
      var t = c.currentTime;
      var f0 = 320, f1 = 320, type = 'square', dur = 0.12, vol = 0.16;
      if (kind === 'boing') { type = 'sine'; f0 = 220; f1 = 520; dur = 0.22; }
      else if (kind === 'honk') { type = 'sawtooth'; f0 = 180; f1 = 120; dur = 0.18; }
      else if (kind === 'splat') { type = 'square'; f0 = 160; f1 = 60; dur = 0.14; }
      else if (kind === 'pop') { type = 'triangle'; f0 = 600; f1 = 200; dur = 0.1; }
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + dur);
    } catch (e) {}
  };

  // Map a verb to its one-shot sound.
  var VERB_SOUND = {
    hop: 'boing', spin: 'boing', launch: 'pop', splash: 'splat',
    speak: 'honk', rage: 'honk', slip: 'boing', faint: 'splat',
    flee: 'pop', chase: 'honk', summon: 'pop', freeze: null,
    shake: null, transform: 'pop'
  };

  // ── Reaction VERB painters ──────────────────────────────────────────
  // ONE painter per verb. Each returns a transform descriptor the target
  // renderer applies (offset, rotation, scale squash/stretch) plus an
  // overlay flag list. Driven purely by the core FSM event + elapsed time.
  // p = phase 0..1 through the verb's visible window.
  function verbTransform(verb, params, p, beatTime) {
    var t = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, flush: 0 };
    var ease = Math.sin(Math.min(1, p) * Math.PI); // 0→1→0 bump
    switch (verb) {
      case 'hop': {
        var h = (params.height || 20);
        t.dy = -h * ease;
        t.sx = 1 + 0.18 * ease; t.sy = 1 - 0.18 * ease; // squash-stretch
        break;
      }
      case 'shake': {
        var inten = (params.intensity || 2);
        t.dx = Math.sin(beatTime * 40) * inten * (1 - p);
        break;
      }
      case 'spin': {
        var turns = (params.turns || 1);
        t.rot = p * turns * Math.PI * 2;
        break;
      }
      case 'flee': {
        var sp = (params.speed || 120);
        var dir = params.dir === 'right' ? 1 : -1;
        t.dx = dir * sp * p * 0.9;
        t.sx = 1.1; t.sy = 0.92;
        break;
      }
      case 'chase': {
        var cs = (params.speed || 120);
        t.dx = (cs * 0.012) * Math.sin(beatTime * 8) * 6; // lean bob
        t.dy = -2 * Math.abs(Math.sin(beatTime * 9));
        t.sx = 1.06; t.sy = 0.96;
        break;
      }
      case 'faint': {
        t.rot = (Math.PI / 2) * Math.min(1, p * 1.4); // tip backward
        t.dy = 6 * Math.min(1, p);
        t.sx = 1.05; t.sy = 0.95;
        break;
      }
      case 'slip': {
        t.rot = Math.sin(p * Math.PI) * 0.6;
        t.dy = 8 * ease;
        break;
      }
      case 'rage': {
        t.flush = 1 - Math.min(1, p);
        t.dx = Math.sin(beatTime * 30) * 2 * (1 - p);
        t.sy = 1 + 0.05 * ease;
        break;
      }
      case 'freeze': {
        // Mid-action freeze: eyes dart (handled in overlay), body still
        // but with a tiny jitter so it doesn't read as a pause bug.
        t.dx = Math.sin(beatTime * 22) * 0.4;
        break;
      }
      case 'launch':
      case 'splash':
      case 'speak':
      case 'summon':
      case 'transform':
        // These read mainly via overlay props (handled in drawTarget);
        // give the body a small acknowledgement pop on impact.
        t.sy = 1 - 0.08 * ease; t.sx = 1 + 0.08 * ease;
        break;
      default:
        break;
    }
    return t;
  }

  // ── Park drawing ────────────────────────────────────────────────────
  function drawBackground(ctx, scroll, t) {
    // Sky band
    var g = ctx.createLinearGradient(0, 0, 0, H * SKY_BAND);
    g.addColorStop(0, SKY_TOP);
    g.addColorStop(1, SKY_BOTTOM);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H * SKY_BAND + 40);

    // Far treeline (slow parallax)
    ctx.fillStyle = TREE_FAR;
    var fx = -((scroll * 0.15) % 180);
    for (var i = -1; i < W / 180 + 2; i++) {
      var bx = fx + i * 180;
      blob(ctx, bx, 250, 120, 90);
    }
    // Near treeline (faster parallax)
    ctx.fillStyle = TREE_NEAR;
    var nx = -((scroll * 0.3) % 220);
    for (var j = -1; j < W / 220 + 2; j++) {
      blob(ctx, nx + j * 220 + 90, 300, 150, 120);
    }

    // Sidewalk
    ctx.fillStyle = SIDEWALK;
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    ctx.strokeStyle = SIDEWALK_LINE;
    ctx.lineWidth = 2;
    var sx = -((scroll * 0.6) % 80);
    for (var k = 0; k < W / 80 + 2; k++) {
      var lx = sx + k * 80;
      ctx.beginPath(); ctx.moveTo(lx, GROUND_Y); ctx.lineTo(lx, H); ctx.stroke();
    }

    // Foreground grass strip above the sidewalk
    ctx.fillStyle = GRASS;
    ctx.fillRect(0, GROUND_Y - 22, W, 22);
    ctx.fillStyle = GRASS_DARK;
    var gx = -((scroll * 0.45) % 26);
    for (var m = 0; m < W / 26 + 2; m++) {
      var px = gx + m * 26;
      ctx.beginPath();
      ctx.moveTo(px, GROUND_Y);
      ctx.lineTo(px + 5, GROUND_Y - 14);
      ctx.lineTo(px + 10, GROUND_Y);
      ctx.closePath(); ctx.fill();
    }
  }

  function blob(ctx, x, y, w, h) {
    ctx.beginPath();
    ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Outlined flat-fill rounded box (the cel-cartoon primitive).
  function celBox(ctx, x, y, w, h, fill, r) {
    r = r || 8;
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
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = OUTLINE;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }

  // ── Game ────────────────────────────────────────────────────────────
  function Game(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.audio = new Audio2();
    this.screen = 'title';
    this.keys = {};
    this.scroll = 0;
    this.now = 0;
    this.reset(1);
    this.crashMsg = '';
  }

  // Build a fresh round. seed keeps spawns deterministic for tests.
  Game.prototype.reset = function (seed) {
    var rng = Core.createRng(seed || (Date.now() % 100000) + 1);
    this.rng = rng;
    this.roster = Roster.TARGETS;
    this.timer = new Core.RoundTimer(Core.ROUND_SECONDS);
    this.combo = new Core.ComboTracker();
    this.album = new Core.Album(this.roster);
    this.spawner = new Core.Spawner(this.roster, rng);
    this.score = 0;
    this.bestCombo = 1;
    this.bird = { x: W / 2, y: 140, vx: 0, vy: 0, flap: 0, facing: 1 };
    this.targets = [];
    this.payloads = [];
    this.decals = [];       // persistent ground/target splats
    this.props = [];        // launched objects flying out
    this.bubbles = [];      // speech bubbles
    this.spawnIn = 0.4;
    this.lastDiscovery = null;
    // Seed the opening cohort so the round starts populated (6-10 on screen).
    for (var s = 0; s < MIN_TARGETS; s++) {
      this.spawnTarget();
      // Fan the openers across the sidewalk instead of stacking at an edge.
      var last = this.targets[this.targets.length - 1];
      if (last) last.x = 80 + s * ((W - 160) / MIN_TARGETS);
    }
  };

  // ── Input ───────────────────────────────────────────────────────────
  Game.prototype.onKeyDown = function (k, repeat) {
    var key = normKey(k);
    if (key === '') return;
    // Menu / global keys (act on the edge, ignore auto-repeat).
    if (!repeat) {
      if (key === 'enter') { this.advance(); return; }
      // R is an instant restart from any non-title screen.
      if (key === 'r' && this.screen !== 'title') { this.restart(); return; }
      if (this.screen === 'play') {
        if (key === 'p') { this.togglePause(); return; }
        if (key === ' ') { this.poop(); }
      }
    }
    this.keys[key] = true;
  };
  Game.prototype.onKeyUp = function (k) {
    var key = normKey(k);
    if (key) this.keys[key] = false;
  };
  Game.prototype.clearKeys = function () {
    this.keys = {};
    // Auto-pause on focus loss while playing.
    if (this.screen === 'play' && !this.paused) this.togglePause();
  };

  Game.prototype.advance = function () {
    if (this.screen === 'title') {
      this.reset(this._seed || ((Date.now() % 100000) + 1));
      this.screen = 'play';
      this.paused = false;
    } else if (this.screen === 'endcard') {
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
  };
  Game.prototype.togglePause = function () {
    this.paused = !this.paused;
    if (this.paused) this.timer.pause(); else this.timer.resume();
  };

  // ── Spawning ────────────────────────────────────────────────────────
  Game.prototype.spawnTarget = function () {
    if (this.targets.length >= MAX_TARGETS) return;
    var pick = this.spawner.next();
    var def = pick.def;
    var fromLeft = pick.dir === 'left';
    var x = fromLeft ? -TARGET_W - 10 : W + 10;
    var t = {
      def: def,
      fsm: new Core.TargetFSM(def),
      x: x,
      baseY: GROUND_Y - TARGET_H,
      w: TARGET_W,
      h: TARGET_H,
      dir: fromLeft ? 1 : -1,
      golden: pick.golden,
      activeVerb: null,    // { verb, params, at } currently animating
      verbAge: 0,
      splatted: false,
      gone: false,
      summons: [],         // companions summoned by reactions (visual only)
      airborne: false,     // balloon-vendor transform
      tangle: false
    };
    this.targets.push(t);
  };

  // Walk targets along the sidewalk per their pattern.
  Game.prototype.moveTarget = function (t, dt) {
    if (t.fsm.busy()) return; // freeze movement during a reaction beat
    var w = t.def.walk || {};
    var speed = w.speed || 0;
    var pat = w.pattern || 'idle';
    if (pat === 'idle') speed = 0;
    if (pat === 'jog') speed *= 1.15;
    t.x += t.dir * speed * dt;
    // Exit cleanup
    if (t.x < -TARGET_W - 60 || t.x > W + 60) t.gone = true;
  };

  // ── Poop ────────────────────────────────────────────────────────────
  Game.prototype.poop = function () {
    var b = this.bird;
    this.payloads.push({
      x: b.x,
      y: b.y + 14,
      vx: b.vx * 0.35,        // slight forward inheritance
      vy: 80,
      age: 0
    });
    this.timer.payloadLaunched();
    this.audio.slideWhistle();
  };

  // Resolve a landed payload: scan ALL overlapping targets, score each,
  // fire its reaction, record album discoveries, drop a decal.
  Game.prototype.landPayload = function (pl) {
    var splat = { x: pl.x, y: pl.y, r: SPLAT_R };
    // Build a box list the core can resolve against.
    var boxes = [];
    for (var i = 0; i < this.targets.length; i++) {
      var t = this.targets[i];
      if (t.splatted && false) {} // (targets can be hit repeatedly)
      if (t.gone) continue;
      boxes.push({ x: t.x, y: t.baseY, w: t.w, h: t.h, _ref: t });
    }
    var hits = Core.resolveSplat(splat, boxes);
    var time = this.timer.elapsed;
    if (hits.length === 0) {
      this.combo.registerGroundSplat();
      this.decals.push({ x: pl.x, y: Math.min(pl.y, GROUND_Y + 12), r: rand(14, 22), onGround: true });
      this.audio.blip('splat');
    } else {
      for (var h = 0; h < hits.length; h++) {
        var ref = hits[h]._ref;
        this.hitTarget(ref, time);
        this.decals.push({ x: ref.x + ref.w / 2, y: ref.baseY + 12, r: rand(12, 18), onGround: false, follow: ref });
      }
    }
    this.timer.payloadResolved();
  };

  Game.prototype.hitTarget = function (t, time) {
    var mult = this.combo.registerHit(time);
    var res = t.fsm.hit(t.golden);
    var pts = Math.round(res.points * mult);
    this.score += pts;
    if (this.combo.bestChain > this.bestCombo - 1) {
      this.bestCombo = Math.max(this.bestCombo, this.combo.bestChain);
    }
    if (res.albumKey && this.album.discover(res.albumKey)) {
      this.lastDiscovery = { name: t.def.name, at: this.now };
    }
    t.splatted = true;
    this.audio.blip('splat');
  };

  // Pull due FSM events for a target and turn them into shell visuals.
  Game.prototype.pumpFSM = function (t, dt) {
    var events = t.fsm.step(dt);
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var params = Core.parseParams(ev.verb, ev.params);
      t.activeVerb = { verb: ev.verb, params: params };
      t.verbAge = 0;
      this.applyVerbSideEffects(t, ev.verb, params);
      var snd = VERB_SOUND[ev.verb];
      if (snd) this.audio.blip(snd);
    }
    if (t.activeVerb) {
      t.verbAge += dt;
      // Verb visual lasts ~0.9s then settles back to idle.
      if (t.verbAge > 1.1 && !t.fsm.busy()) t.activeVerb = null;
    }
  };

  // Verbs that change persistent shell state or spawn visual companions.
  Game.prototype.applyVerbSideEffects = function (t, verb, params) {
    if (verb === 'launch') {
      var count = clamp(params.count || 3, 1, 12);
      for (var i = 0; i < count; i++) {
        this.props.push({
          x: t.x + t.w / 2, y: t.baseY + 20,
          vx: rand(-160, 160), vy: rand(-280, -120),
          age: 0, life: rand(0.7, 1.2),
          color: '#c8a868'
        });
      }
    } else if (verb === 'splash') {
      var col = splashColor(params.color);
      for (var j = 0; j < 14; j++) {
        this.props.push({
          x: t.x + t.w / 2, y: t.baseY + t.h / 2,
          vx: rand(-200, 200), vy: rand(-240, -40),
          age: 0, life: rand(0.5, 0.9), color: col, dot: true
        });
      }
    } else if (verb === 'speak') {
      var line = (params.line || '').slice(0, Core.SPEAK_MAX_CHARS);
      this.bubbles.push({ follow: t, line: line, age: 0, life: 1.6 });
    } else if (verb === 'summon') {
      t.summons.push({ thing: params.thing || 'friend', x: t.x + t.dir * -30, phase: 0 });
    } else if (verb === 'transform') {
      if (params.state === 'airborne') t.airborne = true;
      if (params.state === 'tangled') t.tangle = true;
      t.transformed = params.state;
    }
  };

  // ── Per-frame update ────────────────────────────────────────────────
  Game.prototype.update = function (dt) {
    this.now += dt;
    this.scroll += dt * 30;
    if (this.screen !== 'play') return;
    if (this.paused) return;

    // Bird steering (gravity-free arcade).
    var b = this.bird;
    var ax = 0, ay = 0;
    if (this.keys['arrowleft'] || this.keys['a']) ax -= 1;
    if (this.keys['arrowright'] || this.keys['d']) ax += 1;
    if (this.keys['arrowup'] || this.keys['w']) ay -= 1;
    if (this.keys['arrowdown'] || this.keys['s']) ay += 1;
    b.vx = ax * BIRD_SPEED;
    b.vy = ay * BIRD_SPEED;
    if (ax !== 0) b.facing = ax > 0 ? 1 : -1;
    b.x = clamp(b.x + b.vx * dt, 30, W - 30);
    b.y = clamp(b.y + b.vy * dt, 40, GROUND_Y - 110);
    b.flap += dt * 14;

    // Timer
    this.timer.update(dt);

    // Spawns
    this.spawnIn -= dt;
    if ((this.spawnIn <= 0 && this.targets.length < MAX_TARGETS) || this.targets.length < MIN_TARGETS) {
      this.spawnTarget();
      this.spawnIn = rand(0.8, 1.8);
    }

    // Targets: FSM + movement
    var live = [];
    for (var i = 0; i < this.targets.length; i++) {
      var t = this.targets[i];
      this.pumpFSM(t, dt);
      this.moveTarget(t, dt);
      if (!t.gone) live.push(t);
    }
    this.targets = live;

    // Payloads fall, splat on ground or when low enough to resolve.
    var stillFlying = [];
    for (var p = 0; p < this.payloads.length; p++) {
      var pl = this.payloads[p];
      pl.age += dt;
      pl.vy += 520 * dt;             // gravity on the dropping
      pl.x += pl.vx * dt;
      pl.y += pl.vy * dt;
      if (pl.y >= GROUND_Y + 6 || this.overlapsAnyTarget(pl)) {
        this.landPayload(pl);
      } else {
        stillFlying.push(pl);
      }
    }
    this.payloads = stillFlying;

    // Props (launched bits) fly + fade.
    var liveProps = [];
    for (var q = 0; q < this.props.length; q++) {
      var pr = this.props[q];
      pr.age += dt;
      pr.vy += 600 * dt;
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      if (pr.age < pr.life) liveProps.push(pr);
    }
    this.props = liveProps;

    // Bubbles fade.
    var liveBubbles = [];
    for (var bk = 0; bk < this.bubbles.length; bk++) {
      var bub = this.bubbles[bk];
      bub.age += dt;
      if (bub.age < bub.life && !bub.follow.gone) liveBubbles.push(bub);
    }
    this.bubbles = liveBubbles;

    // Trim ground decals so they don't grow unbounded (persist generously).
    if (this.decals.length > 80) this.decals.splice(0, this.decals.length - 80);

    // End condition: timer up AND all in-flight payloads resolved.
    if (this.timer.isOver()) {
      this.endRound();
    }
  };

  Game.prototype.overlapsAnyTarget = function (pl) {
    if (pl.y < GROUND_Y - TARGET_H - 8) return false; // still high up
    for (var i = 0; i < this.targets.length; i++) {
      var t = this.targets[i];
      if (t.gone) continue;
      if (Core.circleRectOverlap(pl.x, pl.y, SPLAT_R, t.x, t.baseY, t.w, t.h)) return true;
    }
    return false;
  };

  Game.prototype.endRound = function () {
    this.screen = 'endcard';
    this.shareCardData = {
      score: this.score,
      bestCombo: Math.max(1, this.combo.bestMultiplier()),
      discovered: this.album.count,
      total: this.album.total
    };
  };

  // ── Share text + card (clipboard + PNG) ─────────────────────────────
  Game.prototype.shareText = function () {
    return Core.shareText(this.shareCardData || {
      score: this.score, bestCombo: this.combo.bestMultiplier(),
      discovered: this.album.count, total: this.album.total
    });
  };
  Game.prototype.copyResult = function () {
    var txt = this.shareText();
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      try { root.navigator.clipboard.writeText(txt); } catch (e) {}
    }
    return txt;
  };
  // Render the end card into an offscreen canvas and download as PNG.
  Game.prototype.saveCard = function () {
    var doc = root.document;
    var c = doc.createElement ? doc.createElement('canvas') : null;
    if (!c || !c.getContext) return false;
    c.width = 600; c.height = 720;
    var x = c.getContext('2d');
    this.paintShareCard(x, c.width, c.height);
    if (!c.toBlob) return false;
    var self = this;
    c.toBlob(function (blob) {
      if (!blob || !root.URL || !root.URL.createObjectURL) return;
      var url = root.URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url; a.download = 'splat-happens.png';
      if (doc.body) doc.body.appendChild(a);
      a.click();
      if (a.remove) a.remove();
      if (root.URL.revokeObjectURL) root.URL.revokeObjectURL(url);
    });
    return true;
  };

  // Standalone share-card painter (used by saveCard + visible end card).
  Game.prototype.paintShareCard = function (ctx, w, h) {
    var d = this.shareCardData || { score: this.score, bestCombo: 1, discovered: 0, total: this.album.total };
    ctx.fillStyle = '#2a2438'; ctx.fillRect(0, 0, w, h);
    celBox(ctx, 24, 24, w - 48, h - 48, '#3a3450', 18);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f0e0a0';
    ctx.font = 'bold 42px ui-monospace, monospace';
    ctx.fillText('SPLAT HAPPENS', w / 2, 100);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 64px ui-monospace, monospace';
    ctx.fillText(Core.formatScore(d.score), w / 2, 200);
    ctx.fillStyle = '#b8a8cc';
    ctx.font = '20px ui-monospace, monospace';
    ctx.fillText('POINTS', w / 2, 232);
    ctx.fillStyle = '#e0b34c';
    ctx.font = 'bold 30px ui-monospace, monospace';
    ctx.fillText('Best Combo  x' + Math.max(1, d.bestCombo), w / 2, 300);
    ctx.fillStyle = '#9ad8a0';
    ctx.fillText('Album  ' + d.discovered + ' / ' + d.total, w / 2, 348);
    // emoji progress bar
    ctx.font = '34px ui-monospace, monospace';
    ctx.fillStyle = '#fff';
    var bar = this.shareText().split('\n').pop();
    ctx.fillText(bar, w / 2, 420);
    ctx.textAlign = 'left';
  };

  // ── Render ──────────────────────────────────────────────────────────
  Game.prototype.draw = function () {
    var ctx = this.ctx;
    ctx.save();
    drawBackground(ctx, this.scroll, this.now);

    if (this.screen === 'title') { this.drawTitle(ctx); ctx.restore(); return; }
    if (this.screen === 'crash') { this.drawCrash(ctx); ctx.restore(); return; }

    // World: decals first (under everyone), then targets, props, bird, payloads.
    this.drawDecals(ctx);
    for (var i = 0; i < this.targets.length; i++) this.drawTarget(ctx, this.targets[i]);
    this.drawProps(ctx);
    this.drawBubbles(ctx);
    this.drawBird(ctx);
    this.drawPayloads(ctx);
    this.drawHUD(ctx);

    if (this.paused) this.drawPause(ctx);
    if (this.screen === 'endcard') this.drawEndcard(ctx);
    ctx.restore();
  };

  Game.prototype.drawDecals = function (ctx) {
    for (var i = 0; i < this.decals.length; i++) {
      var d = this.decals[i];
      var dx = d.x, dy = d.y;
      if (d.follow && !d.follow.gone) { dx = d.follow.x + d.follow.w / 2; dy = d.follow.baseY + 12; }
      ctx.fillStyle = POOP;
      ctx.beginPath();
      ctx.ellipse(dx, dy, d.r, d.r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = POOP_HI;
      ctx.beginPath();
      ctx.ellipse(dx - d.r * 0.3, dy - d.r * 0.15, d.r * 0.3, d.r * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  // The single target painter: flat body + head, eyes, then verb transform.
  Game.prototype.drawTarget = function (ctx, t) {
    var sp = t.def.sprite || {};
    var bodyFill = swatch(sp.body, '#c8b8a8');
    var headFill = swatch(sp.head, '#e6b89a');
    var accent = swatch(sp.accent, '#c0473e');

    var vt = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, flush: 0 };
    if (t.activeVerb) {
      var phase = clamp(t.verbAge / 0.9, 0, 1);
      vt = verbTransform(t.activeVerb.verb, t.activeVerb.params, phase, this.now);
    }

    var cx = t.x + t.w / 2 + vt.dx;
    var feetY = t.baseY + t.h + (t.airborne ? -90 - Math.sin(this.now * 2) * 8 : 0) + vt.dy;

    ctx.save();
    ctx.translate(cx, feetY);
    ctx.rotate(vt.rot);
    ctx.scale(vt.sx, vt.sy);

    // Body
    var bw = t.w, bh = t.h * 0.62;
    celBox(ctx, -bw / 2, -bh, bw, bh, vt.flush > 0 ? mix(bodyFill, '#d8443a', vt.flush) : bodyFill, 10);
    // Accent stripe / prop hint
    ctx.fillStyle = accent;
    ctx.fillRect(-bw / 2 + 4, -bh * 0.55, bw - 8, 6);

    // Head
    var headR = t.w * 0.42;
    celCircle(ctx, 0, -bh - headR * 0.7, headR, vt.flush > 0 ? mix(headFill, '#e07a6a', vt.flush) : headFill);

    // Eyes (big expressive); freeze = darting eyes.
    var eyeDart = (t.activeVerb && t.activeVerb.verb === 'freeze') ? Math.sin(this.now * 6) * 3 : 0;
    var ey = -bh - headR * 0.85;
    ctx.fillStyle = '#fff';
    celCircle(ctx, -7, ey, 6, '#fff');
    celCircle(ctx, 7, ey, 6, '#fff');
    ctx.fillStyle = INK;
    dot(ctx, -7 + eyeDart, ey, 2.6);
    dot(ctx, 7 + eyeDart, ey, 2.6);

    // Transform overlays (persistent)
    if (t.tangle) {
      ctx.strokeStyle = '#b89a6a'; ctx.lineWidth = 2;
      for (var w = 0; w < 4; w++) {
        ctx.beginPath();
        ctx.moveTo(-bw / 2, -bh + w * 8);
        ctx.lineTo(bw / 2, -bh + w * 8 + 4);
        ctx.stroke();
      }
    }
    if (t.golden) {
      ctx.strokeStyle = '#f0d060'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, -bh - headR * 0.7, headR + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // Summoned companions (drawn at ground, simple flat blobs).
    for (var s = 0; s < t.summons.length; s++) {
      var su = t.summons[s];
      celCircle(ctx, t.x + t.dir * -26 - s * 16, t.baseY + t.h - 12, 12, '#8a8a96');
    }
  };

  function dot(ctx, x, y, r) {
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  function mix(a, b, t) {
    // a, b are #rrggbb; t 0..1
    function hx(c, i) { return parseInt(c.slice(1 + i * 2, 3 + i * 2), 16); }
    var r = Math.round(hx(a, 0) * (1 - t) + hx(b, 0) * t);
    var g = Math.round(hx(a, 1) * (1 - t) + hx(b, 1) * t);
    var bl = Math.round(hx(a, 2) * (1 - t) + hx(b, 2) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }
  function splashColor(c) {
    if (c === 'yellow') return '#e6c84a';
    if (c === 'white') return '#f4f4f8';
    if (c === 'rainbow') return '#d96a8a';
    if (c === 'confetti') return '#6ab0d8';
    if (c === 'water') return '#7fc4e0';
    return '#d96a8a';
  }

  Game.prototype.drawProps = function (ctx) {
    for (var i = 0; i < this.props.length; i++) {
      var p = this.props[i];
      var a = clamp(1 - p.age / p.life, 0, 1);
      ctx.globalAlpha = a;
      if (p.dot) { celCircle(ctx, p.x, p.y, 5, p.color); }
      else { celBox(ctx, p.x - 5, p.y - 4, 10, 8, p.color, 2); }
      ctx.globalAlpha = 1;
    }
  };

  Game.prototype.drawBubbles = function (ctx) {
    ctx.font = 'bold 14px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (var i = 0; i < this.bubbles.length; i++) {
      var b = this.bubbles[i];
      var t = b.follow;
      var bx = t.x + t.w / 2;
      var by = t.baseY - 18;
      var tw = ctx.measureText ? (ctx.measureText(b.line).width || b.line.length * 8) : b.line.length * 8;
      var pad = 10;
      celBox(ctx, bx - tw / 2 - pad, by - 22, tw + pad * 2, 26, '#fff', 8);
      ctx.fillStyle = INK;
      ctx.fillText(b.line, bx, by - 4);
    }
    ctx.textAlign = 'left';
  };

  Game.prototype.drawBird = function (ctx) {
    var b = this.bird;
    var bob = Math.sin(this.now * 4) * 4;
    var flap = Math.sin(b.flap) * 10;
    ctx.save();
    ctx.translate(b.x, b.y + bob);
    ctx.scale(b.facing, 1);
    // Shadow on the ground (helps aim).
    ctx.restore();
    ctx.fillStyle = 'rgba(40,30,50,0.18)';
    ctx.beginPath();
    ctx.ellipse(b.x, GROUND_Y - 4, 18, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(b.x, b.y + bob);
    ctx.scale(b.facing, 1);
    // wings
    ctx.fillStyle = BIRD_WING;
    ctx.strokeStyle = INK; ctx.lineWidth = OUTLINE;
    ctx.beginPath();
    ctx.ellipse(-6, -2 - flap, 16, 8, -0.5, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    // body
    celCircle(ctx, 0, 0, 16, BIRD_BODY);
    // beak
    ctx.fillStyle = BIRD_BEAK;
    ctx.beginPath();
    ctx.moveTo(14, -2); ctx.lineTo(26, 1); ctx.lineTo(14, 4); ctx.closePath();
    ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.stroke();
    // eye
    celCircle(ctx, 6, -6, 5, '#fff');
    dot(ctx, 7, -6, 2.4);
    ctx.restore();
  };

  Game.prototype.drawPayloads = function (ctx) {
    for (var i = 0; i < this.payloads.length; i++) {
      var p = this.payloads[i];
      ctx.fillStyle = POOP;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 7, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.stroke();
    }
  };

  // ── HUD ─────────────────────────────────────────────────────────────
  Game.prototype.drawHUD = function (ctx) {
    ctx.fillStyle = INK;
    ctx.font = 'bold 22px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('SCORE ' + Core.formatScore(this.score), 18, 32);

    // Timer
    var rem = Math.ceil(this.timer.remaining());
    ctx.textAlign = 'right';
    ctx.fillText(pad2(Math.floor(rem / 60)) + ':' + pad2(rem % 60), W - 18, 32);

    // Album counter
    ctx.textAlign = 'center';
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.fillText('ALBUM ' + this.album.count + '/' + this.album.total, W / 2, 30);

    // Combo meter
    var mult = this.combo.multiplier();
    if (this.combo.isActive(this.timer.elapsed) && mult > 1) {
      ctx.textAlign = 'left';
      ctx.fillStyle = '#c0473e';
      ctx.font = 'bold 26px ui-monospace, monospace';
      ctx.fillText('x' + mult, 18, 60);
      // bar
      var frac = clamp(mult / Core.COMBO_MAX_MULTIPLIER, 0, 1);
      ctx.fillStyle = 'rgba(192,71,62,0.25)';
      ctx.fillRect(60, 46, 140, 14);
      ctx.fillStyle = '#c0473e';
      ctx.fillRect(60, 46, 140 * frac, 14);
    }

    // Last-discovery toast
    if (this.lastDiscovery && this.now - this.lastDiscovery.at < 2.2) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#1d7a3a';
      ctx.font = 'bold 18px ui-monospace, monospace';
      ctx.fillText('NEW REACTION: ' + this.lastDiscovery.name, W / 2, H - 24);
    }
    ctx.textAlign = 'left';
  };
  function pad2(n) { n = Math.max(0, n | 0); return n < 10 ? '0' + n : '' + n; }

  // ── Screens ─────────────────────────────────────────────────────────
  Game.prototype.drawTitle = function (ctx) {
    dimCenterPanel(ctx, 'SPLAT HAPPENS', '#f0e0a0');
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = '18px ui-monospace, monospace';
    ctx.fillText('Fly the park. Poop on everyone.', W / 2, H / 2 + 4);
    ctx.fillText('Every target reacts differently.', W / 2, H / 2 + 30);
    ctx.fillStyle = '#e0b34c';
    ctx.font = 'bold 20px ui-monospace, monospace';
    ctx.fillText('press ENTER to play', W / 2, H / 2 + 78);
    ctx.textAlign = 'left';
  };

  Game.prototype.drawPause = function (ctx) {
    ctx.fillStyle = 'rgba(26,22,40,0.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 40px ui-monospace, monospace';
    ctx.fillText('PAUSED', W / 2, H / 2);
    ctx.font = '16px ui-monospace, monospace';
    ctx.fillText('P resume · R restart', W / 2, H / 2 + 34);
    ctx.textAlign = 'left';
  };

  Game.prototype.drawEndcard = function (ctx) {
    ctx.fillStyle = 'rgba(26,22,40,0.72)';
    ctx.fillRect(0, 0, W, H);
    var cw = 420, ch = 380;
    var cx = (W - cw) / 2, cy = (H - ch) / 2;
    celBox(ctx, cx, cy, cw, ch, '#3a3450', 16);
    ctx.textAlign = 'center';
    var d = this.shareCardData || { score: this.score, bestCombo: 1, discovered: this.album.count, total: this.album.total };
    ctx.fillStyle = '#f0e0a0';
    ctx.font = 'bold 30px ui-monospace, monospace';
    ctx.fillText('ROUND OVER', W / 2, cy + 48);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 48px ui-monospace, monospace';
    ctx.fillText(Core.formatScore(d.score), W / 2, cy + 104);
    ctx.fillStyle = '#e0b34c';
    ctx.font = 'bold 22px ui-monospace, monospace';
    ctx.fillText('Best Combo x' + Math.max(1, d.bestCombo), W / 2, cy + 142);
    ctx.fillStyle = '#9ad8a0';
    ctx.fillText('Album ' + d.discovered + '/' + d.total, W / 2, cy + 174);

    // Silhouette row of locked album entries.
    var locked = this.album.silhouettes();
    var n = Math.min(locked.length, 8);
    var startX = W / 2 - (n * 30) / 2;
    for (var i = 0; i < n; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      celCircle(ctx, startX + i * 30 + 15, cy + 210, 11, 'rgba(0,0,0,0.35)');
    }

    // Action buttons (DOM-less hit zones drawn here; index.html wires touch).
    this._endButtons = [
      { id: 'copy', label: 'COPY RESULT', x: cx + 30, y: cy + 240, w: cw - 60, h: 42, color: '#2aa7a0' },
      { id: 'save', label: 'SAVE CARD', x: cx + 30, y: cy + 292, w: cw - 60, h: 42, color: '#8c5a9e' }
    ];
    for (var bI = 0; bI < this._endButtons.length; bI++) {
      var bt = this._endButtons[bI];
      celBox(ctx, bt.x, bt.y, bt.w, bt.h, bt.color, 10);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 18px ui-monospace, monospace';
      ctx.fillText(bt.label, bt.x + bt.w / 2, bt.y + 27);
    }
    ctx.fillStyle = '#b8a8cc';
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillText('ENTER for title', W / 2, cy + ch - 14);
    ctx.textAlign = 'left';
  };

  Game.prototype.drawCrash = function (ctx) {
    ctx.fillStyle = '#2a2438';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e08a6a';
    ctx.font = 'bold 30px ui-monospace, monospace';
    ctx.fillText('SPLAT HAPPENS... CRASHED', W / 2, H / 2 - 20);
    ctx.fillStyle = '#b8a8cc';
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillText((this.crashMsg || 'unexpected error').slice(0, 70), W / 2, H / 2 + 14);
    ctx.fillStyle = '#e0b34c';
    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.fillText('press ENTER to restart', W / 2, H / 2 + 54);
    ctx.textAlign = 'left';
  };

  function dimCenterPanel(ctx, title, color) {
    ctx.fillStyle = 'rgba(26,22,40,0.45)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.font = 'bold 56px ui-monospace, monospace';
    ctx.fillText(title, W / 2, H / 2 - 60);
    ctx.textAlign = 'left';
  }

  // Pointer / touch on the end card buttons.
  Game.prototype.handlePoint = function (px, py) {
    if (this.screen !== 'endcard' || !this._endButtons) return;
    for (var i = 0; i < this._endButtons.length; i++) {
      var b = this._endButtons[i];
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
        if (b.id === 'copy') this.copyResult();
        else if (b.id === 'save') this.saveCard();
        return;
      }
    }
  };

  // ── Boot ────────────────────────────────────────────────────────────
  function boot() {
    var doc = root.document;
    var canvas = doc.getElementById('game');
    if (!canvas) return;
    canvas.width = W; canvas.height = H;
    var game = new Game(canvas);

    // Input wiring (normalized keys; clear on blur + visibility change).
    root.addEventListener('keydown', function (e) {
      var key = e.key;
      // Stop the page from scrolling on arrows / space.
      if (key === ' ' || (key && key.indexOf('Arrow') === 0)) {
        if (e.preventDefault) e.preventDefault();
      }
      game.onKeyDown(key, e.repeat);
    });
    root.addEventListener('keyup', function (e) { game.onKeyUp(e.key); });
    root.addEventListener('blur', function () { game.clearKeys(); });
    if (doc.addEventListener) {
      doc.addEventListener('visibilitychange', function () {
        if (doc.hidden) game.clearKeys();
      });
    }
    // Pointer for end-card buttons.
    canvas.addEventListener && canvas.addEventListener('click', function (e) {
      var r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: W, height: H };
      var sx = W / (r.width || W), sy = H / (r.height || H);
      game.handlePoint((e.clientX - r.left) * sx, (e.clientY - r.top) * sy);
    });

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

    // Test hook (mirrors bullseye's window.__BB).
    root.__SPLAT = {
      getScreen: function () { return game.screen; },
      getGame: function () { return game; },
      poop: function () { game.poop(); },
      seed: function (s) { game._seed = s; }
    };
  }

  // Boot on load if we have a DOM; vm harness fires 'load' itself.
  if (root.addEventListener) {
    root.addEventListener('load', boot);
  }

  // Export for any UMD consumer / direct test require (logic-free shell,
  // but expose the painters + Game for completeness).
  if (typeof module === 'object' && module.exports) {
    module.exports = { Game: Game, verbTransform: verbTransform, normKey: normKey, boot: boot };
  }
})(typeof self !== 'undefined' ? self : this);
