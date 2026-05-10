import { z } from 'zod';

// ============================================================================
// Contract version
// ============================================================================

export const CONTRACT_VERSION = '1.0' as const;

export const ContractVersionSchema = z.literal(CONTRACT_VERSION);

// ============================================================================
// Slugs and references
// ============================================================================

// Lowercase, alphanumeric, single-dash separators. No leading/trailing/consecutive dashes.
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const SlugSchema = z.string().regex(SLUG_PATTERN, {
  message: 'slug must be lowercase alphanumeric with single-dash separators',
});

// The five reference types — anything that can be the target of a [[REF:]] token.
// "folder" is intentionally NOT here because folder refs aren't useful in user content.
export const RefTypeSchema = z.enum(['actor', 'journal', 'scene', 'item', 'playlist']);
export type RefType = z.infer<typeof RefTypeSchema>;

// A single token, e.g. "[[REF:actor:captain-marrow]]" or "[[REF:journal:npcs-ch1#captain-marrow]]"
const REF_TOKEN_PATTERN = /^\[\[REF:(actor|journal|scene|item|playlist):[a-z0-9]+(-[a-z0-9]+)*(#[a-z0-9]+(-[a-z0-9]+)*)?\]\]$/;

export const RefTokenSchema = z.string().regex(REF_TOKEN_PATTERN, {
  message: 'ref token must be [[REF:type:slug]] or [[REF:type:slug#anchor]]',
});

// Used for content fields that may contain zero or more REF tokens mixed with other text/HTML.
// Validation is just "string"; extraction is done by extractRefs().
export const RefContentSchema = z.string();

export interface ParsedRef {
  raw: string;
  type: RefType;
  slug: string;
  anchor?: string;
}

const REF_EXTRACTION_PATTERN =
  /\[\[REF:(actor|journal|scene|item|playlist):([a-z0-9]+(?:-[a-z0-9]+)*)(?:#([a-z0-9]+(?:-[a-z0-9]+)*))?\]\]/g;

export function extractRefs(content: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  for (const m of content.matchAll(REF_EXTRACTION_PATTERN)) {
    // Groups 1 and 2 are non-optional in the pattern; group 3 is the optional anchor.
    refs.push({
      raw: m[0]!,
      type: m[1] as RefType,
      slug: m[2]!,
      anchor: m[3],
    });
  }
  return refs;
}

// ============================================================================
// Asset paths (relative to bundle root)
// ============================================================================

const ASSET_PATH_PATTERN =
  /^images\/(maps|portraits|creatures|items|handouts|illustrations)\/[a-z0-9]+(?:-[a-z0-9]+)*\.(webp|png|jpg)$/;

export const AssetPathSchema = z.string().regex(ASSET_PATH_PATTERN, {
  message: 'asset path must be images/<category>/<slug>.{webp|png|jpg}',
});

// ============================================================================
// Permissions (string enum, not Foundry's numeric levels)
// ============================================================================

export const PermissionLevelSchema = z.enum(['none', 'limited', 'observer', 'owner']);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

// ============================================================================
// Compendium refs
// ============================================================================

// Foundry compendium UUIDs look like "Compendium.<package>.<pack>.<docType>.<id>"
export const CompendiumUuidSchema = z
  .string()
  .regex(/^Compendium\.[\w-]+\.[\w-]+\.\w+\.[\w-]+$/, {
    message: 'expected Compendium.<package>.<pack>.<docType>.<id>',
  });

// ============================================================================
// AI metadata — travels with every extracted entity
// ============================================================================

export const AIMetadataSchema = z.object({
  // 0.0–1.0 confidence score from extraction
  confidence: z.number().min(0).max(1),

  // 1-indexed PDF page where this entity was first identified
  source_page: z.number().int().positive().optional(),

  // Reference to a source-text snippet preserved in the bundle's _meta/ folder
  source_text_id: z.string().optional(),

  // ISO-8601 timestamp
  extracted_at: z.string().datetime().optional(),

  // Versioned prompt that produced this — useful for diagnosing quality regressions
  prompt_version: z.string().optional(),

  // Set when confidence < 0.6, or when extraction had specific known gaps
  review_required: z.boolean().default(false),
  review_reasons: z.array(z.string()).default([]),
});

export type AIMetadata = z.infer<typeof AIMetadataSchema>;

// ============================================================================
// Folder reference (used by every entity type to declare its folder placement)
// ============================================================================

// Forward-slash path through folder slugs, e.g. "lost-temple/actors/npcs"
const FOLDER_PATH_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/;

export const FolderPathSchema = z.string().regex(FOLDER_PATH_PATTERN, {
  message: 'folder path must be slug segments separated by /',
});
