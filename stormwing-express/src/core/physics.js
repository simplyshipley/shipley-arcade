/*
 * Pure flight physics — the one courier body, identical in every stage.
 * No DOM, no canvas. Constants are spec-pinned (design-spec playerIdentity
 * + sharedSystems): the skill learned in minute one must transfer verbatim.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Physics = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PHYS = {
    gravity: 900,        // px/s², always on
    flapImpulse: -260,   // px/s added to vy per flap
    vyMin: -420,         // vy clamp band
    vyMax: 520,
    hAccel: 600,         // px/s² horizontal accel
    vxMax: 280,          // max |vx|
    hDrag: 4.0,          // exponential decay rate when no steer input
  };

  function clampVy(vy) {
    return vy < PHYS.vyMin ? PHYS.vyMin : vy > PHYS.vyMax ? PHYS.vyMax : vy;
  }

  function makeBody(x, y) {
    return { x: x, y: y, vx: 0, vy: 0, facing: 1 };
  }

  function flap(body) {
    body.vy = clampVy(body.vy + PHYS.flapImpulse);
    body.flapT = 0;   // restart the wing-flap animation (gfx.craft reads flapT)
    return body;
  }

  function steer(body, axisX, dt) {
    if (axisX !== 0) {
      body.vx += axisX * PHYS.hAccel * dt;
      if (body.vx > PHYS.vxMax) body.vx = PHYS.vxMax;
      if (body.vx < -PHYS.vxMax) body.vx = -PHYS.vxMax;
      body.facing = axisX > 0 ? 1 : -1;
    } else {
      body.vx *= Math.exp(-PHYS.hDrag * dt);
    }
    return body;
  }

  function integrate(body, dt, opts) {
    opts = opts || {};
    var windX = opts.windX || 0;
    var gravityScale = opts.gravityScale == null ? 1 : opts.gravityScale;
    body.vy = clampVy(body.vy + PHYS.gravity * gravityScale * dt);
    body.x += (body.vx + windX) * dt;
    body.y += body.vy * dt;
    body.flapT = (body.flapT || 0) + dt;   // time since last flap → wing decay
    return body;
  }

  return {
    PHYS: PHYS,
    makeBody: makeBody,
    flap: flap,
    steer: steer,
    integrate: integrate,
  };
});
