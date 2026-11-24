import { chromium } from "playwright";
import { startServer } from "../../src/server.js";

const srv = await startServer({ port: 0, host: "127.0.0.1" });
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(srv.url, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
console.log("title:", await page.title());
const sampleOptions = await page.$$eval("#sample-select option", (opts) => opts.map((o) => o.textContent));
console.log("samples:", sampleOptions.length);
console.log("status:", await page.textContent("#status-text"));
// ensure sample loaded
await page.waitForFunction(() => !document.querySelector("#btn-analyze").disabled, null, { timeout: 20000 });
await page.click("#btn-analyze");
await page.waitForFunction(() => document.querySelector("#btn-render") && !document.querySelector("#btn-render").disabled, null, { timeout: 120000 });
await page.waitForTimeout(600);
console.log("rhythm:", await page.textContent("#m-source-fps"), await page.textContent("#m-pattern"), await page.textContent("#m-kept"));
console.log("runs rows:", await page.$$eval("#runs-body tr", (r) => r.length));
console.log("phase cells:", await page.$$eval(".phase-cell", (r) => r.length));
await page.screenshot({ path: "/tmp/shot-analysis.png", fullPage: true });
await page.click("#btn-render");
await page.waitForFunction(() => document.querySelector("#result-tag").textContent === "已生成", null, { timeout: 180000 });
await page.waitForTimeout(1200);
console.log("result kept:", await page.textContent("#r-kept"));
console.log("result duration:", await page.textContent("#r-duration"));
console.log("kept rows:", await page.$$eval("#kept-body tr", (r) => r.length));
await page.screenshot({ path: "/tmp/shot-result.png", fullPage: true });
console.log("errors:", errors);
await browser.close();
await srv.close();
