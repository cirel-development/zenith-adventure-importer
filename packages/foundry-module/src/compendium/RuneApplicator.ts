import type { CompendiumLookup } from './CompendiumLookup.js';
import { log } from '../log.js';
import { toPf2ePropertyRuneSlug } from '../builders/pf2eMappings.js';

/** Property-rune keys PF2e knows at runtime, when it exposes them; undefined otherwise. */
function knownPropertyRunes(): Set<string> | undefined {
  const P = (CONFIG as any)?.PF2E ?? {};
  const maps = [P.weaponPropertyRunes, P.armorPropertyRunes, P.runes?.weapon?.property, P.runes?.armor?.property].filter(Boolean);
  return maps.length ? new Set(maps.flatMap((m: object) => Object.keys(m))) : undefined;
}

interface PF2eRune {
  type:
    | 'weapon-potency'
    | 'striking'
    | 'armor-potency'
    | 'resilient'
    | 'property';
  uuid: string;
  rank?: number;
}

/**
 * Applies runes to a base weapon or armor source document.
 *
 * PF2e represents runes as separate fields on the item's system data:
 *   - weapons: system.runes.{potency, striking, property: [...]}
 *   - armor:   system.runes.{potency, resilient, property: [...]}
 *
 * Property runes go into an array (up to 4 slots typically). Potency and
 * striking/resilient runes are single-valued.
 *
 * The compendium-ref-with-runes contract variant gives us: a base item UUID,
 * plus a list of runes with their own UUIDs. We resolve the base, apply the
 * rune metadata, and let PF2e's automation handle the rest at runtime.
 */
export class RuneApplicator {
  constructor(private readonly compendium: CompendiumLookup) {}

  async apply(
    baseUuid: string,
    runes: PF2eRune[],
    fallbackName?: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.compendium.resolveSource(baseUuid, fallbackName);
    if (!result) {
      log.warn(`base item not found: ${baseUuid}`);
      return null;
    }

    const base = result.source;

    if (result.driftWarning) {
      base['flags'] = {
        ...((base['flags'] as Record<string, unknown>) ?? {}),
        'zenith-adventure-importer': {
          ...((base['flags'] as any)?.['zenith-adventure-importer'] ?? {}),
          driftWarning: true,
          originalUuid: baseUuid,
          resolvedUuid: result.resolvedUuid,
        },
      };
    }

    const system = ((base['system'] as Record<string, unknown>) ??= {});
    const runesField = ((system['runes'] as Record<string, unknown>) ??= {});
    const propertyRunes: string[] = [];
    const skipped: string[] = [];

    const known = knownPropertyRunes();
    for (const rune of runes) {
      switch (rune.type) {
        case 'weapon-potency':
        case 'armor-potency':
          runesField['potency'] = rune.rank ?? 1;
          break;
        case 'striking':
          runesField['striking'] = rune.rank ?? 1;
          break;
        case 'resilient':
          runesField['resilient'] = rune.rank ?? 1;
          break;
        case 'property': {
          // PF2e stores property runes by key ("greaterFlaming"), which comes
          // from the rune item's name, not its document id.
          const runeDoc = await this.compendium.resolveSource(rune.uuid);
          const runeName = typeof runeDoc?.source['name'] === 'string' ? (runeDoc.source['name'] as string) : null;
          const slug = runeName ? toPf2ePropertyRuneSlug(runeName) : null;
          if (!slug || (known && !known.has(slug))) {
            log.warn(`property rune ${rune.uuid} (${runeName ?? 'not found'}) has no PF2e key; skipped`);
            skipped.push(runeName ?? rune.uuid);
            break;
          }
          propertyRunes.push(slug);
          break;
        }
      }
    }

    if (propertyRunes.length > 0) {
      runesField['property'] = propertyRunes;
    }
    if (skipped.length) {
      const flags = ((base['flags'] as Record<string, any>) ??= {});
      flags['zenith-adventure-importer'] = { ...(flags['zenith-adventure-importer'] ?? {}), skippedRunes: skipped };
    }

    return base;
  }
}
