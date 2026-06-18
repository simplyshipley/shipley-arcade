/*
 * sfx.js — tiny zero-dependency WebAudio sound kit for the arcade games.
 *
 * No audio files: every sound is synthesized (oscillators + noise). Drop in
 * with a <script> tag and call SFX.<name>() on game events. The AudioContext
 * is created lazily and resumed on the first user gesture (browsers require
 * a gesture before audio can play), so just wire it to keydown/touch once.
 *
 *   <script src="src/sfx.js"></script>
 *   SFX.arm(window);          // resume on first key/touch (call once at load)
 *   SFX.jump(); SFX.coin(); SFX.thud(); ...
 *
 * SFX.muted = true to silence. All calls are no-ops until armed + a gesture.
 */
(function (root) {
  'use strict';

  var ctx = null;
  var SFX = { muted: false };

  function ac() {
    if (ctx) return ctx;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  }

  // A single oscillator note with an exponential decay envelope.
  function tone(freq, dur, type, vol, when) {
    if (SFX.muted) return;
    var a = ac();
    if (!a) return;
    var t0 = a.currentTime + (when || 0);
    var osc = a.createOscillator();
    var g = a.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(Math.max(0.0001, vol == null ? 0.12 : vol), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // A pitch slide (great for jumps, whooshes, tosses).
  function sweep(f1, f2, dur, type, vol) {
    if (SFX.muted) return;
    var a = ac();
    if (!a) return;
    var t0 = a.currentTime;
    var osc = a.createOscillator();
    var g = a.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(f1, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t0 + dur);
    g.gain.setValueAtTime(vol == null ? 0.12 : vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // Filtered white noise — splats, crashes, dust.
  function noise(dur, vol, hp) {
    if (SFX.muted) return;
    var a = ac();
    if (!a) return;
    var n = Math.floor(a.sampleRate * dur);
    var buf = a.createBuffer(1, n, a.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var src = a.createBufferSource();
    src.buffer = buf;
    var g = a.createGain();
    g.gain.value = vol == null ? 0.16 : vol;
    var node = src;
    if (hp) {
      var f = a.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = hp;
      src.connect(f);
      node = f;
    }
    node.connect(g).connect(a.destination);
    src.start();
  }

  // ── Named game sounds (compose the primitives) ──────────────────────
  SFX.jump   = function () { sweep(280, 620, 0.18, 'square', 0.10); };
  SFX.coin   = function () { tone(880, 0.07, 'square', 0.10); tone(1320, 0.12, 'square', 0.10, 0.06); }; // bud/pickup
  SFX.chime  = function () { tone(660, 0.08, 'triangle', 0.12); tone(990, 0.14, 'triangle', 0.10, 0.07); }; // water/streak
  SFX.thud   = function () { noise(0.18, 0.20); tone(120, 0.16, 'sine', 0.18); }; // crash
  SFX.toss   = function () { sweep(520, 240, 0.16, 'triangle', 0.10); };
  SFX.deliver = function () { tone(740, 0.07, 'square', 0.11); tone(1110, 0.13, 'square', 0.10, 0.06); };
  SFX.bullseye = function () { tone(880, 0.06, 'square', 0.11); tone(1175, 0.06, 'square', 0.11, 0.05); tone(1568, 0.16, 'square', 0.11, 0.10); };
  SFX.splat  = function () { noise(0.14, 0.18, 600); tone(180, 0.1, 'sine', 0.12); };
  SFX.thunk  = function () { tone(150, 0.07, 'square', 0.14); noise(0.06, 0.10); }; // card dispense
  SFX.riff   = function () { sweep(200, 320, 0.5, 'sine', 0.07); };               // earl wakes
  SFX.golden = function () { [0, 0.08, 0.16, 0.26].forEach(function (d, i) { tone([660, 880, 1175, 1568][i], 0.14, 'triangle', 0.11, d); }); };
  SFX.uiTick = function () { tone(440, 0.04, 'square', 0.07); };
  SFX.fanfare = function () { [523, 659, 784, 1046].forEach(function (f, i) { tone(f, 0.18, 'square', 0.10, i * 0.10); }); };
  SFX.tone = tone; SFX.sweep = sweep; SFX.noise = noise;

  // Resume the AudioContext on the first user gesture (required by browsers).
  SFX.arm = function (target) {
    var t = target || root;
    function go() {
      var a = ac();
      if (a && a.state === 'suspended' && a.resume) a.resume();
      t.removeEventListener && t.removeEventListener('keydown', go);
      t.removeEventListener && t.removeEventListener('pointerdown', go);
      t.removeEventListener && t.removeEventListener('touchstart', go);
    }
    if (t.addEventListener) {
      t.addEventListener('keydown', go);
      t.addEventListener('pointerdown', go);
      t.addEventListener('touchstart', go);
    }
  };

  root.SFX = SFX;
})(typeof self !== 'undefined' ? self : this);
