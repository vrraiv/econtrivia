#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Validate first — exits with code 1 on errors
try {
  execSync('node scripts/validate.mjs', { cwd: root, stdio: 'inherit' });
} catch {
  process.exit(1);
}

// Merge all question files
const questionsDir = join(root, 'questions');
const files = readdirSync(questionsDir).filter(f => f.endsWith('.json')).sort();
const all = [];
for (const file of files) {
  const arr = JSON.parse(readFileSync(join(questionsDir, file), 'utf8'));
  all.push(...arr);
}

mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(join(root, 'public', 'questions.json'), JSON.stringify(all));
console.log(`\nBuilt public/questions.json — ${all.length} questions.`);
