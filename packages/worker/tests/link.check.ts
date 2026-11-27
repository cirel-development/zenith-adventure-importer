/**
 * Offline checks: NPC -> stat block linking, variant resolution, and the
 * assemble order (compendium first, then parsed block, then placeholder).
 * Run: pnpm --filter @ai-adventure/worker test:link
 * Blocks are invented in Paizo's layout (no published text in the repo).
 */
import { validateBundle } from '@ai-adventure/contract';
import { assembleBundle } from '../src/bundle/assemble.js';
import { CompendiumIndex } from '../src/compendium/index.js';
import { ExtractedAdventureZ } from '../src/pipeline/extractAdventure.js';
import { indexBlocks, linkStatBlock, nameKeys } from '../src/statblock/link.js';
import { scanStatBlocks } from '../src/statblock/scan.js';

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `: expected ${e}, got ${a}`}`);
  if (!pass) failures.push(name);
};

const text =
  'Intro text. ' +
  'MARSH WOLVES (3) CREATURE 2 N MEDIUM ANIMAL Perception +8; low-light vision, scent (imprecise) 30 feet ' +
  'Skills Athletics +8, Stealth +7 Str +3, Dex +3, Con +2, Int -4, Wis +2, Cha -2 ' +
  'AC 17; Fort +8, Ref +9, Will +6 HP 30 Speed 35 feet Melee [one-action] jaws +10, Damage 1d8+3 piercing plus Knockdown ' +
  'BOG NOTES The wolves hunt at dusk. ' +
  'OLD GREYMUZZLE CREATURE 3 UNIQUE N MEDIUM ANIMAL Variant marsh wolf (page 4) Skills Athletics +11 AC 19; Fort +10, Ref +9, Will +8 HP 45 ' +
  'GOBLIN CHIEFTAIN BUB CREATURE 0 UNIQUE MEDIUM GOBLIN HUMANOID Variant goblin warrior (Monster Core 196) HP 18 AC 17; Fort +6, Ref +9, Will +3 ' +
  'Outro text.';

const blocks = scanStatBlocks(text);
const byName = indexBlocks(blocks);
check('name keys plural', nameKeys('Marsh Wolves').includes('marsh wolf'), true);

const wolf = linkStatBlock('Marsh Wolf', byName);
check('plural header links to singular NPC', [wolf?.scanned.name, wolf?.parse.block.hp], ['Marsh Wolves', 30]);

const grey = linkStatBlock('Old Greymuzzle', byName);
check('variant merged with same-PDF base', grey?.base?.name, 'Marsh Wolves');
check('variant fields win', [grey?.parse.block.hp, grey?.parse.block.ac, grey?.parse.block.level], [45, 19, 3]);
check('base fields fill gaps', [grey?.parse.block.perception, grey?.parse.block.speeds?.land, grey?.parse.block.strikes.length], [8, 35, 1]);
check('skills merged', grey?.parse.block.skills.map((s) => `${s.name} ${s.bonus}`), ['Athletics 11', 'Stealth 7']);

const bub = linkStatBlock('Goblin Chieftain Bub', byName);
check('variant with base elsewhere stays unmerged', [bub?.scanned.form, bub?.base ?? null], ['variant', null]);

// --- assemble order -------------------------------------------------------
const idx = CompendiumIndex.load();
const extracted = ExtractedAdventureZ.parse({
  title: 'Link Check',
  synopsis: 's',
  npcs: [
    { name: 'Marsh Wolf', role: 'pack', description: 'Wolves.', level: 2, category: 'creature' },
    { name: 'Old Greymuzzle', role: 'alpha', description: 'Old wolf.', level: 3 },
    { name: 'Goblin Chieftain Bub', role: 'boss', description: 'Loud.', level: 0 },
    { name: 'Goblin Warrior', role: 'mook', description: 'Goblins.', level: -1, category: 'creature' },
    { name: 'Nobody Special', role: 'villager', description: 'No stat block.' },
  ],
});
const bundle = assembleBundle(extracted, { pdfBytes: new Uint8Array([1]), compendium: idx, pdfText: text });
const v = validateBundle(bundle);
check('bundle validates', v.valid, true);
if (!v.valid) console.error(JSON.stringify(v.issues, null, 2));
const by = (n: string) => bundle.actors.entities.find((a) => a.name === n)!;
const kindOf = (n: string) => {
  const a = by(n);
  return a.stat_block.kind === 'compendium-ref'
    ? a.stat_block.overrides
      ? 'compendium+overrides'
      : 'compendium'
    : a.ai_metadata?.prompt_version === 'statblock-regex-1'
      ? 'parsed'
      : 'placeholder';
};
check('assemble order', ['Marsh Wolf', 'Old Greymuzzle', 'Goblin Chieftain Bub', 'Goblin Warrior', 'Nobody Special'].map(kindOf), [
  'parsed',
  'parsed',
  'compendium+overrides',
  'compendium',
  'placeholder',
]);
const wolfSb = by('Marsh Wolf').stat_block;
check('parsed custom has real stats', wolfSb.kind === 'custom' ? [wolfSb.hp, wolfSb.ac, wolfSb.perception, wolfSb.strikes[0]?.damage_formula, wolfSb.strikes[0]?.effects] : null, [
  30,
  17,
  8,
  '1d8+3 piercing',
  ['Knockdown'],
]);
const bubSb = by('Goblin Chieftain Bub').stat_block;
check('variant overrides', bubSb.kind === 'compendium-ref' ? bubSb.overrides : null, {
  level: 0,
  rarity: 'unique',
  hp: 18,
  ac: 17,
  saves: { fortitude: 6, reflex: 9, will: 3 },
});
check('variant base is Monster Core goblin', bubSb.kind === 'compendium-ref' && bubSb.uuid.startsWith('Compendium.pf2e.pathfinder-monster-core.Actor.'), true);
check('variant flagged for review', by('Goblin Chieftain Bub').ai_metadata?.review_required, true);
check('manifest stats', bundle.manifest.stats.actors, { compendium: 2, custom: 3, review_needed: 2 });
check('warning counts parsed', bundle.manifest.warnings[0]?.message.startsWith('2 of 5 NPCs/creatures/hazards matched the PF2e compendium and 2 use stats parsed from the PDF'), true);

if (failures.length) {
  console.error(`\n${failures.length} link check(s) failed`);
  process.exit(1);
}
console.log('\nAll link checks passed');
