/* eslint-disable no-console */
const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');

// ---------- tiny utils (no external deps) ----------
async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.isFile() && p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function ensureDirSync(p) {
  const dir = path.dirname(p);
  if (!fssync.existsSync(dir)) fssync.mkdirSync(dir, { recursive: true });
}

function toFeatureName(filePath) {
  const base = path.basename(filePath, '.ts')         // e.g. ReportingAPIAlpha1.spec
    .replace(/\.spec$/i, '')                          // -> ReportingAPIAlpha1
    .trim();
  // Insert spaces between words/numbers: "ReportingAPIAlpha1" => "ReportingAPI Alpha1"
  return base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanBodyString(s) {
  if (!s) return undefined;
  // Drop surrounding braces if clearly a JSON object, but keep content
  const trimmed = s.trim();
  // Cosmetic: collapse whitespace but keep quotes/braces
  return trimmed.replace(/\s+/g, ' ');
}

// Find the matching closing parenthesis index for a call starting at openIdx
function findMatchingParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------- Core extraction per file ----------
async function parseFile(file) {
  const src = await fs.readFile(file, 'utf8');

  // collect (name, startIdx) for tests so we can attach a human name
  const testNameMatches = [];
  const TEST_NAME_RE = /test\s*\(\s*(['"`])([^'"`]+)\1/g;
  let m;
  while ((m = TEST_NAME_RE.exec(src)) !== null) {
    testNameMatches.push({ name: m[2], idx: m.index });
  }

  // find request.<method>('url', { ... })
  const CALL_RE = /request\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2/gi;
  const endpoints = [];
  let cm;
  while ((cm = CALL_RE.exec(src)) !== null) {
    const method = cm[1].toUpperCase();
    const url = cm[3];

    // find full call text to capture options object (headers/data) if present
    const openIdx = src.indexOf('(', cm.index); // first '(' after request.<m>
    const closeIdx = findMatchingParen(src, openIdx);
    const callText = closeIdx > openIdx ? src.slice(openIdx + 1, closeIdx) : '';

    // options object is the 2nd argument if it begins with '{'
    let opts = '';
    const afterUrl = callText.replace(/^\s*(['"`]).*?\1\s*,?/, s => {
      // removes the first argument (the url literal) incl. trailing comma
      return '';
    }).trim();

    if (afterUrl.startsWith('{')) {
      // naive brace match just for the top-level object
      let depth = 0, end = 0;
      for (let i = 0; i < afterUrl.length; i++) {
        const ch = afterUrl[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }
      opts = afterUrl.slice(0, end);
    }

    // headers: detect content-type
    let contentType = null;
    const CT_RE = /['"]content-type['"]\s*:\s*['"]([^'"]+)['"]/i;
    const ct = CT_RE.exec(opts);
    if (ct) contentType = ct[1];

    // body: prefer "data: {...}" block (Playwright pattern)
    let body = null;
    const DATA_RE = /data\s*:\s*(\{[\s\S]*?\})(?=[,}])/i;
    const dm = DATA_RE.exec(opts);
    if (dm) body = cleanBodyString(dm[1]);

    // expectations: status + optional text .toContain(...)
    let status;
    const STATUS_RE = /expect\s*\(\s*response\s*\.\s*status\s*\(\s*\)\s*\)\s*\.?\s*toBe\s*\(\s*(\d{3})\s*\)/gi;
    let sm;
    while ((sm = STATUS_RE.exec(src)) !== null) {
      // choose the nearest status that appears after call site (simple heuristic)
      if (sm.index > cm.index) { status = Number(sm[1]); break; }
    }

    let text;
    const TEXT_RE = /expect\s*\(\s*text\s*\)\s*\.?\s*toContain\s*\(\s*(['"`])([^'"`]+)\1\s*\)/gi;
    let tm;
    while ((tm = TEXT_RE.exec(src)) !== null) {
      if (tm.index > cm.index) { text = tm[2]; break; }
    }

    // test name: nearest preceding test("name", ...)
    let name = '';
    for (let i = testNameMatches.length - 1; i >= 0; i--) {
      if (testNameMatches[i].idx <= cm.index) { name = testNameMatches[i].name; break; }
    }
    if (!name) name = `${method} ${url}`;

    // headers object for output
    const headers = {};
    if (contentType && method !== 'GET') headers['Content-Type'] = contentType;

    const ep = {
      name,
      method,
      url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(body ? { body } : {}),
      auth: /^(POST|PATCH|DELETE)$/i.test(method) ? 'bearer' : undefined,
      expect: {}
    };
    if (typeof status === 'number') ep.expect.status = status;
    if (typeof text === 'string')   ep.expect.text   = text;
    if (!Object.keys(ep.expect).length) delete ep.expect;
    if (!ep.auth) delete ep.auth;

    endpoints.push(ep);
  }

  return endpoints;
}

// ---------- Main ----------
(async () => {
  try {
    const root = process.cwd();
    const srcDir = path.join(root, 'tests', 'endpoint-tests');
    if (!fssync.existsSync(srcDir)) {
      console.error(`❌ Not found: ${srcDir}`);
      process.exit(1);
    }

    const files = await walk(srcDir);
    const byFeature = {}; // Record<string, Endpoint[]>

    for (const file of files) {
      const feature = toFeatureName(file);
      const eps = await parseFile(file);
      if (!eps.length) continue;
      byFeature[feature] ||= [];
      byFeature[feature].push(...eps);
    }

    // write JSON (for the JS runner)
    const outJson = path.join(root, 'perf', 'k6', 'sources', 'endpoints.byFeature.json');
    ensureDirSync(outJson);
    await fs.writeFile(outJson, JSON.stringify(byFeature, null, 2), 'utf8');

    // optional TS view for humans/IDE
    const outTs = path.join(root, 'perf', 'k6', 'sources', 'endpoints.byFeature.ts');
    const ts = `// AUTO-GENERATED from Playwright specs. Keep full URL. Bodies are pre-trimmed. Auth header injected at runtime for POST/PATCH/DELETE.
export type Endpoint = {
  name: string;
  method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
  url: string;
  headers?: Record<string,string>;
  body?: any;
  auth?: 'bearer';
  expect?: { status?: number; text?: string };
};
export const ENDPOINTS_BY_FEATURE: Record<string, Endpoint[]> = ${JSON.stringify(byFeature, null, 2)};
`;
    ensureDirSync(outTs);
    await fs.writeFile(outTs, ts, 'utf8');

    // stats
    const total = Object.values(byFeature).reduce((n, a) => n + a.length, 0);
    const features = Object.keys(byFeature).length;
    console.log(`✅ Generated ${total} endpoints across ${features} features →`);
    console.log(`   - ${path.relative(root, outJson)}`);
    console.log(`   - ${path.relative(root, outTs)}`);
  } catch (err) {
    console.error('❌ Generator failed:', err && err.stack || err);
    process.exit(1);
  }
})();
