import { UndoManager } from '../undo/UndoManager.js';
import {
  getAllImportRecords,
  deleteImportRecord,
  type ImportRecord,
} from '../settings.js';
import type { PhaseProgress, ProgressListener } from '../pipeline/Importer.js';
import { log } from '../log.js';

/**
 * Result of a successful undo, mirrors ImportSummary in shape so it can flow
 * through the same ProgressDialog.
 */
export interface UndoSummary {
  bundleId: string;
  adventureTitle: string;
  entitiesDeleted: number;
}

/**
 * Drives the GM-facing undo flow.
 *
 * Composition: reads an ImportRecord from settings, hands it to UndoManager
 * for the actual entity deletion, then removes the record from history so
 * the bundle becomes re-importable. Emits progress events that can be wired
 * into ProgressDialog using the same listener contract as Importer.
 *
 * Pattern intentionally mirrors Importer: instantiate, register a progress
 * listener, call the run method, get a summary. Makes UI orchestration
 * identical for both flows.
 */
export class UndoHandler {
  private listener?: ProgressListener;

  onProgress(listener: ProgressListener): void {
    this.listener = listener;
  }

  /** Most recently imported bundle, or null if there's no history. */
  static latestImport(): ImportRecord | null {
    const records = getAllImportRecords();
    return records[0] ?? null;
  }

  /** Whether any import history exists. */
  static hasHistory(): boolean {
    return getAllImportRecords().length > 0;
  }

  /**
   * Delete every entity from this import, then remove its registry entry so
   * the bundle can be re-imported without tripping the preflight check.
   */
  async undo(record: ImportRecord): Promise<UndoSummary> {
    const manager = new UndoManager();
    const totalEntities = record.createdEntities.length;

    this.emit({
      phase: 'rolling-back',
      message: `Undoing "${record.adventureTitle}"`,
    });

    await manager.undoFromRecord(record, (current, total, currentItem) => {
      this.emit({
        phase: 'rolling-back',
        message: `Deleting ${currentItem}`,
        current,
        total,
      });
    });

    // Clear the registry entry so the user can re-import this bundle.
    await deleteImportRecord(record.bundleId);

    this.emit({ phase: 'complete', message: 'Undo complete' });
    log.info(
      `undid import "${record.adventureTitle}" (${totalEntities} entities deleted)`,
    );

    return {
      bundleId: record.bundleId,
      adventureTitle: record.adventureTitle,
      entitiesDeleted: totalEntities,
    };
  }

  private emit(progress: PhaseProgress): void {
    this.listener?.(progress);
  }
}
