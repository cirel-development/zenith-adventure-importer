/**
 * Offline checks for the stat-block AI fallback (no API, no model).
 * Run: pnpm --filter @ai-adventure/worker test:fallback
 * Blocks are invented in Paizo's layout.
 */
import { assembleBundle } from '../src/bundle/assemble.js';
import { ExtractedAdventureZ } from '../src/pipeline/extractAdventure.js';
import {
  applyFallbackAnswers,
  buildFallbackMessage,
  collectFallbackCandidates,
  estimateOutputTokens,
  mergeFallback,
  parseFallbackAnswer,
  planFallbackBatches,
} from '../src/statblock/ai-fallback.js';

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `: expected ${e}, got ${a}`}`);
  if (!pass) failures.push(name);
};

// Second block is garbled the way a bad page split can garble one: no AC/saves/HP line.
const text =
  'MARSH WOLF CREATURE 2 N MEDIUM ANIMAL Perception +8; low-light vision Str +3, Dex +3, Con +2, Int -4, Wis +2, Cha -2 ' +
  'AC 17; Fort +8, Ref +9, Will +6 HP 30 Speed 35 feet Melee [one-action] jaws +10, Damage 1d8+3 piercing ' +
  'BOG NOTES The wolves hunt at dusk. ' +
  'REED HAG CREATURE 4 UNCOMMON CE MEDIUM FEY Perception +11; darkvision Str +2, Dex +3, Con +2, Int +1, Wis +3, Cha +4 ' +
  'Speed 25 feet, swim 25 feet Melee [one-action] claw +12 (agile), Damage 2d6+4 slashing ' +
  'MIRE NOTES The hag rarely leaves the reeds.';

const extracted = ExtractedAdventureZ.parse({
  title: 'Fallback Check',
  synopsis: 's',
  npcs: [
    { name: 'Marsh Wolf', role: 'beast', description: 'Wolf.', level: 2, category: 'creature' },
    { name: 'Reed Hag', role: 'villain', description: 'Hag.', level: 4 },
  ],
});

const candidates = collectFallbackCandidates(extracted, text, undefined);
check('only the low-confidence block is a candidate', candidates.map((c) => [c.name, c.missing]), [['Reed Hag', ['ac', 'saves', 'hp']]]);
check('threshold can force more', collectFallbackCandidates(extracted, text, undefined, 1.01).length, 2);

const many = Array.from({ length: 10 }, () => candidates[0]!);
const per = estimateOutputTokens(candidates[0]!);
check('batches split under 80% of the budget', planFallbackBatches(many, Math.ceil((per * 3) / 0.8)).map((b) => b.length), [3, 3, 3, 1]);
check('one batch when it fits', planFallbackBatches(many, 32000).length, 1);

const msg = buildFallbackMessage(candidates);
check('request carries id and verbatim text', msg.includes('id="reed hag"') && msg.includes('Melee [one-action] claw +12'), true);

const answer = parseFallbackAnswer({
  blocks: [
    {
      id: 'reed hag',
      name: 'Reed Hag',
      level: 4,
      ac: 20,
      saves: { fortitude: 10, reflex: 11, will: 13 },
      hp: 60,
      perception: 99, // conflicts with the regex value; regex must win
      speeds: { land: 25, swim: 25 },
      strikes: [{ kind: 'melee', name: 'claw', bonus: 12, damage: [{ formula: '2d6 + 4', type: 'slashing' }] }],
    },
  ],
});
check('answer parsed', [...answer.keys()], ['reed hag']);
check('answer damage normalized', answer.get('reed hag')!.strikes[0]!.damage, [{ formula: '2d6+4', type: 'slashing', persistent: false }]);

const merged = mergeFallback(candidates[0]!.regex, answer.get('reed hag')!);
check('fallback fills only what regex missed', [merged.ac, merged.hp, merged.saves?.will, merged.perception], [20, 60, 13, 11]);

const fixes = applyFallbackAnswers(candidates, answer);
const bundle = assembleBundle(extracted, { pdfBytes: new Uint8Array([1]), pdfText: text, statBlockFixes: fixes });
const hag = bundle.actors.entities.find((a) => a.name === 'Reed Hag')!;
check('assemble uses the fix', hag.stat_block.kind === 'custom' ? [hag.stat_block.ac, hag.stat_block.hp] : null, [20, 60]);
check('marked as AI-filled and flagged', [hag.ai_metadata?.prompt_version, hag.ai_metadata?.review_required], ['statblock-ai-1', true]);
const wolf = bundle.actors.entities.find((a) => a.name === 'Marsh Wolf')!;
check('confident block untouched', wolf.ai_metadata?.prompt_version, 'statblock-regex-1');

let threw = false;
try {
  parseFallbackAnswer({ blocks: [{ id: 'x' }] });
} catch {
  threw = true;
}
check('malformed answer rejected', threw, true);

if (failures.length) {
  console.error(`\n${failures.length} fallback check(s) failed`);
  process.exit(1);
}
console.log('\nAll fallback checks passed');
