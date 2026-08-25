/* Measures how much of the frame the instrument actually occupies, per chapter.
 * A hero object that reads as "lost" is usually a number problem, not a taste
 * problem, so this reports the number instead of guessing.
 * node scripts/framing.cjs [url] */
const puppeteer = require("D:/git/node_modules/puppeteer-core");
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const URL = process.argv[2] || "http://127.0.0.1:4180/";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForFunction("window.__meridian");
  await new Promise(r => setTimeout(r, 1800));

  const N = await page.evaluate(() => window.__meridian.keys);
  console.log("\n  ch   bbox w%   h%   diag%   fill%   cx     cy     clipped");
  for (let i = 0; i < N; i++) {
    await page.evaluate(x => window.__meridian.jump(x), i / (N - 1));
    await new Promise(r => setTimeout(r, 800));
    /* Hide every DOM layer before measuring. Headlines are bright pixels too,
     * and counting them would report a chapter with lots of copy as a chapter
     * with a big instrument in it. visibility keeps layout intact. */
    await page.evaluate(() => {
      window.__hidden = [...document.querySelectorAll("#scroller,.chrome,.rail,#hint,#cursor,#labels,#ink,.shade,#veil")];
      window.__hidden.forEach(e => e.style.visibility = "hidden");
      // dust spans the whole frame; leaving it on measures the dust, not the pen
      window.__meridian.setDust(0);
    });
    await new Promise(r => setTimeout(r, 260));
    const shot = (await page.screenshot({ encoding: "base64" }));
    await page.evaluate(() => {
      window.__hidden.forEach(e => e.style.visibility = "");
      window.__meridian.setDust(1);
    });

    const m = await page.evaluate(async (b64) => {
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
      // the void sits near 8-14; anything clearly above it is the instrument
      const THRESH = 34;
      for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        const o = (py * w + px) * 4;
        const l = Math.max(d[o], d[o + 1], d[o + 2]);
        if (l > THRESH) {
          lit++;
          if (px < minx) minx = px; if (px > maxx) maxx = px;
          if (py < miny) miny = py; if (py > maxy) maxy = py;
        }
      }
      if (maxx < 0) return null;
      const bw = (maxx - minx + 1) / w, bh = (maxy - miny + 1) / h;
      return {
        bw, bh,
        diag: Math.hypot(bw, bh) / Math.SQRT2,
        fill: lit / (w * h),
        cx: (minx + maxx) / 2 / w,
        cy: (miny + maxy) / 2 / h,
        clipped: (minx <= 0 ? "L" : "") + (maxx >= w - 1 ? "R" : "") +
                 (miny <= 0 ? "T" : "") + (maxy >= h - 1 ? "B" : "")
      };
    }, shot);
    if (!m) { console.log("  " + i + "    (nothing lit)"); continue; }
    const pct = v => (v * 100).toFixed(1).padStart(5);
    console.log("  " + i + "   " + pct(m.bw) + " " + pct(m.bh) + "  " + pct(m.diag) +
      "  " + pct(m.fill) + "  " + m.cx.toFixed(2) + "  " + m.cy.toFixed(2) +
      "   " + (m.clipped || "-"));
  }
  console.log("");
  await browser.close();
})().catch(e => { console.error("HARNESS:", e.message); process.exit(2); });
