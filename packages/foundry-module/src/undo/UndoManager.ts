import type { EntityRegistry } from '../pipeline/EntityRegistry.js';
import type { ImportRecord } from '../settings.js';
import { ASSET_SOURCE } from '../constants.js';
import { log } from '../log.js';

export interface UndoProgressCallback {
  (current: number, total: number, currentItem: string): void;
}

/**
 * Removes everything from a single import.
 *
 * Two flows:
 *   - rollback(registry): used when an import fails partway through
 *   - undoFromRecord(record): used by the GM to undo a completed import later
 *
 * Both flows do the same thing: walk the entity list in reverse creation
 * order, delete each, then remove uploaded files. The difference is just
 * where the entity list comes from.
 */
export class UndoManager {
  /** Roll back a partial import using the in-memory registry. */
  async rollback(registry: EntityRegistry, onProgress?: UndoProgressCallback): Promise<void> {
    if (registry.isEmpty()) {
      log.info('rollback: nothing to undo');
      return;
    }

    const entities = registry.reverseOrder();
    const assets = registry.assets();
    log.warn(`rolling back ${entities.length} entities and ${assets.length} assets`);

    let i = 0;
    for (const entity of entities) {
      i++;
      onProgress?.(i, entities.length, entity.slug);
      await this.deleteEntity(entity);
    }

    for (const path of assets) {
      // We don't bulk-delete uploaded files here — Foundry's API for file
      // deletion is awkward and best-effort. Log them so the GM can clean
      // manually if desired. The whole adventure folder is a single rm -rf
      // when undoing a completed import (see undoFromRecord below).
      log.debug('asset orphaned by rollback (manual cleanup if needed):', path);
    }
  }

  /** Undo a previously-completed import using its persisted manifest. */
  async undoFromRecord(record: ImportRecord, onProgress?: UndoProgressCallback): Promise<void> {
    const entities = [...record.createdEntities].reverse();
    log.warn(`undoing import "${record.adventureTitle}":`, `${entities.length} entities`);

    let i = 0;
    for (const entity of entities) {
      i++;
      onProgress?.(i, entities.length, entity.slug);
      await this.deleteEntityById(entity.collection, entity.foundryId);
    }

    // Clean up uploaded asset folder. We only attempt the per-adventure
    // folder, not individual files, because Foundry's FilePicker doesn't
    // expose a delete API on consumer Foundry. Best-effort recursive cleanup
    // would require the user to manually delete via FilePicker UI.
    log.info(
      `import undone. Asset folder uploads/zenith-imports/${record.adventureSlug}/ ` +
        `is left in place — delete manually via Foundry's file picker if desired.`,
    );
  }

  // ============================================================================

  private async deleteEntity(entity: { collection: string; foundryId: string; slug: string }): Promise<void> {
    await this.deleteEntityById(entity.collection, entity.foundryId);
  }

  private async deleteEntityById(collection: string, foundryId: string): Promise<void> {
    try {
      const doc = this.findInCollection(collection, foundryId);
      if (!doc) {
        log.debug(`${collection} ${foundryId} already gone, skipping`);
        return;
      }
      await doc.delete();
    } catch (err) {
      // Don't let a single failure halt the rollback. Log and continue.
      log.error(`failed to delete ${collection} ${foundryId}:`, err);
    }
  }

  private findInCollection(collection: string, id: string): BaseDoc | undefined {
    switch (collection) {
      case 'Folder':
        return game.folders.get(id);
      case 'Scene':
        return game.scenes.get(id);
      case 'JournalEntry':
        return game.journal.get(id);
      case 'Actor':
        return game.actors.get(id);
      case 'Item':
        return game.items.get(id);
      case 'Playlist':
        return game.playlists.get(id);
      default:
        log.warn(`unknown collection: ${collection}`);
        return undefined;
    }
  }
}
