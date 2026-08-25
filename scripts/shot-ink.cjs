/* Captures the ink motif the way a visitor actually produces it: by scrolling.
 * jump() teleports progress, so the nib never travels and never draws.
 * node scripts/shot-ink.cjs [outDir] */
const puppeteer = require("D:/git/node_modules/puppeteer-core");
const fs = require("fs");
const path = require("path");
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const OUT = path.resolve(process.argv[2] || "qa/ink");
const URL = process.argv[3] || "http://127.0.0.1:4180/";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
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
  await new Promise(r => setTimeout(r, 2000));

  await page.mouse.move(800, 500);

  // scroll into chapter 1 the way a person would, then keep nudging so the
  // nib keeps travelling and laying down ink
  const shots = [];
  for (let step = 0; step < 30; step++) {
    await page.mouse.wheel({ deltaY: 130 });
    await new Promise(r => setTimeout(r, 55));
    if (step === 11 || step === 17 || step === 24 || step === 29) {
      await new Promise(r => setTimeout(r, 260));
      const st = await page.evaluate(() => window.__meridian.state);
      const f = path.join(OUT, "ink-" + step + ".png");
      await page.screenshot({ path: f });
      shots.push({ step, progress: +st.progress.toFixed(3), inkMode: st.inkMode, points: st.inkPoints });
    }
  }
  console.log(JSON.stringify(shots, null, 1));

  // and the pressure pad, drawn with a real pointer
  await page.evaluate(() => window.__meridian.jump(0.667));
  await new Promise(r => setTimeout(r, 900));
  const pad = await page.evaluate(() => {
    const r = document.getElementById("pad").getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  await page.mouse.move(pad.x + 30, pad.y + pad.h * 0.6);
  await page.mouse.down();
  for (let i = 0; i <= 90; i++) {
    const t = i / 90;
    // slow into the middle, quick out: the width should visibly respond
    const ease = t < 0.5 ? t : 0.5 + (t - 0.5) * 1.9;
    await page.mouse.move(
      pad.x + 24 + ease * (pad.w - 60),
      pad.y + pad.h * 0.6 - Math.sin(t * Math.PI * 1.6) * pad.h * 0.30
    );
    await new Promise(r => setTimeout(r, t < 0.5 ? 26 : 8));
  }
  await page.mouse.up();
  await new Promise(r => setTimeout(r, 400));
  const lvl = await page.evaluate(() => ({
    level: document.getElementById("padLevel").textContent,
    points: window.__meridian.state.inkPoints,
    mode: window.__meridian.state.inkMode
  }));
  console.log("pad:", JSON.stringify(lvl));
  await page.screenshot({ path: path.join(OUT, "pad.png") });

  await browser.close();
})().catch(e => { console.error("HARNESS:", e.message); process.exit(2); });
