import { z } from 'zod';
import { SlugSchema, FolderPathSchema, AIMetadataSchema } from './shared.js';

// Two playlist types per chapter — ambience (sequential) and combat (shuffle).
// GM adds their own audio files later; the contract only carries the structure.
export const PlaylistModeSchema = z.enum(['sequential', 'shuffle', 'simultaneous']);

export const PlaylistEntrySchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1),
  folder: FolderPathSchema,
  mode: PlaylistModeSchema.default('sequential'),

  // Suggested ambience descriptions for the GM — these don't become playlist
  // sounds (those need real files), they just live as a description on the
  // playlist itself for the GM's reference.
  description: z.string().optional(),

  // No `sounds` array. By design. Empty playlists are clean in Foundry's UI;
  // placeholder sound entries with no file path show as broken icons.

  ai_metadata: AIMetadataSchema.optional(),
});

export type PlaylistEntry = z.infer<typeof PlaylistEntrySchema>;

export const PlaylistsFileSchema = z.object({
  entities: z.array(PlaylistEntrySchema),
});

export type PlaylistsFile = z.infer<typeof PlaylistsFileSchema>;
