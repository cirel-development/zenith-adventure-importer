/**
 * Offline checks for stat block inventory linking: parseInventoryLine,
 * singular, inventoryResolver, toCustomStatBlock and the assemble path.
 * Uses the real compendium index. No network, no AI.
 * Run: pnpm --filter @ai-adventure/worker test:inventory
 * Sample text is invented (no published text in the repo).
 */
import { validateBundle } from '@ai-adventure/contract';
import { assembleBundle } from '../src/bundle/assemble.js';
import { CompendiumIndex } from '../src/compendium/index.js';
import { ExtractedAdventureZ } from '../src/pipeline/extractAdventure.js';
import { parseInventoryLine, singular } from '../src/statblock/inventory.js';
import { inventoryResolver, toCustomStatBlock } from '../src/statblock/link.js';
import type { ParsedStatBlock } from '../src/statblock/parse.js';

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `: expected ${e}, got ${a}`}`);
  if (!pass) failures.push(name);
};

// --- singular -------------------------------------------------------------
check('singular daggers', singular('daggers'), 'dagger');
check('singular javelins', singular('javelins'), 'javelin');
check('singular torches', singular('torches'), 'torch');
check('singular glass', singular('glass'), 'glass');

// --- parseInventoryLine ---------------------------------------------------
const one = (s: string) => parseInventoryLine([s]).entries[0];
check('quantity (2)', one('daggers (2)'), { printed: 'daggers (2)', name: 'daggers', quantity: 2 });
check('leading digit', [one('2 javelins')?.name, one('2 javelins')?.quantity], ['javelins', 2]);
check('leading word', [one('two javelins')?.name, one('two javelins')?.quantity], ['javelins', 2]);
check('note kept', [one('heavy crossbow (10 bolts)')?.name, one('heavy crossbow (10 bolts)')?.note, one('heavy crossbow (10 bolts)')?.quantity], ['heavy crossbow', '10 bolts', 1]);
check('page ref dropped', one('rope (page 201)'), { printed: 'rope (page 201)', name: 'rope', quantity: 1 });
check('functions as -> standIn', [one('dagger-like thing (functions as a dagger)')?.standIn, one('dagger-like thing (functions as a dagger)')?.note], ['dagger', undefined]);
check('counts as -> standIn', one('durable farm clothes (counts as padded armor)')?.standIn, 'padded armor');
check('nested parens note', one('blunderbuss (20 rounds; Guns & Gears 151)')?.note, '20 rounds; Guns & Gears 151');
check('curly apostrophe', one('crafter’s eyepiece')?.name, "crafter's eyepiece");

const run = parseInventoryLine(['+1 striking jambiya (functions as a dagger) Cloud of Visions (aura) 30 feet.', 'lesser healing potion', 'torch']);
check('ability run-in entries', run.entries.map((e) => e.name), ['+1 striking jambiya']);
check('ability run-in standIn', run.entries[0]?.standIn, 'dagger');
check('ability run-in leftover', run.leftover, 'Cloud of Visions (aura) 30 feet., lesser healing potion, torch');
const plainRun = parseInventoryLine(['torch', 'rope']);
check('no leftover on plain list', [plainRun.entries.length, plainRun.leftover], [2, '']);

// --- inventoryResolver ----------------------------------------------------
const idx = CompendiumIndex.load();
const resolve = inventoryResolver(idx);
const res = (s: string) => {
  const { entries } = parseInventoryLine([s]);
  return entries[0] ? resolve(entries[0]) : null;
};
const dagger = idx.findItemExact('Dagger')?.uuid;
const padded = idx.findItemExact('Padded Armor')?.uuid;
check('dagger uuid exists', typeof dagger, 'string');
check('padded armor uuid exists', typeof padded, 'string');

const scim = res('+1 striking scimitar');
check('scimitar name/equipped', [scim?.name, scim?.equipped, scim?.quantity], ['+1 Striking Scimitar', true, 1]);
check('scimitar runes', scim?.runes?.map((r) => [r.type, r.rank ?? null]), [['weapon-potency', 1], ['striking', 1]]);
check('scimitar base uuid', scim?.uuid, idx.findItemExact('Scimitar')?.uuid);

const leather = res('leather armor');
check('leather armor equipped, no name', [leather?.equipped, leather?.name ?? null, leather?.uuid], [true, null, idx.findItemExact('Leather Armor')?.uuid]);

const daggers = res('daggers (2)');
check('daggers (2)', [daggers?.uuid, daggers?.quantity], [dagger, 2]);

check('healing potion not equipped', res('lesser healing potion')?.equipped, false);

const jambiya = res('+1 striking jambiya (functions as a dagger)');
check('jambiya stand-in', [jambiya?.uuid, jambiya?.name, jambiya?.runes?.length], [dagger, '+1 Striking Jambiya', 2]);

check('farm clothes stand-in uuid', res('durable farm clothes (counts as padded armor)')?.uuid, padded);

check('low-grade silver dagger', res('low-grade silver dagger')?.material, { type: 'silver', grade: 'low' });
check('crossbow note', res('heavy crossbow (10 bolts)')?.note, '10 bolts');
check('strongbox key unmatched', res('strongbox key'), null);

// --- toCustomStatBlock ----------------------------------------------------
const parsedBase = (items: string[], abilitiesText = ''): ParsedStatBlock => ({
  name: 'Test Guard',
  level: 1,
  rarity: 'common',
  alignment: 'N',
  size: 'medium',
  traits: ['human', 'humanoid'],
  perception: 5,
  senses: [],
  languages: ['Common'],
  skills: [],
  attributes: null,
  items,
  ac: 16,
  saves: { fortitude: 5, reflex: 4, will: 3 },
  hp: 20,
  immunities: [],
  weaknesses: [],
  resistances: [],
  speeds: { land: 25 },
  strikes: [],
  spellcasting: [],
  abilitiesText,
  defensiveText: '',
});
const itemsPara = (html: string) => /<p><strong>Items<\/strong>([^<]*)<\/p>/.exec(html)?.[1]?.trim() ?? null;

const withRes = toCustomStatBlock(parsedBase(['+1 striking scimitar', 'strongbox key', 'leather armor']), '', undefined, resolve);
check('resolver: 2 inventory entries', withRes.inventory.length, 2);
const p1 = itemsPara(withRes.tactics_html);
check('resolver: Items paragraph keeps unmatched', [p1?.includes('strongbox key'), p1?.includes('scimitar'), p1?.includes('leather')], [true, false, false]);

const noRes = toCustomStatBlock(parsedBase(['+1 striking scimitar', 'strongbox key', 'leather armor']), '');
check('no resolver: inventory empty', noRes.inventory, []);
check('no resolver: all items stay', itemsPara(noRes.tactics_html), '+1 striking scimitar, strongbox key, leather armor');

const withLeft = toCustomStatBlock(parsedBase(['torch', '+1 striking jambiya (functions as a dagger) Cloud of Visions (aura) 30 feet.'], 'Sneaky.'), '', undefined, resolve);
const abil = /<h3>Abilities \(from the stat block\)<\/h3><p>([^<]*)<\/p>/.exec(withLeft.tactics_html)?.[1] ?? '';
// The ability that ran into the Items list becomes an interaction action;
// text with no ability name stays in the Abilities paragraph.
const cloud = withLeft.actions.find((a) => a.name === 'Cloud of Visions');
check('leftover ability becomes an interaction action', [cloud?.category, cloud?.traits], ['interaction', ['aura']]);
check('unnamed text stays in Abilities paragraph', [abil.includes('Sneaky.'), abil.includes('Cloud of Visions')], [true, false]);
check('leftover item still linked', withLeft.inventory.length >= 2, true);

// --- assembleBundle path --------------------------------------------------
const pdfText =
  'Intro text. ' +
  'CROSSROADS WARDEN CREATURE 2 N MEDIUM HUMANOID Perception +7; darkvision Languages Common ' +
  'Skills Athletics +8, Stealth +5 Str +3, Dex +2, Con +2, Int +0, Wis +1, Cha +0 ' +
  'Items +1 striking scimitar, daggers (2), strongbox key, leather armor ' +
  'AC 18; Fort +8, Ref +7, Will +5 HP 34 Speed 25 feet Melee [one-action] scimitar +10, Damage 1d6+3 slashing ' +
  'Outro text.';
const extracted = ExtractedAdventureZ.parse({
  title: 'Inventory Check',
  synopsis: 's',
  npcs: [{ name: 'Crossroads Warden', role: 'guard', description: 'Guards the road.', level: 2, category: 'creature' }],
});
const bundle = assembleBundle(extracted, { pdfBytes: new Uint8Array([1]), pdfText, spellIndex: idx });
const v = validateBundle(bundle);
check('assembled bundle validates', v.valid, true);
if (!v.valid) console.error(JSON.stringify(v.issues, null, 2));
const warden = bundle.actors.entities.find((a) => a.name === 'Crossroads Warden');
const wsb = warden?.stat_block;
check('warden parsed custom', wsb?.kind, 'custom');
if (wsb?.kind === 'custom') {
  check('warden inventory linked', wsb.inventory.length, 3);
  check('warden unmatched item stays text', itemsPara(wsb.tactics_html), 'strongbox key');
}

if (failures.length) {
  console.error(`\n${failures.length} inventory check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nAll inventory checks passed');
