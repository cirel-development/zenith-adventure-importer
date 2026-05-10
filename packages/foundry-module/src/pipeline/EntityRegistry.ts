import type { CreatedEntity } from '../settings.js';
import { log } from '../log.js';

/**
 * Tracks every Foundry entity created during an import.
 *
 * Foundry entity creation is NOT transactional — if creation #31 fails, the
 * first 30 still exist. The registry is what lets us:
 *   1. Resolve [[REF:type:slug]] tokens to real Foundry IDs after creation
 *   2. Roll back partial state when a phase fails
 *   3. Persist the undo manifest at the end
 *
 * Append-only during the build. `record()` is called immediately after each
 * successful create, before any other work — never batched.
 */
export class EntityRegistry {
  private readonly entries: CreatedEntity[] = [];

  // Indexed lookups for fast ref resolution
  private readonly byTypeAndSlug = new Map<string, CreatedEntity>();

  // Asset paths uploaded during this import. Tracked so undo can clean them up.
  private readonly uploadedAssets = new Set<string>();

  record(entity: CreatedEntity): void {
    const key = this.keyFor(entity.type, entity.slug);
    if (this.byTypeAndSlug.has(key)) {
      // This shouldn't happen with the contract's slug uniqueness check, but
      // catch it defensively rather than silently overwriting.
      throw new Error(
        `EntityRegistry: duplicate ${entity.type} with slug "${entity.slug}"`,
      );
    }
    this.entries.push(entity);
    this.byTypeAndSlug.set(key, entity);
    log.debug('registered', entity.type, entity.slug, '→', entity.foundryId);
  }

  recordAsset(path: string): void {
    this.uploadedAssets.add(path);
  }

  /** Resolve a slug to a Foundry ID, or undefined if not yet created. */
  lookup(type: CreatedEntity['type'], slug: string): CreatedEntity | undefined {
    return this.byTypeAndSlug.get(this.keyFor(type, slug));
  }

  /** All entities, in creation order. */
  all(): readonly CreatedEntity[] {
    return this.entries;
  }

  /**
   * Entities in REVERSE creation order. This is the order undo deletes them in
   * so that referencing entities are removed before their references.
   *
   * Folders are created first → deleted last (which is what we want; deleting
   * a folder doesn't delete its contents in Foundry, but deleting them in
   * reverse leaves an empty folder by the time we get to it).
   */
  reverseOrder(): readonly CreatedEntity[] {
    return [...this.entries].reverse();
  }

  /** All asset paths uploaded during this import. */
  assets(): readonly string[] {
    return Array.from(this.uploadedAssets);
  }

  /** True if any entities have been recorded — used to decide whether undo has anything to do. */
  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  size(): number {
    return this.entries.length;
  }

  private keyFor(type: CreatedEntity['type'], slug: string): string {
    return `${type}:${slug}`;
  }
}
