/**
 * Pure mappings from contract values to PF2e system slugs.
 *
 * Verified against PF2e 8.7.1 on Foundry 14.371 (2026-11-27):
 *   - CONFIG.PF2E.actorSizes keys: tiny, sm, med, lg, huge, grg
 *   - CONFIG.PF2E.languages uses lowercase Remaster slugs; legacy names
 *     (sylvan, undercommon, abyssal, infernal, celestial, terran, ignan,
 *     aquan, auran) are absent, their Remaster names are present.
 *
 * No Foundry globals here so these run in offline checks too.
 */

const SIZE_TO_PF2E: Record<string, string> = {
  tiny: 'tiny',
  small: 'sm',
  sm: 'sm',
  medium: 'med',
  med: 'med',
  large: 'lg',
  lg: 'lg',
  huge: 'huge',
  gargantuan: 'grg',
  grg: 'grg',
};

/** Contract size ('medium') -> PF2e slug ('med'). Unknown values fall back to 'med'. */
export function toPf2eSize(size: string | undefined | null): string {
  return SIZE_TO_PF2E[(size ?? '').trim().toLowerCase()] ?? 'med';
}

/**
 * Hazard traits PF2e will keep. PF2e silently drops values that are not in
 * CONFIG.PF2E.hazardTraits (e.g. "hazard", the stat-block header word), so
 * filter first and fall back to "mechanical" when nothing valid remains.
 * @param known  Object.keys(CONFIG.PF2E.hazardTraits); omit outside Foundry.
 */
export function toPf2eHazardTraits(traits: readonly string[], known?: Iterable<string>): string[] {
  const knownSet = known ? new Set(known) : null;
  const out: string[] = [];
  for (const raw of traits) {
    const t = raw.trim().toLowerCase();
    if (!t || t === 'hazard' || out.includes(t)) continue;
    if (!knownSet || knownSet.has(t)) out.push(t);
  }
  return out.length > 0 ? out : ['mechanical'];
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// ---------------------------------------------------------------------------
// Senses — PF2e 8.7.1: system.perception.senses = [{ type, acuity?, range? }]
// ---------------------------------------------------------------------------

export interface Pf2eSense {
  type: string;
  acuity?: 'precise' | 'imprecise' | 'vague';
  range?: number;
}

/**
 * "low-light vision", "scent (imprecise) 30 feet", "tremorsense (imprecise) 60 feet".
 * Senses PF2e doesn't know ("smoke vision") go to `details` as text.
 */
export function toPf2eSenses(senses: readonly string[], known?: Iterable<string>): { senses: Pf2eSense[]; details: string } {
  const knownSet = known ? new Set(known) : null;
  const out: Pf2eSense[] = [];
  const unknown: string[] = [];
  for (const raw of senses) {
    const m = /^(.+?)(?:\s\((precise|imprecise|vague)\))?(?:\s(\d+)\s?feet)?$/i.exec(raw.trim());
    const type = slugify(m?.[1] ?? raw);
    if (m && type && (!knownSet || knownSet.has(type))) {
      out.push({
        type,
        ...(m[2] ? { acuity: m[2].toLowerCase() as Pf2eSense['acuity'] } : {}),
        ...(m[3] ? { range: Number(m[3]) } : {}),
      });
    } else if (raw.trim()) unknown.push(raw.trim());
  }
  return { senses: out, details: unknown.join(', ') };
}

// ---------------------------------------------------------------------------
// Immunities / weaknesses / resistances — PF2e type slugs
// ---------------------------------------------------------------------------

/** Printed names whose PF2e slug is not just the slugified name. */
const DEFENSE_ALIASES: Record<string, string> = {
  axes: 'axe-vulnerability',
  'visual effects': 'visual',
  all: 'all-damage',
  'all damage': 'all-damage',
  'auditory effects': 'auditory',
  'olfactory effects': 'olfactory',
  'emotion effects': 'emotion',
  'fear effects': 'fear-effects',
};

export function toPf2eDefenseType(name: string): string {
  const n = name.trim().toLowerCase();
  return DEFENSE_ALIASES[n] ?? slugify(n);
}

/**
 * Keep entries PF2e knows (CONFIG.PF2E.immunityTypes etc.); return the rest
 * as text. An unknown type can make PF2e reject the whole actor, so it never
 * goes into the structured field.
 */
export function splitKnownDefenses<T extends { type: string }>(
  entries: readonly T[],
  known?: Iterable<string>,
): { kept: T[]; unknownText: string } {
  const knownSet = known ? new Set(known) : null;
  const kept: T[] = [];
  const unknown: string[] = [];
  for (const e of entries) {
    const type = toPf2eDefenseType(e.type);
    if (!knownSet || knownSet.has(type)) kept.push({ ...e, type });
    else unknown.push('value' in e ? `${e.type} ${(e as { value?: number }).value}` : e.type);
  }
  return { kept, unknownText: unknown.join(', ') };
}

// ---------------------------------------------------------------------------
// Strikes — PF2e "melee" items (melee and ranged)
// ---------------------------------------------------------------------------

export interface Pf2eDamageRoll {
  damage: string;
  damageType: string;
  category: 'persistent' | null;
}

/** "1d6+2 piercing plus 1d4 acid plus 1d4 persistent bleed" -> damage rolls. */
export function toPf2eDamageRolls(formula: string): Pf2eDamageRoll[] {
  if (!formula.trim()) return [];
  return formula
    .split(/\s+plus\s+/)
    .map((part) => /^(\d+(?:d\d+)?(?:[+-]\d+)?)(?:\s(persistent))?(?:\s([a-z]+))?$/.exec(part.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ damage: m[1]!, damageType: m[3] ?? 'untyped', category: m[2] ? ('persistent' as const) : null }));
}

/**
 * Printed strike traits -> PF2e trait slugs, pulling range out:
 *   "reach 10 feet" -> reach-10, "thrown 20 feet" -> thrown-20, "versatile S" -> versatile-s,
 *   "deadly d10" -> deadly-d10, "reload 1" -> reload-1,
 *   "range increment 30 feet" -> range { increment: 30 }, "range 20 feet" -> range { max: 20 }.
 */
export function toPf2eStrikeTraits(traits: readonly string[]): {
  traits: string[];
  range: { increment: number | null; max: number | null } | null;
} {
  const out: string[] = [];
  let range: { increment: number | null; max: number | null } | null = null;
  for (const raw of traits) {
    const t = raw.trim().toLowerCase();
    const inc = /^range increment (\d+)\s?feet$/.exec(t);
    const max = /^range (\d+)\s?feet$/.exec(t);
    if (inc) range = { increment: Number(inc[1]), max: null };
    else if (max) range = { increment: null, max: Number(max[1]) };
    else out.push(slugify(t.replace(/\s?feet$/, '')));
  }
  return { traits: out.filter(Boolean), range };
}

/** "Grab", "Improved Knockdown" -> PF2e attackEffects slugs. */
export function toPf2eAttackEffects(effects: readonly string[]): string[] {
  return effects.map((e) => slugify(e)).filter(Boolean);
}

const SKILL_ALIASES: Record<string, string> = { arcane: 'arcana', occult: 'occultism' };

/** Printed skill name -> PF2e skill slug ("Arcane" -> arcana). */
export function toPf2eSkillSlug(name: string): string {
  const s = slugify(name);
  return SKILL_ALIASES[s] ?? s;
}

/** Lore skills are separate "lore" items on PF2e NPCs, not system.skills. */
export function isLoreSkill(name: string): boolean {
  return /\blore\b/i.test(name);
}

/** Pre-Remaster language names -> Remaster slugs. */
const LEGACY_LANGUAGE_TO_REMASTER: Record<string, string> = {
  sylvan: 'fey',
  undercommon: 'sakvroth',
  abyssal: 'chthonian',
  infernal: 'diabolic',
  celestial: 'empyrean',
  terran: 'petran',
  ignan: 'pyric',
  aquan: 'thalassic',
  auran: 'sussuran',
};

export interface Pf2eLanguages {
  /** Slugs PF2e knows (or all normalized slugs when `known` is not given). */
  value: string[];
  /** Comma-separated names PF2e does not know, kept as free text. */
  details: string;
}

/**
 * Normalize language names to PF2e slugs.
 * @param names  languages as extracted, e.g. ['Common', 'Sylvan', 'Thieves\' Cant']
 * @param known  PF2e language slugs (Object.keys(CONFIG.PF2E.languages)); when
 *               given, unknown names go to `details` instead of `value`.
 */
export function toPf2eLanguages(names: readonly string[], known?: Iterable<string>): Pf2eLanguages {
  const knownSet = known ? new Set(known) : null;
  const value: string[] = [];
  const unknown: string[] = [];

  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const slug = name.toLowerCase().replace(/['’]/g, '').replace(/\s+/g, '-');
    const mapped = LEGACY_LANGUAGE_TO_REMASTER[slug] ?? slug;
    if (!knownSet || knownSet.has(mapped)) {
      if (!value.includes(mapped)) value.push(mapped);
    } else if (!unknown.includes(name)) {
      unknown.push(name);
    }
  }

  return { value, details: unknown.join(', ') };
}

// ---------------------------------------------------------------------------
// Spellcasting (PF2e 8.x: a spellcastingEntry item plus spell items whose
// system.location.value is the entry's _id)
// ---------------------------------------------------------------------------

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/**
 * Printed spell note -> the parenthetical PF2e puts in the spell's name:
 * "at will; self only" -> "At Will; Self Only", "constant" -> "Constant".
 */
export function toPf2eSpellLabel(note: string | undefined): string {
  if (!note) return '';
  return note
    .split(/;\s*/)
    .filter(Boolean)
    .map((part) =>
      part
        .split(' ')
        .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' '),
    )
    .join('; ');
}

export interface Pf2eSpellPlacement {
  /** system.location for the spell item. */
  location: { value: string; heightenedLevel?: number; uses?: { max: number; value: number } };
  /** Prepared entries: how many times the spell fills a slot of `rank`. */
  preparedCount: number;
}

/**
 * Where a spell goes in its entry. Cantrips (rank key 0) and focus spells
 * auto-heighten; prepared spells take their rank from the slot; innate and
 * spontaneous spells carry heightenedLevel; innate "(×N)" becomes uses.
 */
export function toPf2eSpellPlacement(
  entryId: string,
  type: 'prepared' | 'spontaneous' | 'innate' | 'focus',
  rank: number,
  uses: number | undefined,
): Pf2eSpellPlacement {
  const location: Pf2eSpellPlacement['location'] = { value: entryId };
  if (rank > 0 && (type === 'innate' || type === 'spontaneous')) location.heightenedLevel = rank;
  if (type === 'innate' && uses && uses > 1) location.uses = { max: uses, value: uses };
  return { location, preparedCount: type === 'prepared' ? (uses ?? 1) : 0 };
}

// ---------------------------------------------------------------------------
// Runes and precious materials (PF2e 8.x: system.runes / system.material)
// ---------------------------------------------------------------------------

/**
 * PF2e property-rune key from the rune item's name:
 * "Flaming" -> "flaming", "Flaming (Greater)" -> "greaterFlaming",
 * "Ghost Touch" -> "ghostTouch", "Energy-Resistant" -> "energyResistant".
 */
export function toPf2ePropertyRuneSlug(runeName: string): string {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(runeName.trim());
  const words = [...(m ? [m[2]!] : []), m ? m[1]! : runeName]
    .join(' ')
    .replace(/['’]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}

/** Append the adventure's text below an item's compendium description. */
export function appendAdventureNotes(existing: unknown, notesHtml: string): string {
  const base = typeof existing === 'string' ? existing : '';
  return `${base}${base ? '<hr>' : ''}<h3>In this adventure</h3>${notesHtml}`;
}
