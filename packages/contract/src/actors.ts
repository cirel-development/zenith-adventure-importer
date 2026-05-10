import { z } from 'zod';
import {
  SlugSchema,
  FolderPathSchema,
  AssetPathSchema,
  RefContentSchema,
  CompendiumUuidSchema,
  AIMetadataSchema,
} from './shared.js';

// ============================================================================
// Categories — drives folder placement and which stat-block fields apply
// ============================================================================

export const ActorCategorySchema = z.enum([
  'npc', // humanoid character with a name (Captain Marrow)
  'creature', // generic monster or beast (Shadow Cultist)
  'hazard', // trap or environmental hazard with combat mechanics
  'loot', // treasure container — stat_block must be {kind: "loot-container"}
]);

export type ActorCategory = z.infer<typeof ActorCategorySchema>;

// ============================================================================
// Compendium reference variant
// ============================================================================

const CompendiumRefStatBlockSchema = z.object({
  kind: z.literal('compendium-ref'),
  uuid: CompendiumUuidSchema,

  // Hint to log a warning if the user's installed pack version differs.
  // Format: "<system-or-module>@<version>" e.g. "pf2e@7.4.1"
  version_pin: z
    .string()
    .regex(/^[\w-]+@\d+(\.\d+)*$/)
    .optional(),

  // Override the compendium's default name if the adventure renames the creature
  // (e.g. compendium "Shadow Cultist" → adventure "Shadow Cultist of the Veil")
  name_override: z.string().optional(),
});

// ============================================================================
// Custom stat block variant — PF2e flavor
// ============================================================================

const PF2eAbilityModsSchema = z.object({
  str: z.number().int(),
  dex: z.number().int(),
  con: z.number().int(),
  int: z.number().int(),
  wis: z.number().int(),
  cha: z.number().int(),
});

const PF2eSavesSchema = z.object({
  fortitude: z.number().int(),
  reflex: z.number().int(),
  will: z.number().int(),
});

const PF2eSpeedsSchema = z.object({
  land: z.number().int().nonnegative(),
  fly: z.number().int().nonnegative().optional(),
  swim: z.number().int().nonnegative().optional(),
  climb: z.number().int().nonnegative().optional(),
  burrow: z.number().int().nonnegative().optional(),
});

const PF2eSizeSchema = z.enum(['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan']);

const PF2eAlignmentSchema = z
  .enum(['LG', 'NG', 'CG', 'LN', 'N', 'CN', 'LE', 'NE', 'CE', 'no-alignment'])
  .optional();

const PF2eRaritySchema = z.enum(['common', 'uncommon', 'rare', 'unique']).default('common');

// A "strike" is one weapon attack the creature has access to
const PF2eStrikeSchema = z.object({
  name: z.string(),
  type: z.enum(['melee', 'ranged']),
  attack_bonus: z.number().int(),
  damage_formula: z.string(), // e.g. "1d8+4 piercing"
  traits: z.array(z.string()).default([]),
  range_feet: z.number().int().positive().optional(),
  reload: z.string().optional(), // e.g. "1", "interact"
  // Compendium link for the underlying weapon, if matched. Strike data still
  // included even when matched, since attack bonus and traits are creature-specific.
  weapon_uuid: CompendiumUuidSchema.optional(),
});

// A discrete ability/action — covers passive abilities, reactions, and N-action abilities
const PF2eActionSchema = z.object({
  name: z.string(),
  // Passive = always-on. Action = takes 1, 2, or 3 actions to use.
  // Reaction = single reaction. Free = free action.
  cost: z.enum(['passive', '1', '2', '3', 'reaction', 'free']),
  traits: z.array(z.string()).default([]),
  frequency: z.string().optional(), // e.g. "once per minute"
  trigger: z.string().optional(),
  description_html: RefContentSchema,
  // If matched to compendium feat/action
  source_uuid: CompendiumUuidSchema.optional(),
});

const PF2eSpellcastingSchema = z.object({
  tradition: z.enum(['arcane', 'divine', 'occult', 'primal']),
  type: z.enum(['prepared', 'spontaneous', 'innate', 'focus']),
  dc: z.number().int(),
  attack_bonus: z.number().int().optional(),
  // Spell list keyed by level. "0" = cantrips. Each spell either references the
  // compendium or is a custom adventure spell.
  spells: z.record(
    z.string(), // level as string key, e.g. "0", "1", ... "10"
    z.array(
      z.object({
        name: z.string(),
        uuid: CompendiumUuidSchema.optional(),
        // For prepared casters: how many slots of this level. For spontaneous: spells known.
        slots: z.number().int().nonnegative().optional(),
      }),
    ),
  ),
});

const PF2eInventoryItemSchema = z.object({
  // Reference into items.json by slug, OR a compendium UUID for unmodified equipment
  ref: SlugSchema.optional(),
  uuid: CompendiumUuidSchema.optional(),
  quantity: z.number().int().positive().default(1),
  equipped: z.boolean().default(false),
});

const CustomStatBlockSchema = z.object({
  kind: z.literal('custom'),
  level: z.number().int().min(-1).max(30),
  size: PF2eSizeSchema,
  rarity: PF2eRaritySchema,
  alignment: PF2eAlignmentSchema,
  traits: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),

  hp: z.number().int().nonnegative(),
  ac: z.number().int(),
  saves: PF2eSavesSchema,
  abilities: PF2eAbilityModsSchema,

  perception: z.number().int(),
  senses: z.array(z.string()).default([]),

  skills: z
    .array(z.object({ name: z.string(), bonus: z.number().int() }))
    .default([]),
  speeds: PF2eSpeedsSchema,

  // Mechanics
  immunities: z.array(z.string()).default([]),
  weaknesses: z
    .array(z.object({ type: z.string(), value: z.number().int() }))
    .default([]),
  resistances: z
    .array(z.object({ type: z.string(), value: z.number().int() }))
    .default([]),

  strikes: z.array(PF2eStrikeSchema).default([]),
  actions: z.array(PF2eActionSchema).default([]),
  spellcasting: z.array(PF2eSpellcastingSchema).default([]),
  inventory: z.array(PF2eInventoryItemSchema).default([]),

  // Free-form GM tactics paragraph
  tactics_html: RefContentSchema.optional(),
});

// ============================================================================
// Loot container variant — for treasure hoards (PF2e loot-type actor)
// ============================================================================

const LootContainerStatBlockSchema = z.object({
  kind: z.literal('loot-container'),
  // Currency in copper-piece-equivalent terms. Renderer converts to gp/sp/cp.
  currency: z
    .object({
      cp: z.number().int().nonnegative().default(0),
      sp: z.number().int().nonnegative().default(0),
      gp: z.number().int().nonnegative().default(0),
      pp: z.number().int().nonnegative().default(0),
    })
    .default({ cp: 0, sp: 0, gp: 0, pp: 0 }),

  // Items in the container, referenced by item slug or compendium UUID
  contents: z.array(
    z.object({
      ref: SlugSchema.optional(),
      uuid: CompendiumUuidSchema.optional(),
      quantity: z.number().int().positive().default(1),
    }),
  ),
});

// ============================================================================
// Discriminated stat block union
// ============================================================================

export const StatBlockSchema = z.discriminatedUnion('kind', [
  CompendiumRefStatBlockSchema,
  CustomStatBlockSchema,
  LootContainerStatBlockSchema,
]);

export type StatBlock = z.infer<typeof StatBlockSchema>;

// ============================================================================
// Token configuration
// ============================================================================

export const TokenConfigSchema = z.object({
  disposition: z.enum(['hostile', 'neutral', 'friendly', 'secret']).default('hostile'),
  // Token grid size, defaults to 1 (Tiny–Medium). Large=2, Huge=3, Gargantuan=4.
  scale: z.number().int().min(1).max(4).default(1),
  // If true, each placed token is its own copy (good for combat mooks).
  // If false, all tokens share the actor data (good for named NPCs).
  unlinked: z.boolean().default(true),
});

// ============================================================================
// Actor entry
// ============================================================================

export const ActorEntrySchema = z
  .object({
    slug: SlugSchema,
    name: z.string().min(1),
    category: ActorCategorySchema,
    folder: FolderPathSchema,

    stat_block: StatBlockSchema,

    portrait: AssetPathSchema.optional(),
    token_image: AssetPathSchema.optional(),
    token_config: TokenConfigSchema.optional(),

    // Companion journal page describing personality, secrets, voice, etc.
    linked_journal: RefContentSchema.optional(),

    ai_metadata: AIMetadataSchema.optional(),
  })
  .refine(
    (a) => a.category !== 'loot' || a.stat_block.kind === 'loot-container',
    { message: 'category=loot requires stat_block.kind=loot-container' },
  )
  .refine(
    (a) => a.category === 'loot' || a.stat_block.kind !== 'loot-container',
    { message: 'stat_block.kind=loot-container requires category=loot' },
  );

export type ActorEntry = z.infer<typeof ActorEntrySchema>;

// ============================================================================
// File
// ============================================================================

export const ActorsFileSchema = z.object({
  entities: z.array(ActorEntrySchema),
});

export type ActorsFile = z.infer<typeof ActorsFileSchema>;
