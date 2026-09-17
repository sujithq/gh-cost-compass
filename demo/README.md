# Six-minute Budget Lab demo

This folder contains a synchronized presentation and browser recording script for:

> **Copilot Budget Lab: understand the rules before the bill arrives.**

The story follows an engineering lead who wants uninterrupted developer flow and a FinOps lead
who wants predictable usage-based spending. The demo uses synthetic data only and shows:

1. The Default Set Generator describing a deterministic tenant.
2. The Scenario Generator describing a reusable lesson.
3. A cost-center included pool reaching its cap and continuing as $24 of paid overage.
4. A user-level budget reaching exactly 100%, followed by an atomically blocked event.

## Generate the PowerPoint deck

```powershell
cd demo
npm install
npm run deck
```

The deck is written to `demo/output/copilot-budget-lab-six-minute-demo.pptx`. Speaker notes carry
the complete six-minute narration and match the recording scenes.

## Record the app walkthrough

The recorder first uses an installed Microsoft Edge or Google Chrome browser. To force a channel:

```powershell
$env:PLAYWRIGHT_CHANNEL = "msedge"
```

If neither browser is installed, install Playwright's bundled Chromium once with
`npx playwright install chromium`. Then create the full six-minute, silent WebM recording with
on-screen narration:

```powershell
npm run record
```

For a roughly 15-second rehearsal that exercises the same flow:

```powershell
npm run record:fast
```

The script starts the Budget Lab server, records at 1440 × 900, and writes the result to
`demo/output/copilot-budget-lab-six-minute-demo.webm`. The full narration is also available in
`narration.md` for a live presenter or a separate voice-over track.
