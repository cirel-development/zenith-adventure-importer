/**
 * Offline check for contract -> PF2e slug mappings.
 * Run: pnpm --filter zenith-adventure-importer test:mappings
 */
import { toPf2eLanguages, toPf2eSize } from '../src/builders/pf2eMappings.js';

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

if (failures.length) {
  console.error(`\n${failures.length} mapping check(s) failed`);
  process.exit(1);
}
console.log('\nAll mapping checks passed');
