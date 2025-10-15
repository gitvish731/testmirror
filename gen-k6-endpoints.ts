// scripts/gen-k6-endpoints.js
/* eslint-disable no-console */
const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');

/* ----------------------------- helpers ----------------------------- */
async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && p.endsWith('.ts')) out.push(p);
  }
  return out;
}
function ensureDirSync(p) {
  const d = path.dirname(p);
  if (!fss.existsSync(d)) fss.mkdirSync(d, { recursive: true });
}
function toFeatureName(filePath) {
  // Fallback if we can’t read from describe("…")
  return path.basename(filePath, '.spec.ts').replace(/[_-]+/g, ' ').trim();
}
function nearAfter(src, startIdx, re) {
  re.lastIndex = startIdx;
  return re.exec(src);
}
function clean(s) {
  return (s || '').trim().replace(/\s+/g, ' ');
}
function extractHeadersAuth(opts) {
  if (!opts) return { headers: undefined, auth: undefined };
  let headers;
  let auth;
  const ct = /content[-_]type["']?\s*:\s*["']([^"']+)["']/i.exec(opts);
  if (ct) headers = { ...(headers || {}), 'Content-Type': ct[1] };
  const authBearer = /authorization["']?\s*:\s*["']\s*bearer\s+[^"']+["']/i.exec(opts);
  if (authBearer) auth = 'bearer';
  return { headers, auth };
}

/* -------------------------- core extraction ------------------------- */
async function parseSpec(absFile) {
  const src = await fs.readFile(absFile, 'utf8');

  // Prefer describe("Feature …")
  const d = /describe\(\s*["'`](.+?)["'`]\s*,/i.exec(src);
  const feature = d ? d[1].trim() : toFeatureName(absFile);

  const endpoints = [];

  // 1) request.METHOD(url[, opts])
  //    <anyVar>.request.METHOD(url[, opts])
  // url can be ', ", or `…${}…` and may span lines → ([\s\S]*?)
  const REQ =
    /\b(?:\w+\.)?request\.(get|post|put|patch|delete)\s*\(\s*(['"`])([\s\S]*?)\2\s*(?:,\s*({[\s\S]*?}))?\s*\)/ig;

  // 2) request.fetch(url, { method: 'POST'|'PUT'|'PATCH'|'DELETE'|'GET', ... })
  const FETCH =
    /\b(?:\w+\.)?request\.fetch\s*\(\s*(['"`])([\s\S]*?)\1\s*,\s*{([\s\S]*?)\}\s*\)/ig;

  // Status assertions near the call site:
  const STATUS_NUM = /expect\(\s*[^)]*status\(\)\s*\)\s*\.\s*(?:toBe|toEqual)\s*\(\s*(\d{3})\s*\)/ig;
  const STATUS_PROP = /expect\(\s*[^)]*\)\s*\.toHaveProperty\(\s*['"]status['"]\s*,\s*(\d{3})\s*\)/ig;
  const OK_TRUTHY = /expect\(\s*[^)]*ok\(\)\s*\)\s*\.toBeTruthy\(\s*\)/ig; // → treat as 200
  const TEXT_CONTAINS = /\.toContain\(\s*(['"`])([^'"`]+)\1\s*\)/ig;

  // Optional test name, nearest previous it("…")
  const IT_ALL = [...src.matchAll(/it\(\s*["'`](.+?)["'`]\s*,/g)];

  function nearestItName(start) {
    let name;
    for (let i = IT_ALL.length - 1; i >= 0; i--) {
      if (IT_ALL[i].index <= start) { name = IT_ALL[i][1]; break; }
    }
    return name;
  }

  // ---- (1) request.METHOD ----
  let m;
  while ((m = REQ.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const url = clean(m[3]);
    const optsRaw = m[4] ? clean(m[4]) : undefined;

    const tail = REQ.lastIndex;
    let status;
    const s1 = nearAfter(src, tail, STATUS_NUM); if (s1) status = Number(s1[1]);
    if (typeof status !== 'number') { const s2 = nearAfter(src, tail, STATUS_PROP); if (s2) status = Number(s2[1]); }
    if (typeof status !== 'number') { const s3 = nearAfter(src, tail, OK_TRUTHY); if (s3) status = 200; }

    const t1 = nearAfter(src, tail, TEXT_CONTAINS);
    const text = t1 ? t1[2] : undefined;

    const { headers, auth } = extractHeadersAuth(optsRaw);

    // Name preference: closest it("…"), else last path segment
    let name = nearestItName(m.index) || `${method} ${url}`;
    if (!nearestItName(m.index)) {
      try { const u = new URL(url); const seg = u.pathname.split('/').filter(Boolean).slice(-1)[0]; if (seg) name = `${method} ${seg}`; } catch { /* keep */ }
    }

    endpoints.push({
      name, method, url,
      ...(headers ? { headers } : {}),
      ...(auth ? { auth } : {}),
      expect: { ...(typeof status === 'number' ? { status } : {}), ...(text ? { text } : {}) }
    });
  }

  // ---- (2) request.fetch with method in options ----
  let f;
  while ((f = FETCH.exec(src)) !== null) {
    const url = clean(f[2]);
    const opts = clean(f[3]);
    const mm = /method\s*:\s*['"`]([a-z]+)['"`]/i.exec(opts);
    if (!mm) continue;
    const method = mm[1].toUpperCase();

    const tail = FETCH.lastIndex;
    let status;
    const s1 = nearAfter(src, tail, STATUS_NUM); if (s1) status = Number(s1[1]);
    if (typeof status !== 'number') { const s2 = nearAfter(src, tail, STATUS_PROP); if (s2) status = Number(s2[1]); }
    if (typeof status !== 'number') { const s3 = nearAfter(src, tail, OK_TRUTHY); if (s3) status = 200; }

    const t1 = nearAfter(src, tail, TEXT_CONTAINS);
    const text = t1 ? t1[2] : undefined;

    const { headers, auth } = extractHeadersAuth(opts);

    let name = nearestItName(f.index) || `${method} ${url}`;
    if (!nearestItName(f.index)) {
      try { const u = new URL(url); const seg = u.pathname.split('/').filter(Boolean).slice(-1)[0]; if (seg) name = `${method} ${seg}`; } catch {}
    }

    endpoints.push({
      name, method, url,
      ...(headers ? { headers } : {}),
      ...(auth ? { auth } : {}),
      expect: { ...(typeof status === 'number' ? { status } : {}), ...(text ? { text } : {}) }
    });
  }

  return { feature, endpoints };
}

/* ----------------------------- writer ------------------------------ */
function writeJs(outPath, byFeature) {
  ensureDirSync(outPath);
  const js =
`// AUTO-GENERATED. Do not edit.
// ESM-safe map for K6 runner; keep exactly this export shape.
const features = ${JSON.stringify(byFeature, null, 2)};
export default features;
`;
  fss.writeFileSync(outPath, js, 'utf8');
}

/* ------------------------------ main ------------------------------- */
(async () => {
  try {
    const ROOT = path.resolve(__dirname, '..');
    const SRC_DIR = path.join(ROOT, 'tests', 'endpoint-tests'); // scope as requested
    const OUT_JS  = path.join(ROOT, 'perf', 'k6', 'sources', 'endpoints.byFeature.js');

    if (!fss.existsSync(SRC_DIR)) {
      console.error(`❌ Not found: ${SRC_DIR}`);
      process.exit(1);
    }

    const files = (await walk(SRC_DIR)).filter(f => f.endsWith('.spec.ts'));
    if (!files.length) {
      console.warn('⚠️  No *.spec.ts files under tests/endpoint-tests');
      process.exit(0);
    }

    const byFeature = {};
    const zero = [];
    let total = 0;

    for (const file of files) {
      const { feature, endpoints } = await parseSpec(file);
      if (!endpoints.length) { zero.push(path.relative(ROOT, file)); continue; }
      byFeature[feature] = (byFeature[feature] || []).concat(endpoints);
      total += endpoints.length;
    }

    writeJs(OUT_JS, byFeature);

    const featCount = Object.keys(byFeature).length;
    console.log(`✅ Generated ${total} endpoints across ${featCount} features → ${path.relative(ROOT, OUT_JS)}`);
    if (zero.length) {
      console.log('\nℹ️  Files with 0 detected requests (inspect these to reach 84):');
      zero.forEach(f => console.log(`   - ${f}`));
    }
  } catch (err) {
    console.error('❌ Generation failed:', err.stack || err);
    process.exit(1);
  }
})();
