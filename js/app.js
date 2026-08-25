/* MERIDIAN ONE — control loop.
 *
 * One target, one current, one progress. Wheel, touch, keys, drag, pointer
 * parallax and the debug surface all write into the same value, and DOM copy,
 * camera, ink and HUD are all read out of it inside the same animation frame.
 * There is no second easing system, no Lenis and no ScrollTrigger — every
 * reference site in this class owns its own scroll, and so does this one.
 */
(function (global) {
  "use strict";

  var TAU = Math.PI * 2;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function smoothRange(a, b, t) { return smoothstep((t - a) / (b - a)); }

  /* ---------------------------------------------------------------- chapters
   * Camera keys. Lateral eye position is keyed as deliberately as depth: a
   * camera that only moves in Z will fly through the instrument it just left.
   */
  var KEYS = [
    // 0 hero
    { rotY: 0.00 * Math.PI, rotX: 0.00, rotZ: 0.13, camZ: 384, fov: 26, focusY: 0, panX: -46, panY: 0, explode: 0, cutaway: 0, knurl: 0.16, led: 0.15, bloom: 0.55, ink: 0.0 },
    // 1 the line — pen held high and right so the nib clears the headline it is
    //   drawing under, instead of cutting through the word "milliseconds"
    { rotY: 0.85 * Math.PI, rotX: 0.06, rotZ: 1.31, camZ: 248, fov: 29, focusY: -6, panX: -34, panY: -19, explode: 0, cutaway: 0, knurl: 0.16, led: 0.40, bloom: 0.72, ink: 1.0 },
    // 2 material macro — framed on the JUNCTION, where knurled aluminium meets the
    //   brass band meets the brushed barrel. A wall of knurl shows no material story.
    { rotY: 1.70 * Math.PI, rotX: 0.02, rotZ: 0.09, camZ: 86, fov: 24, focusY: -20, panX: -14, panY: 0, explode: 0, cutaway: 0, knurl: 0.20, led: 0.00, bloom: 0.42, ink: 0.0 },
    // 3 inside — the shell opens along a wedge and the stack is visible
    { rotY: 2.42 * Math.PI, rotX: 0.05, rotZ: 0.11, camZ: 350, fov: 26, focusY: -2, panX: -40, panY: 0, explode: 0, cutaway: 1, knurl: 0.16, led: 0.30, bloom: 0.50, ink: 0.0 },
    // 4 exploded — pulled back far enough that the whole separated assembly and
    //   its top and bottom labels stay inside the frame
    { rotY: 3.24 * Math.PI, rotX: 0.10, rotZ: 0.62, camZ: 700, fov: 26, focusY: 0, panX: -18, panY: -2, explode: 1, cutaway: 0, knurl: 0.16, led: 0.65, bloom: 0.58, ink: 0.0 },
    // 5 pressure
    { rotY: 4.05 * Math.PI, rotX: 0.05, rotZ: 1.14, camZ: 210, fov: 27, focusY: 4, panX: 37, panY: 0, explode: 0, cutaway: 0, knurl: 0.16, led: 1.00, bloom: 0.80, ink: 0.0 },
    // 6 specifications
    { rotY: 4.80 * Math.PI, rotX: 0.02, rotZ: 0.17, camZ: 344, fov: 25, focusY: 0, panX: -52, panY: 0, explode: 0, cutaway: 0, knurl: 0.16, led: 0.45, bloom: 0.50, ink: 0.35 },
    // 7 order
    { rotY: 5.60 * Math.PI, rotX: 0.00, rotZ: 0.10, camZ: 302, fov: 24, focusY: 0, panX: -34, panY: 0, explode: 0, cutaway: 0, knurl: 0.16, led: 0.85, bloom: 0.66, ink: 0.0 }
  ];

  /* Exploded-view displacement in millimetres along the pen's own axes.
   * Shell parts stack apart along the barrel; the internals pull out sideways
   * so the stack that was hidden inside is the thing you actually see. */
  var EXPLODE = [
    [0, -84, 0],    // 0 tip
    [0, -56, 0],    // 1 nib cone
    [0, -22, 0],    // 2 grip
    [0, 6, 0],    // 3 band
    [0, 40, 0],    // 4 barrel
    [0, 88, 0],    // 5 top
    [30, 88, 0],    // 6 clip
    [-40, -64, 0],  // 7 sensor
    [-40, -18, 0],  // 8 PCB
    [-40, 32, 0],   // 9 cell
    [-38, 80, 0]    // 10 USB-C port
  ];

  /* label anchors in pen-local space, per part */
  var LABELS = [
    { part: 0, at: [0, -69, 0], name: "Tip", spec: "POM 0.6 mm", inner: 0 },
    { part: 1, at: [0, -62, 0], name: "Nib cone", spec: "Turned steel", inner: 0 },
    { part: 2, at: [0, -36, 0], name: "Grip", spec: "Knurled 6061", inner: 0 },
    { part: 3, at: [0, -15, 0], name: "Band", spec: "Engraved brass", inner: 0 },
    { part: 4, at: [0, 25, 0], name: "Barrel", spec: "Brushed anodise", inner: 0 },
    { part: 5, at: [0, 72, 0], name: "Cap", spec: "Status ring", inner: 0 },
    { part: 6, at: [7, 62, 0], name: "Clip", spec: "Spring steel", inner: 0 },
    { part: 7, at: [0, -58, 0], name: "Sensor", spec: "8192 levels", inner: 1 },
    { part: 8, at: [0, -22, 0], name: "Board", spec: "240 Hz radio", inner: 1 },
    { part: 9, at: [0, 26, 0], name: "Cell", spec: "14 h, USB-C", inner: 1 },
    { part: 10, at: [0, 60, 0], name: "Port", spec: "45 min charge", inner: 1 }
  ];

  /* Deep detail, one entry per part, keyed by the same index the mesh carries.
   *
   * This is the payload behind clicking a piece in the exploded view. The
   * label on the canvas can only afford two words; this is the rest of it.
   * Every figure here is consistent with the numbers the chapters quote, so a
   * visitor who reads both does not catch the product contradicting itself. */
  var PARTS = [
    { name: "Elastomer tip",  sub: "Wear item · replaceable",
      body: "A 0.6 mm POM cone over a sprung core. It is the only part that touches glass, so it is the only part meant to wear out — it unscrews by hand and the pack of three ships in the box.",
      spec: [["Material", "POM copolymer"], ["Contact", "0.6 mm"], ["Travel", "0.35 mm"], ["Rated", "1,200 km of line"]] },
    { name: "Nib cone",       sub: "Load path",
      body: "Turned from one piece of stainless and threaded to the grip. Its only job is to carry the load from the tip into the sensor without flexing: any give here shows up as latency you can feel but cannot measure.",
      spec: [["Material", "303 stainless"], ["Finish", "Bead blast"], ["Runout", "0.01 mm"], ["Thread", "M6 × 0.5"]] },
    { name: "Grip section",   sub: "Knurled 6061",
      body: "Diamond knurl cut at 24 teeth around, deep enough to hold with dry hands and shallow enough not to print on your fingers after an hour. Hard anodised after cutting, so the ridges are ceramic rather than bare aluminium.",
      spec: [["Material", "6061-T6"], ["Knurl", "24 × diamond"], ["Depth", "0.22 mm"], ["Finish", "Type III anodise"]] },
    { name: "Index band",     sub: "Engraved brass",
      body: "The one warm surface on the instrument, and the only part that is not structural. It is turned brass, engraved rather than printed, and it will darken with handling — the mark is cut deep enough to survive that.",
      spec: [["Material", "CZ121 brass"], ["Mark", "Cut 40 µm"], ["Width", "9 mm"], ["Patina", "Unlacquered"]] },
    { name: "Barrel",         sub: "Brushed anodise",
      body: "Turned from a single billet, brushed along the axis, then anodised. Wall thickness is set by the radio, not by stiffness: too much metal around the antenna and the link budget collapses at the far end of a desk.",
      spec: [["Material", "6061-T6"], ["Wall", "0.9 mm"], ["Length", "61 mm"], ["Brush", "Axial, 320 grit"]] },
    { name: "Cap",            sub: "Status ring",
      body: "Closes the barrel and carries the light pipe for the ring. The LED underneath is off in normal use — it exists for charge state and pairing, and it fades rather than blinks, because a blinking light on a desk is a thing you end up covering with tape.",
      spec: [["Material", "6061-T6"], ["Ring", "Diffused PMMA"], ["Output", "0.4 – 8 mcd"], ["Seal", "IPX4"]] },
    { name: "Pocket clip",    sub: "Spring steel",
      body: "Formed from 0.6 mm spring steel and pinned, not glued, so it can be replaced. Sprung for about 3 mm of opening, which is a shirt pocket and a notebook cover and nothing thicker.",
      spec: [["Material", "301 spring steel"], ["Thickness", "0.6 mm"], ["Opening", "3.0 mm"], ["Cycles", "> 20,000"]] },
    { name: "Pressure sensor",sub: "8192 levels",
      body: "A strain gauge bridge reading the tip's 0.35 mm of travel. Eight thousand levels sounds like marketing until you draw a slow taper: at 1024 the line steps, and once you have seen it step you cannot stop seeing it.",
      spec: [["Levels", "8,192"], ["Travel", "0.35 mm"], ["Initial force", "3 g"], ["Drift", "< 0.4 % / °C"]] },
    { name: "Logic board",    sub: "240 Hz radio",
      body: "A four-layer board carrying the MCU, the radio and the tilt sensor. It reports at 240 Hz, which is the number that sets the two millisecond figure on the first screen — everything else in the chain is faster than the report interval.",
      spec: [["Report rate", "240 Hz"], ["Latency", "2.0 ms"], ["Tilt", "60° / 0.5°"], ["Link", "BLE 5.3"]] },
    { name: "Cell",           sub: "14 h, USB-C",
      body: "A 120 mAh lithium cell sized for a working day rather than for a spec sheet. It sits behind the board so the mass lands just above the grip, which is what makes the pen balance in the hand instead of in the drawing.",
      spec: [["Capacity", "120 mAh"], ["Runtime", "14 h"], ["Standby", "60 days"], ["Cycles", "500 to 80 %"]] },
    { name: "USB-C port",     sub: "45 min charge",
      body: "Charge only, no data: the pen pairs over the radio and updates over the radio, so the port is one less thing to seal against the desk. Fifteen minutes returns a full working day.",
      spec: [["Connector", "USB-C 2.0"], ["Input", "5 V / 0.5 A"], ["Full charge", "45 min"], ["Quick", "15 min → 9 h"]] }
  ];

  function App() {
    this.canvas = document.getElementById("stage");

    this.scroller = document.getElementById("scroller");
    this.chapters = Array.prototype.slice.call(document.querySelectorAll(".chapter"));
    this.railFill = document.getElementById("railFill");
    this.chapterNum = document.getElementById("chapterNum");
    this.chapterName = document.getElementById("chapterName");
    this.cursor = document.getElementById("cursor");
    this.labelLayer = document.getElementById("labels");
    this.pad = document.getElementById("pad");
    this.padLevel = document.getElementById("padLevel");
    this.padPeak = document.getElementById("padPeak");
    this.hint = document.getElementById("hint");

    this.target = 0;
    this.current = 0;
    this.maxY = 1;
    this.progress = 0;
    this.velocity = 0;

    this.dragging = false;
    this.dragY = 0; this.dragX = 0;
    this.dragVel = 0;
    this.lastDragT = 0;
    this.px = 0; this.py = 0;          // pointer parallax, smoothed
    this.pxT = 0; this.pyT = 0;

    this.reveal = 0;
    this.startT = 0;
    this.frameTimes = [];
    this.renderScale = 1;
    this.reduced = global.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.pose = {
      rotX: 0, rotY: 0, rotZ: 0, camZ: 340, fov: 26,
      focusY: 0, panX: 0, panY: 0, knurl: 0.16, led: 0,
      reveal: 0, cut: 0, bloom: 0.5,
      parts: [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]]
    };

    /* Exploded-view interaction.
     *   hover  what the cursor is over right now, and how lit it is
     *   sel    which part the inspector is showing (-1 = none)
     *   mix    0..1 transition into the inspector
     *   spin   free-orbit angle inside the inspector
     */
    this.hoverPart = -1;
    this.hoverAmt = 0;
    this.sel = -1;
    this.selMix = 0;
    this.selTarget = 0;
    this.spin = 0;
    this.autoSpin = true;
    this.exitAccum = 0;
    this._lastPick = 0;

    this.ready = false;
    this.error = null;
  }

  App.prototype.init = function () {
    var self = this;

    try {
      this.renderer = new PenRenderer(this.canvas);
    } catch (e) {
      this.error = e.message;
      document.body.classList.add("no-webgl");
      console.error(e);
      return;
    }

    this.ink = new PenInk();
    this.splitHeadlines();
    this.buildLabels();
    this.buildPanel();
    this.measure();

    global.addEventListener("resize", function () { self.measure(); }, { passive: true });

    /* -- single input hub -- */
    global.addEventListener("wheel", function (e) {
      /* Only a stroke in progress blocks the scroll. Blocking it whenever the
       * pointer merely hovers the pad trapped the visitor on that chapter. */
      if (self.padDrawing) return;
      e.preventDefault();
      /* Inside the inspector the wheel is an exit, not a scroll. Locking the
       * scroll outright would be a trap on any device without a visible close
       * control; letting one notch fall through would fire it by accident. A
       * short threshold is the only version that is neither. */
      if (self.sel >= 0) {
        self.exitAccum += Math.abs(e.deltaY) * (e.deltaMode === 1 ? 18 : 1);
        if (self.exitAccum > 130) self.closePart();
        return;
      }
      self.target = clamp(self.target + e.deltaY * (e.deltaMode === 1 ? 18 : 1), 0, self.maxY);
    }, { passive: false });

    var touchY = 0;
    global.addEventListener("touchstart", function (e) {
      touchY = e.touches[0].clientY;
    }, { passive: true });
    global.addEventListener("touchmove", function (e) {
      if (self.padDrawing) return;
      var y = e.touches[0].clientY;
      if (self.sel >= 0) {
        /* On touch the same gesture turns the part, so only a decisive flick
         * closes the inspector. */
        self.exitAccum += Math.abs(touchY - y);
        touchY = y;
        if (self.exitAccum > 190) self.closePart();
        return;
      }
      self.target = clamp(self.target + (touchY - y) * 2.1, 0, self.maxY);
      touchY = y;
      e.preventDefault();
    }, { passive: false });

    global.addEventListener("keydown", function (e) {
      var step = global.innerHeight * 0.72;
      var k = e.key;
      if (self.sel >= 0) {
        if (k === "Escape") { self.closePart(); e.preventDefault(); return; }
        // arrows turn the part instead of moving the page
        if (k === "ArrowLeft") { self.dragY -= 0.22; self.lastDragT = performance.now(); e.preventDefault(); return; }
        if (k === "ArrowRight") { self.dragY += 0.22; self.lastDragT = performance.now(); e.preventDefault(); return; }
        if (k === "ArrowUp" || k === "ArrowDown" || k === " ") { e.preventDefault(); return; }
      }
      if (k === "ArrowDown" || k === "PageDown" || k === " ") { self.target = clamp(self.target + step, 0, self.maxY); e.preventDefault(); }
      else if (k === "ArrowUp" || k === "PageUp") { self.target = clamp(self.target - step, 0, self.maxY); e.preventDefault(); }
      else if (k === "Home") { self.target = 0; e.preventDefault(); }
      else if (k === "End") { self.target = self.maxY; e.preventDefault(); }
    });

    /* -- drag to orbit: the instrument is a thing you can pick up -- */
    var lastX = 0, lastY = 0, downX = 0, downY = 0, downT = 0;
    this.canvas.addEventListener("pointerdown", function (e) {
      self.dragging = true; lastX = e.clientX; lastY = e.clientY;
      downX = e.clientX; downY = e.clientY; downT = performance.now();
      self.canvas.setPointerCapture(e.pointerId);
      document.body.classList.add("grabbing");
      if (self.hint) self.hint.classList.add("used");
    });
    this.canvas.addEventListener("pointerup", function (e) {
      self.dragging = false;
      document.body.classList.remove("grabbing");
      try { self.canvas.releasePointerCapture(e.pointerId); } catch (_) { }

      /* The canvas is already a drag surface, so a click has to be recognised
       * as a drag that did not happen: a short press that barely moved. Doing
       * it on pointerup rather than on click keeps it working with pointer
       * capture and with touch. */
      var moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved > 6 || performance.now() - downT > 700) return;
      if (self.sel >= 0) return;                 // inside the inspector, taps turn
      if (!self.partsPickable()) return;
      var hit = self.renderer.pick(e.clientX, e.clientY, self.pose);
      if (hit >= 0) self.openPart(hit);
    });
    this.canvas.addEventListener("pointercancel", function () {
      self.dragging = false; document.body.classList.remove("grabbing");
    });

    global.addEventListener("pointermove", function (e) {
      var w = global.innerWidth, h = global.innerHeight;
      self.pxT = (e.clientX / w - 0.5) * 2;
      self.pyT = (e.clientY / h - 0.5) * 2;
      if (self.cursor) {
        self.cursor.style.transform = "translate3d(" + e.clientX + "px," + e.clientY + "px,0)";
      }
      if (self.dragging) {
        self.dragY += (e.clientX - lastX) * 0.0068;
        self.dragX += (e.clientY - lastY) * 0.0034;
        self.dragX = clamp(self.dragX, -0.55, 0.55);
        lastX = e.clientX; lastY = e.clientY;
        self.lastDragT = performance.now();
        if (self.sel >= 0) self.autoSpin = false;   // taking the wheel stops the turntable
      }
      /* Ask for a hover pick. It is not taken here: readPixels stalls the
       * pipeline until the GPU has caught up, so running one per pointermove
       * would hand the frame budget to the mouse. frame() takes at most one
       * every 90 ms, which is faster than anyone can move between two parts. */
      self.wantPick = { x: e.clientX, y: e.clientY };
    }, { passive: true });

    /* -- pressure pad -- */
    if (this.pad) {
      this.pad.addEventListener("pointerenter", function () { self.padActive = true; });
      this.pad.addEventListener("pointerleave", function () { self.padActive = false; });
      this.pad.addEventListener("pointerdown", function (e) {
        self.padDrawing = true;
        self.ink.clear();
        self.pad.setPointerCapture(e.pointerId);
      });
      this.pad.addEventListener("pointerup", function () { self.padDrawing = false; });
      this.pad.addEventListener("pointermove", function (e) {
        if (!self.padDrawing) return;
        /* Pointer capture keeps delivering moves after the cursor leaves the
         * pad, so without clamping a stroke can run off across the page. */
        var r = self.pad.getBoundingClientRect();
        var x = clamp(e.clientX, r.left + 2, r.right - 2);
        var y = clamp(e.clientY, r.top + 2, r.bottom - 2);
        self.ink.push(x, y, performance.now());
      });
    }

    this.exposeDebug();
    this.ready = true;
    this.startT = performance.now();
    requestAnimationFrame(function (t) { self.frame(t); });

    document.body.classList.remove("is-loading");
  };


  /* ---- typographic reveal --------------------------------------------------
   * Headlines are split into per-character spans inside per-line masks, so the
   * letters rise out from behind a hard edge instead of fading in as a block.
   * The stagger is a CSS transition-delay rather than a per-frame JS animation:
   * it costs nothing in the render loop and it cannot fall out of sync with it.
   */
  App.prototype.splitHeadlines = function () {
    var heads = document.querySelectorAll(".chapter h1, .chapter h2");
    for (var h = 0; h < heads.length; h++) {
      var el = heads[h];
      if (el.getAttribute("data-split")) continue;
      var nodes = Array.prototype.slice.call(el.childNodes);
      var lines = [[]], trailing = [];
      for (var n = 0; n < nodes.length; n++) {
        var node = nodes[n];
        if (node.nodeType === 3) {
          var txt = node.textContent.replace(/\s+/g, " ");
          for (var c = 0; c < txt.length; c++) lines[lines.length - 1].push(txt[c]);
        } else if (node.nodeName === "BR") {
          lines.push([]);
        } else if (node.classList && node.classList.contains("one")) {
          trailing.push(node);            // the hero's ONE is a block: keep it whole
        } else {
          lines[lines.length - 1].push(node);
        }
      }
      el.innerHTML = "";
      var i = 0;
      for (var L = 0; L < lines.length; L++) {
        if (!lines[L].length) continue;
        var ln = document.createElement("span");
        ln.className = "ln";
        /* The mask is per WORD, not per line. Characters are inline-block, so a
         * per-line mask lets the browser break between any two letters and the
         * headline wraps as "milli / eco / nd". Grouping each word in its own
         * nowrap, overflow-hidden box keeps words intact AND survives a line
         * that has to wrap on a narrow viewport, which a line-level mask would
         * simply clip. */
        var wd = null;
        for (var k = 0; k < lines[L].length; k++) {
          var item = lines[L][k];
          if (item === " ") { ln.appendChild(document.createTextNode(" ")); wd = null; continue; }
          if (!wd) { wd = document.createElement("span"); wd.className = "wd"; ln.appendChild(wd); }
          var sp = document.createElement("span");
          sp.className = "ch";
          sp.style.setProperty("--i", i++);
          if (typeof item === "string") sp.textContent = item;
          else sp.appendChild(item);
          wd.appendChild(sp);
        }
        el.appendChild(ln);
      }
      for (var t = 0; t < trailing.length; t++) el.appendChild(trailing[t]);
      el.setAttribute("data-split", "1");
    }

    // stagger the spec rows off the same mechanism
    var rows = document.querySelectorAll(".spec div, .meta span");
    for (var r = 0; r < rows.length; r++) rows[r].style.setProperty("--i", r);
  };

  /* Figures count up when their chapter arrives. The value in the DOM is the
   * source of truth, so the markup still reads correctly with JS disabled. */
  App.prototype.countUp = function (chapter) {
    var els = chapter.querySelectorAll(".figure b, .price");
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        if (el.__target === undefined) el.__target = el.textContent;
        var raw = el.__target;
        var m = raw.match(/([d,]+(?:.d+)?)/);
        if (!m) return;
        var digits = m[1].replace(/,/g, "");
        var dp = (digits.split(".")[1] || "").length;
        var end = parseFloat(digits);
        var grouped = m[1].indexOf(",") >= 0;
        if (!isFinite(end)) return;
        var t0 = performance.now(), dur = 900;
        function step(now) {
          var t = Math.min(1, (now - t0) / dur);
          var e = 1 - Math.pow(1 - t, 3);
          var v = (end * e).toFixed(dp);
          if (grouped) v = Number(v).toLocaleString("en-US");
          el.textContent = raw.replace(m[1], v);
          if (t < 1) requestAnimationFrame(step);
          else el.textContent = raw;
        }
        requestAnimationFrame(step);
      })(els[i]);
    }
  };

  App.prototype.measure = function () {
    var vh = global.innerHeight;
    this.maxY = (KEYS.length - 1) * vh * 1.08;
    this.target = clamp(this.target, 0, this.maxY);
    this.ink.resize();
    this.portrait = global.innerWidth < 860;
    document.body.classList.toggle("portrait", !!this.portrait);
    this.cacheChapterBoxes();
  };

  /* Chapter blocks are fixed-position and only shift by the small --o
   * enter/exit offset, so their boxes are measured on resize rather than per
   * frame. The padding absorbs that offset. */
  App.prototype.cacheChapterBoxes = function () {
    var self = this;
    var read = function () {
      self.chapterBoxes = self.chapters.map(function (el) {
        var r = el.getBoundingClientRect();
        if (r.width < 2) return null;
        return { l: r.left - 16, r: r.right + 16, t: r.top - 46, b: r.bottom + 46 };
      });
      /* The pick hint is fixed furniture that sits exactly where the tip
       * label wants to be. Rather than moving it to some other corner a
       * label will also want, it joins the same guard the chapter copy uses:
       * whatever projects onto it stands down. */
      var ph = document.getElementById("pickHint");
      if (ph) {
        var pr = ph.getBoundingClientRect();
        self.pickHintBox = pr.width > 2
          ? { l: pr.left - 14, r: pr.right + 14, t: pr.top - 10, b: pr.bottom + 10 }
          : null;
      }
    };
    read();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(read);
    requestAnimationFrame(read);
  };

  App.prototype.buildLabels = function () {
    if (!this.labelLayer) return;
    var html = "";
    for (var i = 0; i < LABELS.length; i++) {
      html += '<div class="lbl" data-i="' + i + '">' +
        '<i></i><b>' + LABELS[i].name + '</b><s>' + LABELS[i].spec + '</s></div>';
    }
    this.labelLayer.innerHTML = html;
    this.labelEls = Array.prototype.slice.call(this.labelLayer.querySelectorAll(".lbl"));
    /* Measure once. Reading offsetWidth per frame would force layout on every
     * label every frame, and these boxes do not change after the fonts land. */
    this.labelSizes = this.labelEls.map(function (el) {
      return { w: el.offsetWidth || 150, h: el.offsetHeight || 34 };
    });
    var self = this;
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        self.labelSizes = self.labelEls.map(function (el) {
          return { w: el.offsetWidth || 150, h: el.offsetHeight || 34 };
        });
      });
    }
  };

  /* ------------------------------------------------------- part inspector */

  /* Parts are only clickable once the assembly has actually come apart. While
   * it is still one object, "click a part" has no meaning on screen and a hit
   * would land on whatever happens to be in front. */
  App.prototype.partsPickable = function () {
    return this.sel < 0 && (this.pose.cut || 0) > 0.35;
  };

  App.prototype.buildPanel = function () {
    this.panel = document.getElementById("partPanel");
    if (!this.panel) return;
    var self = this;
    this.ppName = document.getElementById("ppName");
    this.ppSub = document.getElementById("ppSub");
    this.ppBody = document.getElementById("ppBody");
    this.ppSpec = document.getElementById("ppSpec");
    this.ppIdx = document.getElementById("ppIdx");
    var close = document.getElementById("partClose");
    if (close) close.addEventListener("click", function () { self.closePart(); });

    /* The labels are the other way in. On a touch screen they are a far bigger
     * target than the part itself, and they are real buttons, so this is also
     * the keyboard route to the same content. */
    if (this.labelEls) {
      this.labelEls.forEach(function (el, i) {
        el.setAttribute("role", "button");
        el.setAttribute("tabindex", "0");
        var open = function (ev) { ev.preventDefault(); ev.stopPropagation(); self.openPart(LABELS[i].part); };
        el.addEventListener("click", open);
        el.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter" || ev.key === " ") open(ev);
        });
      });
    }
  };

  App.prototype.openPart = function (k) {
    if (k < 0 || k > 10 || !PARTS[k]) return;
    this.sel = k;
    this._lastSel = k;
    this.selTarget = 1;
    this.exitAccum = 0;
    this.autoSpin = true;
    this.spin = 0;
    /* Start the turntable from wherever the visitor was already looking, so
     * the part does not snap to a canonical angle the instant it is chosen. */
    this.dragY = 0; this.dragX = 0;
    this.hoverPart = -1;

    var d = PARTS[k];
    if (this.ppName) this.ppName.textContent = d.name;
    if (this.ppSub) this.ppSub.textContent = d.sub;
    if (this.ppBody) this.ppBody.textContent = d.body;
    if (this.ppIdx) this.ppIdx.textContent = "Part " + String(k + 1).padStart(2, "0") + " / 11";
    if (this.ppSpec) {
      var h = "";
      for (var i = 0; i < d.spec.length; i++) {
        h += "<div><dt>" + d.spec[i][0] + "</dt><dd>" + d.spec[i][1] + "</dd></div>";
      }
      this.ppSpec.innerHTML = h;
    }
    if (this.panel) this.panel.setAttribute("aria-hidden", "false");
    document.body.classList.add("inspecting");
  };

  App.prototype.closePart = function () {
    if (this.sel < 0) return;
    this.sel = -1;
    this.selTarget = 0;
    this.exitAccum = 0;
    this.dragY = 0; this.dragX = 0;
    if (this.panel) this.panel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("inspecting");
  };

  /* interpolate the camera keys at an arbitrary progress */
  App.prototype.poseAt = function (p, now) {
    var f = p * (KEYS.length - 1);
    var a = Math.min(KEYS.length - 1, Math.floor(f));
    var b = Math.min(KEYS.length - 1, a + 1);
    var u = smoothstep(f - a);
    var A = KEYS[a], B = KEYS[b];
    var pose = this.pose;

    var breath = this.reduced ? 0 : Math.sin(now * 0.00042) * 0.5 + 0.5;
    var settle = 1 - clamp(Math.abs(f - Math.round(f)) * 2.2, 0, 1);

    pose.rotY = lerp(A.rotY, B.rotY, u) + this.dragY + (this.reduced ? 0 : now * 0.000035);
    pose.rotX = lerp(A.rotX, B.rotX, u) + this.dragX + this.py * 0.05;
    pose.rotZ = lerp(A.rotZ, B.rotZ, u);
    pose.fov = lerp(A.fov, B.fov, u);
    pose.focusY = lerp(A.focusY, B.focusY, u);
    pose.panY = lerp(A.panY, B.panY, u) + this.py * 5.5;

    var baseZ = lerp(A.camZ, B.camZ, u);
    pose.camZ = baseZ - settle * breath * baseZ * 0.020;      // breathing dolly
    pose.panX = lerp(A.panX, B.panX, u) + this.px * 9.0;

    pose.knurl = lerp(A.knurl, B.knurl, u);
    pose.led = lerp(A.led, B.led, u);
    pose.bloom = lerp(A.bloom, B.bloom, u);
    pose.reveal = this.reveal;
    pose.dust = (this.dustScale === undefined ? 1 : this.dustScale) * 0.85;

    pose.cutaway = lerp(A.cutaway || 0, B.cutaway || 0, u);
    /* Keep the wedge pointing at the camera whatever the pen is doing. The
     * rotation is Ry with rx=rz~0, under which an object-space bearing t
     * lands at world bearing t - rotY, so t = rotY + PI/2 puts the opening
     * on the +Z side, which is where the viewer is. Because it tracks rotY it
     * stays open even while the visitor is dragging the pen around. */
    pose.cutAngle = pose.rotY + Math.PI * 0.5;

    var ex = lerp(A.explode, B.explode, u);
    pose.cut = ex;
    for (var i = 0; i < 11; i++) {
      var e = EXPLODE[i];
      /* Staggered: each part starts leaving a little after the one before it,
       * so the assembly comes apart as a sequence rather than as one puff. */
      var lead = i * 0.045;
      var ei = smoothstep((ex - lead) / (1 - lead * 0.8));
      var wob = this.reduced ? 0 : Math.sin(now * 0.0009 + i * 1.7) * 1.1 * ei;
      pose.parts[i][0] = e[0] * ei;
      pose.parts[i][1] = e[1] * ei + wob;
      pose.parts[i][2] = e[2] * ei;
    }

    /* Portrait is a different composition, not a smaller one. The copy owns the
     * lower field, so the instrument is lifted into the upper field, the camera
     * pulls back for the narrower frame, and the lateral offset is reduced
     * because there is no room for it. */
    if (this.portrait) {
      /* Measured, not guessed: at camZ ~260 and 27 deg the frame is about
       * 125 mm tall, and the instrument was landing with its centre at 58% of
       * frame height, straight through the paragraph. Lifting the eye by 72 mm
       * tilts the camera enough to put it at roughly a quarter height, which
       * leaves the bottom half clear for copy. */
      pose.panY -= 96;
      pose.camZ *= 1.72;
      pose.panX *= 0.30;
    }

    pose.inkAmount = lerp(A.ink, B.ink, u);
    pose.chapterFloat = f;

    pose.hoverPart = this.hoverPart;
    pose.hoverAmt = this.hoverAmt;
    pose.soloPart = -1;
    pose.soloMix = 0;
    pose.exposure = 1;

    /* ---- inspector -------------------------------------------------------
     * Everything above still runs: the chapter pose is the state the inspector
     * blends OUT of, so closing it lands the visitor back exactly where they
     * were rather than snapping to a keyframe. */
    if (this.sel >= 0 || this.selMix > 0.001) {
      var k = this._lastSel || 0;
      var m = smoothstep(this.selMix);
      var bounds = (this.renderer.mesh.partBounds || [])[k] || { c: [0, 0, 0], r: 20 };

      /* Camera distance is DERIVED from the part's bounding sphere, not keyed.
       * Eleven hand-tuned distances would be eleven things to re-tune the next
       * time the profile changes, and the tip is twenty times smaller than the
       * barrel — no single number frames both. */
      var half = pose.fov * Math.PI / 360;
      /* 1/margin is the fraction of frame height the part's bounding sphere
       * fills. 2.10 left the barrel occupying 47% of the frame, which reads
       * as a thumbnail rather than as an inspection. A bounding SPHERE is
       * rotation-invariant, so filling it tightly is safe: no angle of the
       * turntable can push a corner out of frame. */
      var margin = this.portrait ? 2.30 : 1.62;
      var need = Math.max(26, bounds.r / Math.tan(half) * margin);

      pose.camZ = lerp(pose.camZ, need, m);
      /* The panel owns the right edge on a wide screen and the lower field on
       * a narrow one, so the part is pushed clear of it rather than centred
       * under it. Positive panX swings the eye right, which reads as the
       * object moving left. */
      pose.panX = lerp(pose.panX, this.portrait ? 0 : need * 0.150, m);
      /* Portrait lifts the part clear of the sheet by moving the look-at
       * point BELOW it and the eye up by the same amount, so the camera
       * stays level and the part is not viewed from above.
       *
       * The lift is an ANGLE, not a fraction of the camera distance. Both
       * scale together, so a flat fraction looks correct for one part and
       * throws the next one off the top of the screen — which is exactly
       * what 0.200 did to the squat brass band. Screen offset, as a
       * fraction of half the frame, is (lift / camZ) / tan(halfFov); 0.46
       * puts the centre at 27% down, which clears both the wordmark above
       * and the sheet below. */
      var lift = need * 0.46 * Math.tan(half);
      /* Portrait lifts the part by moving the look-at point BELOW it and the
       * eye up by the same amount: the camera stays level, so the part is
       * raised clear of the sheet without being viewed from above. */
      pose.panY = lerp(pose.panY, this.portrait ? lift : 0, m);
      pose.focusY = lerp(pose.focusY, this.portrait ? -lift : 0, m);
      /* A long thin part stood dead upright is a sliver on a wide screen.
       * Laying it on the diagonal uses the frame the object actually has,
       * and the tilt is chosen from the part's own proportions rather than
       * applied to everything: a squat part looks wrong on a slant. */
      var sz = bounds.size || [10, 10, 10];
      var slim = sz[1] / Math.max(1e-3, Math.max(sz[0], sz[2]));
      var tilt = slim > 2.2 ? 0.66 : 0.16;
      pose.rotZ = lerp(pose.rotZ, tilt, m);
      pose.rotX = lerp(pose.rotX, this.dragX + 0.10, m);
      pose.rotY = lerp(pose.rotY, this.spin + this.dragY, m);

      pose.cutaway = pose.cutaway * (1 - m);
      pose.inkAmount = pose.inkAmount * (1 - m);
      pose.led = lerp(pose.led, 0.55, m);
      pose.bloom = lerp(pose.bloom, 0.44, m);
      pose.dust *= (1 - m * 0.6);
      pose.knurl = lerp(pose.knurl, 0.24, m);   // a little deeper when this close
      pose.exposure = 1 + 0.40 * m;

      for (var s = 0; s < 11; s++) {
        if (s === k) {
          // bring the chosen part's own centroid to the origin
          pose.parts[s][0] = lerp(pose.parts[s][0], -bounds.c[0], m);
          pose.parts[s][1] = lerp(pose.parts[s][1], -bounds.c[1], m);
          pose.parts[s][2] = lerp(pose.parts[s][2], -bounds.c[2], m);
        } else {
          /* The rest clear out along the line away from the chosen part, so
           * the assembly visibly opens up around it. They are culled outright
           * once m passes 0.995 (see SCENE_VS), this is only the journey. */
          var dx = EXPLODE[s][0] - EXPLODE[k][0];
          var dy = EXPLODE[s][1] - EXPLODE[k][1];
          var dz = EXPLODE[s][2] - EXPLODE[k][2] + 0.001;
          var dl = Math.hypot(dx, dy, dz) || 1;
          pose.parts[s][0] += (dx / dl) * 900 * m;
          pose.parts[s][1] += (dy / dl) * 900 * m;
          pose.parts[s][2] += (dz / dl) * 900 * m;
        }
      }
      pose.soloPart = k;
      pose.soloMix = m;
      pose.hoverPart = -1;
    }

    return pose;
  };

  App.prototype.updateChapters = function (p) {
    var f = p * (KEYS.length - 1);
    for (var i = 0; i < this.chapters.length; i++) {
      var el = this.chapters[i];
      var centre = parseFloat(el.getAttribute("data-c"));
      var d = Math.abs(f - centre);
      var t = clamp(1 - d, 0, 1);
      var vis = smoothRange(0.52, 0.94, t);          // exit before enter
      var dir = f > centre ? -1 : 1;
      el.style.opacity = vis.toFixed(3);
      el.style.setProperty("--o", (dir * (1 - vis) * 34).toFixed(2) + "px");
      var isIn = vis > 0.55;
      if (isIn !== (el.__in === true)) {
        el.__in = isIn;
        el.classList.toggle("in", isIn);
        if (isIn) this.countUp(el);
      }
      el.style.pointerEvents = vis > 0.55 ? "auto" : "none";
      el.setAttribute("aria-hidden", vis > 0.4 ? "false" : "true");
    }
    var idx = clamp(Math.round(f), 0, KEYS.length - 1);
    if (this._idx !== idx) {
      this._idx = idx;
      var el2 = this.chapters[idx];
      if (this.chapterNum) this.chapterNum.textContent = String(idx + 1).padStart(2, "0");
      if (this.chapterName && el2) this.chapterName.textContent = el2.getAttribute("data-name") || "";
      document.body.setAttribute("data-chapter", String(idx));
    }
  };

  App.prototype.updateLabels = function (pose, ex) {
    if (!this.labelEls) return;
    var cutIn = pose.cutaway || 0;
    ex = Math.max(ex, cutIn);

    /* Labels only exist for the exploded chapter. Bailing out here means six of
     * the seven chapters do no label work at all, instead of paying for a guard
     * that has nothing to guard. */
    if (ex < 0.06) {
      if (this._labelsShown) {
        for (var z = 0; z < this.labelEls.length; z++) this.labelEls[z].style.opacity = "0";
        this._labelsShown = false;
      }
      return;
    }
    this._labelsShown = true;

    /* A label is placed by 3D projection, so nothing stops it landing on top of
     * the chapter copy at a viewport we did not anticipate. Rather than tuning
     * positions per breakpoint, any label that projects into the live copy block
     * simply stands down. The boxes are cached from measure(): reading them per
     * frame, right after writing chapter styles, forces a layout every frame. */
    var guard = null;
    var boxes = this.chapterBoxes || [];
    for (var c = 0; c < this.chapters.length; c++) {
      if (parseFloat(this.chapters[c].style.opacity || 0) <= 0.25) continue;
      var box = boxes[c];
      if (!box) continue;
      if (!guard) guard = { l: box.l, r: box.r, t: box.t, b: box.b };
      else {            // union, so a mid-crossfade frame is still protected
        guard.l = Math.min(guard.l, box.l); guard.r = Math.max(guard.r, box.r);
        guard.t = Math.min(guard.t, box.t); guard.b = Math.max(guard.b, box.b);
      }
    }

    /* The hint is checked as its OWN box, not folded into the union above.
     * Unioning a block on the left with a strip at the bottom centre makes a
     * rectangle covering most of the frame, and five labels that had nothing
     * to collide with stood down. */
    var hintBox = (this.pickHintBox &&
      document.body.getAttribute("data-chapter") === "4" && this.sel < 0)
      ? this.pickHintBox : null;

    var placed = hintBox ? [hintBox] : [];
    for (var i = 0; i < this.labelEls.length; i++) {
      var el = this.labelEls[i];
      if (ex < 0.06) { el.style.opacity = "0"; continue; }
      var L = LABELS[i];
      /* Two label sets share one layer. The cutaway names what is inside; the
       * exploded view names the pieces. Showing both at once is noise. */
      var want = L.inner ? cutIn : (pose.cut || 0);
      if (want < 0.06) { el.style.opacity = "0"; continue; }
      var pt = this.renderer.projectPoint(L.at, L.part, pose);
      if (!pt) { el.style.opacity = "0"; continue; }

      var blocked = !!(guard &&
        pt.x > guard.l && pt.x < guard.r && pt.y > guard.t && pt.y < guard.b);

      /* Projection can put a label past the edge of the frame, where it renders
       * half cut off. Suppress rather than clamp: a label dragged back inside
       * would no longer point at the part it names. */
      var sz0 = (this.labelSizes && this.labelSizes[i]) || { w: 150, h: 34 };
      if (pt.x < 4 || pt.x + sz0.w > global.innerWidth - 4 ||
          pt.y < 4 || pt.y + sz0.h > global.innerHeight - 4) blocked = true;

      /* Labels are placed by projection, so on a narrow screen two parts can
       * land close enough that their labels stack. Earlier labels win and the
       * crowded one stands down rather than printing over its neighbour. */
      var sz = (this.labelSizes && this.labelSizes[i]) || { w: 150, h: 34 };
      var box = { l: pt.x, r: pt.x + sz.w, t: pt.y, b: pt.y + sz.h };
      if (!blocked) {
        for (var q = 0; q < placed.length; q++) {
          var o = placed[q];
          if (box.l < o.r + 8 && box.r + 8 > o.l && box.t < o.b + 4 && box.b + 4 > o.t) {
            blocked = true; break;
          }
        }
      }
      if (!blocked) placed.push(box);

      el.style.transform = "translate3d(" + pt.x.toFixed(1) + "px," + pt.y.toFixed(1) + "px,0)";
      el.style.opacity = blocked ? "0" : (want * 0.96).toFixed(3);
    }
  };

  /* Hover feedback for the exploded view.
   *
   * The pick itself is a GPU readback, which stalls the pipeline until the
   * card has finished the frame, so it is rate limited hard. 90 ms is far
   * below the ~200 ms it takes a hand to move between two parts, and well
   * above the cost of the stall. Between picks the highlight is eased in JS,
   * so the response still looks continuous. */
  App.prototype.updateHover = function (now, pose) {
    /* Never pick while the page is moving. Nobody can target a part that is
     * flying across the frame, and a readback issued mid-scroll spends the
     * frame budget stalling on a result that is stale by the time it lands. */
    var live = this.sel < 0 && (pose.cut || 0) > 0.35 &&
               this.selMix < 0.02 && this.velocity < 40;

    if (live && this.wantPick && now - this._lastPick > 90) {
      this._lastPick = now;
      var w = this.wantPick;
      this.wantPick = null;
      var hit = this.renderer.pick(w.x, w.y, pose);
      if (hit !== this.hoverPart) {
        this.hoverPart = hit;
        document.body.classList.toggle("over-part", hit >= 0);
      }
    } else if (!live && this.hoverPart !== -1) {
      this.hoverPart = -1;
      document.body.classList.remove("over-part");
    }

    var want = this.hoverPart >= 0 ? 1 : 0;
    this.hoverAmt += (want - this.hoverAmt) * (this.reduced ? 0.4 : 0.16);
    if (this.hoverAmt < 0.002) this.hoverAmt = 0;
  };

  App.prototype.frame = function (now) {
    var self = this;
    requestAnimationFrame(function (t) { self.frame(t); });
    if (!this.ready) return;

    var t0 = performance.now();

    /* one lerp, one progress */
    var delta = this.target - this.current;
    var ease = this.reduced ? 0.28 : 0.088;
    this.velocity = Math.abs(delta);
    this.current = Math.abs(delta) > 0.06 ? this.current + delta * ease : this.target;
    var p = this.maxY > 0 ? this.current / this.maxY : 0;
    this.progress = p;

    /* pointer parallax and drag decay share the same clock as everything else */
    this.px += (this.pxT - this.px) * 0.06;
    this.py += (this.pyT - this.py) * 0.06;
    if (!this.dragging && now - this.lastDragT > 900) {
      this.dragY *= 0.965;
      this.dragX *= 0.955;
      if (Math.abs(this.dragY) < 0.0008) this.dragY = 0;
      if (Math.abs(this.dragX) < 0.0008) this.dragX = 0;
    }

    /* intro: the instrument resolves out of black */
    var since = now - this.startT;
    this.reveal = this.reduced ? 1 : smoothRange(160, 1500, since);

    /* ---- inspector state ----
     * The turntable resumes on its own a moment after the visitor lets go, so
     * a part they turned once does not sit dead still afterwards. */
    var selEase = this.reduced ? 0.30 : 0.085;
    this.selMix += (this.selTarget - this.selMix) * selEase;
    if (this.selMix < 0.0006 && this.selTarget === 0) this.selMix = 0;
    if (this.sel >= 0) {
      if (!this.autoSpin && now - this.lastDragT > 2400) this.autoSpin = true;
      if (this.autoSpin && !this.reduced) this.spin += 0.0042;
    }

    var pose = this.poseAt(p, now);

    /* NOTE: #scroller is deliberately NOT transformed. Its children are pinned
     * and cross-faded in place, and a transform on the parent would turn their
     * position:fixed into position:absolute and drag every chapter off screen
     * as progress grows. Chapter motion is the small per-element offset below. */
    this.updateChapters(p);

    /* adaptive resolution: drop while the scroll is fast, restore before it settles */
    var fastness = clamp(this.velocity / 220, 0, 1);
    var wanted = this.perfScale * (1 - fastness * 0.28);
    this.renderScale += (wanted - this.renderScale) * 0.2;
    this.renderer.renderScale = this.renderScale;

    /* ---- ink: the nib writes the page ----
     * Built BEFORE the render call, because the ribbon is now drawn inside the
     * same pass as the instrument rather than onto a layer above it. */
    /* On the pressure chapter the ink belongs to the visitor for as long as they
     * are there. Tying the mode to "is the button currently held" wiped the
     * stroke the instant they lifted the pointer, which is the opposite of what
     * drawing on paper does. */
    var mode = "off";
    if (this._idx === 5) mode = "pointer";
    else if (pose.inkAmount > 0.12) mode = "nib";
    this.ink.setMode(mode);

    /* The stroke persists for the whole chapter rather than trailing off after
     * a second, so what you see is a line the pen has actually drawn and left
     * behind. It is wiped on a chapter change so it cannot leak into the next
     * composition. */
    if (this._inkChapter !== this._idx) { this._inkChapter = this._idx; this.ink.clear(); }

    if (mode === "nib") {
      var tip = this.renderer.projectTip(pose);
      if (tip) this.ink.push(tip.x, tip.y, now);
    }
    var verts = this.ink.build(now, {
      life: mode === "pointer" ? 14000 : 9000,
      color: mode === "pointer" ? [1.00, 0.84, 0.59] : [0.94, 0.73, 0.45],
      scale: mode === "pointer" ? 1.6 : (0.85 + pose.inkAmount * 1.0)
    });
    pose.inkVerts = verts;
    pose.inkData = verts > 1 ? this.ink.data : null;
    pose.inkColor = this.ink.color;

    this.renderer.render(pose, now * 0.001);

    if (this.padLevel && mode === "pointer") {
      this.padLevel.textContent = String(this.ink.level()).padStart(4, "0");
      this.padPeak.style.transform = "scaleX(" + this.ink.pressure.toFixed(3) + ")";
    }

    this.updateLabels(pose, pose.cut * (1 - this.selMix));
    this.updateHover(now, pose);

    if (this.railFill) this.railFill.style.transform = "scaleY(" + p.toFixed(4) + ")";

    /* Frame-time watchdog.
     *
     * This has to measure the gap BETWEEN frames, not the duration of the work
     * inside one. WebGL draw calls return immediately and the GPU finishes
     * later, so timing the callback body reports a comfortable couple of
     * milliseconds on a card that is actually managing eight frames a second,
     * and the resolution would never come down when it most needs to.
     * Measured on the target GT 710: 1920x1080 holds 16.7 ms, 3840x2160 is
     * 125 ms. Only the inter-frame delta can tell those apart.
     */
    var delta = this._lastFrame ? now - this._lastFrame : 16.7;
    this._lastFrame = now;
    if (delta < 200) {                    // ignore tab-switch and debugger gaps
      this.frameTimes.push(delta);
      if (this.frameTimes.length > 50) {
        this.frameTimes.shift();
        var sorted = this.frameTimes.slice().sort(function (a, b) { return a - b; });
        var med = sorted[sorted.length >> 1];
        this.frameMedian = med;
        if (med > 21 && this.perfScale > 0.5) this.perfScale -= 0.05;
        else if (med < 17.6 && this.perfScale < 1) this.perfScale += 0.02;
        this.perfScale = clamp(this.perfScale, 0.5, 1);
      }
    }
  };

  App.prototype.perfScale = 1;

  App.prototype.exposeDebug = function () {
    var self = this;
    global.__meridian = {
      get progress() { return self.progress; },
      scrollTo: function (p) { self.target = clamp(p, 0, 1) * self.maxY; },
      jump: function (p) { self.target = self.current = clamp(p, 0, 1) * self.maxY; },
      get state() {
        var r = self.renderer;
        return {
          progress: self.progress,
          chapter: self._idx,
          drawCalls: r.drawCalls,
          triangles: r.mesh.triangles,
          vertices: r.mesh.verts,
          buffer: [r.bufW, r.bufH],
          aspect: r.aspect,
          dprCap: r.dprCap,
          renderScale: +self.renderScale.toFixed(3),
          perfScale: +self.perfScale.toFixed(3),
          frameMedian: self.frameMedian ? +self.frameMedian.toFixed(1) : null,
          samples: r.samples,
          reveal: +self.reveal.toFixed(3),
          inkMode: self.ink.mode,
          inkPoints: self.ink.pts.length,
          dragY: +self.dragY.toFixed(3),
          reduced: self.reduced,
          error: self.error
        };
      },
      /* Measurement hook. The dust field covers the whole frame, so any tool
       * that measures "how much of the frame does the instrument occupy" has
       * to be able to switch it off first or it just measures the dust. */
      setDust: function (v) { self.dustScale = v; },
      setDrag: function (y, x) { self.dragY = y || 0; self.dragX = x || 0; self.lastDragT = performance.now(); },
      /* Inspector hooks, for QA: opening by index is deterministic where a
       * synthetic click at a guessed pixel is not. */
      openPart: function (k) { self.openPart(k); },
      closePart: function () { self.closePart(); },
      pickAt: function (x, y) { return self.renderer.pick(x, y, self.pose); },
      get inspect() {
        return { sel: self.sel, mix: +self.selMix.toFixed(3), hover: self.hoverPart,
                 autoSpin: self.autoSpin, parts: 11 };
      },
      keys: KEYS.length
    };
  };

  global.addEventListener("DOMContentLoaded", function () {
    var app = new App();
    global.__app = app;
    app.init();
  });
})(window);
