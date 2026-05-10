import type { LoadedBundle } from './BundleLoader.js';
import { BundleLoader } from './BundleLoader.js';
import { PreflightChecker } from './PreflightChecker.js';
import { AssetUploader } from './AssetUploader.js';
import { RefResolver } from './RefResolver.js';
import { EntityRegistry } from './EntityRegistry.js';
import { FolderBuilder } from '../builders/FolderBuilder.js';
import { JournalBuilder } from '../builders/JournalBuilder.js';
import { ItemBuilder } from '../builders/ItemBuilder.js';
import { ActorBuilder } from '../builders/ActorBuilder.js';
import { SceneBuilder } from '../builders/SceneBuilder.js';
import { PlaylistBuilder } from '../builders/PlaylistBuilder.js';
import { CompendiumLookup } from '../compendium/CompendiumLookup.js';
import { UndoManager } from '../undo/UndoManager.js';
import {
  saveImportRecord,
  getAllImportRecords,
  type ImportRecord,
} from '../settings.js';
import { log } from '../log.js';

// ============================================================================
// Phase tracking
// ============================================================================

export type ImportPhase =
  | 'idle'
  | 'loading'
  | 'preflight'
  | 'uploading-assets'
  | 'building-folders'
  | 'building-items'
  | 'building-actors'
  | 'building-journals'
  | 'building-scenes'
  | 'building-playlists'
  | 'resolving-refs'
  | 'finalizing'
  | 'complete'
  | 'error'
  | 'rolling-back';

export interface PhaseProgress {
  phase: ImportPhase;
  message: string;
  current?: number;
  total?: number;
}

export type ProgressListener = (progress: PhaseProgress) => void;

export interface ImportSource {
  kind: 'bundle-id' | 'url' | 'file';
  value: string | File;
}

export interface ImportSummary {
  bundleId: string;
  adventureTitle: string;
  entitiesCreated: number;
  assetsUploaded: number;
  warnings: string[];
}

export class ImportError extends Error {
  constructor(
    message: string,
    public readonly phase: ImportPhase,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

// ============================================================================
// Importer
// ============================================================================

export class Importer {
  private listener: ProgressListener | null = null;

  onProgress(listener: ProgressListener): void {
    this.listener = listener;
  }

  async run(source: ImportSource): Promise<ImportSummary> {
    const registry = new EntityRegistry();
    const undoManager = new UndoManager();

    try {
      // ----- Phase 1: load + validate -----
      this.emit('loading', 'Downloading and validating bundle...');
      const loaded = await this.load(source);

      // ----- Phase 2: preflight -----
      this.emit('preflight', 'Running preflight checks...');
      const importedIds = new Set(getAllImportRecords().map((r) => r.bundleId));
      const preflight = new PreflightChecker().check(loaded, importedIds);
      if (!preflight.ok) {
        const errs = preflight.issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .join('\n');
        throw new ImportError(`Preflight failed:\n${errs}`, 'preflight');
      }

      // ----- Phase 3: assets -----
      this.emit('uploading-assets', 'Uploading images...', 0, loaded.assets.size);
      const assetMap = await new AssetUploader().uploadAll(
        loaded,
        registry,
        (current, total, item) => {
          this.emit('uploading-assets', `Uploading ${item}`, current, total);
        },
      );

      // ----- Phase 4: build folders -----
      this.emit(
        'building-folders',
        `Creating ${loaded.bundle.folders.entities.length} folders...`,
      );
      const folderBuilder = new FolderBuilder();
      await folderBuilder.build(loaded.bundle, registry);

      // The compendium lookup is shared across actor and item builders so
      // they hit the same cache.
      const compendium = new CompendiumLookup();

      // ----- Phase 5: build journals -----
      // Journals first because they reference everything else only by [[REF:]]
      // tokens which the resolver handles later. Building them early lets us
      // surface errors in journal data before anything heavier.
      this.emit(
        'building-journals',
        `Creating ${loaded.bundle.journals.entities.length} journals...`,
      );
      const journalBuilder = new JournalBuilder(folderBuilder);
      await journalBuilder.build(loaded.bundle, registry, assetMap);

      // ----- Phase 6: build items -----
      // Items before actors so actor inventories can resolve item refs.
      this.emit(
        'building-items',
        `Creating ${loaded.bundle.items.entities.length} items...`,
      );
      const itemBuilder = new ItemBuilder(folderBuilder, compendium);
      await itemBuilder.build(loaded.bundle, registry, assetMap);

      // ----- Phase 7: build actors -----
      this.emit(
        'building-actors',
        `Creating ${loaded.bundle.actors.entities.length} actors...`,
      );
      const actorBuilder = new ActorBuilder(folderBuilder, compendium);
      await actorBuilder.build(loaded.bundle, registry, assetMap);

      // ----- Phase 8: build scenes -----
      this.emit(
        'building-scenes',
        `Creating ${loaded.bundle.scenes.entities.length} scenes...`,
      );
      const sceneBuilder = new SceneBuilder(folderBuilder);
      await sceneBuilder.build(loaded.bundle, registry, assetMap);

      // ----- Phase 9: build playlists -----
      this.emit(
        'building-playlists',
        `Creating ${loaded.bundle.playlists.entities.length} playlists...`,
      );
      const playlistBuilder = new PlaylistBuilder(folderBuilder);
      await playlistBuilder.build(loaded.bundle, registry);

      // ----- Phase 10: resolve refs -----
      this.emit('resolving-refs', 'Wiring up cross-references...');
      await new RefResolver().resolve(loaded.bundle, registry);

      // ----- Phase 8: finalize -----
      this.emit('finalizing', 'Saving import record...');
      const record = this.buildRecord(loaded, registry);
      await saveImportRecord(record);

      this.emit('complete', 'Import complete.');
      log.info('import complete', record.bundleId);

      return {
        bundleId: record.bundleId,
        adventureTitle: record.adventureTitle,
        entitiesCreated: registry.size(),
        assetsUploaded: registry.assets().length,
        warnings: loaded.bundle.manifest.warnings.map((w) => w.message),
      };
    } catch (err) {
      log.error('import failed:', err);

      // Roll back any partial state
      if (!registry.isEmpty()) {
        this.emit(
          'rolling-back',
          `Import failed. Rolling back ${registry.size()} entities...`,
          0,
          registry.size(),
        );
        try {
          await undoManager.rollback(registry, (current, total, item) => {
            this.emit('rolling-back', `Removing ${item}`, current, total);
          });
        } catch (rollbackErr) {
          log.error('rollback also failed:', rollbackErr);
        }
      }

      this.emit('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // ============================================================================

  private async load(source: ImportSource): Promise<LoadedBundle> {
    const loader = new BundleLoader();
    if (source.kind === 'bundle-id') {
      return loader.loadFromBundleId(source.value as string);
    }
    if (source.kind === 'url') {
      return loader.loadFromUrl(source.value as string);
    }
    return loader.loadFromFile(source.value as File);
  }

  private buildRecord(loaded: LoadedBundle, registry: EntityRegistry): ImportRecord {
    return {
      bundleId: loaded.bundle.manifest.bundle_id,
      adventureSlug: loaded.bundle.manifest.adventure.slug,
      adventureTitle: loaded.bundle.manifest.adventure.title,
      importedAt: new Date().toISOString(),
      createdEntities: [...registry.all()],
      assetPaths: [...registry.assets()],
    };
  }

  private emit(
    phase: ImportPhase,
    message: string,
    current?: number,
    total?: number,
  ): void {
    log.debug(`[${phase}]`, message);
    this.listener?.({ phase, message, current, total });
  }
}
