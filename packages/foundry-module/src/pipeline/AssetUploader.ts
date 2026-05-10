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

    // Make sure the base directory exists. FilePicker.upload creates the
    // immediate parent only, not nested ancestors, so we walk subdirectories
    // and create each one.
    await this.ensureDirectory(ASSET_BASE_PATH);
    await this.ensureDirectory(baseTarget);

    const assetEntries = Array.from(loaded.assets.entries());
    log.info(`uploading ${assetEntries.length} assets to ${baseTarget}/`);

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
        await this.ensureDirectory(targetDir);
      }

      const file = this.toFile(data, filename);
      const result = await FilePicker.upload(ASSET_SOURCE, targetDir, file, {
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

  /** Idempotent directory creation. Foundry returns an error if it exists; we swallow that. */
  private async ensureDirectory(path: string): Promise<void> {
    try {
      await FilePicker.createDirectory(ASSET_SOURCE, path);
    } catch (err) {
      // EEXIST-equivalent — directory already exists, which is fine.
      // Foundry surfaces this as a thrown string or Error depending on version.
      const msg = (err as Error)?.message ?? String(err);
      if (!/EEXIST|already exists/i.test(msg)) {
        // Some other error — re-throw
        log.warn('directory creation failed, continuing optimistically:', path, msg);
      }
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
