// scripts/gen-k6-endpoints.js
/* eslint-disable no-console */
const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');

/** ---------- tiny utils (no external deps) ---------- */
async function walkTsSpecs(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkTsSpecs(p)));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}
function ensureDirSync(p) {
  const d = path.dirname(p);
  if (!fss.existsSync(d)) fss.mkdirSync(d, { recursive: true });
}
function toFeatureName(filePath) {
  return path.basename(filePath, '.spec.ts')
    .replace(/[_-]/g, ' ')
    .replace(/\s+v?\d+/ig, (m) => ` ${m.trim()}`)
    .trim();
}

/** ---------- parsing helpers (heuristic) ---------- */
function cleanBodyString(s) {
  if (!s) return undefined;
  const t = s.trim();
  // keep braces/quotes but collapse whitespace inside
  return t.replace(/\s+/g, ' ');
}

function nearestAfter(src, startIdx, regex) {
  regex.lastIndex = startIdx;
  const m = regex.exec(src);
  return m;
}

function extractHeaders(optsSrc) {
  if (!optsSrc) return { headers: undefined, auth: undefined };
  // Very light heuristics
  let headers = undefined;
  let auth = undefined;

  // Content-Type
  const CT = /content[-_]type["']?\s*:\s*["']([^"']+)["']/i.exec(optsSrc);
  if (CT) headers = { ...(headers || {}), 'Content-Type': CT[1] };

  // Authorization
  const AUTH = /authorization["']?\s*:\s*["']bearer\s+[^"']+["']/i.exec(optsSrc);
  if (AUTH) auth = 'bearer';

  return { headers, auth };
}

/** ---------- Core extractor per file ---------- */
async function parseFile(absFile) {
  const src = await fs.readFile(absFile, 'utf8');

  // feature from first describe("…")
  let featureName = null;
  const DM = /describe\(\s*["'`](.+?)["'`]\s*,/i.exec(src);
  if (DM) featureName = DM[1].trim();
  if (!featureName) featureName = toFeatureName(absFile);

  const endpoints = [];

  // request.<method>(url, [opts]) — light parser
  const REQ = /request\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2\s*(?:,\s*({[\s\S]*?}))?\s*\)/ig;
  // status / toBe(200) or toEqual(200)
  const STATUS_NEAR = /expect\([^)]*status[^)]*\)\s*\.\s*(?:toBe|toEqual)\s*\(\s*(\d{3})\s*\)/ig;
  // .toContain("text")
  const TEXT_NEAR = /\.toContain\(\s*(['"`])([^'"`]+)\1\s*\)/ig;

  let m;
  while ((m = REQ.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const url = m[3].trim();
    const optsRaw = m[4] ? cleanBodyString(m[4]) : undefined;

    const tailIdx = REQ.lastIndex;
    const statusM = nearestAfter(src, tailIdx, STATUS_NEAR);
    const textM = nearestAfter(src, tailIdx, TEXT_NEAR);

    const status = statusM ? Number(statusM[1]) : undefined;
    const text = textM ? textM[2] : undefined;

    const { headers, auth } = extractHeaders(optsRaw);

    // name heuristic: method + url path last segment (or file test hint)
    let name = `${method} ${url}`;
    try {
      const u = new URL(url);
      const seg = u.pathname.split('/').filter(Boolean).slice(-1)[0] || u.pathname;
      name = seg ? `${method} ${seg}` : name;
    } catch (_) { /* leave as is for non-URL patterns */ }

    const ep = {
      name,
      method,
      url,
      ...(headers ? { headers } : {}),
      ...(auth ? { auth } : {}),
      expect: {
        ...(typeof status === 'number' ? { status } : {}),
        ...(text ? { text } : {}),
      },
    };

    endpoints.push(ep);
  }

  return { featureName, endpoints };
}

/** ---------- writer helpers ---------- */
function writeJson(outPath, obj) {
  ensureDirSync(outPath);
  fss.writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function writeTs(outPath, byFeature) {
  ensureDirSync(outPath);
  const ts =
`// AUTO-GENERATED. Do not edit by hand.
// From Playwright endpoint tests -> typed K6 feature map
export type Method = 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
export type Endpoint = {
  name: string;
  method: Method;
  url: string;
  headers?: Record<string,string>;
  auth?: 'bearer';
  expect: { status?: number; text?: string };
};
export const ENDPOINTS_BY_FEATURE: Record<string, Endpoint[]> = ${JSON.stringify(byFeature, null, 2)}; 
`;
  fss.writeFileSync(outPath, ts, 'utf8');
}
function writeJs(outPath, byFeature) {
  ensureDirSync(outPath);
  const js =
`// AUTO-GENERATED. Do not edit by hand.
// Pure ESM-safe default export shape expected by the runner(s).
const features = ${JSON.stringify(byFeature, null, 2)};
export default features;
`;
  fss.writeFileSync(outPath, js, 'utf8');
}

/** ---------- main ---------- */
(async function main() {
  try {
    const ROOT = path.resolve(__dirname, '..');
    const SRC_DIR = path.join(ROOT, 'tests', 'endpoint-tests'); // <- scope to endpoint-tests only
    const OUT_DIR = path.join(ROOT, 'perf', 'k6', 'sources');

    if (!fss.existsSync(SRC_DIR)) {
      console.error(`❌ Source folder not found: ${SRC_DIR}`);
      process.exit(1);
    }

    const files = (await walkTsSpecs(SRC_DIR)).filter(f => f.endsWith('.spec.ts'));
    if (!files.length) {
      console.warn('⚠️  No *.spec.ts files found under tests/endpoint-tests');
      process.exit(0);
    }

    const byFeature = {};
    let total = 0;

    for (const file of files) {
      const { featureName, endpoints } = await parseFile(file);
      if (!endpoints.length) continue;
      if (!byFeature[featureName]) byFeature[featureName] = [];
      byFeature[featureName].push(...endpoints);
      total += endpoints.length;
    }

    // outputs
    const jsonPath = path.join(OUT_DIR, 'endpoints.byFeature.json');
    const tsPath   = path.join(OUT_DIR, 'endpoints.byFeature.ts');
    const jsPath   = path.join(OUT_DIR, 'endpoints.byFeature.js');

    writeJson(jsonPath, byFeature);
    writeTs(tsPath, byFeature);
    writeJs(jsPath, byFeature);

    const featCount = Object.keys(byFeature).length;
    console.log(`✅ Generated ${total} endpoints across ${featCount} features →`);
    console.log(`   - ${path.relative(ROOT, jsonPath)}`);
    console.log(`   - ${path.relative(ROOT, tsPath)}`);
    console.log(`   - ${path.relative(ROOT, jsPath)}`);
  } catch (err) {
    console.error('❌ Generation failed:', err.stack || err);
    process.exit(1);
  }
})();
