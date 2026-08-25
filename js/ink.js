/* MERIDIAN ONE — the ink layer.
 *
 * This is the motif the whole page is built around, and it is the one thing here
 * that only works for a pen: the 3D nib's tip vertex is projected into screen
 * space every frame, and a stroke is laid down at exactly that point. The
 * instrument is not next to the line — it is drawing it.
 *
 * Two producers write into the same ink model:
 *   nib     the projected tip of the 3D pen (chapters that sweep)
 *   pointer the visitor's own cursor (the pressure chapter)
 *
 * Width is driven by velocity, the way a real pen lays down more ink when it
 * slows into a curve, so the stroke has weight instead of being a constant
 * hairline.
 *
 * WHY THIS IS NOT A 2D CANVAS ANY MORE
 * ------------------------------------
 * It was, and it cost about 12 ms a frame. Instrumenting the function showed
 * only 0.09 ms of that was JavaScript: the rest was the browser re-uploading a
 * full-viewport 2D canvas layer to the compositor on every frame it was touched,
 * roughly 6 MB per frame. Shrinking it, dropping mix-blend-mode and removing the
 * per-segment colour strings all changed nothing, because none of them were the
 * cost.
 *
 * Now the stroke is a triangle strip drawn into the SAME HDR target as the
 * instrument, one extra draw call, no second layer to composite. It also lands
 * before the bloom pass, so the ink genuinely glows instead of having a glow
 * painted around it in three passes.
 */
(function (global) {
  "use strict";

  var MAX_POINTS = 260;

  var VS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 aPos;",      // screen pixels
    "in vec2 aNrm;",      // unit perpendicular, screen space
    "in vec3 aSWA;",      // side (-1/+1), half width px, alpha
    "uniform vec2 uRes;",
    "out float vSide;",
    "out float vAlpha;",
    "void main(){",
    "  vec2 p = aPos + aNrm * aSWA.x * aSWA.y;",
    "  vSide = aSWA.x;",
    "  vAlpha = aSWA.z;",
    "  vec2 c = (p / uRes) * 2.0 - 1.0;",
    "  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);",
    "}"
  ].join("\n");

  var FS = [
    "#version 300 es",
    "precision highp float;",
    "in float vSide;",
    "in float vAlpha;",
    "out vec4 oColor;",
    "uniform vec3 uColor;",
    "void main(){",
    "  /* One pass does what three canvas passes used to: a hot core with a soft",
    "   * shoulder, straight out of the distance across the ribbon. */",
    "  float d = abs(vSide);",
    "  float core = pow(max(0.0, 1.0 - d), 6.0);",
    "  float halo = pow(max(0.0, 1.0 - d), 1.5) * 0.30;",
    "  // written into an HDR target ahead of the bloom pass, so it is driven",
    "  // above 1.0 deliberately: that overshoot is what the bloom picks up.",
    "  oColor = vec4(uColor * (core + halo) * vAlpha * 3.4, 1.0);",
    "}"
  ].join("\n");

  function Ink() {
    this.pts = [];
    this.mode = "off";          // off | nib | pointer
    this.pressure = 0;          // smoothed 0..1
    this.peak = 0;
    this.w = 0; this.h = 0;
    // 2 vertices per point, 7 floats each
    this.data = new Float32Array(MAX_POINTS * 2 * 7);
    this.vertexCount = 0;
    this.color = [0.94, 0.73, 0.45];
    this.dirty = false;
  }

  Ink.prototype.resize = function () {
    this.w = global.innerWidth;
    this.h = global.innerHeight;
  };

  Ink.prototype.setMode = function (mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === "off") this.pts.length = 0;
  };

  Ink.prototype.clear = function () { this.pts.length = 0; };

  Ink.prototype.push = function (x, y, t) {
    var pts = this.pts;
    var last = pts[pts.length - 1];
    var jump = false;
    if (last) {
      var dx = x - last.x, dy = y - last.y;
      var d = Math.hypot(dx, dy);
      if (d < 0.6) return;                    // ignore jitter, keep the line clean
      /* A camera transition can move the nib hundreds of pixels between two
       * frames. That is the instrument being repositioned, not a stroke, and
       * joining across it draws a chord straight through the composition. */
      if (d > 90) jump = true;
      var dt = Math.max(1, t - last.t);
      var v = d / dt;                          // px per ms
      var target = Math.max(0, Math.min(1, 1 - v / 2.4));   // slow = more ink
      this.pressure += (target - this.pressure) * 0.22;
      this.peak = Math.max(this.peak * 0.985, this.pressure);
    }
    pts.push({ x: x, y: y, t: t, p: this.pressure, brk: jump });
    if (pts.length > MAX_POINTS) pts.shift();
  };

  /* Builds the ribbon. Returns the vertex count; 0 means nothing to draw. */
  Ink.prototype.build = function (now, opts) {
    var pts = this.pts;
    this.vertexCount = 0;
    if (this.mode === "off" || pts.length < 2) return 0;

    var life = opts.life || 1400;
    var scale = opts.scale === undefined ? 1 : opts.scale;
    var col = opts.color || [0.94, 0.73, 0.45];
    this.color[0] = col[0]; this.color[1] = col[1]; this.color[2] = col[2];

    while (pts.length && now - pts[0].t > life) pts.shift();
    if (pts.length < 2) return 0;

    var d = this.data, k = 0;
    for (var i = 0; i < pts.length; i++) {
      var b = pts[i];
      var a = pts[Math.max(0, i - 1)];
      var c = pts[Math.min(pts.length - 1, i + 1)];

      /* A break means the nib was repositioned rather than drawn with. Emitting
       * a zero-width, zero-alpha vertex pair pinches the ribbon shut there, so
       * one continuous strip can still contain several separate strokes. */
      var brk = b.brk || (i > 0 && a.brk);

      var tx = c.x - a.x, ty = c.y - a.y;
      var tl = Math.hypot(tx, ty) || 1;
      var nx = -ty / tl, ny = tx / tl;

      var age = (now - b.t) / life;
      var fade = Math.max(0, 1 - age);
      fade *= fade;
      var half = brk ? 0 : 9.0 * scale * (0.40 + 0.90 * b.p) * fade;
      var alpha = brk ? 0 : fade;

      for (var s = 0; s < 2; s++) {
        d[k++] = b.x; d[k++] = b.y;
        d[k++] = nx; d[k++] = ny;
        d[k++] = s === 0 ? -1 : 1;
        d[k++] = half;
        d[k++] = alpha;
      }
    }
    this.vertexCount = pts.length * 2;
    this.dirty = true;
    return this.vertexCount;
  };

  Ink.prototype.level = function () {
    return Math.round(this.pressure * 8192);
  };

  Ink.VS = VS;
  Ink.FS = FS;
  Ink.MAX_POINTS = MAX_POINTS;
  global.PenInk = Ink;
})(window);
