// Drive the perp flow: switch market → connect → long 1 SOL → verify
// position row + collateral → close → verify flat. Real transactions.
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const OUT = process.env.E2E_SHOT_DIR ?? "e2e";
const URL = process.env.E2E_URL ?? "http://localhost:3000";
const EXES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const browser = await puppeteer.launch({
  executablePath: EXES.find((p) => fs.existsSync(p)),
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

let passed = 0;
let failed = 0;
const check = (c, name) => {
  if (c) (passed++, console.log(`  ok    ${name}`));
  else (failed++, console.error(`  FAIL  ${name}`));
};

await page.goto(URL, { waitUntil: "networkidle2", timeout: 60_000 });

console.log("login: connect wallet from the gate");
await page.waitForSelector('[data-testid="connect-wallet"]', { timeout: 30_000 });
await page.click('[data-testid="connect-wallet"]');
await page.waitForFunction(
  () => document.querySelector('[data-testid="wallet-address"]')?.textContent?.includes("Kfq"),
  { timeout: 25_000 },
);
check(true, "logged in with the burner wallet");
await page.waitForFunction(() => document.body.innerText.includes("live"), { timeout: 20_000 });
await page.screenshot({ path: `${OUT}/perp-0-spot-restyled.png` });

console.log("switch to SOL-PERP");
await page.waitForSelector('[data-testid="market-SOL-PERP"]', { timeout: 15_000 });
await page.click('[data-testid="market-SOL-PERP"]');
await page.waitForFunction(() => document.body.innerText.includes("Oracle Market"), {
  timeout: 20_000,
});
await page.waitForFunction(
  () => document.body.innerText.toLowerCase().includes("mark price"),
  { timeout: 15_000 },
);
check(true, "perp market selected: oracle panel showing");

console.log("margin state on perp");
// on-chain trading must be live and the margin panel populated (the
// exact balance depends on prior sessions' fees/PnL, so no fixed value)
await page.waitForFunction(
  () => document.body.innerText.toLowerCase().includes("signed and placed on-chain"),
  { timeout: 20_000 },
);
await page.click('[data-testid="tab-balances"]');
await page.waitForFunction(
  () => {
    const t = document.body.innerText.toLowerCase();
    return t.includes("free collateral") && /\d+\.\d\d/.test(t);
  },
  { timeout: 20_000 },
);
check(true, "on-chain margin account loaded (collateral panel populated)");

console.log("open a 1 SOL long");
await page.click('[data-testid="side-buy"]');
await page.click('[data-testid="input-size"]');
await page.type('[data-testid="input-size"]', "1");
await page.click('[data-testid="submit-order"]');
await page.click('[data-testid="tab-orders"]');
await page.waitForSelector('[data-testid="position-row"]', { timeout: 25_000 });
const row = await page.$eval('[data-testid="position-row"]', (el) => el.textContent);
check(row.includes("Long"), `position row shows Long (${row.trim().slice(0, 80)})`);
await new Promise((r) => setTimeout(r, 3000)); // let PnL tick against the oracle
await page.screenshot({ path: `${OUT}/perp-1-long.png` });

console.log("close the position");
await page.click('[data-testid="close-position"]');
await page.waitForFunction(
  () => document.body.innerText.includes("No open position"),
  { timeout: 25_000 },
);
check(true, "position closed on-chain, panel flat");

console.log("history shows both real fills");
await page.click('[data-testid="tab-history"]');
await page.waitForFunction(
  () => document.querySelectorAll('[data-testid="fill-row"]').length >= 2,
  { timeout: 20_000 },
);
const fills = await page.$$eval('[data-testid="fill-row"]', (els) =>
  els.map((e) => e.textContent),
);
check(fills.length >= 2, `open + close both printed (${fills.length} fills)`);
await page.screenshot({ path: `${OUT}/perp-2-closed.png` });

const realErrors = errors.filter((e) => !e.includes("favicon"));
check(realErrors.length === 0, realErrors.length ? `errors: ${realErrors[0]}` : "no page errors");

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
