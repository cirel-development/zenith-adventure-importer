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
// Categories — drives folder placement and rendering
// ============================================================================

export const ItemCategorySchema = z.enum([
  'magic_item', // unique adventure-specific magic items
  'quest_object', // mechanically-minimal plot objects (the bronze key)
  'consumable',
  'weapon',
  'armor',
  'equipment',
  'spell', // adventure-specific spells
  'treasure', // gems, art objects, valuables (not currency — that lives on loot containers)
]);

export type ItemCategory = z.infer<typeof ItemCategorySchema>;

// ============================================================================
// Compendium reference variant — most items match
// ============================================================================

const CompendiumRefItemDataSchema = z.object({
  kind: z.literal('compendium-ref'),
  uuid: CompendiumUuidSchema,
  version_pin: z
    .string()
    .regex(/^[\w-]+@\d+(\.\d+)*$/)
    .optional(),
  name_override: z.string().optional(),
});

// ============================================================================
// Compendium-ref + runes variant — for PF2e magic weapons/armor
// ============================================================================

// Runes get applied to a base item from the compendium (e.g. base "longsword" + striking rune)
const PF2eRuneSchema = z.object({
  // Type tells the builder where on the base item to apply this rune
  type: z.enum([
    'weapon-potency', // +1, +2, +3
    'striking', // striking, greater striking, major striking
    'armor-potency', // +1, +2, +3
    'resilient', // resilient, greater resilient, major resilient
    'property', // flaming, returning, holy, etc.
  ]),
  // Compendium UUID for the rune itself
  uuid: CompendiumUuidSchema,
  // For potency/striking/resilient runes, the level (1, 2, 3)
  rank: z.number().int().min(1).max(3).optional(),
});

const RuneAppliedItemDataSchema = z.object({
  kind: z.literal('compendium-ref-with-runes'),
  base_uuid: CompendiumUuidSchema, // base weapon or armor
  runes: z.array(PF2eRuneSchema).min(1),
  name_override: z.string().optional(),
});

// ============================================================================
// Custom variant — adventure-specific items
// ============================================================================

const PF2eItemTypeSchema = z.enum([
  'weapon',
  'armor',
  'consumable',
  'equipment',
  'treasure',
  'spell',
]);

const PF2eBulkSchema = z.union([
  z.literal('L'), // light bulk
  z.literal(0), // negligible
  z.number().int().nonnegative(),
]);

// PF2e price stored in copper pieces equivalent for unambiguous comparison.
// Renderer converts to gp/sp/cp for display.
const PF2ePriceCpSchema = z.number().int().nonnegative();

const PF2eRaritySchema = z.enum(['common', 'uncommon', 'rare', 'unique']).default('common');

// Mechanical properties for weapons
const WeaponPropertiesSchema = z.object({
  damage_dice: z.string(), // e.g. "1d8"
  damage_type: z.string(), // "piercing", "slashing", etc.
  group: z.string(), // weapon group, e.g. "sword", "axe"
  traits: z.array(z.string()).default([]),
  range_feet: z.number().int().positive().optional(),
  reload: z.string().optional(),
});

// Mechanical properties for armor
const ArmorPropertiesSchema = z.object({
  ac_bonus: z.number().int(),
  dex_cap: z.number().int().nullable(),
  check_penalty: z.number().int(),
  speed_penalty: z.number().int(),
  strength_requirement: z.number().int().optional(),
  group: z.string(), // armor group
  traits: z.array(z.string()).default([]),
});

// Mechanical properties for consumables
const ConsumablePropertiesSchema = z.object({
  // PF2e usage strings, e.g. "held-in-one-hand", "worn"
  usage: z.string().optional(),
  activation: z.enum(['1', '2', '3', 'reaction', 'free', 'passive']).optional(),
  charges: z.number().int().positive().optional(),
});

// Magic effects — passive bonuses, activated abilities, attached spells
const ItemEffectSchema = z.object({
  name: z.string(),
  effect_type: z.enum(['passive', 'activated', 'attached-spell']),
  description_html: RefContentSchema,
  activation: z.enum(['1', '2', '3', 'reaction', 'free']).optional(),
  frequency: z.string().optional(),
  // For attached-spell effects: compendium reference
  spell_uuid: CompendiumUuidSchema.optional(),
});

const CustomItemDataSchema = z.object({
  kind: z.literal('custom'),
  item_type: PF2eItemTypeSchema,
  level: z.number().int().min(0).max(30),
  rarity: PF2eRaritySchema,
  traits: z.array(z.string()).default([]),
  bulk: PF2eBulkSchema,
  price_cp: PF2ePriceCpSchema,
  description_html: RefContentSchema,

  // Type-specific properties — populate the one matching item_type
  weapon: WeaponPropertiesSchema.optional(),
  armor: ArmorPropertiesSchema.optional(),
  consumable: ConsumablePropertiesSchema.optional(),

  // Magic effects on the item
  effects: z.array(ItemEffectSchema).default([]),

  // Investiture / resonance requirements (PF2e wears worn magic items)
  requires_investiture: z.boolean().default(false),
});

// ============================================================================
// Discriminated item data union
// ============================================================================

export const ItemDataSchema = z.discriminatedUnion('kind', [
  CompendiumRefItemDataSchema,
  RuneAppliedItemDataSchema,
  CustomItemDataSchema,
]);

export type ItemData = z.infer<typeof ItemDataSchema>;

// ============================================================================
// Item entry
// ============================================================================

export const ItemEntrySchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1),
  category: ItemCategorySchema,
  folder: FolderPathSchema,

  data: ItemDataSchema,
  image: AssetPathSchema.optional(),

  // For quest objects: pointer to the journal where this object is described
  linked_journal: RefContentSchema.optional(),

  ai_metadata: AIMetadataSchema.optional(),
});

export type ItemEntry = z.infer<typeof ItemEntrySchema>;

// ============================================================================
// File
// ============================================================================

export const ItemsFileSchema = z.object({
  entities: z.array(ItemEntrySchema),
});

export type ItemsFile = z.infer<typeof ItemsFileSchema>;
