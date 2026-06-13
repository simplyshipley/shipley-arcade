'use strict';
/*
 * Headless smoke test for the canvas shell (game.js) — no browser, no deps.
 * Stubs window/document/canvas-2d, loads the real game files in a vm
 * sandbox, then plays a full run: title → controls → flight (with payload
 * drops + Bird Vision) → rescue → summary → title. Any runtime exception
 * in update/draw fails the test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeSandbox() {
  const listeners = {};
  let rafCb = null;

  // Canvas 2D context stub: every method is a no-op, every property sticks.
  const ctx = new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === 'createLinearGradient') {
          return () => ({ addColorStop() {} });
        }
        if (!(prop in target)) target[prop] = () => {};
        return target[prop];
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    }
  );

  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const window = {
    addEventListener(ev, fn) {
      (listeners[ev] = listeners[ev] || []).push(fn);
    },
  };
  const sandbox = {
    window,
    self: window,
    document: { getElementById: () => canvas },
    requestAnimationFrame(cb) {
      rafCb = cb;
    },
    Math,
    console,
  };
  vm.createContext(sandbox);

  const dir = __dirname;
  vm.runInContext(fs.readFileSync(path.join(dir, 'game-core.js'), 'utf8'), sandbox, { filename: 'game-core.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'game.js'), 'utf8'), sandbox, { filename: 'game.js' });

  let now = 0;
  const harness = {
    bb: () => window.__BB,
    fire(ev, payload) {
      (listeners[ev] || []).forEach((fn) => fn(payload));
    },
    key(k) {
      harness.fire('keydown', { key: k, repeat: false, preventDefault() {} });
    },
    keyUp(k) {
      harness.fire('keyup', { key: k });
    },
    // Pump requestAnimationFrame at ~30fps simulated time.
    sim(seconds) {
      const step = 1000 / 30;
      const frames = Math.ceil((seconds * 1000) / step);
      for (let i = 0; i < frames; i++) {
        now += step;
        const cb = rafCb;
        rafCb = null;
        assert.ok(cb, 'game loop stopped re-registering requestAnimationFrame');
        cb(now);
      }
    },
  };

  harness.fire('load');
  harness.sim(0.1);
  return harness;
}

test('full playthrough: title → controls → flight → rescue → summary → title, no exceptions', () => {
  const h = makeSandbox();
  const bb = h.bb();
  assert.ok(bb, 'window.__BB test hook missing');
  assert.equal(bb.getScreen(), 'title');

  h.key('Enter');
  assert.equal(bb.getScreen(), 'controls');

  h.key('Enter');
  assert.equal(bb.getScreen(), 'flight');
  const game = bb.getGame();
  assert.ok(game.flight, 'flight state not initialized');

  // Fly around, drop a payload, toggle Bird Vision.
  h.key('ArrowLeft');
  h.sim(0.5);
  h.keyUp('ArrowLeft');
  h.key(' ');
  assert.equal(game.flight.payloads.length, 1, 'payload not spawned on SPACE');
  h.sim(0.6); // payload falls for 0.45s, then splats
  assert.ok(game.flight.decals.length >= 1, 'payload did not leave a splat decal');
  h.key('v');
  assert.equal(game.vision.active, true, 'Bird Vision did not activate');
  h.sim(2);
  assert.ok(game.vision.value < 100, 'vision meter did not drain');

  // Run out the 60s flight clock.
  h.sim(60);
  assert.equal(bb.getScreen(), 'rescue');
  assert.ok(bb.getGame().rescue, 'rescue state not initialized');

  // Move around during rescue, then run out the 45s clock.
  h.key('ArrowRight');
  h.sim(1);
  h.keyUp('ArrowRight');
  h.sim(46);
  assert.equal(bb.getScreen(), 'summary');
  assert.ok(bb.getGame().score.score >= 0);

  h.key('Enter');
  assert.equal(bb.getScreen(), 'title');
});

test('payload drop scores against a planted target (deterministic)', () => {
  const h = makeSandbox();
  const bb = h.bb();
  h.key('Enter');
  h.key('Enter');
  const game = bb.getGame();

  // Plant a guaranteed target directly under the bird, clear randoms.
  const f = game.flight;
  f.targets.length = 0;
  f.targets.push({ x: f.bird.x, y: f.bird.y, r: 30, emoji: '🧍', golden: false, splatted: false });
  f.spawnIn = 999; // hold off random spawns

  h.key(' ');
  h.sim(0.6); // payload dur is 0.45s
  assert.ok(game.score.score > 0, 'dead-center drop scored nothing');
  assert.equal(game.score.combo, 1);
});
