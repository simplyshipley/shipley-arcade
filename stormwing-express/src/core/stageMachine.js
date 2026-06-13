/*
 * Stage sequencer: banners, transition gating (isDone + projectile drain),
 * the 1s palette-crossfade veil, and the hull/tailwind hand-off between
 * legs. Pure logic; draw() only touches the ctx it is handed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StageMachine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BANNER_TIME = 2.5;  // s banner shown on stage entry
  var CROSSFADE = 1.0;    // s palette crossfade between stages
  var DRAIN_GRACE = 1.5;  // s isDone may wait on projectiles before fadeAll

  function Machine(stageList, world) {
    if (!(this instanceof Machine)) return new Machine(stageList, world);
    this.stages = stageList;
    this.world = world;
    this.index = -1;
    this.current = null;
    this.banner = null;
    this.bannerT = 0;
    this.fadeT = -1;   // >= 0 while crossfading
    this.drainT = 0;
    this._enter(0);
  }

  Machine.prototype._enter = function (index) {
    this.index = index;
    this.drainT = 0;
    if (index >= this.stages.length) {
      this.current = null;
      this.banner = null;
      return;
    }
    var stage = this.stages[index];
    this.current = stage;
    // Clear the HUD row set — stages only ADD keys, so without this the
    // previous stage's rows persist and push later stages' rows off-canvas.
    if (this.world.hud) {
      for (var k in this.world.hud) {
        if (Object.prototype.hasOwnProperty.call(this.world.hud, k)) delete this.world.hud[k];
      }
    }
    if (stage.slingConfig && this.world.projectiles) {
      this.world.projectiles.configure(stage.slingConfig);
    }
    stage.init(this.world);
    this.banner = stage.banner;
    this.bannerT = BANNER_TIME;
  };

  Machine.prototype.finished = function () {
    return this.index >= this.stages.length;
  };

  Machine.prototype.update = function (dt) {
    var world = this.world;
    if (this.finished() || world.paused) return; // stages never see paused updates

    if (this.fadeT >= 0) {
      // Mid-transition: stage logic is frozen behind the veil.
      this.fadeT += dt;
      if (this.fadeT >= CROSSFADE) {
        this.fadeT = -1;
        this._enter(this.index + 1);
        if (world.tailwind) world.tailwind.thaw(); // tier carries across
      }
      return;
    }

    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) this.banner = null;
    }

    this.current.update(dt, world);

    if (this.current.isDone(world)) {
      if (world.projectiles.drained()) {
        this._beginTransition();
      } else {
        this.drainT += dt;
        if (this.drainT >= DRAIN_GRACE) {
          // No transition deadlock: force-fade stragglers and proceed.
          world.projectiles.fadeAll(0.5);
          this._beginTransition();
        }
      }
    } else {
      this.drainT = 0;
    }
  };

  Machine.prototype._beginTransition = function () {
    var world = this.world;
    if (world.hull && world.hull.heal) world.hull.heal(1); // +1 segment; Health caps at maxHp (5)
    if (world.tailwind) world.tailwind.freeze();
    this.fadeT = 0;
    this.drainT = 0;
  };

  Machine.prototype.draw = function (ctx) {
    if (this.current) this.current.draw(ctx, this.world);
    if (this.fadeT >= 0) {
      var a = this.fadeT / CROSSFADE;
      if (a > 1) a = 1;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = '#06070d';
      ctx.fillRect(0, 0, this.world.W, this.world.H);
      ctx.restore();
    }
  };

  return { Machine: Machine };
});
