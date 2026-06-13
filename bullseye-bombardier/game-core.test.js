'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const GC = require('./game-core.js');

// ── Bird progression ──────────────────────────────────────────────────
test('birdForScore: starts as Sparrow', () => {
  assert.equal(GC.birdForScore(0).name, 'Sparrow');
  assert.equal(GC.birdForScore(599).name, 'Sparrow');
});

test('birdForScore: upgrades at each threshold', () => {
  assert.equal(GC.birdForScore(600).name, 'Pigeon');
  assert.equal(GC.birdForScore(1500).name, 'Seagull');
  assert.equal(GC.birdForScore(3000).name, 'Hawk');
  assert.equal(GC.birdForScore(6000).name, 'Pterodactyl');
  assert.equal(GC.birdForScore(999999).name, 'Pterodactyl');
});

test('birds grow: splat radius strictly increases up the tiers', () => {
  for (let i = 1; i < GC.BIRDS.length; i++) {
    assert.ok(GC.BIRDS[i].splatRadius > GC.BIRDS[i - 1].splatRadius);
  }
});

// ── Drop scoring ──────────────────────────────────────────────────────
test('scoreForDrop: dead center = 100', () => {
  assert.equal(GC.scoreForDrop(0, 30, 18, false), 100);
});

test('scoreForDrop: ring boundaries (r=30)', () => {
  assert.equal(GC.scoreForDrop(10, 30, 18, false), 100); // inner third
  assert.equal(GC.scoreForDrop(11, 30, 18, false), 50);  // middle third
  assert.equal(GC.scoreForDrop(20, 30, 18, false), 50);
  assert.equal(GC.scoreForDrop(21, 30, 18, false), 25);  // outer
});

test('scoreForDrop: exact reach edge hits, beyond misses', () => {
  assert.equal(GC.scoreForDrop(48, 30, 18, false), 25);
  assert.equal(GC.scoreForDrop(48.5, 30, 18, false), 0);
});

test('scoreForDrop: pterodactyl splat reaches what a sparrow misses', () => {
  const sparrow = GC.BIRDS[0].splatRadius;     // 18
  const ptero = GC.BIRDS[4].splatRadius;       // 64
  const d = 60, r = 26;
  assert.equal(GC.scoreForDrop(d, r, sparrow, false), 0);
  assert.equal(GC.scoreForDrop(d, r, ptero, false), 25);
});

test('scoreForDrop: golden pays triple', () => {
  assert.equal(GC.scoreForDrop(0, 30, 18, true), 300);
  assert.equal(GC.scoreForDrop(25, 30, 18, true), 75);
});

// ── Combos ────────────────────────────────────────────────────────────
test('comboMultiplier: x1 first hit, +0.25 per consecutive, capped x3', () => {
  assert.equal(GC.comboMultiplier(1), 1);
  assert.equal(GC.comboMultiplier(2), 1.25);
  assert.equal(GC.comboMultiplier(5), 2);
  assert.equal(GC.comboMultiplier(9), 3);
  assert.equal(GC.comboMultiplier(50), 3);
});

test('ScoreKeeper: consecutive hits multiply, miss resets combo', () => {
  const sk = new GC.ScoreKeeper();
  assert.equal(sk.registerDrop(100), 100);  // x1
  assert.equal(sk.registerDrop(100), 125);  // x1.25
  assert.equal(sk.registerDrop(100), 150);  // x1.5
  assert.equal(sk.score, 375);
  assert.equal(sk.combo, 3);
  sk.registerDrop(0); // miss
  assert.equal(sk.combo, 0);
  assert.equal(sk.registerDrop(100), 100); // back to x1
  assert.equal(sk.bestCombo, 3);
});

test('ScoreKeeper: addBonus never subtracts', () => {
  const sk = new GC.ScoreKeeper();
  sk.addBonus(500);
  sk.addBonus(-9999);
  assert.equal(sk.score, 500);
});

// ── Bird Vision meter ─────────────────────────────────────────────────
test('VisionMeter: drains while active, auto-deactivates at empty', () => {
  const v = new GC.VisionMeter();
  assert.equal(v.activate(), true);
  v.update(1); // -40
  assert.equal(v.value, 60);
  assert.equal(v.active, true);
  v.update(2); // -80 → clamps to 0, deactivates
  assert.equal(v.value, 0);
  assert.equal(v.active, false);
});

test('VisionMeter: recharges while inactive, cannot activate below minimum', () => {
  const v = new GC.VisionMeter();
  v.value = 0;
  assert.equal(v.activate(), false);
  v.update(1); // +14
  assert.equal(v.value, 14);
  assert.equal(v.activate(), false); // still below 25
  v.update(1); // 28
  assert.equal(v.activate(), true);
});

test('VisionMeter: recharge clamps at max, timeScale slows when active', () => {
  const v = new GC.VisionMeter();
  v.update(100);
  assert.equal(v.value, 100);
  assert.equal(v.timeScale(), 1);
  v.activate();
  assert.equal(v.timeScale(), 0.35);
});

// ── Rescue interlude ──────────────────────────────────────────────────
test('RescueState: pickup → deliver loop, complete at goal', () => {
  const r = new GC.RescueState(3);
  assert.equal(r.pickup(), true);
  assert.equal(r.pickup(), false);      // hands full
  assert.equal(r.deliver(), false);     // 1/3
  assert.equal(r.deliver(), false);     // not carrying — no-op
  assert.equal(r.rescued, 1);
  r.pickup(); r.deliver();              // 2/3
  r.pickup();
  assert.equal(r.deliver(), true);      // 3/3 complete
  assert.equal(r.complete(), true);
});

test('RescueState: hazard hit drops carried chick', () => {
  const r = new GC.RescueState(3);
  assert.equal(r.hitHazard(), 'hit');
  r.pickup();
  assert.equal(r.hitHazard(), 'dropped');
  assert.equal(r.carrying, false);
  assert.equal(r.hits, 2);
});

test('rescueBonus: 500 per chick minus 100 per hit, floored at 0', () => {
  assert.equal(GC.rescueBonus(3, 0), 1500);
  assert.equal(GC.rescueBonus(3, 2), 1300);
  assert.equal(GC.rescueBonus(0, 5), 0);
  assert.equal(GC.rescueBonus(1, 9), 0);
});

// ── Ranks ─────────────────────────────────────────────────────────────
test('rankForScore: boundaries', () => {
  assert.equal(GC.rankForScore(0).name, 'Fledgling');
  assert.equal(GC.rankForScore(999).name, 'Fledgling');
  assert.equal(GC.rankForScore(1000).name, 'Branch Hopper');
  assert.equal(GC.rankForScore(2500).name, 'Sky Scrapper');
  assert.equal(GC.rankForScore(5000).name, 'Raptor Elite');
  assert.equal(GC.rankForScore(8000).name, 'Apex Pterodactyl');
});

// ── Geometry ──────────────────────────────────────────────────────────
test('circlesOverlap: touching counts, separated does not', () => {
  assert.equal(GC.circlesOverlap(0, 0, 10, 20, 0, 10), true);
  assert.equal(GC.circlesOverlap(0, 0, 10, 21, 0, 10), false);
  assert.equal(GC.dist(0, 0, 3, 4), 5);
});
