/* eslint-disable no-console */
// CommonJS, Node 16+/18+
//
// Default: writes ONLY perf/k6/sources/endpoints.byFeature.js
// Opt-in flags:
//   --with-json   also write endpoints.byFeature.json
//   --with-ts     also write endpoints.byFeature.ts
//   --all         same as both flags
//
// Run:
//   node scripts/gen-k6-endpoints.js
//   node scripts/gen-k6-endpoints.js --all

const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');

const WANT_JSON = process.argv.includes('--with-json') || process.argv.includes('--all');
const WANT_TS   = process.argv.includes('--with-ts')   || process.argv.includes('--all');

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
  const dir = path.dirname(p);
  if (!fssync.existsSync(dir)) fssync.mkdirSync(dir, { recursive: true });
}
function toFeatureName(filePath) {
  return path.basename(filePath, '.ts').replace(/\.specs?$/i, '').trim();
}
function cleanBodyString(s) {
  if (!s) return undefined;
  return s.trim().replace(/\s+/g, ' ');
}
function findMatchingParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

async function parseFile(file) {
  const src = await fs.readFile(file, 'utf8');

  // capture titles from it(...) and test(...)
  const TITLES = [];
  const TITLE_RE = /\b(?:it|test)\(\s*["'`](.+?)["'`]\s*,/g;
  let t;
  while ((t = TITLE_RE.exec(src)) !== null) TITLES.push({ name: t[1], index: t.index });
  const nearestTitle = (idx) => {
    for (let i = TITLES.length - 1; i >= 0; i--) if (TITLES[i].index <= idx) return TITLES[i].name;
    return undefined;
  };

  const endpoints = [];

  // A) request.METHOD('url', [opts])
  const CALL_RE = /\brequest\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^"'`]+)\2/gi;
  let m;
  while ((m = CALL_RE.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const url = m[3];

    const openIdx = src.indexOf('(', m.index + m[0].indexOf('('));
    const closeIdx = findMatchingParen(src, openIdx);
    const argList = src.slice(openIdx + 1, closeIdx);

    let headers = {};
    let body = null;
    let auth;
    let status, text;

    const afterUrl = argList.replace(/^\s*(["'`].+?["'`])\s*,?/, '').trim();
    if (afterUrl.startsWith('{')) {
      // capture top-level opts object
      let depth = 0, end = -1;
      for (let i = 0; i < afterUrl.length; i++) {
        const ch = afterUrl[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      const opts = afterUrl.slice(0, end);

      const HDR_RE = /headers\s*:\s*\{([\s\S]*?)\}/i;
      const hm = HDR_RE.exec(opts);
      if (hm) {
        const hdrBlock = hm[1];
        const CT_RE = /['"]content-type['"]\s*:\s*['"]([^'"]+)['"]/i;
        const ctm = CT_RE.exec(hdrBlock);
        if (ctm) headers['Content-Type'] = ctm[1];
        const AUTH_RE = /['"]authorization['"]\s*:\s*['"]Bearer\s+([^'"]+)['"]/i;
        if (AUTH_RE.test(hdrBlock)) auth = 'bearer';
      }

      const DATA_RE = /\b(?:data|body)\s*:\s*([^\n}]+|\{[\s\S]*?\}|\[[\s\S]*?\])/i;
      const dm = DATA_RE.exec(opts);
      if (dm) body = cleanBodyString(dm[1]);
    }

    const tail = src.slice(closeIdx, closeIdx + 600);
    const STATUS_RE = /expect\s*\(\s*response\s*\.\s*status\s*\)\s*\.toBe\s*\(\s*(\d{3})\s*\)/i;
    const TEXT_RE   = /expect\s*\(\s*text\s*\)\s*\.toContain\s*\(\s*['"]([^'"]+)['"]\s*\)/i;
    const sm = STATUS_RE.exec(tail);
    const xm = TEXT_RE.exec(tail);
    if (sm) status = Number(sm[1]);
    if (xm) text = xm[1];

    let name = nearestTitle(m.index);
    if (!name) name = `${method} ${url}`;

    endpoints.push({
      name, method, url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(auth ? { auth } : {}),
      expect: { ...(status ? { status } : {}), ...(text ? { text } : {}) },
      ...(body ? { body } : {}),
    });
  }

  // B) request.fetch('url', { method, ... })
  const FETCH_RE = /\brequest\.fetch\s*\(\s*(['"`])([^"'`]+)\1\s*,\s*\{([\s\S]*?)\}\s*\)/gi;
  let f;
  while ((f = FETCH_RE.exec(src)) !== null) {
    const url = f[2];
    const opts = f[3];

    let method = 'GET';
    const METH_RE = /\bmethod\s*:\s*['"]([A-Za-z]+)['"]/i;
    const mm = METH_RE.exec(opts);
    if (mm) method = mm[1].toUpperCase();

    const headers = {};
    const CT_RE = /['"]content-type['"]\s*:\s*['"]([^'"]+)['"]/i;
    const ctm = CT_RE.exec(opts);
    if (ctm) headers['Content-Type'] = ctm[1];

    let auth;
    const AUTH_RE = /['"]authorization['"]\s*:\s*['"]Bearer\s+([^'"]+)['"]/i;
    if (AUTH_RE.exec(opts)) auth = 'bearer';

    let body = null;
    const BODY_RE = /\b(?:data|body)\s*:\s*([^\n}]+|\{[\s\S]*?\}|\[[\s\S]*?\])/i;
    const bm = BODY_RE.exec(opts);
    if (bm) body = cleanBodyString(bm[1]);

    const tail = src.slice(f.index + f[0].length, f.index + f[0].length + 600);
    const STATUS_RE = /expect\s*\(\s*response\s*\.\s*status\s*\)\s*\.toBe\s*\(\s*(\d{3})\s*\)/i;
    const TEXT_RE   = /expect\s*\(\s*text\s*\)\s*\.toContain\s*\(\s*['"]([^'"]+)['"]\s*\)/i;

    const sm = STATUS_RE.exec(tail);
    const xm = TEXT_RE.exec(tail);

    let name = nearestTitle(f.index);
    if (!name) name = `${method} ${url}`;

    endpoints.push({
      name, method, url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(auth ? { auth } : {}),
      expect: { ...(sm ? { status: Number(sm[1]) } : {}), ...(xm ? { text: xm[1] } : {}) },
      ...(body ? { body } : {}),
    });
  }

  return endpoints;
}

(async function main() {
  try {
    const ROOT = process.cwd();
    const TEST_ROOT = path.join(ROOT, 'tests', 'endpoint-tests');

    const files = (fssync.existsSync(TEST_ROOT)) ? (await walk(TEST_ROOT)) : [];
    if (!files.length) {
      console.warn(`No *.ts test files found under ${TEST_ROOT}`);
      process.exit(0);
    }

    const byFeature = {};
    for (const file of files) {
      const feature = toFeatureName(file);
      const eps = await parseFile(file);
      if (!eps.length) continue;
      if (!byFeature[feature]) byFeature[feature] = [];
      byFeature[feature].push(...eps);
    }

    const OUT_DIR = path.join(ROOT, 'perf', 'k6', 'sources');
    ensureDirSync(OUT_DIR);

    const BASE = 'endpoints.byFeature'; // <<< Capital F everywhere

    // .js (always)
    const jsPath = path.join(OUT_DIR, `${BASE}.js`);
    const js = [
      '// AUTO-GENERATED — K6 ESM compatible (JS-only mode)',
      'const features = ' + JSON.stringify(byFeature, null, 2) + ';',
      '',
      'export default features;',
      '',
    ].join('\n');
    await fs.writeFile(jsPath, js, 'utf8');

    // optional extras
    if (WANT_JSON) {
      const jsonPath = path.join(OUT_DIR, `${BASE}.json`);
      await fs.writeFile(jsonPath, JSON.stringify(byFeature, null, 2), 'utf8');
    }
    if (WANT_TS) {
      const tsPath = path.join(OUT_DIR, `${BASE}.ts`);
      const ts = [
        '// AUTO-GENERATED from Playwright specs',
        'export type Method = \'GET\' | \'POST\' | \'PUT\' | \'PATCH\' | \'DELETE\';',
        'export type Endpoint = {',
        '  name: string;',
        '  method: Method;',
        '  url: string;',
        '  headers?: Record<string,string>;',
        '  auth?: \'bearer\';',
        '  expect: { status?: number; text?: string; };',
        '  body?: string;',
        '};',
        'export const ENDPOINTS_BY_FEATURE: Record<string, Endpoint[]> = ' +
          JSON.stringify(byFeature, null, 2) + ';',
        '',
      ].join('\n');
      await fs.writeFile(tsPath, ts, 'utf8');
    }

    const featCount = Object.keys(byFeature).length;
    const epCount = Object.values(byFeature).reduce((a, v) => a + v.length, 0);

    console.log(`✅ Generated ${epCount} endpoints across ${featCount} features →`);
    console.log(`  - perf/k6/sources/${BASE}.js`);
    if (WANT_JSON) console.log(`  - perf/k6/sources/${BASE}.json`);
    if (WANT_TS)   console.log(`  - perf/k6/sources/${BASE}.ts`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
