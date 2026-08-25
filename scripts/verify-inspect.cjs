/* Verifies the exploded-view interaction end to end, in a real browser.
 *
 * The interesting checks are the ones an assertion on state cannot fake:
 *   - the picker agrees with the picture (pick at a projected part centre
 *     returns that part, for all eleven)
 *   - a real click at a real pixel opens the right part
 *   - once open, ONLY that part is on screen (measured from the framebuffer,
 *     not from a flag)
 *   - dragging actually turns it
 *   - every exit route works
 *
 * node scripts/verify-inspect.cjs [url]
 */
const puppeteer = require("D:/git/node_modules/puppeteer-core");
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const URL = process.argv[2] || "http://127.0.0.1:4180/";

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log("  ok   " + n + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  FAIL " + n + (extra ? "  " + extra : "")); }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle"]
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForFunction("window.__meridian && window.__meridian.inspect");
  await sleep(1600);

  console.log("\n-- exploded chapter ------------------------------------------");
  // chapter 4 of 8 keys -> progress 4/7
  await page.evaluate(() => window.__meridian.jump(4 / 7));
  await sleep(1400);

  const cut = await page.evaluate(() => window.__app.pose.cut);
  ok("assembly is separated", cut > 0.9, "cut=" + cut.toFixed(2));

  /* The picker has to agree with what is drawn. Project each part's own
   * centroid to a screen pixel, then ask the picker what is at that pixel. */
  const agree = await page.evaluate(() => {
    const app = window.__app, r = app.renderer, out = [];
    const rect = r.canvas.getBoundingClientRect();
    for (let k = 0; k < 11; k++) {
      const b = r.mesh.partBounds[k];
      const pt = r.projectPoint(b.c, k, app.pose);
      if (!pt) { out.push({ k, hit: -2 }); continue; }
      const x = pt.x + rect.left, y = pt.y + rect.top;
      out.push({ k, hit: window.__meridian.pickAt(x, y), x: Math.round(x), y: Math.round(y) });
    }
    return out;
  });
  const agreed = agree.filter(a => a.hit === a.k).length;
  ok("picker agrees with projection for all 11 parts", agreed === 11,
     agreed + "/11 " + (agreed === 11 ? "" : JSON.stringify(agree.filter(a => a.hit !== a.k))));

  ok("picker returns nothing in empty space",
     await page.evaluate(() => window.__meridian.pickAt(12, 12)) === -1);

  console.log("\n-- hover -----------------------------------------------------");
  const target = agree.find(a => a.k === 4);   // barrel: biggest, safest to hover
  await page.mouse.move(target.x, target.y);
  await sleep(420);
  const hov = await page.evaluate(() => ({
    part: window.__meridian.inspect.hover,
    cls: document.body.classList.contains("over-part"),
    amt: window.__app.hoverAmt
  }));
  ok("hovering a part registers it", hov.part === 4, "part=" + hov.part);
  ok("body gets the affordance class", hov.cls === true);
  ok("highlight strength eases up", hov.amt > 0.25, "amt=" + hov.amt.toFixed(2));

  console.log("\n-- click opens the inspector ---------------------------------");
  await page.mouse.click(target.x, target.y);
  await sleep(1500);
  let st = await page.evaluate(() => window.__meridian.inspect);
  ok("clicking a part selects it", st.sel === 4, "sel=" + st.sel);
  ok("transition completes", st.mix > 0.98, "mix=" + st.mix);

  const panel = await page.evaluate(() => {
    const p = document.getElementById("partPanel");
    const cs = getComputedStyle(p);
    return {
      shown: p.getAttribute("aria-hidden") === "false",
      opacity: +cs.opacity,
      name: document.getElementById("ppName").textContent,
      idx: document.getElementById("ppIdx").textContent,
      body: document.getElementById("ppBody").textContent.length,
      rows: document.getElementById("ppSpec").querySelectorAll("div").length,
      right: p.getBoundingClientRect().right,
      vw: innerWidth
    };
  });
  ok("panel is visible", panel.shown && panel.opacity > 0.9, "opacity=" + panel.opacity);
  ok("panel names the part that was clicked", panel.name === "Barrel", panel.name);
  ok("panel shows the part index", panel.idx === "Part 05 / 11", panel.idx);
  ok("panel carries real detail copy", panel.body > 120, panel.body + " chars");
  ok("panel lists spec rows", panel.rows === 4, panel.rows + " rows");
  ok("panel sits inside the viewport", Math.abs(panel.right - panel.vw) < 2);

  /* Measured, not asserted: hide the DOM, screenshot, and confirm the lit
   * pixels are one compact object rather than a whole exploded assembly. */
  const lit = await measure(page);
  ok("only one object is on screen", lit.frac > 0.004 && lit.frac < 0.30,
     "lit=" + (lit.frac * 100).toFixed(1) + "% bbox=" + lit.bw.toFixed(2) + "x" + lit.bh.toFixed(2));
  ok("the part fills the frame properly", lit.diag > 0.30,
     "diag=" + (lit.diag * 100).toFixed(1) + "%");
  ok("the part is clear of the panel column", lit.cx < 0.52,
     "centre x=" + lit.cx.toFixed(2));

  console.log("\n-- 360 turn --------------------------------------------------");
  const rotA = await page.evaluate(() => window.__app.pose.rotY);
  await sleep(900);
  const rotB = await page.evaluate(() => window.__app.pose.rotY);
  ok("turntable runs on its own", Math.abs(rotB - rotA) > 0.02,
     "d=" + (rotB - rotA).toFixed(3));

  await page.mouse.move(800, 500);
  await page.mouse.down();
  for (let i = 0; i < 12; i++) { await page.mouse.move(800 + i * 22, 500); await sleep(16); }
  await page.mouse.up();
  await sleep(260);
  const dragged = await page.evaluate(() => ({ y: window.__app.dragY, auto: window.__app.autoSpin }));
  ok("dragging turns the part", Math.abs(dragged.y) > 0.4, "dragY=" + dragged.y.toFixed(2));
  ok("taking the wheel stops the turntable", dragged.auto === false);
  await sleep(2700);
  ok("turntable resumes after letting go",
     await page.evaluate(() => window.__app.autoSpin) === true);

  console.log("\n-- exits -----------------------------------------------------");
  await page.keyboard.press("Escape");
  await sleep(900);
  st = await page.evaluate(() => window.__meridian.inspect);
  ok("Escape closes it", st.sel === -1 && st.mix < 0.35, "mix=" + st.mix);
  await sleep(900);
  ok("it returns to the exploded assembly",
     await page.evaluate(() => window.__app.pose.cut) > 0.9);
  ok("panel is hidden again",
     (await page.evaluate(() => document.getElementById("partPanel").getAttribute("aria-hidden"))) === "true");

  // close button
  await page.evaluate(() => window.__meridian.openPart(7));
  await sleep(1300);
  await page.click("#partClose");
  await sleep(700);
  ok("the close control closes it",
     (await page.evaluate(() => window.__meridian.inspect)).sel === -1);

  // wheel exit, and the threshold that stops one stray notch doing it
  await page.evaluate(() => window.__meridian.openPart(9));
  await sleep(1300);
  await page.mouse.wheel({ deltaY: 40 });
  await sleep(120);
  ok("one stray wheel notch does NOT close it",
     (await page.evaluate(() => window.__meridian.inspect)).sel === 9);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel({ deltaY: 90 }); await sleep(60); }
  await sleep(200);
  ok("a deliberate scroll closes it",
     (await page.evaluate(() => window.__meridian.inspect)).sel === -1);
  const prog = await page.evaluate(() => window.__meridian.progress);
  ok("the exit scroll did not also move the page", Math.abs(prog - 4 / 7) < 0.02,
     "progress=" + prog.toFixed(3));

  console.log("\n-- labels as the touch route ---------------------------------");
  await sleep(1000);
  const labelOpened = await page.evaluate(() => {
    const l = document.querySelector('#labels .lbl[data-i="2"]');
    l.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return window.__app.sel;
  });
  ok("clicking a label opens its part", labelOpened === 2, "sel=" + labelOpened);
  await page.evaluate(() => window.__meridian.closePart());
  await sleep(800);

  console.log("\n-- other chapters are unaffected ------------------------------");
  await page.evaluate(() => window.__meridian.jump(0));
  await sleep(1200);
  ok("parts are not pickable on the hero", await page.evaluate(() => window.__app.partsPickable()) === false);
  const heroClick = await page.evaluate(() => {
    const r = window.__app.renderer.canvas.getBoundingClientRect();
    return window.__meridian.pickAt(r.left + r.width * 0.42, r.top + r.height * 0.5);
  });
  ok("the picker still works, it is the gate that is closed", heroClick >= -1);

  console.log("\n-- portrait ---------------------------------------------------");
  await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 1 });
  await sleep(600);
  await page.evaluate(() => window.__meridian.jump(4 / 7));
  await sleep(1200);
  await page.evaluate(() => window.__meridian.openPart(8));
  await sleep(1500);
  const port = await page.evaluate(() => {
    const p = document.getElementById("partPanel").getBoundingClientRect();
    return { top: p.top, bottom: p.bottom, w: p.width, vh: innerHeight, vw: innerWidth,
             scrollW: document.documentElement.scrollWidth };
  });
  ok("portrait panel is a bottom sheet", port.w > port.vw - 2 && port.bottom <= port.vh + 2,
     "w=" + port.w.toFixed(0) + " bottom=" + port.bottom.toFixed(0));
  ok("no horizontal overflow in portrait", port.scrollW <= port.vw + 1,
     port.scrollW + " vs " + port.vw);
  const litP = await measure(page);
  ok("the part sits entirely above the sheet", litP.bottom < port.top / port.vh,
     "part bottom=" + litP.bottom.toFixed(2) + " sheet top=" + (port.top / port.vh).toFixed(2));
  ok("the part is not clipped by the top edge", litP.top > 0.04,
     "part top=" + litP.top.toFixed(2));

  console.log("\n-- runtime ----------------------------------------------------");
  ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  const draws = await page.evaluate(() => window.__meridian.state.drawCalls);
  // 7 is the ceiling (instrument, dust, ink, 3 bloom, composite); the ink call
  // is only issued on the chapters that use it, so 6 here is correct.
  ok("draw calls stay within budget", draws >= 5 && draws <= 7, "draws=" + draws);

  await browser.close();
  console.log("\n  " + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS:", e.message); process.exit(2); });

/* hide every DOM layer, screenshot, and report where the lit pixels are */
async function measure(page) {
  await page.evaluate(() => {
    window.__h = [...document.querySelectorAll("#scroller,.chrome,.rail,#hint,#cursor,#labels,#partPanel,#pickHint,.shade,#veil")];
    window.__h.forEach(e => e.style.visibility = "hidden");
    window.__meridian.setDust(0);
  });
  await new Promise(r => setTimeout(r, 260));
  const shot = await page.screenshot({ encoding: "base64" });
  await page.evaluate(() => {
    window.__h.forEach(e => e.style.visibility = "");
    window.__meridian.setDust(1);
  });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const w = 200, h = Math.round(200 * img.height / img.width);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1, lit = 0;
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const o = (py * w + px) * 4;
      if (Math.max(d[o], d[o + 1], d[o + 2]) > 34) {
        lit++;
        if (px < minx) minx = px; if (px > maxx) maxx = px;
        if (py < miny) miny = py; if (py > maxy) maxy = py;
      }
    }
    if (maxx < 0) return { frac: 0, bw: 0, bh: 0, diag: 0, cy: 0 };
    const bw = (maxx - minx + 1) / w, bh = (maxy - miny + 1) / h;
    return { frac: lit / (w * h), bw, bh,
             diag: Math.hypot(bw, bh) / Math.SQRT2,
             cx: (minx + maxx) / 2 / w,
             cy: (miny + maxy) / 2 / h,
             bottom: (maxy + 1) / h, top: miny / h };
  }, shot);
}
