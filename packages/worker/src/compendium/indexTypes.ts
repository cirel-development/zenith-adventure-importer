/**
 * Shape of data/compendium-index.json and the pack-priority rules shared by
 * the build script and the runtime loader.
 */

/** Item packs to index, by system.json pack NAME (not folder). */
export const ITEM_PACKS = ['equipment-srd', 'spells-srd', 'feats-srd', 'conditionitems'];

export const INDEX_ENTRY_FIELDS = ['name', 'id', 'pack', 'type', 'level', 'rarity'] as const;

/** [name, _id, pack index, document type (npc/hazard/equipment/...), level, rarity] */
export type IndexEntry = [string, string, number, string, number | null, string | null];

export interface IndexPack {
  name: string;
  label: string;
  docType: 'Actor' | 'Item';
  folder: string;
  count: number;
  /** Lower wins on a name clash (after the adventure's own pack). */
  tier: number;
}

export interface CompendiumIndexFile {
  source: {
    system: string;
    version: string;
    release: string;
    foundry: { minimum: string; verified: string; maximum?: string };
  };
  entryFields: string[];
  packs: IndexPack[];
  entries: IndexEntry[];
}

const REMASTER_CORE = ['pathfinder-monster-core', 'pathfinder-monster-core-2', 'pathfinder-npc-core'];
const LEGACY_CORE = ['pathfinder-bestiary', 'pathfinder-bestiary-2', 'pathfinder-bestiary-3', 'npc-gallery'];

/**
 * Name-clash priority (decided 2026-11-27): the adventure's own pack first
 * (applied at lookup time), then Remaster core, then legacy core, then the
 * hazards pack, then every other bestiary.
 */
export function packTier(name: string, docType: string): number {
  if (docType === 'Item') return 1;
  if (REMASTER_CORE.includes(name)) return 1;
  if (LEGACY_CORE.includes(name)) return 2;
  if (name === 'hazards') return 3;
  return 4;
}
