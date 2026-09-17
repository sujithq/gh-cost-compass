#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createGitHubClient, acquireGitHubEnterprise, normalizeGitHubEnterprise, redactExtractionError } from "../src/github-environment-extractor.js";

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const enterprise = flag("--enterprise");
const output = flag("--output");
const allowPartial = process.argv.includes("--allow-partial");
const preserveIdentity = process.argv.includes("--preserve-identity");
if (!enterprise || !output) {
  console.error("Usage: GITHUB_TOKEN=... node scripts/extract-github-environment.js --enterprise SLUG --output PATH [--allow-partial] [--preserve-identity]");
  process.exitCode = 2;
} else if (!process.env.GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is required at runtime and is never written to the export.");
  process.exitCode = 2;
} else {
  try {
    const client = createGitHubClient({ token: process.env.GITHUB_TOKEN });
    const acquired = await acquireGitHubEnterprise({ client, enterprise });
    if (acquired.failures.length && !allowPartial) {
      console.error(`Extraction is partial (${acquired.failures.length} optional capability failures); rerun with --allow-partial only after reviewing omissions.`);
      process.exitCode = 1;
    } else {
      const environment = normalizeGitHubEnterprise(acquired, { extractionId: enterprise, anonymize: !preserveIdentity });
      try {
        await readFile(output);
        console.error(`Refusing to overwrite existing export: ${output}.`);
        process.exitCode = 1;
      } catch {
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, `${JSON.stringify(environment, null, 2)}\n`, { flag: "wx" });
        console.log(`Wrote ${output}. No GitHub resources were modified.`);
      }
    }
  } catch (error) {
    console.error(redactExtractionError(error, { anonymize: !preserveIdentity }));
    process.exitCode = 1;
  }
}
