/**
 * Offline checks for the stat-block scanner and parser.
 * Run: pnpm --filter @ai-adventure/worker test:statblock
 *
 * The blocks below are invented for this test in Paizo's layout (the repo is
 * public, so no published stat-block text is copied here). Accuracy against
 * real books is measured separately with tests/statblock-accuracy.ts.
 */
import { scanStatBlocks } from '../src/statblock/scan.js';
import { parseStatBlock, parseDamage } from '../src/statblock/parse.js';
import { stripPurchaseWatermarks } from '../src/pdf/extract.js';

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `: expected ${e}, got ${a}`}`);
  if (!pass) failures.push(name);
};

const page =
  'The mill creaks in the wind. ' +
  'BRAMBLE HOUND (2) CREATURE 3 UNCOMMON N MEDIUM ANIMAL PLANT Perception +9; low-light vision, scent (imprecise) 30 feet ' +
  'Languages Sylvan (can’t speak any language) Skills Athletics +10, Stealth +8 (+10 in forests) ' +
  'Str +4, Dex +2, Con +3, Int –4, Wis +1, Cha –2 Items thorn collar ' +
  'AC 19; Fort +12, Ref +9, Will +7 HP 48; Immunities poison, sleep; Resistances piercing 5 (except slashing); Weaknesses fire 5 ' +
  'Bristle [reaction] Trigger A creature touches the hound; Effect Thorns scratch it. ' +
  'Speed 30 feet, climb 15 feet Melee [one-action] jaws +12 (agile), Damage 1d10+4 piercing plus Grab ' +
  'Melee [one-action] thorn tail +12 (reach 10 feet); Damage 1d6+4 slashing plus 1d4 persistent bleed ' +
  'Ranged [one-action] spore puff +10 (range 20 feet), Effect sickened 1 ' +
  'Seed Burst [two-actions] The hound shakes loose seeds in a 10-foot emanation. ' +
  'HUNTING THE HOUNDS Village elders say the hounds came with the floods. ' +
  'MOSSY STEPS HAZARD 1 MECHANICAL TRAP Stealth DC 18 (trained) Description Slick stairs. Disable DC 16 Athletics. Reset 1 hour. ' +
  'MILL GUARD CREATURE 1 Pathfinder NPC Core 12 Initiative Perception +6 Area A2. ' +
  'OLD BRAMBLE CREATURE 4 UNIQUE N MEDIUM ANIMAL PLANT Variant bramble hound (page 3) HP 60 ' +
  'paizo.com #1234567, Pat Example <pat@example.com>, Jan 2, 2026 12345678 12345678 12345678';

const blocks = scanStatBlocks(page);
check('scan: four headers', blocks.map((b) => `${b.name}|${b.form}|${b.level}`), [
  'Bramble Hound|full|3',
  'Mossy Steps|hazard|1',
  'Mill Guard|reference|1',
  'Old Bramble|variant|4',
]);
check('scan: count', blocks[0]!.count, 2);
check('scan: block stops at sidebar heading', blocks[0]!.text.includes('HUNTING THE HOUNDS'), false);
check('scan: reference source', blocks[2]!.reference, 'Pathfinder NPC Core 12');
check('scan: variant base', blocks[3]!.variantOf, { name: 'bramble hound', source: 'page 3' });

const { block: p, confidence, missing } = parseStatBlock(blocks[0]!);
check('confidence', [confidence, missing], [1, []]);
check('trait line', [p.rarity, p.alignment, p.size, p.traits], ['uncommon', 'N', 'medium', ['animal', 'plant']]);
check('perception + senses', [p.perception, p.senses], [9, ['low-light vision', 'scent (imprecise) 30 feet']]);
check('languages', p.languages, ['Sylvan (can’t speak any language)']);
check('skills with note', p.skills, [
  { name: 'Athletics', bonus: 10 },
  { name: 'Stealth', bonus: 8, note: '+10 in forests' },
]);
check('attributes (en-dash minus)', p.attributes, { str: 4, dex: 2, con: 3, int: -4, wis: 1, cha: -2 });
check('items', p.items, ['thorn collar']);
check('ac/saves/hp', [p.ac, p.saves, p.hp], [19, { fortitude: 12, reflex: 9, will: 7 }, 48]);
check('immunities', p.immunities, ['poison', 'sleep']);
check('resistances (except)', p.resistances, [{ type: 'piercing', value: 5 }]);
check('weaknesses stop before reaction', p.weaknesses, [{ type: 'fire', value: 5 }]);
check('defensive text', p.defensiveText.includes('Bristle [reaction]'), true);
check('speeds', p.speeds, { land: 30, climb: 15 });
check('strikes', p.strikes.map((s) => `${s.kind}:${s.name}:${s.bonus}:${s.traits.join('/')}`), [
  'melee:jaws:12:agile',
  'melee:thorn tail:12:reach 10 feet',
  'ranged:spore puff:10:range 20 feet',
]);
check('strike damage + effect', [p.strikes[0]!.damage, p.strikes[0]!.effects], [
  [{ formula: '1d10+4', type: 'piercing', persistent: false }],
  ['Grab'],
]);
check('persistent damage', p.strikes[1]!.damage, [
  { formula: '1d6+4', type: 'slashing', persistent: false },
  { formula: '1d4', type: 'bleed', persistent: true },
]);
check('abilities text kept', p.abilitiesText.startsWith('Seed Burst [two-actions]'), true);

check('damage: effect lowercase', parseDamage('1d8+2 slashing plus weeping wounds Next Ability').effects, ['weeping wounds']);
check('speed: fly only', parseStatBlock(scanStatBlocks('GUST WISP CREATURE 1 N TINY AIR ELEMENTAL Perception +5 Str +0, Dex +3, Con +0, Int -2, Wis +1, Cha +0 AC 16; Fort +4, Ref +8, Will +5 HP 14 Speed fly 40 feet Melee [one-action] gust +8 (air), Damage 1d4 bludgeoning')[0]!).block.speeds, { land: 0, fly: 40 });

const cleaned = stripPurchaseWatermarks(page);
check('watermark: email removed', cleaned.includes('@example.com'), false);
check('watermark: tracking numbers removed', cleaned.includes('12345678'), false);
check('watermark: game text kept', cleaned.includes('OLD BRAMBLE CREATURE 4'), true);

if (failures.length) {
  console.error(`\n${failures.length} stat-block check(s) failed`);
  process.exit(1);
}
console.log('\nAll stat-block checks passed');
