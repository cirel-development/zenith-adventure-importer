/**
 * Round-trip test: write a bundle with build-sample.ts, then read it back
 * through the same BundleLoader the Foundry module uses.
 *
 * This is the cheapest possible integration test for "does the importer
 * accept what the generator produces?"
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { validateBundle } from '@ai-adventure/contract';

const HERE = dirname(fileURLToPath(import.meta.url));
const ZIP_PATH = join(HERE, 'the-haunted-mill.zip');

console.log(`Loading ${ZIP_PATH}...`);
const buffer = readFileSync(ZIP_PATH);
const unzipped = unzipSync(buffer);
console.log(`  unzipped ${Object.keys(unzipped).length} files`);

const requireFile = (path: string) => {
  const data = unzipped[path];
  if (!data) throw new Error(`Missing: ${path}`);
  return JSON.parse(strFromU8(data));
};

const result = validateBundle({
  manifest: requireFile('manifest.json'),
  folders: requireFile('entities/folders.json'),
  journals: requireFile('entities/journals.json'),
  actors: requireFile('entities/actors.json'),
  items: requireFile('entities/items.json'),
  scenes: requireFile('entities/scenes.json'),
  playlists: requireFile('entities/playlists.json'),
});

if (!result.valid || !result.bundle) {
  console.error('FAIL: round-trip validation broke');
  for (const issue of result.issues) {
    console.error(`  [${issue.severity}] ${issue.path}: ${issue.message}`);
  }
  process.exit(1);
}

const bundle = result.bundle;
console.log(`  ✓ adventure: ${bundle.manifest.adventure.title}`);
console.log(`  ✓ folders: ${bundle.folders.entities.length}`);
console.log(`  ✓ journals: ${bundle.journals.entities.length} (${bundle.journals.entities.reduce((n, j) => n + j.pages.length, 0)} pages total)`);
console.log(`  ✓ actors: ${bundle.actors.entities.length}`);
console.log(`  ✓ items: ${bundle.items.entities.length}`);
console.log(`  ✓ scenes: ${bundle.scenes.entities.length}`);
console.log(`  ✓ playlists: ${bundle.playlists.entities.length}`);
console.log(`  ✓ assets in zip:`);
for (const path of Object.keys(unzipped)) {
  if (path.startsWith('images/')) {
    console.log(`      ${path} (${unzipped[path]!.length} bytes)`);
  }
}

console.log('\nRound-trip OK. Importer should accept this zip.');
