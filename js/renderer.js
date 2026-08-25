/* MERIDIAN ONE — WebGL2 renderer.
 *
 * Budget, in draw calls per frame:
 *   1 instrument (one indexed mesh, every part, one call)
 *   1 bloom high-pass   1 blur H   1 blur V   1 composite
 *   = 5 total.
 *
 * The projection contract from the architecture reference is enforced in
 * render(): the canvas rectangle is measured inside the same call that uploads
 * the projection matrix, and the same rectangle drives both aspect and viewport.
 * That is what stops a fast scroll from squashing the instrument for one frame.
 */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------ tiny linalg */
  function mat4() { return new Float32Array(16); }

  function perspective(out, fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
    return out;
  }

  function lookAt(out, eye, center, up) {
    var zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    var zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
    var xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    var xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }

  function eulerMat3(out, rx, ry, rz) {
    var cx = Math.cos(rx), sx = Math.sin(rx);
    var cy = Math.cos(ry), sy = Math.sin(ry);
    var cz = Math.cos(rz), sz = Math.sin(rz);
    // Ry * Rx * Rz
    out[0] = cy * cz + sy * sx * sz;  out[1] = cx * sz;   out[2] = -sy * cz + cy * sx * sz;
    out[3] = -cy * sz + sy * sx * cz; out[4] = cx * cz;   out[5] = sy * sz + cy * sx * cz;
    out[6] = sy * cx;                 out[7] = -sx;       out[8] = cy * cx;
    return out;
  }

  /* -------------------------------------------------------------- gl helpers */
  function compile(gl, type, src, label) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(label + " compile failed:\n" + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function program(gl, vsSrc, fsSrc, label) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc, label + ".vs"));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc, label + ".fs"));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(label + " link failed:\n" + gl.getProgramInfoLog(p));
    }
    var u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      var name = info.name.replace(/\[0\]$/, "");
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p: p, u: u };
  }

  /* Engraving atlas — generated with Canvas2D so the build stays image-free. */
  function makeMarkTexture(gl) {
    var W = 2048, H = 128;
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    var x = c.getContext("2d");
    x.fillStyle = "#000"; x.fillRect(0, 0, W, H);
    x.fillStyle = "#fff";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.font = "600 44px 'Archivo', 'Helvetica Neue', Arial, sans-serif";
    // four repeats so the wordmark wraps evenly around the band
    var marks = ["MERIDIAN  ONE", "8192  LEVELS", "MERIDIAN  ONE", "TILT  60°"];
    for (var i = 0; i < 4; i++) {
      x.save();
      x.translate(W * (i + 0.5) / 4, H / 2);
      x.setTransform(1, 0, 0, 1, W * (i + 0.5) / 4, H / 2);
      x.fillText(marks[i], 0, 2);
      x.restore();
    }
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, c);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /* ----------------------------------------------------------------- Renderer */
  function Renderer(canvas) {
    var gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: true,
      powerPreference: "high-performance", preserveDrawingBuffer: false
    });
    if (!gl) throw new Error("WebGL2 unavailable");

    this.gl = gl;
    this.canvas = canvas;
    this.ok = true;
    this.drawCalls = 0;
    this.renderScale = 1;
    this.dprCap = 1.5;
    this.samples = 0;
    this.bufW = 0; this.bufH = 0;
    this.aspect = 1;

    var floatOK = !!gl.getExtension("EXT_color_buffer_float");
    var halfOK = !!gl.getExtension("EXT_color_buffer_half_float");
    this.hdrFormat = floatOK ? gl.RGBA16F : (halfOK ? gl.RGBA16F : gl.RGBA8);
    this.hdrType = (floatOK || halfOK) ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    var maxS = gl.getParameter(gl.MAX_SAMPLES) | 0;
    this.samples = Math.min(4, maxS);

    this.progScene = program(gl, PenShaders.SCENE_VS, PenShaders.SCENE_FS, "scene");
    this.progHigh = program(gl, PenShaders.QUAD_VS, PenShaders.HIGHPASS_FS, "highpass");
    this.progBlur = program(gl, PenShaders.QUAD_VS, PenShaders.BLUR_FS, "blur");
    this.progComp = program(gl, PenShaders.QUAD_VS, PenShaders.COMPOSITE_FS, "composite");
    this.progDust = program(gl, PenShaders.DUST_VS, PenShaders.DUST_FS, "dust");
    this.progInk = program(gl, PenInk.VS, PenInk.FS, "ink");
    this.progPick = program(gl, PenShaders.SCENE_VS, PenShaders.PICK_FS, "pick");
    this._buildDust();
    this._buildInk();

    this.markTex = makeMarkTexture(gl);
    this.emptyVAO = gl.createVertexArray();

    /* The studio cubemap is generated and prefiltered once, here. It needs the
     * fullscreen-triangle vertex shader and the program compiler, so they are
     * handed in rather than duplicated inside the env module. */
    gl.bindVertexArray(this.emptyVAO);
    this.env = PenEnv.build(gl, PenShaders.QUAD_VS, program);
    gl.bindVertexArray(null);

    this._buildMesh();
    this._targets = null;

    this.proj = mat4();
    this.view = mat4();
    this.rot = new Float32Array(9);
    this.partOffsets = new Float32Array(11 * 4);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0, 0, 0, 1);
  }

  Renderer.prototype._buildMesh = function () {
    var gl = this.gl;
    var m = PenGeometry.build();
    this.mesh = { triangles: m.triangles, count: m.idx.length, verts: m.vcount,
                  partBounds: m.partBounds };

    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    function attrib(loc, data, size) {
      var b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
    var p = this.progScene.p;
    attrib(gl.getAttribLocation(p, "aPos"), m.pos, 3);
    attrib(gl.getAttribLocation(p, "aNormal"), m.nrm, 3);
    attrib(gl.getAttribLocation(p, "aUV"), m.uv, 2);
    attrib(gl.getAttribLocation(p, "aMeta"), m.meta, 2);

    var ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    this.vao = vao;
  };

  /* Motes scattered through a studio-sized volume. Deterministic so the field
   * is identical on every load and cannot flicker between frames. */
  Renderer.prototype._buildDust = function () {
    var gl = this.gl;
    var N = 420;
    this.dustCount = N;
    var seed = new Float32Array(N * 3), rnd = new Float32Array(N * 2);
    var s0 = 20260825;
    function rand() { s0 = (s0 * 1664525 + 1013904223) >>> 0; return s0 / 4294967296; }
    for (var i = 0; i < N; i++) {
      seed[i * 3]     = (rand() - 0.5) * 620;
      seed[i * 3 + 1] = (rand() - 0.5) * 460;
      seed[i * 3 + 2] = (rand() - 0.5) * 520 - 60;
      rnd[i * 2]     = 0.28 + rand() * 0.95;   // mote radius in mm
      rnd[i * 2 + 1] = rand();
    }
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var p = this.progDust.p;
    var b1 = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b1);
    gl.bufferData(gl.ARRAY_BUFFER, seed, gl.STATIC_DRAW);
    var l1 = gl.getAttribLocation(p, "aSeed");
    gl.enableVertexAttribArray(l1); gl.vertexAttribPointer(l1, 3, gl.FLOAT, false, 0, 0);
    var b2 = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b2);
    gl.bufferData(gl.ARRAY_BUFFER, rnd, gl.STATIC_DRAW);
    var l2 = gl.getAttribLocation(p, "aRnd");
    gl.enableVertexAttribArray(l2); gl.vertexAttribPointer(l2, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.dustVAO = vao;
  };

  /* One dynamic buffer for the ink ribbon, uploaded with bufferSubData each
   * frame it changes. 260 points is 3,640 floats: nothing. */
  Renderer.prototype._buildInk = function () {
    var gl = this.gl;
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, PenInk.MAX_POINTS * 2 * 7 * 4, gl.DYNAMIC_DRAW);
    var p = this.progInk.p, S = 7 * 4;
    var lp = gl.getAttribLocation(p, "aPos");
    gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, S, 0);
    var ln = gl.getAttribLocation(p, "aNrm");
    gl.enableVertexAttribArray(ln); gl.vertexAttribPointer(ln, 2, gl.FLOAT, false, S, 8);
    var ls = gl.getAttribLocation(p, "aSWA");
    gl.enableVertexAttribArray(ls); gl.vertexAttribPointer(ls, 3, gl.FLOAT, false, S, 16);
    gl.bindVertexArray(null);
    this.inkVAO = vao; this.inkBuf = buf;
  };

  Renderer.prototype._tex = function (w, h, fmt, type) {
    var gl = this.gl;
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };

  Renderer.prototype._allocTargets = function (w, h) {
    var gl = this.gl;
    var t = this._targets;
    if (t) {
      gl.deleteFramebuffer(t.msFBO); gl.deleteFramebuffer(t.resolveFBO);
      gl.deleteFramebuffer(t.bloomFBO_A); gl.deleteFramebuffer(t.bloomFBO_B);
      gl.deleteRenderbuffer(t.msColor); gl.deleteRenderbuffer(t.msDepth);
      gl.deleteTexture(t.resolveTex); gl.deleteTexture(t.bloomA); gl.deleteTexture(t.bloomB);
    }

    var bw = Math.max(2, w >> 2), bh = Math.max(2, h >> 2);

    var msColor = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, msColor);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, this.hdrFormat, w, h);

    var msDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, msDepth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT16, w, h);

    var msFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, msFBO);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msColor);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, msDepth);

    var resolveTex = this._tex(w, h, this.hdrFormat, this.hdrType);
    var resolveFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resolveTex, 0);

    var bloomA = this._tex(bw, bh, this.hdrFormat, this.hdrType);
    var bloomFBO_A = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFBO_A);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bloomA, 0);

    var bloomB = this._tex(bw, bh, this.hdrFormat, this.hdrType);
    var bloomFBO_B = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFBO_B);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bloomB, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this._targets = {
      msFBO: msFBO, msColor: msColor, msDepth: msDepth,
      resolveFBO: resolveFBO, resolveTex: resolveTex,
      bloomFBO_A: bloomFBO_A, bloomA: bloomA,
      bloomFBO_B: bloomFBO_B, bloomB: bloomB,
      w: w, h: h, bw: bw, bh: bh
    };
  };

  /* pose: { rotX, rotY, rotZ, camZ, fov, focusY, panX, panY, parts[], led, reveal, cut } */
  Renderer.prototype.render = function (pose, time) {
    var gl = this.gl;

    // --- projection contract: measure inside the same call ------------------
    var rect = this.canvas.getBoundingClientRect();
    this._rect = rect;      // reused by projectPoint: see the note there
    var cssW = Math.max(1, Math.round(rect.width));
    var cssH = Math.max(1, Math.round(rect.height));
    var dpr = Math.min(this.dprCap, global.devicePixelRatio || 1);
    var scale = dpr * this.renderScale;
    var w = Math.max(2, Math.round(cssW * scale));
    var h = Math.max(2, Math.round(cssH * scale));

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    if (!this._targets || this._targets.w !== w || this._targets.h !== h) {
      this._allocTargets(w, h);
    }
    this.bufW = w; this.bufH = h;
    this.aspect = cssW / cssH;                 // from the SAME measured rect

    perspective(this.proj, pose.fov * Math.PI / 180, this.aspect, 1, 4000);
    lookAt(this.view,
      [pose.panX, pose.focusY + pose.panY, pose.camZ],
      [pose.panX * 0.35, pose.focusY, 0],
      [0, 1, 0]);
    eulerMat3(this.rot, pose.rotX, pose.rotY, pose.rotZ);

    for (var i = 0; i < 11; i++) {
      var o = pose.parts[i] || [0, 0, 0];
      this.partOffsets[i * 4] = o[0];
      this.partOffsets[i * 4 + 1] = o[1];
      this.partOffsets[i * 4 + 2] = o[2];
      this.partOffsets[i * 4 + 3] = 0;
    }

    var t = this._targets;
    this.drawCalls = 0;

    // --- 1. instrument ------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.msFBO);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    var S = this.progScene;
    gl.useProgram(S.p);
    gl.uniformMatrix4fv(S.u.uProj, false, this.proj);
    gl.uniformMatrix4fv(S.u.uView, false, this.view);
    gl.uniformMatrix3fv(S.u.uRot, false, this.rot);
    gl.uniform3f(S.u.uOrigin, 0, 0, 0);
    gl.uniform4fv(S.u.uPart, this.partOffsets);
    gl.uniform1f(S.u.uKnurl, pose.knurl);
    gl.uniform1f(S.u.uTime, time);
    gl.uniform1f(S.u.uLed, pose.led);
    gl.uniform1f(S.u.uReveal, pose.reveal);
    gl.uniform1f(S.u.uCut, pose.cut);
    gl.uniform1f(S.u.uCutaway, pose.cutaway || 0);
    gl.uniform1f(S.u.uCutAngle, pose.cutAngle || 0);
    gl.uniform2f(S.u.uSolo, pose.soloPart === undefined ? -1 : pose.soloPart, pose.soloMix || 0);
    gl.uniform2f(S.u.uHover, pose.hoverPart === undefined ? -1 : pose.hoverPart, pose.hoverAmt || 0);
    gl.uniform1f(S.u.uInside, pose.soloMix || 0);

    /* Backface culling has to come off while the wedge is open. The far inside
     * wall of the shell is a backface, and with culling on the cutaway shows
     * empty space where the interior should be. */
    if ((pose.cutaway || 0) > 0.001 || (pose.soloMix || 0) > 0.001) gl.disable(gl.CULL_FACE);
    else gl.enable(gl.CULL_FACE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.markTex);
    gl.uniform1i(S.u.uMark, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.env.tex);
    gl.uniform1i(S.u.uEnv, 1);
    gl.uniform1f(S.u.uEnvMaxLod, this.env.maxLod);

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0);
    this.drawCalls++;
    gl.bindVertexArray(null);

    /* Dust goes into the same HDR target as the instrument, before the resolve,
     * so it picks up MSAA and feeds the bloom instead of being pasted on top.
     * Depth test stays ON and depth write OFF: motes behind the pen are hidden
     * by it, but they never occlude each other into hard discs. */
    if ((pose.dust || 0) > 0.001) {
      var D = this.progDust;
      gl.useProgram(D.p);
      gl.uniformMatrix4fv(D.u.uProj, false, this.proj);
      gl.uniformMatrix4fv(D.u.uView, false, this.view);
      gl.uniform1f(D.u.uTime, time);
      gl.uniform1f(D.u.uSizeK, (h * 0.5) / Math.tan(pose.fov * Math.PI / 360));
      gl.uniform1f(D.u.uAmount, pose.dust);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.bindVertexArray(this.dustVAO);
      gl.drawArrays(gl.POINTS, 0, this.dustCount);
      this.drawCalls++;
      gl.bindVertexArray(null);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    /* Ink goes into the HDR target too, so the stroke feeds the bloom rather
     * than having a glow painted around it. Depth test off: the line is a 2D
     * overlay in screen space and must never be occluded by the instrument. */
    if (pose.inkVerts > 1) {
      var K = this.progInk;
      gl.useProgram(K.p);
      gl.uniform2f(K.u.uRes, cssW, cssH);
      gl.uniform3fv(K.u.uColor, pose.inkColor);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.bindVertexArray(this.inkVAO);
      if (pose.inkData) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.inkBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, pose.inkData, 0, pose.inkVerts * 7);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, pose.inkVerts);
      this.drawCalls++;
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
    }

    // resolve MSAA
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.msFBO);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.resolveFBO);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);

    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.emptyVAO);

    // --- 2. bloom high-pass -------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.bloomFBO_A);
    gl.viewport(0, 0, t.bw, t.bh);
    gl.useProgram(this.progHigh.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.resolveTex);
    gl.uniform1i(this.progHigh.u.uSrc, 0);
    gl.uniform1f(this.progHigh.u.uThreshold, 0.62);
    gl.uniform1f(this.progHigh.u.uKnee, 0.55);
    gl.drawArrays(gl.TRIANGLES, 0, 3); this.drawCalls++;

    // --- 3/4. separable blur ------------------------------------------------
    gl.useProgram(this.progBlur.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.bloomFBO_B);
    gl.bindTexture(gl.TEXTURE_2D, t.bloomA);
    gl.uniform1i(this.progBlur.u.uSrc, 0);
    gl.uniform2f(this.progBlur.u.uDir, 1 / t.bw, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3); this.drawCalls++;

    gl.bindFramebuffer(gl.FRAMEBUFFER, t.bloomFBO_A);
    gl.bindTexture(gl.TEXTURE_2D, t.bloomB);
    gl.uniform2f(this.progBlur.u.uDir, 0, 1 / t.bh);
    gl.drawArrays(gl.TRIANGLES, 0, 3); this.drawCalls++;

    // --- 5. composite -------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    var C = this.progComp;
    gl.useProgram(C.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.resolveTex);
    gl.uniform1i(C.u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, t.bloomA);
    gl.uniform1i(C.u.uBloom, 1);
    gl.uniform2f(C.u.uRes, w, h);
    gl.uniform1f(C.u.uTime, time);
    gl.uniform1f(C.u.uBloomAmt, pose.bloom);
    gl.uniform1f(C.u.uVignette, 0.62);
    gl.uniform1f(C.u.uGrain, 0.016);
    gl.uniform1f(C.u.uExposure, pose.exposure === undefined ? 1 : pose.exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3); this.drawCalls++;

    gl.bindVertexArray(null);
  };

  /* Project a pen-local point into CSS pixel space. This is what couples the 3D
   * instrument to the 2D layers above it — the ink follows a real vertex and the
   * exploded-view labels follow real part centres, not scripted paths. */
  Renderer.prototype.projectPoint = function (local, partIdx, pose) {
    var off = pose.parts[partIdx] || [0, 0, 0];
    var x = local[0] + off[0], y = local[1] + off[1], z = local[2] + off[2];
    var R = this.rot;
    var wx = R[0] * x + R[3] * y + R[6] * z;
    var wy = R[1] * x + R[4] * y + R[7] * z;
    var wz = R[2] * x + R[5] * y + R[8] * z;
    var V = this.view;
    var vx = V[0] * wx + V[4] * wy + V[8] * wz + V[12];
    var vy = V[1] * wx + V[5] * wy + V[9] * wz + V[13];
    var vz = V[2] * wx + V[6] * wy + V[10] * wz + V[14];
    var P = this.proj;
    var cx = P[0] * vx;
    var cy = P[5] * vy;
    var cw = -vz;
    if (cw <= 0.0001) return null;
    /* Reuse the rectangle render() already measured this frame. Calling
     * getBoundingClientRect() here instead forces a synchronous layout on every
     * projected point, and with seven exploded-view labels that alone cost more
     * than the entire GPU pipeline. */
    var rect = this._rect || this.canvas.getBoundingClientRect();
    return {
      x: (cx / cw * 0.5 + 0.5) * rect.width,
      y: (0.5 - cy / cw * 0.5) * rect.height,
      depth: cw
    };
  };

  Renderer.prototype.projectTip = function (pose) {
    return this.projectPoint(PenGeometry.tipLocal(), 0, pose);
  };

  /* Which part is under this CSS pixel? Returns a part index, or -1.
   *
   * This renders the instrument again with a shader that writes the part id
   * instead of a colour, then reads one pixel back. It is exact by
   * construction: it reuses the scene VERTEX shader verbatim, so the pick is
   * taken against the same explode offsets and the same knurl displacement
   * that produced the picture. Any screen-space approximation — distance to a
   * projected centre, a 2D bounding box — disagrees with what the visitor can
   * see the moment two parts overlap, which in an exploded view is constantly.
   *
   * Cost is kept near zero by scissoring to three pixels. The vertex stage
   * still runs for the whole mesh, but 50k triangles is nothing; it is fill
   * that costs, and there is none. The expensive part is readPixels, which
   * stalls the pipeline until the GPU catches up, so the CALLER must throttle
   * hover picks. Once per click is free; once per pointermove is not. */
  /* The pick target is small, and it is allocated the first time something is
   * actually picked.
   *
   * It started out matched to the render buffer, for exactness. At 4K that is
   * another 33 MB of colour plus 16 MB of depth, and it cost the frame: 42.9 ms
   * became 219 ms, while 1080p did not move at all. Fine at low resolution and
   * catastrophic at high resolution is the signature of a memory or bandwidth
   * problem, not of the code you just wrote.
   *
   * Resolution buys nothing here anyway. The projection is independent of
   * viewport size, so a smaller target renders the same picture scaled down,
   * and the smallest part on screen is still a good ten pixels across. */
  var PICK_MAX = 1024;

  Renderer.prototype._ensurePick = function (aspect) {
    var p = this._pick;
    var w = aspect >= 1 ? PICK_MAX : Math.max(16, Math.round(PICK_MAX * aspect));
    var h = aspect >= 1 ? Math.max(16, Math.round(PICK_MAX / aspect)) : PICK_MAX;
    if (p && p.w === w && p.h === h) return p;

    var gl = this.gl;
    if (p) {
      gl.deleteFramebuffer(p.fbo); gl.deleteTexture(p.tex);
      gl.deleteRenderbuffer(p.depth);
    }
    /* Single-sampled on purpose: readPixels cannot be issued against a
     * multisampled renderbuffer, and an averaged part id would be meaningless
     * anyway — an edge pixel between part 3 and part 7 must not resolve to 5. */
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    var depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this._pick = { fbo: fbo, tex: tex, depth: depth, w: w, h: h };
    return this._pick;
  };

  Renderer.prototype.pick = function (cssX, cssY, pose) {
    var gl = this.gl;
    var rect = this._rect || this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    var t = this._ensurePick(rect.width / rect.height);

    var fx = Math.round((cssX - rect.left) / rect.width * t.w);
    // GL's origin is bottom-left; the DOM's is top-left
    var fy = Math.round((1 - (cssY - rect.top) / rect.height) * t.h);
    if (fx < 0 || fy < 0 || fx >= t.w || fy >= t.h) return -1;

    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(fx - 1, fy - 1, 3, 3);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);

    var P = this.progPick;
    gl.useProgram(P.p);
    gl.uniformMatrix4fv(P.u.uProj, false, this.proj);
    gl.uniformMatrix4fv(P.u.uView, false, this.view);
    gl.uniformMatrix3fv(P.u.uRot, false, this.rot);
    gl.uniform3f(P.u.uOrigin, 0, 0, 0);
    gl.uniform4fv(P.u.uPart, this.partOffsets);
    gl.uniform1f(P.u.uKnurl, pose.knurl);
    gl.uniform2f(P.u.uSolo, pose.soloPart === undefined ? -1 : pose.soloPart, pose.soloMix || 0);

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    var px = new Uint8Array(4);
    gl.readPixels(fx, fy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);

    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return px[0] === 0 ? -1 : px[0] - 1;
  };

  global.PenRenderer = Renderer;
})(window);
