/**
 * Offline checks for the special-ability parser (parseAbilities,
 * abilityDescriptionHtml), its use in toCustomStatBlock, and scoreParsed's
 * troop exemption. No network, no AI.
 * Run: pnpm --filter @ai-adventure/worker test:abilities
 * Sample text is invented (no published text in the repo).
 */
import { abilityDescriptionHtml, parseAbilities } from '../src/statblock/abilities.js';
import { toCustomStatBlock } from '../src/statblock/link.js';
import { scoreParsed, type ParsedStatBlock } from '../src/statblock/parse.js';

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `: expected ${e}, got ${a}`}`);
  if (!pass) failures.push(name);
};

const one = (s: string) => parseAbilities(s).abilities[0];
const names = (s: string) => parseAbilities(s).abilities.map((a) => a.name);

// --- glyph costs ------------------------------------------------------------
check('cost one-action', one('Slam [one-action] Frequency once per round; Effect The brute hits.')?.cost, '1');
check('cost two-actions', one('Slam [two-actions] Frequency once per round; Effect The brute hits.')?.cost, '2');
check('cost three-actions', one('Slam [three-actions] Frequency once per round; Effect The brute hits.')?.cost, '3');
check('cost reaction', one('Slam [reaction] Trigger An enemy moves; Effect The brute hits.')?.cost, 'reaction');
check('cost free-action', one('Slam [free-action] Frequency once per round; Effect The brute hits.')?.cost, 'free');
check('cost passive', one('Earth Glide The creature can burrow through soil.')?.cost, 'passive');

const range = one('Pummeling Gale [one-action] to [three-actions] Frequency once per round; Effect The gale bashes each adjacent enemy.');
check('range cost/costTo', [range?.cost, range?.costTo], ['1', '3']);
check('range html says Uses 1 to 3 actions', range ? abilityDescriptionHtml(range).includes('Uses 1 to 3 actions') : false, true);
const either = one('Quick Step [free-action] or [one-action] Frequency once per round; Effect The scout steps.');
check('free or one-action: free, no costTo', [either?.cost, either?.costTo], ['free', undefined]);

// --- traits -------------------------------------------------------------------
check('traits parsed', one('Ember Burst [two-actions] (fire, primal) Frequency once per day; Effect Sparks fly.')?.traits, ['fire', 'primal']);
const pageOnly = one('Form Up [one-action] (page 232)');
check('page ref is not traits', pageOnly?.traits, []);
check('page-only ability keeps text', pageOnly?.text, '(page 232)');

// --- frequency / trigger / requirements --------------------------------------
const freq = one('Roar [one-action] Frequency once per round; Effect The beast roars.');
check('frequency field', freq?.frequency, 'once per round');
const trig = one('Counter [reaction] Trigger An enemy hits the guard; Effect The guard strikes back.');
check('trigger field', trig?.trigger, 'An enemy hits the guard');
const req = one('Grapple Throw [one-action] Requirements The creature has a hand free; Effect It throws the foe.');
check('requirements field', req?.requirements, 'The creature has a hand free');
check('no frequency when absent', trig?.frequency, undefined);

// --- names --------------------------------------------------------------------
check('hyphenated name 1', names('Self-Destruct [two-actions] Frequency once per day; Effect It explodes.'), ['Self-Destruct']);
check('hyphenated name 2', names('Tight-Knit Family The creature gains a bonus near allies.'), ['Tight-Knit Family']);
check('two small words 1', names('Heat of the Forge [one-action] Frequency once per round; Effect It glows.'), ['Heat of the Forge']);
check('two small words 2', names('Blessed by the Winds [reaction] Trigger It falls; Effect It floats.'), ['Blessed by the Winds']);
check('passive opened by The', one('Earth Glide The creature can burrow through earth.')?.name, 'Earth Glide');
check('passive opened by When', one('Stone Skin When struck by a blade the creature hardens.')?.name, 'Stone Skin');
check('passive opened by A', one('Wary Eyes A hidden foe never gets the drop on it.')?.name, 'Wary Eyes');
const afterList = parseAbilities('Walks Under Open Sky The shaman reads sky signs Collect Thunder [free-action] Frequency once per day; Effect Thunder rolls.');
check('glyph ability after lowercase list', afterList.abilities.map((a) => a.name), ['Walks Under Open Sky', 'Collect Thunder']);
check('after-list ability cost', afterList.abilities[1]?.cost, 'free');

// --- non-names ----------------------------------------------------------------
const body = 'Slam [one-action] Frequency once per round; Effect The brute hits. Saving Throw DC 20 Fortitude. Stage 2 The foe is slowed. Melee [one-action] fist. Range 30 feet.';
check('rules words never become abilities', names(body), ['Slam']);
check('As Trample does not create an ability', names('Trampler The ogre tramples. As Trample it moves 10 feet. Effect It runs.'), ['Trampler']);
const dmg = parseAbilities('Flame Wash [two-actions] (fire) Frequency once per day; Effect Fire sweeps out. The damage depends on the wash size. Saving Throw DC 20 basic Reflex.');
check('mid-ability sentence does not split', dmg.abilities.map((a) => a.name), ['Flame Wash']);
check('mid-ability sentence kept in text', dmg.abilities[0]?.text.includes('The damage depends on the wash size.'), true);

// --- rest ---------------------------------------------------------------------
const withRest = parseAbilities('Some preamble text. Roar [one-action] Frequency once per round; Effect It roars.');
check('rest is text before first ability', [withRest.rest, withRest.abilities.length], ['Some preamble text.', 1]);
check('rest empty when ability first', parseAbilities('Roar [one-action] Frequency once per round; Effect It roars.').rest, '');
check('no abilities: all text is rest', parseAbilities('just some plain words.'), { abilities: [], rest: 'just some plain words.' });

// --- abilityDescriptionHtml ---------------------------------------------------
const htmlAb = one('Venom Spit [two-actions] Frequency once per round; Trigger A foe nears; Requirements It has a free mouth; Effect It spits a <b> & more. Critical Success The foe is unaffected. Success The foe is sickened. Failure The foe is slowed. Critical Failure The foe is paralyzed.');
const html = htmlAb ? abilityDescriptionHtml(htmlAb) : '';
for (const k of ['Frequency', 'Trigger', 'Requirements', 'Effect', 'Critical Success', 'Success', 'Failure', 'Critical Failure'])
  check(`html bolds ${k}`, html.includes(`<strong>${k}</strong>`), true);
check('html escapes < and &', [html.includes('&lt;b&gt;'), html.includes('&amp; more'), html.includes('<b>')], [true, true, false]);

// --- toCustomStatBlock --------------------------------------------------------
const parsedBase = (over: Partial<ParsedStatBlock> = {}): ParsedStatBlock => ({
  name: 'Test Boar',
  level: 3,
  rarity: 'common',
  alignment: 'N',
  size: 'medium',
  traits: ['animal'],
  perception: 8,
  senses: [],
  languages: [],
  skills: [],
  attributes: { str: 3, dex: 1, con: 2, int: -4, wis: 1, cha: -2 },
  items: [],
  ac: 18,
  saves: { fortitude: 9, reflex: 6, will: 5 },
  hp: 45,
  immunities: [],
  weaknesses: [],
  resistances: [],
  speeds: { land: 25 },
  strikes: [],
  spellcasting: [],
  abilitiesText: '',
  defensiveText: '',
  ...over,
});
const noMatch = () => null;
const sb = toCustomStatBlock(
  parsedBase({
    items: ['torch', '+1 striking jambiya (functions as a dagger) Cloud of Visions (aura) 30 feet.'],
    defensiveText: 'Ferocity [reaction] Trigger The boar is reduced to 0 HP; Effect It stays at 1 HP.',
    abilitiesText: 'Gore Rush [two-actions] (fire) Frequency once per day; Effect The boar charges.',
  }),
  '',
  undefined,
  noMatch,
);
const act = (n: string) => sb.actions.find((a) => a.name === n);
check('three actions', sb.actions.length, 3);
check('Ferocity defensive reaction', [act('Ferocity')?.category, act('Ferocity')?.cost, act('Ferocity')?.trigger], ['defensive', 'reaction', 'The boar is reduced to 0 HP']);
check('Gore Rush offensive', [act('Gore Rush')?.category, act('Gore Rush')?.cost, act('Gore Rush')?.traits, act('Gore Rush')?.frequency], ['offensive', '2', ['fire'], 'once per day']);
check('Cloud of Visions interaction', [act('Cloud of Visions')?.category, act('Cloud of Visions')?.traits], ['interaction', ['aura']]);
check('actions carry description_html', sb.actions.every((a) => a.description_html.startsWith('<p>')), true);
check('no Abilities paragraph when nothing unparsed', sb.tactics_html.includes('Abilities (from the stat block)'), false);
const sbRest = toCustomStatBlock(parsedBase({ abilitiesText: 'Loose preamble. Gore Rush [two-actions] Frequency once per day; Effect The boar charges.' }), '');
check('unparsed leading text stays in Abilities paragraph', [sbRest.tactics_html.includes('Abilities (from the stat block)'), sbRest.tactics_html.includes('Loose preamble.')], [true, true]);

// --- scoreParsed troop exemption ----------------------------------------------
check('troop without strikes: no strikes missing', scoreParsed(parsedBase({ traits: ['troop'], strikes: [] })).missing.includes('strikes'), false);
check('non-troop without strikes: strikes missing', scoreParsed(parsedBase({ traits: ['animal'], strikes: [] })).missing.includes('strikes'), true);

if (failures.length) {
  console.error(`\n${failures.length} ability check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nAll ability checks passed');
