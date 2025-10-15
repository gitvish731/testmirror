// gen-k6-endpoints.js
// Generates endpoints.byFeature.json, endpoints.byFeature.ts, and endpoints.byFeature.js

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function ensureDirSync(p) {
  const dir = path.dirname(p);
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
}

function toFeatureName(filePath) {
  return path.basename(filePath, ".ts").replace(/\.specs?/, "").trim();
}

function cleanBodyString(s) {
  if (!s) return undefined;
  const trimmed = s.trim();
  return trimmed.replace(/\s+/g, " ");
}

function findMatchingParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

async function parseFile(file) {
  const src = await fs.readFile(file, "utf8");
  const TEST_NAME_RE = /test\s*\(\s*["'`](.*?)["'`]/g;
  const CALL_RE =
    /request\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
  const tests = [];
  const testNameMatches = [];
  let m;
  while ((m = TEST_NAME_RE.exec(src)) !== null)
    testNameMatches.push({ name: m[1], idx: m.index });

  while ((m = CALL_RE.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const url = m[2];
    const openIdx = src.indexOf("(", m.index);
    const closeIdx = findMatchingParen(src, openIdx);
    const callText = src.slice(openIdx + 1, closeIdx);

    let name = testNameMatches.find(t => t.idx < m.index)?.name || `${method} ${url}`;
    let status = 200;
    const STATUS_RE = /expect.*status.*?(\d{3})/g;
    const statusMatch = STATUS_RE.exec(src);
    if (statusMatch) status = Number(statusMatch[1]);

    tests.push({ name, method, url, expect: { status } });
  }

  return tests;
}

async function main() {
  try {
    const ROOT = process.cwd();
    const TEST_DIR = path.join(ROOT, "tests");
    const OUT_DIR = path.join(ROOT, "perf/k6/sources");
    const files = await walk(TEST_DIR);

    const byFeature = {};
    for (const f of files) {
      const feature = toFeatureName(f);
      const endpoints = await parseFile(f);
      if (endpoints.length) byFeature[feature] = endpoints;
    }

    ensureDirSync(path.join(OUT_DIR, "endpoints.byFeature.json"));
    await fs.writeFile(
      path.join(OUT_DIR, "endpoints.byFeature.json"),
      JSON.stringify(byFeature, null, 2)
    );

    const tsOut =
      "export default " + JSON.stringify(byFeature, null, 2).replace(/"(\w+)":/g, "$1:") + ";";
    await fs.writeFile(path.join(OUT_DIR, "endpoints.byFeature.ts"), tsOut, "utf8");

    const jsOut =
      "export default " + JSON.stringify(byFeature, null, 2).replace(/"(\w+)":/g, "$1:") + ";";
    await fs.writeFile(path.join(OUT_DIR, "endpoints.byFeature.js"), jsOut, "utf8");

    console.log(
      `✅ Generated ${Object.keys(byFeature).length} features → endpoints.byFeature.json/.ts/.js`
    );
  } catch (err) {
    console.error("❌ Error:", err);
  }
}

await main();
