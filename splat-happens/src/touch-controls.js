/*
 * touch-controls.js — drop-in mobile control layer for keyboard canvas games.
 *
 * It does NOT touch game logic: on-screen buttons synthesize the same
 * keydown/keyup events the game already listens for on `window`. A held
 * d-pad button = a held arrow key; a tapped action button = one key press.
 * Multi-touch d-pad gives diagonals for free.
 *
 * Zero dependencies, works over file://. Activates only on touch-capable
 * devices (or when forced). Usage, after the canvas exists:
 *
 *   TouchControls.init({
 *     canvas: document.getElementById('game'),
 *     dpad: true,                                  // arrow-key d-pad
 *     buttons: [
 *       { label: 'FLAP', keys: [' '], color: '#2aa7a0' },
 *       { label: 'SLING', keys: ['x'], color: '#d9b36a' },
 *       { label: 'DROP', keys: ['ArrowDown', 'x'], color: '#8c5a9e' }, // combo
 *       { label: 'OK',  keys: ['Enter'], color: '#445' },
 *       { label: 'II',  keys: ['p'], color: '#445' },
 *     ],
 *     force: false,   // set true to show controls on desktop (testing)
 *   });
 */
(function (root) {
  'use strict';

  function isTouch() {
    return ('ontouchstart' in root) ||
      (root.navigator && root.navigator.maxTouchPoints > 0);
  }

  function press(key) {
    root.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }));
  }
  function release(key) {
    root.dispatchEvent(new KeyboardEvent('keyup', { key: key, bubbles: true, cancelable: true }));
  }

  var STYLE = [
    'html,body{touch-action:none;overscroll-behavior:none;}',
    '.tc-root{position:fixed;left:0;right:0;bottom:0;z-index:9999;',
    '  pointer-events:none;user-select:none;-webkit-user-select:none;',
    '  -webkit-tap-highlight-color:transparent;font-family:ui-monospace,Menlo,monospace;}',
    '.tc-side{position:absolute;bottom:max(16px,env(safe-area-inset-bottom));',
    '  display:flex;gap:14px;align-items:center;}',
    '.tc-left{left:max(16px,env(safe-area-inset-left));}',
    '.tc-right{right:max(16px,env(safe-area-inset-right));align-items:flex-end;}',
    '.tc-btn{pointer-events:auto;display:flex;align-items:center;justify-content:center;',
    '  color:#fff;font-weight:700;font-size:12px;letter-spacing:.04em;',
    '  -webkit-tap-highlight-color:transparent;transition:transform .05s,filter .05s;}',
    '.tc-btn.tc-on{transform:scale(.88);filter:brightness(1.5);}',
    // NES-style cross d-pad: one dark plus made of two bars, 4 invisible
    // touch zones over the arms. Reads instantly as a console d-pad.
    '.tc-dpad{position:relative;width:144px;height:144px;}',
    '.tc-dpad:before,.tc-dpad:after{content:"";position:absolute;background:#23262f;',
    '  border:2px solid #11131a;border-radius:10px;box-shadow:0 2px 6px rgba(0,0,0,.4);}',
    '.tc-dpad:before{left:48px;top:0;width:48px;height:144px;}',
    '.tc-dpad:after{left:0;top:48px;width:144px;height:48px;}',
    '.tc-dpad .tc-btn{position:absolute;width:48px;height:48px;font-size:16px;color:#c9ccd6;',
    '  text-shadow:0 1px 1px #000;}',
    '.tc-up{left:48px;top:0;} .tc-down{left:48px;top:96px;}',
    '.tc-leftk{left:0;top:48px;} .tc-rightk{left:96px;top:48px;}',
    // Round NES A/B-style action buttons (primary = larger).
    '.tc-act{width:68px;height:68px;border-radius:50%;border:3px solid rgba(0,0,0,.35);',
    '  background:rgba(20,24,40,.55);backdrop-filter:blur(2px);box-shadow:0 2px 8px rgba(0,0,0,.35);}',
    '.tc-act.tc-primary{width:84px;height:84px;font-size:14px;}',
    '.tc-act.tc-util{width:50px;height:50px;font-size:11px;opacity:.8;}',
  ].join('');

  function makeBtn(label, color, cls) {
    var b = document.createElement('div');
    b.className = 'tc-btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    if (color) b.style.borderColor = color;
    return b;
  }

  // Wire a button element to a list of keys: press all on touchstart, release
  // all on touchend/cancel. Active-pointer tracking keeps multi-touch honest.
  function bind(el, keys) {
    var active = 0;
    function down(e) {
      e.preventDefault();
      active++;
      el.classList.add('tc-on');
      for (var i = 0; i < keys.length; i++) press(keys[i]);
    }
    function up(e) {
      e.preventDefault();
      active = Math.max(0, active - 1);
      if (active === 0) {
        el.classList.remove('tc-on');
        // Release in reverse so a combo like [ArrowDown, x] lifts x first.
        for (var i = keys.length - 1; i >= 0; i--) release(keys[i]);
      }
    }
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
    // Mouse fallback (desktop testing with force:true).
    el.addEventListener('mousedown', down);
    root.addEventListener('mouseup', function () {
      if (active > 0) { active = 1; up({ preventDefault: function () {} }); }
    });
  }

  function init(opts) {
    opts = opts || {};
    if (!opts.force && !isTouch()) return null;
    if (document.querySelector('.tc-root')) return null; // idempotent

    var style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    // Prevent pinch-zoom / double-tap-zoom on the play surface.
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    document.addEventListener('dblclick', function (e) { e.preventDefault(); });

    var rootEl = document.createElement('div');
    rootEl.className = 'tc-root';

    if (opts.dpad) {
      var left = document.createElement('div');
      left.className = 'tc-side tc-left';
      var pad = document.createElement('div');
      pad.className = 'tc-dpad';
      var dirs = [
        ['▲', 'ArrowUp', 'tc-up'],
        ['▼', 'ArrowDown', 'tc-down'],
        ['◀', 'ArrowLeft', 'tc-leftk'],
        ['▶', 'ArrowRight', 'tc-rightk'],
      ];
      for (var i = 0; i < dirs.length; i++) {
        var d = makeBtn(dirs[i][0], null, dirs[i][2]);
        bind(d, [dirs[i][1]]);
        pad.appendChild(d);
      }
      left.appendChild(pad);
      rootEl.appendChild(left);
    }

    // Right side, NES-style: gameplay buttons are big round A/B buttons
    // (first = primary, biggest); utility buttons (pause/OK, marked
    // util:true) are small chips so the play actions stay obvious.
    var rightEl = document.createElement('div');
    rightEl.className = 'tc-side tc-right';
    var buttons = opts.buttons || [];
    var playIdx = 0;
    for (var j = 0; j < buttons.length; j++) {
      var spec = buttons[j];
      var cls = 'tc-act';
      if (spec.util) cls += ' tc-util';
      else if (playIdx++ === 0) cls += ' tc-primary';
      var btn = makeBtn(spec.label, spec.color, cls);
      if (spec.color) btn.style.background = spec.color;
      bind(btn, spec.keys);
      rightEl.appendChild(btn);
    }
    rootEl.appendChild(rightEl);

    document.body.appendChild(rootEl);
    return rootEl;
  }

  root.TouchControls = { init: init, isTouch: isTouch };
})(typeof self !== 'undefined' ? self : this);
