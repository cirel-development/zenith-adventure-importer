/**
 * In-Foundry integration tests for the importer, driven by the deterministic
 * test bundle from packages/worker/tests/build-test-bundle.ts.
 *
 * The cases are plain async functions so two runners can share them:
 *   - selfTest(): built-in, no dependencies. Run from the F12 console:
 *       await game.modules.get('zenith-adventure-importer').api.selfTest()
 *   - Quench: registered as batch "zenith-adventure-importer.fixture" when the
 *     Quench module is active.
 *
 * Every case asserts what PF2e should store, read from `_source` (what
 * survived PF2e's schema cleaning). A failure means the import is wrong,
 * not that the test restates the current code.
 *
 * Lifecycle: setup() undoes any stale test import, imports the fixture,
 * cases run, teardown() undoes it. The last case checks the undo itself.
 */
import { Importer } from '../pipeline/Importer.js';
import { UndoHandler } from '../apps/UndoHandler.js';
import { getAllImportRecords, getImportRecord, type ImportRecord } from '../settings.js';

/** Served by Foundry from <Data>/zenith-fixtures/ (setup.ps1 copies it there). */
export const FIXTURE_PATH = 'zenith-fixtures/test-bundle.zip';
const FIXTURE_ADVENTURE_SLUG = 'test-bundle-2a';
const EXPECTED_ACTORS = 20; // 16 custom + 1 parsed + 3 compendium-ref
const EXPECTED_ENTITIES = 4 /* folders */ + 1 /* journal */ + 1 /* item */ + EXPECTED_ACTORS;

export interface SuiteState {
  record: ImportRecord | null;
  entitiesCreated: number;
}

export interface TestCase {
  name: string;
  run: (state: SuiteState) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class AssertionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionFailed';
  }
}

function fmt(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function eq(actual: unknown, expected: unknown, what: string): void {
  // Arrays/objects compare by content, not identity.
  const same =
    typeof expected === 'object' && expected !== null ? fmt(actual) === fmt(expected) : actual === expected;
  if (!same) {
    throw new AssertionFailed(`${what}: expected ${fmt(expected)}, got ${fmt(actual)}`);
  }
}

function ok(cond: unknown, what: string): void {
  if (!cond) throw new AssertionFailed(what);
}

function includesAll(actual: unknown, expected: string[], what: string): void {
  const arr = Array.isArray(actual) ? actual : [];
  const missing = expected.filter((e) => !arr.includes(e));
  if (missing.length) {
    throw new AssertionFailed(`${what}: missing ${fmt(missing)} in ${fmt(actual)}`);
  }
}

function get(obj: any, path: string): unknown {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function requireRecord(state: SuiteState): ImportRecord {
  if (!state.record) throw new AssertionFailed('fixture was not imported (setup failed)');
  return state.record;
}

function doc(state: SuiteState, type: string, slug: string): any {
  const record = requireRecord(state);
  const entry = record.createdEntities.find((e) => e.type === type && e.slug === slug);
  if (!entry) throw new AssertionFailed(`no ${type} with slug "${slug}" in import record`);
  const collection = (game as any).collections.get(entry.collection);
  const found = collection?.get(entry.foundryId);
  if (!found) throw new AssertionFailed(`${type} "${slug}" (${entry.foundryId}) not found in ${entry.collection}`);
  return found;
}

const actor = (s: SuiteState, slug: string) => doc(s, 'actor', slug);
const src = (d: any, path: string) => get(d._source, path);

async function enrich(html: string): Promise<string> {
  const TE =
    (foundry as any).applications?.ux?.TextEditor?.implementation ??
    (globalThis as any).TextEditor;
  return TE.enrichHTML(html, { async: true });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function undoStaleFixtureImports(): Promise<void> {
  const stale = getAllImportRecords().filter((r) => r.adventureSlug === FIXTURE_ADVENTURE_SLUG);
  for (const r of stale) await new UndoHandler().undo(r);
}

export async function setup(state: SuiteState): Promise<void> {
  if (!(game as any).user?.isGM) throw new Error('Tests must run as a GM');
  if ((game as any).system?.id !== 'pf2e') throw new Error(`Tests need the pf2e system, world uses ${(game as any).system?.id}`);
  await undoStaleFixtureImports();
  const url = (foundry as any).utils.getRoute(FIXTURE_PATH);
  const summary = await new Importer().run({ kind: 'url', value: url });
  state.entitiesCreated = summary.entitiesCreated;
  state.record = getImportRecord(summary.bundleId);
}

export async function teardown(state: SuiteState): Promise<void> {
  if (state.record && getImportRecord(state.record.bundleId)) {
    await new UndoHandler().undo(state.record);
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const cases: TestCase[] = [
  {
    name: 'import creates every bundle entity',
    run: (s) => {
      eq(s.entitiesCreated, EXPECTED_ENTITIES, 'entities created');
      eq(requireRecord(s).createdEntities.filter((e) => e.type === 'actor').length, EXPECTED_ACTORS, 'actors in record');
    },
  },
  {
    name: 'folders: four "Bug Test Bundle" roots, one per document type',
    run: (s) => {
      const types = ['test-bundle-2a-actors', 'test-bundle-2a-items', 'test-bundle-2a-journals', 'test-bundle-2a-playlists']
        .map((slug) => doc(s, 'folder', slug))
        .map((f) => {
          eq(f.name, 'Bug Test Bundle', `folder ${f.id} name`);
          return f.type;
        });
      eq(types.sort().join(','), 'Actor,Item,JournalEntry,Playlist', 'folder types');
    },
  },
  ...(['common', 'uncommon', 'rare', 'unique'] as const).map<TestCase>((rarity) => ({
    name: `rarity: ${rarity} -> system.traits.rarity`,
    run: (s) => eq(src(actor(s, `rarity-${rarity}`), 'system.traits.rarity'), rarity, 'rarity'),
  })),
  {
    name: 'alignment: CE stored at system.details.alignment.value',
    run: (s) => eq(src(actor(s, 'alignment-ce'), 'system.details.alignment.value'), 'CE', 'alignment'),
  },
  {
    name: 'alignment: LG stored at system.details.alignment.value',
    run: (s) => eq(src(actor(s, 'alignment-lg'), 'system.details.alignment.value'), 'LG', 'alignment'),
  },
  {
    name: 'alignment: no-alignment is omitted',
    run: (s) => {
      const v = src(actor(s, 'alignment-none'), 'system.details.alignment.value');
      ok(v == null || v === '', `alignment should be empty, got ${fmt(v)}`);
    },
  },
  {
    name: 'category: npc and creature build type "npc"',
    run: (s) => {
      eq(actor(s, 'category-npc').type, 'npc', 'category-npc type');
      eq(actor(s, 'category-creature').type, 'npc', 'category-creature type');
    },
  },
  {
    name: 'category: hazard builds type "hazard" with traits',
    run: (s) => {
      const a = actor(s, 'category-hazard');
      eq(a.type, 'hazard', 'type');
      includesAll(src(a, 'system.traits.value'), ['mechanical', 'trap'], 'hazard traits');
      // PF2e 8.x hazards have no publicNotes; the text belongs in details.description.
      ok(String(src(a, 'system.details.description') ?? '').includes('Hazard'), 'hazard text in system.details.description');
    },
  },
  {
    name: 'notes: tactics_html lands in system.details.publicNotes',
    run: (s) => {
      const notes = String(src(actor(s, 'notes-plain'), 'system.details.publicNotes') ?? '');
      ok(notes.includes('tactics_html mapping works'), `publicNotes missing text: ${fmt(notes.slice(0, 120))}`);
    },
  },
  {
    name: 'notes: @Check / @Damage enrich into PF2e inline rolls',
    run: async (s) => {
      const notes = String(src(actor(s, 'notes-with-rolls'), 'system.details.publicNotes') ?? '');
      ok(notes.includes('@Check[type:fortitude|dc:18|basic:true]'), 'raw @Check syntax preserved');
      const html = await enrich(notes);
      ok(/inline-check|data-pf2-check/.test(html), 'enriched HTML has a PF2e check link');
      ok(/inline-roll|data-pf2-damage|data-damage-roll/.test(html), 'enriched HTML has a damage roll link');
    },
  },
  {
    name: 'traits: three trait tags stored',
    run: (s) => includesAll(src(actor(s, 'traits-three'), 'system.traits.value'), ['fey', 'gremlin', 'incorporeal'], 'traits'),
  },
  {
    name: 'size: tiny -> "tiny", huge -> "huge"',
    run: (s) => {
      eq(src(actor(s, 'size-tiny'), 'system.traits.size.value'), 'tiny', 'size-tiny');
      eq(src(actor(s, 'size-huge'), 'system.traits.size.value'), 'huge', 'size-huge');
    },
  },
  {
    name: 'size: medium -> PF2e slug "med"',
    run: (s) => eq(src(actor(s, 'category-npc'), 'system.traits.size.value'), 'med', 'size of a medium actor'),
  },
  {
    name: 'languages: Common/Sylvan/Undercommon -> PF2e Remaster slugs',
    run: (s) => {
      const langs = src(actor(s, 'language-mix'), 'system.details.languages.value');
      eq(fmt(langs), fmt(['common', 'fey', 'sakvroth']), 'language slugs');
      const known = Object.keys((CONFIG as any).PF2E.languages);
      const bad = (langs as string[]).filter((l) => !known.includes(l));
      eq(bad.length, 0, `slugs not in CONFIG.PF2E.languages (${fmt(bad)})`);
    },
  },
  {
    name: 'parsed stats: core numbers land where PF2e 8.x reads them',
    run: (s) => {
      const a = actor(s, 'parsed-full');
      eq(a.type, 'npc', 'type');
      eq([src(a, 'system.attributes.hp.max'), src(a, 'system.attributes.ac.value')], [48, 19], 'hp/ac');
      eq(src(a, 'system.perception.mod'), 9, 'perception at system.perception.mod');
      eq(a.system.perception?.mod, 9, 'perception as the sheet computes it');
      eq([src(a, 'system.saves.fortitude.value'), src(a, 'system.saves.reflex.value'), src(a, 'system.saves.will.value')], [12, 9, 7], 'saves');
      eq(src(a, 'system.abilities.int.mod'), -4, 'attribute');
      eq(src(a, 'system.attributes.speed.value'), 30, 'land speed');
      eq((src(a, 'system.attributes.speed.otherSpeeds') as any[]).map((o) => `${o.type}:${o.value}`), ['climb:15'], 'other speeds');
    },
  },
  {
    name: 'parsed stats: senses, skills, lore, defenses mapped to PF2e slugs',
    run: (s) => {
      const a = actor(s, 'parsed-full');
      eq(src(a, 'system.perception.senses'), [{ type: 'low-light-vision' }, { type: 'scent', acuity: 'imprecise', range: 30 }], 'senses');
      eq(src(a, 'system.perception.details'), 'smoke vision', 'unknown sense kept as text');
      eq([src(a, 'system.skills.athletics.base'), src(a, 'system.skills.stealth.base')], [10, 8], 'skills');
      const lore = a.items.find((i: any) => i.type === 'lore');
      eq([lore?.name, lore?.system?.mod?.value], ['Forest Lore', 7], 'lore skill is a lore item');
      eq((src(a, 'system.attributes.immunities') as any[]).map((i) => i.type), ['poison', 'sleep'], 'known immunities');
      eq((src(a, 'system.attributes.weaknesses') as any[]).map((w) => `${w.type}:${w.value}`), ['axe-vulnerability:5', 'cold-iron:3'], 'weakness slugs');
      const notes = String(src(a, 'system.details.publicNotes') ?? '');
      ok(notes.includes('Immunities: bramble magic'), 'unknown immunity kept in notes');
      ok(notes.includes('Stealth +8 (+10 in forests)'), 'skill note kept in notes');
    },
  },
  {
    name: 'parsed stats: strikes with damage parts, persistent, effects, ranges',
    run: (s) => {
      const a = actor(s, 'parsed-full');
      const strikes = a.items.filter((i: any) => i.type === 'melee');
      eq(strikes.map((i: any) => i.name), ['jaws', 'thorn', 'seed pod'], 'strike names');
      const jaws = strikes[0];
      eq(jaws._source.system.bonus.value, 12, 'attack bonus');
      eq(Object.values(jaws._source.system.damageRolls).map((r: any) => `${r.damage}|${r.damageType}|${r.category}`), ['1d10+4|piercing|null', '1d4|bleed|persistent'], 'damage rolls');
      eq(jaws._source.system.attackEffects.value, ['grab'], 'attack effect');
      ok(jaws._source.system.traits.value.includes('reach-10'), 'reach trait slug');
      const thorn = strikes[1];
      eq(thorn._source.system.range?.increment, 30, 'range increment');
      eq(thorn.isRanged, true, 'thorn is ranged');
      const pod = strikes[2];
      ok(pod._source.system.traits.value.includes('thrown-20'), 'thrown trait slug');
      eq(Object.keys(pod._source.system.damageRolls).length, 0, 'effect-only strike has no damage');
      ok(String(pod._source.system.description?.value ?? '').includes('sickened 1'), 'effect text kept');
    },
  },
  {
    name: 'compendium-ref NPC: Monster Core goblin + adventure notes overlay',
    run: (s) => {
      const a = actor(s, 'compendium-npc');
      eq(a.type, 'npc', 'type');
      eq(a.name, 'Compendium Test — Goblin Warrior', 'name from bundle');
      eq(src(a, 'system.details.level.value'), -1, 'level from compendium');
      ok((a.items?.size ?? 0) > 0, 'compendium strikes/abilities came along');
      const notes = String(src(a, 'system.details.publicNotes') ?? '');
      ok(notes.includes('<h3>In this adventure</h3>') && notes.includes('ZENITH-OVERLAY-NPC'), 'overlay appended to publicNotes');
      eq(notes.split('ZENITH-OVERLAY-NPC').length - 1, 1, 'overlay appears exactly once');
      eq(a.getFlag('zenith-adventure-importer', 'slug'), 'compendium-npc', 'zenith flags kept');
    },
  },
  {
    name: 'compendium-ref variant: base creature with the variant numbers applied',
    run: (s) => {
      const a = actor(s, 'compendium-variant');
      eq(a.type, 'npc', 'type');
      eq(src(a, 'system.details.level.value'), 0, 'level override');
      eq(src(a, 'system.traits.rarity'), 'unique', 'rarity override');
      eq([src(a, 'system.attributes.hp.max'), src(a, 'system.attributes.ac.value'), src(a, 'system.perception.mod')], [20, 18, 7], 'hp/ac/perception overrides');
      eq([src(a, 'system.saves.fortitude.value'), src(a, 'system.saves.reflex.value'), src(a, 'system.saves.will.value')], [6, 9, 4], 'save overrides');
      eq(src(a, 'system.skills.athletics.base'), 9, 'skill override');
      ok((a.items?.size ?? 0) > 0, "base creature's strikes kept");
    },
  },
  {
    name: 'compendium-ref hazard: real hazard stats + overlay in description',
    run: (s) => {
      const a = actor(s, 'compendium-hazard');
      eq(a.type, 'hazard', 'type');
      ok(typeof src(a, 'system.attributes.stealth.value') === 'number', 'structured stealth from compendium');
      const desc = String(src(a, 'system.details.description') ?? '');
      ok(desc.includes('ZENITH-OVERLAY-HAZARD'), 'overlay appended to details.description');
    },
  },
  {
    name: 'item: equipment with level, rarity, traits, price, description',
    run: (s) => {
      const item = doc(s, 'item', 'item-test-magic');
      eq(item.type, 'equipment', 'item type');
      eq(src(item, 'system.level.value'), 5, 'item level');
      eq(src(item, 'system.traits.rarity'), 'uncommon', 'item rarity');
      includesAll(src(item, 'system.traits.value'), ['magical', 'cursed'], 'item traits');
      const coins = (src(item, 'system.price.value') ?? {}) as Record<string, number>;
      const totalCp = (coins.pp ?? 0) * 1000 + (coins.gp ?? 0) * 100 + (coins.sp ?? 0) * 10 + (coins.cp ?? 0);
      eq(totalCp, 25000, `item price in cp (stored ${fmt(coins)})`);
      ok(String(src(item, 'system.description.value') ?? '').includes('@Damage[2d10[bludgeoning]]'), 'item description');
    },
  },
  {
    name: 'journal: overview entry with its checklist page',
    run: (s) => {
      const j = doc(s, 'journal', 'test-overview');
      eq(j.name, 'Bug Test Bundle — Overview', 'journal name');
      eq(j.pages.size, 1, 'page count');
      const page = j.pages.contents[0];
      eq(page.name, 'How to use this bundle', 'page name');
      ok(String(page.text?.content ?? '').includes('Verification checklist'), 'page content');
    },
  },
  {
    name: 'undo: removes every created document and the import record',
    run: async (s) => {
      const record = requireRecord(s);
      await new UndoHandler().undo(record);
      const leftovers = record.createdEntities.filter((e) =>
        (game as any).collections.get(e.collection)?.get(e.foundryId),
      );
      eq(leftovers.length, 0, `documents left after undo (${leftovers.map((e) => e.slug).join(', ')})`);
      eq(getImportRecord(record.bundleId), null, 'import record after undo');
    },
  },
];

// ---------------------------------------------------------------------------
// Built-in runner
// ---------------------------------------------------------------------------

export interface SelfTestResult {
  passed: number;
  failed: number;
  results: { test: string; status: 'pass' | 'fail'; detail: string }[];
}

export async function selfTest(): Promise<SelfTestResult> {
  const state: SuiteState = { record: null, entitiesCreated: 0 };
  const results: SelfTestResult['results'] = [];
  const started = performance.now();

  try {
    await setup(state);
  } catch (err) {
    results.push({ test: 'setup: import fixture', status: 'fail', detail: (err as Error).message });
  }

  for (const c of cases) {
    try {
      await c.run(state);
      results.push({ test: c.name, status: 'pass', detail: '' });
    } catch (err) {
      results.push({ test: c.name, status: 'fail', detail: (err as Error).message });
    }
  }

  try {
    await teardown(state);
  } catch (err) {
    results.push({ test: 'teardown: undo fixture', status: 'fail', detail: (err as Error).message });
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.length - passed;
  const ms = Math.round(performance.now() - started);
  const ver = `Foundry ${(game as any).version}, ${(game as any).system?.id} ${(game as any).system?.version}`;
  console.log(`%cZenith self-test: ${passed} passed, ${failed} failed (${ms} ms) — ${ver}`, `font-weight:bold;color:${failed ? '#c33' : '#3a3'}`);
  console.table(results);
  const msg = `Zenith self-test: ${passed} passed, ${failed} failed. See console (F12).`;
  if (failed) (ui as any).notifications.error(msg);
  else (ui as any).notifications.info(msg);
  return { passed, failed, results };
}

// ---------------------------------------------------------------------------
// Quench adapter
// ---------------------------------------------------------------------------

export function registerQuench(quench: any): void {
  quench.registerBatch(
    'zenith-adventure-importer.fixture',
    (context: any) => {
      const { describe, it, before, after } = context;
      describe('Test bundle import (packages/worker/test-bundle.zip)', function (this: any) {
        this.timeout(120_000);
        const state: SuiteState = { record: null, entitiesCreated: 0 };
        before(() => setup(state));
        after(() => teardown(state));
        for (const c of cases) it(c.name, () => c.run(state));
      });
    },
    { displayName: 'Zenith: test bundle import' },
  );
}
