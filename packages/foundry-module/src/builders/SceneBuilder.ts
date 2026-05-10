import type { Bundle, SceneEntry, Wall, Light, AmbientSound } from '@ai-adventure/contract';
import type { FolderBuilder } from './FolderBuilder.js';
import type { AssetMap } from '../pipeline/AssetUploader.js';
import type { EntityRegistry } from '../pipeline/EntityRegistry.js';
import { log } from '../log.js';

const GRID_TYPE_MAP = {
  square: 1,
  'hex-pointy-top': 2,
  'hex-flat-top': 3,
  gridless: 0,
} as const;

/**
 * Foundry's wall blocking constants in v13. Same values the contract uses
 * (0/10/20) — confirmed working in ai-map-scanner. Documented here for
 * future maintainers wondering why magic numbers.
 */
const WALL_BLOCKING = { NONE: 0, LIMITED: 10, NORMAL: 20 } as const;

export class SceneBuilder {
  constructor(private readonly folders: FolderBuilder) {}

  async build(
    bundle: Bundle,
    registry: EntityRegistry,
    assetMap: AssetMap,
  ): Promise<void> {
    const scenes = bundle.scenes.entities;
    log.info(`building ${scenes.length} scenes`);

    for (const entry of scenes) {
      await this.createOne(entry, registry, assetMap);
    }
  }

  // ============================================================================

  private async createOne(
    entry: SceneEntry,
    registry: EntityRegistry,
    assetMap: AssetMap,
  ): Promise<void> {
    const folderId = this.folders.pathToId.get(entry.folder);
    if (!folderId) {
      throw new Error(
        `SceneBuilder: folder "${entry.folder}" not found for scene "${entry.slug}".`,
      );
    }

    const backgroundPath = assetMap.get(entry.background);
    if (!backgroundPath) {
      throw new Error(
        `SceneBuilder: background "${entry.background}" not found in upload map.`,
      );
    }

    const { width, height } = entry.dimensions;
    const padding = entry.dimensions.padding;

    // Foundry's `padding` adds extra canvas space around the playable area.
    // The background image sits in the playable area, which starts at
    // (padding * width, padding * height) on the canvas — NOT at (0, 0).
    // Our normalized 0..1 coordinates from the contract describe positions
    // relative to the image, so we add the offset to align walls/lights/etc
    // with the actual image, not the upper-left of the padded canvas.
    const offsetX = width * padding;
    const offsetY = height * padding;

    // Convert all normalized coordinates to scene-pixel coordinates.
    const walls = entry.walls.map((w) => this.buildWall(w, width, height, offsetX, offsetY));
    const lights = entry.lights.map((l) =>
      this.buildLight(l, width, height, entry.grid.size, offsetX, offsetY),
    );
    const sounds = entry.sounds.map((s) =>
      this.buildSound(s, width, height, entry.grid.size, offsetX, offsetY),
    );

    // Notes are created with the journal_ref still as a [[REF:]] token.
    // The RefResolver pass replaces these with real journal references, then
    // a separate pinning pass attaches notes to the right journal page.
    // For Pass 1 we just store the raw ref in the note's flags so the
    // resolver can find it.
    const notes = entry.notes.map((n) => this.buildNote(n, width, height, offsetX, offsetY));

    const sceneData: Record<string, unknown> = {
      name: entry.name,
      folder: folderId,
      background: { src: backgroundPath },
      width,
      height,
      padding: entry.dimensions.padding,
      grid: {
        type: GRID_TYPE_MAP[entry.grid.type],
        size: entry.grid.size,
      },
      walls,
      lights,
      sounds,
      notes,
      flags: {
        'zenith-adventure-importer': {
          slug: entry.slug,
        },
      },
    };

    if (entry.initial_view) {
      sceneData['initial'] = {
        x: offsetX + entry.initial_view.x * width,
        y: offsetY + entry.initial_view.y * height,
        scale: entry.initial_view.scale,
      };
    }

    // playlist_hint is intentionally NOT applied here. Auto-linking to a
    // playlist that has no audio files makes scenes look broken on first load.
    // The Importer applies it later via a setting if the user opted in.

    const created = await Scene.create(sceneData);
    registry.record({
      slug: entry.slug,
      type: 'scene',
      foundryId: created.id,
      collection: 'Scene',
    });

    log.debug(
      'scene created',
      entry.slug,
      '→',
      created.id,
      `(${walls.length}w/${lights.length}l/${sounds.length}s/${notes.length}n)`,
    );
  }

  // ============================================================================
  // Coordinate denormalization
  // ============================================================================

  private buildWall(
    wall: Wall,
    sceneWidth: number,
    sceneHeight: number,
    offsetX: number,
    offsetY: number,
  ): unknown {
    const [x1, y1, x2, y2] = wall.c;
    return {
      c: [
        offsetX + x1 * sceneWidth,
        offsetY + y1 * sceneHeight,
        offsetX + x2 * sceneWidth,
        offsetY + y2 * sceneHeight,
      ],
      light: wall.light,
      move: wall.move,
      sight: wall.sight,
      door: wall.door,
      ds: wall.ds,
    };
  }

  private buildLight(
    light: Light,
    sceneWidth: number,
    sceneHeight: number,
    gridSize: number,
    offsetX: number,
    offsetY: number,
  ): unknown {
    return {
      x: offsetX + light.x * sceneWidth,
      y: offsetY + light.y * sceneHeight,
      config: {
        // Light radii are in grid units in the contract; Foundry expects pixels.
        // dim/bright fields on the light itself become grid-unit radii Foundry
        // multiplies by gridSize internally — but storing pixel values directly
        // here matches what ai-map-scanner did successfully, so we keep that.
        dim: light.config.dim * gridSize,
        bright: light.config.bright * gridSize,
        color: light.config.color,
        alpha: light.config.alpha,
        ...(light.config.animation
          ? {
              animation: {
                type: light.config.animation.type,
                speed: light.config.animation.speed,
                intensity: light.config.animation.intensity,
              },
            }
          : {}),
      },
    };
  }

  private buildSound(
    sound: AmbientSound,
    sceneWidth: number,
    sceneHeight: number,
    gridSize: number,
    offsetX: number,
    offsetY: number,
  ): unknown {
    return {
      x: offsetX + sound.x * sceneWidth,
      y: offsetY + sound.y * sceneHeight,
      radius: sound.radius * gridSize,
      easing: sound.easing,
      volume: sound.volume,
      // path intentionally empty — we never bundle audio. The description
      // lives on the sound's flags so the GM can search and replace later.
      flags: {
        'zenith-adventure-importer': {
          description: sound.description,
        },
      },
    };
  }

  private buildNote(
    note: SceneEntry['notes'][number],
    sceneWidth: number,
    sceneHeight: number,
    offsetX: number,
    offsetY: number,
  ): unknown {
    return {
      x: offsetX + note.x * sceneWidth,
      y: offsetY + note.y * sceneHeight,
      icon: note.icon,
      iconSize: note.icon_size,
      ...(note.label ? { text: note.label } : {}),
      // entryId is set during the ref-resolution pass once the target journal
      // exists. For now, stash the ref token in flags.
      flags: {
        'zenith-adventure-importer': {
          unresolvedJournalRef: note.journal_ref,
        },
      },
    };
  }
}
