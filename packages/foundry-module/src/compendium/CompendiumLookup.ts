import { log } from '../log.js';

declare global {
  // Foundry exposes fromUuid both at the global level and on foundry.utils
  function fromUuid(uuid: string): Promise<unknown>;
}

/**
 * Looks up Foundry compendium documents by UUID and caches them.
 *
 * UUID format: "Compendium.<package>.<pack>.<docType>.<id>"
 * Example: "Compendium.pf2e.pathfinder-monster-core.Actor.shadow-cultist"
 *
 * If a UUID resolves, we get a "source document" — Foundry's term for the
 * compendium template. We pass this to Actor.create / Item.create to make
 * a live copy in the world.
 *
 * If a UUID DOESN'T resolve (compendium pack not installed, or ID changed
 * between PF2e versions), we return null and the caller falls back to
 * custom creation if it has the data, or skips with a warning if it doesn't.
 */
export class CompendiumLookup {
  private readonly cache = new Map<string, unknown | null>();

  async resolve(uuid: string): Promise<unknown | null> {
    if (this.cache.has(uuid)) {
      return this.cache.get(uuid) ?? null;
    }

    try {
      const doc = await fromUuid(uuid);
      const value = doc ?? null;
      this.cache.set(uuid, value);
      if (!value) {
        log.warn(`compendium lookup miss: ${uuid}`);
      }
      return value;
    } catch (err) {
      log.warn(`compendium lookup error: ${uuid}`, err);
      this.cache.set(uuid, null);
      return null;
    }
  }

  /**
   * Resolves to source data ready to pass into a `.create()` call. Foundry
   * documents have a `.toObject()` method that strips IDs and returns plain
   * data we can use as a template.
   */
  async resolveSource(uuid: string): Promise<Record<string, unknown> | null> {
    const doc = await this.resolve(uuid);
    if (!doc) return null;
    if (typeof (doc as any).toObject !== 'function') {
      log.warn(`compendium doc ${uuid} has no toObject method`);
      return null;
    }
    return (doc as any).toObject();
  }
}
