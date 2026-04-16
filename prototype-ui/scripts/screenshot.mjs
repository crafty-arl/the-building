import { chromium } from "playwright";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "networkidle", timeout: 30000 });
await page.waitForSelector(".entry", { timeout: 10000 });
await page.screenshot({ path: "dashboard.png", fullPage: false });
await browser.close();
console.log("screenshot saved: dashboard.png");
