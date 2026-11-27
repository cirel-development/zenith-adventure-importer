/**
 * Score the stat-block parser against PF2e's own data for the same creatures.
 *
 *   pnpm --filter @ai-adventure/worker test:statblocks -- --text <user-message.md> --pack <folder> [--pack <folder>] [--verbose]
 *
 * <user-message.md> comes from `prepare:sim <pdf>` (the extracted PDF text).
 * <folder> is a pack folder inside the cached json-assets.zip (run build:index
 * first), e.g. fall-of-plaguestone, one-shot-bestiary, rage-of-elements-bestiary.
 * Prints per-field accuracy over every full block that has a PF2e twin.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { scanStatBlocks } from '../src/statblock/scan.js';
import { parseStatBlock, type ParsedStatBlock } from '../src/statblock/parse.js';
import { normalizeName } from '../src/compendium/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const textPath = args[args.indexOf('--text') + 1]!;
const packs = args.flatMap((a, i) => (a === '--pack' ? [args[i + 1]!] : []));
const verbose = args.includes('--verbose');
const version = args.includes('--version') ? args[args.indexOf('--version') + 1]! : '8.7.1';

const zip = unzipSync(readFileSync(join(HERE, '..', '.cache', `pf2e-${version}`, 'json-assets.zip')), {
  filter: (f) => packs.some((p) => f.name === `packs/${p}.json`),
});
const truth = packs.flatMap((p) => {
  const f = zip[`packs/${p}.json`];
  if (!f) throw new Error(`pack folder ${p} not in json-assets.zip`);
  return (JSON.parse(strFromU8(f)) as any[]).filter((d) => d.type === 'npc');
});
const byName = new Map(truth.map((d) => [normalizeName(d.name), d]));

function singulars(name: string): string[] {
  const n = normalizeName(name);
  return [n, n.replace(/ves$/, 'f'), n.replace(/ies$/, 'y'), n.replace(/es$/, ''), n.replace(/s$/, '')];
}
const SIZE: Record<string, string> = { tiny: 'tiny', small: 'sm', medium: 'med', large: 'lg', huge: 'huge', gargantuan: 'grg' };

type Check = [field: string, ok: boolean, got: unknown, want: unknown];
function compare(p: ParsedStatBlock, d: any): Check[] {
  const s = d.system;
  const melee = (d.items as any[]).filter((i) => i.type === 'melee');
  const tStrikes = melee.map((i) => ({
    name: normalizeName(i.name),
    bonus: i.system.bonus.value,
    rolls: Object.values(i.system.damageRolls ?? {}) as any[],
    get dmg() {
      return this.rolls[0];
    },
  }));
  const pStrikes = p.strikes.map((x) => ({ name: normalizeName(x.name), bonus: x.bonus, dmg: x.damage[0] }));
  const strikeBonusOk =
    pStrikes.length === tStrikes.length && pStrikes.every((x) => tStrikes.some((t) => t.name === x.name && t.bonus === x.bonus));
  const strikeDmgOk =
    pStrikes.length === tStrikes.length &&
    pStrikes.every((x) =>
      // PF2e stores a strike's damage rolls in no fixed order; accept a match
      // against any of them ("3d8+11 bludgeoning plus 2d4 fire").
      tStrikes.some(
        (t) =>
          t.name === x.name &&
          // effect-only strikes ("hot air ... Effect pushed 5 feet") have no rolls on either side
          (x.dmg
            ? t.rolls.some((r) => r.damage.replace(/\s/g, '') === x.dmg!.formula && (!x.dmg!.type || r.damageType === x.dmg!.type))
            : t.rolls.length === 0),
      ),
    );
  const tSkills = Object.entries(s.skills ?? {}).map(([k, v]: [string, any]) => `${k}:${v.base}`).sort();
  const pSkills = p.skills
    .filter((k) => !/lore/i.test(k.name))
    .map((k) => `${normalizeName(k.name).replace(/ /g, '-')}:${k.bonus}`)
    .sort();
  const tAttr = ['str', 'dex', 'con', 'int', 'wis', 'cha'].map((k) => s.abilities[k].mod);
  const pAttr = p.attributes ? ['str', 'dex', 'con', 'int', 'wis', 'cha'].map((k) => (p.attributes as any)[k]) : null;
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  // PF2e adds chaotic/evil/good/lawful traits from legacy alignment; the parser
  // keeps alignment separately, so compare traits without them.
  const ALIGN = new Set(['chaotic', 'evil', 'good', 'lawful']);
  const slug = (x: string) => normalizeName(x).replace(/ /g, '-');
  const tImm = (s.attributes.immunities ?? []).map((i: any) => i.type).sort();
  const pImm = p.immunities.map(slug).sort();
  const tWeak = (s.attributes.weaknesses ?? []).map((w: any) => `${w.type}:${w.value}`).sort();
  const pWeak = p.weaknesses.map((w) => `${slug(w.type)}:${w.value}`).sort();
  const tRes = (s.attributes.resistances ?? []).map((r: any) => `${r.type}:${r.value}`).sort();
  const pRes = p.resistances.map((r) => `${slug(r.type)}:${r.value}`).sort();
  return [
    ['level', p.level === s.details.level.value, p.level, s.details.level.value],
    ['rarity', p.rarity === s.traits.rarity, p.rarity, s.traits.rarity],
    ['size', SIZE[p.size ?? ''] === s.traits.size.value, p.size, s.traits.size.value],
    ['traits', eq([...p.traits].sort(), s.traits.value.filter((x: string) => !ALIGN.has(x)).sort()), p.traits, s.traits.value],
    ['perception', p.perception === s.perception.mod, p.perception, s.perception.mod],
    ['attributes', eq(pAttr, tAttr), pAttr, tAttr],
    ['ac', p.ac === s.attributes.ac.value, p.ac, s.attributes.ac.value],
    ['saves', eq(p.saves && [p.saves.fortitude, p.saves.reflex, p.saves.will], [s.saves.fortitude.value, s.saves.reflex.value, s.saves.will.value]), p.saves, s.saves],
    ['hp', p.hp === s.attributes.hp.max, p.hp, s.attributes.hp.max],
    ['speed', p.speeds?.land === s.attributes.speed.value, p.speeds?.land, s.attributes.speed.value],
    ['immunities', eq(pImm, tImm), pImm, tImm],
    ['weaknesses', eq(pWeak, tWeak), pWeak, tWeak],
    ['resistances', eq(pRes, tRes), pRes, tRes],
    ['skills', eq(pSkills, tSkills), pSkills, tSkills],
    ['strike bonus', strikeBonusOk, pStrikes.map((x) => `${x.name} ${x.bonus}`), tStrikes.map((x) => `${x.name} ${x.bonus}`)],
    ['strike damage', strikeDmgOk, pStrikes.map((x) => `${x.name} ${x.dmg?.formula} ${x.dmg?.type}`), tStrikes.map((x) => `${x.name} ${x.dmg?.damage} ${x.dmg?.damageType}`)],
  ];
}

const text = readFileSync(textPath, 'utf8');
const blocks = scanStatBlocks(text);
const forms = blocks.reduce<Record<string, number>>((acc, b) => ((acc[b.form] = (acc[b.form] ?? 0) + 1), acc), {});
console.log(`scanned ${blocks.length} headers: ${JSON.stringify(forms)}`);

const tally = new Map<string, [number, number]>();
let compared = 0;
const unmatched: string[] = [];
const confidences: number[] = [];
for (const b of blocks.filter((x) => x.form === 'full')) {
  const doc = singulars(b.name).map((n) => byName.get(n)).find(Boolean);
  const { block, confidence, missing } = parseStatBlock(b);
  confidences.push(confidence);
  if (!doc) {
    unmatched.push(`${b.name} (conf ${confidence})`);
    continue;
  }
  compared++;
  const checks = compare(block, doc);
  const bad = checks.filter((c) => !c[1]);
  for (const [f, ok] of checks) {
    const t = tally.get(f) ?? [0, 0];
    tally.set(f, [t[0] + (ok ? 1 : 0), t[1] + 1]);
  }
  if (verbose || bad.length) {
    console.log(`\n${b.name} -> ${doc.name}  conf ${confidence}${missing.length ? ` missing ${missing.join(',')}` : ''}`);
    for (const [f, , got, want] of bad) console.log(`   ✗ ${f}: got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
  }
}

console.log(`\n=== accuracy over ${compared} blocks with a PF2e twin ===`);
let okAll = 0;
let nAll = 0;
for (const [f, [ok, n]] of tally) {
  okAll += ok;
  nAll += n;
  console.log(`${f.padEnd(14)} ${String(ok).padStart(3)}/${n}  ${((100 * ok) / n).toFixed(0)}%`);
}
if (nAll) console.log(`${'ALL FIELDS'.padEnd(14)} ${okAll}/${nAll}  ${((100 * okAll) / nAll).toFixed(1)}%`);
const high = confidences.filter((c) => c >= 0.7).length;
console.log(`confidence >= 0.7: ${high}/${confidences.length} full blocks`);
if (unmatched.length) console.log(`full blocks with no PF2e twin: ${unmatched.join('; ')}`);
