/* MERIDIAN ONE — procedural environment IBL.
 *
 * The reference sites (IYO, activetheory) light their products from a real
 * environment map with a roughness mip chain. That is why their metal reads
 * correctly at every roughness instead of being a hand-tuned pow() lobe.
 *
 * This builds the same thing at startup, in code, so the project still ships
 * zero image files:
 *
 *   1  paint a studio into the six faces of a float cubemap
 *   2  GGX importance-sample that into a mip chain, so mip 0 is a mirror and
 *      the last mip is effectively irradiance
 *   3  the scene samples textureLod(env, R, roughness * maxLod)
 *
 * Runtime cost goes DOWN, not up: two cube fetches replace a stack of pow()
 * and exp() calls that used to run up to three times per fragment.
 */
(function (global) {
  "use strict";

  var SIZE = 128;      // base face resolution
  var MIPS = 6;        // mip 0 mirror .. mip 5 irradiance

  /* The studio itself. Lights are rectangles with real edges, because an edge
   * is what makes a reflection read as a light with physical size rather than
   * as a smudge. A pow() lobe has no edge. */
  var STUDIO = [
    "vec3 studioRadiance(vec3 d){",
    "  vec3 c = mix(vec3(0.014,0.015,0.019), vec3(0.215,0.222,0.240),",
    "               smoothstep(-0.02, 0.92, d.y));",
    "  c += vec3(0.130,0.100,0.070) * smoothstep(0.15,-0.75, d.y) * 0.70;",
    "  // the horizon line: this is what gives polished metal its dark/light split",
    "  float horizon = 1.0 - smoothstep(0.0, 0.085, abs(d.y + 0.06));",
    "  c = mix(c, c*0.42, horizon*0.75);",
    "",
    "  // KEY — rectangular softbox, upper left, in front",
    "  vec3 kd = normalize(vec3(-0.52,0.66,0.54));",
    "  vec3 kr = normalize(cross(vec3(0.0,1.0,0.0), kd));",
    "  vec3 ku = cross(kd, kr);",
    "  float kz = dot(d, kd);",
    "  float key = 0.0;",
    "  if (kz > 0.30) {",
    "    vec2 q = vec2(dot(d,kr), dot(d,ku)) / kz;",
    "    key = (1.0 - smoothstep(0.34, 0.60, abs(q.x))) *",
    "          (1.0 - smoothstep(0.46, 0.76, abs(q.y))) *",
    "          smoothstep(0.30, 0.52, kz);",
    "  }",
    "  c += vec3(1.00,0.975,0.935) * key * 6.6;",
    "",
    "  // STRIP — tall narrow softbox, front right. On a cylinder this becomes",
    "  // the long vertical streak that reads unmistakably as machined metal.",
    "  vec3 sd = normalize(vec3(0.86,0.06,0.50));",
    "  vec3 sr = normalize(cross(vec3(0.0,1.0,0.0), sd));",
    "  vec3 su = cross(sd, sr);",
    "  float sz = dot(d, sd);",
    "  float strip = 0.0;",
    "  if (sz > 0.22) {",
    "    vec2 q = vec2(dot(d,sr), dot(d,su)) / sz;",
    "    strip = (1.0 - smoothstep(0.055, 0.16, abs(q.x))) *",
    "            (1.0 - smoothstep(1.15, 1.85, abs(q.y))) *",
    "            smoothstep(0.22, 0.45, sz);",
    "  }",
    "  c += vec3(0.98,0.99,1.00) * strip * 4.4;",
    "",
    "  // FILL — broad, dim, front-left-low. Without it the shadow side of a",
    "  // cylinder goes flat black and the form stops reading.",
    "  float fill = pow(max(0.0, dot(d, normalize(vec3(-0.62,-0.18,0.76)))), 2.0);",
    "  c += vec3(0.62,0.64,0.70) * fill * 0.42;",
    "",
    "  // RIM — cool kicker from behind right. The only cool light in the frame,",
    "  // and it only ever appears as a reflection, never as a UI colour.",
    "  float rim = pow(max(0.0, dot(d, normalize(vec3(0.44,0.30,-0.84)))), 12.0);",
    "  c += vec3(0.46,0.60,1.00) * rim * 1.15;",
    "  return c;",
    "}"
  ].join("\n");

  var FACE_DIR = [
    "vec3 faceDir(int f, vec2 uv){",
    "  vec2 t = uv * 2.0 - 1.0;",
    "  if (f == 0) return normalize(vec3( 1.0, -t.y, -t.x));",
    "  if (f == 1) return normalize(vec3(-1.0, -t.y,  t.x));",
    "  if (f == 2) return normalize(vec3( t.x,  1.0,  t.y));",
    "  if (f == 3) return normalize(vec3( t.x, -1.0, -t.y));",
    "  if (f == 4) return normalize(vec3( t.x, -t.y,  1.0));",
    "  return normalize(vec3(-t.x, -t.y, -1.0));",
    "}"
  ].join("\n");

  var FACE_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 vUV; out vec4 oColor;",
    "uniform int uFace;",
    STUDIO,
    FACE_DIR,
    "void main(){ oColor = vec4(studioRadiance(faceDir(uFace, vUV)), 1.0); }"
  ].join("\n");

  var FILTER_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 vUV; out vec4 oColor;",
    "uniform samplerCube uSrc;",
    "uniform int uFace;",
    "uniform float uRough;",
    "uniform float uSrcLod;",
    "const float PI = 3.14159265359;",
    FACE_DIR,
    "float radical(uint bits){",
    "  bits = (bits << 16u) | (bits >> 16u);",
    "  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);",
    "  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);",
    "  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);",
    "  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);",
    "  return float(bits) * 2.3283064365386963e-10;",
    "}",
    "vec3 importanceGGX(vec2 xi, vec3 N, float a){",
    "  float phi = 2.0*PI*xi.x;",
    "  float ct = sqrt((1.0-xi.y)/(1.0+(a*a-1.0)*xi.y));",
    "  float st = sqrt(max(0.0, 1.0-ct*ct));",
    "  vec3 h = vec3(st*cos(phi), st*sin(phi), ct);",
    "  vec3 upv = abs(N.z) < 0.999 ? vec3(0.0,0.0,1.0) : vec3(1.0,0.0,0.0);",
    "  vec3 tx = normalize(cross(upv, N));",
    "  return normalize(tx*h.x + cross(N,tx)*h.y + N*h.z);",
    "}",
    "void main(){",
    "  vec3 N = faceDir(uFace, vUV);",
    "  if (uRough < 0.002) { oColor = vec4(textureLod(uSrc, N, 0.0).rgb, 1.0); return; }",
    "  float a = uRough*uRough;",
    "  vec3 sum = vec3(0.0); float wsum = 0.0;",
    "  const int S = 48;",
    "  for (int i = 0; i < S; i++) {",
    "    vec2 xi = vec2(float(i)/float(S), radical(uint(i)));",
    "    vec3 H = importanceGGX(xi, N, a);",
    "    vec3 L = normalize(2.0*dot(N,H)*H - N);",
    "    float nl = max(dot(N,L), 0.0);",
    "    if (nl > 0.0) { sum += textureLod(uSrc, L, uSrcLod).rgb * nl; wsum += nl; }",
    "  }",
    "  oColor = vec4(sum / max(wsum, 1e-4), 1.0);",
    "}"
  ].join("\n");

  /* Builds the cubemap. Runs once, costs 6 + 30 draw calls at startup, and
   * nothing per frame afterwards. */
  function build(gl, quadVS, compileProgram) {
    var faceProg = compileProgram(gl, quadVS, FACE_FS, "env-face");
    var filtProg = compileProgram(gl, quadVS, FILTER_FS, "env-filter");

    var cube = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, MIPS, gl.RGBA16F, SIZE, SIZE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    var fbo = gl.createFramebuffer();
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    var FACES = [
      gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
      gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
      gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z
    ];

    // --- mip 0: paint the studio ------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.useProgram(faceProg.p);
    gl.viewport(0, 0, SIZE, SIZE);
    for (var f = 0; f < 6; f++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, FACES[f], cube, 0);
      gl.uniform1i(faceProg.u.uFace, f);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* --- mips 1..5: GGX prefilter ----------------------------------------
     * Each mip reads the mip above it rather than mip 0. The source is already
     * partially blurred, so 48 samples land far closer together than they
     * would over the full sphere, and the result is smooth instead of showing
     * the individual samples as sparkle. */
    gl.useProgram(filtProg.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube);
    gl.uniform1i(filtProg.u.uSrc, 0);
    for (var m = 1; m < MIPS; m++) {
      var size = SIZE >> m;
      var rough = m / (MIPS - 1);
      gl.viewport(0, 0, size, size);
      gl.uniform1f(filtProg.u.uRough, rough);
      gl.uniform1f(filtProg.u.uSrcLod, m - 1);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_BASE_LEVEL, m - 1);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAX_LEVEL, m - 1);
      for (var g = 0; g < 6; g++) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, FACES[g], cube, m);
        gl.uniform1i(filtProg.u.uFace, g);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAX_LEVEL, MIPS - 1);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.deleteFramebuffer(fbo);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);

    return { tex: cube, maxLod: MIPS - 1, size: SIZE };
  }

  global.PenEnv = { build: build, SIZE: SIZE, MIPS: MIPS };
})(window);
