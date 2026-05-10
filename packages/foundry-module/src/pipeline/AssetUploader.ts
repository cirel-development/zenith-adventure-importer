import type { LoadedBundle } from './BundleLoader.js';
import type { EntityRegistry } from './EntityRegistry.js';
import { ASSET_BASE_PATH, ASSET_SOURCE } from '../constants.js';
import { log } from '../log.js';

/**
 * Maps bundle-relative asset paths ("images/maps/a1-docks.webp") to the
 * Foundry-absolute path the builders need ("uploads/zenith-imports/<slug>/maps/a1-docks.webp").
 *
 * Builders look up assets via this map; they never see raw bundle paths.
 */
export type AssetMap = Map<string, string>;

export interface ProgressCallback {
  (current: number, total: number, currentItem: string): void;
}

/**
 * Get FilePicker from the v13 namespace, falling back to the deprecated global
 * if running on an older build. The v13 namespace is `foundry.applications.apps.FilePicker.implementation`.
 */
function getFilePicker(): typeof FilePicker {
  const namespaced = (foundry as any)?.applications?.apps?.FilePicker?.implementation;
  if (namespaced) return namespaced;
  return FilePicker;
}

export class AssetUploader {
  /**
   * Upload every asset in the bundle. Path prefix is per-adventure so cleanup
   * is `rm -rf uploads/zenith-imports/<slug>/` and there's no collision risk.
   */
  async uploadAll(
    loaded: LoadedBundle,
    registry: EntityRegistry,
    onProgress?: ProgressCallback,
  ): Promise<AssetMap> {
    const map: AssetMap = new Map();
    const adventureSlug = loaded.bundle.manifest.adventure.slug;
    const baseTarget = `${ASSET_BASE_PATH}/${adventureSlug}`;

    // Walk the full base path creating each segment. FilePicker.createDirectory
    // does NOT create parent directories — if `uploads/` doesn't exist, you can't
    // create `uploads/zenith-imports/`. So we create each segment in order.
    await this.ensurePath(baseTarget);

    const assetEntries = Array.from(loaded.assets.entries());
    log.info(`uploading ${assetEntries.length} assets to ${baseTarget}/`);

    const FP = getFilePicker();

    let i = 0;
    for (const [bundlePath, data] of assetEntries) {
      i++;
      onProgress?.(i, assetEntries.length, bundlePath);

      // bundlePath looks like "images/maps/a1-docks.webp"
      // Strip the leading "images/" — that's just the bundle's organization.
      // Everything else (maps/a1-docks.webp) becomes the path inside our adventure folder.
      const relative = bundlePath.replace(/^images\//, '');
      const lastSlash = relative.lastIndexOf('/');
      const subdir = lastSlash >= 0 ? relative.slice(0, lastSlash) : '';
      const filename = lastSlash >= 0 ? relative.slice(lastSlash + 1) : relative;

      const targetDir = subdir ? `${baseTarget}/${subdir}` : baseTarget;
      if (subdir) {
        await this.ensurePath(targetDir);
      }

      const file = this.toFile(data, filename);
      const result = await FP.upload(ASSET_SOURCE, targetDir, file, {
        notify: false,
      });

      if (!result) {
        throw new Error(`Asset upload failed: ${bundlePath}`);
      }

      // result.path is the Foundry-absolute path we'll reference everywhere
      map.set(bundlePath, result.path);
      registry.recordAsset(result.path);
    }

    log.info(`uploaded ${assetEntries.length} assets`);
    return map;
  }

  // ============================================================================
  // Internals
  // ============================================================================

  /**
   * Ensure every segment of a path exists, creating each one in turn.
   *
   * Foundry's FilePicker.createDirectory only creates a leaf directory and
   * fails with ENOENT if the parent doesn't exist. So we walk down from the
   * top, creating each missing segment. Existing segments throw "already
   * exists" errors which we swallow.
   */
  private async ensurePath(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    let cumulative = '';
    for (const segment of segments) {
      cumulative = cumulative ? `${cumulative}/${segment}` : segment;
      await this.createDirectoryIfMissing(cumulative);
    }
  }

  /**
   * Create a single directory level. Treats EEXIST as success. ENOENT and other
   * errors are real and re-thrown so we don't proceed to upload into a missing
   * directory (the cause of the original "Asset upload failed" bug).
   */
  private async createDirectoryIfMissing(path: string): Promise<void> {
    const FP = getFilePicker();
    try {
      await FP.createDirectory(ASSET_SOURCE, path);
      log.debug('created directory', path);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if (/EEXIST|already exists/i.test(msg)) {
        // Already present — fine
        log.debug('directory already exists', path);
        return;
      }
      // ENOENT means a parent is missing; that's a bug in our own walk logic,
      // not something to swallow. Anything else is also a real failure.
      throw new Error(`Could not create directory ${path}: ${msg}`);
    }
  }

  /**
   * Build a File from raw bytes. We pick the MIME type from the extension so
   * Foundry stores it correctly for serving back to the browser.
   */
  private toFile(data: Uint8Array, filename: string): File {
    const ext = filename.toLowerCase().split('.').pop();
    const mime =
      ext === 'webp' ? 'image/webp'
      : ext === 'png' ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : 'application/octet-stream';
    // Convert Uint8Array to a properly typed BlobPart
    const blob = new Blob([data.slice().buffer], { type: mime });
    return new File([blob], filename, { type: mime });
  }
}
