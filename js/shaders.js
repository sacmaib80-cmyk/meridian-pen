/* MERIDIAN ONE — GLSL ES 3.00 shader sources.
 *
 * Lighting is image-based, from a studio cubemap that js/env.js generates at
 * startup and prefilters into a roughness mip chain. The map is authored in
 * VIEW space, so the lights stay fixed to the camera while the instrument turns,
 * exactly as a turntable in a real studio behaves.
 *
 * There is still no environment image FILE: the cubemap is painted in code. What
 * changed is that roughness is now resolved by the mip chain rather than by a
 * hand-tuned pow() exponent, which is what makes the metal read correctly at
 * every roughness instead of only at the two the exponent was tuned for.
 *
 * Detail is layered by frequency, per the material reference:
 *   macro   silhouette + zone materials
 *   meso    knurl diamonds, band turning grooves, engraved wordmark
 *   micro   axial brush streaks, micro-scratches, anodise grain
 *   response anisotropic specular, clearcoat, fresnel rim, cavity occlusion
 */
(function (global) {
  "use strict";

  var COMMON = [
    "const float PI = 3.14159265359;",
    "const float TAU = 6.28318530718;",
    "float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }",
    "float hash21(vec2 p){ vec3 q = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));",
    "  q += dot(q, q.yzx+33.33); return fract((q.x+q.y)*q.z); }",
    "float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);",
    "  float a=hash21(i), b=hash21(i+vec2(1,0)), c=hash21(i+vec2(0,1)), d=hash21(i+vec2(1,1));",
    "  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }"
  ].join("\n");

  /* ------------------------------------------------------------------ scene */

  var SCENE_VS = [
    "#version 300 es",
    "precision highp float;",
    "in vec3 aPos;",
    "in vec3 aNormal;",
    "in vec2 aUV;",
    "in vec2 aMeta;",
    "",
    "uniform mat4 uProj;",
    "uniform mat4 uView;",
    "uniform mat3 uRot;",         // pen orientation
    "uniform vec3 uOrigin;",      // pen position in view-target space
    "uniform vec4 uPart[11];",     // exploded offsets: xyz = mm along pen axes, w = spare
    "uniform float uKnurl;",      // knurl displacement amplitude (mm)
    "uniform vec2 uSolo;",        // x = part being inspected (-1 = none), y = 0..1 mix
    "",
    "out vec3 vViewPos;",
    "out vec3 vViewNrm;",
    "out vec3 vViewAxial;",       // pen +Y in view space
    "out vec3 vViewCirc;",        // circumferential tangent in view space
    "out vec2 vUV;",
    "out float vZone;",
    "out float vPart;",
    "out vec3 vLocal;",
    COMMON,
    "",
    "float knurlHeight(float u, float y){",
    "  float A = u*TAU*24.0;",
    "  float B = y*3.74;",
    "  float h = sin(A+B)*sin(A-B);",
    "  return pow(h*0.5+0.5, 1.9);",
    "}",
    "",
    "void main(){",
    "  vZone = aMeta.x; vPart = aMeta.y;",
    "  vec3 p = aPos;",
    "  vec3 n = aNormal;",
    "",
    "  // knurl displaces real geometry so the SILHOUETTE is scalloped, not just the shading",
    "  if (aMeta.x > 1.5 && aMeta.x < 2.5) {",
    "    float h = knurlHeight(aUV.x, aUV.y);",
    "    float band = smoothstep(26.6,28.4,aUV.y) * (1.0 - smoothstep(53.4,55.6,aUV.y));",
    "    p += n * (h - 0.5) * uKnurl * band;",
    "  }",
    "",
    "  vLocal = p;",
    "  int pi = int(aMeta.y + 0.5);",
    "  vec3 off = uPart[pi].xyz;",
    "  vec3 world = uRot * (p + off) + uOrigin;",
    "  vec4 vp = uView * vec4(world, 1.0);",
    "  vViewPos = vp.xyz;",
    "",
    "  mat3 nv = mat3(uView) * uRot;",
    "  vViewNrm  = normalize(nv * n);",
    "  vViewAxial = normalize(nv * vec3(0.0,1.0,0.0));",
    "  vec3 circ = normalize(vec3(-p.z, 0.0, p.x) + vec3(1e-5));",
    "  vViewCirc = normalize(nv * circ);",
    "  vUV = aUV;",
    "  gl_Position = uProj * vp;",
    "",
    "  /* Inspector. Everything except the chosen part is thrown clear of the",
    "   * clip volume once the transition has finished, which costs nothing at",
    "   * all: those vertices are discarded before rasterisation, so there is no",
    "   * fragment work and no blending order to get wrong. During the",
    "   * transition they are still drawn, and app.js is flying them out of",
    "   * frame, so the assembly visibly scatters rather than blinking away. */",
    "  if (uSolo.x >= 0.0 && abs(aMeta.y - uSolo.x) > 0.5 && uSolo.y > 0.995) {",
    "    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);",
    "  }",
    "}"
  ].join("\n");

  var SCENE_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec3 vViewPos;",
    "in vec3 vViewNrm;",
    "in vec3 vViewAxial;",
    "in vec3 vViewCirc;",
    "in vec2 vUV;",
    "in float vZone;",
    "in float vPart;",
    "in vec3 vLocal;",
    "out vec4 oColor;",
    "",
    "uniform sampler2D uMark;",   // generated engraving atlas
    "uniform samplerCube uEnv;",  // procedural studio, prefiltered by roughness
    "uniform float uEnvMaxLod;",
    "uniform float uTime;",
    "uniform float uLed;",        // LED ring intensity 0..1
    "uniform float uReveal;",     // 0 = matte blackout, 1 = full studio
    "uniform float uCut;",
    "uniform float uCutaway;",   // 0 = sealed, 1 = wedge fully open
    "uniform vec2 uHover;",      // x = part under the cursor (-1 = none), y = strength
    "uniform float uInside;",   // 1 while a lone shell part is being inspected
    "uniform float uCutAngle;",  // object-space bearing the wedge is centred on        // cutaway reveal for the exploded chapter
    COMMON,
    "",
    "",
    "",
    // Karis split-sum approximation. The prefiltered cube supplies the incoming
    // light; this supplies how much of it a surface of this roughness actually
    // reflects toward the eye. Without it, rough metal comes out too bright and
    // grazing angles blow out.
    "vec3 envBRDF(vec3 f0, float rough, float ndv){",
    "  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);",
    "  const vec4 c1 = vec4( 1.0,  0.0425,  1.040, -0.04);",
    "  vec4 r = rough * c0 + c1;",
    "  float a004 = min(r.x*r.x, exp2(-9.28*ndv))*r.x + r.y;",
    "  vec2 ab = vec2(-1.04, 1.04)*a004 + r.zw;",
    "  return f0*ab.x + ab.y;",
    "}",
    "",
    "// squash the reflection along a tangent -> highlight stretches across it",
    "vec3 anisotropic(vec3 R, vec3 T, float amount){",
    "  return normalize(R - T * dot(R,T) * amount);",
    "}",
    "",
    "float knurlHeight(float u, float y){",
    "  float A = u*TAU*24.0; float B = y*3.74;",
    "  return pow(sin(A+B)*sin(A-B)*0.5+0.5, 1.9);",
    "}",
    "vec2 knurlGrad(float u, float y){",
    "  float A = u*TAU*24.0; float B = y*3.74;",
    "  float dA = TAU*24.0, dB = 3.74;",
    "  float s1 = sin(A+B), s2 = sin(A-B), c1 = cos(A+B), c2 = cos(A-B);",
    "  float raw = s1*s2;",
    "  float dU = (c1*dA*s2 + s1*c2*dA);",
    "  float dY = (c1*dB*s2 - s1*c2*dB);",
    "  float k = 1.9*pow(max(raw*0.5+0.5,1e-4),0.55)*0.5;",
    "  return vec2(dU,dY)*k;",
    "}",
    "",
    "void main(){",
    "  int zone = int(vZone + 0.5);",
    "",
    "  /* ---- cutaway ---------------------------------------------------------",
    "   * A wedge of the outer shell is removed so the stack inside is visible.",
    "   * Three things have to happen or it reads as paper:",
    "   *   1 the wedge is discarded from the SHELL zones only",
    "   *   2 the far inside wall is now facing us, so it gets its own matte",
    "   *     material instead of being shaded as polished exterior metal",
    "   *   3 the rim of the cut is lit as bare machined aluminium, which is",
    "   *     what sells the wall as having real thickness",
    "   */",
    "  float az = atan(vLocal.z, vLocal.x);",
    "  float dAng = az - uCutAngle;",
    "  dAng = atan(sin(dAng), cos(dAng));",
    "  // 1.22 rad each side removed 140 degrees of shell and the pen stopped",
  "  // reading as a cylinder at all. 0.72 opens a clear window and leaves",
  "  // enough wall on both flanks to still see the round form.",
    "  float halfW = uCutaway * 0.72;",
    "  bool shell = (zone <= 6);",
    "  float cutEdge = 0.0;",
    "  if (uCutaway > 0.001 && shell) {",
    "    if (abs(dAng) < halfW) discard;",
    "    cutEdge = 1.0 - smoothstep(0.0, 0.085, abs(abs(dAng) - halfW));",
    "  }",
    "  vec3 N = normalize(vViewNrm);",
    "  vec3 V = normalize(-vViewPos);",
    "  vec3 T = normalize(vViewAxial);",      // brush direction
    "  vec3 C = normalize(vViewCirc);",
    "  float u = vUV.x, y = vUV.y;",
    "",
    "  vec3 albedo = vec3(0.5);",
    "  float rough = 0.35;",
    "  float metal = 1.0;",
    "  float aniso = 0.0;",
    "  vec3 anisoT = T;",
    "  float cavity = 1.0;",
    "  float clear = 0.0;",
    "  vec3 emissive = vec3(0.0);",
    "  float height = 0.0;",
    "",
    "  if (zone == 0) {",                                     // elastomer tip
    "    albedo = vec3(0.075,0.076,0.082); rough = 0.62; metal = 0.0;",
    "    height = vnoise(vec2(u*180.0, y*90.0))*0.5;",
    "    cavity = 0.86 + 0.14*height;",
    "  } else if (zone == 1) {",                              // polished steel cone
    "    albedo = vec3(0.66,0.67,0.70); rough = 0.085;",
    "    float lathe = sin(y*46.0)*0.5+0.5;",
    "    rough += lathe*0.020;",
    "    cavity = 0.94+0.06*lathe;",
    "    aniso = 0.55; anisoT = C;",                          // turned: rings around
    "  } else if (zone == 2) {",                              // knurled anodised aluminium
    "    float h = knurlHeight(u,y);",
    "    vec2 g = knurlGrad(u,y);",
    "    float band = smoothstep(26.4,28.2,y) * (1.0 - smoothstep(53.6,55.8,y));",
    "    h = mix(0.5, h, band); g *= band;",
    "    N = normalize(N - (C*g.x*0.00042 + T*g.y*0.026));",
    "    albedo = mix(vec3(0.150,0.158,0.175), vec3(0.330,0.342,0.366), h);",
    "    rough = mix(0.50, 0.31, h);",
    "    cavity = 0.42 + 0.58*h;",
    "    metal = 0.82;",
    "    height = h;",
    "  } else if (zone == 3) {",                              // engraved brass band
    "    albedo = vec3(0.86,0.68,0.38); rough = 0.13; ",
    "    float grooves = sin(y*30.0)*0.5+0.5;",
    "    rough += pow(grooves,3.0)*0.11;",
    "    cavity = 0.80+0.20*grooves;",
    "    aniso = 0.62; anisoT = C;",
    // u is flipped because the cylinder's winding runs the other way from the
    // canvas the atlas was drawn on, and v is flipped because texel row 0 is the
    // TOP of that canvas while pen-y grows upward. Without both, it reads backwards.
    "    float mark = texture(uMark, vec2(fract(1.0-u), clamp(1.0-(y-58.0)/4.6,0.0,1.0))).r;",
    "    N = normalize(N + T*(mark-0.5)*0.55);",
    "    albedo *= 1.0 - mark*0.45;",
    "    rough += mark*0.30;",
    "    cavity *= 1.0 - mark*0.42;",
    "  } else if (zone == 4) {",                              // brushed anodised barrel
    "    float brush = vnoise(vec2(u*760.0, y*1.6));",
    "    albedo = vec3(0.246,0.256,0.278) + (brush-0.5)*0.062;",
    "    rough = 0.235 + (brush-0.5)*0.075;",
    "    metal = 0.94; aniso = 0.86; anisoT = T;",            // brushed along the length
    "    clear = 0.30;",
    "    float scratch = smoothstep(0.986,1.0, vnoise(vec2(u*300.0, y*0.35)));",
    "    rough -= scratch*0.14; cavity = 1.0 - scratch*0.06;",
    "  } else if (zone == 5) {",                              // polished top ring
    "    albedo = vec3(0.70,0.71,0.74); rough = 0.075;",
    "    float g2 = sin(y*38.0)*0.5+0.5;",
    "    cavity = 0.88+0.12*g2; rough += pow(g2,4.0)*0.09;",
    "    aniso = 0.5; anisoT = C;",
    "  } else if (zone == 6) {",                              // dome + LED
    "    albedo = vec3(0.232,0.242,0.266); rough = 0.30; metal = 0.85; clear = 0.42;",
    "    float ring = smoothstep(0.9,1.0, 1.0 - abs(y-148.2)/0.62);",
    "    emissive = vec3(1.00,0.72,0.36) * ring * uLed * 2.8;",
    "    cavity *= 1.0 - ring*0.25;",
    "  } else if (zone == 8) {",                             // pressure sensor module
    "    albedo = vec3(0.115,0.118,0.126); rough = 0.52; metal = 0.20;",
    "    float ridge = sin(y*7.0)*0.5+0.5;",
    "    cavity = 0.72 + 0.28*ridge;",
    "    albedo = mix(albedo, vec3(0.55,0.56,0.60), smoothstep(26.0,28.0,y));",
    "  } else if (zone == 9) {",                              // PCB
    "    albedo = vec3(0.030,0.055,0.042); rough = 0.68; metal = 0.05;",
    "    float trace = step(0.62, fract(u*9.0)) * step(0.30, fract(y*0.9));",
    "    float pads  = step(0.86, fract(y*2.3)) * step(0.40, fract(u*5.0));",
    "    albedo = mix(albedo, vec3(0.78,0.62,0.26), max(trace*0.75, pads));",
    "    rough = mix(rough, 0.24, max(trace,pads));",
    "    metal = max(metal, max(trace,pads)*0.85);",
    "    cavity = 0.80 + 0.20*max(trace,pads);",
    "  } else if (zone == 10) {",                             // cell
    "    float wrap = smoothstep(84.0,86.0,y) * (1.0 - smoothstep(118.0,120.0,y));",
    "    albedo = mix(vec3(0.60,0.61,0.64), vec3(0.36,0.20,0.10), wrap);",
    "    rough = mix(0.16, 0.44, wrap); metal = mix(0.92, 0.30, wrap);",
    "    aniso = 0.55; anisoT = C;",
    "    cavity = 0.88 + 0.12*(1.0-wrap);",
    "  } else if (zone == 11) {",                             // USB-C port shell
    "    albedo = vec3(0.68,0.69,0.72); rough = 0.10;",
    "    float slot = 1.0 - smoothstep(0.0,0.30, abs(fract(y*0.5)-0.5));",
    "    albedo *= 1.0 - slot*0.72; cavity = 0.70 + 0.30*(1.0-slot);",
    "  } else {",                                            // clip: polished steel
    "    albedo = vec3(0.72,0.73,0.76); rough = 0.055;",
    "    aniso = 0.30; anisoT = T;",
    "    cavity = 0.92;",
    "  }",
    "",
    "  // fresnel-weighted reflection",
    "  vec3 R0 = reflect(-V, N);",
    "  vec3 R = R0;",
    "  if (aniso > 0.0) R = anisotropic(R, anisoT, aniso);",
    "  /* The studio is authored in VIEW space, so sampling the cube with a",
    "   * view-space reflection keeps the lights fixed to the camera while the pen",
    "   * turns, which is exactly what a turntable in a real studio does. */",
    "  vec3 spec = textureLod(uEnv, R, rough * uEnvMaxLod).rgb;",
    "",
    "  float ndv = max(dot(N,V), 0.0);",
    "  float fres = pow(1.0 - ndv, 5.0);",
    "  vec3 f0 = mix(vec3(0.045), albedo, metal);",
    "  vec3 F = envBRDF(f0, rough, ndv);",
    "",
    "  // diffuse term only matters for the non-metal zones",
    // studio() is the single most expensive thing in this shader, so it runs
    // once for the specular and only again where it can actually be seen. The
    // diffuse term is weighted by (1-metal) and most of this pen IS metal, so
    // for those zones a full evaluation would be multiplied away to nothing.
    "  vec3 color = vec3(0.0);",
    "  if (metal < 0.97) {",
    "    color = albedo * textureLod(uEnv, N, uEnvMaxLod).rgb * (1.0 - metal) * 1.55;",
    "  }",
    "  color += spec * F;",
    "",
    "  if (clear > 0.0) {",
    "    vec3 cc = textureLod(uEnv, R0, 0.05 * uEnvMaxLod).rgb;",
    "    color += cc * clear * (0.03 + 0.30*fres);",
    "  }",
    "",
    "  color *= cavity;",
    "",
    "  // edge definition against the void",
    "  float edge = pow(1.0 - ndv, 2.4);",
    "  color += vec3(0.34,0.42,0.62) * edge * 0.10;",
    "",
    "  /* the inside of the shell, revealed by the cut */",
    "  /* A shell part is an open tube. Inside the assembly its ends are",
    "   * covered by its neighbours; alone in the inspector they are not, and",
    "   * with culling on you see straight through it. Same material as the",
    "   * cutaway wall, same reason. */",
    "  if ((uCutaway > 0.001 || uInside > 0.5) && shell && !gl_FrontFacing) {",
    "    /* Bead-blasted aluminium, not cardboard: neutral grey, low gain, and a",
    "     * faint machining spiral so the wall has a direction. The warm floor",
    "     * bounce in studioIrradiance was tinting this tan, so only its green",
    "     * channel is used as a scalar. */",
    "    vec3 inner = vec3(0.088,0.092,0.100);",
    "    float wash = textureLod(uEnv, -N, uEnvMaxLod).g;",
    "    float spiral = 0.93 + 0.07*sin(y*5.2 + az*2.0);",
    "    color = inner * (0.22 + 1.15*wash) * spiral;",
    "    color += vec3(0.42,0.50,0.66) * pow(1.0-ndv, 3.0) * 0.16;",
    "  }",
    "  /* The shell is a surface with no thickness, so the wall would end in a",
    "   * hairline. Lighting the rim as bare machined aluminium is what makes the",
    "   * cut read as having gone THROUGH something. */",
    "  color = mix(color, vec3(0.90,0.91,0.94) * (1.35 + 0.9*pow(1.0-ndv,2.0)), cutEdge*0.92);",
    "",
    "  color += emissive;",
    "",
    "  // chapter reveal: the instrument resolves out of matte black",
    "  color *= mix(0.10, 1.0, uReveal);",
    "",
    "  // cutaway wash used while the assembly is separated",
    "  color = mix(color, color*vec3(0.82,0.90,1.06), uCut*0.5);",
    "",
    "  /* Hover. The part under the cursor has to answer 'this one, and it is",
    "   * clickable' without recolouring it — a tinted part stops reading as the",
    "   * material it is made of. So the read is a rim: brightest exactly at the",
    "   * silhouette, which is where the eye already is when it is picking one",
    "   * object out of eleven. */",
    "  if (uHover.x >= 0.0 && abs(vPart - uHover.x) < 0.5) {",
    "    float rim = pow(1.0 - ndv, 1.8);",
    "    color += vec3(1.00,0.80,0.52) * rim * uHover.y * 1.30;",
    "    color *= 1.0 + uHover.y * 0.14;",
    "  }",
    "",
    "  oColor = vec4(color, 1.0);",
    "}"
  ].join("\n");

  /* Part picking. The scene vertex shader is reused verbatim so the pick is
   * taken against exactly the geometry on screen — same explode offsets, same
   * knurl displacement. Reimplementing the transform here is how a picker ends
   * up disagreeing with the picture by a few pixels at the silhouette. */
  var PICK_FS = [
    "#version 300 es",
    "precision highp float;",
    "in float vPart;",
    "out vec4 oColor;",
    "void main(){",
    "  // +1 so that 0 stays reserved for 'background, nothing there'",
    "  oColor = vec4((vPart + 1.0) / 255.0, 0.0, 0.0, 1.0);",
    "}"
  ].join("\n");

  /* ------------------------------------------------------------- fullscreen */

  var QUAD_VS = [
    "#version 300 es",
    "precision highp float;",
    "out vec2 vUV;",
    "void main(){",
    "  vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2);",
    "  vUV = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);",
    "}"
  ].join("\n");

  var HIGHPASS_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 vUV; out vec4 oColor;",
    "uniform sampler2D uSrc; uniform float uThreshold; uniform float uKnee;",
    "void main(){",
    "  vec3 c = texture(uSrc, vUV).rgb;",
    "  float l = dot(c, vec3(0.2126,0.7152,0.0722));",
    "  float s = smoothstep(uThreshold, uThreshold+uKnee, l);",
    "  oColor = vec4(c*s, 1.0);",
    "}"
  ].join("\n");

  var BLUR_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 vUV; out vec4 oColor;",
    "uniform sampler2D uSrc; uniform vec2 uDir;",
    "void main(){",
    "  vec3 s = texture(uSrc, vUV).rgb * 0.2270270270;",
    "  s += texture(uSrc, vUV + uDir*1.3846153846).rgb * 0.3162162162;",
    "  s += texture(uSrc, vUV - uDir*1.3846153846).rgb * 0.3162162162;",
    "  s += texture(uSrc, vUV + uDir*3.2307692308).rgb * 0.0702702703;",
    "  s += texture(uSrc, vUV - uDir*3.2307692308).rgb * 0.0702702703;",
    "  oColor = vec4(s, 1.0);",
    "}"
  ].join("\n");

  var COMPOSITE_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 vUV; out vec4 oColor;",
    "uniform sampler2D uScene; uniform sampler2D uBloom;",
    "uniform vec2 uRes; uniform float uTime; uniform float uBloomAmt;",
    "uniform float uExposure;",
    "uniform float uVignette; uniform float uGrain;",
    COMMON,
    "",
    "vec3 aces(vec3 x){",
    "  const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;",
    "  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);",
    "}",
    "void main(){",
    "  vec3 scene = texture(uScene, vUV).rgb;",
    "  vec3 bloom = texture(uBloom, vUV).rgb;",
    "  vec3 c = scene + bloom * uBloomAmt;",
    "",
    "  // studio sweep behind the instrument: a soft, off-centre pool of light",
    "  vec2 q = (vUV - vec2(0.40,0.56)) * vec2(uRes.x/uRes.y, 1.0);",
    "  float sweep = exp(-dot(q,q)*1.55);",
    "  c += vec3(0.030,0.034,0.046) * sweep;",
    "",
    "  // the inspector lifts this: one part alone catches far less of the",
    "  // studio than the whole instrument does at a wide framing",
    "  c = aces(c * 1.22 * uExposure);",
    "",
    "  /* Grade. The reference builds all run a LUT after tone mapping; this is",
    "   * the same move done analytically. Shadows cool very slightly, highlights",
    "   * carry a trace of the brass, and a gentle S-curve puts contrast back that",
    "   * ACES flattens. Kept deliberately small: the point is that the frame",
    "   * looks graded, not that anyone can name the grade. */",
    "  float lum = dot(c, vec3(0.2126,0.7152,0.0722));",
    "  c = mix(c, c*vec3(0.955,0.980,1.045), (1.0 - smoothstep(0.0,0.42,lum)) * 0.55);",
    "  c = mix(c, c*vec3(1.045,1.010,0.955), smoothstep(0.55,1.0,lum) * 0.50);",
    "  c = clamp(c, 0.0, 1.0);",
    "  c = c*c*(3.0-2.0*c) * 0.22 + c * 0.78;",   // gentle S-curve
    "  c = mix(vec3(dot(c, vec3(0.2126,0.7152,0.0722))), c, 1.06);",
    "",
    "  vec2 v = vUV - 0.5;",
    "  c *= 1.0 - dot(v,v) * uVignette;",
    "",
    "  float g = hash21(gl_FragCoord.xy + fract(uTime)*137.0) - 0.5;",
    "  c += g * uGrain;",
    "",
    "  // ordered dither kills banding in the dark sweep",
    "  float d = hash21(gl_FragCoord.xy*0.7331) - 0.5;",
    "  c += d * (1.0/255.0);",
    "",
    "  oColor = vec4(c, 1.0);",
    "}"
  ].join("\n");


  /* ------------------------------------------------------------------- dust
   * A field of motes drifting in the studio air. This is the cheapest depth cue
   * there is: the void behind the pen stops being a flat black plane the moment
   * something is measurably in front of and behind the instrument.
   * One instanced-free gl.POINTS call, additive, depth-tested so the pen
   * genuinely occludes the motes that pass behind it.
   */
  var DUST_VS = [
    "#version 300 es",
    "precision highp float;",
    "in vec3 aSeed;",
    "in vec2 aRnd;",
    "uniform mat4 uProj;",
    "uniform mat4 uView;",
    "uniform float uTime;",
    "uniform float uSizeK;",
    "out float vBright;",
    "out float vSoft;",
    "",
    "/* Curl of an analytic potential field. Because the curl of any field is",
    " * divergence-free, particles advected by it never bunch up or thin out —",
    " * they follow smooth streams the way real motes ride air currents.",
    " * Three independent sine axes drifting at their own rate is what makes a",
    " * particle field read as mechanical, and that is the look being replaced. */",
    "vec3 curlField(vec3 p, float t){",
    "  float a = 1.00, b = 1.31, c = 0.83;",
    "  // psi = potential; the derivatives below are its analytic curl",
    "  float dPzdy = -a * sin(p.y*a + t) * cos(p.x*c);",
    "  float dPydz = -b * sin(p.z*b + t*0.83) * cos(p.y*a);",
    "  float dPxdz =  c * cos(p.z*c + t*0.61) * sin(p.x*b);",
    "  float dPzdx = -c * sin(p.x*c) * cos(p.y*a + t);",
    "  float dPydx =  b * cos(p.x*b + t*0.47) * sin(p.z*b);",
    "  float dPxdy = -a * sin(p.y*b) * cos(p.z*c + t*0.61);",
    "  return vec3(dPzdy - dPydz, dPxdz - dPzdx, dPydx - dPxdy);",
    "}",
    "",
    "void main(){",
    "  vec3 p = aSeed;",
    "  float ph = aRnd.y * 6.2831853;",
    "  // two octaves: a broad current plus a finer eddy inside it",
    "  p += curlField(aSeed * 0.0075 + ph, uTime * 0.055) * 30.0;",
    "  p += curlField(aSeed * 0.0210 + 13.7, uTime * 0.090) * 11.0;",
    "  vec4 vp = uView * vec4(p, 1.0);",
    "  gl_Position = uProj * vp;",
    "  float dist = max(1.0, -vp.z);",
    "  float px = aRnd.x * uSizeK / dist;",
    "  /* Depth of field. A mote close to the lens is a large, very soft, very",
    "   * faint disc; a distant one is a small sharp point. Uniformly crisp dots",
    "   * at every depth is the other half of why a particle field looks cheap. */",
    "  vSoft = clamp((px - 2.2) / 7.0, 0.0, 1.0);",
    "  gl_PointSize = clamp(px, 1.2, 14.0);",
    "  vec3 nd = normalize(p + vec3(0.001));",
    "  float key = clamp(dot(nd, normalize(vec3(-0.52,0.66,0.54))), 0.0, 1.0);",
    "  float lit = 0.22 + 0.78 * pow(key, 1.5);",
    "  // energy spread over a bigger disc, so soft motes do not read as blobs",
    "  vBright = lit * (1.0 - smoothstep(420.0, 1150.0, dist)) * mix(1.0, 0.22, vSoft);",
    "}"
  ].join("\n");

  var DUST_FS = [
    "#version 300 es",
    "precision highp float;",
    "in float vBright;",
    "in float vSoft;",
    "out vec4 oColor;",
    "uniform float uAmount;",
    "void main(){",
    "  vec2 d = gl_PointCoord - 0.5;",
    "  float r = length(d) * 2.0;",
    "  if (r > 1.0) discard;",
    "  // sharp motes get a tight core, defocused ones an even disc with a",
    "  // feathered rim, which is what an out-of-focus highlight actually is",
    "  float sharp = pow(1.0 - r, 2.4);",
    "  float disc  = smoothstep(1.0, 0.62, r);",
    "  float a = mix(sharp, disc, vSoft);",
    "  oColor = vec4(vec3(0.93,0.91,0.87) * a * vBright * uAmount, 1.0);",
    "}"
  ].join("\n");

  global.PenShaders = {
    SCENE_VS: SCENE_VS,
    SCENE_FS: SCENE_FS,
    QUAD_VS: QUAD_VS,
    HIGHPASS_FS: HIGHPASS_FS,
    BLUR_FS: BLUR_FS,
    COMPOSITE_FS: COMPOSITE_FS,
    DUST_VS: DUST_VS,
    DUST_FS: DUST_FS,
    PICK_FS: PICK_FS
  };
})(window);
