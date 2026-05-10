import { z } from 'zod';
import {
  SlugSchema,
  FolderPathSchema,
  RefContentSchema,
  AssetPathSchema,
  PermissionLevelSchema,
  AIMetadataSchema,
} from './shared.js';

// ============================================================================
// Journal types (the seven journal categories)
// ============================================================================

export const JournalTypeSchema = z.enum([
  // 1. At-a-glance "what's happening here" for a room/encounter location
  'scene_entry',
  // 2. Deep dives: hidden details, skill checks, treasure mechanics
  'detailed_room',
  // 3. "How to run this" — synopsis, pacing, GM advice
  'instructional',
  // 4. Handouts, letters, player maps, riddles
  'shareable',
  // 5. Plot reveals, secrets, faction goals, twists
  'gm_context',
  // 6. NPC personality, voice, public info + secrets
  'npc_profile',
  // 7. Worldbuilding, history, factions, religions
  'lore',
]);

export type JournalType = z.infer<typeof JournalTypeSchema>;

// ============================================================================
// Pages
// ============================================================================

export const JournalPageTypeSchema = z.enum(['text', 'image', 'pdf', 'video']);

const TextPageSchema = z.object({
  page_type: z.literal('text'),
  slug: SlugSchema,
  name: z.string().min(1),
  permission: PermissionLevelSchema,
  // HTML content. May contain [[REF:type:slug]] tokens that get resolved at import.
  // May also contain <details><summary>...</summary>...</details> for collapsible
  // ambience blocks (rendered natively by Foundry).
  content_html: RefContentSchema,
  sort: z.number().int().default(0),
});

const ImagePageSchema = z.object({
  page_type: z.literal('image'),
  slug: SlugSchema,
  name: z.string().min(1),
  permission: PermissionLevelSchema,
  image: AssetPathSchema,
  // Optional caption shown beneath the image
  caption: z.string().optional(),
  sort: z.number().int().default(0),
});

export const JournalPageSchema = z.discriminatedUnion('page_type', [
  TextPageSchema,
  ImagePageSchema,
]);

export type JournalPage = z.infer<typeof JournalPageSchema>;

// ============================================================================
// Journal entries (multi-page containers)
// ============================================================================

export const JournalEntrySchema = z
  .object({
    slug: SlugSchema,
    name: z.string().min(1),
    type: JournalTypeSchema,
    folder: FolderPathSchema,

    // Default permission for pages that don't override it
    default_permission: PermissionLevelSchema.default('none'),

    pages: z.array(JournalPageSchema).min(1),

    // For scene_entry journals only — which scene this maps onto.
    // The module pins this journal as a map note when building scenes.
    scene_pin: z
      .object({
        scene_slug: SlugSchema,
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        // Which page within the journal the pin opens to
        page_slug: SlugSchema.optional(),
      })
      .optional(),

    sort: z.number().int().default(0),
    ai_metadata: AIMetadataSchema.optional(),
  })
  .refine(
    (entry) => {
      // page slugs must be unique within a journal
      const slugs = entry.pages.map((p) => p.slug);
      return new Set(slugs).size === slugs.length;
    },
    { message: 'page slugs must be unique within a journal entry' },
  );

export type JournalEntry = z.infer<typeof JournalEntrySchema>;

// ============================================================================
// File
// ============================================================================

export const JournalsFileSchema = z.object({
  entities: z.array(JournalEntrySchema),
});

export type JournalsFile = z.infer<typeof JournalsFileSchema>;
