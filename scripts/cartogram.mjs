#!/usr/bin/env node
/**
 * Cartogram generator for Econ Pub Trivia.
 *
 * Builds non-contiguous cartogram SVGs: every country keeps its real outline but
 * is scaled about its own centroid so that its rendered AREA is proportional to
 * a data value. A faint unscaled world map sits underneath as a geographic
 * reference, which is what makes "guess what is being depicted" solvable.
 *
 * Data comes from the World Bank indicator API and is cached under data/cache/
 * so that `npm run build` never needs the network — only `npm run cartograms`
 * does. Generated SVGs are committed as build artifacts.
 *
 * Usage:
 *   node scripts/cartogram.mjs            # use cache where present
 *   node scripts/cartogram.mjs --refresh  # re-fetch all indicators
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { geoEqualEarth, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import countries from 'i18n-iso-countries';
import topology from 'world-atlas/countries-110m.json' with { type: 'json' };

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const cacheDir = join(root, 'data', 'cache');
const outDir = join(root, 'public', 'img', 'cartograms');
const manifestPath = join(root, 'data', 'cartograms.json');

const WIDTH = 760;
const HEIGHT = 380;
const REFRESH = process.argv.includes('--refresh');

// ── Geometry ────────────────────────────────────────────────────────────────

// Antarctica has no data for any economic indicator and eats ~15% of the
// vertical frame, so drop it and refit — everything else renders larger.
const ANTARCTICA = '010';
const geo = feature(topology, topology.objects.countries);
geo.features = geo.features.filter(f => String(f.id).padStart(3, '0') !== ANTARCTICA);

const projection = geoEqualEarth().fitSize([WIDTH, HEIGHT], geo);

// Measurement path (full precision) for area/centroid maths.
const path = geoPath(projection);

// Output path: same geometry, but (a) coordinates rounded to one decimal, which
// is sub-pixel at this viewBox size, and (b) rings whose bounding box is smaller
// than MIN_RING_PX are dropped. Those are offshore specks that cannot resolve on
// screen but carry a lot of vertices. Both are visually lossless here; global
// simplification is deliberately avoided since 110m outlines are already coarse.
const MIN_RING_PX = 0.7;

function roundingContext(digits = 1) {
  let out = '';       // completed, kept subpaths
  let cur = '';       // subpath being built
  let x0, y0, x1, y1; // bbox of the current subpath
  const r = n => String(+n.toFixed(digits));

  function endRing() {
    if (!cur) return;
    if ((x1 - x0) >= MIN_RING_PX || (y1 - y0) >= MIN_RING_PX) out += cur;
    cur = '';
  }

  return {
    flush() { endRing(); const s = out; out = ''; return s; },
    moveTo(x, y) {
      endRing();
      cur = `M${r(x)},${r(y)}`;
      x0 = x1 = x; y0 = y1 = y;
    },
    lineTo(x, y) {
      cur += `L${r(x)},${r(y)}`;
      if (x < x0) x0 = x; else if (x > x1) x1 = x;
      if (y < y0) y0 = y; else if (y > y1) y1 = y;
    },
    closePath() { cur += 'Z'; },
    arc() {}, // only invoked for point geometry, which we never render
  };
}
const outCtx = roundingContext(1);
const outPath = geoPath(projection, outCtx);

// numeric ISO id -> ISO3, so World Bank rows can be joined to geometry.
// Disputed territories without ISO numeric codes (Kosovo, Somaliland,
// N. Cyprus) have no id and are reference-only.
function iso3of(featureObj) {
  if (featureObj.id == null) return null;
  return countries.numericToAlpha3(String(featureObj.id).padStart(3, '0')) || null;
}

// ── World Bank fetch (cached) ───────────────────────────────────────────────

async function fetchIndicator(indicator, year) {
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, `${indicator}-${year}.json`);

  if (!REFRESH && existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8'));
  }

  const url = `https://api.worldbank.org/v2/country/all/indicator/${indicator}`
    + `?format=json&date=${year}&per_page=400`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`World Bank API ${res.status} for ${indicator}`);
  const body = await res.json();
  if (!Array.isArray(body) || !Array.isArray(body[1]))
    throw new Error(`Unexpected API shape for ${indicator}`);

  // The /country/all endpoint mixes real countries with regional aggregates
  // (World, Arab World, OECD members, income groups...). Aggregates would wreck
  // the proportional scaling, so keep only rows whose ISO3 maps to a real
  // country in the ISO register.
  const values = {};
  for (const row of body[1]) {
    const iso = row.countryiso3code;
    if (!iso || iso.length !== 3) continue;
    if (!countries.alpha3ToNumeric(iso)) continue;
    if (row.value == null) continue;
    values[iso] = row.value;
  }

  writeFileSync(cacheFile, JSON.stringify(values, null, 2));
  console.log(`  fetched ${indicator} ${year} — ${Object.keys(values).length} countries`);
  return values;
}

// ── Cartogram rendering ─────────────────────────────────────────────────────

function renderCartogram(spec, values) {
  // Pre-compute geographic area and centroid per country, in projected pixels.
  const shapes = [];
  for (const f of geo.features) {
    const area = path.area(f);
    const [cx, cy] = path.centroid(f);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    outPath(f);
    const d = outCtx.flush();
    if (!d) continue;
    shapes.push({ d, area, cx, cy, iso: iso3of(f), name: f.properties.name });
  }

  // Assign the <defs> id before any copies are taken below.
  shapes.forEach((s, i) => { s.ref = `p${i}`; });

  const withData = shapes.filter(s => s.iso && values[s.iso] > 0 && s.area > 0);
  const totalValue = withData.reduce((sum, s) => sum + values[s.iso], 0);
  const totalArea = withData.reduce((sum, s) => sum + s.area, 0);

  // Target: rendered area proportional to share of the total value, with the
  // whole cartogram occupying roughly the same area as the real landmass. That
  // keeps the image about as "full" as a normal world map.
  const scaled = withData.map(s => {
    const share = values[s.iso] / totalValue;
    const targetArea = share * totalArea;
    return { ...s, scale: Math.sqrt(targetArea / s.area), value: values[s.iso] };
  });

  // Draw biggest-first so small countries land on top and stay clickable/visible.
  scaled.sort((a, b) => b.scale * b.area - a.scale * a.area);

  // Each outline is emitted once in <defs> and referenced twice (reference
  // layer + scaled layer), which roughly halves the file.
  const defs = shapes.map(s => `<path id="${s.ref}" d="${s.d}"/>`).join('');
  const reference = shapes.map(s => `<use href="#${s.ref}"/>`).join('');
  const bodies = scaled.map(s => {
    const t = `translate(${s.cx.toFixed(1)} ${s.cy.toFixed(1)}) `
      + `scale(${s.scale.toFixed(3)}) `
      + `translate(${(-s.cx).toFixed(1)} ${(-s.cy).toFixed(1)})`;
    return `<use href="#${s.ref}" transform="${t}"><title>${esc(s.name)}</title></use>`;
  }).join('');

  // Colours are chosen to read on both the light (#f5f5f0) and dark (#111)
  // page backgrounds; the media query only nudges contrast.
  // Explicit width/height give the file an intrinsic size and aspect ratio, so
  // the page reserves the right space before the image loads (no layout shift).
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" `
    + `width="${WIDTH}" height="${HEIGHT}" `
    + `role="img" aria-label="${esc(spec.alt)}">`
    + `<style>`
    + `.ref{fill:#d9d9d2;stroke:#9ca3af;stroke-width:.4;opacity:.75}`
    + `.cart{fill:#6366f1;fill-opacity:.75;stroke:#4338ca;stroke-width:.35}`
    + `@media(prefers-color-scheme:dark){`
    + `.ref{fill:#2a2a2a;stroke:#4b5563;opacity:.9}`
    + `.cart{fill:#818cf8;fill-opacity:.78;stroke:#c7d2fe;stroke-width:.3}}`
    + `</style>`
    + `<defs>${defs}</defs>`
    + `<g class="ref">${reference}</g>`
    + `<g class="cart">${bodies}</g>`
    + `</svg>`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Main ────────────────────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
mkdirSync(outDir, { recursive: true });

console.log(`\n=== CARTOGRAM GENERATOR ===`);
console.log(`${manifest.length} map(s)${REFRESH ? ' (refreshing cache)' : ''}\n`);

for (const spec of manifest) {
  console.log(`${spec.id}:`);
  const values = await fetchIndicator(spec.indicator, spec.year);

  const covered = geo.features.filter(f => {
    const iso = iso3of(f);
    return iso && values[iso] > 0;
  }).length;
  if (covered < 100)
    console.warn(`  WARN: only ${covered} countries have data — map may read poorly`);

  const svg = renderCartogram(spec, values);
  const file = join(outDir, `${spec.id}.svg`);
  writeFileSync(file, svg);

  const kb = (Buffer.byteLength(svg) / 1024).toFixed(0);
  console.log(`  wrote public/img/cartograms/${spec.id}.svg — ${covered} countries, ${kb} KB`);

  // Top 8 by value, so question explanations can be fact-checked against the
  // exact numbers the map was drawn from. Units vary by indicator (dollars,
  // tonnes, km2, headcounts), so print raw magnitudes rather than assuming.
  const ranked = Object.entries(values).sort(([, a], [, b]) => b - a);
  const fmt = v => v >= 1e12 ? `${(v / 1e12).toFixed(2)}T`
    : v >= 1e9 ? `${(v / 1e9).toFixed(1)}B`
    : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M`
    : v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  console.log(`  top 8: ${ranked.slice(0, 8).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}`);
  const sum = ranked.reduce((a, [, v]) => a + v, 0);
  console.log(`  top-3 share: ${((ranked.slice(0, 3).reduce((a, [, v]) => a + v, 0) / sum) * 100).toFixed(0)}%`);
}

console.log(`\nDone — ${manifest.length} cartogram(s) in public/img/cartograms/\n`);
