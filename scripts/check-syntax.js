// Verifica la sintaxis de todos los .js del proyecto (sin node_modules) con `node --check`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'uploads', 'scratch', '.agent']);

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
};

let failed = 0;
for (const file of walk(ROOT)) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`Sintaxis invalida: ${path.relative(ROOT, file)}\n${err.stderr}`);
  }
}
if (failed) process.exit(1);
console.log('Sintaxis OK');
