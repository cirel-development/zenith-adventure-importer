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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import type { Bundle } from '@ai-adventure/contract';
import { validateBundle, CONTRACT_VERSION } from '@ai-adventure/contract';
import { CompendiumIndex, type CompendiumMatch } from '../src/compendium/index.js';

const INDEX = CompendiumIndex.load();
function requireUuid(m: CompendiumMatch | null): string {
  if (!m) throw new Error('compendium fixture not found in index — rebuild the index?');
  return m.uuid;
}

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
  scenes: `${ADV_SLUG}-scenes`,
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

  // -- Parsed hazard (v0.2.2): hazard extension, reaction, glyph-less Strike.
  {
    slug: 'parsed-hazard',
    name: 'Parsed Test — Rusty Blade Trap',
    category: 'hazard',
    folder: FOLDERS.actors,
    stat_block: {
      ...customStatBlock({ level: 3, rarity: 'common', alignment: 'no-alignment', traits: ['mechanical', 'trap'] }),
      hp: 36,
      ac: 19,
      saves: { fortitude: 12, reflex: 6, will: 0 },
      immunities: ['critical hits', 'object immunities', 'precision damage'],
      strikes: [{ name: 'blade', type: 'melee', attack_bonus: 15, damage_formula: '2d8+6 slashing', traits: [] }],
      actions: [
        {
          name: 'Swinging Blade',
          cost: 'reaction',
          traits: ['attack'],
          trigger: 'A creature steps on the loose stone',
          category: 'offensive',
          description_html: '<p><strong>Trigger</strong> A creature steps on the loose stone</p><p><strong>Effect</strong> The blade attacks that creature.</p>',
        },
      ],
      hazard: {
        stealth_dc: 21,
        stealth_details: '(trained)',
        is_complex: false,
        hardness: 9,
        description_html: '<p>A blade swings from a slot in the wall.</p>',
        disable_html: '<p>@Check[type:thievery|dc:19]{Thievery DC 19} (trained) to jam the slot</p>',
        reset_html: '<p>The blade resets after 1 minute.</p>',
      },
    },
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

  // -- Parsed stat block (Phase 2B task 7) — real values in every shape the
  //    parser produces; the module must map each to PF2e 8.x fields. --------
  {
    slug: 'parsed-full',
    name: 'Parsed Test — Bramble Hound',
    category: 'creature',
    folder: FOLDERS.actors,
    stat_block: {
      ...customStatBlock({ level: 3, size: 'medium', rarity: 'uncommon', traits: ['animal', 'plant'], languages: ['Sylvan'] }),
      hp: 48,
      ac: 19,
      saves: { fortitude: 12, reflex: 9, will: 7 },
      abilities: { str: 4, dex: 2, con: 3, int: -4, wis: 1, cha: -2 },
      perception: 9,
      senses: ['low-light vision', 'scent (imprecise) 30 feet', 'smoke vision'],
      skills: [
        { name: 'Athletics', bonus: 10 },
        { name: 'Stealth', bonus: 8, note: '+10 in forests' },
        { name: 'Forest Lore', bonus: 7 },
      ],
      speeds: { land: 30, climb: 15 },
      immunities: ['poison', 'sleep', 'bramble magic'],
      weaknesses: [{ type: 'axes', value: 5 }, { type: 'cold iron', value: 3 }],
      resistances: [{ type: 'piercing', value: 5 }],
      strikes: [
        { name: 'jaws', type: 'melee', attack_bonus: 12, damage_formula: '1d10+4 piercing plus 1d4 persistent bleed', effects: ['Grab'], traits: ['agile', 'reach 10 feet'] },
        { name: 'thorn', type: 'ranged', attack_bonus: 10, damage_formula: '1d6 piercing', traits: ['range increment 30 feet'] },
        { name: 'seed pod', type: 'ranged', attack_bonus: 10, damage_formula: '', effects: ['sickened 1'], traits: ['thrown 20 feet'] },
      ],
      // Abilities (v0.2.2): one per NPC-sheet section; "notatrait" must be
      // dropped, "once per round" becomes structured frequency.
      actions: [
        {
          name: 'Bramble Hound Aura',
          cost: 'passive',
          traits: ['aura', 'plant'],
          category: 'interaction',
          description_html: '<p>10 feet. Thorns snag at nearby creatures.</p>',
        },
        {
          name: 'Thorn Rebuke',
          cost: 'reaction',
          traits: [],
          trigger: 'A creature hits the hound with a melee Strike',
          category: 'defensive',
          description_html: '<p><strong>Trigger</strong> A creature hits the hound with a melee Strike</p><p><strong>Effect</strong> The attacker takes 1d6 piercing damage.</p>',
        },
        {
          name: 'Seed Burst',
          cost: '2',
          traits: ['plant', 'notatrait'],
          frequency: 'once per round',
          category: 'offensive',
          description_html: '<p><strong>Frequency</strong> once per round</p><p><strong>Effect</strong> Seeds burst in a 10-foot emanation (DC 19 basic Reflex save).</p>',
        },
      ],
      // Printed gear (v0.2.2): runes, quantity + note, material, plain armor.
      inventory: [
        {
          uuid: requireUuid(INDEX.findItemExact('Scimitar')),
          quantity: 1,
          equipped: true,
          name: '+1 Striking Scimitar',
          runes: [
            { type: 'weapon-potency', uuid: requireUuid(INDEX.findItemExact('Weapon Potency (+1)')), rank: 1 },
            { type: 'striking', uuid: requireUuid(INDEX.findItemExact('Striking')), rank: 1 },
          ],
        },
        { uuid: requireUuid(INDEX.findItemExact('Javelin')), quantity: 4, equipped: true, note: 'bundled' },
        { uuid: requireUuid(INDEX.findItemExact('Dagger')), quantity: 1, equipped: true, name: 'Low-Grade Silver Dagger', material: { type: 'silver', grade: 'low' } },
        { uuid: requireUuid(INDEX.findItemExact('Leather Armor')), quantity: 1, equipped: true },
        { uuid: requireUuid(INDEX.findItemExact('Healing Potion (Lesser)')), quantity: 2, equipped: false },
      ],
    },
    ...META,
  },

  // -- Parsed spellcasting — every entry type, linked to spells-srd UUIDs. ----
  {
    slug: 'parsed-caster',
    name: 'Parsed Test — Spellcaster',
    category: 'npc',
    folder: FOLDERS.actors,
    stat_block: {
      ...customStatBlock({ level: 9, size: 'medium', rarity: 'common', traits: ['human', 'humanoid'], languages: ['Common'] }),
      spellcasting: [
        {
          name: 'Primal Innate Spells',
          tradition: 'primal',
          type: 'innate',
          dc: 27,
          attack_bonus: 19,
          spells: {
            '5': [
              { name: 'fireball', uuid: requireUuid(INDEX.findSpell('fireball')), uses: 2 },
              { name: 'truespeech', uuid: requireUuid(INDEX.findSpell('truespeech')), note: 'constant' },
            ],
            '2': [{ name: 'invisibility', uuid: requireUuid(INDEX.findSpell('invisibility')), note: 'at will; self only' }],
            '0': [{ name: 'detect magic', uuid: requireUuid(INDEX.findSpell('detect magic')) }],
            '1': [{ name: 'zenith imaginary spell' }],
          },
        },
        {
          name: 'Arcane Prepared Spells',
          tradition: 'arcane',
          type: 'prepared',
          dc: 26,
          attack_bonus: 18,
          spells: { '3': [{ name: 'haste', uuid: requireUuid(INDEX.findSpell('haste')), uses: 2 }] },
        },
        {
          name: 'Occult Spontaneous Spells',
          tradition: 'occult',
          type: 'spontaneous',
          dc: 25,
          rank_slots: { '1': 3 },
          spells: { '1': [{ name: 'soothe', uuid: requireUuid(INDEX.findSpell('soothe')) }] },
        },
        {
          name: 'Cleric Domain Spells',
          tradition: 'divine',
          type: 'focus',
          dc: 25,
          focus_points: 1,
          spells: { '5': [{ name: "death's call", uuid: requireUuid(INDEX.findSpell("death's call")) }] },
        },
      ],
    },
    ...META,
  },

  // -- Compendium refs (Phase 2B) — UUIDs from the pinned compendium index ----
  {
    slug: 'compendium-npc',
    name: 'Compendium Test — Goblin Warrior',
    category: 'creature',
    folder: FOLDERS.actors,
    stat_block: {
      kind: 'compendium-ref',
      uuid: requireUuid(INDEX.findCreature('Goblin Warrior')),
      version_pin: `pf2e@${INDEX.version}`,
      notes_html: '<p>ZENITH-OVERLAY-NPC: this goblin guards the test bundle.</p>',
    },
    ...META,
  },
  {
    slug: 'compendium-variant',
    name: 'Compendium Test — Goblin Boss (variant)',
    category: 'npc',
    folder: FOLDERS.actors,
    stat_block: {
      kind: 'compendium-ref',
      uuid: requireUuid(INDEX.findCreature('Goblin Warrior')),
      version_pin: `pf2e@${INDEX.version}`,
      overrides: { level: 0, rarity: 'unique', hp: 20, ac: 18, perception: 7, saves: { fortitude: 6, reflex: 9, will: 4 }, skills: [{ name: 'Athletics', bonus: 9 }] },
    },
    ...META,
  },
  {
    slug: 'compendium-weak',
    name: 'Compendium Test — Weak Ghost Commoner',
    category: 'creature',
    folder: FOLDERS.actors,
    stat_block: {
      kind: 'compendium-ref',
      uuid: requireUuid(INDEX.findCreature('Ghost Commoner')),
      version_pin: `pf2e@${INDEX.version}`,
      overrides: { adjustment: 'weak' },
    },
    ...META,
  },
  {
    slug: 'compendium-hazard',
    name: 'Compendium Test — Hidden Pit',
    category: 'hazard',
    folder: FOLDERS.actors,
    stat_block: {
      kind: 'compendium-ref',
      uuid: requireUuid(INDEX.findHazard('Hidden Pit')),
      version_pin: `pf2e@${INDEX.version}`,
      notes_html: '<p>ZENITH-OVERLAY-HAZARD: dug under the test bundle.</p>',
    },
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
  // -- Compendium items (v0.2.1): runes, material, notes overlay. Two rune
  //    items share the Rapier base, so edits to one must not leak into the other.
  ...[
    { slug: 'item-runes-flaming', name: 'Item Test — +2 Greater Striking Flaming Rapier', potency: 2, striking: 2, property: 'Flaming' },
    { slug: 'item-runes-plain', name: 'Item Test — +1 Striking Rapier', potency: 1, striking: 1, property: null },
  ].map((r) => ({
    slug: r.slug,
    name: r.name,
    category: 'weapon' as const,
    folder: FOLDERS.items,
    data: {
      kind: 'compendium-ref-with-runes' as const,
      base_uuid: requireUuid(INDEX.findItemExact('Rapier')),
      runes: [
        { type: 'weapon-potency' as const, uuid: requireUuid(INDEX.findItemExact(`Weapon Potency (+${r.potency})`)), rank: r.potency },
        { type: 'striking' as const, uuid: requireUuid(INDEX.findItemExact(r.striking === 2 ? 'Striking (Greater)' : 'Striking')), rank: r.striking },
        ...(r.property ? [{ type: 'property' as const, uuid: requireUuid(INDEX.findItemExact(r.property)) }] : []),
      ],
      name_override: r.name,
      notes_html: `<p>ZENITH-ITEM-NOTES ${r.slug}</p>`,
    },
    ...META,
  })),
  {
    slug: 'item-material',
    name: 'Item Test — Low-Grade Silver Dagger',
    category: 'weapon',
    folder: FOLDERS.items,
    data: {
      kind: 'compendium-ref',
      uuid: requireUuid(INDEX.findItemExact('Dagger')),
      version_pin: `pf2e@${INDEX.version}`,
      material: { type: 'silver', grade: 'low' },
      notes_html: '<p>ZENITH-ITEM-NOTES item-material</p>',
    },
    ...META,
  },
  {
    slug: 'item-potion',
    name: 'Item Test — Lesser Healing Potion',
    category: 'consumable',
    folder: FOLDERS.items,
    data: {
      kind: 'compendium-ref',
      uuid: requireUuid(INDEX.findItemExact('Healing Potion (Lesser)')),
      version_pin: `pf2e@${INDEX.version}`,
      notes_html: '<p>ZENITH-ITEM-NOTES item-potion</p>',
    },
    ...META,
  },
];

const folders: Bundle['folders']['entities'] = [
  { slug: FOLDERS.actors, name: 'Bug Test Bundle', parent_path: null, type: 'actor', sort: 0 },
  { slug: FOLDERS.items, name: 'Bug Test Bundle', parent_path: null, type: 'item', sort: 0 },
  { slug: FOLDERS.journals, name: 'Bug Test Bundle', parent_path: null, type: 'journal', sort: 0 },
  { slug: FOLDERS.scenes, name: 'Bug Test Bundle', parent_path: null, type: 'scene', sort: 0 },
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

// -- Scene (Foundry v14 keeps the map on the scene's level): one wall with a
//    door, a light, a sound, and a map note pinned to a journal page.
const TEST_MAP = 'images/maps/test-map.png';
const scenes: Bundle['scenes']['entities'] = [
  {
    slug: 'test-scene',
    name: 'Scene Test — Map With Pins',
    folder: FOLDERS.scenes,
    background: TEST_MAP,
    dimensions: { width: 1000, height: 800, padding: 0.25 },
    grid: { type: 'square', size: 100 },
    walls: [
      { c: [0.1, 0.1, 0.9, 0.1], light: 20, move: 20, sight: 20, door: 0, ds: 0 },
      { c: [0.1, 0.5, 0.1, 0.4], light: 20, move: 20, sight: 20, door: 1, ds: 0 },
    ],
    lights: [{ x: 0.5, y: 0.3, config: { dim: 4, bright: 2, color: '#ff9329', alpha: 0.5 } }],
    sounds: [{ x: 0.5, y: 0.5, radius: 6, description: 'Dripping water', easing: true, volume: 0.5 }],
    notes: [{ x: 0.5, y: 0.7, journal_ref: '[[REF:journal:test-overview#how-to-use]]', icon: 'icons/svg/book.svg', icon_size: 40, label: 'Read me' }],
  } as Bundle['scenes']['entities'][number],
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
      scenes: scenes.length,
      journals: journals.length,
      playlists: 0,
      actors: {
        compendium: actors.filter((a) => a.stat_block.kind === 'compendium-ref').length,
        custom: actors.filter((a) => a.stat_block.kind === 'custom').length,
        review_needed: actors.length,
      },
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
  scenes: { entities: scenes },
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
  // A real (tiny) PNG from the sample adventure stands in for a map.
  [TEST_MAP]: readFileSync(join(HERE, '..', '..', 'foundry-module', 'samples', 'the-haunted-mill', 'images', 'maps', 'the-mill.png')),
};

const zipped = zipSync(files);
await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, zipped);

console.log(`✓ Test bundle written: ${OUTPUT_PATH}`);
console.log(`  ${actors.length} actors, ${items.length} items, ${journals.length} journal`);
console.log(`  ${Buffer.byteLength(zipped)} bytes`);
console.log('');
console.log('Import via the Foundry module to verify which fields the module mishandles.');
