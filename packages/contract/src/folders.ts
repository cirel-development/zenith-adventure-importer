import { z } from 'zod';
import { SlugSchema, FolderPathSchema } from './shared.js';

// Folders apply to actors, items, journals, scenes, and playlists.
// One folder list, one entry per folder, parent_path establishes hierarchy.
export const FolderTypeSchema = z.enum([
  'actor',
  'item',
  'journal',
  'scene',
  'playlist',
]);

export type FolderType = z.infer<typeof FolderTypeSchema>;

export const FolderEntrySchema = z.object({
  // Last segment of the folder path. e.g. for "lost-temple/actors/npcs", slug is "npcs"
  slug: SlugSchema,

  // Display name. May start with a number prefix like "01 - " for sort order.
  name: z.string().min(1),

  // Path of the parent folder, or null for top-level folders.
  // e.g. for "lost-temple/actors/npcs", parent_path is "lost-temple/actors"
  parent_path: FolderPathSchema.nullable(),

  // Which Foundry directory this folder lives in.
  type: FolderTypeSchema,

  // Foundry sort order. Use multiples of 100 for room to insert later.
  sort: z.number().int().default(0),

  // Optional folder color, hex. Foundry supports per-folder coloring.
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

export type FolderEntry = z.infer<typeof FolderEntrySchema>;

export const FoldersFileSchema = z.object({
  entities: z.array(FolderEntrySchema),
});

export type FoldersFile = z.infer<typeof FoldersFileSchema>;
