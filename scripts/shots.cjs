/* Visual checkpoints. node scripts/shots.cjs [outDir] [url]
 * Captures every chapter centre plus the boundaries between them, because a
 * boundary is where two headlines and two camera keys can collide. */
const puppeteer = require("D:/git/node_modules/puppeteer-core");
const fs = require("fs");
const path = require("path");
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";

const OUT = path.resolve(process.argv[2] || "qa");
const URL = process.argv[3] || "http://127.0.0.1:4180/";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle"]
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 2200));

  const N = await page.evaluate(() => window.__meridian.keys);
  const stops = [];
  for (let i = 0; i < N; i++) {
    stops.push({ p: i / (N - 1), tag: "c" + i });
    if (i < N - 1) stops.push({ p: (i + 0.5) / (N - 1), tag: "b" + i + (i + 1) });
  }

  for (const s of stops) {
    await page.evaluate(p => window.__meridian.jump(p), s.p);
    await new Promise(r => setTimeout(r, 900));
    const file = path.join(OUT, s.tag + "-" + Math.round(s.p * 100) + ".png");
    await page.screenshot({ path: file });
    const st = await page.evaluate(() => window.__meridian.state);
    console.log(s.tag.padEnd(6), "p=" + s.p.toFixed(3),
      "draws=" + st.drawCalls, "aspect=" + st.aspect.toFixed(4),
      "scale=" + st.renderScale, "ink=" + st.inkMode);
  }
  console.log("pageerrors:", errors.length, errors.slice(0, 5));
  await browser.close();
})().catch(e => { console.error("HARNESS:", e.message); process.exit(2); });
