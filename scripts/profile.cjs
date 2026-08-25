/* Cost-centre profiler. Disables one thing at a time and re-measures, so the
 * optimisation target is evidence rather than intuition.
 * node scripts/profile.cjs [url] */
const puppeteer = require("D:/git/node_modules/puppeteer-core");
const CHROME = "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe";
const URL = process.argv[2] || "http://127.0.0.1:4180/";

/* Each variant gets a freshly loaded page. Applying the patches in sequence on
 * one page lets them stack, and every measurement after the first then reports
 * the profiler's own residue instead of the site. */
async function measure(page, label, setup) {
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction("window.__meridian");
  await new Promise(r => setTimeout(r, 1600));
  const r = await page.evaluate(async (setupSrc) => {
    // eslint-disable-next-line no-eval
    if (setupSrc) eval(setupSrc);
    window.__meridian.jump(0.16);
    await new Promise(r => setTimeout(r, 500));
    const ts = []; let last = performance.now();
    for (let i = 0; i < 150; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const now = performance.now(); ts.push(now - last); last = now;
      window.__meridian.scrollTo(0.16 + Math.sin(i / 9) * 0.06);
    }
    ts.sort((a, b) => a - b);
    return {
      median: +ts[75].toFixed(2),
      p95: +ts[142].toFixed(2),
      jank: +(ts.filter(t => t > 32).length / ts.length * 100).toFixed(1)
    };
  }, setup);
  console.log(("  " + label).padEnd(34), "median", String(r.median).padStart(6),
    " p95", String(r.p95).padStart(6), " jank", String(r.jank).padStart(5) + "%");
  return r;
}

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

  const gpu = await page.evaluate(() => {
    const gl = document.getElementById("stage").getContext("webgl2");
    const d = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?",
      samples: window.__app.renderer.samples,
      buffer: [window.__app.renderer.bufW, window.__app.renderer.bufH]
    };
  });
  console.log("\n  GPU:", gpu.renderer);
  console.log("  MSAA:", gpu.samples + "x   buffer:", gpu.buffer.join("x"), "\n");

  await measure(page, "full pipeline");

  await measure(page, "half resolution", "window.__app.perfScale = 0.5;");
  await measure(page, "back to full", "window.__app.perfScale = 1;");

  await measure(page, "ink layer off",
    "window.__app.ink.draw = function(){};");

  await measure(page, "ink off + no bloom",
    "var R=window.__app.renderer, o=R.render;" +
    "R.render=function(p,t){p=Object.assign({},p,{bloom:0});o.call(this,p,t);};");

  // scene only: skip the post chain entirely by drawing to the default FB
  await measure(page, "MSAA 1x (was " + gpu.samples + "x)",
    "var R=window.__app.renderer; R.samples=1; R._targets=null;");

  console.log("");
  await browser.close();
})().catch(e => { console.error("HARNESS:", e.message); process.exit(2); });
