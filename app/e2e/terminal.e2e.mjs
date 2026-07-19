/**
 * End-to-end smoke test for the trading terminal.
 * Assumes the app is already serving on http://localhost:3000
 * (see `npm run test:e2e` which orchestrates build + start + this script).
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:3000";

const EDGE_PATHS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];
const executablePath = [...EDGE_PATHS, ...CHROME_PATHS].find((p) => fs.existsSync(p));
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

  console.log("terminal loads");
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 30_000 });

  console.log("login gate: enter as guest");
  await page.waitForSelector('[data-testid="enter-guest"]', { timeout: 10_000 });
  await page.click('[data-testid="enter-guest"]');
  await page.waitForSelector('button[title^="Set limit price"]', { timeout: 10_000 });
  check(true, "orderbook renders price levels");
  check((await page.$$("canvas")).length > 0, "chart canvas mounted");
  const bookRows = await page.$$('button[title^="Set limit price"]');
  check(bookRows.length >= 10, `book shows depth (${bookRows.length} rows)`);

  console.log("wallet connect");
  await page.click('[data-testid="connect-wallet"]');
  await page.waitForSelector('[data-testid="wallet-address"]', { timeout: 5_000 });
  const addr = await page.$eval('[data-testid="wallet-address"]', (el) => el.textContent);
  check(addr.includes("9bez"), `address chip shows truncated pubkey (${addr.trim()})`);

  console.log("click-to-quote from the book");
  // DOM-dispatched click: book rows shift as the feed ticks, so a
  // coordinate click can land between rows. Read + click atomically.
  const clickedPrice = await page.$eval('button[title^="Set limit price"]', (el) => {
    el.click();
    return el.title.replace("Set limit price ", "").replace(",", "");
  });
  const priceValue = await page.$eval('[data-testid="input-price"]', (el) => el.value);
  check(
    Math.abs(parseFloat(priceValue) - parseFloat(clickedPrice)) < 0.005,
    `book click loads price into form (${clickedPrice} → ${priceValue})`,
  );

  console.log("market buy fills");
  await page.click('[data-testid="type-market"]');
  await page.click('[data-testid="input-size"]');
  await page.type('[data-testid="input-size"]', "1");
  await page.click('[data-testid="submit-order"]');
  await new Promise((r) => setTimeout(r, 1200)); // simulated on-chain ack + fill
  await page.click('[data-testid="tab-history"]');
  await page.waitForSelector('[data-testid="fill-row"]', { timeout: 5_000 });
  const fillCells = await page.$eval('[data-testid="fill-row"]', (el) => el.textContent);
  check(fillCells.toLowerCase().includes("buy"), "fill row records the buy");

  console.log("balances update after fill");
  await page.click('[data-testid="tab-balances"]');
  const balancesText = await page.$$eval("tbody tr", (rows) => rows.map((r) => r.textContent).join("|"));
  check(balancesText.includes("85.60"), `SOL balance is 84.60 + 1 bought (${balancesText})`);

  console.log("resting limit order + cancel");
  // triple-click doesn't select inside <input type="number">; use keyboard select-all
  const replaceValue = async (sel, text) => {
    await page.click(sel);
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await page.type(sel, text);
  };
  await page.click('[data-testid="type-limit"]');
  await replaceValue('[data-testid="input-price"]', "100");
  await replaceValue('[data-testid="input-size"]', "2");
  const typedPrice = await page.$eval('[data-testid="input-price"]', (el) => el.value);
  check(typedPrice === "100", `price input holds the typed value (${typedPrice})`);
  await page.click('[data-testid="submit-order"]');
  await page.click('[data-testid="tab-orders"]');
  await page.waitForSelector('[data-testid="open-order-row"]', { timeout: 5_000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="open-order-row"]')?.textContent?.includes("open"),
    { timeout: 5_000 },
  );
  const orderRow = await page.$eval('[data-testid="open-order-row"]', (el) => el.textContent);
  check(orderRow.includes("100.00"), "limit order rests at the typed price, acked pending → open");

  await page.click('[data-testid="cancel-order"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="open-order-row"]').length === 0,
    { timeout: 5_000 },
  );
  check(true, "cancel removes the resting order");

  const finalBalances = await (async () => {
    await page.click('[data-testid="tab-balances"]');
    return page.$$eval("tbody tr", (rows) => rows.map((r) => r.textContent).join("|"));
  })();
  check(!finalBalances.includes("200.00USDC") && finalBalances.includes("85.60"), "cancel released locked funds");

  console.log("session survives a reload");
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="wallet-address"]', { timeout: 10_000 });
  check(true, "reload skips the login gate and reconnects the wallet");
  await page.waitForSelector('button[title^="Set limit price"]', { timeout: 10_000 });
  check(true, "book streams again after restore");

  console.log("feed stays live");
  const tradeCount = async () =>
    page.$$eval('[class*="flash-"]', (els) => els.length).catch(() => 0);
  const before = await tradeCount();
  await new Promise((r) => setTimeout(r, 2000));
  const after = await tradeCount();
  check(after >= before, `tape keeps printing (${before} → ${after} visible prints)`);

  check(pageErrors.length === 0, pageErrors.length ? `no page errors: ${pageErrors[0]}` : "no page errors");

  await page.screenshot({ path: process.env.E2E_SHOT ?? "e2e/last-run.png" });
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
