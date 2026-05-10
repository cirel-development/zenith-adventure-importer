import { unzipSync, strFromU8 } from 'fflate';
import { validateBundle, type Bundle } from '@ai-adventure/contract';
import { getServiceUrl, getAuthToken } from '../settings.js';
import { log } from '../log.js';

export interface LoadedBundle {
  bundle: Bundle;
  /**
   * Asset path (e.g. "images/maps/a1-docks.webp") → binary contents.
   * Foundry's FilePicker.upload() takes a File, so we wrap each Uint8Array
   * in a Blob/File at upload time rather than allocating Files up front.
   */
  assets: Map<string, Uint8Array>;
}

export class BundleLoadError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BundleLoadError';
  }
}

/**
 * Load a bundle from one of three sources:
 *   - bundle ID (fetched from the configured service URL with auth token)
 *   - direct download URL (signed R2 URL, no auth needed)
 *   - File object (user uploaded the zip directly)
 */
export class BundleLoader {
  async loadFromBundleId(bundleId: string): Promise<LoadedBundle> {
    const serviceUrl = getServiceUrl();
    if (!serviceUrl) {
      throw new BundleLoadError(
        'Service URL not configured. Set it in module settings or upload the bundle file directly.',
      );
    }
    const token = getAuthToken();
    if (!token) {
      throw new BundleLoadError(
        'Auth token not configured. Set it in module settings or upload the bundle file directly.',
      );
    }

    const url = `${serviceUrl}/api/bundles/${encodeURIComponent(bundleId)}/download`;
    log.info('fetching bundle by ID', bundleId);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (cause) {
      throw new BundleLoadError(`Network error fetching bundle: ${(cause as Error).message}`, cause);
    }

    if (response.status === 401 || response.status === 403) {
      throw new BundleLoadError(
        'Authentication failed. Check your auth token in module settings.',
      );
    }
    if (response.status === 404) {
      throw new BundleLoadError(`Bundle "${bundleId}" not found.`);
    }
    if (!response.ok) {
      throw new BundleLoadError(
        `Service returned ${response.status} ${response.statusText}`,
      );
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    return this.unpackZip(buffer);
  }

  async loadFromUrl(url: string): Promise<LoadedBundle> {
    log.info('fetching bundle from URL');
    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      throw new BundleLoadError(`Network error fetching bundle: ${(cause as Error).message}`, cause);
    }
    if (!response.ok) {
      throw new BundleLoadError(`Download failed: ${response.status} ${response.statusText}`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    return this.unpackZip(buffer);
  }

  async loadFromFile(file: File): Promise<LoadedBundle> {
    log.info('reading bundle from file', file.name, `(${file.size} bytes)`);
    const buffer = new Uint8Array(await file.arrayBuffer());
    return this.unpackZip(buffer);
  }

  // ============================================================================
  // Internals
  // ============================================================================

  private unpackZip(buffer: Uint8Array): LoadedBundle {
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(buffer);
    } catch (cause) {
      throw new BundleLoadError(`Could not unzip bundle: ${(cause as Error).message}`, cause);
    }

    // Required JSON files
    const manifestRaw = this.requireFile(unzipped, 'manifest.json');
    const foldersRaw = this.requireFile(unzipped, 'entities/folders.json');
    const journalsRaw = this.requireFile(unzipped, 'entities/journals.json');
    const actorsRaw = this.requireFile(unzipped, 'entities/actors.json');
    const itemsRaw = this.requireFile(unzipped, 'entities/items.json');
    const scenesRaw = this.requireFile(unzipped, 'entities/scenes.json');
    const playlistsRaw = this.requireFile(unzipped, 'entities/playlists.json');

    // Parse JSON
    const manifest = this.parseJson(manifestRaw, 'manifest.json');
    const folders = this.parseJson(foldersRaw, 'entities/folders.json');
    const journals = this.parseJson(journalsRaw, 'entities/journals.json');
    const actors = this.parseJson(actorsRaw, 'entities/actors.json');
    const items = this.parseJson(itemsRaw, 'entities/items.json');
    const scenes = this.parseJson(scenesRaw, 'entities/scenes.json');
    const playlists = this.parseJson(playlistsRaw, 'entities/playlists.json');

    // Run the contract's full validator. This is the same code path the worker
    // uses on the write side, so we get identical errors on both sides.
    const result = validateBundle({
      manifest,
      folders,
      journals,
      actors,
      items,
      scenes,
      playlists,
    });

    if (!result.valid || !result.bundle) {
      const summary = result.issues
        .slice(0, 5)
        .map((i) => `  • ${i.path}: ${i.message}`)
        .join('\n');
      const more =
        result.issues.length > 5
          ? `\n  ... and ${result.issues.length - 5} more (see console)`
          : '';
      log.error('bundle validation failed', result.issues);
      throw new BundleLoadError(`Bundle failed validation:\n${summary}${more}`);
    }

    // Collect asset blobs
    const assets = new Map<string, Uint8Array>();
    for (const [path, data] of Object.entries(unzipped)) {
      if (path.startsWith('images/')) {
        assets.set(path, data);
      }
    }

    log.info(
      `loaded bundle "${result.bundle.manifest.adventure.title}":`,
      `${result.bundle.scenes.entities.length} scenes,`,
      `${result.bundle.journals.entities.length} journals,`,
      `${result.bundle.actors.entities.length} actors,`,
      `${result.bundle.items.entities.length} items,`,
      `${assets.size} assets`,
    );

    return { bundle: result.bundle, assets };
  }

  private requireFile(zip: Record<string, Uint8Array>, path: string): Uint8Array {
    const data = zip[path];
    if (!data) {
      throw new BundleLoadError(
        `Bundle is missing required file: ${path}. The zip may be corrupted or built with an incompatible contract version.`,
      );
    }
    return data;
  }

  private parseJson(data: Uint8Array, path: string): unknown {
    try {
      return JSON.parse(strFromU8(data));
    } catch (cause) {
      throw new BundleLoadError(
        `${path} is not valid JSON: ${(cause as Error).message}`,
        cause,
      );
    }
  }
}
