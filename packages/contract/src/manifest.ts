import { z } from 'zod';
import { ContractVersionSchema, SlugSchema } from './shared.js';

// ============================================================================
// Adventure metadata
// ============================================================================

export const SystemIdSchema = z.enum(['pf2e', 'dnd5e']);
export type SystemId = z.infer<typeof SystemIdSchema>;

export const AdventureMetadataSchema = z.object({
  title: z.string().min(1),
  slug: SlugSchema,
  system: SystemIdSchema,

  // [min, max] inclusive party levels the adventure targets
  level_range: z.tuple([z.number().int().min(1), z.number().int().max(20)]),

  // Default party size used for encounter math
  party_size: z.number().int().min(1).max(8),

  // Hash of the source PDF so the same upload can be detected
  source_pdf_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),

  imported_at: z.string().datetime(),

  // Optional: which Paizo/WotC product this came from, if detected.
  // Free-form because product naming is not standardized.
  source_product: z.string().optional(),
});

// ============================================================================
// Entity index — maps logical entity types to file paths in the bundle
// ============================================================================

const EntityFilePathSchema = z
  .string()
  .regex(/^entities\/[a-z]+\.json$/, { message: 'expected entities/<name>.json' });

export const EntityIndexSchema = z.object({
  folders: EntityFilePathSchema,
  journals: EntityFilePathSchema,
  actors: EntityFilePathSchema,
  items: EntityFilePathSchema,
  scenes: EntityFilePathSchema,
  playlists: EntityFilePathSchema,
});

// ============================================================================
// Build order — explicit so the module never has to infer dependencies
// ============================================================================

export const BuildPhaseSchema = z.enum([
  'folders',
  'journals',
  'items',
  'actors',
  'scenes',
  'playlists',
]);

export const BuildOrderSchema = z.array(BuildPhaseSchema).min(1).max(6);

// ============================================================================
// Stats — for the GM's pre-import review screen
// ============================================================================

export const ManifestStatsSchema = z.object({
  scenes: z.number().int().nonnegative(),
  journals: z.number().int().nonnegative(),
  playlists: z.number().int().nonnegative(),
  actors: z.object({
    compendium: z.number().int().nonnegative(),
    custom: z.number().int().nonnegative(),
    review_needed: z.number().int().nonnegative(),
  }),
  items: z.object({
    compendium: z.number().int().nonnegative(),
    custom: z.number().int().nonnegative(),
    review_needed: z.number().int().nonnegative(),
  }),
  // Total tokens spent producing this bundle. For GM information only,
  // not used for billing (billing happens server-side in D1).
  ai_tokens: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cached: z.number().int().nonnegative(),
    })
    .optional(),
});

// ============================================================================
// Warnings — non-blocking issues surfaced during extraction
// ============================================================================

export const ManifestWarningSchema = z.object({
  kind: z.enum([
    'low_confidence',
    'partial_extraction',
    'image_not_classified',
    'compendium_not_found',
    'cross_reference_unresolved',
    'rune_parse_fallback',
    'other',
  ]),
  // "actors:strange-beast" — typed slug pointing to the affected entity
  entity: z.string().optional(),
  message: z.string(),
  score: z.number().min(0).max(1).optional(),
});

// ============================================================================
// The manifest itself
// ============================================================================

export const ManifestSchema = z.object({
  contract_version: ContractVersionSchema,
  bundle_id: z.string().regex(/^bnd_[a-z0-9]+$/),
  adventure: AdventureMetadataSchema,
  entities: EntityIndexSchema,
  build_order: BuildOrderSchema,
  stats: ManifestStatsSchema,
  warnings: z.array(ManifestWarningSchema).default([]),
});

export type Manifest = z.infer<typeof ManifestSchema>;
