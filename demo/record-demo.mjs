import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, rename, rm } from "node:fs/promises";
import { chromium } from "playwright";

const demoDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(demoDir, "..");
const outputDir = join(demoDir, "output");
const fast = process.argv.includes("--fast");
const speed = fast ? 0.04 : 1;
const visualStepPause = 5_000;
const targetVideo = join(outputDir, fast
  ? "copilot-budget-lab-six-minute-demo-fast.webm"
  : "copilot-budget-lab-six-minute-demo.webm");

const wait = () => new Promise((resolveWait) => setTimeout(resolveWait, visualStepPause * speed));

async function launchBrowser() {
  const requestedChannel = process.env.PLAYWRIGHT_CHANNEL;
  const attempts = requestedChannel
    ? [{ channel: requestedChannel }]
    : [{ channel: "msedge" }, { channel: "chrome" }, {}];
  const failures = [];

  for (const options of attempts) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch (error) {
      failures.push(`${options.channel || "bundled Chromium"}: ${error.message.split("\n")[0]}`);
    }
  }

  throw new Error(`Unable to launch a Chromium browser.\n${failures.join("\n")}`);
}

async function waitForServer(url, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Budget Lab did not start at ${url}`);
}

async function addDemoChrome(page) {
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      #demo-caption {
        position: fixed; z-index: 10000; left: 50%; bottom: 24px; transform: translateX(-50%);
        width: min(1120px, calc(100vw - 80px)); box-sizing: border-box; padding: 18px 24px;
        border: 1px solid rgba(255,255,255,.22); border-radius: 16px;
        background: rgba(18, 23, 38, .94); color: #fff; box-shadow: 0 18px 50px rgba(0,0,0,.28);
        font: 600 22px/1.35 "Segoe UI", sans-serif; letter-spacing: -.01em;
      }
      #demo-caption small { display:block; margin-bottom:6px; color:#a7f3d0; font-size:13px;
        font-weight:800; letter-spacing:.13em; text-transform:uppercase; }
      #demo-scene {
        position: fixed; z-index: 9999; inset: 0; display: none; align-items: center; justify-content: center;
        padding: 80px; background:
          radial-gradient(circle at 18% 22%, rgba(45,212,191,.22), transparent 28%),
          radial-gradient(circle at 82% 70%, rgba(139,92,246,.24), transparent 30%),
          #111827; color: #fff; font-family: "Segoe UI", sans-serif;
      }
      #demo-scene.visible { display:flex; }
      #demo-scene .scene-card { width:min(1120px, 92vw); }
      #demo-scene .kicker { color:#5eead4; font-size:17px; font-weight:800; letter-spacing:.14em;
        text-transform:uppercase; }
      #demo-scene h1 { margin:18px 0 22px; max-width:1000px; font-size:58px; line-height:1.03;
        letter-spacing:-.045em; }
      #demo-scene p { max-width:920px; margin:0; color:#dbeafe; font-size:27px; line-height:1.45; }
      #demo-scene .pair { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-top:34px; }
      #demo-scene .persona, #demo-scene .agent { padding:24px; border:1px solid rgba(255,255,255,.16);
        border-radius:18px; background:rgba(255,255,255,.08); }
      #demo-scene .persona strong, #demo-scene .agent strong { display:block; margin-bottom:10px;
        color:#fff; font-size:23px; }
      #demo-scene .persona span, #demo-scene .agent span { color:#cbd5e1; font-size:19px; line-height:1.45; }
      #demo-scene .arrow { color:#5eead4; font-weight:900; }
      .demo-focus { position:relative; z-index:20; outline:5px solid #2dd4bf !important;
        outline-offset:5px; border-radius:10px; }
    `;
    document.head.append(style);

    const scene = document.createElement("div");
    scene.id = "demo-scene";
    scene.innerHTML = '<div class="scene-card"></div>';
    document.body.append(scene);

    const caption = document.createElement("div");
    caption.id = "demo-caption";
    caption.hidden = true;
    document.body.append(caption);
  });
}

async function showScene(page, { kicker, title, body, cards = [] }, duration) {
  await page.evaluate(({ kicker, title, body, cards }) => {
    const scene = document.querySelector("#demo-scene");
    const cardMarkup = cards.length
      ? `<div class="pair">${cards.map((card) => `<div class="${card.kind || "persona"}"><strong>${card.title}</strong><span>${card.body}</span></div>`).join("")}</div>`
      : "";
    scene.querySelector(".scene-card").innerHTML = `<div class="kicker">${kicker}</div><h1>${title}</h1><p>${body}</p>${cardMarkup}`;
    scene.classList.add("visible");
  }, { kicker, title, body, cards });
  await wait(duration);
  await page.evaluate(() => document.querySelector("#demo-scene").classList.remove("visible"));
}

async function caption(page, label, text, duration) {
  await page.evaluate(({ label, text }) => {
    const captionNode = document.querySelector("#demo-caption");
    captionNode.innerHTML = `<small>${label}</small>${text}`;
    captionNode.hidden = false;
  }, { label, text });
  await wait(duration);
}

async function focus(page, selector, duration = 2_000) {
  await page.locator(selector).evaluate((element) => element.classList.add("demo-focus"));
  await wait(duration);
  await page.locator(selector).evaluate((element) => element.classList.remove("demo-focus"));
}

async function clickAndPause(page, selector, duration = 2_000) {
  await page.locator(selector).click();
  await wait(duration);
}

await mkdir(outputDir, { recursive: true });
await rm(targetVideo, { force: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let browser;
try {
  await waitForServer("http://localhost:4173");
  browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: outputDir, size: { width: 1440, height: 900 } },
    colorScheme: "light"
  });
  const page = await context.newPage();
  await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
  await addDemoChrome(page);
  const video = page.video();

  await showScene(page, {
    kicker: "Copilot Budget Lab",
    title: "Understand the rules before the bill arrives.",
    body: "A six-minute conversation between engineering velocity and predictable spending.",
    cards: [
      { title: "Maya · Engineering lead", body: "Wants productive AI adoption without interrupting developers." },
      { title: "Daniel · FinOps lead", body: "Wants guardrails before usage becomes unpredictable spend." }
    ]
  }, 35_000);

  await showScene(page, {
    kicker: "The shared problem",
    title: "Licenses are only the starting point.",
    body: "The decision also includes pooled consumption, additional spending, alert thresholds, and the controls that stop usage.",
    cards: [
      { title: "Engineering asks", body: "Will this control block useful work at the wrong moment?" },
      { title: "FinOps asks", body: "When does included usage become a charge, and who owns it?" }
    ]
  }, 45_000);

  await showScene(page, {
    kicker: "Generate with agents",
    title: "Describe the situation—not every row.",
    body: "Two repository agents turn intent into deterministic, reviewable artifacts.",
    cards: [
      { kind: "agent", title: "Default Set Generator", body: "“Create a compact synthetic enterprise with Alice, Bob, stable IDs, AI-credit products, budgets, and no live usage history.”" },
      { kind: "agent", title: "Scenario Generator", body: "“Show a cost-center pool reaching its cap, then compare paid overage with a user hard stop.”" }
    ]
  }, 45_000);

  await caption(page, "Synthetic sandbox", "Nothing connects to GitHub. All data stays in this browser.", 8_000);
  await focus(page, "#summary-cards", 5_000);
  await caption(page, "One operating view", "Included credits, seat charges, paid overage, alerts, and blocked events are visible together.", 12_000);

  await clickAndPause(page, '[data-view="configuration"]', 2_000);
  await caption(page, "Generated environment", "Switch between the compact teaching tenant and a 200-user enterprise dataset without touching production.", 8_000);
  await focus(page, "#default-scenario-set", 5_000);

  await clickAndPause(page, '[data-view="simulate"]', 2_000);
  await page.locator("#scenario-definition").selectOption("cost-center-pool-to-overage");
  await page.locator("#scenario-reset").click();
  await caption(page, "Decision one", "What happens when a cost center exhausts its included AI-credit pool?", 12_000);
  await focus(page, "#scenario-step-list", 4_000);

  await clickAndPause(page, "#scenario-next", 2_000);
  await page.locator("#scenario-outcome").scrollIntoViewIfNeeded();
  await caption(page, "Included pool at 100%", "Alice uses all 3,900 credits attributed to AI Innovation. Paid overage is still $0.", 20_000);
  await focus(page, "#scenario-outcome", 5_000);

  await clickAndPause(page, "#scenario-next", 2_000);
  await page.locator("#scenario-outcome").scrollIntoViewIfNeeded();
  await caption(page, "Continue as paid overage", "The next 2,400 credits are accepted as $24 of paid usage instead of blocking the developer.", 22_000);
  await caption(page, "Predictable signal", "The $30 cost-center budget reaches 80% and crosses its 75% alert threshold.", 16_000);

  await page.locator("#scenario-definition").scrollIntoViewIfNeeded();
  await page.locator("#scenario-definition").selectOption("hard-stop-boundary");
  await page.locator("#scenario-reset").click();
  await caption(page, "Decision two", "Where should usage stop—and what exactly happens at the boundary?", 10_000);

  await clickAndPause(page, "#scenario-next", 2_000);
  await page.locator("#scenario-outcome").scrollIntoViewIfNeeded();
  await caption(page, "Exact limit accepted", "Alice consumes 1,000 credits, reaches the $10 user-level budget exactly, and the event succeeds.", 18_000);

  await clickAndPause(page, "#scenario-next", 2_000);
  await page.locator("#scenario-outcome").scrollIntoViewIfNeeded();
  await caption(page, "Next event blocked", "One additional credit would move $10.00 to $10.01, so the complete event is rejected.", 22_000);
  await caption(page, "Atomic outcome", "No credits are consumed and no counters change. The operator can see the exact control and reason.", 16_000);

  await clickAndPause(page, '[data-view="optimized"]', 2_000);
  await caption(page, "A joint decision surface", "Engineering sees developer impact. FinOps sees the funding route, budget movement, thresholds, and enforcement.", 10_000);

  await showScene(page, {
    kicker: "Agree before deployment",
    title: "Generate → simulate → inspect → agree.",
    body: "Productive AI adoption without using a surprise invoice as the monitoring system—or a blocked developer as the first test case.",
    cards: [
      { title: "Repeatable", body: "The same scenario replays from the same synthetic baseline." },
      { title: "Reviewable", body: "Every assumption, threshold, event, and expected outcome is explicit." }
    ]
  }, 28_000);

  await page.evaluate(() => { document.querySelector("#demo-caption").hidden = true; });
  await page.close();
  await context.close();
  const recordedPath = await video.path();
  await rename(recordedPath, targetVideo);
  console.log(`Recorded ${targetVideo}`);
} finally {
  if (browser) await browser.close();
  server.kill();
}
