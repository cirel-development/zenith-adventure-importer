import { log } from '../log.js';

declare global {
  // Foundry exposes fromUuid both at the global level and on foundry.utils
  function fromUuid(uuid: string): Promise<unknown>;
}

/**
 * Outcome of a compendium lookup. Tells the caller HOW the entry was found
 * so they can surface warnings to the GM (e.g. "matched by name, may be
 * a different version of the entity").
 */
export interface CompendiumResolution {
  source: Record<string, unknown>;
  matchedBy: 'uuid' | 'name';
  /** The UUID that actually returned the document (may differ from input on name fallback) */
  resolvedUuid: string;
  /** Set to true when name fallback was used — caller should warn the GM */
  driftWarning: boolean;
}

interface ParsedUuid {
  packageName: string;
  packName: string;
  fullPackId: string; // "<package>.<pack>" — what game.packs.get takes
  docType: string;
  docId: string;
}

/**
 * Looks up Foundry compendium documents by UUID, with a name-based fallback
 * for handling UUID drift across PF2e (or other system) versions.
 *
 * The contract stores BOTH a UUID and a name on every compendium-ref entry.
 * When we generate a bundle, the UUID is current. When the bundle is imported
 * months later, the user's installed PF2e version may have re-rolled some IDs
 * (the Remaster did this for many creatures). Without a fallback, those refs
 * become placeholders.
 *
 * The fallback strategy:
 *   1. Try the literal UUID — fast path, hits 95%+ of the time
 *   2. If miss: parse the pack name out of the UUID, search that pack's
 *      index by name, resolve via the new UUID
 *   3. If that misses too: return null, caller decides what to do
 *
 * Both lookups are cached so repeated entries (Captain Marrow x10) cost
 * one resolve total.
 */
export class CompendiumLookup {
  private readonly cache = new Map<string, CompendiumResolution | null>();

  /**
   * Resolve a compendium reference to source data, with name fallback.
   *
   * @param uuid The UUID from the bundle
   * @param fallbackName The display name to fall back on if UUID misses
   */
  async resolveSource(
    uuid: string,
    fallbackName?: string,
  ): Promise<CompendiumResolution | null> {
    const cacheKey = this.makeCacheKey(uuid, fallbackName);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) ?? null;
    }

    // Pass 1: try the UUID directly
    const direct = await this.tryUuid(uuid);
    if (direct) {
      const result: CompendiumResolution = {
        source: direct,
        matchedBy: 'uuid',
        resolvedUuid: uuid,
        driftWarning: false,
      };
      this.cache.set(cacheKey, result);
      return result;
    }

    // Pass 2: try by name in the same pack
    if (fallbackName) {
      const named = await this.tryByName(uuid, fallbackName);
      if (named) {
        log.warn(
          `compendium drift: "${fallbackName}" matched by name (UUID ${uuid} not found, used ${named.resolvedUuid})`,
        );
        this.cache.set(cacheKey, named);
        return named;
      }
    }

    // Pass 3: nothing worked
    log.warn(
      `compendium miss: ${uuid}` +
        (fallbackName ? ` (no entry named "${fallbackName}" in pack either)` : ''),
    );
    this.cache.set(cacheKey, null);
    return null;
  }

  // ============================================================================
  // Internals
  // ============================================================================

  /** Try to resolve a UUID directly. Returns parsed source or null. */
  private async tryUuid(uuid: string): Promise<Record<string, unknown> | null> {
    let doc: unknown;
    try {
      doc = await fromUuid(uuid);
    } catch (err) {
      log.debug(`fromUuid threw for ${uuid}:`, err);
      return null;
    }
    if (!doc) return null;
    return this.toSource(doc, uuid);
  }

  /**
   * Search the pack referenced by `uuid` for an entry with `name`.
   * Uses the pack's in-memory index — no need to load full documents.
   */
  private async tryByName(
    originalUuid: string,
    name: string,
  ): Promise<CompendiumResolution | null> {
    const parsed = this.parseUuid(originalUuid);
    if (!parsed) {
      log.debug(`couldn't parse UUID for name fallback: ${originalUuid}`);
      return null;
    }

    const pack = (game as any).packs?.get(parsed.fullPackId);
    if (!pack) {
      log.debug(`pack "${parsed.fullPackId}" not installed`);
      return null;
    }

    // Search the index. Index entries have .name and ._id. Case-insensitive
    // exact match — fuzzy matching is the worker's job, not ours.
    const target = name.toLowerCase();
    const indexEntry = (pack.index as Map<string, any> | any[])
      ? this.findInIndex(pack.index, target)
      : null;
    if (!indexEntry) return null;

    // Build a UUID for the matched entry and resolve it
    const newUuid = `Compendium.${parsed.fullPackId}.${parsed.docType}.${indexEntry._id}`;
    const source = await this.tryUuid(newUuid);
    if (!source) return null;

    return {
      source,
      matchedBy: 'name',
      resolvedUuid: newUuid,
      driftWarning: true,
    };
  }

  /**
   * Search a pack index for an entry with the given (lowercase) name.
   * The index can be either a Map (newer Foundry) or an Array (older), so
   * we handle both shapes.
   */
  private findInIndex(index: Map<string, any> | any[] | unknown, target: string): any | null {
    if (index instanceof Map) {
      for (const entry of index.values()) {
        if (typeof entry?.name === 'string' && entry.name.toLowerCase() === target) {
          return entry;
        }
      }
      return null;
    }
    if (Array.isArray(index)) {
      return (
        index.find(
          (e) => typeof e?.name === 'string' && e.name.toLowerCase() === target,
        ) ?? null
      );
    }
    // Some Foundry builds expose iteration on the index via .contents
    const iterable = (index as any)?.contents ?? index;
    if (Array.isArray(iterable)) {
      return (
        iterable.find(
          (e: any) => typeof e?.name === 'string' && e.name.toLowerCase() === target,
        ) ?? null
      );
    }
    return null;
  }

  /**
   * Convert a Foundry document into plain source data we can pass to .create().
   * Strips _id, folder, and sort so the new copy gets fresh values.
   */
  private toSource(doc: unknown, uuidForLog: string): Record<string, unknown> | null {
    if (typeof (doc as any).toObject !== 'function') {
      log.warn(`compendium doc ${uuidForLog} has no toObject method`);
      return null;
    }
    const source = (doc as any).toObject() as Record<string, unknown>;
    delete source['_id'];
    delete source['folder'];
    delete source['sort'];
    return source;
  }

  /** Parse a Compendium UUID into its components. */
  private parseUuid(uuid: string): ParsedUuid | null {
    // Compendium.<package>.<pack>.<docType>.<docId>
    const match = /^Compendium\.([\w-]+)\.([\w-]+)\.(\w+)\.([\w-]+)$/.exec(uuid);
    if (!match) return null;
    const [, packageName, packName, docType, docId] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    return {
      packageName,
      packName,
      fullPackId: `${packageName}.${packName}`,
      docType,
      docId,
    };
  }

  private makeCacheKey(uuid: string, fallbackName?: string): string {
    return fallbackName ? `${uuid}|${fallbackName}` : uuid;
  }
}
