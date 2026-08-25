/* Screenshots of the exploded-view interaction. Assertions cannot tell you
 * whether a composition works; this exists so someone looks at it. */
const puppeteer = require("D:/git/node_modules/puppeteer-core");
const fs = require("fs");
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const URL = process.argv[2] || "http://127.0.0.1:4180/";
const OUT = "qa/inspect";
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle"]
  });
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForFunction("window.__meridian");
  await sleep(1700);

  await page.evaluate(() => window.__meridian.jump(4 / 7));
  await sleep(1500);
  await page.screenshot({ path: OUT + "/a-exploded.png" });

  // hover the barrel
  const p = await page.evaluate(() => {
    const app = window.__app, r = app.renderer;
    const rect = r.canvas.getBoundingClientRect();
    const pt = r.projectPoint(r.mesh.partBounds[4].c, 4, app.pose);
    return { x: pt.x + rect.left, y: pt.y + rect.top };
  });
  await page.mouse.move(p.x, p.y);
  await sleep(700);
  await page.screenshot({ path: OUT + "/b-hover.png" });

  for (const k of [2, 4, 8, 9]) {
    await page.evaluate(i => window.__meridian.openPart(i), k);
    await sleep(1700);
    await page.screenshot({ path: OUT + "/c-part" + k + ".png" });
    await page.evaluate(() => window.__meridian.closePart());
    await sleep(1100);
  }

  // mid-transition, to check the scatter reads
  await page.evaluate(() => window.__meridian.openPart(3));
  await sleep(330);
  await page.screenshot({ path: OUT + "/d-transition.png" });
  await sleep(1400);

  await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });
  await sleep(700);
  await page.screenshot({ path: OUT + "/e-portrait.png" });
  await page.evaluate(() => window.__meridian.closePart());
  await sleep(1000);
  await page.screenshot({ path: OUT + "/f-portrait-exploded.png" });

  console.log("pageerrors:", errs.length, errs.slice(0, 3).join(" | "));
  await browser.close();
})();
