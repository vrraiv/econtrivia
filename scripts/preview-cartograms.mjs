#!/usr/bin/env node
/**
 * Dev helper: rasterize the generated cartogram SVGs to PNG so they can be
 * eyeballed (light and dark background) without opening a browser.
 * Not part of the build — `npm run cartograms:preview`.
 */
import sharp from 'sharp';
import { readFileSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgDir = join(__dirname, '..', 'public', 'img', 'cartograms');
const outDir = process.argv[2] || join(__dirname, '..', '.preview');

mkdirSync(outDir, { recursive: true });

const files = readdirSync(svgDir).filter(f => f.endsWith('.svg'));
for (const f of files) {
  const svg = readFileSync(join(svgDir, f));
  const base = f.replace('.svg', '');
  await sharp(svg, { density: 200 })
    .flatten({ background: '#f5f5f0' })
    .png()
    .toFile(join(outDir, `${base}.png`));
  console.log(`${base}.png`);
}
console.log(`\n${files.length} preview(s) in ${outDir}`);
