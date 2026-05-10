import type { CompendiumLookup } from './CompendiumLookup.js';
import { log } from '../log.js';

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
  ): Promise<Record<string, unknown> | null> {
    const base = await this.compendium.resolveSource(baseUuid);
    if (!base) {
      log.warn(`base item not found: ${baseUuid}`);
      return null;
    }

    delete (base as any)._id;
    delete (base as any).folder;
    delete (base as any).sort;

    const system = ((base['system'] as Record<string, unknown>) ??= {});
    const runesField = ((system['runes'] as Record<string, unknown>) ??= {});
    const propertyRunes: string[] = [];

    for (const rune of runes) {
      // The rune slug is what PF2e expects in these fields, not the full UUID.
      // We extract the slug from the UUID's last segment.
      const runeSlug = rune.uuid.split('.').pop();
      if (!runeSlug) {
        log.warn(`could not extract slug from rune UUID: ${rune.uuid}`);
        continue;
      }

      switch (rune.type) {
        case 'weapon-potency':
          runesField['potency'] = rune.rank ?? 1;
          break;
        case 'striking':
          runesField['striking'] = rune.rank ?? 1;
          break;
        case 'armor-potency':
          runesField['potency'] = rune.rank ?? 1;
          break;
        case 'resilient':
          runesField['resilient'] = rune.rank ?? 1;
          break;
        case 'property':
          propertyRunes.push(runeSlug);
          break;
      }
    }

    if (propertyRunes.length > 0) {
      runesField['property'] = propertyRunes;
    }

    return base;
  }
}
