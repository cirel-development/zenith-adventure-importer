#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');

function copyRecursive(src, dst) {
  if (!existsSync(src)) return;
  const stat = statSync(src);
  if (stat.isDirectory()) {
    if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyRecursive(join(src, entry), join(dst, entry));
    }
  } else {
    if (!existsSync(dirname(dst))) mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

// Static files that live at module root
copyRecursive(join(ROOT, 'module.json'), join(DIST, 'module.json'));
copyRecursive(join(ROOT, 'templates'), join(DIST, 'templates'));
copyRecursive(join(ROOT, 'lang'), join(DIST, 'lang'));
copyRecursive(
  join(ROOT, 'styles', 'zenith-adventure-importer.css'),
  join(DIST, 'zenith-adventure-importer.css'),
);

// Verify the build emitted the module bundle
const moduleJs = join(DIST, 'module.js');
if (!existsSync(moduleJs)) {
  console.error('verify-build: module.js was not emitted by Vite');
  process.exit(1);
}

const size = statSync(moduleJs).size;
console.log(`verify-build: dist/ ready (module.js = ${(size / 1024).toFixed(1)} KB)`);
