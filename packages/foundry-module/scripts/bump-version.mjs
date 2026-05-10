#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PKG_PATH = join(ROOT, 'package.json');
const MOD_PATH = join(ROOT, 'module.json');

const arg = process.argv[2] ?? 'patch';
if (!['major', 'minor', 'patch'].includes(arg)) {
  console.error('Usage: bump-version.mjs [major|minor|patch]');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
let next;
if (arg === 'major') next = `${major + 1}.0.0`;
else if (arg === 'minor') next = `${major}.${minor + 1}.0`;
else next = `${major}.${minor}.${patch + 1}`;

pkg.version = next;
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');

const mod = JSON.parse(readFileSync(MOD_PATH, 'utf8'));
mod.version = next;
writeFileSync(MOD_PATH, JSON.stringify(mod, null, 2) + '\n');

console.log(`bumped ${pkg.version} → ${next}`);
