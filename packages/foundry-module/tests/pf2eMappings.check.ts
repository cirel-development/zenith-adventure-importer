/**
 * Offline check for contract -> PF2e slug mappings.
 * Run: pnpm --filter zenith-adventure-importer test:mappings
 */
import {
  appendAdventureNotes,
  toPf2ePropertyRuneSlug,
  isLoreSkill,
  splitKnownDefenses,
  toPf2eAttackEffects,
  toPf2eDamageRolls,
  toPf2eDefenseType,
  toPf2eFrequency,
  toPf2eHazardTraits,
  toPf2eLanguages,
  toPf2eSenses,
  toPf2eSize,
  toPf2eSkillSlug,
  toPf2eSpellLabel,
  toPf2eSpellPlacement,
  toPf2eStrikeTraits,
} from '../src/builders/pf2eMappings.js';

// Subset of CONFIG.PF2E.languages keys observed in PF2e 8.7.1.
const KNOWN = ['common', 'fey', 'sakvroth', 'chthonian', 'diabolic', 'empyrean', 'petran', 'pyric', 'thalassic', 'sussuran', 'draconic', 'elven'];

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `: expected ${e}, got ${a}`}`);
  if (!pass) failures.push(name);
};

check('size tiny', toPf2eSize('tiny'), 'tiny');
check('size small', toPf2eSize('small'), 'sm');
check('size medium', toPf2eSize('medium'), 'med');
check('size large', toPf2eSize('large'), 'lg');
check('size huge', toPf2eSize('huge'), 'huge');
check('size gargantuan', toPf2eSize('gargantuan'), 'grg');
check('size already slug', toPf2eSize('lg'), 'lg');
check('size unknown -> med', toPf2eSize('colossal'), 'med');

check('languages legacy -> remaster', toPf2eLanguages(['Common', 'Sylvan', 'Undercommon']).value, ['common', 'fey', 'sakvroth']);
check('languages all legacy', toPf2eLanguages(['Abyssal', 'Infernal', 'Celestial', 'Terran', 'Ignan', 'Aquan', 'Auran']).value,
  ['chthonian', 'diabolic', 'empyrean', 'petran', 'pyric', 'thalassic', 'sussuran']);
check('languages dedupe', toPf2eLanguages(['Fey', 'Sylvan', 'common', 'Common']).value, ['fey', 'common']);
check('languages unknown -> details', toPf2eLanguages(['Common', "Thieves' Cant", 'Gnoll'], KNOWN), { value: ['common'], details: "Thieves' Cant, Gnoll" });
check('languages blank skipped', toPf2eLanguages(['', '  ', 'Draconic'], KNOWN), { value: ['draconic'], details: '' });

const HAZARD_KNOWN = ['mechanical', 'trap', 'environmental', 'magical', 'haunt'];
check('hazard drops header word', toPf2eHazardTraits(['hazard'], HAZARD_KNOWN), ['mechanical']);
check('hazard keeps valid, lowercases', toPf2eHazardTraits(['Mechanical', 'TRAP', 'hazard'], HAZARD_KNOWN), ['mechanical', 'trap']);
check('hazard drops unknown', toPf2eHazardTraits(['environmental', 'spiky'], HAZARD_KNOWN), ['environmental']);
check('hazard empty -> mechanical', toPf2eHazardTraits([]), ['mechanical']);

const SENSES = ['darkvision', 'low-light-vision', 'scent', 'tremorsense', 'motion-sense'];
check('senses', toPf2eSenses(['low-light vision', 'scent (imprecise) 30 feet', 'smoke vision'], SENSES), {
  senses: [{ type: 'low-light-vision' }, { type: 'scent', acuity: 'imprecise', range: 30 }],
  details: 'smoke vision',
});
check('defense alias', [toPf2eDefenseType('axes'), toPf2eDefenseType('Cold Iron'), toPf2eDefenseType('visual effects')], ['axe-vulnerability', 'cold-iron', 'visual']);
check('hazard precision damage', toPf2eDefenseType('precision damage'), 'precision');
check('defense split', splitKnownDefenses([{ type: 'fire', value: 5 }, { type: 'bramble', value: 2 }], ['fire']), { kept: [{ type: 'fire', value: 5 }], unknownText: 'bramble 2' });
check('damage rolls', toPf2eDamageRolls('1d6+2 piercing plus 1d4 acid plus 1d4 persistent bleed'), [
  { damage: '1d6+2', damageType: 'piercing', category: null },
  { damage: '1d4', damageType: 'acid', category: null },
  { damage: '1d4', damageType: 'bleed', category: 'persistent' },
]);
check('damage rolls empty', toPf2eDamageRolls(''), []);
check('strike traits', toPf2eStrikeTraits(['agile', 'reach 10 feet', 'versatile S', 'deadly d10', 'thrown 20 feet', 'range increment 30 feet']), {
  traits: ['agile', 'reach-10', 'versatile-s', 'deadly-d10', 'thrown-20'],
  range: { increment: 30, max: null },
});
// Found in the Rage of Elements import: "10-foot reach" word order, and the default 5 ft reach.
check('reach word orders', toPf2eStrikeTraits(['10-foot reach', '15 feet reach', 'reach 20 ft.']).traits, ['reach-10', 'reach-15', 'reach-20']);
check('5 ft reach is the default, no trait', toPf2eStrikeTraits(['reach 5 feet', 'agile']).traits, ['agile']);
check('attack effects', toPf2eAttackEffects(['Grab', 'Improved Knockdown']), ['grab', 'improved-knockdown']);
check('lore skill', [isLoreSkill('Farming Lore'), isLoreSkill('Athletics')], [true, false]);
check('skill slugs', ['Arcane', 'Occult', 'Athletics'].map(toPf2eSkillSlug), ['arcana', 'occultism', 'athletics']);

check('spell label at will', toPf2eSpellLabel('at will; self only'), 'At Will; Self Only');
check('spell label constant', toPf2eSpellLabel('constant'), 'Constant');
check('spell label small words', toPf2eSpellLabel('to Astral Plane, Elemental Planes, or the Universe only'), 'To Astral Plane, Elemental Planes, or the Universe Only');
check('spell label undefined', toPf2eSpellLabel(undefined), '');
check('placement cantrip', toPf2eSpellPlacement('e1', 'innate', 0, undefined), { location: { value: 'e1' }, preparedCount: 0 });
check('placement innate uses', toPf2eSpellPlacement('e1', 'innate', 4, 3), { location: { value: 'e1', heightenedLevel: 4, uses: { max: 3, value: 3 } }, preparedCount: 0 });
check('placement prepared', toPf2eSpellPlacement('e1', 'prepared', 3, 2), { location: { value: 'e1' }, preparedCount: 2 });
check('placement spontaneous', toPf2eSpellPlacement('e1', 'spontaneous', 2, undefined), { location: { value: 'e1', heightenedLevel: 2 }, preparedCount: 0 });
check('placement focus auto-heightens', toPf2eSpellPlacement('e1', 'focus', 3, undefined), { location: { value: 'e1' }, preparedCount: 0 });

check('rune slug simple', toPf2ePropertyRuneSlug('Flaming'), 'flaming');
check('rune slug graded', toPf2ePropertyRuneSlug('Flaming (Greater)'), 'greaterFlaming');
check('rune slug two words', toPf2ePropertyRuneSlug('Ghost Touch'), 'ghostTouch');
check('rune slug hyphen', toPf2ePropertyRuneSlug('Energy-Resistant'), 'energyResistant');
check('rune slug apostrophes', toPf2ePropertyRuneSlug("Fear-Some's Bane"), 'fearSomesBane');
check('adventure notes fresh', appendAdventureNotes('', '<p>x</p>'), '<h3>In this adventure</h3><p>x</p>');
check('adventure notes existing', appendAdventureNotes('<p>a</p>', '<p>x</p>'), '<p>a</p><hr><h3>In this adventure</h3><p>x</p>');

check('frequency once per round', toPf2eFrequency('once per round'), { max: 1, value: 1, per: 'round' });
check('frequency twice per day', toPf2eFrequency('twice per day'), { max: 2, value: 2, per: 'day' });
check('frequency 10 minutes', toPf2eFrequency('once per 10 minutes')?.per, 'PT10M');
check('frequency hour', toPf2eFrequency('once per hour')?.per, 'PT1H');
check('frequency N times', toPf2eFrequency('3 times per day')?.max, 3);
check('frequency with trailing clause', toPf2eFrequency('once per round; Effect The foe falls.'), { max: 1, value: 1, per: 'round' });
check('frequency non-matching', toPf2eFrequency('until the end of the encounter'), null);
check('frequency undefined', toPf2eFrequency(undefined), null);
// PF2e keys weeks/months/years as ISO durations; "year" alone makes Foundry drop the item.
check('frequency per year', toPf2eFrequency('three times per year'), { max: 3, value: 3, per: 'P1Y' });
check('frequency per week', toPf2eFrequency('once per week')?.per, 'P1W');

if (failures.length) {
  console.error(`\n${failures.length} mapping check(s) failed`);
  process.exit(1);
}
console.log('\nAll mapping checks passed');
