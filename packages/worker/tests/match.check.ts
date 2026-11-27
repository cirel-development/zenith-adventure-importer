/**
 * Offline checks for the Phase 2B creature lookup pass (compendium/match.ts)
 * and its wiring into assembleBundle. No network, no AI.
 * Run: pnpm --filter @ai-adventure/worker test:match
 */
import { validateBundle } from '@ai-adventure/contract';
import { assembleBundle } from '../src/bundle/assemble.js';
import { CompendiumIndex } from '../src/compendium/index.js';
import { planActorMatches } from '../src/compendium/match.js';
import { ExtractedAdventureZ } from '../src/pipeline/extractAdventure.js';

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `: expected ${e}, got ${a}`}`);
  if (!pass) failures.push(name);
};

const idx = CompendiumIndex.load();
const n = (name: string, level: number | null) => ({ name, level });

// --- A Few Flowers More: stat blocks live in one-shot-bestiary ("One-Shots"),
// so the adventure pack comes from the majority of hits, not the title.
const afm = planActorMatches(idx, {
  title: 'A Few Flowers More',
  npcs: [n('Vilm', 1), n('Jinkin Ripclaw', 1), n('Carl the Cobbler', 5), n('Stella', null)],
  hazards: [n('Hidden Spiked Pit', 2)],
});
check('AFM adventure pack (majority)', [afm.adventurePack, afm.adventurePackSource], ['one-shot-bestiary', 'majority']);
check('AFM npc packs', afm.npcs.map((d) => d?.match.pack ?? null), ['one-shot-bestiary', 'one-shot-bestiary', 'one-shot-bestiary', null]);
check('AFM adventure-pack matches need no review', afm.npcs.slice(0, 3).map((d) => d?.reviewReasons.length), [0, 0, 0]);
check('AFM hazard', afm.hazards[0]?.match.uuid.startsWith('Compendium.pf2e.one-shot-bestiary.Actor.'), true);

// --- Level rule outside the adventure pack (Goblin Warrior is Monster Core L-1).
const lv = (level: number | null) =>
  planActorMatches(idx, { title: 'Some Homebrew', npcs: [n('Goblin Warrior', level)], hazards: [] }).npcs[0];
check('level equal -> accept, no review', [lv(-1)?.match.pack, lv(-1)?.reviewReasons.length], ['pathfinder-monster-core', 0]);
check('level off by 1 -> accept, review', [lv(0)?.match.pack, lv(0)?.reviewReasons.length], ['pathfinder-monster-core', 1]);
check('level off by 3 -> custom', lv(2), null);
check('no level -> accept, review', [lv(null)?.match.name, lv(null)?.reviewReasons.length], ['Goblin Warrior', 1]);

// --- Elite/Weak prefixes: base creature + PF2e adjustment (Ghost Commoner is Monster Core L4).
const weak = planActorMatches(idx, { title: 'Some Homebrew', npcs: [n('Weak Ghost Commoner', 3)], hazards: [] }).npcs[0];
check('weak prefix -> base + adjustment', [weak?.match.name, weak?.adjustment, weak?.match.pack], ['Ghost Commoner', 'weak', 'pathfinder-monster-core']);
const elite = planActorMatches(idx, { title: 'Some Homebrew', npcs: [n('Elite Ghost Commoner', 5)], hazards: [] }).npcs[0];
check('elite prefix -> base + adjustment', [elite?.match.name, elite?.adjustment], ['Ghost Commoner', 'elite']);
check('weak with wrong level -> custom', planActorMatches(idx, { title: 'x', npcs: [n('Weak Ghost Commoner', 9)], hazards: [] }).npcs[0], null);

// --- Title-based adventure pack.
const plague = planActorMatches(idx, { title: 'The Fall of Plaguestone', npcs: [], hazards: [] });
check('Plaguestone pack from title', [plague.adventurePack, plague.adventurePackSource], ['fall-of-plaguestone-bestiary', 'title']);

// --- assembleBundle wiring.
const extracted = ExtractedAdventureZ.parse({
  title: 'A Few Flowers More',
  synopsis: 's',
  chapters: [{ name: "Harvester's Camp", slug: 'harvesters-camp', summary: 'c' }],
  npcs: [
    { name: 'Vilm', role: 'Gremlin boss', description: 'Leads the jinkins.', level: 1, chapter_slug: 'harvesters-camp' },
    { name: 'Stella', role: 'Quest giver', description: 'A sprite.', chapter_slug: null },
  ],
  hazards: [{ name: 'Hidden Spiked Pit', level: 2, description: 'A pit with knives.', chapter_slug: 'harvesters-camp' }],
});
const bundle = assembleBundle(extracted, { pdfBytes: new Uint8Array([1]), compendium: idx });
const result = validateBundle(bundle);
check('bundle validates', result.valid, true);
if (!result.valid) console.error(JSON.stringify(result.issues, null, 2));
const byName = (name: string) => bundle.actors.entities.find((a) => a.name === name)!;
const vilm = byName('Vilm').stat_block;
check('Vilm is compendium-ref', vilm.kind, 'compendium-ref');
check('Vilm version pin', vilm.kind === 'compendium-ref' ? vilm.version_pin : null, 'pf2e@8.7.1');
check('Vilm notes overlay', vilm.kind === 'compendium-ref' && vilm.notes_html?.includes('Leads the jinkins.'), true);
check('Stella stays custom', byName('Stella').stat_block.kind, 'custom');
check('pit is compendium-ref', byName('Hidden Spiked Pit').stat_block.kind, 'compendium-ref');
check('manifest actor stats', bundle.manifest.stats.actors, { compendium: 2, custom: 1, review_needed: 1 });
check('placeholder warning mentions matches', bundle.manifest.warnings[0]?.message.startsWith('2 of 3'), true);

// --- Without an index nothing changes (backward compatible).
const plain = assembleBundle(extracted, { pdfBytes: new Uint8Array([1]) });
check('no index -> all custom', plain.actors.entities.map((a) => a.stat_block.kind), ['custom', 'custom', 'custom']);

if (failures.length) {
  console.error(`\n${failures.length} match check(s) failed`);
  process.exit(1);
}
console.log('\nAll match checks passed');
