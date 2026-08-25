/* Quick runtime probe: does it boot, is it error-free, what does it report?
 * node scripts/smoke.cjs [url] */
const puppeteer = require("D:/git/node_modules/puppeteer-core");
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const URL = process.argv[2] || "http://127.0.0.1:4180/";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle"]
  });
  const page = await browser.newPage();
  const errors = [], failed = [], logs = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") logs.push("CONSOLE: " + m.text()); });
  page.on("requestfailed", r => failed.push("REQFAIL: " + r.url() + " " + (r.failure() || {}).errorText));

  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: "load", timeout: 30000 });
  await new Promise(r => setTimeout(r, 2600));

  const state = await page.evaluate(() => (window.__meridian ? window.__meridian.state : { missing: true }));
  const fonts = await page.evaluate(() => document.fonts.check('700 100px Archivo'));
  const geo = await page.evaluate(() => {
    if (!window.PenGeometry) return null;
    const m = window.PenGeometry.build();
    return { tris: m.triangles, verts: m.vcount, idx: m.idx.length };
  });

  console.log("state:", JSON.stringify(state, null, 1));
  console.log("archivo loaded:", fonts);
  console.log("geometry:", JSON.stringify(geo));
  console.log("errors:", errors.length, errors.slice(0, 8));
  console.log("consoleErrors:", logs.length, logs.slice(0, 8));
  console.log("requestFailed:", failed.length, failed.slice(0, 8));

  await browser.close();
  process.exit(errors.length || logs.length ? 1 : 0);
})().catch(e => { console.error("HARNESS:", e.message); process.exit(2); });
