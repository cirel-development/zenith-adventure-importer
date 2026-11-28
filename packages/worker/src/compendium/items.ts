/**
 * v0.2.1: match extracted adventure items to PF2e's equipment compendium.
 *
 * Three outcomes per item:
 *   - plain match:  "Lesser Healing Potion" -> Healing Potion (Lesser)
 *   - base + runes: "+1 Striking Flaming Longsword" -> Longsword with potency 1,
 *                   striking, and the Flaming property rune; precious materials
 *                   ("Low-Grade Silver Rapier") ride along on the base item
 *   - no match:     the item stays custom (quest objects are never matched)
 *
 * Matching stays exact on normalized names; the name forms tried are listed
 * on `itemNameForms`. Anything that needed a guess (an unprinted grade) is
 * returned with a review reason.
 */
import { GRADES, itemNameVariants, type CompendiumIndex, type CompendiumMatch } from './index.js';

export type RuneType = 'weapon-potency' | 'striking' | 'armor-potency' | 'resilient' | 'property';

export interface PlannedRune {
  type: RuneType;
  uuid: string;
  rank?: number;
  name: string;
}

export interface PlannedMaterial {
  type: string;
  grade: 'low' | 'standard' | 'high';
}

export type ItemPlan =
  | { kind: 'match'; match: CompendiumMatch; material?: PlannedMaterial; reviewReasons: string[] }
  | { kind: 'runes'; base: CompendiumMatch; runes: PlannedRune[]; material?: PlannedMaterial; reviewReasons: string[] };

/** PF2e 8.x precious-material slugs; legacy names map to the Remaster ones. */
const MATERIALS: Record<string, string> = {
  abysium: 'abysium',
  adamantine: 'adamantine',
  'cold iron': 'cold-iron',
  dawnsilver: 'dawnsilver',
  mithral: 'dawnsilver',
  duskwood: 'duskwood',
  darkwood: 'duskwood',
  djezet: 'djezet',
  dragonhide: 'dragonhide',
  inubrix: 'inubrix',
  noqual: 'noqual',
  orichalcum: 'orichalcum',
  peachwood: 'peachwood',
  silver: 'silver',
  'sovereign steel': 'sovereign-steel',
  siccatite: 'siccatite',
  warpglass: 'warpglass',
};

/** Item kinds from the extraction that are plot objects, never compendium gear. */
const NEVER_MATCH_KIND = /\b(quest|handout|letter|note|key|map|ledger|journal|book)\b/i;

const WEAPON_OR_ARMOR = new Set(['weapon', 'armor', 'shield']);

/** Extra name forms beyond itemNameVariants: suffix words, reordering, " Armor". */
export function itemNameForms(name: string): string[] {
  const out: string[] = [];
  const exact = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    if (t && !out.includes(t)) out.push(t);
  };
  // itemNameVariants may drop parentheticals, so only feed it printed forms.
  const withVariants = (s: string) => itemNameVariants(s.replace(/\s+/g, ' ').trim()).forEach(exact);
  withVariants(name);
  // "Wolf Fang Talisman" -> "Wolf Fang"; "Shadow Rune Runestone" -> "Shadow".
  withVariants(name.replace(/\s+(?:rune\s+)?(?:talisman|runestone|rune)$/i, ''));
  // Generated forms are tried exactly as built, never trimmed further:
  // "Onyx Dog Wondrous Figurine" -> "Wondrous Figurine (Onyx Dog)".
  if (!name.includes('(')) {
    const words = name.trim().split(/\s+/);
    for (let k = 1; k < words.length; k++) exact(`${words.slice(k).join(' ')} (${words.slice(0, k).join(' ')})`);
  }
  // "Studded Leather" -> "Studded Leather Armor".
  if (!/armor$/i.test(name)) exact(`${name} Armor`);
  return out;
}

function findAny(idx: CompendiumIndex, name: string, accept?: (m: CompendiumMatch) => boolean): CompendiumMatch | null {
  for (const form of itemNameForms(name)) {
    const hit = idx.findItemExact(form);
    if (hit && (!accept || accept(hit))) return hit;
  }
  return null;
}

/** "Energy Mutagen" printed without a grade: the lowest-level graded form, if any. */
function lowestGrade(idx: CompendiumIndex, name: string): CompendiumMatch | null {
  const graded = GRADES.map((g) => idx.findItemExact(`${name} (${g[0]!.toUpperCase()}${g.slice(1)})`)).filter(
    (m): m is CompendiumMatch => !!m,
  );
  graded.sort((a, b) => (a.level ?? 99) - (b.level ?? 99));
  return graded[0] ?? null;
}

/** Leading precious material: "Low-Grade Silver Rapier", "Cold Iron Dagger". */
function takeMaterial(name: string): { material?: PlannedMaterial; rest: string; printedGrade: boolean } {
  const m = /^(?:(low|standard|high)[- ]grade\s+)?([a-z]+(?:\s[a-z]+)?)\s+(.+)$/i.exec(name.trim());
  if (!m) return { rest: name, printedGrade: false };
  for (const words of [m[2]!, m[2]!.split(' ')[0]!]) {
    const slug = MATERIALS[words.toLowerCase()];
    if (!slug) continue;
    const rest = words === m[2] ? m[3]! : `${m[2]!.split(' ').slice(1).join(' ')} ${m[3]}`;
    const grade = (m[1]?.toLowerCase() ?? 'low') as PlannedMaterial['grade'];
    return { material: { type: slug, grade }, rest: rest.trim(), printedGrade: !!m[1] };
  }
  return { rest: name, printedGrade: false };
}

/**
 * "+1 Striking Flaming Longsword (Fluff Fang)": potency, fundamental rune,
 * property runes, then the base weapon/armor (the longest suffix that is one).
 */
function planRunes(idx: CompendiumIndex, name: string): ItemPlan | null {
  const m = /^\+([1-4])\s+(.+?)(?:\s*\(([^)]*)\))?$/.exec(name.trim());
  if (!m) return null;
  const potency = Number(m[1]);
  let words = m[2]!.split(/\s+/);
  const reviewReasons: string[] = [];

  let fundamental: { type: 'striking' | 'resilient'; rank: number } | null = null;
  const rankWord = { greater: 2, major: 3 } as Record<string, number>;
  const f = /^(?:(greater|major)\s+)?(striking|resilient)$/i;
  for (const len of [2, 1]) {
    const hit = f.exec(words.slice(0, len).join(' '));
    if (hit) {
      fundamental = { type: hit[2]!.toLowerCase() as 'striking' | 'resilient', rank: hit[1] ? rankWord[hit[1].toLowerCase()]! : 1 };
      words = words.slice(len);
      break;
    }
  }

  const mat = takeMaterial(words.join(' '));
  words = mat.rest.split(/\s+/);

  // Base item: the longest suffix of the words that is a weapon/armor/shield.
  let base: CompendiumMatch | null = null;
  let baseStart = words.length;
  for (let i = 0; i < words.length; i++) {
    const hit = findAny(idx, words.slice(i).join(' '), (x) => WEAPON_OR_ARMOR.has(x.type));
    if (hit) {
      base = hit;
      baseStart = i;
      break;
    }
  }
  if (!base) return null;
  const isArmor = base.type !== 'weapon';

  const runes: PlannedRune[] = [];
  const potencyRune = idx.findItemExact(`${isArmor ? 'Armor' : 'Weapon'} Potency (+${potency})`);
  if (potencyRune) runes.push({ type: isArmor ? 'armor-potency' : 'weapon-potency', uuid: potencyRune.uuid, rank: potency, name: potencyRune.name });
  else reviewReasons.push(`No PF2e rune item for +${potency} potency; check the bonus by hand.`);

  if (fundamental) {
    const expected = isArmor ? 'resilient' : 'striking';
    if (fundamental.type !== expected) reviewReasons.push(`"${fundamental.type}" printed on ${base.type} ${base.name}; ignored.`);
    else {
      const label = fundamental.rank === 1 ? expected : `${expected} (${fundamental.rank === 2 ? 'Greater' : 'Major'})`;
      const r = idx.findItemExact(label.charAt(0).toUpperCase() + label.slice(1));
      if (r) runes.push({ type: expected, uuid: r.uuid, rank: fundamental.rank, name: r.name });
    }
  }

  // Property runes: greedy longest run of words that names a rune item.
  const prop = words.slice(0, baseStart);
  for (let i = 0; i < prop.length; ) {
    let took = 0;
    for (let j = prop.length; j > i; j--) {
      const phrase = prop.slice(i, j).join(' ');
      const r = findAny(idx, phrase, (x) => x.type === 'equipment');
      if (r) {
        runes.push({ type: 'property', uuid: r.uuid, name: r.name });
        took = j - i;
        break;
      }
    }
    if (!took) {
      reviewReasons.push(`"${prop[i]}" in "${name}" is not a known rune; left off.`);
      took = 1;
    }
    i += took;
  }

  if (mat.material && !mat.printedGrade) reviewReasons.push(`Material grade not printed; assumed low-grade ${mat.material.type}.`);
  return { kind: 'runes', base, runes, ...(mat.material ? { material: mat.material } : {}), reviewReasons };
}

/** Plan one extracted item; null means "stay custom". */
export function planItem(idx: CompendiumIndex, item: { name: string; kind?: string }): ItemPlan | null {
  if (item.kind && NEVER_MATCH_KIND.test(item.kind)) return null;
  const name = item.name.trim();

  const runes = planRunes(idx, name);
  if (runes) return runes;

  // "Low-Grade Silver Rapier": material on a plain base item.
  const mat = takeMaterial(name);
  if (mat.material) {
    const base = findAny(idx, mat.rest, (x) => WEAPON_OR_ARMOR.has(x.type));
    if (base)
      return {
        kind: 'match',
        match: base,
        material: mat.material,
        reviewReasons: mat.printedGrade ? [] : [`Material grade not printed; assumed low-grade ${mat.material.type}.`],
      };
  }

  const direct = findAny(idx, name);
  if (direct) return { kind: 'match', match: direct, reviewReasons: [] };

  for (const form of itemNameForms(name)) {
    const graded = lowestGrade(idx, form);
    if (graded) return { kind: 'match', match: graded, reviewReasons: [`Grade not printed for "${name}"; used the lowest, ${graded.name}. Check the PDF.`] };
  }
  return null;
}
