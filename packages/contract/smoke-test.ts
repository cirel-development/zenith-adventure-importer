import {
  validateBundle,
  CONTRACT_VERSION,
  type Bundle,
} from './src/index.js';

const validBundle: Bundle = {
  manifest: {
    contract_version: CONTRACT_VERSION,
    bundle_id: 'bnd_test1',
    adventure: {
      title: 'Test Adventure',
      slug: 'test-adventure',
      system: 'pf2e',
      level_range: [3, 6],
      party_size: 4,
      source_pdf_hash: 'sha256:' + 'a'.repeat(64),
      imported_at: '2026-05-09T14:32:11Z',
    },
    entities: {
      folders:   'entities/folders.json',
      journals:  'entities/journals.json',
      actors:    'entities/actors.json',
      items:     'entities/items.json',
      scenes:    'entities/scenes.json',
      playlists: 'entities/playlists.json',
    },
    build_order: ['folders', 'journals', 'items', 'actors', 'scenes', 'playlists'],
    stats: {
      scenes: 1,
      journals: 1,
      playlists: 0,
      actors:   { compendium: 1, custom: 0, review_needed: 0 },
      items:    { compendium: 0, custom: 0, review_needed: 0 },
    },
    warnings: [],
  },
  folders: {
    entities: [
      {
        slug: 'test-adventure',
        name: 'Test Adventure',
        parent_path: null,
        type: 'actor',
        sort: 0,
      },
    ],
  },
  journals: {
    entities: [
      {
        slug: 'locations-ch1',
        name: 'Chapter 1 Locations',
        type: 'scene_entry',
        folder: 'test-adventure',
        default_permission: 'none',
        pages: [
          {
            page_type: 'text',
            slug: 'a1-docks',
            name: 'A1. The Docks',
            permission: 'observer',
            content_html: '<p>You arrive. [[REF:actor:captain-marrow]] is here.</p>',
            sort: 0,
          },
        ],
        sort: 0,
      },
    ],
  },
  actors: {
    entities: [
      {
        slug: 'captain-marrow',
        name: 'Captain Marrow',
        category: 'creature',
        folder: 'test-adventure',
        stat_block: {
          kind: 'compendium-ref',
          uuid: 'Compendium.pf2e.bestiary.Actor.captain-marrow',
        },
      },
    ],
  },
  items: { entities: [] },
  scenes: {
    entities: [
      {
        slug: 'a1-docks',
        name: 'A1. The Docks',
        folder: 'test-adventure',
        background: 'images/maps/a1-docks.webp',
        dimensions: { width: 4000, height: 3000, padding: 0.25 },
        grid: { type: 'square', size: 100 },
        walls: [],
        lights: [],
        sounds: [],
        notes: [
          {
            x: 0.5,
            y: 0.5,
            journal_ref: '[[REF:journal:locations-ch1#a1-docks]]',
            icon: 'icons/svg/book.svg',
            icon_size: 40,
          },
        ],
      },
    ],
  },
  playlists: { entities: [] },
};

console.log('Test 1: valid bundle');
const r1 = validateBundle(validBundle);
console.log(`  valid=${r1.valid}, issues=${r1.issues.length}`);
if (!r1.valid) console.log('  ', r1.issues);

console.log('\nTest 2: broken cross-reference');
const broken = JSON.parse(JSON.stringify(validBundle));
broken.journals.entities[0].pages[0].content_html =
  '<p>[[REF:actor:nobody-here]]</p>';
const r2 = validateBundle(broken);
console.log(`  valid=${r2.valid}, issues=${r2.issues.length}`);
console.log(`  ${r2.issues[0]?.code}: ${r2.issues[0]?.message}`);

console.log('\nTest 3: bad slug in actor');
const bad = JSON.parse(JSON.stringify(validBundle));
bad.actors.entities[0].slug = 'BAD_SLUG';
const r3 = validateBundle(bad);
console.log(`  valid=${r3.valid}, issues=${r3.issues.length}`);
console.log(`  ${r3.issues[0]?.code}: ${r3.issues[0]?.path}`);

console.log('\nTest 4: anchor pointing to nonexistent page');
const noAnchor = JSON.parse(JSON.stringify(validBundle));
noAnchor.scenes.entities[0].notes[0].journal_ref =
  '[[REF:journal:locations-ch1#nonexistent]]';
const r4 = validateBundle(noAnchor);
console.log(`  valid=${r4.valid}, issues=${r4.issues.length}`);
console.log(`  ${r4.issues[0]?.code}: ${r4.issues[0]?.message}`);

console.log('\nTest 5: incompatible contract_version');
const wrongVersion = JSON.parse(JSON.stringify(validBundle));
wrongVersion.manifest.contract_version = '0.9';
const r5 = validateBundle(wrongVersion);
console.log(`  valid=${r5.valid}, issues=${r5.issues.length}`);
console.log(`  ${r5.issues[0]?.code}`);
