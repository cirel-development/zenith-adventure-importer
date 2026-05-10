import type { Bundle } from '@ai-adventure/contract';
import type { FolderBuilder } from './FolderBuilder.js';
import type { EntityRegistry } from '../pipeline/EntityRegistry.js';
import { log } from '../log.js';

const PLAYBACK_MODE_MAP = {
  // Foundry's CONST.PLAYLIST_MODES values
  sequential: 0,
  shuffle: 1,
  simultaneous: 2,
} as const;

declare const Playlist: { create(data: unknown): Promise<PlaylistDoc> };

/**
 * Creates empty playlists. By design, no audio files are bundled — the
 * playlist exists as organizational scaffolding the GM fills in later.
 *
 * The description field carries the GM's prose suggestions for what to drop
 * into the playlist (e.g. "tense maritime track with low drums") so they
 * have a sourcing list when looking for audio.
 */
export class PlaylistBuilder {
  constructor(private readonly folders: FolderBuilder) {}

  async build(bundle: Bundle, registry: EntityRegistry): Promise<void> {
    const playlists = bundle.playlists.entities;
    if (playlists.length === 0) {
      log.debug('no playlists to build');
      return;
    }
    log.info(`building ${playlists.length} playlists`);

    for (const entry of playlists) {
      const folderId = this.folders.pathToId.get(entry.folder);
      if (!folderId) {
        throw new Error(
          `PlaylistBuilder: folder "${entry.folder}" not found for playlist "${entry.slug}"`,
        );
      }

      const created = await Playlist.create({
        name: entry.name,
        folder: folderId,
        mode: PLAYBACK_MODE_MAP[entry.mode],
        // Foundry doesn't have a description field on playlists, so we
        // store the suggestion in flags. The GM can find it via macro or
        // the journal scene-entry where we also include the suggestion.
        flags: {
          'zenith-adventure-importer': {
            slug: entry.slug,
            description: entry.description ?? null,
          },
        },
      });

      registry.record({
        slug: entry.slug,
        type: 'playlist',
        foundryId: created.id,
        collection: 'Playlist',
      });
      log.debug('playlist created', entry.slug, '→', created.id);
    }
  }
}
