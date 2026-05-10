/**
 * Generates a small sample bundle for testing the importer end-to-end.
 *
 * This script is the integration test for the contract → bundle → importer
 * pipeline. If the contract validator accepts the output, the importer should
 * accept it too.
 *
 * Usage:
 *   npx tsx samples/build-sample.ts
 *
 * Output: samples/the-haunted-mill.zip
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import {
  validateBundle,
  CONTRACT_VERSION,
  type Bundle,
} from '@ai-adventure/contract';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(HERE, 'the-haunted-mill');

// ============================================================================
// Compendium UUIDs — replace with values from your installed PF2e
// ============================================================================
// To get these, paste this into Foundry's F12 console:
//
//   const monster = await game.packs.get('pf2e.pathfinder-monster-core').getDocuments();
//   console.log('Goblin Warrior:', monster.find(m => m.name === 'Goblin Warrior')?.uuid);
//   const equip = await game.packs.get('pf2e.equipment-srd').getDocuments();
//   console.log('Dagger:', equip.find(i => i.name === 'Dagger')?.uuid);
//   console.log('Striking:', equip.find(i => i.name === 'Striking')?.uuid);
//
// If a constant is left as `null`, the corresponding test entity is skipped.
const COMPENDIUM_UUIDS = {
  goblinWarrior: 'Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4',
  dagger: 'Compendium.pf2e.equipment-srd.Item.rQWaJhI5Bko5x14Z',
  strikingRune: 'Compendium.pf2e.equipment-srd.Item.DxCuJKynlnMQZHgp',
};

// ============================================================================
// Build the bundle in memory
// ============================================================================

// Build actors: always include Old Tom, optionally include compendium-ref entries
function buildActorEntities() {
  const entities: Bundle['actors']['entities'] = [
    {
      slug: 'old-tom',
      name: 'Old Tom',
      category: 'npc',
      folder: 'haunted-mill-actors',
      portrait: 'images/portraits/old-tom.png',
      token_image: 'images/portraits/old-tom.png',
      token_config: {
        disposition: 'neutral',
        scale: 1,
        unlinked: false,
      },
      stat_block: {
        kind: 'custom',
        level: 0,
        size: 'medium',
        rarity: 'common',
        alignment: 'NG',
        traits: ['humanoid', 'human'],
        languages: ['Common'],
        hp: 8,
        ac: 13,
        saves: { fortitude: 4, reflex: 2, will: 6 },
        abilities: { str: 1, dex: 0, con: 2, int: 1, wis: 3, cha: 0 },
        perception: 4,
        senses: [],
        skills: [
          { name: 'Crafting', bonus: 6 },
          { name: 'Survival', bonus: 5 },
        ],
        speeds: { land: 25 },
        immunities: [],
        weaknesses: [],
        resistances: [],
        strikes: [
          {
            name: 'Iron poker',
            type: 'melee',
            attack_bonus: 5,
            damage_formula: '1d6+1 piercing',
            traits: [],
          },
        ],
        actions: [
          {
            name: 'Recall the ritual',
            cost: '1',
            traits: ['concentrate', 'mental'],
            description_html:
              "<p>Tom recalls the cultists' chant in detail, possibly identifying their faction.</p>",
          },
        ],
        spellcasting: [],
        inventory: [],
        tactics_html:
          '<p>Tom does not fight. He hides behind cover and shouts warnings to the PCs.</p>',
      },
      linked_journal: '[[REF:journal:npcs#old-tom]]',
      ai_metadata: {
        confidence: 0.9,
        source_page: 4,
        extracted_at: new Date().toISOString(),
        prompt_version: 'sample-handwritten',
        review_required: false,
        review_reasons: [],
      },
    },
  ];

  // Test 1: compendium-ref with a working UUID — exercises the happy path
  if (COMPENDIUM_UUIDS.goblinWarrior) {
    entities.push({
      slug: 'sample-goblin',
      name: 'Goblin Warrior',
      category: 'creature',
      folder: 'haunted-mill-actors',
      stat_block: {
        kind: 'compendium-ref',
        uuid: COMPENDIUM_UUIDS.goblinWarrior,
      },
    });
  }

  // Test 2: compendium-ref with a deliberately broken UUID + correct name —
  // exercises the name-fallback path. The pack name in the URL must still be
  // valid; only the document ID is broken.
  if (COMPENDIUM_UUIDS.goblinWarrior) {
    const broken = COMPENDIUM_UUIDS.goblinWarrior.replace(
      /\.[\w-]+$/,
      '.deliberatelyBrokenId',
    );
    entities.push({
      slug: 'drift-test-goblin',
      name: 'Goblin Warrior',
      category: 'creature',
      folder: 'haunted-mill-actors',
      stat_block: {
        kind: 'compendium-ref',
        uuid: broken,
      },
    });
  }

  return entities;
}

// Build items: always include Cult Amulet, optionally include compendium-ref entries
function buildItemEntities() {
  const entities: Bundle['items']['entities'] = [
    {
      slug: 'cult-amulet',
      name: 'Cult Amulet',
      category: 'magic_item',
      folder: 'haunted-mill-items',
      data: {
        kind: 'custom',
        item_type: 'equipment',
        level: 2,
        rarity: 'uncommon',
        traits: ['evil', 'invested', 'magical'],
        bulk: 'L',
        price_cp: 4000, // 4 gp
        description_html:
          '<p>A black iron pendant inscribed with the symbol of the cult that menaced [[REF:journal:npcs#old-tom]]. Wearing it suppresses fear effects but may be detected by paladins.</p>',
        effects: [],
        requires_investiture: true,
      },
      ai_metadata: {
        confidence: 0.85,
        source_page: 4,
        review_required: false,
        review_reasons: [],
      },
    },
  ];

  // Test 3: plain compendium-ref item — should resolve directly
  if (COMPENDIUM_UUIDS.dagger) {
    entities.push({
      slug: 'sample-dagger',
      name: 'Dagger',
      category: 'weapon',
      folder: 'haunted-mill-items',
      data: {
        kind: 'compendium-ref',
        uuid: COMPENDIUM_UUIDS.dagger,
      },
    });
  }

  // Test 4: compendium-ref-with-runes — base dagger + striking rune.
  // Exercises the rune application path that's never been tested.
  if (COMPENDIUM_UUIDS.dagger && COMPENDIUM_UUIDS.strikingRune) {
    entities.push({
      slug: 'striking-dagger',
      name: 'Striking Dagger',
      category: 'weapon',
      folder: 'haunted-mill-items',
      data: {
        kind: 'compendium-ref-with-runes',
        base_uuid: COMPENDIUM_UUIDS.dagger,
        runes: [
          {
            type: 'striking',
            uuid: COMPENDIUM_UUIDS.strikingRune,
            rank: 1,
          },
        ],
      },
    });
  }

  return entities;
}

const bundle: Bundle = {
  manifest: {
    contract_version: CONTRACT_VERSION,
    bundle_id: 'bnd_samplehauntedmill',
    adventure: {
      title: 'The Haunted Mill',
      slug: 'the-haunted-mill',
      system: 'pf2e',
      level_range: [1, 3],
      party_size: 4,
      source_pdf_hash: 'sha256:' + 'a'.repeat(64),
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
    build_order: [
      'folders',
      'journals',
      'items',
      'actors',
      'scenes',
      'playlists',
    ],
    stats: {
      scenes: 2,
      journals: 3,
      playlists: 2,
      actors: { compendium: 0, custom: 1, review_needed: 0 },
      items: { compendium: 0, custom: 1, review_needed: 0 },
    },
    warnings: [],
  },

  // ----- Folders: a top-level adventure folder with subfolders for each type -----
  folders: {
    entities: [
      // Actor folder
      {
        slug: 'haunted-mill-actors',
        name: 'The Haunted Mill',
        parent_path: null,
        type: 'actor',
        sort: 0,
      },
      // Item folder
      {
        slug: 'haunted-mill-items',
        name: 'The Haunted Mill',
        parent_path: null,
        type: 'item',
        sort: 0,
      },
      // Playlist folder
      {
        slug: 'haunted-mill-playlists',
        name: 'The Haunted Mill',
        parent_path: null,
        type: 'playlist',
        sort: 0,
      },
      // Scene folder
      {
        slug: 'haunted-mill-scenes',
        name: 'The Haunted Mill',
        parent_path: null,
        type: 'scene',
        sort: 0,
      },
      // Journal folders (top-level + chapter subfolder)
      {
        slug: 'haunted-mill-journals',
        name: 'The Haunted Mill',
        parent_path: null,
        type: 'journal',
        sort: 0,
      },
      {
        slug: 'overview',
        name: '00 - Overview',
        parent_path: 'haunted-mill-journals',
        type: 'journal',
        sort: 0,
      },
      {
        slug: 'locations',
        name: '01 - Locations',
        parent_path: 'haunted-mill-journals',
        type: 'journal',
        sort: 100,
      },
    ],
  },

  // ----- Journals: overview + locations + a single NPC profile -----
  journals: {
    entities: [
      {
        slug: 'adventure-overview',
        name: 'The Haunted Mill — Overview',
        type: 'instructional',
        folder: 'haunted-mill-journals/overview',
        default_permission: 'none',
        pages: [
          {
            page_type: 'text',
            slug: 'synopsis',
            name: 'Synopsis',
            permission: 'observer',
            sort: 0,
            content_html:
              '<h2>Synopsis</h2>' +
              '<p>The mill outside town has been abandoned for ten years. Strange lights and sounds have been spotted in the past week. The miller, Old Tom, has not been seen.</p>' +
              '<p>The PCs are hired by the village elder to investigate. Their first stop should be [[REF:scene:the-mill]]. From there, secret stairs lead to [[REF:scene:the-cellar]].</p>',
          },
          {
            page_type: 'text',
            slug: 'how-to-run',
            name: 'How to Run This',
            permission: 'none',
            sort: 100,
            content_html:
              '<h2>How to Run</h2>' +
              '<p>This is a one-shot designed for a single 3-4 hour session. The key reveal is that Old Tom is not a ghost — see [[REF:journal:npcs#old-tom]] for the truth.</p>',
          },
        ],
      },
      {
        slug: 'locations',
        name: 'Locations',
        type: 'scene_entry',
        folder: 'haunted-mill-journals/locations',
        default_permission: 'observer',
        pages: [
          {
            page_type: 'text',
            slug: 'the-mill',
            name: 'The Mill',
            permission: 'observer',
            sort: 0,
            content_html:
              '<h2>The Mill</h2>' +
              '<p><em>The waterwheel turns slowly in the moonlight. The door hangs open on broken hinges.</em></p>' +
              '<p>Inside: dust, cobwebs, and a heavy trapdoor leading down to [[REF:scene:the-cellar]]. The trapdoor is locked (DC 18 Thievery to pick).</p>',
          },
          {
            page_type: 'text',
            slug: 'the-cellar',
            name: 'The Cellar',
            permission: 'observer',
            sort: 100,
            content_html:
              '<h2>The Cellar</h2>' +
              '<p><em>A damp room lined with shelves. A figure stands in the corner, holding a candle.</em></p>' +
              '<p>This is [[REF:journal:npcs#old-tom]]. He is alive, hiding from cultists who tried to recruit him last week.</p>',
          },
        ],
        scene_pin: {
          scene_slug: 'the-mill',
          x: 0.5,
          y: 0.5,
          page_slug: 'the-mill',
        },
      },
      {
        slug: 'npcs',
        name: 'NPCs',
        type: 'npc_profile',
        folder: 'haunted-mill-journals',
        default_permission: 'none',
        pages: [
          {
            page_type: 'image',
            slug: 'old-tom-portrait',
            name: 'Old Tom',
            permission: 'observer',
            sort: 0,
            image: 'images/portraits/old-tom.png',
            caption: 'Old Tom, the missing miller',
          },
          {
            page_type: 'text',
            slug: 'old-tom',
            name: 'Old Tom — Profile',
            permission: 'none',
            sort: 100,
            content_html:
              '<h2>Old Tom</h2>' +
              '<p><strong>Public knowledge:</strong> Tom is the miller. He is not a ghost. He has been missing for a week.</p>' +
              '<p><strong>Secrets:</strong> Tom witnessed cultists performing a ritual at [[REF:scene:the-cellar]] and has been hiding ever since. He will trust the PCs after they prove they are not cultists.</p>',
          },
        ],
      },
    ],
  },

  // ----- Actors: Old Tom (custom) + optional compendium-ref test entities -----
  actors: {
    entities: buildActorEntities(),
  },

  // ----- Items: a single custom magic item -----
  items: {
    entities: buildItemEntities(),
  },

  // ----- Two scenes: the mill (above) and the cellar (below) -----
  scenes: {
    entities: [
      {
        slug: 'the-mill',
        name: 'The Mill',
        folder: 'haunted-mill-scenes',
        background: 'images/maps/the-mill.png',
        dimensions: { width: 2000, height: 1500, padding: 0.25 },
        grid: { type: 'square', size: 100 },
        walls: [
          // Outline walls — square room
          {
            c: [0.1, 0.1, 0.9, 0.1],
            light: 20,
            move: 20,
            sight: 20,
            door: 0,
            ds: 0,
          },
          {
            c: [0.9, 0.1, 0.9, 0.9],
            light: 20,
            move: 20,
            sight: 20,
            door: 0,
            ds: 0,
          },
          {
            c: [0.9, 0.9, 0.1, 0.9],
            light: 20,
            move: 20,
            sight: 20,
            door: 0,
            ds: 0,
          },
          {
            c: [0.1, 0.9, 0.1, 0.5],
            light: 20,
            move: 20,
            sight: 20,
            door: 0,
            ds: 0,
          },
          // Door at x=0.1, y=0.5
          {
            c: [0.1, 0.5, 0.1, 0.4],
            light: 20,
            move: 20,
            sight: 20,
            door: 1,
            ds: 0,
          },
          {
            c: [0.1, 0.4, 0.1, 0.1],
            light: 20,
            move: 20,
            sight: 20,
            door: 0,
            ds: 0,
          },
        ],
        lights: [
          {
            x: 0.5,
            y: 0.3,
            config: {
              dim: 4,
              bright: 2,
              color: '#ff9329',
              alpha: 0.5,
              animation: { type: 'torch', speed: 3, intensity: 3 },
            },
          },
        ],
        sounds: [
          {
            x: 0.5,
            y: 0.5,
            radius: 8,
            description:
              'Creaking wood and the slow turning of the waterwheel outside',
            easing: true,
            volume: 0.5,
          },
        ],
        notes: [
          {
            x: 0.5,
            y: 0.7,
            journal_ref: '[[REF:journal:locations#the-mill]]',
            icon: 'icons/svg/book.svg',
            icon_size: 40,
            label: 'Read me',
          },
        ],
      },
      {
        slug: 'the-cellar',
        name: 'The Cellar',
        folder: 'haunted-mill-scenes',
        background: 'images/maps/the-cellar.png',
        dimensions: { width: 1600, height: 1600, padding: 0.25 },
        grid: { type: 'square', size: 100 },
        walls: [
          {
            c: [0.15, 0.15, 0.85, 0.15],
            light: 20,
            move: 20,
            sight: 20,
            door: 0,
            ds: 0,
          },
          {
            c: [0.85, 0.15, 0.85, 0.85],
            light: 20,
            move: 20,
            sight: 20,
            door: 0,
            ds: 0,
          },
          {
            c: [0.85, 0.85, 0.15, 0.85],
            light: 20,
            move: 20,
            sight: 20,
            door: 0,
            ds: 0,
          },
          {
            c: [0.15, 0.85, 0.15, 0.15],
            light: 20,
            move: 20,
            sight: 20,
            door: 0,
            ds: 0,
          },
        ],
        lights: [
          {
            x: 0.7,
            y: 0.7,
            config: {
              dim: 2,
              bright: 1,
              color: '#ffe0a0',
              alpha: 0.6,
            },
          },
        ],
        sounds: [],
        notes: [
          {
            x: 0.7,
            y: 0.7,
            journal_ref: '[[REF:journal:locations#the-cellar]]',
            icon: 'icons/svg/book.svg',
            icon_size: 40,
          },
        ],
      },
    ],
  },

  playlists: {
    entities: [
      {
        slug: 'ambience',
        name: 'The Haunted Mill — Ambience',
        folder: 'haunted-mill-playlists',
        mode: 'sequential',
        description:
          'Slow, eerie atmospheric tracks: creaking wood, distant water, occasional whispers',
      },
      {
        slug: 'combat',
        name: 'The Haunted Mill — Combat',
        folder: 'haunted-mill-playlists',
        mode: 'shuffle',
        description: 'Tense, building combat tracks',
      },
    ],
  },
};

// ============================================================================
// Validate against the contract
// ============================================================================

// Report which compendium-ref tests are active
console.log('Compendium-ref test coverage:');
console.log(`  Goblin Warrior:   ${COMPENDIUM_UUIDS.goblinWarrior ? 'enabled' : 'skipped (no UUID configured)'}`);
console.log(`  Drift fallback:   ${COMPENDIUM_UUIDS.goblinWarrior ? 'enabled' : 'skipped'}`);
console.log(`  Plain dagger:     ${COMPENDIUM_UUIDS.dagger ? 'enabled' : 'skipped (no UUID configured)'}`);
console.log(`  Runed dagger:     ${COMPENDIUM_UUIDS.dagger && COMPENDIUM_UUIDS.strikingRune ? 'enabled' : 'skipped'}`);
console.log('');

console.log('Validating bundle against contract...');
const result = validateBundle(bundle);
if (!result.valid) {
  console.error('VALIDATION FAILED:');
  for (const issue of result.issues) {
    console.error(`  [${issue.severity}] ${issue.path}: ${issue.message}`);
  }
  process.exit(1);
}
console.log('  ✓ valid');

// ============================================================================
// Pack into a zip with images + JSON
// ============================================================================

console.log('\nPacking zip...');
const files: Record<string, Uint8Array> = {
  'manifest.json': strToU8(JSON.stringify(bundle.manifest, null, 2)),
  'entities/folders.json': strToU8(JSON.stringify(bundle.folders, null, 2)),
  'entities/journals.json': strToU8(JSON.stringify(bundle.journals, null, 2)),
  'entities/actors.json': strToU8(JSON.stringify(bundle.actors, null, 2)),
  'entities/items.json': strToU8(JSON.stringify(bundle.items, null, 2)),
  'entities/scenes.json': strToU8(JSON.stringify(bundle.scenes, null, 2)),
  'entities/playlists.json': strToU8(JSON.stringify(bundle.playlists, null, 2)),
};

// Walk image asset paths referenced by the bundle and pull them from disk
const imageAssets = [
  'images/maps/the-mill.png',
  'images/maps/the-cellar.png',
  'images/portraits/old-tom.png',
];
for (const path of imageAssets) {
  const fullPath = join(SAMPLE_DIR, path);
  files[path] = readFileSync(fullPath);
}

const zipped = zipSync(files, { level: 9 });
const outPath = join(HERE, 'the-haunted-mill.zip');
writeFileSync(outPath, zipped);

const size = statSync(outPath).size;
console.log(`  ✓ wrote ${outPath} (${(size / 1024).toFixed(1)} KB)`);
console.log('\nDone. Upload this zip via the Import Adventure dialog to test.');
