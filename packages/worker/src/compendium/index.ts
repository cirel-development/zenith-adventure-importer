/**
 * Runtime lookup over data/compendium-index.json (built by
 * scripts/build-compendium-index.ts from a pinned PF2e release).
 *
 * Matching is exact on a normalized name (case, accents, punctuation and a
 * leading "the" ignored). Fuzzy matching is deliberately out of scope here.
 *
 * Name-clash priority: the adventure's own pack, then pack tier
 * (Remaster core < legacy core < hazards < other bestiaries), then closest
 * level when a level is given, then pack name for determinism.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompendiumIndexFile, IndexEntry, IndexPack } from './indexTypes.js';

const DEFAULT_INDEX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'compendium-index.json');

export interface CompendiumMatch {
  uuid: string;
  name: string;
  id: string;
  pack: string;
  packLabel: string;
  type: string;
  level: number | null;
  rarity: string | null;
  /** Pack tier: 1 Remaster core / items, 2 legacy core, 3 hazards, 4 other bestiaries. */
  tier: number;
  /** How many index entries share this normalized name (and doc kind). */
  candidates: number;
}

export interface CreatureQuery {
  level?: number | null;
  /** Pack name of the adventure's own bestiary, see packForAdventure(). */
  adventurePack?: string | null;
}

export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

const GRADES = ['minor', 'lesser', 'moderate', 'greater', 'major', 'true'];

/**
 * Name forms to try for an item, most specific first:
 *   1. as written
 *   2. leading grade moved to PF2e's suffix form: "Minor Healing Potion" -> "Healing Potion (Minor)"
 *   3. non-grade parentheticals dropped: "Boots of Elvenkind (Cursed)" -> "Boots of Elvenkind"
 */
export function itemNameVariants(name: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    if (t && !out.includes(t)) out.push(t);
  };
  add(name);
  const lead = new RegExp(`^(${GRADES.join('|')})\\s+(.+)$`, 'i').exec(name.trim());
  if (lead) add(`${lead[2]} (${lead[1]![0]!.toUpperCase()}${lead[1]!.slice(1).toLowerCase()})`);
  const stripped = name.replace(/\s*\(([^)]*)\)/g, (m, inner: string) => (GRADES.includes(inner.trim().toLowerCase()) ? m : ''));
  add(stripped);
  return out;
}

const CREATURE_TYPES = new Set(['npc']);
const HAZARD_TYPES = new Set(['hazard']);

export class CompendiumIndex {
  readonly version: string;
  private readonly packs: IndexPack[];
  private readonly byName = new Map<string, IndexEntry[]>();

  constructor(data: CompendiumIndexFile) {
    this.version = data.source.version;
    this.packs = data.packs;
    for (const e of data.entries) {
      const key = normalizeName(e[0]);
      const list = this.byName.get(key);
      if (list) list.push(e);
      else this.byName.set(key, [e]);
    }
  }

  static load(path = DEFAULT_INDEX): CompendiumIndex {
    return new CompendiumIndex(JSON.parse(readFileSync(path, 'utf8')) as CompendiumIndexFile);
  }

  get size(): number {
    let n = 0;
    for (const list of this.byName.values()) n += list.length;
    return n;
  }

  findCreature(name: string, query: CreatureQuery = {}): CompendiumMatch | null {
    return this.best(name, (e) => this.packs[e[2]]!.docType === 'Actor' && CREATURE_TYPES.has(e[3]), query);
  }

  findHazard(name: string, query: CreatureQuery = {}): CompendiumMatch | null {
    return this.best(name, (e) => this.packs[e[2]]!.docType === 'Actor' && HAZARD_TYPES.has(e[3]), query);
  }

  /**
   * Equipment / consumables / weapons / armor etc. from equipment-srd only.
   * Tries the name as written, then variants (see itemNameVariants), so
   * "Moderate Alchemist's Fire" finds "Alchemist's Fire (Moderate)" and
   * "Boots of Elvenkind (Cursed)" finds the base "Boots of Elvenkind".
   * `variant` on the result says which form matched.
   */
  findItem(name: string): (CompendiumMatch & { variant: string }) | null {
    for (const variant of itemNameVariants(name)) {
      const hit = this.best(variant, (e) => this.packs[e[2]]!.name === 'equipment-srd', {});
      if (hit) return { ...hit, variant };
    }
    return null;
  }

  findSpell(name: string): CompendiumMatch | null {
    return this.best(name, (e) => this.packs[e[2]]!.name === 'spells-srd', {});
  }

  /**
   * The Actor pack whose label is the adventure's title, e.g. "The Fall of
   * Plaguestone" -> fall-of-plaguestone-bestiary. Null when none matches.
   */
  packForAdventure(title: string): string | null {
    const t = normalizeName(title);
    if (!t) return null;
    for (const p of this.packs) {
      if (p.docType !== 'Actor') continue;
      const label = normalizeName(p.label.replace(/\bbestiary\b/i, ''));
      if (label && (label === t || label === t.replace(/^pathfinder adventure /, ''))) return p.name;
    }
    return null;
  }

  private best(name: string, accept: (e: IndexEntry) => boolean, query: CreatureQuery): CompendiumMatch | null {
    const list = (this.byName.get(normalizeName(name)) ?? []).filter(accept);
    if (list.length === 0) return null;
    const level = query.level ?? null;
    const ranked = [...list].sort((a, b) => {
      const pa = this.packs[a[2]]!;
      const pb = this.packs[b[2]]!;
      if (query.adventurePack) {
        const oa = pa.name === query.adventurePack ? 0 : 1;
        const ob = pb.name === query.adventurePack ? 0 : 1;
        if (oa !== ob) return oa - ob;
      }
      if (pa.tier !== pb.tier) return pa.tier - pb.tier;
      if (level !== null) {
        const da = a[4] === null ? 99 : Math.abs(a[4] - level);
        const db = b[4] === null ? 99 : Math.abs(b[4] - level);
        if (da !== db) return da - db;
      }
      return pa.name.localeCompare(pb.name) || a[1].localeCompare(b[1]);
    });
    const e = ranked[0]!;
    const p = this.packs[e[2]]!;
    return {
      uuid: `Compendium.pf2e.${p.name}.${p.docType}.${e[1]}`,
      name: e[0],
      id: e[1],
      pack: p.name,
      packLabel: p.label,
      type: e[3],
      level: e[4],
      rarity: e[5],
      tier: p.tier,
      candidates: list.length,
    };
  }
}
