import type {
  Bundle,
  ItemEntry,
  ItemData,
} from '@ai-adventure/contract';
import type { FolderBuilder } from './FolderBuilder.js';
import type { AssetMap } from '../pipeline/AssetUploader.js';
import type { EntityRegistry } from '../pipeline/EntityRegistry.js';
import type { CompendiumLookup } from '../compendium/CompendiumLookup.js';
import { RuneApplicator } from '../compendium/RuneApplicator.js';
import { log } from '../log.js';

declare const Item: { create(data: unknown): Promise<ItemDoc> };

export class ItemBuilder {
  private readonly runes: RuneApplicator;

  constructor(
    private readonly folders: FolderBuilder,
    private readonly compendium: CompendiumLookup,
  ) {
    this.runes = new RuneApplicator(compendium);
  }

  async build(
    bundle: Bundle,
    registry: EntityRegistry,
    assetMap: AssetMap,
  ): Promise<void> {
    const items = bundle.items.entities;
    if (items.length === 0) {
      log.debug('no items to build');
      return;
    }
    log.info(`building ${items.length} items`);

    for (const entry of items) {
      await this.createOne(entry, registry, assetMap);
    }
  }

  // ============================================================================

  private async createOne(
    entry: ItemEntry,
    registry: EntityRegistry,
    assetMap: AssetMap,
  ): Promise<void> {
    const folderId = this.folders.pathToId.get(entry.folder);
    if (!folderId) {
      throw new Error(
        `ItemBuilder: folder "${entry.folder}" not found for item "${entry.slug}"`,
      );
    }

    const data = await this.buildItemData(entry);
    if (!data) {
      log.warn(`item "${entry.slug}" could not be built, skipping`);
      return;
    }

    data['folder'] = folderId;
    data['name'] = entry.name;
    data['flags'] = {
      ...(data['flags'] as Record<string, unknown> ?? {}),
      'zenith-adventure-importer': {
        slug: entry.slug,
        category: entry.category,
        ...(entry.ai_metadata?.review_required
          ? {
              reviewRequired: true,
              reviewReasons: entry.ai_metadata.review_reasons,
              confidence: entry.ai_metadata.confidence,
            }
          : {}),
      },
    };

    if (entry.image) {
      const imagePath = assetMap.get(entry.image);
      if (imagePath) data['img'] = imagePath;
    }

    const created = await Item.create(data);
    registry.record({
      slug: entry.slug,
      type: 'item',
      foundryId: created.id,
      collection: 'Item',
    });
    log.debug('item created', entry.slug, '→', created.id);
  }

  /** Dispatch on data.kind. */
  private async buildItemData(
    entry: ItemEntry,
  ): Promise<Record<string, unknown> | null> {
    switch (entry.data.kind) {
      case 'compendium-ref': {
        const result = await this.compendium.resolveSource(entry.data.uuid, entry.name);
        if (!result) {
          log.warn(`item "${entry.slug}": compendium UUID ${entry.data.uuid} not found, placeholder`);
          return {
            type: 'equipment',
            flags: {
              'zenith-adventure-importer': {
                unresolvedCompendium: entry.data.uuid,
                placeholder: true,
              },
            },
          };
        }
        const source = result.source;
        if (entry.data.name_override) {
          source['name'] = entry.data.name_override;
        }
        if (result.driftWarning) {
          source['flags'] = {
            ...((source['flags'] as Record<string, unknown>) ?? {}),
            'zenith-adventure-importer': {
              ...((source['flags'] as any)?.['zenith-adventure-importer'] ?? {}),
              driftWarning: true,
              originalUuid: entry.data.uuid,
              resolvedUuid: result.resolvedUuid,
            },
          };
        }
        return source;
      }

      case 'compendium-ref-with-runes': {
        const result = await this.runes.apply(entry.data.base_uuid, entry.data.runes, entry.name);
        if (!result) {
          log.warn(`item "${entry.slug}": rune application failed, placeholder`);
          return {
            type: 'weapon',
            flags: {
              'zenith-adventure-importer': {
                unresolvedCompendium: entry.data.base_uuid,
                placeholder: true,
              },
            },
          };
        }
        if (entry.data.name_override) {
          result['name'] = entry.data.name_override;
        }
        return result;
      }

      case 'custom':
        return this.buildCustom(entry, entry.data);
    }
  }

  // ----------------------------------------------------------------------------
  // Custom item path
  // ----------------------------------------------------------------------------

  private buildCustom(
    _entry: ItemEntry,
    data: Extract<ItemData, { kind: 'custom' }>,
  ): Record<string, unknown> {
    const system: Record<string, unknown> = {
      level: { value: data.level },
      rarity: data.rarity,
      traits: { value: data.traits, rarity: data.rarity },
      bulk: { value: this.normalizeBulk(data.bulk) },
      // Price: PF2e structures price.value as denominations
      price: {
        value: this.cpToPriceValue(data.price_cp),
      },
      description: { value: data.description_html },
    };

    // Type-specific properties
    if (data.weapon) {
      system['damage'] = {
        dice: this.parseDamageDice(data.weapon.damage_dice),
        die: this.parseDamageDie(data.weapon.damage_dice),
        damageType: data.weapon.damage_type,
      };
      system['group'] = data.weapon.group;
      system['traits'] = { value: data.weapon.traits, rarity: data.rarity };
      if (data.weapon.range_feet) system['range'] = data.weapon.range_feet;
      if (data.weapon.reload) system['reload'] = { value: data.weapon.reload };
    }
    if (data.armor) {
      system['armor'] = { value: data.armor.ac_bonus };
      system['dex'] = { value: data.armor.dex_cap };
      system['check'] = { value: data.armor.check_penalty };
      system['speed'] = { value: data.armor.speed_penalty };
      if (data.armor.strength_requirement !== undefined) {
        system['strength'] = { value: data.armor.strength_requirement };
      }
      system['group'] = data.armor.group;
    }
    if (data.consumable) {
      system['usage'] = { value: data.consumable.usage ?? 'held-in-one-hand' };
      if (data.consumable.activation) {
        system['actionType'] = { value: this.mapActivation(data.consumable.activation) };
        system['actions'] = { value: this.mapActivationCount(data.consumable.activation) };
      }
      if (data.consumable.charges) {
        system['charges'] = { value: data.consumable.charges, max: data.consumable.charges };
      }
    }

    if (data.requires_investiture) {
      system['traits'] = {
        ...((system['traits'] as Record<string, unknown>) ?? {}),
        value: [
          ...((system['traits'] as { value: string[] })?.value ?? []),
          'invested',
        ],
      };
    }

    return {
      type: this.mapItemType(data.item_type),
      system,
    };
  }

  // ----------------------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------------------

  private mapItemType(itemType: Extract<ItemData, { kind: 'custom' }>['item_type']): string {
    // PF2e document types match the contract names directly for these.
    return itemType;
  }

  private normalizeBulk(bulk: Extract<ItemData, { kind: 'custom' }>['bulk']): string | number {
    if (bulk === 'L') return 'L';
    return bulk;
  }

  private cpToPriceValue(cp: number): { gp?: number; sp?: number; cp?: number; pp?: number } {
    // Convert raw copper to PF2e's denomination object.
    const result: { gp?: number; sp?: number; cp?: number; pp?: number } = {};
    let remaining = cp;
    if (remaining >= 1000) {
      result.pp = Math.floor(remaining / 1000);
      remaining %= 1000;
    }
    if (remaining >= 100) {
      result.gp = Math.floor(remaining / 100);
      remaining %= 100;
    }
    if (remaining >= 10) {
      result.sp = Math.floor(remaining / 10);
      remaining %= 10;
    }
    if (remaining > 0) {
      result.cp = remaining;
    }
    return result;
  }

  private parseDamageDice(formula: string): number {
    // Parse "1d8" -> 1, "2d6" -> 2
    const match = /^(\d+)d/.exec(formula);
    return match?.[1] ? parseInt(match[1], 10) : 1;
  }

  private parseDamageDie(formula: string): string {
    // Parse "1d8" -> "d8"
    const match = /d(\d+)/.exec(formula);
    return match?.[1] ? `d${match[1]}` : 'd6';
  }

  private mapActivation(
    activation: NonNullable<Extract<ItemData, { kind: 'custom' }>['consumable']>['activation'],
  ): string {
    switch (activation) {
      case 'reaction':
        return 'reaction';
      case 'free':
        return 'free';
      case 'passive':
        return 'passive';
      default:
        return 'action';
    }
  }

  private mapActivationCount(
    activation: NonNullable<Extract<ItemData, { kind: 'custom' }>['consumable']>['activation'],
  ): number | null {
    if (activation === '1' || activation === '2' || activation === '3') {
      return Number(activation);
    }
    return null;
  }
}
