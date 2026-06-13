/*
 * Shared collision rules. Owns the ALTITUDE DUEL (Joust) so the same rule
 * threads every stage and the boss. Pure logic — callers apply effects.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core.js'));
  } else {
    root.Collision = factory(root.Core);
  }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  var DUEL_BAND = 10; // px

  // Compares CENTER y. Exactly -10 → kill; exactly +10 → hurt.
  function altitudeDuel(playerBody, enemy) {
    var dy = playerBody.y - enemy.y;
    if (dy <= -DUEL_BAND) return 'kill';
    if (dy < DUEL_BAND) return 'bounce';
    return 'hurt';
  }

  // Elastic, equal-mass: swap vy with the enemy (if it has one) and push
  // the player out to the duel-band edge. Mutates player (and enemy.vy).
  function bounce(playerBody, enemy) {
    var dy = playerBody.y - enemy.y;
    var dir = dy > 0 ? 1 : -1; // dy === 0 → treat player as above
    var pvy = playerBody.vy;
    if (typeof enemy.vy === 'number') {
      playerBody.vy = enemy.vy;
      enemy.vy = pvy;
    } else {
      playerBody.vy = 0;
    }
    var overlap = DUEL_BAND - Math.abs(dy);
    if (overlap > 0) playerBody.y += dir * overlap;
    return playerBody;
  }

  function circleHit(x1, y1, r1, x2, y2, r2) {
    return Core.circlesOverlap(x1, y1, r1, x2, y2, r2);
  }

  // Delivery rings: both radii inclusive.
  function pointInRing(px, py, cx, cy, innerR, outerR) {
    var d = Core.dist(px, py, cx, cy);
    return d >= innerR && d <= outerR;
  }

  // Player hurtbox is 60% of sprite size, centered on the body.
  function hurtbox(body, w, h) {
    var hw = w * 0.6;
    var hh = h * 0.6;
    return { x: body.x - hw / 2, y: body.y - hh / 2, w: hw, h: hh };
  }

  return {
    DUEL_BAND: DUEL_BAND,
    altitudeDuel: altitudeDuel,
    bounce: bounce,
    circleHit: circleHit,
    pointInRing: pointInRing,
    hurtbox: hurtbox,
  };
});
