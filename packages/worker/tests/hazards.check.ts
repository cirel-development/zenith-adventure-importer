/**
 * Offline checks for hazard stat blocks: parseHazardBlock, inlineRolls,
 * toCustomHazard and the assembleBundle hazard path. No network, no AI.
 * Run: pnpm --filter @ai-adventure/worker test:hazards
 * Sample text is invented (no published text in the repo).
 */
import { validateBundle } from '@ai-adventure/contract';
import { assembleBundle } from '../src/bundle/assemble.js';
import { ExtractedAdventureZ } from '../src/pipeline/extractAdventure.js';
import { parseHazardBlock } from '../src/statblock/hazard.js';
import { indexHazardBlocks, toCustomHazard } from '../src/statblock/link.js';
import { inlineRolls } from '../src/statblock/rolls.js';
import { scanStatBlocks } from '../src/statblock/scan.js';

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `: expected ${e}, got ${a}`}`);
  if (!pass) failures.push(name);
};
const count = (s: string, sub: string) => s.split(sub).length - 1;

const hazardOf = (text: string) => {
  const b = scanStatBlocks(text).find((x) => x.form === 'hazard');
  if (!b) throw new Error('no hazard block scanned');
  return b;
};

// --- Simple trap ------------------------------------------------------------
const trapText =
  'The party enters the hall. ' +
  'RUSTY BLADE TRAP HAZARD 3 MECHANICAL TRAP Stealth DC 21 (trained) ' +
  'Description A blade swings from a slot in the wall. ' +
  'Disable Thievery DC 19 (trained) to jam the slot ' +
  'AC 19; Fort +12, Ref +6 Hardness 9; HP 36 (BT 18); Immunities critical hits, object immunities, precision damage ' +
  'Swinging Blade [reaction] (attack); Trigger A creature steps on the loose stone; Effect The blade attacks that creature. ' +
  'Melee blade +15, Damage 2d8+6 slashing ' +
  'The corridor beyond is quiet. B4. STOREROOM The shelves hold old crates.';
const trapBlock = hazardOf(trapText);
const trap = parseHazardBlock(trapBlock);
const th = trap.hazard;
check('trap name', th.name, 'Rusty Blade Trap');
check('trap level', th.level, 3);
check('trap rarity', th.rarity, 'common');
check('trap traits', th.traits, ['mechanical', 'trap']);
check('trap not complex', th.complex, false);
check('trap stealthDc', th.stealthDc, 21);
check('trap stealthDetails', th.stealthDetails, '(trained)');
check('trap description', th.description, 'A blade swings from a slot in the wall.');
check('trap disable', th.disable, 'Thievery DC 19 (trained) to jam the slot');
check('trap ac', th.ac, 19);
check('trap saves (will not printed)', th.saves, { fortitude: 12, reflex: 6, will: null });
check('trap hardness', th.hardness, 9);
check('trap hp', th.hp, 36);
check('trap brokenThreshold', th.brokenThreshold, 18);
check('trap immunities', th.immunities, ['critical hits', 'object immunities', 'precision damage']);
check('trap abilities count', th.abilities.length, 1);
const ab = th.abilities[0];
check('trap reaction name', ab?.name, 'Swinging Blade');
check('trap reaction cost', ab?.cost, 'reaction');
check('trap reaction traits', ab?.traits, ['attack']);
check('trap reaction trigger', ab?.trigger, 'A creature steps on the loose stone');
check('trap strikes count', th.strikes.length, 1);
const st = th.strikes[0];
check('trap strike kind/name/bonus', [st?.kind, st?.name, st?.bonus], ['melee', 'blade', 15]);
check('trap strike damage', st?.damage.map((d) => [d.formula, d.type]), [['2d8+6', 'slashing']]);
check('trap routine/reset empty', [th.routine, th.reset], ['', '']);
// Prose cutting.
check('prose after Strike not in ability', /corridor|quiet|STOREROOM|shelves/.test(JSON.stringify(th.abilities)), false);
check('area key cut (nothing after B4.)', JSON.stringify(th).includes('crates'), false);
check('trap confidence full', trap.confidence, 1);
check('trap missing none', trap.missing, []);

// --- Complex hazard ---------------------------------------------------------
const complexText =
  'CLOCKWORK GUARDIAN HAZARD 5 UNCOMMON COMPLEX MECHANICAL TRAP Stealth +14 (expert) to notice the whirring gears ' +
  'Description A brass figure stands in the alcove. ' +
  'Disable Crafting DC 24 (expert) to halt the gears, or Athletics DC 26 (trained) to jam them ' +
  'AC 24; Fort +15, Ref +10, Will +8 Hardness 12; HP 60 (BT 30); Immunities critical hits, object immunities, precision damage ' +
  'Routine (2 actions) The figure uses both actions to strike the nearest intruder. ' +
  'Melee fist +17, Damage 3d6+8 bludgeoning ' +
  'Reset The gears wind themselves back up after 1 minute.';
const cx = parseHazardBlock(hazardOf(complexText));
const ch = cx.hazard;
check('complex name/level', [ch.name, ch.level], ['Clockwork Guardian', 5]);
check('complex rarity', ch.rarity, 'uncommon');
check('complex traits', ch.traits, ['complex', 'mechanical', 'trap']);
check('complex flag', ch.complex, true);
check('complex stealth +14 -> 24', ch.stealthDc, 24);
check('complex stealthDetails', ch.stealthDetails, '(expert) to notice the whirring gears');
check('complex description', ch.description, 'A brass figure stands in the alcove.');
check('complex disable', ch.disable, 'Crafting DC 24 (expert) to halt the gears, or Athletics DC 26 (trained) to jam them');
check('complex saves', ch.saves, { fortitude: 15, reflex: 10, will: 8 });
check('complex hp/bt/hardness', [ch.hp, ch.brokenThreshold, ch.hardness], [60, 30, 12]);
check('complex routine', ch.routine, '(2 actions) The figure uses both actions to strike the nearest intruder.');
check('complex reset', ch.reset, 'The gears wind themselves back up after 1 minute.');
check('complex strike', ch.strikes.map((s) => [s.kind, s.name, s.bonus]), [['melee', 'fist', 17]]);
check('complex confidence', cx.confidence, 1);

// --- Ranged strike ----------------------------------------------------------
const rangedText =
  'DART SLOT HAZARD 1 MECHANICAL TRAP Stealth DC 17 (trained) Description A slot in the wall. ' +
  'Disable Thievery DC 15 (trained) to plug the slot AC 16; Fort +9, Ref +5 Hardness 4; HP 16 (BT 8); Immunities critical hits ' +
  'Dart Volley [reaction] (attack); Trigger A creature opens the chest; Effect The slot fires. ' +
  'Ranged dart +11, Damage 1d4+2 piercing';
const rg = parseHazardBlock(hazardOf(rangedText)).hazard;
check('ranged strike', rg.strikes.map((s) => [s.kind, s.name, s.bonus, s.damage[0]?.formula, s.damage[0]?.type]), [['ranged', 'dart', 11, '1d4+2', 'piercing']]);

// --- Affliction after the Strike is kept ------------------------------------
const poisonText =
  'SLEEPWEED SNARE HAZARD 2 MECHANICAL TRAP Stealth DC 20 (trained) Description A vine curtain hides a needle. ' +
  'Disable Thievery DC 18 (trained) to snip the vines AC 18; Fort +10, Ref +4 Hardness 6; HP 24 (BT 12); Immunities critical hits, object immunities ' +
  'Needle Jab [reaction] (attack); Trigger A creature pushes through the vines; Effect The needle strikes. ' +
  'Melee needle +13, Damage 1d4+2 piercing ' +
  'Sleepweed Poison (poison) Saving Throw DC 18 Fortitude; Maximum Duration 4 rounds; Stage 1 drowsy (1 round); Stage 2 asleep (1 round) ' +
  'The guard in the next room is dozing. B7. GUARD POST The door is open.';
const po = parseHazardBlock(hazardOf(poisonText)).hazard;
check('poison strike still parsed', po.strikes.map((s) => s.name), ['needle']);
const names = po.abilities.map((a) => a.name);
check('poison ability names', names, ['Needle Jab', 'Sleepweed Poison']);
const pois = po.abilities.find((a) => a.name === 'Sleepweed Poison');
check('poison traits', pois?.traits, ['poison']);
check('poison text ends at last Stage', pois?.text.endsWith('Stage 2 asleep (1 round)'), true);
check('poison text has no prose', /guard|dozing|GUARD POST/.test(pois?.text ?? ''), false);
check('poison text keeps stages', [/Stage 1 drowsy/.test(pois?.text ?? ''), /Maximum Duration 4 rounds/.test(pois?.text ?? '')], [true, true]);
check('Needle Jab not polluted by poison', /Sleepweed/.test(po.abilities[0]?.text ?? ''), false);

// --- XP sentence cut --------------------------------------------------------
const xpText =
  'FALLING SLAB HAZARD 4 MECHANICAL TRAP Stealth DC 22 (trained) Description A slab hangs above the door. ' +
  'Disable Athletics DC 20 (trained) to prop the slab AC 21; Fort +13, Ref +7 Hardness 10; HP 40 (BT 20); Immunities critical hits ' +
  'Slab Drop [reaction] (attack); Trigger A creature crosses the threshold; Effect The slab falls. ' +
  'Melee slab +16, Damage 3d8+5 bludgeoning ' +
  'Defeating the trap awards the party 40 XP.';
const xp = parseHazardBlock(hazardOf(xpText)).hazard;
check('xp: strike kept', xp.strikes.length, 1);
check('xp: not in abilities', /XP|Defeating|party/.test(JSON.stringify(xp.abilities)), false);
// XP sentence before the strike line is cut from the action text as well.
const xp2Text =
  'FALLING SLAB HAZARD 4 MECHANICAL TRAP Stealth DC 22 (trained) Description A slab hangs above the door. ' +
  'Disable Athletics DC 20 (trained) to prop the slab AC 21; Fort +13, Ref +7 Hardness 10; HP 40 (BT 20); Immunities critical hits ' +
  'Slab Drop [reaction] (attack); Trigger A creature crosses the threshold; Effect The slab falls. Defeating the trap awards the party 40 XP.';
const xp2 = parseHazardBlock(hazardOf(xp2Text)).hazard;
check('xp (no strike): cut from ability', /XP|Defeating/.test(JSON.stringify(xp2.abilities)), false);

// --- Near-empty block -------------------------------------------------------
const emptyText = 'Entry hall. THE PIT HAZARD 2 The adventurers continue down the long hall and the walls grow damp as they walk.';
const empty = parseHazardBlock(hazardOf(emptyText));
check('near-empty confidence < 0.5', empty.confidence < 0.5, true);
check('near-empty missing core fields', empty.missing.includes('stealth') && empty.missing.includes('actions'), true);

// --- indexHazardBlocks ------------------------------------------------------
const idxMap = indexHazardBlocks(scanStatBlocks(trapText));
check('indexHazardBlocks key', idxMap.has('rusty blade trap'), true);

// --- inlineRolls ------------------------------------------------------------
const r1 = inlineRolls('Make a DC 14 basic Reflex save.');
check('basic reflex', r1.includes('@Check[type:reflex|dc:14|basic:true]'), true);
const r2 = inlineRolls('Make a DC 26 Fortitude save.');
check('fortitude', r2.includes('@Check[type:fortitude|dc:26]'), true);
check('fortitude has no basic', r2.includes('basic'), false);
const r3 = inlineRolls('Thievery DC 18 to pick it.');
check('Thievery DC 18', r3.includes('@Check[type:thievery|dc:18]'), true);
const r4 = inlineRolls('Make a DC 18 Athletics check.');
check('DC 18 Athletics', r4.includes('@Check[type:athletics|dc:18]'), true);
check('piercing damage', inlineRolls('Deals 2d6+6 piercing damage.').includes('@Damage[2d6+6[piercing]] damage'), true);
check('persistent fire damage', inlineRolls('Takes 1d6 persistent fire damage.').includes('@Damage[1d6[persistent,fire]] damage'), true);
const pre = 'Attempt @Check[type:reflex|dc:20] or take 2d6 fire damage.';
check('already-enriched text unchanged', inlineRolls(pre), pre);
const multi = 'Thievery DC 19, a DC 14 basic Reflex save, DC 26 Fortitude save, DC 18 Athletics, Stealth DC 22.';
const mo = inlineRolls(multi);
check('no double conversion (5 checks)', count(mo, '@Check['), 5);
check('no nested check in label', /\{[^}]*@Check\[/.test(mo), false);
const dmg = inlineRolls('2d6+6 piercing damage and 1d6 persistent fire damage');
check('no double conversion (2 damage)', count(dmg, '@Damage['), 2);

// --- toCustomHazard ---------------------------------------------------------
const notes = '<p>The rusty blade lurks here.</p>';
const sb = toCustomHazard(th, notes);
check('custom kind', sb.kind, 'custom');
check('hazard.stealth_dc', sb.hazard?.stealth_dc, 21);
check('hazard.stealth_details', sb.hazard?.stealth_details, '(trained)');
check('hazard.is_complex false', sb.hazard?.is_complex, false);
check('hazard.hardness', sb.hazard?.hardness, 9);
check('disable_html has thievery check', sb.hazard?.disable_html?.includes('@Check[type:thievery'), true);
check('description_html has notes', sb.hazard?.description_html?.includes(notes), true);
check('actions reaction', sb.actions.map((a) => [a.name, a.cost]), [['Swinging Blade', 'reaction']]);
check('strikes mapped', sb.strikes.map((s) => [s.name, s.type, s.attack_bonus, s.damage_formula]), [['blade', 'melee', 15, '2d8+6 slashing']]);
check('hp/ac/saves', [sb.hp, sb.ac, sb.saves], [36, 19, { fortitude: 12, reflex: 6, will: 0 }]);
const csb = toCustomHazard(ch, '');
check('complex custom: is_complex/routine/reset', [csb.hazard?.is_complex, !!csb.hazard?.routine_html, !!csb.hazard?.reset_html], [true, true, true]);
check('complex custom: stealth_dc 24', csb.hazard?.stealth_dc, 24);

// --- assembleBundle path ----------------------------------------------------
const mk = (hazName: string) =>
  ExtractedAdventureZ.parse({
    title: 'Hazard Check',
    synopsis: 's',
    hazards: [{ name: hazName, level: 3, description: 'A blade trap in the hall.' }],
  });
const bundle = assembleBundle(mk('Rusty Blade Trap'), { pdfBytes: new Uint8Array([1]), pdfText: trapText });
const bv = validateBundle(bundle);
check('assembled bundle validates', bv.valid, true);
if (!bv.valid) console.error(JSON.stringify(bv.issues, null, 2));
const actor = bundle.actors.entities.find((a) => a.name === 'Rusty Blade Trap');
check('hazard actor prompt_version', actor?.ai_metadata?.prompt_version, 'statblock-hazard-1');
check('hazard actor category', actor?.category, 'hazard');
const asb = actor?.stat_block;
check('hazard actor stat_block custom with stealth_dc', asb?.kind === 'custom' ? asb.hazard?.stealth_dc : null, 21);
check('hazard actor strikes', asb?.kind === 'custom' ? asb.strikes.length : null, 1);

// Placeholder when the parse is near-empty.
const emptyBundle = assembleBundle(mk('The Pit'), { pdfBytes: new Uint8Array([1]), pdfText: emptyText });
const ev = validateBundle(emptyBundle);
check('placeholder bundle validates', ev.valid, true);
if (!ev.valid) console.error(JSON.stringify(ev.issues, null, 2));
check('near-empty stays placeholder', emptyBundle.actors.entities[0]?.ai_metadata?.prompt_version, 'worker-phase-2a');

// No pdfText -> placeholder.
const noText = assembleBundle(mk('Rusty Blade Trap'), { pdfBytes: new Uint8Array([1]) });
check('no pdfText stays placeholder', noText.actors.entities[0]?.ai_metadata?.prompt_version, 'worker-phase-2a');

if (failures.length) {
  console.error(`\n${failures.length} hazard check(s) failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nAll hazard checks passed');
