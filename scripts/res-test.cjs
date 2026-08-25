/* How large a backing store can this machine actually drive at 60fps?
 * The page caps DPR at 1.5 by default; this raises the cap so the real
 * resolution ceiling is a measurement rather than an assumption.
 * node scripts/res-test.cjs [url] */
const puppeteer = require("D:/git/node_modules/puppeteer-core");
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const URL = process.argv[2] || "http://127.0.0.1:4180/";

/* deviceScaleFactor is what actually moves window.devicePixelRatio, and the
 * page takes min(dprCap, devicePixelRatio). Measurement is taken while the
 * scroll is at rest so the adaptive resolution settles back to 1.0 and the
 * number reflects the resolution named, not a downscaled version of it. */
const CASES = [
  { w: 1600, h: 950, dsf: 1, cap: 1.0, label: "1600x950     (laptop)" },
  { w: 1920, h: 1080, dsf: 1, cap: 1.0, label: "1920x1080    (1080p)" },
  { w: 1920, h: 1080, dsf: 1.5, cap: 1.5, label: "2880x1620    (page default cap)" },
  { w: 2560, h: 1440, dsf: 1, cap: 1.0, label: "2560x1440    (1440p)" },
  { w: 1920, h: 1080, dsf: 2, cap: 2.0, label: "3840x2160    (true 4K)" }
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--use-gl=angle"]
  });
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  console.log("\n  target                            buffer        median   p95    jank");
  for (const c of CASES) {
    await page.setViewport({ width: c.w, height: c.h, deviceScaleFactor: c.dsf });
    await page.goto(URL, { waitUntil: "load" });
    await page.waitForFunction("window.__meridian");
    await new Promise(r => setTimeout(r, 1600));
    const r = await page.evaluate(async (cap) => {
      window.__app.renderer.dprCap = cap;
      window.__app.perfScale = 1;               // do not let adaptive res hide the cost
      window.__meridian.jump(0.16);
      await new Promise(r => setTimeout(r, 500));
      for (let i = 0; i < 110; i++) {           // warm up past shader compilation
        await new Promise(r => requestAnimationFrame(r));
        window.__app.perfScale = 1;
      }
      const ts = []; let last = performance.now();
      for (let i = 0; i < 120; i++) {
        await new Promise(r => requestAnimationFrame(r));
        const now = performance.now(); ts.push(now - last); last = now;
        window.__app.perfScale = 1;
      }
      ts.sort((a, b) => a - b);
      const s = window.__meridian.state;
      return {
        buffer: s.buffer.join("x"),
        median: +ts[60].toFixed(1),
        p95: +ts[114].toFixed(1),
        jank: +(ts.filter(t => t > 32).length / ts.length * 100).toFixed(0)
      };
    }, c.cap);
    console.log("  " + c.label.padEnd(33), r.buffer.padEnd(13),
      String(r.median).padStart(6), String(r.p95).padStart(6), String(r.jank).padStart(5) + "%");
  }
  console.log("");
  await browser.close();
})().catch(e => { console.error("HARNESS:", e.message); process.exit(2); });
