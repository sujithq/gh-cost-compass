import pptxgen from "pptxgenjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";

const demoDir = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(demoDir, "assets");
const outputDir = join(demoDir, "output");
const outputPath = join(outputDir, "copilot-budget-lab-six-minute-demo.pptx");

const pptx = new pptxgen();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "GitHub Copilot";
pptx.company = "GitHub";
pptx.subject = "Six-minute Copilot Budget Lab product demonstration";
pptx.title = "Copilot Budget Lab: understand the rules before the bill arrives";
pptx.lang = "en-US";
pptx.theme = {
  headFontFace: "Aptos Display",
  bodyFontFace: "Aptos",
  lang: "en-US"
};
pptx.defineLayout({ name: "CUSTOM_WIDE", width: 13.333, height: 7.5 });
pptx.layout = "CUSTOM_WIDE";
pptx.margin = 0;

const C = {
  ink: "111827",
  slate: "334155",
  muted: "64748B",
  paper: "F8FAFC",
  white: "FFFFFF",
  teal: "0F766E",
  mint: "2DD4BF",
  mintPale: "CCFBF1",
  violet: "6D28D9",
  violetPale: "EDE9FE",
  amber: "F59E0B",
  amberPale: "FEF3C7",
  red: "DC2626",
  redPale: "FEE2E2",
  line: "CBD5E1",
  navy: "0F172A"
};

const shadow = () => ({ type: "outer", color: "000000", opacity: 0.14, blur: 3, angle: 45, distance: 2 });

function addFooter(slide, number, timing, dark = false) {
  slide.addText(`COPILOT BUDGET LAB  ·  ${timing}`, {
    x: 0.62, y: 7.12, w: 4.2, h: 0.18, margin: 0,
    fontFace: "Aptos", fontSize: 9, bold: true, charSpacing: 1.4,
    color: dark ? "94A3B8" : C.muted
  });
  slide.addText(String(number).padStart(2, "0"), {
    x: 12.15, y: 7.08, w: 0.52, h: 0.22, margin: 0,
    fontFace: "Aptos", fontSize: 10, bold: true, align: "right",
    color: dark ? C.mint : C.teal
  });
}

function addTitle(slide, title, subtitle, dark = false) {
  slide.addText(title, {
    x: 0.65, y: 0.48, w: 11.9, h: 0.62, margin: 0,
    fontFace: "Aptos Display", fontSize: 31, bold: true,
    color: dark ? C.white : C.ink, breakLine: false, fit: "shrink"
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.67, y: 1.16, w: 11.5, h: 0.38, margin: 0,
      fontFace: "Aptos", fontSize: 15, color: dark ? "CBD5E1" : C.muted,
      fit: "shrink"
    });
  }
}

function addPill(slide, text, x, y, fill, color = C.ink, width = 1.5) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w: width, h: 0.36, rectRadius: 0.08,
    fill: { color: fill }, line: { color: fill }
  });
  slide.addText(text, {
    x: x + 0.08, y: y + 0.075, w: width - 0.16, h: 0.16, margin: 0,
    fontSize: 10, bold: true, align: "center", color, charSpacing: 0.5
  });
}

function addPersona(slide, x, y, name, role, concern, accent, monogram) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w: 5.45, h: 1.92, rectRadius: 0.08,
    fill: { color: "FFFFFF", transparency: 5 },
    line: { color: "FFFFFF", transparency: 78, width: 1.2 },
    shadow: shadow()
  });
  slide.addShape(pptx.ShapeType.ellipse, {
    x: x + 0.35, y: y + 0.38, w: 0.88, h: 0.88,
    fill: { color: accent }, line: { color: accent }
  });
  slide.addText(monogram, {
    x: x + 0.35, y: y + 0.59, w: 0.88, h: 0.28, margin: 0,
    align: "center", fontSize: 22, bold: true, color: C.white
  });
  slide.addText(name, {
    x: x + 1.48, y: y + 0.38, w: 3.45, h: 0.34, margin: 0,
    fontSize: 22, bold: true, color: C.ink
  });
  slide.addText(role.toUpperCase(), {
    x: x + 1.48, y: y + 0.83, w: 3.3, h: 0.2, margin: 0,
    fontSize: 10, bold: true, charSpacing: 1.4, color: accent
  });
  slide.addText(concern, {
    x: x + 0.35, y: y + 1.28, w: 4.7, h: 0.35, margin: 0,
    fontSize: 15, color: C.slate, fit: "shrink"
  });
}

function addScreenshot(slide, fileName, x, y, w, h) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x: x - 0.08, y: y - 0.08, w: w + 0.16, h: h + 0.16,
    rectRadius: 0.06, fill: { color: C.white }, line: { color: C.line, width: 1 },
    shadow: shadow()
  });
  slide.addImage({ path: join(assetsDir, fileName), x, y, w, h });
}

function addNotes(slide, text) {
  if (typeof slide.addNotes === "function") slide.addNotes(text);
}

// Slide 1
{
  const slide = pptx.addSlide();
  slide.background = { color: C.navy };
  slide.addShape(pptx.ShapeType.ellipse, {
    x: -1.4, y: -1.1, w: 5.1, h: 5.1,
    fill: { color: C.teal, transparency: 45 }, line: { color: C.teal, transparency: 100 }
  });
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 10.3, y: 4.2, w: 4.4, h: 4.4,
    fill: { color: C.violet, transparency: 42 }, line: { color: C.violet, transparency: 100 }
  });
  addPill(slide, "SIX-MINUTE PRODUCT DEMO", 0.72, 0.58, C.mintPale, C.teal, 2.55);
  slide.addText("Copilot Budget Lab", {
    x: 0.72, y: 1.4, w: 9.8, h: 0.82, margin: 0,
    fontFace: "Aptos Display", fontSize: 50, bold: true, color: C.white
  });
  slide.addText("Understand the rules\nbefore the bill arrives.", {
    x: 0.72, y: 2.25, w: 8.7, h: 1.62, margin: 0,
    fontFace: "Aptos Display", fontSize: 43, bold: true, color: C.mint,
    breakLine: false, fit: "shrink"
  });
  slide.addText("A shared sandbox for engineering velocity and predictable spending.", {
    x: 0.75, y: 4.18, w: 7.4, h: 0.5, margin: 0,
    fontSize: 20, color: "CBD5E1"
  });
  addPersona(slide, 0.75, 4.82, "Maya", "Engineering lead", "Protect productive developer flow.", C.teal, "M");
  addPersona(slide, 6.75, 4.82, "Daniel", "FinOps lead", "Make additional spend predictable.", C.violet, "D");
  addFooter(slide, 1, "0:00–0:35", true);
  addNotes(slide, "Meet Maya, an engineering lead, and Daniel, a FinOps lead. They want the same outcome: productive AI adoption. Maya worries that a guardrail will interrupt a developer in the middle of useful work. Daniel worries that usage-based consumption will turn into unpredictable additional spend. Budget Lab gives them one place to test both concerns before either reaches production.");
}

// Slide 2
{
  const slide = pptx.addSlide();
  slide.background = { color: C.paper };
  addTitle(slide, "Licenses are only the starting point.", "Usage-based billing adds three questions that engineering and finance must answer together.");

  const nodes = [
    { x: 0.8, title: "Consumption", body: "How are included AI credits pooled and attributed?", color: C.teal, pale: C.mintPale, number: "01" },
    { x: 4.63, title: "Additional spend", body: "When does usage become paid overage, and whose budget moves?", color: C.violet, pale: C.violetPale, number: "02" },
    { x: 8.46, title: "Stop conditions", body: "Which controls only alert, and which stop usage?", color: C.red, pale: C.redPale, number: "03" }
  ];
  for (const node of nodes) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: node.x, y: 2.05, w: 3.28, h: 2.55, rectRadius: 0.08,
      fill: { color: C.white }, line: { color: C.line }, shadow: shadow()
    });
    slide.addShape(pptx.ShapeType.ellipse, {
      x: node.x + 0.25, y: 2.33, w: 0.65, h: 0.65,
      fill: { color: node.pale }, line: { color: node.pale }
    });
    slide.addText(node.number, {
      x: node.x + 0.25, y: 2.54, w: 0.65, h: 0.16, margin: 0,
      align: "center", fontSize: 11, bold: true, color: node.color
    });
    slide.addText(node.title, {
      x: node.x + 0.25, y: 3.17, w: 2.65, h: 0.34, margin: 0,
      fontSize: 22, bold: true, color: C.ink
    });
    slide.addText(node.body, {
      x: node.x + 0.25, y: 3.72, w: 2.63, h: 0.62, margin: 0,
      fontSize: 15, color: C.slate, fit: "shrink"
    });
  }
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 1.55, y: 5.15, w: 10.2, h: 1.05, rectRadius: 0.08,
    fill: { color: C.navy }, line: { color: C.navy }
  });
  slide.addText("The FinOps question", {
    x: 1.9, y: 5.43, w: 2.05, h: 0.24, margin: 0,
    fontSize: 13, bold: true, color: C.mint, charSpacing: 1
  });
  slide.addText("How do we agree on guardrails without learning through a surprise invoice—or a blocked developer?", {
    x: 4.0, y: 5.32, w: 7.2, h: 0.46, margin: 0,
    fontSize: 20, bold: true, color: C.white, fit: "shrink"
  });
  addFooter(slide, 2, "0:35–1:20");
  addNotes(slide, "With usage-based billing, buying licenses is only part of the decision. The team also needs to understand how included consumption is pooled, when additional usage becomes paid spending, and which controls merely alert versus actually stop usage. That is a FinOps problem: engineering and finance need to agree on guardrails without learning through a surprise invoice or a blocked developer.");
}

// Slide 3
{
  const slide = pptx.addSlide();
  slide.background = { color: C.navy };
  addTitle(slide, "Describe the situation—not every row.", "Repository agents turn intent into deterministic, reviewable JSON.", true);

  const agentCards = [
    {
      x: 0.72, accent: C.teal, title: "Default Set Generator",
      prompt: "“Create a compact synthetic enterprise with Alice, Bob, stable IDs, AI-credit products, budgets, and no live usage history.”",
      output: "synthetic-compact.json", label: "ENVIRONMENT"
    },
    {
      x: 6.88, accent: C.violet, title: "Scenario Generator",
      prompt: "“Show a cost-center pool reaching its cap, then compare paid overage with a user hard stop.”",
      output: "cost-center-pool-to-overage.json", label: "LESSON"
    }
  ];
  for (const card of agentCards) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: card.x, y: 1.85, w: 5.72, h: 3.85, rectRadius: 0.08,
      fill: { color: "172033" }, line: { color: card.accent, transparency: 25, width: 1.4 }
    });
    addPill(slide, card.label, card.x + 0.32, 2.18, card.accent, C.white, 1.22);
    slide.addText(card.title, {
      x: card.x + 0.32, y: 2.75, w: 4.7, h: 0.42, margin: 0,
      fontSize: 25, bold: true, color: C.white
    });
    slide.addText(card.prompt, {
      x: card.x + 0.32, y: 3.45, w: 5.0, h: 1.0, margin: 0,
      fontFace: "Consolas", fontSize: 14, color: "CBD5E1", fit: "shrink"
    });
    slide.addShape(pptx.ShapeType.roundRect, {
      x: card.x + 0.32, y: 4.78, w: 5.0, h: 0.52, rectRadius: 0.04,
      fill: { color: "0B1220" }, line: { color: "334155" }
    });
    slide.addText(`→  ${card.output}`, {
      x: card.x + 0.48, y: 4.95, w: 4.65, h: 0.17, margin: 0,
      fontFace: "Consolas", fontSize: 12, bold: true, color: card.accent
    });
  }
  slide.addText("Stable IDs  |  explicit assumptions  |  falsifiable outcomes  |  deterministic replay", {
    x: 1.15, y: 6.18, w: 11.05, h: 0.4, margin: 0,
    align: "center", fontSize: 15, bold: true, color: "CBD5E1", charSpacing: 0.4
  });
  addFooter(slide, 3, "1:20–2:05", true);
  addNotes(slide, "Instead of manually inventing every tenant, user, budget, and usage event, we describe the situation we want to understand. The Default Set Generator creates a synthetic topology with stable IDs, explicit assumptions, and no live billing history. The Scenario Generator then creates the lesson: ordered usage events, expected outcomes, and the exact thresholds or blocking reasons we want to observe. Both artifacts are deterministic and reviewable as JSON.");
}

// Slide 4
{
  const slide = pptx.addSlide();
  slide.background = { color: C.paper };
  addTitle(slide, "Open a synthetic sandbox—not a production tenant.", "The environment is selectable, browser-local, and safe to replay.");
  addScreenshot(slide, "dashboard-summary.png", 0.72, 1.82, 8.15, 2.35);
  addScreenshot(slide, "dataset-selector.png", 0.72, 4.62, 8.15, 0.58);
  slide.addText("Two views from the same browser-local synthetic tenant", {
    x: 0.92, y: 5.46, w: 7.75, h: 0.3, margin: 0,
    fontSize: 14, bold: true, color: C.slate, align: "center"
  });
  const callouts = [
    { y: 1.9, title: "No GitHub connection", body: "All data stays in the browser.", color: C.teal, pale: C.mintPale },
    { y: 3.15, title: "Two teaching scales", body: "Compact for focused lessons; enterprise for realistic topology.", color: C.violet, pale: C.violetPale },
    { y: 4.63, title: "One operating view", body: "Pool, seats, overage, alerts, and blocks are visible together.", color: C.amber, pale: C.amberPale }
  ];
  for (const callout of callouts) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 9.28, y: callout.y, w: 3.3, h: 1.0, rectRadius: 0.06,
      fill: { color: C.white }, line: { color: C.line }
    });
    slide.addShape(pptx.ShapeType.ellipse, {
      x: 9.52, y: callout.y + 0.25, w: 0.48, h: 0.48,
      fill: { color: callout.pale }, line: { color: callout.pale }
    });
    slide.addText("✓", {
      x: 9.52, y: callout.y + 0.38, w: 0.48, h: 0.14, margin: 0,
      align: "center", fontSize: 12, bold: true, color: callout.color
    });
    slide.addText(callout.title, {
      x: 10.18, y: callout.y + 0.19, w: 2.15, h: 0.25, margin: 0,
      fontSize: 16, bold: true, color: C.ink
    });
    slide.addText(callout.body, {
      x: 10.18, y: callout.y + 0.52, w: 2.05, h: 0.28, margin: 0,
      fontSize: 11.5, color: C.muted, fit: "shrink"
    });
  }
  addFooter(slide, 4, "2:05–2:45");
  addNotes(slide, "Now we open Budget Lab. Nothing connects to GitHub, and all data stays in this browser. The dashboard shows the selected synthetic tenant, its included AI-credit pool, seat charges, paid overage, budget alerts, and blocked events. We can switch between a compact teaching dataset and a larger enterprise dataset without touching a real organization.");
}

// Slide 5
{
  const slide = pptx.addSlide();
  slide.background = { color: C.paper };
  addTitle(slide, "Decision one: continue after included credits?", "A cost-center pool reaches its cap; the next event becomes paid overage.");
  addScreenshot(slide, "paid-overage-focus.png", 0.65, 1.67, 7.18, 4.49);

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 9.25, y: 1.74, w: 3.42, h: 1.3, rectRadius: 0.06,
    fill: { color: C.mintPale }, line: { color: C.mint, width: 1.2 }
  });
  slide.addText("3,900 / 3,900", {
    x: 9.55, y: 2.08, w: 2.8, h: 0.35, margin: 0,
    fontSize: 27, bold: true, color: C.teal, align: "center"
  });
  slide.addText("COST-CENTER INCLUDED CREDITS", {
    x: 9.55, y: 2.57, w: 2.8, h: 0.17, margin: 0,
    fontSize: 9, bold: true, color: C.teal, align: "center", charSpacing: 1.1
  });

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 9.25, y: 3.3, w: 3.42, h: 1.3, rectRadius: 0.06,
    fill: { color: C.violetPale }, line: { color: C.violet, width: 1.2 }
  });
  slide.addText("$24 → 80%", {
    x: 9.55, y: 3.64, w: 2.8, h: 0.35, margin: 0,
    fontSize: 27, bold: true, color: C.violet, align: "center"
  });
  slide.addText("PAID OVERAGE · 75% ALERT FIRES", {
    x: 9.48, y: 4.13, w: 2.94, h: 0.17, margin: 0,
    fontSize: 9, bold: true, color: C.violet, align: "center", charSpacing: 0.8
  });

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 9.25, y: 4.86, w: 3.42, h: 1.02, rectRadius: 0.06,
    fill: { color: C.navy }, line: { color: C.navy }
  });
  slide.addText("Developer continues", {
    x: 9.55, y: 5.13, w: 2.8, h: 0.25, margin: 0,
    fontSize: 19, bold: true, color: C.white, align: "center"
  });
  slide.addText("Funding route and budget movement remain explicit.", {
    x: 9.52, y: 5.48, w: 2.86, h: 0.2, margin: 0,
    fontSize: 10.5, color: "CBD5E1", align: "center", fit: "shrink"
  });
  addFooter(slide, 5, "2:45–4:10");
  addNotes(slide, "Our first lesson enables an included-usage control for the AI Innovation cost center. Alice uses all 3,900 credits attributed to that cost center. At the cap, the policy is configured to continue as paid overage rather than block the developer. Alice then consumes 2,400 additional credits. Budget Lab predicts and applies the result: the event is accepted, $24 is attributed to paid overage, and the $30 cost-center budget reaches 80 percent, crossing its 75-percent alert. This is the shared decision in concrete terms. Maya sees that the developer continues. Daniel sees the exact funding route, affected budgets, and alert before the policy is deployed.");
}

// Slide 6
{
  const slide = pptx.addSlide();
  slide.background = { color: C.paper };
  addTitle(slide, "Decision two: stop at the exact boundary?", "A user-level budget accepts the limit, then rejects the next event atomically.");
  addScreenshot(slide, "hard-stop-focus.png", 0.65, 2.02, 8.18, 3.52);

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 9.25, y: 1.78, w: 3.42, h: 1.24, rectRadius: 0.06,
    fill: { color: C.mintPale }, line: { color: C.mint, width: 1.2 }
  });
  slide.addText("$10.00", {
    x: 9.55, y: 2.08, w: 2.8, h: 0.35, margin: 0,
    fontSize: 29, bold: true, color: C.teal, align: "center"
  });
  slide.addText("EXACT LIMIT · ACCEPTED", {
    x: 9.55, y: 2.55, w: 2.8, h: 0.18, margin: 0,
    fontSize: 9, bold: true, color: C.teal, align: "center", charSpacing: 1.2
  });

  slide.addText("↓  one more credit", {
    x: 9.65, y: 3.19, w: 2.6, h: 0.25, margin: 0,
    fontSize: 14, bold: true, color: C.muted, align: "center"
  });

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 9.25, y: 3.63, w: 3.42, h: 1.24, rectRadius: 0.06,
    fill: { color: C.redPale }, line: { color: C.red, width: 1.2 }
  });
  slide.addText("$10.01", {
    x: 9.55, y: 3.93, w: 2.8, h: 0.35, margin: 0,
    fontSize: 29, bold: true, color: C.red, align: "center"
  });
  slide.addText("WOULD EXCEED · BLOCKED", {
    x: 9.55, y: 4.4, w: 2.8, h: 0.18, margin: 0,
    fontSize: 9, bold: true, color: C.red, align: "center", charSpacing: 1.1
  });

  slide.addShape(pptx.ShapeType.roundRect, {
    x: 9.25, y: 5.15, w: 3.42, h: 0.78, rectRadius: 0.06,
    fill: { color: C.navy }, line: { color: C.navy }
  });
  slide.addText("0 credits consumed  ·  0 counters changed", {
    x: 9.47, y: 5.42, w: 2.98, h: 0.18, margin: 0,
    fontSize: 11.5, bold: true, color: C.white, align: "center", fit: "shrink"
  });
  addFooter(slide, 6, "4:10–5:20");
  addNotes(slide, "The second lesson tests a user-level hard stop. Alice consumes 1,000 credits, worth $10 for this budget, and reaches the limit exactly. That event is accepted. The next event is only one additional credit, but it would move the budget from $10.00 to $10.01. The simulator rejects the complete event, consumes no credits, and changes no counters. Now the interruption is not an abstract fear. Engineering and FinOps can see the exact boundary, the user affected, the reason shown to an operator, and the difference between an alert and a hard stop.");
}

// Slide 7
{
  const slide = pptx.addSlide();
  slide.background = { color: C.navy };
  addPill(slide, "AGREE BEFORE DEPLOYMENT", 0.72, 0.58, C.mintPale, C.teal, 2.35);
  slide.addText("Generate -> simulate -> inspect -> agree.", {
    x: 0.72, y: 1.36, w: 11.75, h: 0.72, margin: 0,
    fontFace: "Aptos Display", fontSize: 42, bold: true, color: C.white
  });
  slide.addText("Turn a policy conversation into a repeatable decision workflow.", {
    x: 0.75, y: 2.2, w: 9.3, h: 0.45, margin: 0,
    fontSize: 20, color: "CBD5E1"
  });

  const stages = [
    { x: 0.75, n: "1", title: "Describe", body: "Tenant, personas, policies, and the question to answer." },
    { x: 3.77, n: "2", title: "Generate", body: "Synthetic environment and deterministic lesson." },
    { x: 6.79, n: "3", title: "Simulate", body: "Run boundaries and inspect every affected control." },
    { x: 9.81, n: "4", title: "Agree", body: "Choose the guardrail before production adoption." }
  ];
  for (const stage of stages) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: stage.x, y: 3.15, w: 2.62, h: 2.05, rectRadius: 0.07,
      fill: { color: "172033" }, line: { color: "334155" }
    });
    slide.addShape(pptx.ShapeType.ellipse, {
      x: stage.x + 0.24, y: 3.43, w: 0.55, h: 0.55,
      fill: { color: C.mint }, line: { color: C.mint }
    });
    slide.addText(stage.n, {
      x: stage.x + 0.24, y: 3.58, w: 0.55, h: 0.16, margin: 0,
      align: "center", fontSize: 12, bold: true, color: C.navy
    });
    slide.addText(stage.title, {
      x: stage.x + 0.24, y: 4.18, w: 2.1, h: 0.3, margin: 0,
      fontSize: 21, bold: true, color: C.white
    });
    slide.addText(stage.body, {
      x: stage.x + 0.24, y: 4.61, w: 2.1, h: 0.42, margin: 0,
      fontSize: 12.5, color: "CBD5E1", fit: "shrink"
    });
  }
  slide.addText("Productive adoption. Predictable spend. Guardrails tested before production.", {
    x: 1.15, y: 5.88, w: 11.05, h: 0.65, margin: 0,
    fontSize: 25, bold: true, align: "center", color: C.mint, fit: "shrink"
  });
  addFooter(slide, 7, "5:20–6:00", true);
  addNotes(slide, "Budget Lab turns a policy conversation into a repeatable workflow: describe the tenant, generate the lesson, simulate the boundary, inspect every affected control, and agree on the guardrail. The result is productive AI adoption without using a surprise invoice as the monitoring system or a blocked developer as the first test case. Understand the rules before the bill arrives.");
}

await mkdir(outputDir, { recursive: true });
await pptx.writeFile({ fileName: outputPath });
console.log(`Generated ${outputPath}`);
