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
