import { z } from 'zod';
import {
  SlugSchema,
  FolderPathSchema,
  AssetPathSchema,
  RefContentSchema,
  AIMetadataSchema,
} from './shared.js';

// ============================================================================
// Wall — Foundry v13 schema (confirmed working in ai-map-scanner)
// ============================================================================

// 0=none, 10=limited, 20=normal — applies to light, move, sight independently
const WallBlockingSchema = z.union([z.literal(0), z.literal(10), z.literal(20)]);

// 0=wall (not a door), 1=door, 2=secret door
const WallDoorSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

// 0=closed, 1=open, 2=locked
const WallDoorStateSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

// Normalized coordinates: [x1, y1, x2, y2] each in 0.0–1.0 of scene dimensions.
// The Foundry module multiplies by scene width/height at build time, so the
// contract is independent of image resolution — re-exporting at higher fidelity
// doesn't break placed walls.
const NormalizedCoordSchema = z.number().min(0).max(1);

const WallCoordSchema = z.tuple([
  NormalizedCoordSchema,
  NormalizedCoordSchema,
  NormalizedCoordSchema,
  NormalizedCoordSchema,
]);

export const WallSchema = z.object({
  c: WallCoordSchema,
  light: WallBlockingSchema.default(20),
  move: WallBlockingSchema.default(20),
  sight: WallBlockingSchema.default(20),
  door: WallDoorSchema.default(0),
  ds: WallDoorStateSchema.default(0),
});

export type Wall = z.infer<typeof WallSchema>;

// ============================================================================
// Lights
// ============================================================================

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const LightSchema = z.object({
  // Normalized scene coordinates
  x: NormalizedCoordSchema,
  y: NormalizedCoordSchema,

  config: z.object({
    // Radii in grid units (NOT pixels) — Foundry handles the conversion
    dim: z.number().nonnegative(),
    bright: z.number().nonnegative(),
    color: HexColorSchema.default('#ffffff'),
    alpha: z.number().min(0).max(1).default(0.5),
    animation: z
      .object({
        type: z.enum(['none', 'torch', 'pulse', 'chroma', 'wave', 'fog', 'sunburst']),
        speed: z.number().int().min(1).max(10).default(3),
        intensity: z.number().int().min(1).max(10).default(3),
      })
      .optional(),
  }),
});

export type Light = z.infer<typeof LightSchema>;

// ============================================================================
// Ambient sounds
// ============================================================================

export const AmbientSoundSchema = z.object({
  x: NormalizedCoordSchema,
  y: NormalizedCoordSchema,

  // Radius in grid units
  radius: z.number().positive(),

  // The contract leaves the sound file path empty by design — playlists are
  // scaffolded but no audio files are bundled. This field captures the
  // suggestion that the GM can later wire to a real file.
  description: z.string(),

  // Falloff and volume settings — sane defaults applied by the module if omitted
  easing: z.boolean().default(true),
  volume: z.number().min(0).max(1).default(0.5),
});

export type AmbientSound = z.infer<typeof AmbientSoundSchema>;

// ============================================================================
// Map notes (clickable journal pins on the canvas)
// ============================================================================

export const SceneNoteSchema = z.object({
  x: NormalizedCoordSchema,
  y: NormalizedCoordSchema,

  // [[REF:journal:slug]] or [[REF:journal:slug#page]]
  journal_ref: RefContentSchema,

  // Foundry icon for the note pin. Defaults to a generic marker.
  icon: z.string().default('icons/svg/book.svg'),
  icon_size: z.number().int().positive().default(40),

  // Optional label shown next to the pin
  label: z.string().optional(),
});

export type SceneNote = z.infer<typeof SceneNoteSchema>;

// ============================================================================
// Grid
// ============================================================================

const GridTypeSchema = z.enum(['square', 'hex-pointy-top', 'hex-flat-top', 'gridless']);

export const SceneGridSchema = z.object({
  type: GridTypeSchema.default('square'),
  // Pixels per square. Standard Foundry default is 100.
  size: z.number().int().positive().default(100),
});

// ============================================================================
// Scene entry
// ============================================================================

export const SceneEntrySchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1),
  folder: FolderPathSchema,

  background: AssetPathSchema,

  // Pixel dimensions of the scene canvas. The module uses these to convert
  // normalized wall/light/sound coordinates into Foundry pixel coordinates.
  dimensions: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    // Padding multiplier for off-canvas content. Foundry default is 0.25.
    padding: z.number().min(0).max(0.5).default(0.25),
  }),

  grid: SceneGridSchema,

  walls: z.array(WallSchema).default([]),
  lights: z.array(LightSchema).default([]),
  sounds: z.array(AmbientSoundSchema).default([]),
  notes: z.array(SceneNoteSchema).default([]),

  // [[REF:playlist:slug]] — module sets this as scene.playlistSound IF the
  // user enabled "auto-link playlists" in module settings, otherwise records
  // the suggestion in the scene's journal entry but leaves the field blank.
  // (Empty playlists at startup look broken.)
  playlist_hint: RefContentSchema.optional(),

  // Initial view: where the camera starts and zoom level
  initial_view: z
    .object({
      x: NormalizedCoordSchema,
      y: NormalizedCoordSchema,
      scale: z.number().positive().default(1),
    })
    .optional(),

  ai_metadata: AIMetadataSchema.optional(),
});

export type SceneEntry = z.infer<typeof SceneEntrySchema>;

// ============================================================================
// File
// ============================================================================

export const ScenesFileSchema = z.object({
  entities: z.array(SceneEntrySchema),
});

export type ScenesFile = z.infer<typeof ScenesFileSchema>;
