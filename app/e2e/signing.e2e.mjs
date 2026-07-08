/**
 * End-to-end test of real on-chain trading from the terminal.
 *
 * Prereqs: WSL validator + program deployed, indexer running, a market
 * seeded with the dev wallet funded (`node scripts/seed-market.mjs`),
 * and the app serving (E2E_URL, default http://localhost:3000).
 *
 * Flow: connect burner wallet → verify OpenOrders balances → rest a
 * limit bid → verify the on-chain lock → cancel → market buy → verify
 * the fill lands in history. All through real signed transactions.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:3000";

const EXE_PATHS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];
const executablePath = EXE_PATHS.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error("No Edge/Chrome executable found for e2e run");
  process.exit(2);
}

let passed = 0;
let failed = 0;
function check(cond, name) {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}`);
  }
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
  defaultViewport: { width: 1600, height: 900 },
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60_000 });
  await page.waitForSelector('button[title^="Set limit price"]', { timeout: 30_000 });

  console.log("live feed required");
  await page.waitForFunction(() => document.body.innerText.includes("live"), { timeout: 15_000 });
  check(true, "terminal is on the indexer feed");

  console.log("connect real wallet");
  await page.click('[data-testid="connect-wallet"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="wallet-address"]')?.textContent?.includes("Kfq"),
    { timeout: 20_000 },
  );
  check(true, "burner wallet connected (KfqT…)");

  console.log("real balances from the OpenOrders account");
  await page.click('[data-testid="tab-balances"]');
  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll("tbody tr").length;
      return rows >= 2 && !document.body.innerText.includes("12,450.00"); // not the sim defaults
    },
    { timeout: 15_000 },
  );
  check(true, "balances reflect on-chain deposits, not the simulator");

  const replaceValue = async (sel, text) => {
    await page.click(sel);
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await page.type(sel, text);
  };

  console.log("rest a real limit bid at 45.00");
  await page.click('[data-testid="type-limit"]');
  await replaceValue('[data-testid="input-price"]', "45");
  await replaceValue('[data-testid="input-size"]', "0.5");
  await page.click('[data-testid="submit-order"]');
  await page.click('[data-testid="tab-orders"]');
  await page.waitForFunction(
    () => {
      const row = document.querySelector('[data-testid="open-order-row"]');
      return row?.textContent?.includes("45.00") && row?.textContent?.includes("open");
    },
    { timeout: 20_000 },
  );
  check(true, "order resting on-chain, reported back by the indexer");

  console.log("balances reflect the on-chain lock");
  await page.click('[data-testid="tab-balances"]');
  await page.waitForFunction(() => document.body.innerText.includes("22.50"), { timeout: 15_000 });
  check(true, "22.50 USDC locked behind the resting bid (45.00 × 0.5)");

  console.log("cancel it on-chain");
  await page.click('[data-testid="tab-orders"]');
  await page.click('[data-testid="cancel-order"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="open-order-row"]').length === 0,
    { timeout: 20_000 },
  );
  check(true, "cancel confirmed; order gone from the indexer");

  console.log("market buy 0.05 SOL");
  await page.click('[data-testid="type-market"]');
  await replaceValue('[data-testid="input-size"]', "0.05");
  await page.click('[data-testid="submit-order"]');
  await page.click('[data-testid="tab-history"]');
  await page.waitForSelector('[data-testid="fill-row"]', { timeout: 20_000 });
  const fill = await page.$eval('[data-testid="fill-row"]', (el) => el.textContent);
  check(fill.toLowerCase().includes("buy"), `real fill recorded (${fill.trim().slice(0, 60)})`);

  check(pageErrors.length === 0, pageErrors.length ? `no page errors: ${pageErrors[0]}` : "no page errors");

  await page.screenshot({ path: process.env.E2E_SHOT ?? "e2e/last-signing.png" });
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
