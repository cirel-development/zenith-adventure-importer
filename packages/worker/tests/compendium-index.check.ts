/**
 * Offline checks for data/compendium-index.json and the lookup rules.
 * Run: pnpm --filter @ai-adventure/worker test:index
 * Expectations were read from PF2e 8.7.1's json-assets on 2026-11-27.
 */
import { CompendiumIndex, itemNameVariants, normalizeName } from '../src/compendium/index.js';

const UUID_RE = /^Compendium\.[\w-]+\.[\w-]+\.\w+\.[\w-]+$/; // same as contract CompendiumUuidSchema

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `: expected ${e}, got ${a}`}`);
  if (!pass) failures.push(name);
};

const idx = CompendiumIndex.load();
check('index version pinned', idx.version, '8.7.2');
check('index has entries', idx.size > 20000, true);

check('normalize', normalizeName("The Alchemist’s Fire (Moderate)"), 'alchemists fire moderate');
check('variants grade', itemNameVariants('Minor Healing Potion'), ['Minor Healing Potion', 'Healing Potion (Minor)']);
check('variants qualifier', itemNameVariants('Boots of Elvenkind (Cursed)'), ['Boots of Elvenkind (Cursed)', 'Boots of Elvenkind']);

// Creatures: tier priority (Monster Core over AP packs) and adventure override.
const jinkin = idx.findCreature('Jinkin');
check('Jinkin -> Monster Core', jinkin?.pack, 'pathfinder-monster-core');
check('Jinkin candidates', (jinkin?.candidates ?? 0) >= 2, true);
check('uuid format', UUID_RE.test(jinkin?.uuid ?? ''), true);
check('uuid uses Actor doc type', jinkin?.uuid.startsWith('Compendium.pf2e.pathfinder-monster-core.Actor.'), true);
check('case/space insensitive', idx.findCreature('  goblin   WARRIOR ')?.name, 'Goblin Warrior');
check('unknown creature -> null', idx.findCreature('Briboribix'), null);

const plaguePack = idx.packForAdventure('The Fall of Plaguestone');
check('packForAdventure', plaguePack, 'fall-of-plaguestone-bestiary');
check('packForAdventure none', idx.packForAdventure('A Few Flowers More'), null);

// Hazards are not creatures.
check('hazard via findHazard', idx.findHazard('Hidden Pit')?.pack, 'hazards');
check('hazard not via findCreature', idx.findCreature('Hidden Pit'), null);

// Items: pack NAME (equipment-srd), not folder (equipment).
const boots = idx.findItem('Boots of Elvenkind (Cursed)');
check('cursed boots -> base boots', [boots?.name, boots?.variant], ['Boots of Elvenkind', 'Boots of Elvenkind']);
check('item uuid uses pack name', boots?.uuid.startsWith('Compendium.pf2e.equipment-srd.Item.'), true);
check('grade reorder', idx.findItem("Moderate Alchemist's Fire")?.name, "Alchemist's Fire (Moderate)");
check('plain weapon', idx.findItem('Shortbow')?.type, 'weapon');
check('spell', idx.findSpell('Heal')?.pack, 'spells-srd');

if (failures.length) {
  console.error(`\n${failures.length} index check(s) failed`);
  process.exit(1);
}
console.log('\nAll index checks passed');
