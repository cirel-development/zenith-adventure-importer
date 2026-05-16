/**
 * Builds a hand-crafted contract-valid bundle that exercises every Foundry-side
 * mapping concern we can think of, then writes it to a zip. Import the zip in
 * Foundry and check whether each entity renders correctly — every miss
 * indicates a bug in the foundry-module's builder code.
 *
 * What this exercises (each entity named so you can match a bug to its actor):
 *
 *   • rarity-common         Vilm-like creature, rarity='common'
 *   • rarity-uncommon       same, rarity='uncommon'
 *   • rarity-rare           same, rarity='rare'
 *   • rarity-unique         same, rarity='unique'     ← key test
 *   • alignment-ce          alignment='CE' set
 *   • alignment-lg          alignment='LG' set
 *   • alignment-none        alignment='no-alignment'  ← Remaster style
 *   • category-npc          category='npc'
 *   • category-creature     category='creature'
 *   • category-hazard       category='hazard'         ← should become Hazard, not Creature
 *   • category-loot         category='loot'
 *   • notes-with-text       tactics_html populated, should appear in Notes tab
 *   • notes-with-rolls      tactics_html contains @Check and @Damage inline syntax
 *   • traits-multi          traits=['fey', 'gremlin', 'incorporeal'] — three trait tags expected
 *   • size-tiny / size-huge  edges of the size enum
 *   • language-mix          languages=['Common', 'Sylvan', 'Undercommon']
 *
 *  Also one item with all required fields to confirm the item path still works.
 *
 * Run:
 *
 *   pnpm --filter @ai-adventure/worker test:bundle
 *
 * Bundle lands at packages/worker/test-bundle.zip — import via the Foundry module.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import type { Bundle } from '@ai-adventure/contract';
import { validateBundle, CONTRACT_VERSION } from '@ai-adventure/contract';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(HERE, '..', 'test-bundle.zip');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bundleId(): string {
  return `bnd_test${Math.random().toString(36).slice(2, 10)}`;
}

function pdfHash(): string {
  // Contract requires `sha256:<64-hex-chars>`. Hash of a fake "synthetic" buffer.
  const digest = createHash('sha256').update('synthetic-test-bundle').digest('hex');
  return `sha256:${digest}`;
}

// Minimal builder that returns one custom stat block with overrides applied.
function customStatBlock(opts: {
  level?: number;
  size?: 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan';
  rarity?: 'common' | 'uncommon' | 'rare' | 'unique';
  alignment?:
    | 'LG' | 'NG' | 'CG' | 'LN' | 'N' | 'CN' | 'LE' | 'NE' | 'CE'
    | 'no-alignment';
  traits?: string[];
  languages?: string[];
  notes?: string;
}) {
  const level = opts.level ?? 1;
  return {
    kind: 'custom' as const,
    level,
    size: opts.size ?? 'medium',
    rarity: opts.rarity ?? 'common',
    alignment: opts.alignment ?? 'N',
    traits: opts.traits ?? ['humanoid'],
    languages: opts.languages ?? ['Common'],
    hp: 10 + level * 5,
    ac: 10 + level,
    saves: { fortitude: level, reflex: level, will: level },
    abilities: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
    perception: level,
    senses: [],
    skills: [],
    speeds: { land: 25 },
    immunities: [],
    weaknesses: [],
    resistances: [],
    strikes: [],
    actions: [],
    spellcasting: [],
    inventory: [],
    tactics_html:
      opts.notes ?? '<p>Default test notes — if this shows in the Notes tab the mapping works.</p>',
  };
}

const META = {
  ai_metadata: {
    confidence: 0.5,
    extracted_at: new Date().toISOString(),
    prompt_version: 'test-harness-1',
    review_required: true,
    review_reasons: ['Test bundle — placeholder stats by design.'],
  },
};

// ---------------------------------------------------------------------------
// Build the bundle
// ---------------------------------------------------------------------------

const ADV_SLUG = 'test-bundle-2a';
const FOLDERS = {
  actors: `${ADV_SLUG}-actors`,
  items: `${ADV_SLUG}-items`,
  journals: `${ADV_SLUG}-journals`,
  playlists: `${ADV_SLUG}-playlists`,
};

const actors: Bundle['actors']['entities'] = [
  // -- Rarity series ---------------------------------------------------------
  {
    slug: 'rarity-common',
    name: 'Rarity Test — Common',
    category: 'creature',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({ rarity: 'common', traits: ['fey'] }),
    ...META,
  },
  {
    slug: 'rarity-uncommon',
    name: 'Rarity Test — Uncommon',
    category: 'creature',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({ rarity: 'uncommon', traits: ['fey'] }),
    ...META,
  },
  {
    slug: 'rarity-rare',
    name: 'Rarity Test — Rare',
    category: 'creature',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({ rarity: 'rare', traits: ['fey'] }),
    ...META,
  },
  {
    slug: 'rarity-unique',
    name: 'Rarity Test — Unique',
    category: 'npc',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({ rarity: 'unique', traits: ['fey'] }),
    ...META,
  },

  // -- Alignment series ------------------------------------------------------
  {
    slug: 'alignment-ce',
    name: 'Alignment Test — CE',
    category: 'creature',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({ alignment: 'CE', traits: ['fey', 'gremlin'] }),
    ...META,
  },
  {
    slug: 'alignment-lg',
    name: 'Alignment Test — LG',
    category: 'npc',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({ alignment: 'LG', traits: ['humanoid'] }),
    ...META,
  },
  {
    slug: 'alignment-none',
    name: 'Alignment Test — None (Remaster)',
    category: 'creature',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({ alignment: 'no-alignment', traits: ['beast'] }),
    ...META,
  },

  // -- Category series -------------------------------------------------------
  {
    slug: 'category-npc',
    name: 'Category Test — NPC',
    category: 'npc',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({ rarity: 'unique' }),
    ...META,
  },
  {
    slug: 'category-creature',
    name: 'Category Test — Creature',
    category: 'creature',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({ rarity: 'common' }),
    ...META,
  },
  {
    slug: 'category-hazard',
    name: 'Category Test — Hazard',
    category: 'hazard',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({
      rarity: 'common',
      alignment: 'no-alignment',
      traits: ['mechanical', 'trap'],
      notes: '<p>This should be a <strong>Hazard</strong>-type actor, not a Creature. If it shows as Creature 2, the foundry-module always-NPC bug is confirmed.</p>',
    }),
    ...META,
  },

  // -- Notes (tactics_html) tests --------------------------------------------
  {
    slug: 'notes-plain',
    name: 'Notes Test — Plain Text',
    category: 'npc',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({
      notes: '<p>If you can read this paragraph in the actor\'s <em>Notes</em> tab, tactics_html mapping works.</p>',
    }),
    ...META,
  },
  {
    slug: 'notes-with-rolls',
    name: 'Notes Test — Inline Rolls',
    category: 'npc',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({
      notes:
        '<p>This NPC tests inline rolls. Save: @Check[type:fortitude|dc:18|basic:true]. Damage: @Damage[2d10[bludgeoning]]. Skill: @Check[type:nature|dc:20].</p>',
    }),
    ...META,
  },

  // -- Trait, size, language coverage ----------------------------------------
  {
    slug: 'traits-three',
    name: 'Traits Test — Three Tags',
    category: 'creature',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({
      traits: ['fey', 'gremlin', 'incorporeal'],
      alignment: 'CE',
      rarity: 'rare',
    }),
    ...META,
  },
  {
    slug: 'size-tiny',
    name: 'Size Test — Tiny',
    category: 'creature',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({ size: 'tiny' }),
    ...META,
  },
  {
    slug: 'size-huge',
    name: 'Size Test — Huge',
    category: 'creature',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({ size: 'huge' }),
    ...META,
  },
  {
    slug: 'language-mix',
    name: 'Language Test — Mix',
    category: 'npc',
    folder: FOLDERS.actors,
    stat_block: customStatBlock({
      languages: ['Common', 'Sylvan', 'Undercommon'],
    }),
    ...META,
  },
];

const items: Bundle['items']['entities'] = [
  {
    slug: 'item-test-magic',
    name: 'Item Test — Magic Item',
    category: 'magic_item',
    folder: FOLDERS.items,
    data: {
      kind: 'custom',
      item_type: 'equipment',
      level: 5,
      rarity: 'uncommon',
      traits: ['magical', 'cursed'],
      bulk: 'L',
      price_cp: 25000, // 250 gp = 25000 cp
      description_html:
        '<p>If you can read this description with the inline roll @Damage[2d10[bludgeoning]] rendering as a button, item description handling works.</p>',
      effects: [],
      requires_investiture: false,
    } as Bundle['items']['entities'][number]['data'],
    ai_metadata: {
      confidence: 0.5,
      extracted_at: new Date().toISOString(),
      prompt_version: 'test-harness-1',
      review_required: false,
      review_reasons: [],
    },
  },
];

const folders: Bundle['folders']['entities'] = [
  { slug: FOLDERS.actors, name: 'Bug Test Bundle', parent_path: null, type: 'actor', sort: 0 },
  { slug: FOLDERS.items, name: 'Bug Test Bundle', parent_path: null, type: 'item', sort: 0 },
  { slug: FOLDERS.journals, name: 'Bug Test Bundle', parent_path: null, type: 'journal', sort: 0 },
  { slug: FOLDERS.playlists, name: 'Bug Test Bundle', parent_path: null, type: 'playlist', sort: 0 },
];

const journals: Bundle['journals']['entities'] = [
  {
    slug: 'test-overview',
    name: 'Bug Test Bundle — Overview',
    type: 'instructional',
    folder: FOLDERS.journals,
    sort: 0,
    default_permission: 'observer',
    pages: [
      {
        page_type: 'text',
        slug: 'how-to-use',
        name: 'How to use this bundle',
        sort: 0,
        permission: 'observer',
        content_html: `
          <h1>Bug Test Bundle</h1>
          <p>This bundle was generated by <code>packages/worker/tests/build-test-bundle.ts</code>.
          Open each actor in the <strong>Bug Test Bundle</strong> folder of your Actors sidebar
          and check whether the sheet matches what its name claims.</p>
          <h2>Verification checklist</h2>
          <ul>
            <li><strong>Rarity Test — Unique</strong> should show a <em>Unique</em> rarity tag
            (not Common).</li>
            <li><strong>Alignment Test — CE</strong> should show a <em>CE</em> alignment indicator.</li>
            <li><strong>Category Test — Hazard</strong> should be a Hazard-type actor (not Creature 2).</li>
            <li><strong>Notes Test — Plain Text</strong> should have visible paragraph text in
            its Notes tab.</li>
            <li><strong>Notes Test — Inline Rolls</strong> should have clickable @Check / @Damage buttons.</li>
            <li><strong>Traits Test — Three Tags</strong> should show three trait tags.</li>
          </ul>
        `,
      },
    ],
  },
];

const bundle: Bundle = {
  manifest: {
    contract_version: CONTRACT_VERSION,
    bundle_id: bundleId(),
    adventure: {
      title: 'Phase 2A Bug Test Bundle',
      slug: ADV_SLUG,
      system: 'pf2e',
      level_range: [1, 5],
      party_size: 4,
      source_pdf_hash: pdfHash(),
      imported_at: new Date().toISOString(),
    },
    entities: {
      folders: 'entities/folders.json',
      journals: 'entities/journals.json',
      actors: 'entities/actors.json',
      items: 'entities/items.json',
      scenes: 'entities/scenes.json',
      playlists: 'entities/playlists.json',
    },
    build_order: ['folders', 'journals', 'items', 'actors', 'scenes', 'playlists'],
    stats: {
      scenes: 0,
      journals: journals.length,
      playlists: 0,
      actors: { compendium: 0, custom: actors.length, review_needed: actors.length },
      items: { compendium: 0, custom: items.length, review_needed: 0 },
    },
    warnings: [
      {
        kind: 'partial_extraction',
        message:
          'Test bundle: placeholder stats by design. See the overview journal for the verification checklist.',
      },
    ],
  },
  folders: { entities: folders },
  journals: { entities: journals },
  actors: { entities: actors },
  items: { entities: items },
  scenes: { entities: [] },
  playlists: { entities: [] },
};

// ---------------------------------------------------------------------------
// Validate, zip, write
// ---------------------------------------------------------------------------

const result = validateBundle(bundle);
if (!result.valid) {
  console.error('✗ Bundle failed contract validation:');
  console.error(JSON.stringify(result.issues, null, 2));
  process.exit(1);
}
console.log('✓ Bundle validates against contract');

const files: Record<string, Uint8Array> = {
  'manifest.json': strToU8(JSON.stringify(bundle.manifest, null, 2)),
  'entities/folders.json': strToU8(JSON.stringify(bundle.folders, null, 2)),
  'entities/journals.json': strToU8(JSON.stringify(bundle.journals, null, 2)),
  'entities/actors.json': strToU8(JSON.stringify(bundle.actors, null, 2)),
  'entities/items.json': strToU8(JSON.stringify(bundle.items, null, 2)),
  'entities/scenes.json': strToU8(JSON.stringify(bundle.scenes, null, 2)),
  'entities/playlists.json': strToU8(JSON.stringify(bundle.playlists, null, 2)),
};

const zipped = zipSync(files);
await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, zipped);

console.log(`✓ Test bundle written: ${OUTPUT_PATH}`);
console.log(`  ${actors.length} actors, ${items.length} items, ${journals.length} journal`);
console.log(`  ${Buffer.byteLength(zipped)} bytes`);
console.log('');
console.log('Import via the Foundry module to verify which fields the module mishandles.');
