import type { Bundle, FolderEntry } from '@ai-adventure/contract';
import type { EntityRegistry } from '../pipeline/EntityRegistry.js';
import { log } from '../log.js';

/**
 * Folder paths in the contract are slug-based ("lost-temple/actors/npcs"),
 * but Foundry folders use IDs for parent references. We do a topological
 * pass — create root folders first, then their children, etc.
 *
 * The contract validator already ensured every parent_path either is null
 * (root folder) or exists in the same file, so we know the topology is sound.
 *
 * Path resolution: for each folder, the full path is computed from its slug
 * and parent_path. A root folder "lost-temple" has full path "lost-temple".
 * Its child "actors" with parent_path "lost-temple" has full path "lost-temple/actors".
 */
export class FolderBuilder {
  /** Full slug path → Foundry folder id, used by other builders to set folder. */
  readonly pathToId = new Map<string, string>();

  async build(bundle: Bundle, registry: EntityRegistry): Promise<void> {
    const folders = bundle.folders.entities;
    log.info(`building ${folders.length} folders`);

    // Sort by depth so parents are always created before children.
    // Depth = number of slashes in the full path. parent_path is the parent's
    // full path; the entry's full path is parent_path + "/" + slug, or just slug if root.
    const sortedByDepth = [...folders].sort((a, b) => {
      const aDepth = a.parent_path ? a.parent_path.split('/').length : 0;
      const bDepth = b.parent_path ? b.parent_path.split('/').length : 0;
      return aDepth - bDepth;
    });

    for (const entry of sortedByDepth) {
      await this.createOne(entry, registry);
    }
  }

  // ============================================================================

  private async createOne(entry: FolderEntry, registry: EntityRegistry): Promise<void> {
    const fullPath = entry.parent_path ? `${entry.parent_path}/${entry.slug}` : entry.slug;
    const parentId = entry.parent_path ? this.pathToId.get(entry.parent_path) ?? null : null;

    if (entry.parent_path && !parentId) {
      // The contract validator should have prevented this, but defensively:
      throw new Error(
        `FolderBuilder: parent path "${entry.parent_path}" was not created before "${fullPath}". ` +
          `This indicates a topology issue in the bundle that should have been caught by validation.`,
      );
    }

    const foundryType = this.toFoundryType(entry.type);
    const created = await Folder.create({
      name: entry.name,
      type: foundryType,
      folder: parentId,
      sort: entry.sort,
      ...(entry.color ? { color: entry.color } : {}),
    });

    this.pathToId.set(fullPath, created.id);
    registry.record({
      slug: entry.slug,
      type: 'folder',
      foundryId: created.id,
      collection: 'Folder',
    });

    log.debug('folder created', fullPath, '→', created.id);
  }

  /**
   * The contract uses lowercase entity types ("actor", "journal", etc.) but
   * Foundry's Folder.type expects PascalCase document type names.
   */
  private toFoundryType(type: FolderEntry['type']): 'Actor' | 'Item' | 'JournalEntry' | 'Scene' | 'Playlist' {
    switch (type) {
      case 'actor':
        return 'Actor';
      case 'item':
        return 'Item';
      case 'journal':
        return 'JournalEntry';
      case 'scene':
        return 'Scene';
      case 'playlist':
        return 'Playlist';
    }
  }
}
