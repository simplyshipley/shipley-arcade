/*
 * Canvas/browser engine toolkit: input, camera + trauma shake, particles
 * (with named presets), parallax, drawing helpers (incl. the shared
 * gouache ornithopter painter), WebAudio bleeps. No game rules live here.
 * Browser-only (loaded after core.js); stages receive these via `world`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.Engine = factory(root.Core);
  }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  // ── Input: normalized keys in a Set, edge detection, blur AND
  //    visibilitychange clearing, auto-pause hook (game-1 lesson) ──────
  function Input(target, doc) {
    this._keys = new Set();      // held keys (normalized)
    this._pressed = new Set();   // keys that went down this frame
    this.onAutoPause = null;     // assigned by the shell; fired on blur/hidden
    this._target = target;
    var self = this;
    this._onKeyDown = function (e) {
      var k = Core.normalizeKey(e.key);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].indexOf(k) >= 0) {
        e.preventDefault();
      }
      if (!e.repeat) {
        if (!self._keys.has(k)) self._pressed.add(k);
        self._keys.add(k);
      }
    };
    this._onKeyUp = function (e) {
      self._keys.delete(Core.normalizeKey(e.key));
    };
    this._loseFocus = function () {
      self._keys.clear();
      self._pressed.clear();
      if (self.onAutoPause) self.onAutoPause();
    };
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._loseFocus);
    // visibilitychange lives on document; injectable for headless tests.
    this._doc = doc || (typeof document !== 'undefined' ? document : null);
    if (this._doc && this._doc.addEventListener) {
      this._onVis = function () {
        if (self._doc.hidden) self._loseFocus();
      };
      this._doc.addEventListener('visibilitychange', this._onVis);
    }
  }
  Input.prototype.axis = function () {
    // Returns {x, y} in -1..1 from arrows + wasd.
    var x = 0, y = 0;
    if (this._keys.has('ArrowLeft') || this._keys.has('a')) x -= 1;
    if (this._keys.has('ArrowRight') || this._keys.has('d')) x += 1;
    if (this._keys.has('ArrowUp') || this._keys.has('w')) y -= 1;
    if (this._keys.has('ArrowDown') || this._keys.has('s')) y += 1;
    return { x: x, y: y };
  };
  Input.prototype.held = function (k) { return this._keys.has(k); };
  Input.prototype.justPressed = function (k) { return this._pressed.has(k); };
  Input.prototype.endFrame = function () { this._pressed.clear(); };

  // ── Camera: trauma screenshake (decay 1.8/s, cap 8 px) ─────────────
  var SHAKE_CAP = 8;       // px — spec sharedSystems
  var TRAUMA_DECAY = 1.8;  // per second
  function Camera() {
    this.x = 0;
    this.y = 0;
    this.trauma = 0;       // 0..1; effective shake = min(8, trauma² · 8)
  }
  Camera.prototype.addTrauma = function (amount) {
    this.trauma = Math.min(1, this.trauma + (amount || 0));
  };
  // Thin adapter for legacy callers: px magnitude → equivalent trauma.
  Camera.prototype.shake = function (mag, dur) {
    var m = Math.min(SHAKE_CAP, mag == null ? 4 : mag);
    this.addTrauma(Math.sqrt(m / SHAKE_CAP));
  };
  Camera.prototype.shakeAmount = function () {
    return Math.min(SHAKE_CAP, this.trauma * this.trauma * SHAKE_CAP);
  };
  Camera.prototype.update = function (dt) {
    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
  };
  Camera.prototype.apply = function (ctx) {
    var s = this.shakeAmount();
    var sx = 0, sy = 0;
    if (s > 0) {
      sx = (Math.random() - 0.5) * 2 * s;
      sy = (Math.random() - 0.5) * 2 * s;
    }
    ctx.translate(Math.round(-this.x + sx), Math.round(-this.y + sy));
  };

  // ── Particles: one pooled system for sparks, smoke, debris, trails ──
  function Particles(max) {
    this.pool = [];
    this.max = max || 600;
  }
  // opts: x, y, count, speed, spread(rad), angle, life, size, color,
  //       gravity, drag, glow (additive), fade
  Particles.prototype.burst = function (opts) {
    var count = opts.count || 10;
    for (var i = 0; i < count; i++) {
      if (this.pool.length >= this.max) this.pool.shift();
      var ang = (opts.angle || 0) + (Math.random() - 0.5) * (opts.spread == null ? Math.PI * 2 : opts.spread);
      var sp = (opts.speed || 80) * (0.4 + Math.random() * 0.6);
      this.pool.push({
        x: opts.x, y: opts.y,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        life: (opts.life || 0.6) * (0.5 + Math.random() * 0.5),
        maxLife: opts.life || 0.6,
        size: (opts.size || 3) * (0.5 + Math.random()),
        color: opts.color || '#ffd35a',
        gravity: opts.gravity || 0,
        drag: opts.drag == null ? 0.98 : opts.drag,
        glow: !!opts.glow,
      });
    }
  };
  // Named emitter presets (spec sharedSystems weather/juice list). Each is
  // a tuned burst config; opts overrides any field.
  var PRESETS = {
    rain:     { count: 3, speed: 460, angle: Math.PI * 0.58, spread: 0.06, life: 0.55, size: 1.5, color: '#9fb4c8', gravity: 240, drag: 1 },
    spray:    { count: 8, speed: 170, angle: -Math.PI / 2, spread: 1.1, life: 0.5, size: 2.4, color: '#e8f4f4', gravity: 520, drag: 0.99 },
    dust:     { count: 6, speed: 75, angle: -Math.PI / 2, spread: 2.2, life: 0.7, size: 3, color: '#b8a47e', gravity: -25, drag: 0.96 },
    embers:   { count: 10, speed: 95, angle: -Math.PI / 2, spread: 1.3, life: 0.9, size: 2, color: '#ff7a3c', gravity: -60, drag: 0.985, glow: true },
    feathers: { count: 12, speed: 130, spread: Math.PI * 2, life: 1.1, size: 3, color: '#c9b8e8', gravity: 150, drag: 0.97 },
    steam:    { count: 9, speed: 65, angle: -Math.PI / 2, spread: 0.9, life: 0.8, size: 4, color: '#dfe9ec', gravity: -90, drag: 0.97 },
    godRays:  { count: 3, speed: 30, angle: Math.PI * 0.72, spread: 0.12, life: 1.7, size: 6, color: '#ffe9b0', gravity: 0, drag: 1, glow: true },
    confetti: { count: 18, speed: 230, angle: -Math.PI / 2, spread: 1.6, life: 1.2, size: 3, color: '#ffd35a', gravity: 330, drag: 0.985, glow: true },
  };
  Particles.prototype.preset = function (name, x, y, opts) {
    var base = PRESETS[name];
    if (!base) return;
    var merged = { x: x, y: y };
    var k;
    for (k in base) {
      if (base.hasOwnProperty(k)) merged[k] = base[k];
    }
    if (opts) {
      for (k in opts) {
        if (opts.hasOwnProperty(k)) merged[k] = opts[k];
      }
    }
    this.burst(merged);
  };

  Particles.prototype.update = function (dt) {
    for (var i = this.pool.length - 1; i >= 0; i--) {
      var p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) { this.pool.splice(i, 1); continue; }
      p.vy += p.gravity * dt;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  };
  Particles.prototype.draw = function (ctx) {
    for (var i = 0; i < this.pool.length; i++) {
      var p = this.pool[i];
      var a = Math.max(0, p.life / p.maxLife);
      ctx.save();
      if (p.glow) ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.5 + a * 0.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };

  // ── Parallax: depth-sorted layers, each a draw callback ────────────
  // Layer: {factor: 0..1 (0=static sky, 1=foreground), draw(ctx, offX, offY)}
  function Parallax() {
    this.layers = [];
  }
  Parallax.prototype.add = function (factor, draw) {
    this.layers.push({ factor: factor, draw: draw });
    this.layers.sort(function (a, b) { return a.factor - b.factor; });
    return this;
  };
  Parallax.prototype.draw = function (ctx, camX, camY) {
    for (var i = 0; i < this.layers.length; i++) {
      var l = this.layers[i];
      l.draw(ctx, camX * l.factor, camY * l.factor);
    }
  };

  // ── Drawing helpers ─────────────────────────────────────────────────
  var gfx = {
    // Vertical gradient fill over a rect.
    skyGradient: function (ctx, x, y, w, h, stops) {
      var g = ctx.createLinearGradient(0, y, 0, y + h);
      for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
    },
    glowCircle: function (ctx, x, y, r, color, intensity) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = intensity == null ? 0.8 : intensity;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
    // Filled polygon from flat [x0,y0, x1,y1, ...] points.
    poly: function (ctx, pts, color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (var i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath();
      ctx.fill();
    },
    roundRect: function (ctx, x, y, w, h, r, color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
      ctx.fill();
    },
    vignette: function (ctx, w, h, strength) {
      var g = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,' + (strength == null ? 0.45 : strength) + ')');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
    text: function (ctx, str, x, y, opts) {
      opts = opts || {};
      ctx.save();
      ctx.font = opts.font || 'bold 18px monospace';
      ctx.textAlign = opts.align || 'center';
      ctx.textBaseline = opts.baseline || 'middle';
      if (opts.glow) {
        ctx.shadowColor = opts.glow;
        ctx.shadowBlur = opts.glowBlur || 12;
      }
      ctx.fillStyle = opts.color || '#fff';
      ctx.fillText(str, x, y);
      ctx.restore();
    },
    // Pre-render to an offscreen canvas (shadowBlur/glow pre-bake — spec:
    // never run shadowBlur on bulk geometry).
    offscreen: function (w, h, drawFn) {
      var c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      drawFn(c.getContext('2d'), w, h);
      return c;
    },
    // 80ms white hit-flash overlay (caller owns the timer; alpha 0..1).
    hitFlash: function (ctx, W, H, alpha) {
      if (!alpha || alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    },
    // The shared gouache ornithopter painter — the style anchor. Stacked
    // rounded paths, 2px outline #141821, one rim-light stroke, teal wing
    // membranes as quadratic curves animated by flap phase. Ribbon-trail
    // hook: pass body.trail = [{x,y},...] (+ body.ribbon.color override).
    // Flap phase comes from body.flapT (s since last flap) when present,
    // else an idle flutter driven by t.
    craft: function (ctx, body, t, palette) {
      palette = palette || {};
      var brass = palette.brass || '#d9b36a';
      var teal = palette.teal || '#2aa7a0';
      var outline = palette.outline || '#141821';
      var rim = palette.rim || 'rgba(255,236,200,0.85)';
      var f = body.facing >= 0 ? 1 : -1;
      var i;

      var trail = body.trail;
      if (trail && trail.length > 1) {
        ctx.save();
        ctx.strokeStyle = (body.ribbon && body.ribbon.color) || palette.ribbon || teal;
        ctx.lineCap = 'round';
        for (i = 1; i < trail.length; i++) {
          var ta = i / trail.length;
          ctx.globalAlpha = ta * 0.45;
          ctx.lineWidth = 1 + ta * 3;
          ctx.beginPath();
          ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
          ctx.lineTo(trail[i].x, trail[i].y);
          ctx.stroke();
        }
        ctx.restore();
      }

      var phase = body.flapT != null
        ? Math.max(0, 1 - body.flapT * 2.5)
        : 0.5 + 0.5 * Math.sin((t || 0) * 7);
      var wingY = -7 - phase * 13;   // wing control points rise on flap

      ctx.save();
      ctx.translate(body.x, body.y);
      ctx.scale(f, 1);
      ctx.lineWidth = 2;
      ctx.strokeStyle = outline;
      ctx.lineJoin = 'round';

      // Far wing (behind fuselage), dimmed teal
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = teal;
      ctx.beginPath();
      ctx.moveTo(-1, -1);
      ctx.quadraticCurveTo(-13, wingY - 1, -25, wingY + 5);
      ctx.quadraticCurveTo(-12, 3, -1, 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Brass fuselage (rounded teardrop)
      ctx.beginPath();
      ctx.moveTo(15, 0);
      ctx.quadraticCurveTo(14, -7, 3, -7);
      ctx.quadraticCurveTo(-12, -7, -15, -1);
      ctx.quadraticCurveTo(-13, 6, -1, 6);
      ctx.quadraticCurveTo(12, 6, 15, 0);
      ctx.closePath();
      ctx.fillStyle = brass;
      ctx.fill();
      ctx.stroke();

      // Tail fin
      ctx.beginPath();
      ctx.moveTo(-12, -2);
      ctx.quadraticCurveTo(-19, -10, -22, -7);
      ctx.quadraticCurveTo(-20, -3, -13, 1);
      ctx.closePath();
      ctx.fillStyle = brass;
      ctx.fill();
      ctx.stroke();

      // Near wing (over fuselage)
      ctx.beginPath();
      ctx.moveTo(3, -3);
      ctx.quadraticCurveTo(-7, wingY - 5, -21, wingY + 1);
      ctx.quadraticCurveTo(-8, 0, 3, 2);
      ctx.closePath();
      ctx.fillStyle = teal;
      ctx.fill();
      ctx.stroke();

      // Rim-light stroke on the storm-lit top edge
      ctx.beginPath();
      ctx.moveTo(11, -5);
      ctx.quadraticCurveTo(3, -8.5, -8, -6.5);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rim;
      ctx.stroke();

      // Canopy
      ctx.beginPath();
      ctx.arc(6, -3, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = '#1a2238';
      ctx.fill();

      ctx.restore();
    },
  };

  // ── Audio: tiny WebAudio synth, lazily initialized on first input ──
  function Audio() {
    this.ctx = null;
    this.muted = false;
  }
  Audio.prototype._ensure = function () {
    if (!this.ctx && typeof AudioContext !== 'undefined') {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  };
  Audio.prototype.beep = function (freq, dur, type, vol) {
    if (this.muted) return;
    var ac = this._ensure();
    if (!ac) return;
    var osc = ac.createOscillator();
    var gain = ac.createGain();
    osc.type = type || 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol == null ? 0.08 : vol, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + (dur || 0.12));
    osc.connect(gain).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + (dur || 0.12) + 0.02);
  };
  Audio.prototype.noise = function (dur, vol) {
    if (this.muted) return;
    var ac = this._ensure();
    if (!ac) return;
    var len = Math.floor(ac.sampleRate * (dur || 0.2));
    var buf = ac.createBuffer(1, len, ac.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ac.createBufferSource();
    var gain = ac.createGain();
    gain.gain.value = vol == null ? 0.1 : vol;
    src.buffer = buf;
    src.connect(gain).connect(ac.destination);
    src.start();
  };

  // ── Floating combat text ────────────────────────────────────────────
  function Floaters() {
    this.list = [];
  }
  Floaters.prototype.add = function (x, y, text, color) {
    this.list.push({ x: x, y: y, text: text, color: color || '#fff', t: 1.1 });
  };
  Floaters.prototype.update = function (dt) {
    for (var i = this.list.length - 1; i >= 0; i--) {
      var f = this.list[i];
      f.t -= dt;
      f.y -= 40 * dt;
      if (f.t <= 0) this.list.splice(i, 1);
    }
  };
  Floaters.prototype.draw = function (ctx) {
    for (var i = 0; i < this.list.length; i++) {
      var f = this.list[i];
      gfx.text(ctx, f.text, f.x, f.y, {
        color: f.color,
        font: 'bold 17px monospace',
        glow: f.color,
        glowBlur: 8,
      });
    }
    ctx.globalAlpha = 1;
  };

  return {
    Input: Input,
    Camera: Camera,
    Particles: Particles,
    Parallax: Parallax,
    Floaters: Floaters,
    Audio: Audio,
    gfx: gfx,
  };
});
