/**
 * Offline checks: spell-line parsing, contract conversion, and spell UUID
 * resolution against the real compendium index.
 * Run: pnpm --filter @ai-adventure/worker test:spells
 * Sample text is invented in Paizo's layout (no published text in the repo).
 */
import { CompendiumIndex } from '../src/compendium/index.js';
import { spellResolver, toContractSpellcasting, unresolvedSpells } from '../src/statblock/link.js';
import { extractSpellcasting, LEGACY_SPELL_NAMES } from '../src/statblock/spells.js';

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `: expected ${e}, got ${a}`}`);
  if (!pass) failures.push(name);
};

// --- innate -----------------------------------------------------------------
const innateText =
  'Primal Innate Spells DC 17, attack +9; 2nd invisibility (×2), telekinetic hand (at will; self only); ' +
  'Cantrips (3rd) detect magic; Constant (5th) truespeech; 1st heal Rock Stride [one-action] The creature leaps.';
const innate = extractSpellcasting(innateText);
const ie = innate.entries[0]!;
check('innate: one entry', innate.entries.length, 1);
check('innate: header', [ie.name, ie.tradition, ie.type, ie.dc, ie.attack, ie.focusPoints], ['Primal Innate Spells', 'primal', 'innate', 17, 9, null]);
check('innate: ranks', ie.ranks.map((r) => [r.rank, r.cantrip, r.constant]), [[2, false, false], [3, true, false], [5, false, true], [1, false, false]]);
check('innate: uses', ie.ranks[0]!.spells[0], { name: 'invisibility', uses: 2 });
check('innate: at will; self only', ie.ranks[0]!.spells[1], { name: 'telekinetic hand', note: 'at will; self only' });
check('innate: heal is last spell', ie.ranks[3]!.spells, [{ name: 'heal' }]);
check('innate: rest keeps next ability', innate.rest, 'Rock Stride [one-action] The creature leaps.');

// --- stray space, source code, page refs -------------------------------------
const messy = extractSpellcasting(
  'Arcane Prepared Spells DC 20, attack +12; 2nd blazing fissure SoM , slow; Cantrips (1st) light , detect magic (page 70); 1st haste (page 70; at will) Strike [one-action] Hit.',
);
const me = messy.entries[0]!;
check('messy: source code dropped', me.ranks[0]!.spells.map((s) => s.name), ['blazing fissure', 'slow']);
check('messy: stray space before comma', me.ranks[1]!.spells.map((s) => s.name), ['light', 'detect magic']);
check('messy: page dropped', me.ranks[1]!.spells[1], { name: 'detect magic' });
check('messy: page + note keeps note', me.ranks[2]!.spells[0], { name: 'haste', note: 'at will' });
check('messy: rest', messy.rest, 'Strike [one-action] Hit.');

// --- missing rank label ------------------------------------------------------
const joined = extractSpellcasting('Occult Innate Spells DC 25; 4th invisibility (×2); read omens ; Slam [one-action] Hit.').entries[0]!;
check('missing rank label joins previous', joined.ranks.map((r) => [r.rank, r.spells.map((s) => s.name)]), [[4, ['invisibility', 'read omens']]]);
check('missing rank label keeps uses', joined.ranks[0]!.spells[0]!.uses, 2);

// --- prepared / spontaneous / focus ------------------------------------------
const prepared = extractSpellcasting('Arcane Prepared Spells DC 24, attack +16; 3rd fireball (×2); Cantrips (2nd) light').entries[0]!;
check('prepared: type and uses', [prepared.type, prepared.ranks[0]!.spells[0]!.uses], ['prepared', 2]);

const spont = extractSpellcasting('Occult Spontaneous Spells DC 28, attack +20; 3rd (4 slots) haste, slow; Cantrips (2nd) light').entries[0]!;
check('spontaneous: slots', [spont.type, spont.ranks[0]!.rank, spont.ranks[0]!.slots, spont.ranks[0]!.spells.map((s) => s.name)], ['spontaneous', 3, 4, ['haste', 'slow']]);
check('spontaneous: cantrip has no slots', spont.ranks[1]!.slots, undefined);

const focus = extractSpellcasting("Cleric Domain Spells 1 Focus Point, DC 18; 1st death's call").entries[0]!;
check('focus entry', [focus.name, focus.tradition, focus.type, focus.focusPoints, focus.dc, focus.attack], ['Cleric Domain Spells', 'divine', 'focus', 1, 18, null]);
check('focus spell', focus.ranks[0]!.spells, [{ name: "death's call" }]);

// --- two entries ---------------------------------------------------------------
const two = extractSpellcasting(
  "Divine Prepared Spells DC 22, attack +14; 1st heal; Cleric Domain Spells 1 Focus Point, DC 22; 1st death's call Rock Stride [one-action] Hit.",
);
check('two entries parsed', two.entries.map((e) => e.type), ['prepared', 'focus']);
check('two entries: rest has neither', [two.rest.includes('Spells'), two.rest.includes('heal'), two.rest.includes("death's call")], [false, false, false]);
check('two entries: rest', two.rest, 'Rock Stride [one-action] Hit.');

// --- left as text ----------------------------------------------------------------
const keep = (name: string, text: string) => {
  const r = extractSpellcasting(text);
  check(name, [r.entries.length, r.rest], [0, text]);
};
keep('ritual stays text', 'Divine Rituals DC 40; 4th sending');
keep('header without DC stays text', 'Arcane Innate Spells attack +5; 1st heal');
keep('heading without tradition/focus stays text', 'All Made One Spells DC 30; 1st heal');
keep('focus entry for unknown class stays text', 'Tinker Domain Spells 1 Focus Point, DC 18; 1st heal');

// --- toContractSpellcasting ------------------------------------------------------
const contract = toContractSpellcasting(extractSpellcasting(innateText).entries);
const c0 = contract[0]!;
check('contract: keys', Object.keys(c0.spells).sort(), ['0', '1', '2', '5']);
check('contract: cantrip under 0', c0.spells['0'], [{ name: 'detect magic' }]);
check('contract: constant note', c0.spells['5'], [{ name: 'truespeech', note: 'constant' }]);
check('contract: uses and note', c0.spells['2'], [{ name: 'invisibility', uses: 2 }, { name: 'telekinetic hand', note: 'at will; self only' }]);
check('contract: attack, no focus, no rank_slots', [c0.attack_bonus, 'focus_points' in c0, 'rank_slots' in c0], [9, false, false]);

const constNote = toContractSpellcasting(
  extractSpellcasting('Primal Innate Spells DC 17; Constant (4th) truespeech (self only)').entries,
)[0]!;
check('contract: constant joined with other notes', constNote.spells['4'], [{ name: 'truespeech', note: 'constant; self only' }]);

const spontContract = toContractSpellcasting([spont])[0]!;
check('contract: rank_slots spontaneous only', spontContract.rank_slots, { '3': 4 });
check('contract: spontaneous no focus_points', 'focus_points' in spontContract, false);
const focusContract = toContractSpellcasting([focus])[0]!;
check('contract: focus_points, no attack, no rank_slots', [focusContract.focus_points, 'attack_bonus' in focusContract, 'rank_slots' in focusContract], [1, false, false]);
check('contract: prepared no rank_slots', 'rank_slots' in toContractSpellcasting([prepared])[0]!, false);

const stub = toContractSpellcasting(extractSpellcasting(innateText).entries, (n) => (n === 'heal' ? 'Compendium.pf2e.spells-srd.Item.stub' : null))[0]!;
check('contract: uuid only when resolved', [stub.spells['1']![0]!.uuid, stub.spells['2']![0]!.uuid], ['Compendium.pf2e.spells-srd.Item.stub', undefined]);
check('unresolvedSpells lists the rest', unresolvedSpells({ spellcasting: [stub] } as never), ['detect magic', 'invisibility', 'telekinetic hand', 'truespeech']);

// --- real index --------------------------------------------------------------------
const idx = CompendiumIndex.load();
const resolve = spellResolver(idx);
const PREFIX = 'Compendium.pf2e.spells-srd.Item.';
for (const n of ['fireball', "mountain's resilience", 'magic missile']) {
  check(`resolver: ${n}`, resolve(n)?.startsWith(PREFIX) ?? false, true);
}
check('resolver: legacy magic missile = force barrage', resolve('magic missile'), idx.findSpell('force barrage')?.uuid ?? null);
check('resolver: elemental cantrip -> null', resolve('elemental cantrip'), null);

const unresolvedAliases = Object.entries(LEGACY_SPELL_NAMES).filter(([, v]) => !idx.findSpell(v)).map(([k, v]) => `${k} -> ${v}`);
check('every LEGACY_SPELL_NAMES value resolves', unresolvedAliases, []);

// Commas inside a note are the note's own; only "×N" and "page N" items are removed.
const commaNote = extractSpellcasting(
  'Arcane Innate Spells DC 22; 7th interplanar teleport (at will; to Astral Plane, Elemental Planes, or the Universe only); 4th mist (at will, page 73), fly (page 9, ×3, self only) Next',
).entries[0]!;
check('note keeps its commas', commaNote.ranks[0]!.spells[0]!.note, 'at will; to Astral Plane, Elemental Planes, or the Universe only');
check('note drops page and uses inside a comma list', commaNote.ranks[1]!.spells, [{ name: 'mist', note: 'at will' }, { name: 'fly', note: 'self only', uses: 3 }]);

if (failures.length) {
  console.error(`\n${failures.length} spells check(s) failed`);
  process.exit(1);
}
console.log('\nAll spells checks passed');
