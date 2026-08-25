/* MERIDIAN ONE — procedural pen geometry
 *
 * The pen is a surface of revolution plus one swept clip. Everything is generated
 * in code: there are no model files and no image files in this project.
 *
 * Output is ONE indexed mesh so the whole instrument draws in a single call.
 * Per-vertex `aMeta = (zone, part)` lets the shader branch on material and lets
 * the exploded view offset parts without splitting the buffer.
 *
 * ZONES (material grammar)          PARTS (exploded-view groups)
 *   0 tip      elastomer              0 tip
 *   1 cone     polished steel         1 nib cone
 *   2 grip     knurled anodised al.   2 grip
 *   3 band     polished brass         3 band
 *   4 barrel   brushed anodised al.   4 barrel
 *   5 topring  polished steel         5 top
 *   6 dome     anodised + LED ring    5 top
 *   7 clip     polished steel         6 clip
 *
 * Units are millimetres. The pen is 152 mm long and is centred on the origin
 * after generation, so rotation happens about its own middle.
 */
(function (global) {
  "use strict";

  var RADIAL = 144;          // divisible by 24 (knurl), 16, 12, 8, 6
  var LENGTH = 152;
  var KNURL_AROUND = 24;     // diamonds around the circumference
  /* A real pen is about 14:1. On screen that reads spindly, so the body is
   * thickened to roughly 11.5:1 — the proportion premium pens are actually
   * photographed at. Axial dimensions are untouched, so the knurl pitch and
   * the engraving band stay where the shader expects them. */
  var RSCALE = 1.22;

  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { return t * t * (3 - 2 * t); }

  /* ---- profile ------------------------------------------------------------
   * Each segment contributes a run of rings. `curve` reshapes the radius
   * interpolation so a cone can be concave and a dome can be round.
   */
  var SEGMENTS = [
    // y0     y1     r0     r1    zone part rings curve
    [0.0,   4.0,   0.30,  1.30,  0, 0,  9,  "round"],   // elastomer tip
    [4.0,  24.0,   1.30,  4.70,  1, 1, 22,  "concave"], // nib cone
    [24.0, 25.2,   4.70,  5.05,  1, 1,  4,  "linear"],  // cone lip
    [25.2, 26.4,   5.05,  5.25,  2, 2,  3,  "smooth"],  // grip shoulder
    [26.4, 56.0,   5.25,  5.30,  2, 2, 64,  "bulge"],   // knurled grip
    [56.0, 57.2,   5.30,  5.08,  2, 2,  3,  "smooth"],  // grip step-down
    [57.2, 63.4,   5.55,  5.55,  3, 3, 12,  "grooved"], // engraved band
    [63.4, 64.6,   5.55,  5.30,  4, 4,  3,  "smooth"],  // barrel shoulder
    [64.6,142.0,   5.30,  5.05,  4, 4, 18,  "linear"],  // barrel
    [142.0,146.5,  5.20,  5.20,  5, 5,  7,  "grooved"], // top ring
    [146.5,152.0,  5.20,  0.00,  6, 5, 16,  "domeOut"]  // dome + LED inset
  ];

  function radiusAt(seg, t) {
    var r0 = seg[2], r1 = seg[3], curve = seg[7], r;
    switch (curve) {
      // "round" rises fast then flattens: a rounded nose.
      // "domeOut" holds its radius then falls away: an actual hemisphere cap.
      case "round":   r = lerp(r0, r1, Math.sin(t * Math.PI * 0.5)); break;
      case "domeOut": r = lerp(r1, r0, Math.cos(t * Math.PI * 0.5)); break;
      case "concave": r = lerp(r0, r1, Math.pow(t, 1.42)); break;
      case "smooth":  r = lerp(r0, r1, smooth(t)); break;
      case "bulge":   r = lerp(r0, r1, t) + Math.sin(t * Math.PI) * 0.10; break;
      case "grooved": r = lerp(r0, r1, t) - Math.pow(Math.sin(t * Math.PI * 3.0), 8.0) * 0.34; break;
      default:        r = lerp(r0, r1, t);
    }
    return r * RSCALE;
  }

  /* Build the ordered list of rings once, so normals can be taken from the
   * real neighbouring radii instead of from the idealised segment slope.  */
  function buildRings() {
    var rings = [];
    for (var s = 0; s < SEGMENTS.length; s++) {
      var seg = SEGMENTS[s];
      var n = seg[6];
      var start = (s === 0) ? 0 : 1;           // avoid duplicate seam rings
      for (var i = start; i <= n; i++) {
        var t = i / n;
        rings.push({
          y: lerp(seg[0], seg[1], t),
          r: radiusAt(seg, t),
          zone: seg[4],
          part: seg[5]
        });
      }
    }
    return rings;
  }

  function buildBody() {
    var rings = buildRings();
    var ringCount = rings.length;
    var vertsPerRing = RADIAL + 1;             // +1 duplicated seam vertex for clean u
    var vcount = ringCount * vertsPerRing;

    var pos = new Float32Array(vcount * 3);
    var nrm = new Float32Array(vcount * 3);
    var uv = new Float32Array(vcount * 2);
    var meta = new Float32Array(vcount * 2);

    var yMid = LENGTH * 0.5;
    var vi = 0;

    for (var ri = 0; ri < ringCount; ri++) {
      var ring = rings[ri];
      var prev = rings[Math.max(0, ri - 1)];
      var next = rings[Math.min(ringCount - 1, ri + 1)];

      // 2D profile tangent, then its perpendicular = surface normal in (r,y)
      var dy = next.y - prev.y;
      var dr = next.r - prev.r;
      var pl = Math.hypot(dy, dr) || 1;
      var nr = dy / pl;        // radial component
      var ny = -dr / pl;       // axial component

      for (var a = 0; a <= RADIAL; a++) {
        var u = a / RADIAL;
        var ang = u * Math.PI * 2;
        var ca = Math.cos(ang), sa = Math.sin(ang);

        pos[vi * 3]     = ca * ring.r;
        pos[vi * 3 + 1] = ring.y - yMid;
        pos[vi * 3 + 2] = sa * ring.r;

        nrm[vi * 3]     = ca * nr;
        nrm[vi * 3 + 1] = ny;
        nrm[vi * 3 + 2] = sa * nr;

        uv[vi * 2]     = u;
        uv[vi * 2 + 1] = ring.y;          // world-y in mm: engraving + zone maths
        meta[vi * 2]     = ring.zone;
        meta[vi * 2 + 1] = ring.part;
        vi++;
      }
    }

    // indices
    var quads = (ringCount - 1) * RADIAL;
    var idx = new Uint32Array(quads * 6);
    var k = 0;
    for (var r2 = 0; r2 < ringCount - 1; r2++) {
      for (var a2 = 0; a2 < RADIAL; a2++) {
        var i0 = r2 * vertsPerRing + a2;
        var i1 = i0 + 1;
        var i2 = i0 + vertsPerRing;
        var i3 = i2 + 1;
        idx[k++] = i0; idx[k++] = i2; idx[k++] = i1;
        idx[k++] = i1; idx[k++] = i2; idx[k++] = i3;
      }
    }
    return { pos: pos, nrm: nrm, uv: uv, meta: meta, idx: idx, vcount: vcount };
  }

  /* ---- clip ---------------------------------------------------------------
   * A rounded-rectangle cross-section swept along a curve in the XY plane.
   * The clip is the one part that breaks the surface of revolution, which is
   * exactly why it carries the silhouette.
   */
  function clipPath(t) {
    // t 0..1 from the ball foot up to where the clip tucks into the cap flank.
    // It deliberately stops ON the dome instead of hooking over the top: a clip
    // that crosses the axis reads as a wire loop, not as spring steel.
    var pts = [
      [4.85, 105.0], [5.50, 109.0], [5.82, 115.0], [5.96, 123.0],
      [6.02, 131.0], [6.04, 138.0], [6.00, 143.0], [5.72, 146.2],
      [5.10, 147.9], [4.40, 148.6]
    ];
    var f = t * (pts.length - 1);
    var i = Math.min(pts.length - 2, Math.floor(f));
    var u = smooth(f - i);
    return [lerp(pts[i][0], pts[i + 1][0], u) * RSCALE, lerp(pts[i][1], pts[i + 1][1], u)];
  }

  function buildClip() {
    var STEPS = 46;
    var CS = 12;                    // cross-section points (rounded rect)
    var halfW = 1.85 * RSCALE;      // half width, along Z
    var halfT = 0.42 * RSCALE;      // half thickness, along the path normal
    var yMid = LENGTH * 0.5;

    var vcount = (STEPS + 1) * (CS + 1);
    var pos = new Float32Array(vcount * 3);
    var nrm = new Float32Array(vcount * 3);
    var uv = new Float32Array(vcount * 2);
    var meta = new Float32Array(vcount * 2);

    var vi = 0;
    for (var s = 0; s <= STEPS; s++) {
      var t = s / STEPS;
      var p = clipPath(t);
      var pa = clipPath(Math.max(0, t - 0.01));
      var pb = clipPath(Math.min(1, t + 0.01));
      var tx = pb[0] - pa[0], ty = pb[1] - pa[1];
      var tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      var nx = ty, ny = -tx;        // in-plane normal

      // taper the foot and the tip of the clip so it does not read as a slab
      var taper = 0.55 + 0.45 * Math.sin(Math.min(1, Math.max(0, (t - 0.02) / 0.16)) * Math.PI * 0.5);
      taper *= 0.6 + 0.4 * Math.sin(Math.min(1, Math.max(0, (1 - t) / 0.14)) * Math.PI * 0.5);
      var w = halfW * taper;
      var th = halfT * (0.7 + 0.3 * taper);

      for (var c = 0; c <= CS; c++) {
        var ca = (c / CS) * Math.PI * 2;
        // superellipse -> rounded rectangle
        var cc = Math.cos(ca), ss = Math.sin(ca);
        var ex = Math.sign(cc) * Math.pow(Math.abs(cc), 0.55);
        var ey = Math.sign(ss) * Math.pow(Math.abs(ss), 0.55);

        var ox = ex * w;            // along Z
        var oy = ey * th;           // along in-plane normal

        pos[vi * 3]     = p[0] + nx * oy;
        pos[vi * 3 + 1] = p[1] + ny * oy - yMid;
        pos[vi * 3 + 2] = ox;

        var nlen = Math.hypot(ex, ey) || 1;
        nrm[vi * 3]     = nx * (ey / nlen);
        nrm[vi * 3 + 1] = ny * (ey / nlen);
        nrm[vi * 3 + 2] = ex / nlen;

        uv[vi * 2] = c / CS;
        uv[vi * 2 + 1] = p[1];
        meta[vi * 2] = 7;           // zone: clip
        meta[vi * 2 + 1] = 6;       // part: clip
        vi++;
      }
    }

    var idx = new Uint32Array(STEPS * CS * 6);
    var k = 0;
    for (var s2 = 0; s2 < STEPS; s2++) {
      for (var c2 = 0; c2 < CS; c2++) {
        var i0 = s2 * (CS + 1) + c2;
        var i1 = i0 + 1;
        var i2 = i0 + (CS + 1);
        var i3 = i2 + 1;
        idx[k++] = i0; idx[k++] = i2; idx[k++] = i1;
        idx[k++] = i1; idx[k++] = i2; idx[k++] = i3;
      }
    }
    return { pos: pos, nrm: nrm, uv: uv, meta: meta, idx: idx, vcount: vcount };
  }


  /* ---- internals -----------------------------------------------------------
   * Only ever seen through the cutaway. These are the parts a digital pen
   * actually contains, laid out in the order they physically sit in the barrel,
   * so slicing the shell open reveals a believable stack rather than a hollow
   * tube with some shapes floating in it.
   *
   * ZONES  8 sensor module   9 PCB   10 cell   11 USB-C port
   * PARTS  7 sensor          8 PCB   9  cell   10 port
   */
  function buildTube(y0, y1, r0, r1, zone, part, seg, cap) {
    var RS = 40;
    var rings = [];
    if (cap) rings.push({ y: y0, r: 0.001 });
    for (var i = 0; i <= seg; i++) {
      var t = i / seg;
      rings.push({ y: lerp(y0, y1, t), r: lerp(r0, r1, t) * RSCALE });
    }
    if (cap) rings.push({ y: y1, r: 0.001 });

    var vpr = RS + 1, vcount = rings.length * vpr, vi = 0;
    var pos = new Float32Array(vcount * 3), nrm = new Float32Array(vcount * 3);
    var uv = new Float32Array(vcount * 2), meta = new Float32Array(vcount * 2);
    var yMid = LENGTH * 0.5;

    for (var ri = 0; ri < rings.length; ri++) {
      var ring = rings[ri];
      var pv = rings[Math.max(0, ri - 1)], nx = rings[Math.min(rings.length - 1, ri + 1)];
      var dy = nx.y - pv.y, dr = nx.r - pv.r;
      var pl = Math.hypot(dy, dr) || 1;
      for (var a = 0; a <= RS; a++) {
        var u = a / RS, ang = u * Math.PI * 2;
        var ca = Math.cos(ang), sa = Math.sin(ang);
        pos[vi * 3] = ca * ring.r; pos[vi * 3 + 1] = ring.y - yMid; pos[vi * 3 + 2] = sa * ring.r;
        nrm[vi * 3] = ca * (dy / pl); nrm[vi * 3 + 1] = -dr / pl; nrm[vi * 3 + 2] = sa * (dy / pl);
        uv[vi * 2] = u; uv[vi * 2 + 1] = ring.y;
        meta[vi * 2] = zone; meta[vi * 2 + 1] = part;
        vi++;
      }
    }
    var idx = new Uint32Array((rings.length - 1) * RS * 6), k = 0;
    for (var r2 = 0; r2 < rings.length - 1; r2++) {
      for (var a2 = 0; a2 < RS; a2++) {
        var i0 = r2 * vpr + a2, i1 = i0 + 1, i2 = i0 + vpr, i3 = i2 + 1;
        idx[k++] = i0; idx[k++] = i2; idx[k++] = i1;
        idx[k++] = i1; idx[k++] = i2; idx[k++] = i3;
      }
    }
    return { pos: pos, nrm: nrm, uv: uv, meta: meta, idx: idx, vcount: vcount };
  }

  function buildBox(hw, hd, y0, y1, zone, part) {
    var yMid = LENGTH * 0.5;
    var w = hw * RSCALE, d = hd * RSCALE;
    var a = y0 - yMid, b = y1 - yMid;
    var F = [
      [[-w, a, d], [w, a, d], [w, b, d], [-w, b, d], [0, 0, 1]],
      [[w, a, -d], [-w, a, -d], [-w, b, -d], [w, b, -d], [0, 0, -1]],
      [[w, a, d], [w, a, -d], [w, b, -d], [w, b, d], [1, 0, 0]],
      [[-w, a, -d], [-w, a, d], [-w, b, d], [-w, b, -d], [-1, 0, 0]],
      [[-w, b, d], [w, b, d], [w, b, -d], [-w, b, -d], [0, 1, 0]],
      [[-w, a, -d], [w, a, -d], [w, a, d], [-w, a, d], [0, -1, 0]]
    ];
    var vcount = 24;
    var pos = new Float32Array(72), nrm = new Float32Array(72);
    var uv = new Float32Array(48), meta = new Float32Array(48);
    var idx = new Uint32Array(36), vi = 0, k = 0;
    for (var f = 0; f < 6; f++) {
      var n = F[f][4], base = vi;
      for (var c = 0; c < 4; c++) {
        var p = F[f][c];
        pos[vi * 3] = p[0]; pos[vi * 3 + 1] = p[1]; pos[vi * 3 + 2] = p[2];
        nrm[vi * 3] = n[0]; nrm[vi * 3 + 1] = n[1]; nrm[vi * 3 + 2] = n[2];
        uv[vi * 2] = (c === 1 || c === 2) ? 1 : 0;
        uv[vi * 2 + 1] = p[1] + yMid;
        meta[vi * 2] = zone; meta[vi * 2 + 1] = part;
        vi++;
      }
      idx[k++] = base; idx[k++] = base + 1; idx[k++] = base + 2;
      idx[k++] = base; idx[k++] = base + 2; idx[k++] = base + 3;
    }
    return { pos: pos, nrm: nrm, uv: uv, meta: meta, idx: idx, vcount: vcount };
  }

  function buildInternals() {
    var m = buildTube(9.0, 27.0, 0.55, 2.30, 8, 7, 14, true);       // pressure sensor
    m = merge(m, buildTube(27.0, 31.0, 2.30, 2.05, 8, 7, 3, false));// sensor collar
    m = merge(m, buildBox(2.55, 0.42, 33.0, 74.0, 9, 8));           // PCB
    m = merge(m, buildTube(78.0, 126.0, 3.45, 3.45, 10, 9, 10, true)); // cell
    m = merge(m, buildBox(1.65, 0.72, 130.0, 141.0, 11, 10));       // USB-C port
    return m;
  }

  function merge(a, b) {
    var vc = a.vcount + b.vcount;
    var pos = new Float32Array(vc * 3);
    var nrm = new Float32Array(vc * 3);
    var uv = new Float32Array(vc * 2);
    var meta = new Float32Array(vc * 2);
    pos.set(a.pos, 0); pos.set(b.pos, a.vcount * 3);
    nrm.set(a.nrm, 0); nrm.set(b.nrm, a.vcount * 3);
    uv.set(a.uv, 0);   uv.set(b.uv, a.vcount * 2);
    meta.set(a.meta, 0); meta.set(b.meta, a.vcount * 2);

    var idx = new Uint32Array(a.idx.length + b.idx.length);
    idx.set(a.idx, 0);
    for (var i = 0; i < b.idx.length; i++) idx[a.idx.length + i] = b.idx[i] + a.vcount;
    return { pos: pos, nrm: nrm, uv: uv, meta: meta, idx: idx, vcount: vc };
  }

  /* Per-part bounds in pen-local space.
   *
   * The inspector needs two things it cannot guess: where a part's centre is,
   * so it can be brought to the origin, and how big it is, so the camera can
   * be pulled back to exactly frame it. Hand-tuning eleven camera distances
   * would go stale the moment the profile changes; deriving them from the
   * vertices cannot. */
  function partBounds(mesh) {
    var out = [];
    for (var i = 0; i < 11; i++) {
      out.push({ min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9], c: [0, 0, 0], r: 1 });
    }
    for (var v = 0; v < mesh.vcount; v++) {
      var pi = Math.round(mesh.meta[v * 2 + 1]);
      if (pi < 0 || pi > 10) continue;
      var b = out[pi];
      for (var k = 0; k < 3; k++) {
        var val = mesh.pos[v * 3 + k];
        if (val < b.min[k]) b.min[k] = val;
        if (val > b.max[k]) b.max[k] = val;
      }
    }
    for (var j = 0; j < 11; j++) {
      var q = out[j];
      if (q.min[0] > q.max[0]) { q.min = [0, 0, 0]; q.max = [0, 0, 0]; }
      var rad = 0;
      for (var m = 0; m < 3; m++) {
        q.c[m] = (q.min[m] + q.max[m]) * 0.5;
        var half = (q.max[m] - q.min[m]) * 0.5;
        rad += half * half;
      }
      // bounding-sphere radius, floored so a near-flat part still frames sanely
      q.r = Math.max(3.5, Math.sqrt(rad));
      q.size = [q.max[0] - q.min[0], q.max[1] - q.min[1], q.max[2] - q.min[2]];
    }
    return out;
  }

  function build() {
    var mesh = merge(merge(buildBody(), buildClip()), buildInternals());
    mesh.radial = RADIAL;
    mesh.length = LENGTH;
    mesh.knurlAround = KNURL_AROUND;
    mesh.triangles = mesh.idx.length / 3;
    mesh.partBounds = partBounds(mesh);
    return mesh;
  }

  /* Nib tip in pen-local space. The ink system projects this to screen space,
   * which is what couples the 3D instrument to the 2D line it draws. */
  function tipLocal() { return [0, -LENGTH * 0.5 + 0.15, 0]; }

  global.PenGeometry = { build: build, tipLocal: tipLocal, RADIAL: RADIAL, LENGTH: LENGTH };
})(window);
