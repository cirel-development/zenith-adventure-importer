import type {
  Bundle,
  ActorEntry,
  StatBlock,
} from '@ai-adventure/contract';
import type { FolderBuilder } from './FolderBuilder.js';
import type { AssetMap } from '../pipeline/AssetUploader.js';
import type { EntityRegistry } from '../pipeline/EntityRegistry.js';
import type { CompendiumLookup } from '../compendium/CompendiumLookup.js';
import { log } from '../log.js';

declare const Actor: { create(data: unknown): Promise<ActorDoc> };

const TOKEN_DISPOSITION_MAP = {
  // Foundry CONST.TOKEN_DISPOSITIONS values
  hostile: -1,
  neutral: 0,
  friendly: 1,
  secret: -2,
} as const;

/**
 * Three creation paths, branching on stat_block.kind:
 *
 *   - "compendium-ref"     → look up UUID, copy source data, override portrait/folder
 *   - "custom"             → build a PF2e NPC schema from the structured fields
 *   - "loot-container"     → PF2e loot-type actor with currency + items
 *
 * Compendium misses fall through to a placeholder actor with the bundle's
 * `name` and a warning flag. We don't fail the whole import on a single miss.
 */
export class ActorBuilder {
  constructor(
    private readonly folders: FolderBuilder,
    private readonly compendium: CompendiumLookup,
  ) {}

  async build(
    bundle: Bundle,
    registry: EntityRegistry,
    assetMap: AssetMap,
  ): Promise<void> {
    const actors = bundle.actors.entities;
    if (actors.length === 0) {
      log.debug('no actors to build');
      return;
    }
    log.info(`building ${actors.length} actors`);

    for (const entry of actors) {
      await this.createOne(entry, registry, assetMap);
    }
  }

  // ============================================================================

  private async createOne(
    entry: ActorEntry,
    registry: EntityRegistry,
    assetMap: AssetMap,
  ): Promise<void> {
    const folderId = this.folders.pathToId.get(entry.folder);
    if (!folderId) {
      throw new Error(
        `ActorBuilder: folder "${entry.folder}" not found for actor "${entry.slug}"`,
      );
    }

    const data = await this.buildActorData(entry, assetMap);
    if (!data) {
      log.warn(`actor "${entry.slug}" could not be built, skipping`);
      return;
    }

    // Apply common fields (folder, name override, portrait, flags)
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

    if (entry.portrait) {
      const portraitPath = assetMap.get(entry.portrait);
      if (portraitPath) data['img'] = portraitPath;
    }

    // Token configuration is on prototypeToken in v13
    const tokenSrc = entry.token_image
      ? assetMap.get(entry.token_image)
      : entry.portrait
        ? assetMap.get(entry.portrait)
        : undefined;
    const tokenConfig = entry.token_config ?? {
      disposition: 'hostile' as const,
      scale: 1,
      unlinked: true,
    };

    data['prototypeToken'] = {
      ...(data['prototypeToken'] as Record<string, unknown> ?? {}),
      name: entry.name,
      disposition: TOKEN_DISPOSITION_MAP[tokenConfig.disposition],
      width: tokenConfig.scale,
      height: tokenConfig.scale,
      actorLink: !tokenConfig.unlinked,
      ...(tokenSrc ? { texture: { src: tokenSrc } } : {}),
    };

    const created = await this.tryCreateActor(data, entry.slug);
    if (!created) {
      log.warn(`actor "${entry.slug}" could not be created, skipping`);
      return;
    }
    registry.record({
      slug: entry.slug,
      type: 'actor',
      foundryId: created.id,
      collection: 'Actor',
    });
    log.debug('actor created', entry.slug, '→', created.id);
  }

  /**
   * Try to create the actor. If PF2e rejects it (usually because of a trait
   * or schema mismatch in the embedded items), retry once without the items —
   * the actor still gets created with all its core stats; the GM just has to
   * add the strikes/abilities by hand. Better than no actor at all.
   */
  private async tryCreateActor(
    data: Record<string, unknown>,
    slug: string,
  ): Promise<ActorDoc | null> {
    try {
      return await Actor.create(data);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      log.warn(
        `actor "${slug}" rejected by validation, retrying without embedded items:`,
        msg,
      );
    }

    // Retry path — strip the items array. Most validation errors come from
    // trait/schema mismatches on the embedded melee/action items.
    try {
      const stripped = { ...data, items: [] };
      const created = await Actor.create(stripped);
      log.warn(
        `actor "${slug}" created without strikes/abilities — GM must add them manually`,
      );
      return created;
    } catch (err) {
      log.error(`actor "${slug}" failed even without items:`, err);
      return null;
    }
  }

  /**
   * Dispatches on stat_block.kind. Returns null if the actor truly can't
   * be built (e.g. compendium-ref to a missing pack with no fallback data).
   */
  private async buildActorData(
    entry: ActorEntry,
    assetMap: AssetMap,
  ): Promise<Record<string, unknown> | null> {
    switch (entry.stat_block.kind) {
      case 'compendium-ref':
        return this.buildFromCompendium(entry, entry.stat_block);
      case 'custom':
        return this.buildCustom(entry, entry.stat_block, assetMap);
      case 'loot-container':
        return this.buildLootContainer(entry, entry.stat_block);
    }
  }

  // ----------------------------------------------------------------------------
  // Compendium-ref path
  // ----------------------------------------------------------------------------

  private async buildFromCompendium(
    entry: ActorEntry,
    statBlock: Extract<StatBlock, { kind: 'compendium-ref' }>,
  ): Promise<Record<string, unknown> | null> {
    const source = await this.compendium.resolveSource(statBlock.uuid);
    if (!source) {
      // Compendium miss — create a placeholder so the GM at least sees
      // the entity is supposed to exist, with a clear flag.
      log.warn(
        `actor "${entry.slug}": compendium UUID ${statBlock.uuid} not found, creating placeholder`,
      );
      return {
        type: this.placeholderType(entry.category),
        flags: {
          'zenith-adventure-importer': {
            unresolvedCompendium: statBlock.uuid,
            placeholder: true,
          },
        },
      };
    }

    // Strip the source's _id so Foundry assigns a new one
    delete (source as any)._id;
    delete (source as any).folder;
    delete (source as any).sort;

    if (statBlock.name_override) {
      source['name'] = statBlock.name_override;
    }
    return source;
  }

  // ----------------------------------------------------------------------------
  // Custom NPC/creature path — full PF2e schema
  // ----------------------------------------------------------------------------

  private buildCustom(
    entry: ActorEntry,
    statBlock: Extract<StatBlock, { kind: 'custom' }>,
    assetMap: AssetMap,
  ): Record<string, unknown> {
    // PF2e NPC schema is verbose. We build the system data block then
    // wrap it in the actor envelope.
    const system = this.buildPF2eNpcSystem(statBlock);
    const items = this.buildPF2eEmbeddedItems(statBlock, assetMap);

    return {
      type: 'npc',
      system,
      items,
    };
  }

  /**
   * The system.* portion of a PF2e NPC actor.
   *
   * This is the boilerplate that turns "level 5, AC 22, HP 78, +13 to hit"
   * into the nested object the PF2e system module expects. Field names match
   * what PF2e's TypeScript types declare.
   */
  private buildPF2eNpcSystem(
    sb: Extract<StatBlock, { kind: 'custom' }>,
  ): Record<string, unknown> {
    return {
      details: {
        level: { value: sb.level },
        alliance: 'opposition',
        creatureType: '',
        languages: { value: sb.languages },
        rarity: sb.rarity,
        ...(sb.alignment ? { alignment: { value: sb.alignment } } : {}),
      },
      traits: {
        size: { value: sb.size },
        value: sb.traits,
      },
      abilities: {
        str: { mod: sb.abilities.str },
        dex: { mod: sb.abilities.dex },
        con: { mod: sb.abilities.con },
        int: { mod: sb.abilities.int },
        wis: { mod: sb.abilities.wis },
        cha: { mod: sb.abilities.cha },
      },
      attributes: {
        hp: { value: sb.hp, max: sb.hp },
        ac: { value: sb.ac },
        perception: { value: sb.perception },
        speed: {
          value: sb.speeds.land,
          otherSpeeds: this.buildOtherSpeeds(sb.speeds),
        },
        immunities: sb.immunities.map((type) => ({ type })),
        weaknesses: sb.weaknesses.map((w) => ({ type: w.type, value: w.value })),
        resistances: sb.resistances.map((r) => ({ type: r.type, value: r.value })),
      },
      saves: {
        fortitude: { value: sb.saves.fortitude },
        reflex: { value: sb.saves.reflex },
        will: { value: sb.saves.will },
      },
      // Skills are a record on PF2e NPCs, keyed by lowercase skill name
      skills: Object.fromEntries(
        sb.skills.map((s) => [
          s.name.toLowerCase(),
          { base: s.bonus, value: s.bonus },
        ]),
      ),
      perception: {
        senses: sb.senses.map((s) => ({ type: s })),
      },
    };
  }

  private buildOtherSpeeds(speeds: Extract<StatBlock, { kind: 'custom' }>['speeds']): unknown[] {
    const out: unknown[] = [];
    if (speeds.fly !== undefined) out.push({ type: 'fly', value: speeds.fly });
    if (speeds.swim !== undefined) out.push({ type: 'swim', value: speeds.swim });
    if (speeds.climb !== undefined) out.push({ type: 'climb', value: speeds.climb });
    if (speeds.burrow !== undefined) out.push({ type: 'burrow', value: speeds.burrow });
    return out;
  }

  /**
   * Build embedded item documents for strikes, actions, and inventory.
   * On PF2e NPCs, strikes and abilities ARE Items embedded in the actor.
   */
  private buildPF2eEmbeddedItems(
    sb: Extract<StatBlock, { kind: 'custom' }>,
    _assetMap: AssetMap,
  ): unknown[] {
    const items: unknown[] = [];

    // Strikes → "melee" type items in PF2e
    for (const strike of sb.strikes) {
      items.push({
        type: 'melee',
        name: strike.name,
        system: {
          weaponType: { value: strike.type },
          bonus: { value: strike.attack_bonus },
          // PF2e structures damage as a record keyed by a generated ID.
          // We use stable keys derived from index for deterministic output.
          damageRolls: {
            primary: {
              damage: strike.damage_formula.split(' ')[0] ?? '',
              damageType: strike.damage_formula.split(' ').slice(1).join(' ') || 'piercing',
            },
          },
          traits: { value: strike.traits },
          ...(strike.range_feet ? { range: { value: strike.range_feet } } : {}),
          ...(strike.reload ? { reload: { value: strike.reload } } : {}),
        },
      });
    }

    // Abilities/actions → "action" type items
    for (const ability of sb.actions) {
      items.push({
        type: 'action',
        name: ability.name,
        system: {
          actionType: { value: this.mapActionType(ability.cost) },
          actions: { value: this.mapActionCount(ability.cost) },
          traits: { value: ability.traits },
          description: { value: ability.description_html },
          ...(ability.frequency ? { frequency: { value: ability.frequency } } : {}),
          ...(ability.trigger ? { trigger: { value: ability.trigger } } : {}),
        },
      });
    }

    // Inventory references — defer to the ItemBuilder's resolveItem in Pass 2+.
    // For now, log if there's inventory and we'd need to handle it.
    if (sb.inventory.length > 0) {
      log.debug(
        `actor has ${sb.inventory.length} inventory items — not yet wired to ItemBuilder, items skipped`,
      );
    }

    return items;
  }

  private mapActionType(
    cost: Extract<StatBlock, { kind: 'custom' }>['actions'][number]['cost'],
  ): 'action' | 'reaction' | 'free' | 'passive' {
    if (cost === 'passive') return 'passive';
    if (cost === 'reaction') return 'reaction';
    if (cost === 'free') return 'free';
    return 'action';
  }

  private mapActionCount(
    cost: Extract<StatBlock, { kind: 'custom' }>['actions'][number]['cost'],
  ): number | null {
    if (cost === '1' || cost === '2' || cost === '3') return Number(cost);
    return null;
  }

  // ----------------------------------------------------------------------------
  // Loot container path
  // ----------------------------------------------------------------------------

  private async buildLootContainer(
    _entry: ActorEntry,
    statBlock: Extract<StatBlock, { kind: 'loot-container' }>,
  ): Promise<Record<string, unknown>> {
    const items: unknown[] = [];

    for (const ref of statBlock.contents) {
      // Compendium-resolved items go directly into the container as embedded items
      if (ref.uuid) {
        const source = await this.compendium.resolveSource(ref.uuid);
        if (source) {
          delete (source as any)._id;
          (source as any).system = {
            ...(source as any).system,
            quantity: ref.quantity,
          };
          items.push(source);
          continue;
        }
        log.warn(`loot container item ${ref.uuid} not found in compendium`);
      }
      // Items referenced by slug are resolved via cross-reference pass after
      // ItemBuilder has run. Track the ref in flags for the resolver.
      if (ref.ref) {
        items.push({
          type: 'equipment',
          name: `(deferred: ${ref.ref})`,
          system: { quantity: ref.quantity },
          flags: {
            'zenith-adventure-importer': {
              unresolvedItemRef: ref.ref,
              quantity: ref.quantity,
            },
          },
        });
      }
    }

    return {
      type: 'loot',
      system: {
        lootSheetType: 'Loot',
        currency: {
          cp: statBlock.currency.cp,
          sp: statBlock.currency.sp,
          gp: statBlock.currency.gp,
          pp: statBlock.currency.pp,
        },
      },
      items,
    };
  }

  // ----------------------------------------------------------------------------

  private placeholderType(category: ActorEntry['category']): string {
    if (category === 'hazard') return 'hazard';
    if (category === 'loot') return 'loot';
    return 'npc';
  }
}
