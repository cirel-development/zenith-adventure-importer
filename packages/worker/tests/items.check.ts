/**
 * Offline checks for PF2e item matching (compendium/items.ts) and its wiring
 * into assembleBundle. Uses the real compendium index. No network, no AI.
 * Run: pnpm --filter @ai-adventure/worker test:items
 */
import { validateBundle } from '@ai-adventure/contract';
import { assembleBundle } from '../src/bundle/assemble.js';
import { CompendiumIndex } from '../src/compendium/index.js';
import { planItem } from '../src/compendium/items.js';
import { ExtractedAdventureZ } from '../src/pipeline/extractAdventure.js';

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `: expected ${e}, got ${a}`}`);
  if (!pass) failures.push(name);
};

const idx = CompendiumIndex.load();
const EQ = 'Compendium.pf2e.equipment-srd.Item.';

// --- Plain matches.
const plain = (name: string, kind?: string) => {
  const p = planItem(idx, kind ? { name, kind } : { name });
  return p && p.kind === 'match' ? { name: p.match.name, reasons: p.reviewReasons.length } : p;
};
check('Lesser Healing Potion', plain('Lesser Healing Potion'), { name: 'Healing Potion (Lesser)', reasons: 0 });
check('Onyx Dog Wondrous Figurine', plain('Onyx Dog Wondrous Figurine'), { name: 'Wondrous Figurine (Onyx Dog)', reasons: 0 });
check('Wolf Fang Talisman', plain('Wolf Fang Talisman'), { name: 'Wolf Fang', reasons: 0 });
check('Shadow Rune Runestone', plain('Shadow Rune Runestone'), { name: 'Shadow', reasons: 0 });
check('Boots of Elvenkind (Cursed)', plain('Boots of Elvenkind (Cursed)'), { name: 'Boots of Elvenkind', reasons: 0 });

// --- No false positives.
check('Everburning Torch stays custom', planItem(idx, { name: 'Everburning Torch' }), null);
check('Bronze Key (key) stays custom', planItem(idx, { name: 'Bronze Key', kind: 'key' }), null);
check('Poison Vial (quest object) stays custom', planItem(idx, { name: 'Poison Vial', kind: 'quest object' }), null);
check('Silver Amulet of Karvasalon stays custom', planItem(idx, { name: 'Silver Amulet of Karvasalon' }), null);

// --- Ungraded.
const mut = planItem(idx, { name: 'Energy Mutagen' });
check('Energy Mutagen -> lowest grade', mut && mut.kind === 'match' ? [mut.match.name, mut.reviewReasons.length] : mut, ['Energy Mutagen (Lesser)', 1]);

// --- Runes.
const runeSummary = (name: string) => {
  const p = planItem(idx, { name });
  if (!p || p.kind !== 'runes') return p;
  return { base: p.base.name, runes: p.runes.map((r) => [r.type, r.name, r.rank ?? null]), reasons: p.reviewReasons.length };
};
check('+1 Kukri', runeSummary('+1 Kukri'), {
  base: 'Kukri',
  runes: [['weapon-potency', 'Weapon Potency (+1)', 1]],
  reasons: 0,
});
check('+1 Striking Dagger', runeSummary('+1 Striking Dagger'), {
  base: 'Dagger',
  runes: [['weapon-potency', 'Weapon Potency (+1)', 1], ['striking', 'Striking', 1]],
  reasons: 0,
});
check('+2 Greater Striking Flaming Longsword', runeSummary('+2 Greater Striking Flaming Longsword'), {
  base: 'Longsword',
  runes: [['weapon-potency', 'Weapon Potency (+2)', 2], ['striking', 'Striking (Greater)', 2], ['property', 'Flaming', null]],
  reasons: 0,
});
check('+1 Resilient Studded Leather', runeSummary('+1 Resilient Studded Leather'), {
  base: 'Studded Leather Armor',
  runes: [['armor-potency', 'Armor Potency (+1)', 1], ['resilient', 'Resilient', 1]],
  reasons: 0,
});
const fluff = runeSummary('+1 Striking Rapier (Fluff Fang)');
check('+1 Striking Rapier (Fluff Fang) base', fluff && 'base' in fluff ? fluff.base : fluff, 'Rapier');
const ghost = runeSummary('+1 Striking Ghost Touch Shortsword');
check(
  '+1 Striking Ghost Touch Shortsword',
  ghost && 'runes' in ghost ? [ghost.base, ghost.runes.filter((r) => r[0] === 'property').map((r) => r[1]), ghost.reasons] : ghost,
  ['Shortsword', ['Ghost Touch'], 0],
);
const wob = planItem(idx, { name: '+1 Striking Wobbly Longsword' });
check('+1 Striking Wobbly Longsword base', wob && wob.kind === 'runes' ? wob.base.name : wob, 'Longsword');
check('+1 Striking Wobbly Longsword review mentions Wobbly', wob?.reviewReasons.some((r) => r.includes('Wobbly')), true);

// --- Materials.
const silver = planItem(idx, { name: 'Low-Grade Silver Rapier' });
check(
  'Low-Grade Silver Rapier',
  silver && silver.kind === 'match' ? [silver.match.name, silver.material, silver.reviewReasons.length] : silver,
  ['Rapier', { type: 'silver', grade: 'low' }, 0],
);
const iron = planItem(idx, { name: 'Cold Iron Dagger' });
check(
  'Cold Iron Dagger',
  iron && iron.kind === 'match' ? [iron.match.name, iron.material, iron.reviewReasons.length] : iron,
  ['Dagger', { type: 'cold-iron', grade: 'low' }, 1],
);
const ada = planItem(idx, { name: '+1 Striking High-Grade Adamantine Warhammer' });
check(
  '+1 Striking High-Grade Adamantine Warhammer',
  ada && ada.kind === 'runes' ? [ada.base.name, ada.material, ada.runes.map((r) => r.type), ada.reviewReasons.length] : ada,
  ['Warhammer', { type: 'adamantine', grade: 'high' }, ['weapon-potency', 'striking'], 0],
);

// --- Every rune uuid points into the equipment pack.
const allRunes = [
  '+1 Kukri',
  '+1 Striking Dagger',
  '+2 Greater Striking Flaming Longsword',
  '+1 Resilient Studded Leather',
  '+1 Striking Ghost Touch Shortsword',
].flatMap((n) => {
  const p = planItem(idx, { name: n });
  return p && p.kind === 'runes' ? p.runes : [];
});
check('rune uuids in equipment-srd', [allRunes.length > 0, allRunes.every((r) => r.uuid.startsWith(EQ))], [true, true]);

// --- assembleBundle wiring.
const extracted = ExtractedAdventureZ.parse({
  title: 'Item Matching Test',
  synopsis: 's',
  chapters: [{ name: 'One', slug: 'one', summary: 'c' }],
  items: [
    { name: '+1 Striking Dagger', description: 'A keen blade from the vault.', kind: 'weapon', chapter_slug: 'one' },
    { name: 'Lesser Healing Potion', description: 'Red liquid in a flask.', kind: 'consumable', chapter_slug: 'one' },
    { name: 'Energy Mutagen', description: 'Smells of ozone.', kind: 'consumable', chapter_slug: null },
    { name: "Hallod's Map", description: 'A hand-drawn map.', kind: 'quest object', chapter_slug: null },
  ],
});
const bundle = assembleBundle(extracted, { pdfBytes: new Uint8Array([1]), compendium: idx });
const result = validateBundle(bundle);
check('bundle validates', result.valid, true);
if (!result.valid) console.error(JSON.stringify(result.issues, null, 2));
const it = bundle.items.entities;
check('item data kinds', it.map((i) => i.data.kind), ['compendium-ref-with-runes', 'compendium-ref', 'compendium-ref', 'custom']);
const d0 = it[0]!.data;
check('rune item name_override is printed name', d0.kind === 'compendium-ref-with-runes' ? d0.name_override : null, '+1 Striking Dagger');
check('rune item runes', d0.kind === 'compendium-ref-with-runes' ? d0.runes.map((r) => [r.type, r.rank ?? null]) : null, [['weapon-potency', 1], ['striking', 1]]);
check('rune item notes_html', d0.kind === 'compendium-ref-with-runes' && d0.notes_html?.includes('A keen blade from the vault.'), true);
const d1 = it[1]!.data;
check('potion notes_html', d1.kind === 'compendium-ref' && d1.notes_html?.includes('Red liquid in a flask.'), true);
check('categories', it.map((i) => i.category), ['weapon', 'consumable', 'consumable', 'equipment']);
check('review flags', it.map((i) => i.ai_metadata?.review_required), [false, false, true, false]);
check('manifest item stats', bundle.manifest.stats.items, { compendium: 3, custom: 1, review_needed: 1 });

// --- Without an index nothing matches.
const noIdx = assembleBundle(extracted, { pdfBytes: new Uint8Array([1]) });
check('no index -> all custom', noIdx.items.entities.map((i) => i.data.kind), ['custom', 'custom', 'custom', 'custom']);

if (failures.length) {
  console.error(`\n${failures.length} item check(s) failed`);
  process.exit(1);
}
console.log('\nAll item checks passed');
