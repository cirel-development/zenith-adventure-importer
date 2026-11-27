/**
 * Offline check for chapter folder assignment in assembleBundle.
 * Run: pnpm --filter @ai-adventure/worker test:chapters
 * Exits non-zero on failure. No network, no AI cost.
 */
import { validateBundle } from '@ai-adventure/contract';
import { assembleBundle } from '../src/bundle/assemble.js';
import { ExtractedAdventureZ } from '../src/pipeline/extractAdventure.js';

const extracted = ExtractedAdventureZ.parse({
  title: 'Chapter Check',
  synopsis: 'x',
  how_to_run: 'x',
  chapters: [
    { name: 'Harvester Camp', slug: 'harvesters-camp', summary: 'a' },
    { name: 'The Breach', slug: 'The Breach', summary: 'b' }, // not a clean slug
    { name: 'Duplicate', slug: 'harvesters-camp', summary: 'c' }, // duplicate slug
  ],
  npcs: [
    { name: 'Good', role: 'r', description: 'd', chapter_slug: 'harvesters-camp' },
    { name: 'Messy', role: 'r', description: 'd', chapter_slug: 'The Breach' },
    { name: 'Ghost', role: 'r', description: 'd', chapter_slug: 'no-such-chapter' },
    { name: 'Global', role: 'r', description: 'd', chapter_slug: null },
  ],
});

const bundle = assembleBundle(extracted, { pdfBytes: new Uint8Array([1, 2, 3]) });
const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures.push(msg);
};

const result = validateBundle(bundle);
check(result.valid, 'bundle validates against contract');
if (!result.valid) console.error(JSON.stringify(result.issues, null, 2));

const folderPaths = new Set(
  bundle.folders.entities.map((f) => (f.parent_path ? `${f.parent_path}/${f.slug}` : f.slug)),
);
const slugs = bundle.folders.entities.map((f) => f.slug);
check(new Set(slugs).size === slugs.length, `folder slugs are unique (${slugs.length})`);
check(slugs.every((s) => !s.includes('/') && s === s.toLowerCase()), 'folder slugs are bare lowercase');

for (const a of bundle.actors.entities) {
  check(!!a.folder && folderPaths.has(a.folder), `actor "${a.name}" folder exists: ${a.folder}`);
}
const folderOf = (name: string) => bundle.actors.entities.find((a) => a.name === name)?.folder ?? '';
check(folderOf('Good').endsWith('/harvesters-camp-actor'), 'Good -> harvesters-camp');
check(folderOf('Messy').endsWith('/the-breach-actor'), 'Messy -> the-breach (normalized)');
check(folderOf('Ghost').endsWith('/overview-actor'), 'Ghost (unknown slug) -> Overview');
check(folderOf('Global').endsWith('/overview-actor'), 'Global (null) -> Overview');

for (const j of bundle.journals.entities) {
  check(!!j.folder && folderPaths.has(j.folder), `journal "${j.name}" folder exists`);
}
for (const p of bundle.playlists.entities) {
  check(!!p.folder && folderPaths.has(p.folder), `playlist "${p.name}" folder exists`);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll chapter folder checks passed');
